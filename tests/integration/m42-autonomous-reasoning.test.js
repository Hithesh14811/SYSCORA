import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { CapabilityRegistry, LifecycleStatus } from "../../packages/capability-registry/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { ContextEngine } from "../../packages/context-engine/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { LanguageModelProvider } from "../../packages/model-providers/src/index.js";
import { assessPlanGoalCoverage, buildTask } from "../../packages/planner/src/index.js";
import { GoalVerifier, GoalStatus } from "../../packages/agent-runtime/src/goal-verifier.js";

class StrategicFixtureProvider extends LanguageModelProvider {
  constructor() {
    super();
    this.name = "strategic-fixture";
    this.interactiveCalls = 0;
  }

  async healthCheck() {
    return { ok: true, type: "StrategicFixtureProvider" };
  }

  async generateStructured(prompt) {
    if (prompt.includes("Parse this Windows computer task request")) {
      return {
        normalizedGoal: "Advance the application state three times",
        category: "APPLICATION",
        entities: {},
        successCriteria: ["Application state equals 3"],
        requiredContext: [],
        requiredCapabilities: ["state.advance"],
        confidence: 1,
        ambiguity: false
      };
    }
    if (prompt.includes("Generate a task plan")) {
      return {
        goal: "Advance the application state three times",
        summary: "Candidate state plan",
        finalSuccessCriteria: ["Application state equals 3"],
        taskGraph: {
          graphId: "candidate-graph",
          tasks: [{
            ...buildTask("state.advance", {}, {
              goal: "Advance application state",
              description: "Advance the application state",
              retryBudget: 0
            }),
            taskId: "candidate-task"
          }]
        }
      };
    }
    if (prompt.includes("selecting the next safe action")) {
      this.interactiveCalls += 1;
      if (this.interactiveCalls === 1) {
        const action = {
          capability: "state.advance",
          inputs: { ordinal: 1 },
          subgoal: "Advance application state",
          expectedEffect: "State increases by one"
        };
        return {
          goalStatus: "IN_PROGRESS",
          subgoal: "Advance application state to 3",
          action,
          localSteps: [
            { ...action, inputs: { ordinal: 2 } },
            { ...action, inputs: { ordinal: 3 } }
          ]
        };
      }
      return {
        goalStatus: "COMPLETE",
        result: { summary: "Application state is 3", value: 3 },
        verification: {
          allCriteriaSatisfied: true,
          satisfiedCriteria: [{
            criterion: "Application state equals 3",
            evidence: "Three state.advance actions were runtime-verified"
          }]
        }
      };
    }
    return { summary: "fixture" };
  }
}

