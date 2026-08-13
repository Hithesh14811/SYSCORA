import test from "node:test";
import assert from "node:assert/strict";
import {
  InteractiveAgentController,
  InteractiveConvergenceState,
  sanitizeInteractiveState,
  classifyInteractiveContext,
  compactObservationForModel,
  evaluateSubgoalCompletion,
  chooseMechanicalContinuation,
  enumerateGroundedActionCandidates,
  supportedUiActions,
  measureUiProgress,
  buildSupportedUiOperationStrategy,
  buildSupportedTextEntryStrategy,
  buildSupportedReadOnlyNavigationStrategy,
  buildSupportedBrowserReadStrategy,
  buildSupportedRankedProcessReadStrategy,
  buildCrossModalTransferStrategy,
  buildInternalToGuiTransferStrategy,
  buildExplicitApplicationLaunchStrategy
} from "../../packages/agent-runtime/src/interactive-agent-controller.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";

function capability(name, inputSchema = { type: "object", properties: {}, required: [] }) {
  return {
    name,
    version: "1.0.0",
    description: name,
    inputSchema,
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

test("local postcondition evidence recognizes a newly visible generic control after a UI action", () => {
  const completion = evaluateSubgoalCompletion(
    "Open an application, click Advanced view, and verify that the Character set control appears.",
    [{ relevantControls: [{ name: "Character set :", automationId: "129", controlType: "ControlType.Pane" }] }],
    [{ succeeded: true, action: { capability: "ui.action" } }],
    {}
  );

  assert.equal(completion.status, "COMPLETE");
  assert.match(completion.evidence, /Character set/);
});

test("interactive controller performs bounded perceive-decide-act-observe-verify adaptation", async () => {
  const registry = new CapabilityRegistry();
  registry.register(capability("state.read"));
  registry.register(capability("state.advance"));
  let world = 0;
  let modelCalls = 0;
  const events = [];
  const reasoningEngine = {
    async decideInteractiveAction() {
      modelCalls += 1;
      if (world >= 2) return {
        ok: true,
        data: {
          goalStatus: "COMPLETE",
          result: { value: world },
          verification: {
            allCriteriaSatisfied: true,
            satisfiedCriteria: [{ criterion: "advance twice", evidence: "world is 2" }]
          }
        }
      };
      return {
        ok: true,
        data: {
          goalStatus: "IN_PROGRESS",
          subgoal: `advance-${world + 1}`,
          action: { capability: "state.advance", inputs: {} },
          expectedEffect: "world advances"
        }
      };
    }
  };
  const controller = new InteractiveAgentController({
    reasoningEngine,
    capabilityRegistry: registry,
    perceive: async () => ({ world }),
    executeAction: async () => {
      world += 1;
      return {
        executionResult: { world },
        observation: { world },
        verification: { status: "VERIFIED", confidence: 1 }
      };
    },
    onEvent: async (event) => events.push(event),
    budgets: { maxSteps: 6, maxModelCalls: 4 }
  });
  const result = await controller.run("advance twice", { successCriteria: ["advance twice"] });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.result.value, 2);
  assert.equal(result.steps, 2);
  assert.equal(modelCalls, 3);
  assert.ok(events.some((event) => event.type === "ADAPTIVE_PERCEIVED"));
  assert.ok(events.some((event) => event.type === "ADAPTIVE_ACTION_VERIFIED"));
});

test("interactive controller detects repeated action/state loops", async () => {
  const registry = new CapabilityRegistry([capability("state.noop")]);
  const reasoningEngine = {
    async decideInteractiveAction() {
      return { ok: true, data: { goalStatus: "IN_PROGRESS", action: { capability: "state.noop", inputs: {} } } };
    }
  };
  const controller = new InteractiveAgentController({
    reasoningEngine,
    capabilityRegistry: registry,
    perceive: async () => ({ unchanged: true }),
    executeAction: async () => ({
      executionResult: {},
      observation: { unchanged: true },
      verification: { status: "VERIFIED" }
    }),
    budgets: { maxSteps: 10, maxModelCalls: 10, maxRepeatedActions: 2 }
  });
  const result = await controller.run("impossible change");
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "repeated-action-loop");
  assert.equal(result.steps, 2);
});

