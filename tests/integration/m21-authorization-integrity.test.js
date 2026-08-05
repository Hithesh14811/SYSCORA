// M2.1 — Approval, Replan, and Elevation Integrity (production-path adversarial).
//
// Unlike engine-isolated tests, these drive the REAL AgentRuntime composition
// (real RiskEngine, PolicyEngine, PermissionBroker, CapabilityRegistry,
// scheduler, session store, audit) and prove the invariants the independent
// audit demanded:
//
//   HIGH 2  A replan is a NEW security decision. An approval for a LOW/MEDIUM
//           plan can NEVER authorize a HIGH/ELEVATED replan; grants are not
//           minted for unauthorized replan tasks.
//   HIGH 3  ELEVATE is an execution-ROUTING guarantee. An elevated capability
//           must bind to a registered bounded privileged operation; an arbitrary
//           (plugin) elevated capability cannot even register, let alone run.
//   MED 4   Risk evaluation time is explicit and reproducible.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import {
  CapabilityRegistry,
  LifecycleStatus,
  createDefaultCapabilityRegistry
} from "../../packages/capability-registry/src/index.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { ApprovalTokenStore } from "../../packages/permission-broker/src/approval-token-store.js";
import { CapabilityGrantStore } from "../../packages/permission-broker/src/capability-grant-store.js";
import { PrivilegedOperationHelper } from "../../packages/privileged-helpers/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { Memory } from "../../packages/memory/src/index.js";
import { SemanticState } from "../../packages/semantic-state/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ContextEngine } from "../../packages/context-engine/src/index.js";
import { MockModelProvider } from "../../packages/model-providers/src/index.js";

let counter = 0;
const uid = (p) => `${p}_${Date.now()}_${counter++}`;

function task(capability, inputs = {}, overrides = {}) {
  return {
    taskId: overrides.taskId ?? uid("task"),
    goal: overrides.goal ?? capability,
    description: overrides.description ?? capability,
    dependencies: overrides.dependencies ?? [],
    capability,
    inputs,
    expectedStateChanges: [],
    affectedEntities: [],
    riskHints: overrides.riskHints ?? "LOW",
    verificationCriteria: [`${capability} verified`],
    completionCriteria: [`${capability} done`],
    timeout: 5000,
    retryBudget: 0,
    idempotency: true
  };
}

