import test from "node:test";
import assert from "node:assert/strict";
import { MistralModelProvider } from "../../packages/model-providers/src/index.js";

// THE FAKE RATE LIMIT.
//
// A single 429 used to ratchet a self-imposed delay onto EVERY subsequent
// request — up to four seconds, applied silently before each call, decaying only
// after three consecutive successes. So one busy moment taxed the rest of the
// session invisibly: ten seconds of nothing before the first command of a task
// ran, with nothing on screen to explain it, because the wait was our own and
// no 429 had been received.
test("no delay is imposed unless the server actually sent a 429", async (t) => {
  const provider = new MistralModelProvider({ apiKey: "test-key" });
  assert.equal(provider.minRequestIntervalMs, 0, "there is no spacing before any rate limit");

  // Even after being throttled, the provider must not carry a standing delay
  // into later requests.
  provider._widenAfterRateLimit();
  assert.equal(provider.minRequestIntervalMs, 0, "a past 429 must not tax future requests");

  const waits = [];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false, status: 429,
        headers: { get: () => null },
        text: async () => '{"message":"Rate limit exceeded"}'
      };
    }
    return {
      ok: true, body: null,
      json: async () => ({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] })
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const startedAt = Date.now();
  const result = await provider.chat({
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    onRetry: (info) => waits.push(info)
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.text, "done");
  assert.equal(waits.length, 1, "exactly one wait, for the one 429 that was actually received");
  assert.equal(waits[0].reason, "rate-limited");
  // The 2s backoff for that one 429, and nothing else. Before this, the second
  // request also paid a self-imposed 1.5s+ before being sent.
  assert.ok(elapsed >= 1900 && elapsed < 3500, `one backoff only, took ${elapsed}ms`);
});
