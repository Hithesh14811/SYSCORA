// WHAT MODEL ENDPOINTS ARE CONFIGURED, AND IS EACH KEY ALIVE?
//
//   node scripts/probe-model-endpoints.mjs            describe them
//   node scripts/probe-model-endpoints.mjs --test     also send one real request to each
//   SYSCORA_CANDIDATE_KEY=... node scripts/probe-model-endpoints.mjs --test-candidate <baseUrl> <model>
//
// NO KEY IS EVER PRINTED. A previous session leaked the live key into a
// transcript by dumping config.json to check exactly this, so the only thing
// this will say about a key is its length and a short hash of it — enough to
// tell two keys apart and to confirm a write landed, and useless to anyone who
// reads the output.
//
// "Configured" and "working" are separate claims and are reported separately,
// for the same reason probe-failover.mjs separates the machinery from the
// billing: an endpoint listed in a config file is not an endpoint that answers.

import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";
// THROUGH THE LOADER THE DAEMON USES, not by parsing config.json.
//
// Once the keys moved into DPAPI (scripts/protect-model-key.mjs) the file holds
// references like "dpapi:model-primary.bin", and a probe that read the file
// directly would report every endpoint DEAD while the product worked perfectly.
// What is being tested here is whether the endpoints answer for the credentials
// THE DAEMON WILL PRESENT, so it has to resolve them the same way.
import { loadModelConfig } from "../apps/daemon/src/model-config.js";

const configPath = path.join(resolveStateDir(process.cwd()), "config.json");
const fingerprint = (key) => {
  if (!key) return "—";
  const hash = crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
  return `${String(key).length} chars, #${hash}`;
};

const model = loadModelConfig(process.cwd());

const entries = [
  { label: "primary", provider: model.provider, model: model.model, baseUrl: model.baseUrl, apiKey: model.apiKey },
  ...(model.fallbackProviderConfigs ?? []).map((entry, index) => ({
    label: `fallback ${index + 1}`,
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    inherits: entry.apiKeyFromExistingConfig === true
  }))
];

console.log(`\nconfig: ${configPath}\n`);
for (const entry of entries) {
  console.log(`  ${entry.label.padEnd(12)} ${String(entry.provider ?? "?").padEnd(12)} ${String(entry.model ?? "?").padEnd(28)}`);
  console.log(`  ${"".padEnd(12)} ${String(entry.baseUrl ?? "?")}`);
  console.log(`  ${"".padEnd(12)} key: ${fingerprint(entry.apiKey)}${entry.inherits ? "  (inherited from the primary)" : ""}`);
  console.log("");
}

// ONE REAL REQUEST IS THE ONLY EVIDENCE A KEY IS ALIVE.
//
// Not a HEAD, not a models list — an out-of-credit account answers those
// perfectly well and then returns 402 on the thing you actually want. This asks
// for one token of completion, which is the cheapest request that exercises
// billing.
const testKey = async ({ baseUrl, model: modelName, apiKey }) => {
  if (!apiKey || !baseUrl || !modelName) return { ok: false, reason: "not fully configured" };
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelName, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(60000)
    });
    const text = await response.text();
    if (!response.ok) {
      // The body can echo the key back in an error. Say the status and the first
      // line only, with anything key-shaped removed.
      const safe = text.replace(/[A-Za-z0-9_.-]{20,}/g, "<redacted>").slice(0, 200);
      return { ok: false, reason: `HTTP ${response.status}: ${safe}` };
    }
    const parsed = JSON.parse(text);
    return { ok: true, reason: `answered, finish_reason=${parsed?.choices?.[0]?.finish_reason ?? "?"}` };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
};

if (process.argv.includes("--test")) {
  console.log("one real request each\n");
  for (const entry of entries) {
    const result = await testKey(entry);
    console.log(`  ${entry.label.padEnd(12)} ${result.ok ? "ALIVE" : "DEAD "}  ${result.reason}`);
  }
  console.log("");
}

if (process.argv.includes("--test-candidate")) {
  const index = process.argv.indexOf("--test-candidate");
  const baseUrl = process.argv[index + 1];
  const modelName = process.argv[index + 2];
  const apiKey = process.env.SYSCORA_CANDIDATE_KEY;
  if (!apiKey) {
    console.log("SYSCORA_CANDIDATE_KEY is not set — nothing to test.\n");
    process.exit(2);
  }
  console.log(`candidate key ${fingerprint(apiKey)} against ${baseUrl} / ${modelName}\n`);
  const result = await testKey({ baseUrl, model: modelName, apiKey });
  console.log(`  ${result.ok ? "ALIVE" : "DEAD "}  ${result.reason}\n`);
  process.exit(result.ok ? 0 : 1);
}
