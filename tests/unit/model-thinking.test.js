// THINKING IS OFF FOR AN ORDINARY STEP AND BACK ON FOR A TURN THAT FAILED.
//
// See THINKING_OFF in packages/fast-agent/src/index.js for the measurement that
// decided the default. These tests hold the WIRING, which is the half that has
// gone wrong in this codebase over and over: `autoApprove` was correct and never
// read on the hot path, `listSummaries` was correct and never called, the skills
// store is correct and has no surface. A reasoning switch nothing sends is the
// same defect with a different name, so every test here asserts on what reached
// the REQUEST BODY, never on what the constant says.
//
// Proven able to fail: deleting the `extraBody` spread in openAiCompatibleChat
// fails "an endpoint field reaches the wire"; deleting the `...(thinks ? ...)`
// line in _callModel fails three of the loop tests; inverting `deliberate`
// fails the retry test and the ordinary-step test together.

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent } from "../../packages/fast-agent/src/index.js";
import { AgentRouterModelProvider } from "../../packages/model-providers/src/index.js";

// Records the body of every request, and answers the way the endpoint does.
function recordingFetch(bodies, { finishReason = "stop", text = "Here is what I found." } = {}) {
  return async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { content: text, tool_calls: [] }, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })
    };
  };
}

// A provider that records the REQUEST the loop handed it. The loop's job stops
// at the request object; the transport test below covers the rest of the way.
function recordingProvider(turns) {
  const requests = [];
  return {
    requests,
    supportsChat: () => true,
    async chat(request) {
      requests.push(request);
      const turn = turns.shift() ?? { text: "Here is what I found." };
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      };
    }
  };
}

function toolset() {
  return {
    definitions: [{ type: "function", function: { name: "run", description: "", parameters: {} } }],
    has: (name) => name === "run",
    previewOf: () => "",
    async execute() {
      return { ok: true, text: "ran", raw: { evidence: { verdict: "CONFIRMED" } } };
    }
  };
}

const thinkingDisabled = (body) =>
  body?.reasoning_effort === "none"
  && body?.chat_template_kwargs?.thinking === false
  && body?.chat_template_kwargs?.enable_thinking === false;

