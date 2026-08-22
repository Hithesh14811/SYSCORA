import test from "node:test";
import assert from "node:assert/strict";
import { openAiCompatibleChat } from "../../packages/model-providers/src/index.js";

// A TOTAL-DURATION TIMEOUT CANNOT TELL THINKING FROM A DEAD SOCKET.
//
// The transport used to arm one abort timer for the whole request and never
// rearm it. On a reasoning endpoint the model streams its entire deliberation
// before it writes a tool call, so a turn that thinks for 110 seconds looked
// exactly like a connection that died at the first byte — and the healthy one
// was aborted with bytes still arriving. Measured 21 Aug 2026: one drawing
// decision streamed 11,891 reasoning tokens over 111.6s against a 90s cap.
//
// Downstream, that abort surfaces as `fetch failed`, the loop retries once, and
// the run stalls for ~180s at 0 steps before any tool call — which is the
// signature the briefs have been attributing to phone tethering. A slow link
// makes it fire more often; it is not what causes it.
//
// These two tests are a pair and only mean something together: one proves a
// living stream is not killed for being slow, the other proves a silent one
// still dies. Either alone would pass on a broken implementation — deleting the
// timer entirely satisfies the first, and the old total-duration timer
// satisfies the second.

// EVERY STUB HERE HONOURS `signal`, BECAUSE REAL FETCH DOES.
//
// The first version of this file did not, and the "slow stream survives" test
// passed with the rearm deliberately deleted — the abort fired on schedule and
// the stub's stream carried on regardless, so the check could not fail and
// therefore checked nothing. That is the defect class this codebase has found
// twelve times; it takes a deliberate break to notice, which is why both tests
// below are run against a broken build before they are believed.
function signalAwareFetch(makeBody) {
  return (_url, init) => {
    const body = makeBody(init.signal);
    init.signal.addEventListener("abort", () => {
      try {
        body.controller?.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      } catch { /* already closed */ }
    }, { once: true });
    return Promise.resolve({ ok: true, body: body.stream, status: 200, headers: new Map() });
  };
}

function sseStream(chunks, { gapMs }) {
  const encoder = new TextEncoder();
  let index = 0;
  let controllerRef = null;
  const stream = new ReadableStream({
    start(controller) { controllerRef = controller; },
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      // A stream that was aborted while we slept must not keep enqueuing.
      try { controller.enqueue(encoder.encode(chunks[index++])); } catch { /* errored */ }
    }
  });
  return { stream, get controller() { return controllerRef; } };
}

function delta(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => { globalThis.fetch = original; });
}

test("a stream that keeps arriving is not aborted for taking longer than the idle window", async () => {
  // Ten chunks, 30ms apart: 300ms of streaming against a 100ms idle rule. Every
  // individual silence is under the rule; the TOTAL is three times it. Under the
  // old one-shot timer this is the case that died mid-stream.
  const chunks = [...Array(10).keys()].map((n) => delta(`tok${n} `)).concat([
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ]);
  const result = await withFetch(
    signalAwareFetch(() => sseStream(chunks, { gapMs: 30 })),
    () => openAiCompatibleChat({
      baseUrl: "http://x", apiKey: "k", model: "m",
      messages: [{ role: "user", content: "hi" }],
      idleTimeoutMs: 100,
      timeoutMs: 30000
    })
  );

  assert.match(result.text, /tok0/, "the turn must survive");
  assert.match(result.text, /tok9/, "and arrive complete, not clipped at the idle window");
  assert.equal(result.finishReason, "stop");
});

test("a stream that goes silent is still aborted, long before the total deadline", async () => {
  // One chunk, then nothing. The total deadline is 30s away, so only the silence
  // rule can catch this. A transport that simply stopped timing out would hang
  // here until the deadline.
  const encoder = new TextEncoder();
  // The stub honours `signal` the way real fetch does — aborting the request
  // errors the body. Without that the stream would just hang and the test would
  // be measuring its own stub rather than the transport.
  const openSocket = (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(delta("started")));
        init.signal.addEventListener("abort", () => {
          controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        }, { once: true });
      }
    });
    return Promise.resolve({ ok: true, body, status: 200, headers: new Map() });
  };

  const startedAt = Date.now();
  await assert.rejects(
    () => withFetch(
      openSocket,
      () => openAiCompatibleChat({
        baseUrl: "http://x", apiKey: "k", model: "m",
        messages: [{ role: "user", content: "hi" }],
        idleTimeoutMs: 150,
        timeoutMs: 30000
      })
    ),
    (error) => /abort/i.test(String(error?.name ?? "") + String(error?.message ?? "")),
    "silence must still be fatal, or a dead socket hangs the run"
  );
  assert.ok(Date.now() - startedAt < 5000,
    "it must die on the idle rule, not survive to the 30s deadline");
});