function stateCapability(state) {
  return {
    name: "state.advance",
    version: "1.0.0",
    description: "Advance an application state counter",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: "LOW" },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({ value: ++state.value }),
    observe: async (result, context) => ({
      observationId: `obs-${state.value}`,
      source: "state.advance",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: ["application.state"],
      affectedEntities: [],
      relatedActionId: context?.taskId,
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => ({
      status: "VERIFIED",
      message: `state is ${observation.structuredState.value}`,
      evidence: { value: observation.structuredState.value },
      independentFromActionResult: true,
      confidence: 1
    }),
    timeout: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  };
}

test("production free text routes into the adaptive controller and batches local mechanics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m42-"));
  try {
    const state = { value: 0 };
    const provider = new StrategicFixtureProvider();
    const registry = new CapabilityRegistry([stateCapability(state)]);
    const reasoningEngine = new ReasoningEngine({ modelProvider: provider, capabilityRegistry: registry });
    const runtime = new AgentRuntime({
      sessionStore: new SessionStore(path.join(root, "sessions")),
      auditRepository: new AuditRepository(path.join(root, "audit")),
      capabilityRegistry: registry,
      riskEngine: new RiskEngine({ capabilityRegistry: registry }),
      policyEngine: new PolicyEngine(),
      permissionBroker: new PermissionBroker(),
      recoveryEngine: new RecoveryEngine(),
      troubleshootingEngine: new TroubleshootingEngine(),
      adapter: { listWindows: async () => [] },
      modelProvider: provider,
      reasoningEngine,
      intentEngine: new IntentEngine(reasoningEngine),
      contextEngine: new ContextEngine([])
    });

    const session = await runtime.submitIntent(
      "Advance the application state three times and verify the final value.",
      { autoApprove: true }
    );

    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(
      session.finalResponse.interactive,
      true,
      JSON.stringify({
        intent: session.intent,
        controller: session.interactiveController,
        final: session.finalResponse,
        events: session.events.map((event) => event.eventType)
      })
    );
    assert.equal(state.value, 3);
    assert.equal(session.interactiveController.steps, 3);
    assert.equal(provider.interactiveCalls, 1, "independent local evidence must avoid a redundant completion model call");
    assert.ok(session.events.some((event) => event.eventType === "ADAPTIVE_CONTROLLER_STARTED"));
    assert.ok(session.events.some((event) => event.eventType === "INTERACTIVE_GOAL_VERIFIED"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("novel cross-modal goal rejects an unrelated deterministic system plan", () => {
  const intent = {
    rawText:
      "Using a structured browser, read the current download version, then put only that number into Calculator and leave it visible."
  };
  const graph = {
    tasks: [
      buildTask("system.inspect", {}, { description: "Inspect Windows system state" }),
      buildTask("git.repository.inspect", {}, { description: "Inspect a Git repository" })
    ]
  };
  const coverage = assessPlanGoalCoverage(intent, graph);
  assert.equal(coverage.covered, false);
  assert.ok(coverage.missingTerms.includes("browser"));
  assert.ok(coverage.missingTerms.includes("calculator"));
});

test("goal verifier refuses false completion when task evidence misses the original goal", () => {
  const verifier = new GoalVerifier();
  const result = verifier.verify({
    intent: {
      rawText: "Read a browser value and leave it visible in Calculator.",
      successCriteria: ["The browser value is visible in Calculator"]
    },
    taskGraph: {
      tasks: [buildTask("system.inspect", {}, { description: "Inspect Windows system state" })]
    },
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED", message: "System inspected" }]
  });
  assert.equal(result.status, GoalStatus.INCONCLUSIVE);
  assert.match(result.message, /does not establish the original goal/i);
});

test("provider outage plus a novel goal fails truthfully without executing an irrelevant fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m42-outage-"));
  try {
    let executions = 0;
    const names = [
      "system.inspect",
      "git.repository.inspect",
      "docker.environment.inspect",
      "package.manager.inspect"
    ];
    const registry = new CapabilityRegistry(names.map((name) => ({
      ...stateCapability({ value: 0 }),
      name,
      description: `Inspect ${name}`,
      execute: async () => {
        executions += 1;
        return { ok: true };
      }
    })));
    const provider = {
      name: "unavailable-fixture",
      async healthCheck() {
        return { ok: false, error: "provider unavailable" };
      },
      async generateStructured() {
        throw new Error("must not be called while unhealthy");
      }
    };
    const reasoningEngine = new ReasoningEngine({ modelProvider: provider, capabilityRegistry: registry });
    const runtime = new AgentRuntime({
      sessionStore: new SessionStore(path.join(root, "sessions")),
      auditRepository: new AuditRepository(path.join(root, "audit")),
      capabilityRegistry: registry,
      riskEngine: new RiskEngine({ capabilityRegistry: registry }),
      policyEngine: new PolicyEngine(),
      permissionBroker: new PermissionBroker(),
      recoveryEngine: new RecoveryEngine(),
      troubleshootingEngine: new TroubleshootingEngine(),
      adapter: { listWindows: async () => [] },
      modelProvider: provider,
      reasoningEngine,
      intentEngine: new IntentEngine(reasoningEngine),
      contextEngine: new ContextEngine([])
    });

    const session = await runtime.submitIntent(
      "Using a structured browser, read the current Python download version from python.org, then put only that version number into Calculator and leave it visible.",
      { autoApprove: true }
    );

    assert.equal(session.finalResponse.status, "FAILED");
    assert.equal(session.finalResponse.reason, "invalid-composition-graph");
    assert.equal(executions, 0);
    assert.equal(session.taskResults.length, 0);
    assert.ok(session.events.some((event) =>
      ["INTERACTIVE_REASONING_FAILED", "IRRELEVANT_DETERMINISTIC_FALLBACK_REJECTED"].includes(event.eventType)
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
