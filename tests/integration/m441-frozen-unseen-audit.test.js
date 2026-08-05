import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { GeneralPlanner } from "../../packages/planner/src/index.js";
import { InteractiveAgentController } from "../../packages/agent-runtime/src/interactive-agent-controller.js";
import { createGoalContract } from "../../packages/shared-types/src/goal-contract.js";

function registry(names) {
  const capabilities = names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    execution: {
      modality: name.startsWith("browser.") ? "BROWSER_DOM"
        : /^(?:ui|window|application)\./.test(name) ? "UI_AUTOMATION"
          : "INTERNAL"
    }
  }));
  return {
    get: (name) => capabilities.find((capability) => capability.name === name) ?? null,
    getCatalog: () => capabilities
  };
}

function context(goal) {
  return {
    goalContract: createGoalContract({ rawText: goal, successCriteria: [goal] }),
    successCriteria: [goal]
  };
}

test("frozen unseen 1/6: novel internal multi-step", () => {
  const suffix = crypto.randomBytes(3).toString("hex");
  const goal = `Write north-${suffix}.log with exact content ONE; create south-${suffix}.log with content TWO; ` +
    `update north-${suffix}.log to THREE. Verify both.`;
  const plan = new GeneralPlanner(null, null).fallbackPlan({
    rawText: goal,
    normalizedGoal: goal,
    entities: { workspacePath: "C:\\tmp\\m441-frozen-1" },
    successCriteria: ["Both final values verified"]
  }, {});
  assert.deepEqual(
    plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.write").map((task) => task.inputs.content),
    ["ONE", "TWO", "THREE"]
  );
  assert.equal(plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.read").length, 2);
});

test("frozen unseen 2/6: unknown GUI read remains read-only", async () => {
  const control = {
    targetId: "uia:telemetry-beacon",
    name: "Telemetry Beacon",
    controlType: "CheckBox",
    toggleState: "On",
    supportedPatterns: ["TogglePattern"]
  };
  let launched = false;
  let modelCalls = 0;
  const goal = 'Open Generic Utility and report whether the "Telemetry Beacon" setting is on or off without changing it.';
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => { modelCalls += 1; return { ok: false, error: "not-needed" }; } },
    capabilityRegistry: registry(["application.launch"]),
    perceive: async () => launched ? {
      groundedWindow: { title: "Generic Utility" },
      relevantControls: [control]
    } : { relevantControls: [] },
    executeAction: async () => {
      launched = true;
      return {
        executionResult: { launched: true },
        observation: { relevantControls: [control] },
        verification: { status: "VERIFIED", message: "Application opened.", evidence: { launched: true } }
      };
    }
  });
  const result = await controller.run(goal, context(goal));
  assert.equal(result.status, "COMPLETE");
  assert.match(result.result.summary, /On/);
  assert.equal(modelCalls, 0);
  assert.equal(result.metrics.localActions, 1);
});

test("frozen unseen 3/6: unknown GUI action recognizes the reached postcondition", async () => {
  const target = {
    targetId: "uia:safe-preview",
    name: "Safe Preview",
    controlType: "Button",
    supportedPatterns: ["InvokePattern"]
  };
  let launched = false;
  let invoked = false;
  let modelCalls = 0;
  const goal = 'Launch Sample Utility and choose the "Safe Preview" control.';
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => { modelCalls += 1; return { ok: false, error: "provider-offline" }; } },
    capabilityRegistry: registry(["application.launch", "window.wait", "window.activate", "ui.find", "ui.action"]),
    perceive: async () => launched ? { relevantControls: [{ ...target, selected: invoked }] } : { relevantControls: [] },
    executeAction: async (action) => {
      if (action.capability === "application.launch") launched = true;
      if (action.capability === "ui.action") invoked = true;
      const output = action.capability === "application.launch"
        ? { launched: true }
        : { performed: true, target, selected: true };
      return {
        executionResult: output,
        observation: { relevantControls: [{ ...target, selected: invoked }] },
        verification: { status: "VERIFIED", message: `${action.capability} verified`, evidence: output }
      };
    }
  });
  const result = await controller.run(goal, context(goal));
  assert.equal(result.status, "COMPLETE");
  assert.equal(invoked, true);
  assert.equal(modelCalls, 0);
});

