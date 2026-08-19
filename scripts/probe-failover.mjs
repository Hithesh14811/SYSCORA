// DOES A DEAD MODEL ENDPOINT ACTUALLY COST US A RUN?
//
//   node scripts/probe-failover.mjs ["a request to run for real"]
//
// The failover machinery has existed in `packages/model-providers` since long
// before anything was configured to use it — `FailoverModelProvider`,
// `createModelProviderChain`, five implemented providers — and `.syscora/config.json`
// named exactly one endpoint. So "we have failover" was a statement about the
// code and not about this machine, and the difference showed up the day four
// consecutive turns died on `fetch failed`.
//
// This proves it end to end instead: it kills the primary and checks that a real
// request still finishes. Four parts, and only the last one is the claim —
// the first three are what make the last one interpretable when it fails.
//
// NEVER PRINTS A KEY. `.syscora/` holds them in plaintext; this reports the
// endpoint, the model and the length of the credential, which is enough to tell
// two accounts apart and not enough to use one.

import { spawn } from "node:child_process";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";
import { createModelProviderChain } from "../packages/model-providers/src/index.js";

// Port 9 is the discard service and nothing listens on it, so a connection is
// refused immediately rather than hanging — a dead endpoint that fails FAST,
// which is what a failover test wants. A wrong API key would be a slower and
// less honest stand-in: some providers answer a bad key with a 200 and an error
// body, which is a different failure from an unreachable host.
const DEAD_ENDPOINT = "http://127.0.0.1:9/v1";
const REQUEST = process.argv.slice(2).join(" ") || "what is 17 times 23";

const config = loadModelConfig(process.cwd());
const chain = createModelProviderChain(config);

console.log("=== 1. the chain, in the order it will be tried ===\n");
if (chain.providers.length === 1) {
  console.log("  ONE provider. There is nothing to fail over to — see .syscora/config.json,");
  console.log("  `model.fallbackProviderConfigs`. The rest of this probe cannot mean anything.\n");
}
chain.providers.forEach((provider, index) => {
  console.log(
    `  ${index + 1}. ${String(provider.name).padEnd(12)} ${String(provider.model ?? "?").padEnd(36)} ` +
    `${provider.baseUrl ?? "(default)"}`
  );
});

console.log("\n=== 2. does each one answer, on its own ===\n");
const liveness = [];
for (const provider of chain.providers) {
  const startedAt = Date.now();
  try {
    const reply = await provider.chat({
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 25000
    });
    const elapsed = Date.now() - startedAt;
    liveness.push({ provider, ok: true });
    console.log(`  ✓ ${String(provider.baseUrl).padEnd(34)} ${String(elapsed).padStart(5)}ms  ${JSON.stringify(String(reply.text ?? "").trim().slice(0, 24))}`);
  } catch (error) {
    liveness.push({ provider, ok: false });
    console.log(`  ✗ ${String(provider.baseUrl).padEnd(34)} ${String(Date.now() - startedAt).padStart(5)}ms  ${String(error?.message ?? error).slice(0, 90)}`);
  }
}
const healthy = liveness.filter((entry) => entry.ok).length;
console.log(`\n  ${healthy} of ${liveness.length} endpoints answered.`);

console.log("\n=== 3. with a dead endpoint in front, WHICH one answers ===\n");
// The receipt, not an inference. `lastRequestProvider` is set by
// FailoverModelProvider on the provider that actually returned, so this says
// which endpoint served the request rather than concluding it from success.
const withDeadPrimary = createModelProviderChain({
  ...config,
  baseUrl: DEAD_ENDPOINT,
  fallbackProviderConfigs: config.fallbackProviderConfigs
});
try {
  const startedAt = Date.now();
  await withDeadPrimary.chat({
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    maxTokens: 64,
    temperature: 0,
    timeoutMs: 25000
  });
  const served = withDeadPrimary.lastRequestProvider;
  console.log(`  answered by ${served?.baseUrl} (${served?.model}) in ${Date.now() - startedAt}ms`);
  console.log(served?.baseUrl === DEAD_ENDPOINT
    ? "  FAIL — the dead endpoint cannot have answered; the probe is wrong."
    : "  PASS — a different endpoint served it, which is what failover means.");
} catch (error) {
  console.log(`  FAIL — nothing answered: ${String(error?.message ?? error).slice(0, 200)}`);
  console.log("  With only one configured provider this is the expected result, and it is the problem.");
}

console.log("\n=== 4. a real request, end to end, with the primary killed ===\n");
console.log(`  > ${REQUEST}\n`);
// Through the ordinary probe in a child process, so this exercises the real
// runtime — daemon wiring, consent wrapper, the agent loop — and not a provider
// object assembled here. SYSCORA_MODEL_BASE_URL overrides the PRIMARY only;
// `fallbackProviderConfigs` is read from the file and is untouched by it.
const outcome = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/probe-fast-agent.mjs", REQUEST], {
    cwd: process.cwd(),
    env: { ...process.env, SYSCORA_MODEL_BASE_URL: DEAD_ENDPOINT }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", () => {});
  child.on("close", () => resolve(output));
});
for (const line of outcome.split("\n").slice(-8)) console.log(`  ${line}`);

const settled = /^(COMPLETED|PARTIALLY_COMPLETED|FAILED|CANCELLED)/m.exec(outcome)?.[1];
console.log("");
console.log(settled === "COMPLETED"
  ? "  PASS — the primary endpoint was unreachable and the request finished anyway."
  : `  FAIL — the run settled ${settled ?? "not at all"} with the primary dead.`);
process.exit(0);
