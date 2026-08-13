// The transport under the agent loop.
//
// The loop keeps ONE conversation and reasons from it: what it said, what it
// called, what came back. Everything here is about that conversation surviving
// the trip to a provider intact, and about the difference between a turn that
// finished and a turn that was cut off — which the loop cannot tell apart on its
// own, because a turn with no tool calls in it is how a finished task looks.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FailoverModelProvider,
  GeminiModelProvider,
  openAiCompatibleChat
} from "../../packages/model-providers/src/index.js";

// A streamed HTTP response built from a list of SSE payload lines.
function sseResponse(lines, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(`${line}\n`));
  let index = 0;
  return {
    ok,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { value: chunks[index++], done: false }
          : { value: undefined, done: true }),
        cancel: async () => {}
      })
    },
    text: async () => "",
    json: async () => ({})
  };
}

function withFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, init });
    return handler(calls.length, { url: String(url), init });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

// THE MODEL HAS TO SEE ITS OWN TOOL CALLS.
//
// Gemini's wire shape is functionCall / functionResponse; the loop's is OpenAI's
// tool_calls plus tool messages. Flattening every message to a text part — which
// is what this did — dropped the assistant's calls entirely and handed the
// results back as though the USER had typed them. What the model saw was a
// request, an empty turn of its own, and a stranger reciting "Clicked at
// 640,400": no record of having acted, so at every step the obvious next move
// was the one it had just made.
test("Gemini is sent the tool calls it made and the results as responses to them", async (t) => {
  const calls = withFetch(t, () => sseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"All set."}]},"finishReason":"STOP"}]}'
  ]));
  const provider = new GeminiModelProvider({ apiKey: "k" });

  await provider.chat({
    messages: [
      { role: "system", content: "You are SYSCORA." },
      { role: "user", content: "open notepad" },
      {
        role: "assistant",
        content: "Opening it.",
        tool_calls: [{ id: "call_0", type: "function", function: { name: "launch", arguments: '{"application":"notepad"}' } }]
      },
      { role: "tool", tool_call_id: "call_0", content: "notepad is open in a new window (windowId 42)." }
    ],
    tools: [{ type: "function", function: { name: "launch", description: "", parameters: { type: "object", properties: {} } } }],
    onTextDelta: () => {}
  });

  const { contents, systemInstruction, tools } = calls[0].body;
  assert.equal(systemInstruction.parts[0].text, "You are SYSCORA.");
  assert.equal(tools[0].functionDeclarations[0].name, "launch");
  assert.deepEqual(contents.map((entry) => entry.role), ["user", "model", "user"]);

  // The model's own turn keeps both what it said and what it called.
  assert.equal(contents[1].parts[0].text, "Opening it.");
  assert.deepEqual(contents[1].parts[1].functionCall, {
    name: "launch",
    args: { application: "notepad" }
  });
  // And the result goes back as a response to THAT function, not as a new user
  // message, so the model can tell its own action from something it was told.
  const response = contents[2].parts[0].functionResponse;
  assert.equal(response.name, "launch", "the result must be attributed to the call it answers");
  assert.match(response.response.result, /windowId 42/);
});

// THE SIGNATURE HAS TO COME BACK WITH THE CALL.
//
// Gemini attaches a thoughtSignature to each function call it makes and requires
// it on the way back; replaying the call without it is rejected outright —
// "Function call is missing a thought_signature in functionCall parts". Live,
// that arrived as an HTTP 400 on the fourteenth step of a task and was reported
// to the user as the provider having failed.
test("Gemini's thought signature is carried back with the call it belongs to", async (t) => {
  const calls = withFetch(t, (n) => (n === 1
    ? sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"launch","args":{"application":"mspaint"}},"thoughtSignature":"sig-abc123"}]},"finishReason":"STOP"}]}'
      ])
    : sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}'])));
  const provider = new GeminiModelProvider({ apiKey: "k" });

  const first = await provider.chat({
    messages: [{ role: "user", content: "open paint" }],
    onTextDelta: () => {}
  });
  assert.equal(first.toolCalls[0].thoughtSignature, "sig-abc123",
    "the signature must survive the read, or there is nothing to send back");

  // The loop replays the call on the next turn; the signature must ride with it.
  await provider.chat({
    messages: [
      { role: "user", content: "open paint" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: first.toolCalls[0].id,
          type: "function",
          function: { name: "launch", arguments: first.toolCalls[0].arguments },
          thoughtSignature: first.toolCalls[0].thoughtSignature
        }]
      },
      { role: "tool", tool_call_id: first.toolCalls[0].id, content: "mspaint opened." }
    ],
    onTextDelta: () => {}
  });
  const modelTurn = calls[1].body.contents.find((entry) => entry.role === "model");
  assert.equal(modelTurn.parts[0].thoughtSignature, "sig-abc123");
  assert.equal(modelTurn.parts[0].functionCall.name, "launch");
});