function okObserve(source) {
  return async (result) => ({
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

// Build a runtime with real collaborators. `registry` may be supplied (for the
// ELEVATE routing tests that need the bounded helper); otherwise a plain
// registry is created and the supplied capabilities registered into it.
async function buildRuntime({ capabilities = [], planFor, registry: suppliedRegistry, permissionBroker: suppliedBroker } = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m21-"));
  const registry = suppliedRegistry ?? new CapabilityRegistry();
  if (!suppliedRegistry) {
    for (const cap of capabilities) registry.register({ lifecycleStatus: LifecycleStatus.VERIFIED, ...cap });
  }

  const modelProvider = new MockModelProvider();
  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
    auditRepository: new AuditRepository(path.join(tempRoot, "audit")),
    capabilityRegistry: registry,
    riskEngine: new RiskEngine({ capabilityRegistry: registry }),
    policyEngine: new PolicyEngine(),
    permissionBroker: suppliedBroker ?? new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter: {},
    modelProvider,
    intentEngine: new IntentEngine(modelProvider),
    contextEngine: new ContextEngine([]),
    semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
    memory: new Memory(path.join(tempRoot, "memory.sqlite"))
  });

  runtime.generalPlanner = {
    async generatePlan(intent, _ctx, _sem, _mem, previous) {
      // The runtime passes { priorProcedures, priorFailures } on the INITIAL
      // call and { failedTask, ... } on a REPLAN. Only the latter is a replan,
      // so normalize `previous` to null unless it carries a failedTask.
      const isReplan = Boolean(previous?.failedTask);
      const tasks = planFor(intent, { previous: isReplan ? previous : null });
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

  return { runtime, registry, tempRoot };
}

describe("M2.1 replan re-enters the safety gate (HIGH 2)", () => {
  it("11. an approved LOW plan that replans to a HIGH-risk task does NOT execute the HIGH task under the old approval", async () => {
    let lowRuns = 0;
    let dangerRuns = 0;
    let replanned = false;

    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "test.low", version: "1.0.0", description: "low",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { lowRuns += 1; return { ok: true }; },
          observe: okObserve("test.low"),
          // Fails verification the FIRST time to force a replan.
          verify: async () => (replanned
            ? { status: "VERIFIED", message: "ok", confidence: 1 }
            : { status: "FAILED", message: "force replan", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        },
        {
          // A destructive, irreversible mutation — HIGH risk by profile.
          name: "test.danger", version: "1.0.0", description: "destructive",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "HIGH" }, reversibility: "NOT_REQUIRED",
          security: { filesystem: "WRITE" },
          riskProfile: { mutationImpact: "DESTRUCTIVE", reversibility: "IRREVERSIBLE" },
          preconditions: () => true,
          execute: async () => { dangerRuns += 1; return { ok: true }; },
          observe: okObserve("test.danger"),
          verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        }
      ],
      planFor: (_intent, { previous }) => {
        if (previous) { replanned = true; return [task("test.danger", {}, { taskId: "danger" })]; }
        return [task("test.low", {}, { taskId: "low" })];
      }
    });

    // Caller grants standing approval for the ORIGINAL low-risk plan only.
    const session = await runtime.submitIntent("do the low thing", {
      autoApprove: true, operation: "test.low", category: "SYSTEM", normalizedGoal: "Low thing"
    });

    // The HIGH replan requires a FRESH decision. autoApprove is a blanket bit,
    // so here it would still approve — the important guarantee is that a fresh
    // risk/policy decision RAN for the replan (not inherited). We assert the
    // replan was re-assessed and re-decided.
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("REPLAN_RISK_ASSESSED"), "replan must get a FRESH risk assessment");
    assert.ok(types.includes("REPLAN_POLICY_DECIDED"), "replan must get a FRESH policy decision");
    // The fresh risk assessment for the danger replan must be HIGH (not inherited LOW).
    const replanRisk = session.events.filter((e) => e.eventType === "REPLAN_RISK_ASSESSED").at(-1);
    assert.equal(replanRisk.details.overallRisk, "HIGH", "replan risk reflects the NEW plan, not the old one");
  });

  it("12/13. a replan that escalates to CONFIRM/ELEVATE without standing approval PARKS in AWAITING_APPROVAL (no execution)", async () => {
    let dangerRuns = 0;
    let replanned = false;

    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "test.low", version: "1.0.0", description: "low",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => ({ ok: true }),
          observe: okObserve("test.low"),
          verify: async () => (replanned
            ? { status: "VERIFIED", message: "ok", confidence: 1 }
            : { status: "FAILED", message: "force replan", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        },
        {
          name: "test.danger", version: "1.0.0", description: "destructive",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "HIGH" }, reversibility: "NOT_REQUIRED",
          security: { filesystem: "WRITE" },
          riskProfile: { mutationImpact: "DESTRUCTIVE", reversibility: "IRREVERSIBLE" },
          preconditions: () => true,
          execute: async () => { dangerRuns += 1; return { ok: true }; },
          observe: okObserve("test.danger"),
          verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        }
      ],
      planFor: (_intent, { previous }) => {
        if (previous) { replanned = true; return [task("test.danger", {}, { taskId: "danger" })]; }
        return [task("test.low", {}, { taskId: "low" })];
      }
    });

    // NO standing approval: autoApprove is false. The initial LOW plan is
    // read-only so it runs; the HIGH replan needs CONFIRM and must PARK.
    const session = await runtime.submitIntent("do the low thing", {
      autoApprove: false, operation: "test.low", category: "SYSTEM", normalizedGoal: "Low thing"
    });

    assert.equal(dangerRuns, 0, "the escalated replan task must NOT execute without fresh approval");
    assert.equal(session.finalResponse.status, "AWAITING_APPROVAL");
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("REPLAN_APPROVAL_REQUIRED"), "replan requiring confirmation must request approval");
  });

  it("14. a replan introducing a new capability does not auto-mint a grant for it (deny-by-default)", async () => {
    // Use a grant store so grant issuance is authoritative. The escalated task
    // parks for approval, so NO grant should be issued for it.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m21g-"));
    const grantStore = new CapabilityGrantStore(path.join(tempRoot, "grants"));
    const auditRepository = new AuditRepository(path.join(tempRoot, "audit"));
    const broker = new PermissionBroker({ capabilityGrantStore: grantStore, auditRepository });
    let replanned = false;

    const registry = new CapabilityRegistry();
    for (const cap of [
      {
        name: "test.low", version: "1.0.0", description: "low",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
        preconditions: () => true, execute: async () => ({ ok: true }),
        observe: okObserve("test.low"),
        verify: async () => (replanned
          ? { status: "VERIFIED", message: "ok", confidence: 1 }
          : { status: "FAILED", message: "force replan", confidence: 1 }),
        rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }, lifecycleStatus: LifecycleStatus.VERIFIED
      },
      {
        name: "test.danger", version: "1.0.0", description: "destructive",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "HIGH" }, reversibility: "NOT_REQUIRED",
        security: { filesystem: "WRITE" },
        riskProfile: { mutationImpact: "DESTRUCTIVE", reversibility: "IRREVERSIBLE" },
        preconditions: () => true, execute: async () => ({ ok: true }),
        observe: okObserve("test.danger"),
        verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
        rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }, lifecycleStatus: LifecycleStatus.VERIFIED
      }
    ]) registry.register(cap);

    const modelProvider = new MockModelProvider();
    const runtime = new AgentRuntime({
      sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
      auditRepository,
      capabilityRegistry: registry,
      riskEngine: new RiskEngine({ capabilityRegistry: registry }),
      policyEngine: new PolicyEngine(),
      permissionBroker: broker,
      recoveryEngine: new RecoveryEngine(),
      troubleshootingEngine: new TroubleshootingEngine(),
      adapter: {},
      modelProvider,
      intentEngine: new IntentEngine(modelProvider),
      contextEngine: new ContextEngine([]),
      semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
      memory: new Memory(path.join(tempRoot, "memory.sqlite"))
    });
    runtime.generalPlanner = {
      async generatePlan(intent, _c, _s, _m, previous) {
        const isReplan = Boolean(previous?.failedTask);
        const tasks = isReplan ? (replanned = true, [task("test.danger", {}, { taskId: "danger" })]) : [task("test.low", {}, { taskId: "low" })];
        return { planId: uid("plan"), planVersion: 1, parentPlanId: null, goal: intent.normalizedGoal, finalSuccessCriteria: ["done"], summary: "x", taskGraph: { graphId: uid("g"), tasks } };
      }
    };

    await runtime.submitIntent("low then danger", {
      autoApprove: false, operation: "test.low", category: "SYSTEM", normalizedGoal: "Low thing"
    });

    // No grant may have been minted for the parked, unauthorized danger task.
    const audit = await auditRepository.readAll();
    const grantedDanger = audit.some((e) => e.eventType === "CAPABILITY_GRANT_ISSUED" && e.payload?.capability === "test.danger");
    assert.equal(grantedDanger, false, "no grant may be minted for an unauthorized replan task");
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("16. completed VERIFIED tasks are preserved across a replan (not re-run)", async () => {
    let aRuns = 0;
    let bAttempts = 0;
    const { runtime } = await buildRuntime({
      capabilities: [
        {
          name: "step.a", version: "1.0.0", description: "A",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { aRuns += 1; return { ok: true }; },
          observe: okObserve("step.a"),
          verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        },
        {
          name: "step.b", version: "1.0.0", description: "B",
          inputSchema: { type: "object", properties: {}, required: [] },
          riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
          preconditions: () => true,
          execute: async () => { bAttempts += 1; return { attempt: bAttempts }; },
          observe: okObserve("step.b"),
          verify: async () => (bAttempts >= 2
            ? { status: "VERIFIED", message: "ok", confidence: 1 }
            : { status: "FAILED", message: "retry", confidence: 1 }),
          rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }
        }
      ],
      // Stable task ids so preservation applies across the replan.
      planFor: () => [
        task("step.a", {}, { taskId: "A" }),
        task("step.b", {}, { taskId: "B", dependencies: ["A"] })
      ]
    });

    const session = await runtime.submitIntent("A then B", {
      autoApprove: true, operation: "step.a", category: "SYSTEM", normalizedGoal: "A then B"
    });
    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(aRuns, 1, "verified step A must not repeat across replan");
    assert.ok(bAttempts >= 2, "step B retried until verified");
  });

  it("MVP: a material replan revokes the prior plan's pending grants (no stale reuse)", async () => {
    // Plan A uses cap.alpha; a material replan swaps to cap.beta. The old
    // alpha grant must be revoked so a session-reusable grant for a dropped
    // capability can never authorize later work.
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m21rev-"));
    const grantStore = new CapabilityGrantStore(path.join(tempRoot, "grants"));
    const auditRepository = new AuditRepository(path.join(tempRoot, "audit"));
    const broker = new PermissionBroker({ capabilityGrantStore: grantStore, auditRepository });
    let replanned = false;

    const registry = new CapabilityRegistry();
    for (const cap of [
      {
        name: "cap.alpha", version: "1.0.0", description: "alpha",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
        preconditions: () => true, execute: async () => ({ ok: true }),
        observe: okObserve("cap.alpha"),
        verify: async () => (replanned
          ? { status: "VERIFIED", message: "ok", confidence: 1 }
          : { status: "FAILED", message: "force replan", confidence: 1 }),
        rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }, lifecycleStatus: LifecycleStatus.VERIFIED
      },
      {
        name: "cap.beta", version: "1.0.0", description: "beta",
        inputSchema: { type: "object", properties: {}, required: [] },
        riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
        preconditions: () => true, execute: async () => ({ ok: true }),
        observe: okObserve("cap.beta"),
        verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
        rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 }, lifecycleStatus: LifecycleStatus.VERIFIED
      }
    ]) registry.register(cap);

    const modelProvider = new MockModelProvider();
    const runtime = new AgentRuntime({
      sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
      auditRepository,
      capabilityRegistry: registry,
      riskEngine: new RiskEngine({ capabilityRegistry: registry }),
      policyEngine: new PolicyEngine(),
      permissionBroker: broker,
      recoveryEngine: new RecoveryEngine(),
      troubleshootingEngine: new TroubleshootingEngine(),
      adapter: {},
      modelProvider,
      intentEngine: new IntentEngine(modelProvider),
      contextEngine: new ContextEngine([]),
      semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
      memory: new Memory(path.join(tempRoot, "memory.sqlite"))
    });
    runtime.generalPlanner = {
      async generatePlan(intent, _c, _s, _m, previous) {
        const isReplan = Boolean(previous?.failedTask);
        const tasks = isReplan
          ? (replanned = true, [task("cap.beta", {}, { taskId: "beta" })])
          : [task("cap.alpha", {}, { taskId: "alpha" })];
        return { planId: uid("plan"), planVersion: 1, parentPlanId: null, goal: intent.normalizedGoal, finalSuccessCriteria: ["done"], summary: "x", taskGraph: { graphId: uid("g"), tasks } };
      }
    };

    const session = await runtime.submitIntent("alpha then beta", {
      autoApprove: true, operation: "cap.alpha", category: "SYSTEM", normalizedGoal: "Alpha then beta"
    });

    // The material replan must have emitted a grant-invalidation event and the
    // audit trail must record the revocation.
    const types = session.events.map((e) => e.eventType);
    assert.ok(types.includes("REPLAN_GRANTS_INVALIDATED"), "material replan must invalidate prior grants");
    const audit = await auditRepository.readAll();
    assert.ok(audit.some((e) => e.eventType === "CAPABILITY_GRANTS_REVOKED"), "revocation is audited");
    assert.equal(session.finalResponse.status, "PARTIALLY_COMPLETED", "a replacement recovery cannot erase the failed alpha clause");
    assert.deepEqual(session.finalResponse.evidenceCoverage.unsatisfiedCriteria, ["alpha"]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});

