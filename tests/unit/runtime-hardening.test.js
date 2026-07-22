import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { RollbackManager } from "../../packages/agent-runtime/src/rollback-manager.js";
import { GeneralPlanner, PlanValidator } from "../../packages/planner/src/index.js";
import { WorkspaceContextProvider } from "../../packages/context-engine/src/index.js";
import { OpenAIModelProvider } from "../../packages/model-providers/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";

function rollbackCapability(name, calls) {
  return {
    name,
    reversibility: "ROLLBACK_SUPPORTED",
    createCheckpoint: async () => ({ before: name }),
    rollback: async () => { calls.push(name); }
  };
}

test("capability registry rejects duplicate canonical registrations", () => {
  const registry = new CapabilityRegistry();
  const cap = { name: "unique.capability", reversibility: "NOT_REQUIRED" };
  registry.register(cap);
  assert.throws(() => registry.register(cap), /Duplicate capability registration/);
});

test("rollback manager restores dependents before their dependencies", async () => {
  const calls = [];
  const registry = new CapabilityRegistry([
    rollbackCapability("change.a", calls),
    rollbackCapability("change.b", calls)
  ]);
  const manager = new RollbackManager(registry);
  const a = await manager.capture({ taskId: "a", capability: "change.a", inputs: {}, dependencies: [] });
  const b = await manager.capture({ taskId: "b", capability: "change.b", inputs: {}, dependencies: ["a"] });
  const result = await manager.rollback([a, b]);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls, ["change.b", "change.a"]);
});

test("operation planner emits a validator-accepted WinGet install graph", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const planner = new GeneralPlanner(null, registry);
  const plan = await planner.generatePlan({
    operation: "package.winget.install",
    normalizedGoal: "Install package",
    entities: { id: "Contoso.App" },
    successCriteria: ["installed"]
  }, []);
  assert.equal(plan.taskGraph.tasks[0].timeout, 600000);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("installed-package question maps to one read-only WinGet status check", async () => {
  const intent = await new IntentEngine(null).classify("Is Spotify installed on this device?");
  assert.equal(intent.operation, "package.winget.inspect");
  assert.equal(intent.entities.id, "Spotify.Spotify");

  const registry = createDefaultCapabilityRegistry({ wingetList: async () => ({ exitCode: 0, stdout: "Spotify.Spotify" }) });
  const planner = new GeneralPlanner(null, registry);
  const plan = await planner.generatePlan(intent, []);
  assert.equal(plan.plannerSource, "DIRECT_OPERATION");
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["package.winget.inspect"]);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("known package install and system-info requests use direct operations", async () => {
  const engine = new IntentEngine(null);
  const install = await engine.classify("Install Spotify");
  const system = await engine.classify("Show me my system specs");
  assert.equal(install.operation, "package.winget.install");
  assert.equal(install.entities.id, "Spotify.Spotify");
  assert.equal(system.operation, "system.inspect");
});

test("Spotify play phrasing bypasses model planning and plays the requested track", async () => {
  const intent = await new IntentEngine(null).classify('Open Spotify and play "Cry For Me"');
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "Cry For Me");
  const registry = createDefaultCapabilityRegistry({
    playSpotifyTrack: async () => ({ available: true, playback: { playing: true } }),
    readSpotifyPlayback: async () => ({ playing: true, title: "The Weeknd - Cry For Me" })
  });
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  assert.equal(plan.plannerSource, "DIRECT_OPERATION");
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["spotify.track.play"]);
});

test("launching an installed app and opening a search is a low-risk interaction", () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = { taskGraph: { tasks: [
    { capability: "package.winget.inspect" },
    { capability: "application.launch" },
    { capability: "browser.search" }
  ] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan);
  assert.equal(assessment.overallRisk, "LOW");
  assert.equal(decision.effect, "ALLOW");
});

test("workspace context awaits the developer intelligence contract", async () => {
  const provider = new WorkspaceContextProvider({}, {
    async inspectProject(workspacePath) { return { workspacePath, projectType: "node" }; }
  });
  const context = await provider.collect({ workspacePath: "C:\\workspace" });
  assert.deepEqual(context.data.inspection, { workspacePath: "C:\\workspace", projectType: "node" });
});

test("OpenAI retries with a fresh AbortController per attempt", async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    signals.push(options.signal);
    attempts += 1;
    if (attempts === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }), { status: 200 });
  };
  try {
    const provider = new OpenAIModelProvider({ apiKey: "test-key" });
    const result = await provider.generateStructured("test", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, { maxRetries: 2 });
    assert.deepEqual(result, { ok: true });
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