test("frozen unseen 4/6: browser to internal exact persistence", async () => {
  const value = `Lumen-${crypto.randomInt(100, 999)}`;
  const filePath = "C:\\tmp\\m441-frozen-4.txt";
  let stored = null;
  const goal = `Open data:text/html,<title>${value}</title> in a browser and save the page title to "${filePath}".`;
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => ({ ok: false, error: "not-needed" }) },
    capabilityRegistry: registry(["browser.launch", "browser.currentState", "filesystem.write", "filesystem.read"]),
    perceive: async () => ({}),
    executeAction: async (action) => {
      let output = {};
      if (action.capability === "browser.launch") output = { launched: true };
      if (action.capability === "browser.currentState") output = { title: value };
      if (action.capability === "filesystem.write") {
        stored = action.inputs.content;
        output = { filePath: action.inputs.filePath, content: stored };
      }
      if (action.capability === "filesystem.read") output = { filePath: action.inputs.filePath, contents: stored };
      return {
        executionResult: output,
        observation: { structuredState: output },
        verification: { status: "VERIFIED", message: `${action.capability} verified`, evidence: output }
      };
    }
  });
  const result = await controller.run(goal, context(goal));
  assert.equal(result.status, "COMPLETE");
  assert.equal(stored, value);
  assert.equal(result.bindings.browserValue.value, value);
  assert.equal(result.transitionContracts[0].exactTransferVerified, true);
});

test("frozen unseen 5/6: GUI to internal exact persistence", async () => {
  const value = `Pine-${crypto.randomInt(100, 999)}`;
  const filePath = "C:\\tmp\\m441-frozen-5.txt";
  let stored = null;
  const goal = `Launch Sample Utility, obtain the "Session Marker" text, then persist it in "${filePath}".`;
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => ({ ok: false, error: "not-needed" }) },
    capabilityRegistry: registry(["application.launch", "ui.extract", "filesystem.write", "filesystem.read"]),
    perceive: async () => ({ relevantControls: [{ targetId: "uia:marker", name: "Session Marker", value }] }),
    executeAction: async (action) => {
      let output = {};
      if (action.capability === "application.launch") output = { launched: true, windowIdentity: { windowId: "window:sample" } };
      if (action.capability === "ui.extract") output = { found: true, value, valueSource: "ValuePattern" };
      if (action.capability === "filesystem.write") {
        stored = action.inputs.content;
        output = { filePath: action.inputs.filePath, content: stored };
      }
      if (action.capability === "filesystem.read") output = { filePath: action.inputs.filePath, contents: stored };
      return {
        executionResult: output,
        observation: { structuredState: output },
        verification: { status: "VERIFIED", message: `${action.capability} verified`, evidence: output }
      };
    }
  });
  const result = await controller.run(goal, context(goal));
  assert.equal(result.status, "COMPLETE");
  assert.equal(stored, value);
  assert.equal(result.bindings.guiValue.value, value);
});

test("frozen unseen 6/6: three-stage cross-modal value lineage", async () => {
  const value = `Quartz-${crypto.randomInt(1000, 9999)}`;
  const filePath = "C:\\tmp\\m441-frozen-6.txt";
  const target = { targetId: "uia:destination", name: "Destination Value", controlType: "Edit", supportedPatterns: ["ValuePattern"] };
  let stored = null;
  let displayed = null;
  const goal = `Open data:text/html,<title>${value}</title> in a browser, store the title in "${filePath}", ` +
    'then put it into the "Destination Value" field in Sample Utility.';
  const names = [
    "browser.launch", "browser.currentState", "filesystem.write", "filesystem.read",
    "application.launch", "window.wait", "ui.find", "ui.action", "ui.verifyValue"
  ];
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => ({ ok: false, error: "not-needed" }) },
    capabilityRegistry: registry(names),
    perceive: async () => ({ relevantControls: [target] }),
    executeAction: async (action) => {
      let output = {};
      if (action.capability === "browser.launch") output = { launched: true };
      if (action.capability === "browser.currentState") output = { title: value };
      if (action.capability === "filesystem.write") {
        stored = action.inputs.content;
        output = { filePath: action.inputs.filePath, content: stored };
      }
      if (action.capability === "filesystem.read") output = { filePath: action.inputs.filePath, contents: stored };
      if (action.capability === "application.launch") output = { launched: true };
      if (action.capability === "window.wait") output = { found: true };
      if (action.capability === "ui.find") output = { found: true, target };
      if (action.capability === "ui.action") {
        displayed = action.inputs.text;
        output = { performed: true, target, value: displayed };
      }
      if (action.capability === "ui.verifyValue") output = { matched: displayed === action.inputs.expected, value: displayed };
      return {
        executionResult: output,
        observation: { structuredState: output, relevantControls: [target] },
        verification: { status: "VERIFIED", message: `${action.capability} verified`, evidence: output }
      };
    }
  });
  const result = await controller.run(goal, context(goal));
  assert.equal(result.status, "COMPLETE");
  assert.equal(stored, value);
  assert.equal(displayed, value);
  assert.equal(result.transitionContracts[0].exactTransferVerified, true);
  assert.equal(result.metrics.totalModelCalls, 0);
});
