// Closed-Loop Intelligence integration tests.
//
// These prove the runtime continuously loops PLAN -> EXECUTE -> OBSERVE ->
// VERIFY -> DIAGNOSE -> RECOVER -> REPLAN -> CONTINUE until the goal is verified
// or the recovery budget is exhausted. They use deterministic in-test
// capabilities and a deterministic planner injection (no live model), so the
// closed loop is exercised without any real Windows side effects.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { CapabilityRegistry, LifecycleStatus } from "../../packages/capability-registry/src/index.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { Memory } from "../../packages/memory/src/index.js";
import { SemanticState } from "../../packages/semantic-state/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ContextEngine } from "../../packages/context-engine/src/index.js";
import { MockModelProvider } from "../../packages/model-providers/src/index.js";

let counter = 0;
const uid = (p) => `${p}_${Date.now()}_${counter++}`;

// Build a runtime whose collaborators are real but whose capability registry
// and planner are controlled by the test.
async function buildRuntime({ capabilities = [], planFor }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-cl-"));
  const registry = new CapabilityRegistry();
  for (const cap of capabilities) {
    registry.register({ lifecycleStatus: LifecycleStatus.VERIFIED, ...cap });
  }

  const modelProvider = new MockModelProvider();
  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
    auditRepository: new AuditRepository(path.join(tempRoot, "audit")),
    capabilityRegistry: registry,
    riskEngine: new RiskEngine(),
    policyEngine: new PolicyEngine(),
    permissionBroker: new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter: {},
    modelProvider,
    intentEngine: new IntentEngine(modelProvider),
    contextEngine: new ContextEngine([]),
    semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
    memory: new Memory(path.join(tempRoot, "memory.sqlite"))
  });

  // Deterministic planner injection: return a fresh plan built from the current
  // world (so replans reflect diagnosis). planFor receives (intent, ctx) and
  // returns an array of tasks.
  runtime.generalPlanner = {
    async generatePlan(intent, _ctx, _sem, _mem, previous) {
      const tasks = planFor(intent, { previous });
      return {
        planId: uid("plan"),
        planVersion: 1,
        parentPlanId: null,
        goal: intent.normalizedGoal,
        finalSuccessCriteria: intent.successCriteria ?? ["done"],
        summary: intent.normalizedGoal,
        taskGraph: { graphId: uid("graph"), tasks }
      };
    }
  };

  return { runtime, tempRoot };
}

function task(capability, inputs = {}, overrides = {}) {
  return {
    taskId: overrides.taskId ?? uid("task"),
    goal: overrides.goal ?? capability,
    description: overrides.description ?? capability,
    dependencies: overrides.dependencies ?? [],
    capability,
    inputs,
    expectedStateChanges: overrides.expectedStateChanges ?? [],
    affectedEntities: [],
    riskHints: overrides.riskHints ?? "LOW",
    verificationCriteria: overrides.verificationCriteria ?? [`${capability} verified`],
    completionCriteria: overrides.completionCriteria ?? [`${capability} done`],
    timeout: overrides.timeout ?? 5000,
    retryBudget: overrides.retryBudget ?? 0,
    idempotency: overrides.idempotency ?? true
  };
}

function okObserve(source) {
  return async (result, inputs) => ({
    observationId: uid("obs"),
    source,
    timestamp: new Date().toISOString(),
    structuredState: result,
    detectedChanges: [source],
    affectedEntities: [],
    confidence: 1,
    trustLevel: "SYSTEM_TRUSTED"
  });
}

