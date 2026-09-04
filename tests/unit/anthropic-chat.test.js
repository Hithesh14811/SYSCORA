// CONFIGURING CLAUDE SILENTLY TURNED OFF THE AGENT.
//
// `AgentRuntime._canRunFastAgent` requires `provider.chat` AND
// `provider.supportsChat() === true`. `AnthropicModelProvider` had neither, so
// the base class answered false and every request went to the ~15,000-line
// staged pipeline the eval reports is reached zero times — not a degraded mode,
// a different product, one that cannot drive a GUI. Nothing failed loudly,
// because falling back to that pipeline is a legitimate path: it is what happens
// when there is no model at all. The symptom was "Claude is worse at this than
// DeepSeek".
//
// These tests pin the two things that make it reachable and the translation in
// between, which is where the real risk is: the loop speaks OpenAI's shape and
// Anthropic wants something structurally different, and every mistake in that
// mapping is an HTTP 400 on an ordinary conversation rather than a wrong answer.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicModelProvider,
  anthropicChat,
  toAnthropicMessages,
  toAnthropicTools
} from "../../packages/model-providers/src/index.js";

test("the provider can reach the agent loop at all", () => {
  const provider = new AnthropicModelProvider({ apiKey: "k", model: "claude-opus-5" });
  // These are the exact two checks `_canRunFastAgent` makes.
  assert.equal(typeof provider.chat, "function");
  assert.equal(provider.supportsChat(), true);
});

test("no key means no chat, so the loop is not offered a provider that cannot answer", () => {
  const provider = new AnthropicModelProvider({ apiKey: "" });
  provider.apiKey = "";
  assert.equal(provider.supportsChat(), false);
});

// ANTHROPIC EXPECTS TURNS TO ALTERNATE. The loop legitimately emits several
// `user` messages in a row — history, then the request, then a `[SYSTEM]` nudge —
// and sending them as they are is an HTTP 400 on an ordinary conversation.
test("consecutive same-role turns are merged rather than sent as they are", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "one" },
    { role: "user", content: "two" },
    { role: "user", content: "three" }
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content.length, 3);
});

test("the system prompt is hoisted out of the message list", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "SYS" },
    { role: "user", content: "hello" }
  ]);
  assert.deepEqual(system, [{ type: "text", text: "SYS" }]);
  assert.equal(messages.every((m) => m.role !== "system"), true);
});

// THE PAIRING IS WHAT 400s. A `tool_result` whose `tool_use_id` matches no
// `tool_use` is rejected, exactly as OpenAI rejects an orphaned `tool_call_id`.
test("a tool call and its result keep their pairing across the translation", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "Checking.",
      tool_calls: [{ id: "call_7", function: { name: "screen", arguments: '{"application":"notepad"}' } }]
    },
    { role: "tool", tool_call_id: "call_7", content: "Window: Notepad" }
  ]);
  const use = messages.flatMap((m) => m.content).find((b) => b.type === "tool_use");
  const result = messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
  assert.equal(use.id, "call_7");
  assert.equal(result.tool_use_id, "call_7");
  assert.deepEqual(use.input, { application: "notepad" });
  // A tool result is a USER turn on this API, not a role of its own.
  assert.equal(messages.find((m) => m.content.includes(result)).role, "user");
});

// Arguments the loop already discarded arrive as unparseable JSON. Sending `{}`
// keeps the pairing intact; throwing would lose the whole conversation.
test("unparseable tool arguments do not break the conversation", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "run", arguments: '{"broken' } }] },
    { role: "tool", tool_call_id: "c1", content: "x" }
  ]);
  const use = messages.flatMap((m) => m.content).find((b) => b.type === "tool_use");
  assert.deepEqual(use.input, {});
});

test("a conversation that opens on an assistant turn is repaired, not rejected", () => {
  const { messages } = toAnthropicMessages([
    { role: "assistant", content: "carrying on" },
    { role: "user", content: "ok" }
  ]);
  assert.equal(messages[0].role, "user");
});

test("the tool schema is translated to input_schema", () => {
  const tools = toAnthropicTools([
    { type: "function", function: { name: "screen", description: "read a window", parameters: { type: "object" } } }
  ]);
  assert.deepEqual(tools, [{ name: "screen", description: "read a window", input_schema: { type: "object" } }]);
});

// A stubbed Messages stream, in the exact event sequence the API emits.
function sseResponse(events, { ok = true, status = 200 } = {}) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(body);
  return {
    ok,
    status,
    headers: { get: () => null },
    async text() { return body; },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {}
        };
      }
    }
  };
}

