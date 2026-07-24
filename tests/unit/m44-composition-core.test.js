import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import {
  InteractiveAgentController,
  buildBrowserCompositionStrategy,
  buildCrossModalTransferStrategy,
  buildGuiToInternalStrategy,
  evaluateSubgoalCompletion
} from "../../packages/agent-runtime/src/interactive-agent-controller.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import {
  createCompositionGraph,
  validateCompositionGraph
} from "../../packages/shared-types/src/composition-graph.js";
import {
  createResultEnvelope,
  extractResultValue
} from "../../packages/shared-types/src/result-envelope.js";
import { evaluateTransitionContracts } from "../../packages/shared-types/src/transition-contract.js";
import { normalizeInteractiveDecision } from "../../packages/shared-types/src/interactive-decision.js";
import { assessGoalContractEvidence, createGoalContract } from "../../packages/shared-types/src/goal-contract.js";

function capability(name) {
  return {
    name,
    version: "1.0.0",
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: "LOW" },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async () => ({}),
    verify: async () => ({ status: "VERIFIED" }),
    timeout: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: "VERIFIED"
  };
}

test("canonical result envelope extracts browser, filesystem, and nested GUI values", () => {
  const browser = createResultEnvelope({
    capability: "browser.currentState",
    executionResult: { title: "M44 Orchid 482", url: "data:text/html,x" },
    verification: { status: "VERIFIED", confidence: 1 },
    step: 2
  });
  assert.equal(extractResultValue(browser, "output.title"), "M44 Orchid 482");

  const file = createResultEnvelope({
    capability: "filesystem.read",
    executionResult: { filePath: "x.txt", contents: "exact" },
    verification: { status: "VERIFIED" }
  });
  assert.equal(extractResultValue(file, "output.value"), "exact");

  const gui = createResultEnvelope({
    capability: "ui.find",
    executionResult: { target: { source: "UIA", name: "User Data Sources:" } },
    verification: { status: "VERIFIED" }
  });
  assert.equal(extractResultValue(gui, "output.name"), "User Data Sources:");
});

test("composition graph rejects consumers whose typed binding has no prior producer", () => {
  const graph = createCompositionGraph([
    { capability: "browser.currentState", inputs: {} },
    { capability: "filesystem.write", inputs: { content: "$binding.pageTitle" } }
  ]);
  const validation = validateCompositionGraph(graph);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /requires binding pageTitle before it is produced/);
});

test("composition graph records dependencies and accepts a valid producer-consumer chain", () => {
  const graph = createCompositionGraph([
    {
      capability: "browser.currentState",
      inputs: {},
      bindOutput: { name: "pageTitle", path: "output.title" }
    },
    { capability: "filesystem.write", inputs: { content: "$binding.pageTitle" } }
  ]);
  const validation = validateCompositionGraph(graph, {
    capabilityExists: (name) => ["browser.currentState", "filesystem.write"].includes(name)
  });
  assert.equal(validation.valid, true);
  assert.deepEqual(graph.nodes[1].dependsOn, [graph.nodes[0].nodeId]);
});

test("interactive GUI binding uses canonical extraction and retains provenance", async () => {
  const registry = new CapabilityRegistry([
    capability("ui.find"),
    capability("state.consume")
  ]);
  const events = [];
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: {
      async decideInteractiveAction() {
        return {
          ok: true,
          data: {
            goalStatus: "IN_PROGRESS",
            action: {
              capability: "ui.find",
              inputs: {},
              bindOutput: { name: "label", path: "output.name", normalize: "trim" }
            },
            localSteps: [{
              capability: "state.consume",
              inputs: {},
              completesGoal: true,
              completionResult: { summary: "done" }
            }]
          }
        };
      }
    },
    perceive: async () => ({}),
    executeAction: async (action) => ({
      executionResult: action.capability === "ui.find"
        ? { target: { source: "UIA", name: "User Data Sources:" } }
        : {},
      verification: { status: "VERIFIED", confidence: 1, message: "verified" }
    }),
    onEvent: async (event) => events.push(event),
    budgets: { maxSteps: 3, maxModelCalls: 1 }
  });
  const result = await controller.run("copy the observed label", {
    successCriteria: ["label is copied"]
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.bindings.label.value, "User Data Sources:");
  assert.equal(result.bindings.label.provenance.source, "UIA");
  assert.ok(events.some((event) => event.type === "ADAPTIVE_BINDING_CREATED"));
});