test("interactive context sanitization removes secrets but keeps paths usable", () => {
  const safe = sanitizeInteractiveState({
    token: "secret-token",
    path: "C:\\Users\\Alice\\Documents\\private.txt",
    nested: { password: "hunter2" }
  });
  assert.equal(safe.token, "***REDACTED***");
  assert.equal(safe.nested.password, "***REDACTED***");
  // This used to become "%USERPROFILE%\Documents\private.txt". PowerShell does
  // not expand %VAR%, so the agent — reasonably typing back the only path it had
  // been given — resolved it against the working directory and could not open,
  // read or edit anything under the home folder. The username is already in
  // every window title it receives; hiding it here bought nothing.
  assert.equal(safe.path, "C:\\Users\\Alice\\Documents\\private.txt");
  const classified = classifyInteractiveContext({ clipboardText: "private", MainWindowTitle: "secret.txt - Notepad" });
  assert.equal(classified.safeForExternalReasoning, true);
  assert.equal(classified.data.clipboardText, "***REDACTED***");
  assert.match(classified.data.MainWindowTitle, /PRIVATE_WINDOW_TITLE/);
});

test("interactive model observations are bounded while retaining local verification data", () => {
  const largeObservation = {
    message: "Spotify launched",
    elements: Array.from({ length: 40 }, (_, index) => ({
      targetId: `target-${index}`,
      name: "x".repeat(1_200)
    })),
    verification: { status: "VERIFIED" }
  };
  const compact = compactObservationForModel(largeObservation);
  assert.ok(Buffer.byteLength(JSON.stringify(compact), "utf8") <= 4_000);
  assert.equal(compact.message, "Spotify launched");
  assert.equal(compact.truncated, true);
});

test("local terminal evidence answers a read-only state goal without another model call", async () => {
  const registry = new CapabilityRegistry([capability("application.launch")]);
  let launched = false;
  let modelCalls = 0;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: { async decideInteractiveAction() {
      modelCalls += 1;
      return { ok: true, data: { goalStatus: "IN_PROGRESS", action: { capability: "application.launch", inputs: {} } } };
    } },
    perceive: async () => launched ? ({ relevantControls: [{ name: "Bluetooth", automationId: "BluetoothToggle", toggleState: "Off" }] }) : ({}),
    executeAction: async () => {
      launched = true;
      return { executionResult: { started: true }, observation: { started: true }, verification: { status: "VERIFIED", message: "Settings opened" } };
    }
  });
  const result = await controller.run("Tell me whether Bluetooth is enabled", { successCriteria: ["Bluetooth state is reported"] });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.completionVerification.locallyEvaluated, true);
  assert.equal(modelCalls, 1);
});

test("negative mutation constraints preserve local read-only completion", () => {
  const result = evaluateSubgoalCompletion(
    "Open Settings and tell me whether Bluetooth is on or off. Do not change it.",
    [{ relevantControls: [{ name: "Bluetooth is turned off", controlType: "ControlType.Text" }] }]
  );
  assert.equal(result.status, "COMPLETE");
  assert.match(result.evidence, /Bluetooth is turned off/i);
});

test("typed bindings carry one result through local steps without per-step reasoning", async () => {
  const registry = new CapabilityRegistry([
    capability("data.read"), capability("application.launch"), capability("data.verify")
  ]);
  let modelCalls = 0;
  let received = null;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: { async decideInteractiveAction() {
      modelCalls += 1;
      return { ok: true, data: {
        goalStatus: "IN_PROGRESS",
        action: { capability: "data.read", inputs: {}, bindOutput: { name: "version", path: "output.text", normalize: "version" } },
        localSteps: [
          { capability: "application.launch", inputs: {} },
          { capability: "data.verify", inputs: { value: "$binding.version" }, completesGoal: true, completionResult: { summary: "version transferred" } }
        ]
      } };
    } },
    perceive: async () => ({}),
    executeAction: async (action) => {
      if (action.capability === "data.read") return { executionResult: { text: "Python 3.14.6" }, observation: {}, verification: { status: "VERIFIED" } };
      if (action.capability === "data.verify") received = action.inputs.value;
      return { executionResult: { performed: true }, observation: {}, verification: { status: "VERIFIED", message: "value visible" } };
    }
  });
  const result = await controller.run("transfer a discovered version", { successCriteria: ["version is visible"] });
  assert.equal(result.status, "COMPLETE");
  assert.equal(received, "3.14.6");
  assert.equal(result.bindings.version.sourceCapability, "data.read");
  assert.equal(result.steps, 3);
  assert.equal(modelCalls, 1);
});

