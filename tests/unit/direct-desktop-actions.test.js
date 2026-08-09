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

  for (const [text, capabilities] of [
    ["Open Calculator", ["application.launch"]],
    ["Open calclator", ["application.launch"]],
    // Adjusting the volume is followed by an independent read of the resulting
    // level. The keystroke is not the outcome — "I sent a volume-down command"
    // is exactly the kind of claim that cannot be checked, and the endpoint read
    // is what turns it into a verifiable one.
    ["turn the volume down a little", ["system.volume.adjust", "system.volume.inspect"]],
    ["search the web for cheap flights to Mumbai", ["browser.search"]]
  ]) {
    const intent = await intentEngine.classify(text);
    const plan = await planner.generatePlan(intent, []);
    assert.equal(plan.plannerSource, "DIRECT_OPERATION", text);
    assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), capabilities, text);
    assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] }, text);
  }
});

test("setting an absolute volume reads before and after, so the change is provable", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const planner = new GeneralPlanner({ hasModel: () => false }, registry);
  // The model is free to name this entity whatever it likes; the compiler must
  // still find it. `targetVolumePercent` is what it actually returned live, and
  // reading only `percent` produced a task with no inputs that died on its own
  // precondition check.
  const intent = {
    rawText: "set the volume to 26%",
    normalizedGoal: "Set the system volume to 26%",
    operation: "system.volume.set",
    entities: { targetVolumePercent: "26" },
    successCriteria: ["The master volume is 26%"]
  };
  const plan = await planner.generatePlan(intent, []);
  assert.deepEqual(
    plan.taskGraph.tasks.map((task) => task.capability),
    ["system.volume.inspect", "system.volume.set", "system.volume.inspect"]
  );
  assert.equal(plan.taskGraph.tasks[1].inputs.percent, 26);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("a required input the planner could not resolve empties the graph instead of running", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const planner = new GeneralPlanner({ hasModel: () => false }, registry);
  // `package.winget.inspect` needs an id. When the request names none, the
  // compiler used to emit `{ id: undefined }`, which passed schema validation
  // (the key was present) and failed inside the capability — surfacing the
  // internal string "Capability package.winget.inspect preconditions failed" as
  // the user's entire answer. An unbuildable plan must not reach execution.
  const plan = await planner.generatePlan({
    rawText: "is python installed",
    normalizedGoal: "Check whether Python is installed",
    operation: "package.winget.inspect",
    entities: {},
    successCriteria: ["Python installation state is known"]
  }, []);
  assert.equal(plan.taskGraph.tasks.length, 0);
  assert.equal(plan.plannerRejection?.reason, "PLAN_FAILED_VALIDATION");
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

test("a single install pinned to WinGet still requires explicit confirmation", () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = { taskGraph: { tasks: [{ capability: "package.winget.install", inputs: { id: "Spotify.Spotify" } }] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [registry.get("package.winget.install")] });
  assert.equal(decision.effect, "CONFIRM");
});
