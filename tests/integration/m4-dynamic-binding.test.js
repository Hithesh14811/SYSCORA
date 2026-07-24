import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { CapabilityRegistry, LifecycleStatus } from "../../packages/capability-registry/src/index.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ContextEngine } from "../../packages/context-engine/src/index.js";
import { MockModelProvider } from "../../packages/model-providers/src/index.js";

const observe = (source) => async (result) => ({
  source, structuredState: result, detectedChanges: [], confidence: 1, trustLevel: "SYSTEM_TRUSTED"
});
const verify = async () => ({ status: "VERIFIED", message: "verified", confidence: 1 });

test("canonical runtime resolves a discovered target into a dependent task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-m4-binding-"));
  const registry = new CapabilityRegistry();
  let consumedTarget = null;
  registry.register({
    name: "test.find", version: "1.0.0", description: "find",
    inputSchema: { type: "object", properties: {}, required: [] }, outputSchema: { type: "object" },
    riskMetadata: { level: "LOW" }, permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED", preconditions: () => true,
    execute: async () => ({ target: { source: "UIA", windowId: "live-42", name: "Runtime target" } }),
    observe: observe("test.find"), verify, lifecycleStatus: LifecycleStatus.VERIFIED
  });
  registry.register({
    name: "test.consume", version: "1.0.0", description: "consume",
    inputSchema: { type: "object", properties: { target: { type: "object" } }, required: ["target"] },
    outputSchema: { type: "object" }, riskMetadata: { level: "LOW" },
    permissionModel: { scope: ["SESSION"], type: "READ" }, reversibility: "NOT_REQUIRED",
    preconditions: (args) => Boolean(args.target?.windowId),
    execute: async (args) => { consumedTarget = args.target; return { consumed: true }; },
    observe: observe("test.consume"), verify, lifecycleStatus: LifecycleStatus.VERIFIED
  });
  const model = new MockModelProvider();
  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(root, "sessions")),
    auditRepository: new AuditRepository(path.join(root, "audit")),
    capabilityRegistry: registry,
    riskEngine: new RiskEngine({ capabilityRegistry: registry }),
    policyEngine: new PolicyEngine(),
    permissionBroker: new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter: {}, modelProvider: model, intentEngine: new IntentEngine(model),
    contextEngine: new ContextEngine([])
  });
  runtime.generalPlanner = {
    async generatePlan(intent) {
      return {
        planId: "m4-plan", planVersion: 1, parentPlanId: null,
        goal: intent.normalizedGoal, summary: intent.normalizedGoal,
        finalSuccessCriteria: ["bound"],
        taskGraph: { graphId: "m4-graph", tasks: [
          {
            taskId: "find", goal: "find", description: "find", dependencies: [],
            capability: "test.find", inputs: {}, expectedStateChanges: [], affectedEntities: [],
            riskHints: "LOW", verificationCriteria: ["found"], completionCriteria: ["found"],
            timeout: 5000, retryBudget: 0, idempotency: true
          },
          {
            taskId: "consume", goal: "consume", description: "consume", dependencies: ["find"],
            capability: "test.consume", inputs: { target: "$task.find.output.target" },
            expectedStateChanges: [], affectedEntities: [], riskHints: "LOW",
            verificationCriteria: ["consumed"], completionCriteria: ["consumed"],
            timeout: 5000, retryBudget: 0, idempotency: true
          }
        ] }
      };
    }
  };

  const session = await runtime.submitIntent("Use the discovered runtime target", { autoApprove: true });
  assert.equal(session.currentState, "COMPLETED");
  assert.equal(consumedTarget.windowId, "live-42");
  assert.ok(session.events.some((event) => event.eventType === "TASK_INPUTS_RESOLVED"));
});