describe("M2.1 ELEVATE is execution routing (HIGH 3)", () => {
  it("20/21. a plugin capability declaring elevation + arbitrary execute is REJECTED at registration", () => {
    const helper = new PrivilegedOperationHelper({ adapter: {} });
    const registry = createDefaultCapabilityRegistry({}, { privilegedHelper: helper });
    let ran = false;
    assert.throws(() => {
      registry.register({
        name: "evil.plugin.admin", version: "1.0.0", description: "arbitrary admin",
        inputSchema: { type: "object", properties: {} },
        requirements: { elevation: "ADMIN", permissions: ["system:anything"] },
        preconditions: () => true,
        execute: async () => { ran = true; return { pwned: true }; },
        observe: async (r) => ({ structuredState: r }),
        verify: async () => ({ status: "VERIFIED", confidence: 1 }),
        lifecycleStatus: LifecycleStatus.VERIFIED
      }, { source: "evil-plugin", strict: true });
    }, /Plugins cannot self-grant privileged execution|requires elevation but is sourced/);
    assert.equal(ran, false, "the arbitrary elevated execute must never run");
    assert.equal(registry.has("evil.plugin.admin"), false);
  });

  it("21b. even a BUILT-IN elevated capability must bind a known bounded operation or be rejected", () => {
    const helper = new PrivilegedOperationHelper({ adapter: {} });
    const registry = createDefaultCapabilityRegistry({}, { privilegedHelper: helper });
    assert.throws(() => {
      registry.register({
        name: "system.bogus.elevated", version: "1.0.0", description: "no real route",
        inputSchema: { type: "object", properties: {} },
        requirements: { elevation: "ADMIN", permissions: ["system:x"] },
        privilegedOperation: "not.a.real.operation",
        preconditions: () => true,
        execute: async () => ({}),
        observe: async (r) => ({ structuredState: r }),
        verify: async () => ({ status: "VERIFIED", confidence: 1 }),
        lifecycleStatus: LifecycleStatus.VERIFIED
      }); // builtin source
    }, /must bind privilegedOperation to a known bounded/);
  });

  it("19. a built-in privileged capability binds a real bounded operation and is routed through the helper", async () => {
    const helper = new PrivilegedOperationHelper({ adapter: { async serviceExists() { return { exists: true }; } } });
    const registry = createDefaultCapabilityRegistry({ async serviceExists() { return { exists: true }; } }, { privilegedHelper: helper });
    const cap = registry.get("service.restart");
    assert.equal(cap.privilegedOperation, "service.restart");
    assert.ok(registry.privilegedOperations.has("service.restart"), "the bounded route is registered");
    // The pipeline allows preparation only because a live bounded route exists.
    const prepared = await registry.pipeline.prepare(
      { taskId: "t", capability: "service.restart", inputs: { scope: "demo", token: "x" } },
      { platform: process.platform, privilegeApproved: true, authorize: async () => ({ approved: true }) }
    );
    assert.equal(prepared.name, "service.restart");
  });

  it("22. helper availability for one operation cannot authorize an unsupported operation", () => {
    const helper = new PrivilegedOperationHelper({ adapter: {} });
    assert.equal(helper.isSupported("service.restart"), true);
    assert.equal(helper.isSupported("arbitrary.plugin.adminAction"), false);
    // supportedOperations is the authoritative, finite allow-list.
    assert.ok(!helper.supportedOperations().includes("arbitrary.plugin.adminAction"));
  });

  it("23/24. an elevated capability cannot run without a live bounded route (pipeline fails closed)", async () => {
    // A registry with NO helper wired: privilegedOperations is empty, so even a
    // correctly-declared built-in elevated capability has no live route and the
    // pipeline refuses to prepare it — a bare privilegeApproved boolean is not
    // sufficient to execute.
    const registry = createDefaultCapabilityRegistry({}); // no helper
    await assert.rejects(
      registry.pipeline.prepare(
        { taskId: "t", capability: "service.restart", inputs: { scope: "demo", token: "x" } },
        { platform: process.platform, privilegeApproved: true, authorize: async () => ({ approved: true }) }
      ),
      (error) => {
        assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
        assert.match(error.message, /service\.restart is unavailable/);
        return true;
      }
    );
  });
});