async function withFetch(response, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return response;
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const BASE = {
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "k",
  model: "claude-opus-5",
  messages: [{ role: "system", content: "SYS" }, { role: "user", content: "open notepad" }],
  tools: [{ type: "function", function: { name: "launch", description: "", parameters: { type: "object" } } }],
  maxTokens: 8192
};

// THE RETURN SHAPE IS THE CONTRACT. The agent loop reads
// `{text, reasoning, toolCalls, finishReason, usage}` with OpenAI's usage
// spelling, and must not learn a second shape — translating twice in the
// transport is cheaper than translating everywhere.
test("a streamed tool call comes back in the shape the loop reads", async () => {
  const { result } = await withFetch(
    sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 9000, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Opening it." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "launch" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"application":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"notepad"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }
    ]),
    () => anthropicChat(BASE)
  );

  assert.equal(result.text, "Opening it.");
  assert.equal(result.finishReason, "tool_calls", "the loop only understands OpenAI's spelling");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "launch");
  assert.equal(result.toolCalls[0].id, "toolu_1");
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { application: "notepad" });
});

// `input_tokens` EXCLUDES what was served from cache. Reported as-is, a run whose
// prefix all cached would look almost free, and every cost surface here computes
// fresh = prompt_tokens - cached_tokens.
test("cached input is counted into prompt_tokens, not left out of it", async () => {
  const { result } = await withFetch(
    sseResponse([
      {
        type: "message_start",
        message: { usage: { input_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 30, output_tokens: 0 } }
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }
    ]),
    () => anthropicChat(BASE)
  );
  assert.equal(result.usage.prompt_tokens, 9150);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 9000);
  const fresh = result.usage.prompt_tokens - result.usage.prompt_tokens_details.cached_tokens;
  assert.equal(fresh, 150);
});

// THE ECONOMICS OF THIS PRODUCT DEPEND ON THE PREFIX BEING CACHED. DeepSeek does
// it unprompted; Anthropic caches only what is marked, so without a breakpoint
// every step re-buys the whole fixed prefix at full price.
test("the fixed prefix is marked cacheable", async () => {
  const { calls } = await withFetch(
    sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]),
    () => anthropicChat(BASE)
  );
  const body = calls[0].body;
  assert.equal(body.tools.at(-1).cache_control.type, "ephemeral");
  assert.equal(body.system.at(-1).cache_control.type, "ephemeral");
});

test("max_tokens is always sent, because this API rejects a request without it", async () => {
  const { calls } = await withFetch(
    sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]),
    () => anthropicChat(BASE)
  );
  assert.equal(calls[0].body.max_tokens, 8192);
});

// A CUT CONNECTION IS NOT A FINISHED ANSWER. Without this the loop reads a
// truncated turn with no tool calls as the model having finished, and reports an
// interrupted task as complete in the model's own half-sentence.
test("a stream that ends with no stop reason is an error, not an empty answer", async () => {
  await assert.rejects(
    () => withFetch(
      sseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The last two messages are:" } }
      ]),
      () => anthropicChat(BASE)
    ),
    /ended before the turn was complete/
  );
});

test("a truncated turn reports the spelling wasTruncated understands", async () => {
  const { result } = await withFetch(
    sseResponse([{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } }]),
    () => anthropicChat(BASE)
  );
  assert.equal(result.finishReason, "length");
});

// The loop hard-coded DeepSeek's `reasoning_effort` and sent it to every
// provider. Anthropic rejects unknown body fields, so the correct decision on an
// ordinary step would have failed every ordinary step.
test("not deliberating sends nothing, rather than another vendor's field names", () => {
  const provider = new AnthropicModelProvider({ apiKey: "k" });
  assert.equal(provider.reasoningBody(false), null);
  assert.equal(provider.reasoningBody(true).thinking.type, "enabled");
});

// budget_tokens must be >= 1024 and strictly less than max_tokens, and the caller
// cannot know max_tokens. Getting it wrong is a 400, not a slower answer.
test("a thinking budget too large for max_tokens is clamped, never sent as-is", async () => {
  const { calls } = await withFetch(
    sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]),
    () => anthropicChat({ ...BASE, maxTokens: 4096, extraBody: { thinking: { type: "enabled", budget_tokens: 8000 } } })
  );
  assert.ok(calls[0].body.thinking.budget_tokens < 4096, "budget must be under max_tokens");
  assert.ok(calls[0].body.thinking.budget_tokens >= 1024);
  // Temperature must be 1 while thinking is enabled — also a 400 otherwise.
  assert.equal(calls[0].body.temperature, 1);
});

test("no room to think means answering without it, not failing the turn", async () => {
  const { calls } = await withFetch(
    sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]),
    () => anthropicChat({ ...BASE, maxTokens: 1200, extraBody: { thinking: { type: "enabled", budget_tokens: 8000 } } })
  );
  assert.equal(calls[0].body.thinking, undefined);
});

test("an HTTP failure carries its status so the retry logic can read it", async () => {
  await assert.rejects(
    () => withFetch(
      sseResponse([], { ok: false, status: 429 }),
      () => anthropicChat(BASE)
    ),
    (error) => error.status === 429
  );
});