test("generic browser composition accepts persistence synonyms and does not treat output files as domains", () => {
  const strategy = buildBrowserCompositionStrategy(
    "Open data:text/html,<title>Fresh Meadow 731</title> in a browser, then save its title to \"C:\\tmp\\fresh-result.txt\"."
  );
  assert.equal(strategy.domain, "local-browser-document");
  assert.equal(strategy.localSteps[1].capability, "filesystem.write");
  assert.equal(strategy.localSteps[1].inputs.filePath, "C:\\tmp\\fresh-result.txt");

  assert.equal(
    buildCrossModalTransferStrategy("Save the browser title to \"C:\\tmp\\not-a-domain.txt\"."),
    null
  );
});

test("generic GUI to internal composition preserves a typed producer-consumer chain", () => {
  const strategy = buildGuiToInternalStrategy(
    "Open Generic Utility, obtain the current status label, save that exact label to \"%TEMP%\\generic-status.txt\", and verify it."
  );
  assert.equal(strategy.action.capability, "application.launch");
  assert.deepEqual(
    strategy.localSteps.map((step) => step.capability),
    ["ui.extract", "filesystem.write", "filesystem.read"]
  );
  assert.equal(strategy.localSteps[0].bindOutput.expectedType, "string");
  assert.equal(strategy.localSteps[0].inputs.windowId, "$last.output.windowIdentity.windowId");
  assert.equal(strategy.localSteps[1].inputs.content, "$binding.guiValue");
});

test("generic GUI extraction ranks accessible labels and fails closed on ambiguity", async () => {
  let controls = [
    { name: "Primary Status:", className: "Static", controlType: "ControlType.Text" },
    { name: "Apply", className: "Button", controlType: "ControlType.Button" }
  ];
  const adapter = {
    inspectUi: async () => ({ targets: controls, windows: [{ title: "Generic Utility" }] })
  };
  const registry = createDefaultCapabilityRegistry(adapter);
  const extracted = await registry.get("ui.extract").execute({
    application: "Generic Utility",
    query: "the main visible status label"
  });
  assert.equal(extracted.found, true);
  assert.equal(extracted.value, "Primary Status:");
  assert.equal(extracted.valueSource, "AccessibleName");

  controls = [
    { name: "Left Caption", className: "Static", controlType: "ControlType.Text" },
    { name: "Right Caption", className: "Static", controlType: "ControlType.Text" }
  ];
  const ambiguous = await registry.get("ui.extract").execute({
    application: "Generic Utility",
    query: "visible label"
  });
  assert.equal(ambiguous.found, false);
  assert.equal(ambiguous.reason, "ambiguous-value");
});

test("filesystem primitives expand Windows environment path tokens without a shell", async () => {
  const adapter = new WindowsAdapter({ automationHost: false });
  const filePath = `%TEMP%\\syscora-m44-${Date.now()}.txt`;
  const written = await adapter.writeTextFile(filePath, "expanded");
  assert.equal(written.filePath.includes("%TEMP%"), false);
  assert.equal((await adapter.readTextFile(filePath)).contents, "expanded");
  await adapter.removeTextFile(filePath);
});

test("transition contract proves exact typed transfer with provenance and an independent read", () => {
  const actions = [
    {
      succeeded: true,
      action: { capability: "browser.currentState", inputs: {}, subgoal: "Extract the page title" },
      executionResult: { title: "Fresh Meadow 731", url: "data:text/html,<title>x</title>" },
      resultEnvelope: { provenance: { step: 1 }, data: { url: "data:text/html,<title>x</title>" } }
    },
    {
      succeeded: true,
      action: { capability: "filesystem.write", inputs: { content: "Fresh Meadow 731" } },
      executionResult: { nextContents: "Fresh Meadow 731" },
      resultEnvelope: { provenance: { step: 2 } }
    },
    {
      succeeded: true,
      action: { capability: "filesystem.read", inputs: {} },
      executionResult: { contents: "Fresh Meadow 731" },
      resultEnvelope: { provenance: { step: 3 } }
    }
  ];
  const contracts = evaluateTransitionContracts(actions, {
    title: {
      value: "Fresh Meadow 731",
      type: "string",
      sourceCapability: "browser.currentState",
      sourceStep: 1,
      provenance: { capability: "browser.currentState", source: "DOM" }
    }
  });
  assert.equal(contracts[0].provenanceValid, true);
  assert.equal(contracts[0].exactTransferVerified, true);
  assert.match(contracts[0].summary, /page title value from HTML data URI/);
});