test("a uniquely matching grounded navigation control is selected mechanically", () => {
  const target = {
    targetId: "bluetooth-nav",
    source: "UIA",
    windowId: "42",
    name: "Bluetooth & devices",
    supportedPatterns: ["SelectionItemPatternIdentifiers.Pattern"]
  };
  const action = chooseMechanicalContinuation(
    "Determine whether Bluetooth is enabled",
    { relevantControls: [target, { ...target, targetId: "other", name: "Network", supportedPatterns: [] }] }
  );
  assert.equal(action.capability, "ui.action");
  assert.equal(action.inputs.target.targetId, "bluetooth-nav");
  assert.equal(action.inputs.action, "select");
});

test("UI action vocabulary is derived only from advertised UIA patterns", () => {
  const display = {
    targetId: "volatile-1",
    source: "UIA",
    windowId: "42",
    name: "Display is 0",
    controlType: "ControlType.Text",
    supportedPatterns: ["InvokePatternIdentifiers.Pattern", "ScrollItemPatternIdentifiers.Pattern"]
  };
  const edit = {
    targetId: "edit-1",
    source: "UIA",
    windowId: "42",
    name: "Address and search bar",
    controlType: "ControlType.Edit",
    supportedPatterns: ["ValuePatternIdentifiers.Pattern", "ExpandCollapsePatternIdentifiers.Pattern"]
  };
  assert.deepEqual(supportedUiActions(display), ["scrollIntoView"]);
  assert.deepEqual(supportedUiActions(edit), ["setValue", "type", "expand"]);
});

test("exhausted target/action pairs survive volatile target id refreshes", () => {
  const control = {
    targetId: "first-id",
    source: "UIA",
    windowId: "42",
    automationId: "Display",
    name: "Display",
    controlType: "ControlType.Button",
    supportedPatterns: ["InvokePatternIdentifiers.Pattern"]
  };
  const first = enumerateGroundedActionCandidates("click Display", { relevantControls: [control] });
  assert.equal(first.length, 1);
  const exhausted = new Set([first[0].convergencePairKey]);
  const refreshed = enumerateGroundedActionCandidates(
    "click Display",
    { relevantControls: [{ ...control, targetId: "second-id" }] },
    exhausted
  );
  assert.equal(refreshed.length, 0);
});

test("progress requires the predicted observable postcondition", () => {
  const expected = {
    kind: "VALUE_EQUALS",
    expected: "example.com",
    before: { key: "42|address|ControlType.Edit|address and search bar", value: "" }
  };
  const unchanged = measureUiProgress(expected, {
    relevantControls: [{
      targetId: "new-id",
      source: "UIA",
      windowId: "42",
      automationId: "address",
      name: "Address and search bar",
      controlType: "ControlType.Edit",
      value: "",
      supportedPatterns: ["ValuePatternIdentifiers.Pattern"]
    }]
  });
  assert.equal(unchanged.state, InteractiveConvergenceState.NO_PROGRESS);
  const changed = measureUiProgress(expected, {
    relevantControls: [{
      targetId: "newer-id",
      source: "UIA",
      windowId: "42",
      automationId: "address",
      name: "Address and search bar",
      controlType: "ControlType.Edit",
      value: "example.com",
      supportedPatterns: ["ValuePatternIdentifiers.Pattern"]
    }]
  });
  assert.equal(changed.state, InteractiveConvergenceState.PROGRESS);
});

