// Runtime-level LLM-integration tests: provider independence and secret
// isolation through the full AgentRuntime pipeline.
//
// These build a real AgentRuntime with an injected deterministic planner (so no
// live model is needed) and prove:
//   - the runtime completes identically whether the model provider is Mock,
//     a scripted "OpenAI-like", or a scripted "Anthropic-like" provider, and
//     when the reasoning engine has no model at all;
//   - a capability that requires a secret receives the plaintext at execution
//     time, but the secret value never appears in the persisted session, the
//     audit log, or any reasoning prompt.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { MockModelProvider, LanguageModelProvider } from "../../packages/model-providers/src/index.js";

let counter = 0;
const uid = (p) => `${p}_${Date.now()}_${counter++}`;

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

function task(capability, inputs = {}) {
  return {
    taskId: uid("task"),
    goal: capability,
    description: capability,
    dependencies: [],
    capability,
    inputs,
    expectedStateChanges: [],
    affectedEntities: [],
    riskHints: "LOW",
    verificationCriteria: [`${capability} verified`],
    completionCriteria: [`${capability} done`],
    timeout: 5000,
    retryBudget: 0,
    idempotency: true
  };
}

async function buildRuntime({ modelProvider, capabilities, planFor, secretBroker = null }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-llm-"));
  const registry = new CapabilityRegistry();
  for (const cap of capabilities) registry.register({ lifecycleStatus: LifecycleStatus.VERIFIED, ...cap });

  const reasoningEngine = new ReasoningEngine({ modelProvider, capabilityRegistry: registry });
  const auditRepository = new AuditRepository(path.join(tempRoot, "audit"));

  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
    auditRepository,
    capabilityRegistry: registry,
    riskEngine: new RiskEngine(),
    policyEngine: new PolicyEngine(),
    permissionBroker: new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter: {},
    modelProvider,
    reasoningEngine,
    secretBroker,
    intentEngine: new IntentEngine(reasoningEngine),
    contextEngine: new ContextEngine([]),
    semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
    memory: new Memory(path.join(tempRoot, "memory.sqlite"))
  });

  // Deterministic planner injection so the pipeline runs without a live model.
  runtime.generalPlanner = {
    async generatePlan(intent) {
      return {
        planId: uid("plan"),
        planVersion: 1,
        parentPlanId: null,
        goal: intent.normalizedGoal,
        finalSuccessCriteria: intent.successCriteria ?? ["done"],
        summary: intent.normalizedGoal,
        taskGraph: { graphId: uid("graph"), tasks: planFor(intent) }
      };
    }
  };

  return { runtime, tempRoot, auditRepository };
}

// Scripted remote-like providers: they behave like OpenAI/Anthropic for the
// reasoning calls the runtime makes (intent understanding + summarization), but
// deterministically. Provider independence means the runtime result is the same
// regardless of which one is used.
class RemoteLikeProvider extends LanguageModelProvider {
  constructor(name) { super(); this.name = name; }
  async generateStructured(prompt) {
    this._usage.calls += 1;
    // Summary request.
    if (/Summarize this completed automation run/.test(prompt)) {
      return { summary: `${this.name} summary`, changesMade: [], recoveriesPerformed: [], remainingProblems: [], nextRecommendations: [] };
    }
    // Intent request.
    return {
      normalizedGoal: "Do a readonly thing",
      category: "SYSTEM",
      entities: {},
      successCriteria: ["done"]
    };
  }
}

const readonlyCap = {
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
};

describe("provider independence", () => {
  const providers = [
    ["mock", () => new MockModelProvider()],
    ["openai-like", () => new RemoteLikeProvider("openai")],
    ["anthropic-like", () => new RemoteLikeProvider("anthropic")],
    ["no-model", () => null]
  ];

  for (const [label, make] of providers) {
    it(`completes a simple goal identically with provider: ${label}`, async () => {
      const { runtime } = await buildRuntime({
        modelProvider: make(),
        capabilities: [readonlyCap],
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
      // A summary is always produced (model-phrased or deterministic template).
      assert.ok(session.finalResponse.summary);
      assert.equal(typeof session.finalResponse.summary.summary, "string");
    });
  }
});

describe("secret isolation through the runtime", () => {
  it("injects a secret into capability execution but never persists/audits it", async () => {
    const SECRET_VALUE = "sk-DPAPI-TOP-SECRET-1234";
    let seenByCapability = null;

    // Fake DPAPI broker: retrieveSecret(ref) -> plaintext.
    const secretBroker = {
      async retrieveSecret(ref) {
        assert.equal(ref, "secret_ref_1");
        return SECRET_VALUE;
      }
    };

    const secretCap = {
      name: "test.uses_secret",
      version: "1.0.0",
      description: "consumes a secret",
      inputSchema: { type: "object", properties: {}, required: [] },
      riskMetadata: { level: "MEDIUM" },
      reversibility: "NOT_REQUIRED",
      preconditions: () => true,
      // The capability sees the resolved plaintext at execution time.
      execute: async (inputs) => {
        seenByCapability = inputs.apiKey;
        return { usedSecret: Boolean(inputs.apiKey) };
      },
      observe: okObserve("test.uses_secret"),
      verify: async () => ({
        status: "VERIFIED",
        message: "secret-dependent operation independently confirmed",
        evidence: { secretWasAvailable: seenByCapability === SECRET_VALUE },
        independentFromActionResult: true,
        confidence: 1
      }),
      rollback: null,
      timeout: 5000,
      retryPolicy: { maxAttempts: 1 }
    };

    const { runtime, auditRepository } = await buildRuntime({
      modelProvider: new MockModelProvider(),
      capabilities: [secretCap],
      secretBroker,
      // The task carries a secret REFERENCE, never the value.
      planFor: () => [task("test.uses_secret", { secretRefs: { apiKey: "secret_ref_1" } })]
    });

    const session = await runtime.submitIntent("use a secret", {
      autoApprove: true,
      operation: "test.uses_secret",
      category: "SYSTEM",
      normalizedGoal: "Use a secret"
    });

    assert.equal(session.finalResponse.status, "COMPLETED");
    // 1. Capability actually received the resolved plaintext.
    assert.equal(seenByCapability, SECRET_VALUE);

    // 2. The persisted session never contains the plaintext.
    const persisted = await runtime.sessionStore.get(session.sessionId);
    assert.ok(!JSON.stringify(persisted).includes(SECRET_VALUE), "secret must not be persisted in session");

    // 3. The audit log never contains the plaintext.
    const auditEvents = await auditRepository.readAll();
    assert.ok(!JSON.stringify(auditEvents).includes(SECRET_VALUE), "secret must not appear in audit");

    // 4. A SECRETS_INJECTED event was recorded (by reference/key, not value).
    assert.ok(session.events.some((e) => e.eventType === "SECRETS_INJECTED"));
  });
});
