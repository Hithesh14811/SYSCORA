// OPT-IN real-model proof (Phase 7). Spends real API credits, so it is SKIPPED
// unless SYSCORA_REAL_MODEL_TEST=1. It proves the full production path:
//   free-text intent -> ReasoningEngine -> AgentRouter HTTP -> configured model
//   -> structured plan -> PlanValidator -> real capabilities -> scheduler ->
//   observe -> verify -> result, with plannerSource === "MODEL_REASONING".
// Then it forces the provider unavailable and proves the SAME goal completes via
// the deterministic fallback. Never prints the API key.
//
// Run before a demo:  SYSCORA_REAL_MODEL_TEST=1 node --test tests/integration/m3-real-model.test.js

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { loadModelConfig } from "../../apps/daemon/src/model-config.js";

const enabled = process.env.SYSCORA_REAL_MODEL_TEST === "1";
const realModel = (name, fn) =>
  test(name, { skip: enabled ? false : "set SYSCORA_REAL_MODEL_TEST=1 to run (uses API credits)" }, fn);

realModel("real model composes a validated executable plan; provider-down falls back", async () => {
  // Uses whatever provider .syscora/config.json / env resolves to (AgentRouter).
  const cfg = loadModelConfig(process.cwd());
  assert.ok(cfg.apiKey, "a real provider API key must be configured (.syscora/config.json or env)");
  // Do NOT print the key. Only the non-secret provider/model identity.
  console.log(`[real-model] provider=${cfg.provider} model=${cfg.model ?? "(default)"}`);

  // createRuntime reads config from <basePath>/.syscora/config.json. This test
  // runs against a TEMP basePath, so export the resolved config as env (which
  // takes priority in loadModelConfig) to ensure the real gateway is used.
  process.env.SYSCORA_MODEL_PROVIDER = cfg.provider;
  process.env.SYSCORA_MODEL_API_KEY = cfg.apiKey;
  if (cfg.model) process.env.SYSCORA_MODEL_NAME = cfg.model;
  if (cfg.baseUrl) process.env.SYSCORA_MODEL_BASE_URL = cfg.baseUrl;

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-realmodel-"));

  // A novel, non-templated prompt so this cannot be a deterministic keyword hit.
  const prompt =
    "Take a look at this Windows machine from a developer's perspective and figure out what tooling I already have available.";

  const started = Date.now();
  const s = await runtimeSubmit(base, prompt);
  const latency = Date.now() - started;

  console.log(`[real-model] source=${s.plan?.plannerSource} status=${s.finalResponse?.status} latency=${latency}ms caps=${(s.plan?.taskGraph?.tasks ?? []).map((t) => t.capability).join(",")}`);

  assert.equal(s.plan.plannerSource, "MODEL_REASONING", "the real model (not fallback) must have produced the plan");
  assert.ok((s.plan.taskGraph.tasks ?? []).length > 0, "model produced a non-empty task graph");
  for (const t of s.plan.taskGraph.tasks) {
    assert.ok(t.capability, "every task names a real capability");
  }
  // A model-composed plan is a genuine success whether it ran to completion OR
  // correctly parked for approval because the model proposed mutating steps —
  // both prove real reasoning drove a valid, policy-gated plan.
  assert.ok(
    ["COMPLETED", "COMPLETED_WITH_WARNINGS", "AWAITING_APPROVAL"].includes(s.finalResponse.status),
    `model-planned goal reached a valid gated outcome (was ${s.finalResponse.status})`
  );

  // Same goal, provider forced unavailable -> deterministic fallback still works.
  process.env.SYSCORA_MODEL_PROVIDER = "agentrouter";
  process.env.SYSCORA_MODEL_API_KEY = "sk-dead-key";
  process.env.SYSCORA_MODEL_BASE_URL = "https://127.0.0.1:9/v1";
  try {
    const base2 = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-realmodel-fb-"));
    const started2 = Date.now();
    const s2 = await runtimeSubmit(base2, prompt);
    const latency2 = Date.now() - started2;
    console.log(`[real-model] FALLBACK source=${s2.plan?.plannerSource} status=${s2.finalResponse?.status} latency=${latency2}ms`);
    assert.equal(s2.plan.plannerSource, "DETERMINISTIC_FALLBACK", "provider-down must fall back deterministically");
    assert.equal(s2.finalResponse.status, "COMPLETED");
    assert.ok(latency2 < 12000, `fallback must be bounded, took ${latency2}ms`);
  } finally {
    delete process.env.SYSCORA_MODEL_API_KEY;
    delete process.env.SYSCORA_MODEL_BASE_URL;
    delete process.env.SYSCORA_MODEL_PROVIDER;
    delete process.env.SYSCORA_MODEL_NAME;
  }
});

async function runtimeSubmit(base, text) {
  const runtime = createRuntime(base);
  return runtime.submitIntent(text, { autoApprove: false, workspacePath: base });
}