test("generic section navigation cycles boundedly until accessible evidence matches", async () => {
  let view = 0;
  const views = [
    [{ name: "User Data Sources:", automationId: "user", source: "UIA" }],
    [{ name: "File Data Sources:", automationId: "file", source: "UIA" }],
    [
      { name: "System Data Sources:", automationId: "system", source: "UIA" },
      { name: "Add...", automationId: "add", source: "UIA" }
    ]
  ];
  const adapter = {
    inspectUi: async () => ({ targets: views[view] }),
    keyboardAction: async () => { view = Math.min(view + 1, views.length - 1); return { performed: true }; }
  };
  const registry = createDefaultCapabilityRegistry(adapter);
  const result = await registry.get("ui.navigateSection").execute({
    application: "Generic Utility",
    query: "System DSN",
    maxTransitions: 4
  });
  assert.equal(result.performed, true);
  assert.equal(result.transitions, 2);
  assert.equal(result.matched.name, "System Data Sources:");
  assert.ok(result.controls.some((control) => control.name === "Add..."));
});

test("visible control cannot falsely complete a compound section-navigation goal", () => {
  const result = evaluateSubgoalCompletion(
    "Select the System section and verify that the Add control is visible.",
    [{ relevantControls: [{ name: "Add", controlType: "ControlType.Button" }] }],
    [{ succeeded: true, action: { capability: "ui.find", inputs: { selector: { name: "Add" } } } }],
    {}
  );
  assert.notEqual(result.status, "COMPLETE");
});

test("provider shorthand UI actions normalize to the canonical grounded capability", () => {
  const normalized = normalizeInteractiveDecision({
    kind: "ACT",
    action: { capability: "ui.click", inputs: { target: { targetId: "observed" } } }
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.data.action.capability, "ui.action");
  assert.equal(normalized.data.action.inputs.action, "click");
});

test("scoped GUI prohibition permits navigation but still rejects the forbidden control action", () => {
  const contract = {
    criteria: [{
      criterionId: "safe",
      description: "Do not add, remove, or configure any data source",
      kind: "PROHIBITION",
      anchors: [],
      tokens: ["add", "remove", "configure", "data", "source"]
    }]
  };
  const safe = assessGoalContractEvidence(contract, {
    taskGraph: { tasks: [{ capability: "ui.navigateSection", inputs: { query: "System DSN" } }] },
    observations: [{ detectedChanges: ["application.navigation"] }]
  });
  assert.equal(safe.satisfied, true);

  const unsafe = assessGoalContractEvidence(contract, {
    taskGraph: {
      tasks: [{
        capability: "ui.action",
        inputs: { action: "click", target: { name: "Add..." } }
      }]
    },
    observations: [{ detectedChanges: ["application.ui"] }]
  });
  assert.equal(unsafe.satisfied, false);

  const scopedAlter = {
    criteria: [{
      criterionId: "safe-close",
      description: "Do not alter any data source",
      kind: "PROHIBITION",
      anchors: [],
      tokens: ["alter", "any", "data", "source"]
    }]
  };
  const cancel = assessGoalContractEvidence(scopedAlter, {
    taskGraph: {
      tasks: [{
        capability: "ui.action",
        inputs: { action: "invoke", target: { name: "Cancel" } }
      }]
    },
    observations: [{ detectedChanges: ["application.ui"] }]
  });
  assert.equal(cancel.satisfied, true);
});

test("goal evidence treats absolute and USERPROFILE paths as the same canonical target", () => {
  const contract = createGoalContract({
    rawText: "Save the label to \"%USERPROFILE%\\AppData\\Local\\Temp\\m44\\value.txt\""
  });
  const result = assessGoalContractEvidence(contract, {
    taskGraph: {
      tasks: [{
        capability: "filesystem.write",
        inputs: {
          filePath: "C:\\Users\\example\\AppData\\Local\\Temp\\m44\\value.txt",
          content: "Ready:"
        },
        subgoal: "Save the label"
      }]
    },
    observations: [{
      source: "filesystem.read",
      structuredState: {
        filePath: "C:\\Users\\example\\AppData\\Local\\Temp\\m44\\value.txt",
        contents: "Ready:"
      }
    }]
  });
  assert.equal(result.satisfied, true);
});

test("goal contracts discard vacuous provider criteria and retain original grounded clauses", () => {
  const contract = createGoalContract({
    rawText: "Read the visible status and save it to \"C:\\tmp\\status.txt\".",
    successCriteria: ["Request is processed successfully"]
  });
  assert.equal(contract.criteria.some((criterion) => /request is processed successfully/i.test(criterion.description)), false);
  assert.equal(contract.criteria.some((criterion) => criterion.anchors.includes("c:/tmp/status.txt")), true);
});
