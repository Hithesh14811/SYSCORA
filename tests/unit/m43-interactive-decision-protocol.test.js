import test from "node:test";
import assert from "node:assert/strict";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { normalizeInteractiveDecision } from "../../packages/shared-types/src/interactive-decision.js";

function registry(...names) {
  return {
    getCatalog: () => names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    get: (name) => names.includes(name) ? { name } : null
  };
}

class ScriptedProvider {
  constructor(values) {
    this.values = [...values];
    this.calls = 0;
  }
  async generateStructured() {
    this.calls += 1;
    return this.values.shift();
  }
}

test("normalizes status plus nextAction into canonical ACT", () => {
  const normalized = normalizeInteractiveDecision({
    status: "IN_PROGRESS",
    nextAction: { capabilityName: "ui.inspect", parameters: { application: "Example" } }
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.data.kind, "ACT");
  assert.equal(normalized.data.action.capability, "ui.inspect");
  assert.deepEqual(normalized.data.action.inputs, { application: "Example" });
});

test("normalizes nested actions and completion without action", () => {
  const act = normalizeInteractiveDecision({
    status: "CONTINUE",
    continuation: { action: { name: "window.wait", input: { application: "Example" } } }
  });
  assert.equal(act.data.kind, "ACT");
  assert.equal(act.data.action.capability, "window.wait");

  const complete = normalizeInteractiveDecision({
    goalStatus: "COMPLETED",
    result: { summary: "Done" },
    verification: { allCriteriaSatisfied: true, satisfiedCriteria: [] }
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.data.kind, "COMPLETE");
  assert.equal(complete.data.action, undefined);
});

test("normalizes observe, recover, fail, and clarify intents", () => {
  assert.equal(normalizeInteractiveDecision({ status: "OBSERVE", reason: "refresh" }).data.kind, "OBSERVE");
  assert.equal(normalizeInteractiveDecision({ status: "RECOVER", strategy: "refresh-window" }).data.kind, "RECOVER");
  assert.equal(normalizeInteractiveDecision({ status: "FAILED", reason: "unsafe" }).data.kind, "FAIL");
  assert.equal(normalizeInteractiveDecision({ status: "NEEDS_USER", question: "Which app?" }).data.kind, "CLARIFY");
});

test("ReasoningEngine performs one bounded repair after normalization fails", async () => {
  const provider = new ScriptedProvider([
    { status: "IN_PROGRESS", reason: "No action supplied" },
    { status: "IN_PROGRESS", nextAction: { capability: "ui.inspect", inputs: { application: "Example" } } }
  ]);
  const reasoning = new ReasoningEngine({
    modelProvider: provider,
    capabilityRegistry: registry("ui.inspect"),
    repairAttempts: 1
  });
  const result = await reasoning.decideInteractiveAction({
    goal: "Inspect Example",
    availableCapabilities: registry("ui.inspect").getCatalog(),
    initialContext: { successCriteria: ["Controls are reported"] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.kind, "ACT");
  assert.equal(provider.calls, 2);
});

test("normalization never makes an unknown capability executable", async () => {
  const provider = new ScriptedProvider([
    { status: "IN_PROGRESS", nextAction: { capability: "unsafe.shell", inputs: {} } },
    { status: "IN_PROGRESS", nextAction: { capability: "unsafe.shell", inputs: {} } }
  ]);
  const reasoning = new ReasoningEngine({
    modelProvider: provider,
    capabilityRegistry: registry("ui.inspect"),
    repairAttempts: 1
  });
  const result = await reasoning.decideInteractiveAction({
    goal: "Inspect Example",
    availableCapabilities: registry("ui.inspect").getCatalog(),
    initialContext: { successCriteria: [] }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown capability/);
  assert.equal(provider.calls, 2);
});