describe("Closed-Loop Intelligence", () => {
  it("verifies a simple goal end-to-end (plan->execute->observe->verify->goal)", async () => {
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.readonly",
        version: "1.0.0",
        description: "read only",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" },
        reversibility: "NOT_REQUIRED",
        preconditions: () => true,
        execute: async () => ({ ok: true }),
        observe: okObserve("test.readonly"),
        verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => [task("test.readonly")]
    });

    const session = await runtime.submitIntent("do a readonly thing", {
      autoApprove: true,
      operation: "test.readonly",
      category: "SYSTEM",
      normalizedGoal: "Do a readonly thing"
    });

    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(session.currentState, "COMPLETED");
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("PLAN_GENERATED"));
    assert.ok(types.includes("TASK_EXECUTED"));
    assert.ok(types.includes("VERIFICATION_COMPLETED"));
    assert.ok(types.includes("FINAL_VERIFICATION_COMPLETED"));
  });

  it("continues after an action that ran but could not be independently confirmed", async () => {
    // A GUI click with no declared postcondition is the ordinary case, not a
    // fault: the action performed, and nothing external proved what it changed.
    // This used to be routed into diagnosis and abort alongside real failures,
    // so a session that had genuinely done the work was reported as "did not
    // work" and stopped. It must carry on and let the goal decide.
    let secondRan = false;
    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "test.unconfirmable",
          version: "1.0.0",
          description: "performs, proves nothing",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => ({ performed: true }),
          observe: okObserve("test.unconfirmable"),
          verify: async () => ({
            status: "PARTIALLY_VERIFIED",
            message: "UI action completed; no explicit postcondition was supplied.",
            confidence: 0.7
          }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        },
        {
          name: "test.after",
          version: "1.0.0",
          description: "the step that depends on it",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { secondRan = true; return { ok: true }; },
          observe: okObserve("test.after"),
          verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        }
      ],
      planFor: () => {
        const first = task("test.unconfirmable", {}, { taskId: "step_one" });
        const second = task("test.after", {}, { taskId: "step_two", dependencies: ["step_one"] });
        return [first, second];
      }
    });

    const session = await runtime.submitIntent("do the unconfirmable thing then the next one", {
      autoApprove: true,
      operation: "test.unconfirmable",
      category: "SYSTEM",
      normalizedGoal: "Do the unconfirmable thing then the next one"
    });

    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("VERIFICATION_UNCONFIRMED"), "the unconfirmed step must be recorded as such");
    assert.ok(!types.includes("VERIFICATION_FAILED"), "an unconfirmed step is not a failure");
    assert.ok(!types.includes("FAILURE_DIAGNOSED"), "an unconfirmed step must not trigger diagnosis");
    assert.ok(secondRan, "execution must continue to the dependent step");
    // The unconfirmed result is still carried, so nothing can silently claim it.
    assert.ok(
      session.verifications.some((verification) => verification?.status === "PARTIALLY_VERIFIED"),
      "the unconfirmed verification stays in the record"
    );
  });

  it("loops through verification failure -> diagnosis -> recovery -> replan -> success", async () => {
    // A capability that FAILS verification the first time and SUCCEEDS after a
    // replan. The runtime must diagnose, decide to recover, replan, and re-run.
    let attempts = 0;
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.flaky",
        version: "1.0.0",
        description: "fails then succeeds",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" },
        reversibility: "NOT_REQUIRED",
        preconditions: () => true,
        execute: async () => {
          attempts += 1;
          return { attempt: attempts };
        },
        observe: okObserve("test.flaky"),
        verify: async () => (attempts >= 2
          ? { status: "VERIFIED", message: "ok now", confidence: 1 }
          : { status: "FAILED", message: "not yet", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => [task("test.flaky")]
    });

    const session = await runtime.submitIntent("do the flaky thing", {
      autoApprove: true,
      operation: "test.flaky",
      category: "SYSTEM",
      normalizedGoal: "Do the flaky thing"
    });

    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("FAILURE_DIAGNOSED"), "should diagnose the failure");
    assert.ok(types.includes("RECOVERY_DECIDED"), "should decide a recovery");
    assert.ok(types.includes("STARTING_REPLANNING"), "should replan");
    assert.equal(session.finalResponse.status, "COMPLETED", "should recover to COMPLETED");
    assert.ok(attempts >= 2, "capability should have run again after replan");
  });

  it("does not replan a failed mutating task", async () => {
    let plans = 0;
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.mutating-timeout",
        version: "1.0.0",
        description: "mutation whose postcondition cannot be verified",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "MEDIUM" },
        reversibility: "PARTIAL",
        preconditions: () => true,
        execute: async () => ({ changed: true }),
        observe: okObserve("test.mutating-timeout"),
        verify: async () => ({ status: "FAILED", message: "state is uncertain", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => {
        plans += 1;
        return [task("test.mutating-timeout")];
      }
    });

    const session = await runtime.submitIntent("perform the timed mutation", {
      autoApprove: true,
      operation: "test.mutating-timeout",
      category: "SYSTEM",
      normalizedGoal: "Perform the timed mutation"
    });

    assert.equal(session.finalResponse.status, "FAILED", JSON.stringify(session.finalResponse));
    assert.equal(plans, 1, "a failed mutation must not be replanned or retried");
    assert.ok(session.events.some((event) => event.eventType === "RECOVERY_DECIDED" && event.details.action === "abort"));
    assert.ok(!session.events.some((event) => event.eventType === "STARTING_REPLANNING"));
  });

  it("exhausts recovery budget and stops (never loops forever)", async () => {
    let runs = 0;
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.always_fails",
        version: "1.0.0",
        description: "always fails verification",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" },
        reversibility: "NOT_REQUIRED",
        preconditions: () => true,
        execute: async () => { runs += 1; return { runs }; },
        observe: okObserve("test.always_fails"),
        verify: async () => ({ status: "FAILED", message: "nope", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => [task("test.always_fails")]
    });

    const session = await runtime.submitIntent("try the impossible", {
      autoApprove: true,
      operation: "test.always_fails",
      category: "SYSTEM",
      normalizedGoal: "Try the impossible"
    });

    assert.ok(["FAILED", "ROLLED_BACK"].includes(session.finalResponse.status));
    // Bounded: MAX_REPLAN_ATTEMPTS is 2, so the capability runs at most 3 times.
    assert.ok(runs <= 3, `runs should be bounded, got ${runs}`);
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("FAILURE_DIAGNOSED"));
    assert.ok(types.includes("RECOVERY_DECIDED"));
  });

  it("preserves completed VERIFIED work across a replan (no repeat of non-idempotent tasks)", async () => {
    // Two tasks: A always verifies (and counts its executions), B fails once then
    // succeeds. After B triggers a replan, A must NOT run again.
    let aRuns = 0;
    let bAttempts = 0;
    const aId = uid("taskA");
    const bId = uid("taskB");

    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "test.stepA",
          version: "1.0.0",
          description: "step A (non-idempotent)",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { aRuns += 1; return { aRuns }; },
          observe: okObserve("test.stepA"),
          verify: async () => ({ status: "VERIFIED", message: "A ok", confidence: 1 }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        },
        {
          name: "test.stepB",
          version: "1.0.0",
          description: "step B (flaky)",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { bAttempts += 1; return { bAttempts }; },
          observe: okObserve("test.stepB"),
          verify: async () => (bAttempts >= 2
            ? { status: "VERIFIED", message: "B ok", confidence: 1 }
            : { status: "FAILED", message: "B not yet", confidence: 1 }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        }
      ],
      // Stable task IDs so the replan reuses the same graph and preservation works.
      planFor: () => [
        task("test.stepA", {}, { taskId: aId }),
        task("test.stepB", {}, { taskId: bId, dependencies: [aId] })
      ]
    });

    const session = await runtime.submitIntent("run A then B", {
      autoApprove: true,
      operation: "test.chain",
      category: "SYSTEM",
      normalizedGoal: "Run A then B"
    });

    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(aRuns, 1, "step A (verified) must not repeat across replan");
    assert.ok(bAttempts >= 2, "step B should retry until verified");
  });

  it("blocks dependent tasks when a dependency fails, and diagnoses", async () => {
    const aId = uid("depA");
    const bId = uid("depB");
    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "test.depFails",
          version: "1.0.0",
          description: "dependency that fails",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => ({ error: "unknown capability xyz not registered" }),
          observe: okObserve("test.depFails"),
          verify: async () => ({ status: "FAILED", message: "dep failed", confidence: 1 }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        },
        {
          name: "test.dependent",
          version: "1.0.0",
          description: "should be skipped",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" },
          reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => ({ ran: true }),
          observe: okObserve("test.dependent"),
          verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
          rollback: null,
          timeout: 5000,
          retryPolicy: { maxAttempts: 1 }
        }
      ],
      planFor: () => [
        task("test.depFails", {}, { taskId: aId }),
        task("test.dependent", {}, { taskId: bId, dependencies: [aId] })
      ]
    });

    const session = await runtime.submitIntent("run dependency chain", {
      autoApprove: true,
      operation: "test.depchain",
      category: "SYSTEM",
      normalizedGoal: "Run a dependency chain"
    });

    assert.ok(["FAILED", "ROLLED_BACK"].includes(session.finalResponse.status));
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("FAILURE_DIAGNOSED"));
  });

  it("updates semantic state and memory after a verified goal", async () => {
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.semantic",
        version: "1.0.0",
        description: "produces state changes",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" },
        reversibility: "NOT_REQUIRED",
        preconditions: () => true,
        execute: async () => ({ ok: true }),
        observe: async () => ({
          observationId: uid("obs"),
          source: "test.semantic",
          type: "environment_variable",
          environmentVariable: { key: "CL_TEST", value: "1", scope: "user" },
          timestamp: new Date().toISOString(),
          structuredState: { key: "CL_TEST", value: "1" },
          detectedChanges: ["user.environment"],
          affectedEntities: [],
          confidence: 1,
          trustLevel: "SYSTEM_TRUSTED"
        }),
        verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => [task("test.semantic")]
    });

    const session = await runtime.submitIntent("change env", {
      autoApprove: true,
      operation: "test.semantic",
      category: "ENVIRONMENT",
      normalizedGoal: "Change env"
    });

    assert.equal(session.finalResponse.status, "COMPLETED");

    // Semantic state ingested the observation's entity.
    const entities = await runtime.semanticState.queryEntities({ type: "EnvironmentVariable" });
    assert.ok(entities.length >= 1, "semantic state should record the env var entity");

    // Memory recorded an episodic success and a procedural recipe.
    const memories = await runtime.memory.list({});
    assert.ok(memories.some((m) => m.type === "EPISODIC" && m.verifiedSuccess));
    assert.ok(memories.some((m) => m.type === "PROCEDURAL"));

    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("SEMANTIC_STATE_UPDATED"));
    assert.ok(types.includes("MEMORY_UPDATED"));
  });

  it("requests permission (does not loop) when diagnosis is a permission failure", async () => {
    const { runtime } = await buildRuntime({
      capabilities: [{
        name: "test.perm",
        version: "1.0.0",
        description: "permission denied",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" },
        reversibility: "NOT_REQUIRED",
        preconditions: () => true,
        execute: async () => ({ stderr: "Access is denied. (EACCES)", exitCode: 1 }),
        observe: okObserve("test.perm"),
        verify: async () => ({ status: "FAILED", message: "permission denied: EACCES", confidence: 1 }),
        rollback: null,
        timeout: 5000,
        retryPolicy: { maxAttempts: 1 }
      }],
      planFor: () => [task("test.perm")]
    });

    const session = await runtime.submitIntent("do privileged thing", {
      autoApprove: true,
      operation: "test.perm",
      category: "SYSTEM",
      normalizedGoal: "Do a privileged thing"
    });

    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("FAILURE_DIAGNOSED"));
    const diag = session.events.find((e) => e.eventType === "FAILURE_DIAGNOSED");
    assert.equal(diag.details.category, "PERMISSION");
    assert.equal(session.finalResponse.status, "AWAITING_APPROVAL");
  });
});