test("model target references are rehydrated before action canonicalization", async () => {
  const registry = new CapabilityRegistry([capability("ui.action", {
    type: "object",
    properties: {
      target: { type: "object" },
      action: { type: "string", enum: ["invoke", "click"] }
    },
    required: ["target", "action"]
  })]);
  const target = {
    targetId: "observed-button",
    source: "UIA",
    windowId: "42",
    automationId: "submit",
    name: "Submit",
    controlType: "ControlType.Button",
    supportedPatterns: ["InvokePatternIdentifiers.Pattern"]
  };
  const otherTarget = {
    ...target,
    targetId: "observed-other-button",
    automationId: "other",
    name: "Other"
  };
  let clicked = false;
  let executedAction = null;
  let calls = 0;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: { async decideInteractiveAction() {
      calls += 1;
      if (calls > 1) return {
        ok: true,
        data: {
          goalStatus: "COMPLETE",
          result: { summary: "Submitted" },
          verification: {
            allCriteriaSatisfied: true,
            satisfiedCriteria: [{ criterion: "click submit", evidence: "Submit changed the observed UI." }]
          }
        }
      };
      return {
        ok: true,
        data: {
          goalStatus: "IN_PROGRESS",
          action: {
            capability: "ui.action",
            inputs: { target: { targetId: target.targetId, source: "UIA", windowId: "42" }, action: "click" }
          }
        }
      };
    } },
    perceive: async () => ({
      relevantControls: [target, otherTarget],
      statusText: clicked ? "Submitted" : "Ready"
    }),
    executeAction: async (action) => {
      executedAction = action;
      clicked = true;
      return { executionResult: { performed: true }, verification: { status: "PARTIALLY_VERIFIED" } };
    },
    budgets: { maxModelCalls: 3, maxSteps: 3 }
  });
  const result = await controller.run("click a button");
  assert.equal(executedAction.inputs.action, "invoke");
  assert.deepEqual(executedAction.inputs.target.supportedPatterns, target.supportedPatterns);
  assert.equal(result.status, "COMPLETE");
});

test("cross-modal value transfers compile into one bound mechanical strategy", () => {
  const strategy = buildCrossModalTransferStrategy(
    "Using a browser, read the current release version from example.org, then put only that version into Calculator and leave it visible."
  );
  assert.equal(strategy.action.capability, "browser.launch");
  assert.equal(strategy.domain, "example.org");
  assert.ok(strategy.localSteps.some((step) => step.capability === "browser.extract" && step.bindOutput?.name === "transferredValue"));
  assert.ok(strategy.localSteps.some((step) => step.capability === "keyboard.type" && step.inputs.text === "$binding.transferredValue"));
  assert.equal(strategy.localSteps.at(-1).completesGoal, true);
});

test("ordered textual keypad operations compile through grounded supported actions", () => {
  const strategy = buildSupportedUiOperationStrategy(
    "Open a numeric keypad, calculate (47 times 19) plus 6, and leave the result visible."
  );
  assert.equal(strategy.expectedResult, "899");
  assert.equal(strategy.action.capability, "application.launch");
  const uiActions = strategy.localSteps.filter((step) => step.capability === "ui.action");
  assert.deepEqual(
    uiActions.map((step) => step.inputs.action),
    Array(uiActions.length).fill("click")
  );
  assert.ok(uiActions.every((step) => step.inputs.target === "$last.output.target"));
  assert.equal(strategy.localSteps.at(-1).inputs.selector.nameContains, "899");
});

test("multiline text entry compiles to ValuePattern action and exact verification", () => {
  const strategy = buildSupportedTextEntryStrategy(
    "Open an editor, type first value on the first line and second value on the second line, then leave it visible without saving."
  );
  assert.equal(strategy.expectedText, "first value\nsecond value");
  assert.equal(strategy.localSteps[1].inputs.action, "setValue");
  assert.equal(strategy.localSteps[1].inputs.target, "$last.output.target");
  assert.equal(strategy.localSteps.at(-1).capability, "ui.verifyValue");
  assert.equal(strategy.localSteps.at(-1).inputs.expected, "first value\nsecond value");
});

test("read-only page navigation compiles to grounded action and typed extraction", () => {
  const strategy = buildSupportedReadOnlyNavigationStrategy(
    "Open system preferences to the Display page, report the current scale percentage, and do not change any setting."
  );
  assert.equal(strategy.page, "Display");
  assert.equal(strategy.localSteps[0].capability, "window.moveResize");
  assert.equal(strategy.localSteps[1].capability, "ui.navigateSection");
  assert.equal(strategy.localSteps[2].capability, "keyboard.press");
  assert.equal(strategy.localSteps[3].capability, "ui.inspect");
  assert.equal(strategy.localSteps[3].bindOutput.normalize, "firstPercentage");
  assert.equal(strategy.localSteps[3].completesGoal, true);
});

