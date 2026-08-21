// DOES THIS MODEL ACTUALLY EMIT ITS REASONING, AND HOW LONG BEFORE IT SAYS
// ANYTHING AT ALL?
//
//   node scripts/probe-reasoning-stream.mjs ["a request"]
//
// Two questions, both of which the chat surface currently guesses at.
//
// 1. The surface shows "Thinking…" from the instant a request is sent. For most
//    of that time nothing is thinking: the request is in flight, the endpoint is
//    queueing it, and no token has come back. Calling that "thinking" is a small
//    lie told constantly, and it is indistinguishable on screen from a network
//    stall. What is needed is the time to the FIRST byte — before it, the honest
//    word is "connecting".
//
// 2. A dropdown of "what it is thinking" is only honest if the model actually
//    sends reasoning. DeepSeek's reasoner models emit `reasoning_content` on the
//    delta alongside `content`; a non-reasoning model emits only `content`. If
//    this endpoint sends none, the dropdown must show the model's own narration
//    rather than inventing an inner monologue for it.
//
// Prints every distinct key seen on the streamed delta, so the answer comes from
// the wire rather than from documentation.

import { loadModelConfig } from "../apps/daemon/src/model-config.js";

const request = process.argv.slice(2).join(" ") || "In one sentence, what is 17 times 23?";
const model = loadModelConfig(process.cwd());
if (!model.apiKey) {
  console.error("No model API key resolved — nothing to ask.");
  process.exit(1);
}

console.log(`\nmodel: ${model.model}   host: ${new URL(model.baseUrl).host}`);
console.log(`> ${request}\n`);

const startedAt = Date.now();
const response = await fetch(`${model.baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey}` },
  body: JSON.stringify({
    model: model.model,
    messages: [{ role: "user", content: request }],
    stream: true,
    max_tokens: 300
  })
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}

const deltaKeys = new Set();
let firstByteMs = null;
let firstContentMs = null;
let firstReasoningMs = null;
let reasoning = "";
let content = "";

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstByteMs == null) firstByteMs = Date.now() - startedAt;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    const delta = chunk?.choices?.[0]?.delta ?? {};
    for (const key of Object.keys(delta)) deltaKeys.add(key);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      if (firstReasoningMs == null) firstReasoningMs = Date.now() - startedAt;
      reasoning += delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content) {
      if (firstContentMs == null) firstContentMs = Date.now() - startedAt;
      content += delta.content;
    }
  }
}

const ms = (value) => (value == null ? "never" : `${value}ms`);
console.log(`first byte off the wire      ${ms(firstByteMs)}`);
console.log(`first reasoning token        ${ms(firstReasoningMs)}`);
console.log(`first answer token           ${ms(firstContentMs)}`);
console.log(`total                        ${Date.now() - startedAt}ms`);
console.log(`\nkeys seen on the delta: ${[...deltaKeys].join(", ") || "(none)"}`);
console.log(`reasoning characters: ${reasoning.length}`);
console.log(`answer characters:    ${content.length}`);
if (reasoning) console.log(`\nreasoning began: ${JSON.stringify(reasoning.slice(0, 200))}`);
console.log(
  reasoning
    ? "\nThis model DOES send its reasoning — a thinking dropdown can show the real thing."
    : "\nThis model sends NO reasoning channel. A thinking dropdown must show the model's own\n" +
      "narration, not an invented inner monologue."
);
