// HALF AN EMOJI IS NOT SENDABLE, AND IT TAKES THE WHOLE RUN WITH IT.
//
// Measured 20 Aug 2026. Every WhatsApp perception task in the eval failed with:
//
//   HTTP 400: Failed to parse the request body as JSON:
//   messages[5].content: unexpected end of hex escape
//
// A JS string is UTF-16 code units and an emoji is a surrogate PAIR of them, so
// any truncation by length can cut between the halves and leave a lone high
// surrogate. JSON.stringify encodes it as `\ud83d`; Node's own parser accepts
// that, so a local round-trip proves nothing, and the provider's stricter parser
// rejects the ENTIRE body. One clipped emoji in a screen reading loses the run.
//
// Two defences, because a lone surrogate can be introduced by anything that
// truncates: `clip` stops making them, and the transport stops any reaching the
// wire whatever made them.

import test from "node:test";
import assert from "node:assert/strict";

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const endsWithLoneSurrogate = (text) => HIGH_SURROGATE.test(String(text).slice(-1));

// One emoji, deliberately built from its code point so no editor or shell can
// quietly normalise it into something else.
const EMOJI = String.fromCodePoint(0x1F600);

test("an emoji really is two code units, which is the whole reason this exists", () => {
  assert.equal(EMOJI.length, 2, "if this is 1 the test below proves nothing");
});

// What this would FAIL on: any truncation that leaves a lone high surrogate.
// THE REAL FUNCTION, NOT A COPY OF IT. The first draft of this test
// reimplemented `clip` locally, which would have gone on passing after the fix
// was reverted — a check that cannot fail on the code it names.
test("a screen reading clipped mid-emoji never ends in half a character", async () => {
  const { clipForTest: clip } = await import("../../packages/fast-agent/src/tools.js");
  assert.equal(typeof clip, "function", "this test is about the shipped clip, not a copy of it");

  const reading = `WhatsApp message row ${EMOJI}${EMOJI}${EMOJI}`;
  // Try every cut position: at least one of them lands inside a pair.
  let cutsInsideAPair = 0;
  for (let max = 1; max < reading.length; max += 1) {
    if (HIGH_SURROGATE.test(reading[max - 1])) cutsInsideAPair += 1;
    const clipped = clip(reading, max);
    const body = clipped.split("\n")[0];
    assert.equal(endsWithLoneSurrogate(body), false,
      `cutting at ${max} left half an emoji: ${JSON.stringify(body.slice(-4))}`);
  }
  assert.ok(cutsInsideAPair > 0, "if no cut landed inside a pair this test proved nothing");
});

// THE DEFENCE THAT CATCHES IT WHATEVER MADE IT. The transport is the one place
// every message passes through on its way out.
test("the transport never puts a lone surrogate on the wire", async () => {
  const { OpenAIModelProvider } = await import("../../packages/model-providers/src/index.js");
  const provider = new OpenAIModelProvider({ apiKey: "test-key", model: "test-model" });

  let sentBody = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sentBody = init.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
      body: null
    };
  };

  try {
    // A tool result that was clipped mid-emoji, exactly as a screen reading is.
    const halfAnEmoji = `WhatsApp row ${EMOJI}`.slice(0, -1);
    assert.equal(endsWithLoneSurrogate(halfAnEmoji), true, "the fixture must actually be broken");

    await provider.chat({
      messages: [{ role: "tool", tool_call_id: "c1", content: halfAnEmoji }],
      stream: false,
      maxTokens: 16
    }).catch(() => { /* the shape of the reply is not what is under test */ });

    assert.ok(sentBody, "the request must have been built");
    const parsed = JSON.parse(sentBody);
    const content = String(parsed.messages.at(-1).content);
    assert.equal(endsWithLoneSurrogate(content), false,
      "a lone surrogate reached the wire — the provider rejects the whole body for this");
    assert.ok(content.startsWith("WhatsApp row"), "and the rest of the message must survive intact");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A whole emoji must not be damaged. A defence that mangles ordinary content is
// its own defect.
test("intact emoji pass through untouched", async () => {
  const { OpenAIModelProvider } = await import("../../packages/model-providers/src/index.js");
  const provider = new OpenAIModelProvider({ apiKey: "test-key", model: "test-model" });
  let sentBody = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sentBody = init.body;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }), body: null };
  };
  try {
    const intact = `she replied ${EMOJI} and left`;
    await provider.chat({ messages: [{ role: "user", content: intact }], stream: false, maxTokens: 16 })
      .catch(() => {});
    const parsed = JSON.parse(sentBody);
    assert.equal(parsed.messages.at(-1).content, intact, "an unbroken emoji must arrive unchanged");
  } finally {
    globalThis.fetch = realFetch;
  }
});
