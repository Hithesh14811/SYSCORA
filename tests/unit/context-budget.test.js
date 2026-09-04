// WITH THE RUN CEILINGS OFF, THIS IS THE ONLY BOUND LEFT ON A CONVERSATION.
//
// Before this module, `pruneConversation` and `supersedeEarlierReading` were both
// behind `SYSCORA_COLLAPSE_HISTORY=1` — off — so nothing bounded the conversation
// at all. Eighty steps and six minutes were doing the context management by
// accident. These tests pin the three things that must stay true now that they
// are not: the limit follows the MODEL, a trim never breaks the tool-call pairing
// every provider validates, and a trim says that it happened.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_TOKENS,
  conversationLimits,
  messageChars,
  resolveContextTokens,
  trimConversation
} from "../../packages/fast-agent/src/context-budget.js";

test("the context window comes from the model, not from a constant", () => {
  assert.equal(resolveContextTokens({ model: "deepseek-ai/DeepSeek-V4-Flash-0731" }), 128_000);
  assert.equal(resolveContextTokens({ model: "claude-opus-5" }), 200_000);
  assert.equal(resolveContextTokens({ model: "gemini-3-pro" }), 1_000_000);
  assert.equal(resolveContextTokens({ model: "gpt-6-astra" }), 400_000);
});

// GUESSING HIGH FOR AN UNKNOWN MODEL FAILS ON EXACTLY THE MODEL NOBODY TESTED.
// Being wrong low costs a trim that was not needed; being wrong high costs the
// run. So an unrecognised name gets the smallest window in wide use.
test("an unknown model is assumed to be the smallest window, never the largest", () => {
  assert.equal(resolveContextTokens({ model: "some-new-model-v9" }), DEFAULT_CONTEXT_TOKENS);
  assert.equal(resolveContextTokens({}), DEFAULT_CONTEXT_TOKENS);
  assert.equal(resolveContextTokens(null), DEFAULT_CONTEXT_TOKENS);
});

// A PROVIDER THAT KNOWS ITS OWN LIMIT IS ALWAYS RIGHT AND THE TABLE IS ALWAYS A
// GUESS, so the table must never win over it.
test("a provider that declares its own context window beats the table", () => {
  assert.equal(resolveContextTokens({ model: "deepseek-chat", contextTokens: 64_000 }), 64_000);
  assert.equal(
    resolveContextTokens({ model: "deepseek-chat", capabilities: () => ({ contextTokens: 999 }) }),
    999
  );
});

test("the environment overrides everything, because being wrong here is a config line", () => {
  process.env.SYSCORA_MODEL_CONTEXT_TOKENS = "42000";
  try {
    assert.equal(resolveContextTokens({ model: "gemini-3-pro", contextTokens: 1_000_000 }), 42_000);
  } finally {
    delete process.env.SYSCORA_MODEL_CONTEXT_TOKENS;
  }
});

// THE RESERVE IS THE HALF PEOPLE FORGET. The tool schema is ~5,200 tokens, it is
// sent on every request, and `messageChars` cannot see it because it is not a
// message. A budget computed without it is over by that much on every step.
test("the usable budget is smaller than the window, and by a real margin", () => {
  const limits = conversationLimits({ model: "deepseek-chat" });
  assert.equal(limits.contextTokens, 128_000);
  assert.ok(limits.availableTokens < 128_000 - 25_000,
    `the reserve must cover prompt, schema, output and margin; got ${limits.availableTokens}`);
  assert.equal(limits.maxChars, limits.availableTokens * CHARS_PER_TOKEN);
  assert.ok(limits.targetChars < limits.maxChars);
  assert.ok(limits.collapseAtChars < limits.targetChars);
});

// A model whose whole window is smaller than the reserve must not produce a
// negative budget — that is a permanent trim loop that deletes the conversation
// one step at a time and never gets under the limit.
test("a tiny window floors instead of going negative", () => {
  const limits = conversationLimits({ model: "tiny", contextTokens: 4_000 });
  assert.ok(limits.availableTokens > 0, "a negative budget is a permanent trim loop");
  assert.ok(limits.maxChars > 0);
});