// Whatever is added to the conversation for one provider must be dropped for
// the others: an OpenAI-compatible gateway is entitled to reject a tool_call
// object carrying a field it has never heard of.
test("provider bookkeeping is stripped before it reaches an OpenAI-shaped endpoint", async (t) => {
  const calls = withFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    "data: [DONE]"
  ]));
  await openAiCompatibleChat({
    baseUrl: "https://x/v1",
    apiKey: "k",
    model: "m",
    messages: [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_0",
        type: "function",
        function: { name: "launch", arguments: "{}" },
        thoughtSignature: "sig-abc123"
      }]
    }]
  });
  const sent = calls[0].body.messages[0].tool_calls[0];
  assert.deepEqual(sent, { id: "call_0", type: "function", function: { name: "launch", arguments: "{}" } });
});

// An assistant turn with neither prose nor calls has nothing in it, and Gemini
// rejects an empty parts array outright — which would fail the whole request.
test("Gemini is not sent an empty turn", async (t) => {
  const calls = withFetch(t, () => sseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}'
  ]));
  await new GeminiModelProvider({ apiKey: "k" }).chat({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: null },
      { role: "user", content: "still there?" }
    ],
    onTextDelta: () => {}
  });
  const { contents } = calls[0].body;
  assert.deepEqual(contents.map((entry) => entry.role), ["user", "user"]);
  assert.ok(contents.every((entry) => entry.parts.length > 0));
});

// The first sentence on screen in under a second is the product. A single-shot
// call holds everything back until the turn is finished, which for a turn that
// also runs a tool is several seconds of nothing.
test("Gemini streams its prose as it arrives, and still reassembles the tool calls", async (t) => {
  const calls = withFetch(t, () => sseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"Opening "}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"Notepad."}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"launch","args":{"application":"notepad"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}'
  ]));
  const deltas = [];
  const result = await new GeminiModelProvider({ apiKey: "k" }).chat({
    messages: [{ role: "user", content: "open notepad" }],
    onTextDelta: (text) => deltas.push(text)
  });

  assert.match(calls[0].url, /streamGenerateContent\?alt=sse/);
  assert.deepEqual(deltas, ["Opening ", "Notepad."], "prose must arrive in fragments, not one block");
  assert.equal(result.text, "Opening Notepad.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "launch");
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { application: "notepad" });
});

// A CUT CONNECTION IS NOT A FINISHED ANSWER.
//
// The loop reads a turn with no tool calls as the model having finished. So when
// the socket dropped mid-turn, a task interrupted halfway through was reported
// to the user as complete, in the model's own confident half-sentence.
test("a stream that ends mid-turn fails instead of passing as a finished answer", async (t) => {
  withFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Installing it now"}}]}'
    // No finish_reason, no [DONE]: the connection went away.
  ]));
  await assert.rejects(
    openAiCompatibleChat({ baseUrl: "https://x/v1", apiKey: "k", model: "m", messages: [] }),
    /ended before the turn was complete/
  );
});

test("a stream that really did finish is returned, not treated as a drop", async (t) => {
  withFetch(t, () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}',
    "data: [DONE]"
  ]));
  const result = await openAiCompatibleChat({ baseUrl: "https://x/v1", apiKey: "k", model: "m", messages: [] });
  assert.equal(result.text, "Done.");
  assert.equal(result.finishReason, "stop");
});

// STOP MEANS STOP, INCLUDING IN FAILOVER.
//
// Pressing stop aborts the in-flight request, which arrives at the failover
// provider as an ordinary provider failure — and its job is to answer a provider
// failure by trying the next one. So one stop press sent a fresh request to
// every other configured account in turn, and the user paid for all of them.
test("cancelling stops the request rather than starting one on every other provider", async () => {
  const attempts = [];
  const provider = (name) => ({
    name,
    supportsChat: () => true,
    chat: async ({ signal }) => {
      attempts.push(name);
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      if (signal?.aborted) throw error;
      throw new Error("upstream is down");
    }
  });
  const controller = new AbortController();
  const failover = new FailoverModelProvider([provider("a"), provider("b"), provider("c")]);

  controller.abort();
  await assert.rejects(
    failover.chat({ messages: [], signal: controller.signal }),
    /Cancelled/
  );
  assert.deepEqual(attempts, [], "an already-cancelled request must not reach any provider");

  // With no cancellation it still does its job: every provider gets a turn.
  const open = new FailoverModelProvider([provider("a"), provider("b")]);
  await assert.rejects(open.chat({ messages: [] }), /All configured model providers failed/);
  assert.deepEqual(attempts, ["a", "b"]);
});