test("an endpoint field reaches the wire", async () => {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(bodies);
  try {
    const provider = new AgentRouterModelProvider({
      apiKey: "test-key", model: "test-model", baseUrl: "https://example.invalid/v1", providerName: "deepseek"
    });
    await provider.chat({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: false,
      maxTokens: 64,
      extraBody: { reasoning_effort: "none", chat_template_kwargs: { thinking: false, enable_thinking: false } }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(bodies.length, 1);
  assert.ok(thinkingDisabled(bodies[0]), `extraBody did not reach the request body: ${JSON.stringify(bodies[0])}`);
  // And the ordinary fields are still there — a passthrough that replaced the
  // body rather than extending it would pass the assertion above.
  assert.equal(bodies[0].model, "test-model");
  assert.equal(bodies[0].max_tokens, 64);
});

test("an ordinary step does not ask the model to think", async () => {
  const provider = recordingProvider([{ text: "Here is what I found." }]);
  await new FastAgent({ provider, toolset: toolset() }).run("say hello");
  assert.equal(provider.requests.length, 1);
  assert.ok(
    thinkingDisabled(provider.requests[0].extraBody),
    "the first step of an ordinary run must send the thinking-off fields"
  );
});

test("the retry after a cut-off turn is allowed to think", async () => {
  // First turn is truncated, so the loop discards it and asks again. That second
  // request is the one that may deliberate.
  const provider = recordingProvider([
    { text: "I was cut o", finishReason: "length" },
    { text: "Here is what I found." }
  ]);
  await new FastAgent({ provider, toolset: toolset() }).run("draw something complicated");
  assert.equal(provider.requests.length, 2, "a truncated turn must be retried");
  assert.ok(thinkingDisabled(provider.requests[0].extraBody), "the first attempt does not think");
  assert.equal(
    provider.requests[1].extraBody, undefined,
    "the retry after a truncation must NOT disable thinking — that is the whole point of the retry"
  );
});

test("the retry after a malformed turn is allowed to think", async () => {
  const provider = recordingProvider([
    { text: "<｜DSML｜invoke name=\"run\">" },
    { text: "Here is what I found." }
  ]);
  await new FastAgent({ provider, toolset: toolset() }).run("run something");
  assert.equal(provider.requests.length, 2, "a malformed turn must be retried");
  assert.ok(thinkingDisabled(provider.requests[0].extraBody));
  assert.equal(provider.requests[1].extraBody, undefined, "the retry may deliberate");
});

test("SYSCORA_MODEL_THINKING=always restores deliberation on every step", async () => {
  // The module reads the environment once, at import, so this is checked by
  // importing a fresh copy rather than by mutating the environment after the
  // fact — which would assert nothing and pass regardless.
  const previous = process.env.SYSCORA_MODEL_THINKING;
  process.env.SYSCORA_MODEL_THINKING = "always";
  try {
    const fresh = await import(`../../packages/fast-agent/src/index.js?thinking=always`);
    const provider = recordingProvider([{ text: "Here is what I found." }]);
    await new fresh.FastAgent({ provider, toolset: toolset() }).run("say hello");
    assert.equal(
      provider.requests[0].extraBody, undefined,
      "with thinking forced on, no step may send the thinking-off fields"
    );
  } finally {
    if (previous === undefined) delete process.env.SYSCORA_MODEL_THINKING;
    else process.env.SYSCORA_MODEL_THINKING = previous;
  }
});

test("SYSCORA_MODEL_THINKING=never keeps thinking off even on a retry", async () => {
  const previous = process.env.SYSCORA_MODEL_THINKING;
  process.env.SYSCORA_MODEL_THINKING = "never";
  try {
    const fresh = await import(`../../packages/fast-agent/src/index.js?thinking=never`);
    const provider = recordingProvider([
      { text: "cut o", finishReason: "length" },
      { text: "Here is what I found." }
    ]);
    await new fresh.FastAgent({ provider, toolset: toolset() }).run("draw something");
    assert.equal(provider.requests.length, 2);
    assert.ok(
      thinkingDisabled(provider.requests[1].extraBody),
      "with thinking forced off, even the retry must not deliberate"
    );
  } finally {
    if (previous === undefined) delete process.env.SYSCORA_MODEL_THINKING;
    else process.env.SYSCORA_MODEL_THINKING = previous;
  }
});

// THE USER'S CHOICE, AND WHETHER IT ACTUALLY REACHES THE WIRE.
//
// The composer has a Thinking control (auto / always / off) and the value rides
// on each message. Everything between it and the request body is plumbing, and
// plumbing is where this codebase loses things: `autoApprove` was correct and
// never read on the hot path, `listSummaries` was correct and never called.
// These assert on the REQUEST, not on the constructor argument.

test("thinking:'always' from the caller makes an ordinary step deliberate", async () => {
  const provider = recordingProvider([{ text: "Here is what I found." }]);
  await new FastAgent({ provider, toolset: toolset(), thinking: "always" }).run("say hello");
  assert.equal(
    provider.requests[0].extraBody, undefined,
    "the user asked for thinking, so the thinking-off fields must not be sent"
  );
});

test("thinking:'never' from the caller keeps a retry non-deliberating", async () => {
  const provider = recordingProvider([
    { text: "cut o", finishReason: "length" },
    { text: "Here is what I found." }
  ]);
  await new FastAgent({ provider, toolset: toolset(), thinking: "never" }).run("draw something");
  assert.equal(provider.requests.length, 2);
  assert.ok(
    thinkingDisabled(provider.requests[1].extraBody),
    "the user asked for no thinking, so even the retry must not deliberate"
  );
});

test("thinking:'auto' is the measured default behaviour", async () => {
  const provider = recordingProvider([
    { text: "cut o", finishReason: "length" },
    { text: "Here is what I found." }
  ]);
  await new FastAgent({ provider, toolset: toolset(), thinking: "auto" }).run("draw something");
  assert.ok(thinkingDisabled(provider.requests[0].extraBody), "ordinary step: off");
  assert.equal(provider.requests[1].extraBody, undefined, "the retry after a cut-off: on");
});

test("a nonsense thinking value falls back rather than disabling deliberation", async () => {
  // A malformed client must not be able to turn the model's judgement off by
  // sending a word nobody recognises.
  const provider = recordingProvider([{ text: "Here is what I found." }]);
  await new FastAgent({ provider, toolset: toolset(), thinking: "banana" }).run("say hello");
  assert.ok(
    thinkingDisabled(provider.requests[0].extraBody),
    "an unknown value must land on the process default, not on a third behaviour"
  );
});
