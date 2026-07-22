import test from "node:test";
import assert from "node:assert/strict";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { GeneralPlanner, PlanValidator } from "../../packages/planner/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";

test("direct desktop commands bypass model planning", async () => {
  const intentEngine = new IntentEngine(null);
  const registry = createDefaultCapabilityRegistry({});
  const planner = new GeneralPlanner({
    hasModel: () => true,
    isModelHealthy: async () => { throw new Error("model must not be called"); }
  }, registry);

  for (const [text, capability] of [
    ["Open Calculator", "application.launch"],
    ["Open calclator", "application.launch"],
    ["turn the volume down a little", "system.volume.adjust"],
    ["search the web for cheap flights to Mumbai", "browser.search"]
  ]) {
    const intent = await intentEngine.classify(text);
    const plan = await planner.generatePlan(intent, []);
    assert.equal(plan.plannerSource, "DIRECT_OPERATION", text);
    assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), [capability], text);
    assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] }, text);
  }
});

test("Spotify typo still uses the immediate, typed playback route", async () => {
  const intent = await new IntentEngine(null).classify("open spotfiy and play Cry For Me");
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "Cry For Me");
});

test("volume adjustment remains a low-risk no-confirmation interaction", () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = { taskGraph: { tasks: [{ capability: "system.volume.adjust", inputs: { direction: "up", steps: 2 } }] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [registry.get("system.volume.adjust")] });
  assert.equal(assessment.overallRisk, "LOW");
  assert.equal(decision.effect, "ALLOW");
});

test("a single install pinned to the trusted WinGet source needs no visible confirmation", () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = { taskGraph: { tasks: [{ capability: "package.winget.install", inputs: { id: "Spotify.Spotify" } }] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [registry.get("package.winget.install")] });
  assert.equal(decision.effect, "ALLOW");
});