test("browser heading reads compile without unsupported address-bar verbs", () => {
  const strategy = buildSupportedBrowserReadStrategy(
    "Open a browser, navigate to example.com, report the page heading, and leave the page open."
  );
  assert.equal(strategy.action.capability, "browser.launch");
  assert.equal(strategy.localSteps.at(-1).inputs.selector, "h1");
  assert.ok(!strategy.localSteps.some((step) => step.capability === "ui.action"));
});

test("highest-memory reads compile without a process mutation", () => {
  const strategy = buildSupportedRankedProcessReadStrategy(
    "Open Task Manager, identify the process currently using the most memory, and report its name and memory usage without ending anything."
  );
  assert.equal(strategy.localSteps[0].capability, "processes.list");
  assert.equal(strategy.localSteps[0].bindOutput.normalize, "maxWorkingSet");
  assert.ok(!strategy.localSteps.some((step) => /stop|end|kill/i.test(step.capability)));
});

test("generic internal-to-GUI composition binds file output and verifies the target value", () => {
  const strategy = buildInternalToGuiTransferStrategy(
    'Read the contents from "C:\\tmp\\value.txt", enter it into the "Characters to copy :" control in Character Map, and verify it.'
  );
  assert.equal(strategy.action.capability, "filesystem.read");
  assert.equal(strategy.localSteps.at(-1).capability, "ui.verifyValue");
  assert.equal(strategy.localSteps.at(-1).inputs.expected, "$binding.transferredValue");
  assert.ok(!strategy.localSteps.some((step) => /calculator|MathRichEditBox|Graphing/i.test(JSON.stringify(step))));
});

test("explicit application opening compiles into a local verified launch", () => {
  const strategy = buildExplicitApplicationLaunchStrategy("Open Windows Settings and tell me the Bluetooth state");
  assert.equal(strategy.action.capability, "application.launch");
  assert.equal(strategy.action.inputs.application, "Settings");
});

test("interactive controller rejects fabricated interaction targets", async () => {
  const registry = new CapabilityRegistry([
    capability("ui.action", {
      type: "object",
      properties: { target: { type: "object" }, action: { type: "string" } },
      required: ["target", "action"]
    })
  ]);
  const controller = new InteractiveAgentController({
    reasoningEngine: {
      async decideInteractiveAction() {
        return {
          ok: true,
          data: {
            goalStatus: "IN_PROGRESS",
            action: {
              capability: "ui.action",
              inputs: {
                target: { targetId: "invented", source: "UIA", windowId: "7", name: "OK" },
                action: "invoke"
              }
            }
          }
        };
      }
    },
    capabilityRegistry: registry,
    perceive: async () => ({ targets: [] }),
    executeAction: async () => assert.fail("fabricated target must not execute"),
    budgets: { maxFailedActions: 1, maxModelCalls: 2 }
  });
  const result = await controller.run("click OK");
  assert.equal(result.status, "FAILED");
  // The property under test is that an invented target NEVER reaches execution
  // (executeAction above fails the test if it does) and that the run terminates
  // on a budget instead of looping.
  //
  // This asserted `max-failed-actions` when a rejected proposal was booked as an
  // executed failure. Proposals the model wrote incorrectly are now counted
  // separately from actions that ran and failed, because re-asking with the
  // specific violation is the loop working as designed and should not spend the
  // budget reserved for genuinely broken steps. A fabricated target is a
  // malformed proposal, so whichever bound is reached first here, the reason is
  // a budget — never an execution.
  assert.match(result.reason, /^max-(model-calls|malformed-proposals|failed-actions|steps)$/);
  assert.ok(
    result.failedAttempts.some((attempt) =>
      /was not present in runtime-observed state/.test(String(attempt.reason ?? ""))
    ),
    "the fabricated target must be rejected for not being runtime-observed"
  );
});
