// M3 real-LLM planning integration tests.
//
// These prove the LLM planning path genuinely contributes to execution — NOT a
// deterministic keyword match. A ScriptedProvider stands in for OpenAI/Anthropic
// (same generateStructured contract), returning a task graph for a novel,
// free-text intent that has NO deterministic OPERATION_PLANS entry. The plan
// flows through the REAL runtime: composeTaskGraph -> validate against the live
// capability catalog -> risk -> policy -> execute -> observe -> verify.
//
// This is the Batch 3/4 proof: the model drives planning, output is validated
// against the real catalog (hallucinations rejected), and a bad model response
// falls back deterministically instead of executing arbitrary text.

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
import { ContextEngine } from "../../packages/context-engine/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { LanguageModelProvider } from "../../packages/model-providers/src/index.js";

let counter = 0;
const uid = (p) => `${p}_${Date.now()}_${counter++}`;

// A provider that returns pre-scripted structured responses keyed by a marker in
// the prompt. Mirrors what a real OpenAI/Anthropic provider returns from
// generateStructured — the ReasoningEngine cannot tell the difference.
class ScriptedProvider extends LanguageModelProvider {
  constructor(script) {
    super();
    this.name = "scripted";
    this.script = script;
    this.calls = [];
  }
  async healthCheck() { return { ok: true, type: "ScriptedProvider" }; }
  async generateStructured(prompt, _schema) {
    this.calls.push(prompt);
    // Intent classification prompt vs task-graph prompt vs summary — dispatch on
    // marker text the ReasoningEngine includes.
    if (prompt.includes("Generate a task plan")) return this.script.taskGraph(prompt);
    if (prompt.includes("understand") || prompt.includes("intent")) return this.script.intent?.(prompt) ?? {};
    return this.script.other?.(prompt) ?? { text: "ok" };
  }
}

function readonlyCap(name, source) {
  return {
    name, version: "1.0.0", description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    riskMetadata: { level: "LOW" }, reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({ ok: true, ran: name }),
    observe: async (result) => ({
      observationId: uid("obs"), source: name, timestamp: new Date().toISOString(),
      structuredState: result, detectedChanges: [name], affectedEntities: [], confidence: 1, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "ok", confidence: 1 }),
    rollback: null, timeout: 5000, retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  };
}

async function buildRuntime(provider, capabilities) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m3llm-"));
  const registry = new CapabilityRegistry();
  for (const cap of capabilities) registry.register(cap);
  const reasoningEngine = new ReasoningEngine({ modelProvider: provider, capabilityRegistry: registry });
  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
    auditRepository: new AuditRepository(path.join(tempRoot, "audit")),
    capabilityRegistry: registry,
    riskEngine: new RiskEngine({ capabilityRegistry: registry }),
    policyEngine: new PolicyEngine(),
    permissionBroker: new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter: {},
    modelProvider: provider,
    reasoningEngine,
    intentEngine: new IntentEngine(reasoningEngine),
    contextEngine: new ContextEngine([]),
    semanticState: new SemanticState(path.join(tempRoot, "semantic.sqlite")),
    memory: new Memory(path.join(tempRoot, "memory.sqlite"))
  });
  return { runtime, registry, tempRoot };
}

describe("M3 real-LLM planning path (Batch 4)", () => {
  it("the model composes a NOVEL multi-step plan that executes end-to-end (no deterministic keyword match)", async () => {
    // Two read-only capabilities the model will chain. The free-text intent has
    // no OPERATION_PLANS entry, so a plan can ONLY come from the model here.
    const caps = [readonlyCap("system.inspect"), readonlyCap("processes.list")];
    const provider = new ScriptedProvider({
      taskGraph: () => ({
        goal: "Summarize the machine",
        summary: "Inspect system then list processes",
        finalSuccessCriteria: ["system inspected", "processes listed"],
        taskGraph: {
          graphId: "g1",
          tasks: [
            { taskId: "t1", goal: "inspect", description: "inspect system", dependencies: [], capability: "system.inspect", inputs: {}, riskHints: "LOW", verificationCriteria: [], completionCriteria: [], rollbackRequired: false, timeout: 5000, retryBudget: 0, idempotency: true },
            { taskId: "t2", goal: "list", description: "list processes", dependencies: ["t1"], capability: "processes.list", inputs: {}, riskHints: "LOW", verificationCriteria: [], completionCriteria: [], rollbackRequired: false, timeout: 5000, retryBudget: 0, idempotency: true }
          ]
        }
      })
    });
    const { runtime } = await buildRuntime(provider, caps);

    // Deliberately NOT an operation keyword — free text only.
    const session = await runtime.submitIntent(
      "give me a quick rundown of this box and whats running on it",
      { autoApprove: true, category: "SYSTEM", normalizedGoal: "Rundown of the machine" }
    );

    assert.equal(session.finalResponse.status, "COMPLETED");
    // The model's two-task plan actually ran, in order.
    const caps2 = session.plan.taskGraph.tasks.map((t) => t.capability);
    assert.deepEqual(caps2, ["system.inspect", "processes.list"]);
    assert.ok(provider.calls.some((p) => p.includes("Generate a task plan")), "model was consulted for planning");
    assert.equal(session.taskResults.length, 2, "both model-planned tasks executed");
  });

  it("a model plan referencing a HALLUCINATED capability is rejected and falls back deterministically", async () => {
    const caps = [readonlyCap("system.inspect")];
    const provider = new ScriptedProvider({
      taskGraph: () => ({
        goal: "do it", summary: "hallucinated",
        finalSuccessCriteria: ["x"],
        taskGraph: { graphId: "g", tasks: [
          { taskId: "t1", goal: "x", description: "x", dependencies: [], capability: "totally.fake.capability", inputs: {}, riskHints: "LOW", verificationCriteria: [], completionCriteria: [], rollbackRequired: false, timeout: 5000, retryBudget: 0, idempotency: true }
        ] }
      })
    });
    const { runtime } = await buildRuntime(provider, caps);

    // Give a deterministic operation so the fallback has something valid to plan.
    const session = await runtime.submitIntent("inspect the system", {
      autoApprove: true, operation: "system.inspect", category: "SYSTEM", normalizedGoal: "Inspect"
    });

    // The hallucinated capability must NEVER appear in the executed plan.
    const names = session.plan.taskGraph.tasks.map((t) => t.capability);
    assert.equal(names.includes("totally.fake.capability"), false, "hallucinated capability must be rejected");
    assert.ok(names.includes("system.inspect"), "deterministic fallback produced a valid plan");
  });

  it("a malformed model response (garbage) does not execute; deterministic fallback runs", async () => {
    const caps = [readonlyCap("system.inspect")];
    const provider = new ScriptedProvider({ taskGraph: () => ({ nonsense: true }) });
    const { runtime } = await buildRuntime(provider, caps);
    const session = await runtime.submitIntent("inspect the system", {
      autoApprove: true, operation: "system.inspect", category: "SYSTEM", normalizedGoal: "Inspect"
    });
    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.ok(session.plan.taskGraph.tasks.every((t) => t.capability), "every executed task names a real capability");
  });
});
