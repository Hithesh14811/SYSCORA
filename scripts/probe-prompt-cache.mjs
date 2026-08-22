// DOES THIS PROVIDER CACHE THE PROMPT PREFIX, AND CAN WE SEE IT?
//
//   node scripts/probe-prompt-cache.mjs
//
// 8,222 tokens of system prompt and tool schema are byte-identical on every step
// of every run and are re-sent every time. That is the central business problem
// in docs/production-plan.md (W2.1), and the whole question is empirical: an
// OpenAI-compatible endpoint backed by vLLM or SGLang caches prefixes
// automatically and reports the hit in `usage`, or it does not do either, and
// which one it is decides whether W2.1 is a day of work or a change of provider.
//
// So this asks the endpoint directly. Three requests:
//
//   1. a cold one, to establish the shape of `usage`;
//   2. the SAME prefix with a different last message — what step 2 of a real run
//      looks like, and the case that must hit;
//   3. a deliberately DIFFERENT prefix, so a "hit" that is really the endpoint
//      reporting the same number every time cannot be mistaken for a cache.
//
// It prints the raw usage object each time rather than a field this script
// picked, because the field name is exactly what is unknown — DeepSeek's own API
// says `prompt_cache_hit_tokens`, OpenAI says `prompt_tokens_details.cached_
// tokens`, and a vLLM gateway may say nothing at all.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
// THE SAME RESOLVER THE DAEMON USES, not a second reading of the config file.
// Environment variables outrank the file and `primaryApiKey` outranks `apiKey`;
// a probe that re-derives that gets 403 against an endpoint the product reaches
// perfectly well, and sends you debugging the wrong thing.
import { loadModelConfig } from "../apps/daemon/src/model-config.js";

const model = loadModelConfig(process.cwd());
const apiKey = model.apiKey;
if (!apiKey) {
  console.error("No model API key resolved — nothing to ask.");
  process.exit(1);
}

const adapter = new WindowsAdapter();
const toolset = buildToolset({
  registry: createDefaultCapabilityRegistry(adapter),
  adapter,
  basePath: process.cwd()
});

// The real system prompt, so the prefix under test is the prefix a run sends.
const { FastAgent } = await import("../packages/fast-agent/src/index.js");
const systemPrompt = new FastAgent({ provider: null, toolset }).systemPrompt;

async function ask(label, messages, { stream = false, streamOptions = null } = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model.model,
      messages,
      tools: toolset.definitions,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 16,
      stream,
      ...(streamOptions ? { stream_options: streamOptions } : {})
    })
  });
  if (!response.ok) {
    console.log(`${label}: HTTP ${response.status} — ${(await response.text()).slice(0, 200)}`);
    return null;
  }
  let usage = null;
  if (stream) {
    // Read it the way the agent loop reads it: usage rides on a chunk, or it
    // does not arrive at all.
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        if (chunk.usage) usage = chunk.usage;
      } catch { /* a partial frame is not a failure */ }
    }
  } else {
    usage = (await response.json()).usage ?? null;
  }
  console.log(`\n${label}  (${Date.now() - startedAt}ms)`);
  console.log(`  usage: ${JSON.stringify(usage)}`);
  return usage;
}

const base = [{ role: "system", content: systemPrompt }];

console.log(`endpoint: ${model.baseUrl}`);
console.log(`model:    ${model.model}`);
console.log(`prefix:   system prompt + ${toolset.definitions.length} tool schemas`);

// 1 — cold.
const cold = await ask("1. cold, prefix never sent", [
  ...base,
  { role: "user", content: "Say OK." }
]);

// 2 — the same prefix, a different tail. This is step 2 of every real run.
const warm = await ask("2. SAME prefix, different last message", [
  ...base,
  { role: "user", content: "Say OK twice." }
]);

// 3 — a different prefix, as the control. A number that does not move between
// 2 and 3 is not a cache, it is a constant.
//
// THE DIFFERENCE HAS TO BE AT THE START. The first version of this control
// APPENDED a unique sentence to the system prompt and reported a full cache hit,
// which is correct and meaningless: a prefix cache matches the longest common
// PREFIX, so 8,320 tokens of identical system prompt still hit no matter what
// follows them. That is also the single most useful fact about it — anything
// that changes an EARLY message costs the cache for everything after it, and
// anything appended at the end costs nothing.
const control = await ask("3. DIFFERENT prefix (control — differs at the FIRST token)", [
  { role: "system", content: `Unrelated preamble ${Date.now()}.\n\n${systemPrompt}` },
  { role: "user", content: "Say OK." }
]);

// 4 — AND THE WAY THE AGENT ACTUALLY ASKS. The loop streams, and an
// OpenAI-compatible endpoint sends no usage frame on a streamed response unless
// `stream_options: {include_usage: true}` is set. If the counters do not survive
// streaming, then every number this project has ever quoted about its own cost
// was measured through a channel that cannot see the cache.
const streamed = await ask("4. streamed, same prefix (how the loop asks)", [
  ...base,
  { role: "user", content: "Say OK three times." }
], { stream: true });
const streamedWithOption = await ask("5. streamed + stream_options.include_usage", [
  ...base,
  { role: "user", content: "Say OK four times." }
], { stream: true, streamOptions: { include_usage: true } });

const cachedIn = (usage) => {
  if (!usage) return null;
  const candidates = [
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cached_tokens,
    usage.cache_read_input_tokens
  ];
  const found = candidates.find((value) => Number.isFinite(Number(value)));
  return found === undefined ? null : Number(found);
};

console.log("\n---");
const warmHit = cachedIn(warm);
if (warmHit === null) {
  console.log("VERDICT: this endpoint reports NO cache counter of any known name.");
  console.log("  That does not prove it is not caching — vLLM and SGLang cache prefixes");
  console.log("  automatically and many gateways simply never surface it. What it does prove");
  console.log("  is that we cannot MEASURE a cache hit here, and W2.1's done-criterion is a");
  console.log("  measured number. Compare the latency of 1 and 2 above: a large prefix served");
  console.log("  from a cache is markedly faster to first token.");
} else {
  const controlHit = cachedIn(control) ?? 0;
  console.log(`VERDICT: cached tokens reported — warm ${warmHit}, control ${controlHit}.`);
  console.log(warmHit > controlHit
    ? "  The prefix IS being reused. Billable fixed cost after step 1 is the miss count."
    : "  The counter does not move with the prefix, so it is not evidence of a cache.");
}
console.log(`\nfixed prefix, uncached: ${cold?.prompt_tokens ?? "?"} prompt tokens per step.`);

console.log("\nStreamed — which is how the agent loop asks:");
console.log(`  plain stream:                usage ${streamed ? "arrives" : "NEVER ARRIVES"}` +
  `${streamed ? `, cached ${cachedIn(streamed)}` : ""}`);
console.log(`  stream + include_usage:      usage ${streamedWithOption ? "arrives" : "NEVER ARRIVES"}` +
  `${streamedWithOption ? `, cached ${cachedIn(streamedWithOption)}` : ""}`);
if (streamed && cachedIn(streamed) === null && streamedWithOption && cachedIn(streamedWithOption) !== null) {
  console.log("  → the loop must send stream_options.include_usage to see the cache at all.");
}
process.exit(0);