const bigResult = (label) => `${label}\n${"x".repeat(5_000)}`;

function conversation(toolResults = 12) {
  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "the original request, which must survive anything" }
  ];
  for (let index = 0; index < toolResults; index += 1) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "screen", arguments: "{}" } }]
    });
    messages.push({ role: "tool", tool_call_id: `call_${index}`, content: bigResult(`reading ${index}`) });
  }
  return messages;
}

test("nothing is trimmed while the conversation fits", () => {
  const messages = conversation(2);
  const before = messageChars(messages);
  const result = trimConversation(messages, conversationLimits({ model: "deepseek-chat" }));
  assert.equal(result.trimmed, false);
  assert.equal(messageChars(messages), before);
});

// EVERY PROVIDER REJECTS AN ORPHANED TOOL CALL. OpenAI, Anthropic and Gemini all
// validate that each assistant `tool_call` has a matching `tool` reply. So the
// trim shrinks CONTENT and must never remove a message — if this test ever fails,
// long runs die at the endpoint with a validation error rather than degrading.
test("a trim never removes a message, so the tool-call pairing survives", () => {
  const messages = conversation(30);
  const countBefore = messages.length;
  const idsBefore = messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

  const result = trimConversation(messages, { maxChars: 20_000, targetChars: 11_000, collapseAtChars: 9_000 });

  assert.equal(result.trimmed, true);
  assert.equal(messages.length, countBefore, "a message was removed; every provider rejects that");
  assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), idsBefore);
  assert.ok(messageChars(messages) < result.before);
});

test("the user's request and the model's own turns are never trimmed", () => {
  const messages = conversation(30);
  trimConversation(messages, { maxChars: 20_000, targetChars: 11_000, collapseAtChars: 9_000 });
  assert.equal(messages[0].content, "SYSTEM PROMPT");
  assert.equal(messages[1].content, "the original request, which must survive anything");
});

// THE MOST RECENT RESULTS ARE WHAT THE NEXT DECISION IS MADE FROM. A trim that
// reaches them is not saving context, it is blinding the agent one step before it
// acts.
test("the newest tool results survive a trim", () => {
  const messages = conversation(30);
  const lastTool = messages[messages.length - 1].content;
  trimConversation(messages, { maxChars: 20_000, targetChars: 11_000, collapseAtChars: 9_000 });
  assert.equal(messages[messages.length - 1].content, lastTool);
});

// A SHORTENED RESULT THAT DOES NOT ANNOUNCE ITSELF IS READ AS THE WHOLE OF WHAT
// THAT TOOL RETURNED, and the model then reports a third of a listing as all of
// it. Same argument as the 256 KB row cap in SessionStore.
test("a trimmed result says it was trimmed, and how much is missing", () => {
  const messages = conversation(30);
  trimConversation(messages, { maxChars: 20_000, targetChars: 11_000, collapseAtChars: 9_000 });
  const trimmed = messages.find((m) => m.role === "tool" && String(m.content).includes("were dropped"));
  assert.ok(trimmed, "no trimmed message announced itself");
  assert.match(trimmed.content, /\d+ more characters/);
  assert.match(trimmed.content, /read it again/i);
  // The head survives, so what the result WAS is still readable.
  assert.match(trimmed.content, /^reading \d+/);
});

// Proving the trim is not vacuous: it has to get under the target, not merely
// touch something.
test("a trim gets the conversation under its target in one pass", () => {
  const messages = conversation(40);
  const limits = { maxChars: 20_000, targetChars: 11_000, collapseAtChars: 9_000 };
  trimConversation(messages, limits);
  assert.ok(messageChars(messages) <= limits.maxChars,
    `still over the limit after one pass: ${messageChars(messages)}`);
});
