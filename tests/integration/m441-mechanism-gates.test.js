import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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

test("M4.4.1 gate 1: novel internal composition retains three operations, two artifacts, and exact readback", () => {
  const marker = crypto.randomBytes(4).toString("hex");
  const goal = `Create cedar-${marker}.txt with content NORTH, create birch-${marker}.txt with content SOUTH, ` +
    `then rewrite cedar-${marker}.txt to EAST. Verify both.`;
  const plan = new GeneralPlanner(null, null).fallbackPlan({
    rawText: goal,
    normalizedGoal: goal,
    entities: { workspacePath: "C:\\tmp\\m441-gate-1" },
    successCriteria: ["Both artifacts have exact final content"]
  }, {});
  const writes = plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.write");
  const reads = plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.read");
  assert.deepEqual(writes.map((task) => task.inputs.content), ["NORTH", "SOUTH", "EAST"]);
  assert.equal(reads.length, 2);
  assert.equal(reads.find((task) => path.basename(task.inputs.filePath).startsWith("cedar-")).completionCriteria[0].includes("EAST"), true);
});

test("M4.4.1 gate 2: unknown GUI action completes locally after provider becomes unavailable", async () => {
  const target = {
    targetId: "uia:harmless-mode",
    name: "Harmless Mode",
    controlType: "Button",
    supportedPatterns: ["InvokePattern"]
  };
  let launched = false;
  let modelCalls = 0;
  const goal = 'Open Generic Utility and select the "Harmless Mode" control.';
  const controller = new InteractiveAgentController({
    reasoningEngine: {
      async decideInteractiveAction() {
        modelCalls += 1;
        return { ok: false, error: "provider-unavailable-after-postcondition" };
      }
    },
    capabilityRegistry: registry(["application.launch", "window.wait", "window.activate", "ui.find", "ui.action"]),
    perceive: async () => launched ? { relevantControls: [target] } : { relevantControls: [] },
    executeAction: async (action) => {
      if (action.capability === "application.launch") launched = true;
      return {
        executionResult: action.capability === "application.launch"
          ? { launched: true, windowIdentity: { windowId: "window:generic" } }
          : { performed: true, target },
        observation: launched ? { relevantControls: [{ ...target, selected: action.capability === "ui.action" }] } : {},
        verification: {
          status: "VERIFIED",
          message: action.capability === "ui.action" ? "Harmless Mode selected." : "Generic Utility opened.",
          evidence: { target, launched }
        }
      };
    }
  });
  const result = await controller.run(goal, {
    goalContract: createGoalContract({ rawText: goal, successCriteria: [goal] }),
    successCriteria: [goal]
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(modelCalls, 0);
  assert.equal(result.metrics.localActions, 5);
});

test("M4.4.1 gate 3: grounded GUI value persists internally with exact typed lineage", async () => {
  const value = `Nimbus-${crypto.randomInt(1000, 9999)}`;
  const filePath = "C:\\tmp\\m441-gate-3.txt";
  let stored = null;
  const names = ["application.launch", "ui.extract", "filesystem.write", "filesystem.read"];
  const goal = `Open Generic Utility, read the "Status Token" label, and save it to "${filePath}".`;
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => ({ ok: false, error: "model-must-not-be-needed" }) },
    capabilityRegistry: registry(names),
    perceive: async () => ({ relevantControls: [{ targetId: "uia:status", name: "Status Token", value }] }),
    executeAction: async (action) => {
      let output;
      if (action.capability === "application.launch") output = { launched: true, windowIdentity: { windowId: "window:generic" } };
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
  const result = await controller.run(goal, {
    goalContract: createGoalContract({ rawText: goal, successCriteria: [goal] }),
    successCriteria: [goal]
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(stored, value);
  assert.equal(result.bindings.guiValue.value, value);
  assert.equal(result.transitionContracts[0].exactTransferVerified, true);
});

test("M4.4.1 gate 4: three modalities preserve one random binding through persistence and GUI verification", async () => {
  const value = `Aster-${crypto.randomInt(1000, 9999)}`;
  const filePath = "C:\\tmp\\m441-gate-4.txt";
  const target = { targetId: "uia:transfer", name: "Transfer Field", controlType: "Edit", supportedPatterns: ["ValuePattern"] };
  let stored = null;
  let displayed = null;
  const names = [
    "browser.launch", "browser.currentState", "filesystem.write", "filesystem.read",
    "application.launch", "window.wait", "ui.find", "ui.action", "ui.verifyValue"
  ];
  const goal = `Open data:text/html,<title>${value}</title> in a browser, save the page title to "${filePath}", ` +
    'then enter it into the "Transfer Field" control in Generic Utility.';
  const controller = new InteractiveAgentController({
    reasoningEngine: { decideInteractiveAction: async () => ({ ok: false, error: "model-must-not-be-needed" }) },
    capabilityRegistry: registry(names),
    perceive: async () => ({ relevantControls: [target] }),
    executeAction: async (action) => {
      let output = {};
      if (action.capability === "browser.launch") output = { launched: true, url: action.inputs.url };
      if (action.capability === "browser.currentState") output = { title: value, url: "data:text/html" };
      if (action.capability === "filesystem.write") {
        stored = action.inputs.content;
        output = { filePath: action.inputs.filePath, content: stored };
      }
      if (action.capability === "filesystem.read") output = { filePath: action.inputs.filePath, contents: stored };
      if (action.capability === "application.launch") output = { launched: true, windowIdentity: { windowId: "window:generic" } };
      if (action.capability === "window.wait") output = { found: true, windowId: "window:generic" };
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
  const result = await controller.run(goal, {
    goalContract: createGoalContract({ rawText: goal, successCriteria: [goal] }),
    successCriteria: [goal]
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(stored, value);
  assert.equal(displayed, value);
  assert.equal(result.observability.browserActions > 0, true);
  assert.equal(result.observability.internalActions > 0, true);
  assert.equal(result.observability.uiaActions > 0, true);
  assert.equal(result.transitionContracts[0].exactTransferVerified, true);
});

test("M4.4.1 gate 5: compound completion requires independent evidence for both criteria", async () => {
  const goal = 'Record the "first-independent" result and record the "second-independent" result.';
  const contract = createGoalContract({
    rawText: goal,
    successCriteria: ['"first-independent" result recorded', '"second-independent" result recorded']
  });
  let calls = 0;
  const controller = new InteractiveAgentController({
    reasoningEngine: {
      async decideInteractiveAction() {
        calls += 1;
        return {
          ok: true,
          data: {
            kind: "ACT",
            action: {
              capability: "internal.recordOne",
              inputs: {},
              criterionIds: [contract.criteria[0].criterionId],
              subgoal: "Record first independent result"
            },
            localSteps: [{
              capability: "internal.recordTwo",
              inputs: {},
              criterionIds: [contract.criteria[1].criterionId],
              subgoal: "Record second independent result"
            }]
          }
        };
      }
    },
    capabilityRegistry: registry(["internal.recordOne", "internal.recordTwo"]),
    perceive: async () => ({}),
    executeAction: async (action) => ({
      executionResult: { recorded: action.capability },
      observation: { recorded: action.capability },
      verification: { status: "VERIFIED", message: `${action.capability} verified`, evidence: { recorded: action.capability } }
    })
  });
  const result = await controller.run(goal, { goalContract: contract, successCriteria: contract.criteria.map((item) => item.description) });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.metrics.localActions, 2);
  assert.equal(calls, 1);
  assert.equal(result.completionVerification.ledger.satisfiedCount, 2);
});