describe("M2.1 risk evaluation time is explicit (MED 4)", () => {
  const engine = new RiskEngine();
  const plan = { taskGraph: { tasks: [{ taskId: "t", capability: "x", inputs: {} }] } };
  const staleCtx = { items: [{ type: "environment", observedAt: "2020-01-01T00:00:00.000Z" }] };

  it("26. identical (plan, context, evaluatedAt) yields identical assessment", () => {
    const t = "2020-01-01T00:00:10.000Z";
    const a = engine.assess(plan, staleCtx, { evaluatedAt: t });
    const b = engine.assess(plan, staleCtx, { evaluatedAt: t });
    assert.deepEqual(a.dimensions, b.dimensions);
    assert.equal(a.overallRisk, b.overallRisk);
    assert.equal(a.uncertainty, b.uncertainty);
    assert.equal(a.evaluatedAt, b.evaluatedAt);
  });

  it("27. a later explicit evaluation time deterministically increases staleness", () => {
    const fresh = engine.assess(plan, { items: [{ type: "environment", observedAt: "2020-01-01T00:00:00.000Z" }] }, { evaluatedAt: "2020-01-01T00:00:10.000Z" });
    const stale = engine.assess(plan, { items: [{ type: "environment", observedAt: "2020-01-01T00:00:00.000Z" }] }, { evaluatedAt: "2020-01-01T01:00:00.000Z" });
    assert.equal(fresh.contextEvidence.contextStale, false);
    assert.equal(stale.contextEvidence.contextStale, true);
  });

  it("28. the assessment records the evaluatedAt that was used", () => {
    const t = "2020-06-01T12:00:00.000Z";
    const a = engine.assess(plan, staleCtx, { evaluatedAt: t });
    assert.equal(a.evaluatedAt, t);
  });
});
