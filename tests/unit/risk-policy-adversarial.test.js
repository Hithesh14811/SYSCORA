// Adversarial hardening suite for the risk -> policy -> permission decision path.
//
// Every test here encodes a way a malicious or buggy caller could try to make a
// dangerous operation run without the control it deserves — and asserts the
// system fails CLOSED. These are the guarantees the four layers exist to hold:
//
//   1. Capabilities cannot self-certify as safer than their surface implies.
//   2. Runtime evidence and caller hints can only RAISE risk, never lower it.
//   3. Required controls escalate monotonically and are never silently
//      downgraded to a weaker mechanism that happens to be wired.
//   4. A required control with no wired mechanism fails closed, not open.
//   5. An approval is bound to the exact plan it was shown for; a mutated plan
//      voids the approval.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RiskLevel,
  RiskDimension,
  ConfirmationLevel,
  PolicyEffect,
  PolicyOutcome
} from "../../packages/shared-types/src/domain.js";
import { deriveRiskProfile, normalizeCapability } from "../../packages/capability-registry/src/contract.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";

// A registry stub that returns a fixed capability for any task name. Lets the
// RiskEngine read an authoritative floor without standing up the full registry.
function registryOf(capabilitiesByName) {
  return {
    get: (name) => capabilitiesByName[name] ?? null
  };
}

function planWith(tasks) {
  return { taskGraph: { tasks } };
}

// --- Layer 1 & 2: capabilities cannot self-certify below their surface ------

test("a WRITE-surface capability declaring LOW risk still derives a mutating profile", () => {
  const profile = deriveRiskProfile(
    "plugin.sneaky.write",
    { risk: { level: RiskLevel.LOW }, riskProfile: { MUTATION_IMPACT: "READ_ONLY" } },
    { filesystem: "WRITE" },
    { type: "WRITE", scope: ["USER"], declaredPermissions: ["fs:write"] }
  );
  // The declared READ_ONLY is ignored downward: the WRITE surface forces at
  // least PERSISTENT mutation and USER-persistent persistence.
  assert.notEqual(profile[RiskDimension.MUTATION_IMPACT], "READ_ONLY");
  assert.equal(profile[RiskDimension.PERSISTENCE], "USER_PERSISTENT");
});

test("an explicit riskProfile may raise a dimension but never lower it", () => {
  const profile = deriveRiskProfile(
    "plugin.declares.higher",
    { risk: { level: RiskLevel.LOW }, riskProfile: { [RiskDimension.BLAST_RADIUS]: "SYSTEM_WIDE", [RiskDimension.DATA_SENSITIVITY]: "PUBLIC" } },
    { filesystem: "WRITE" },
    { type: "WRITE", scope: ["PROJECT"], declaredPermissions: ["fs:write"] }
  );
  // Raised where declared higher...
  assert.equal(profile[RiskDimension.BLAST_RADIUS], "SYSTEM_WIDE");
  // ...but a PUBLIC claim cannot pull data sensitivity below the derived floor.
  assert.notEqual(profile[RiskDimension.DATA_SENSITIVITY], "PUBLIC");
});

// --- Layer 2: RiskEngine evidence is raise-only ------------------------------

test("a LOW risk hint cannot lower a capability's authoritative floor", () => {
  const capability = normalizeCapability(
    { name: "env.write", risk: { level: RiskLevel.MEDIUM }, security: { filesystem: "WRITE" },
      requirements: { permissions: ["fs:write"] } },
    { source: "builtin" }
  );
  const engine = new RiskEngine({ capabilityRegistry: registryOf({ "env.write": capability }) });
  const assessment = engine.assess(
    planWith([{ capability: "env.write", riskHints: RiskLevel.LOW, inputs: { key: "X", value: "1" } }]),
    { currentEnvironment: { exists: true } }
  );
  // The LOW hint is ignored downward; a persistent write stays at least MEDIUM.
  assert.notEqual(assessment.overallRisk, RiskLevel.LOW);
});

test("a model-derived plan cannot claim INTERNAL input trust", () => {
  const engine = new RiskEngine();
  const assessment = engine.assess(
    { source: "model", taskGraph: { tasks: [{ action: { actionType: "EnvironmentVariableSetAction", parameters: { key: "K", value: "v" } }, inputTrust: "INTERNAL" }] } },
    { currentEnvironment: { exists: true } }
  );
  assert.equal(assessment.dimensions[RiskDimension.INPUT_TRUST], "MODEL_DERIVED");
});

// --- Layer 3 & 4: policy controls escalate and fail closed -------------------

test("privileged operation requires ELEVATE and fails closed when the helper is not wired", () => {
  const engine = new PolicyEngine(); // ELEVATE unavailable by default
  const decision = engine.decide(
    { overallRisk: RiskLevel.HIGH, dimensions: { [RiskDimension.PRIVILEGE]: "ADMINISTRATOR" } },
    planWith([{ capability: "service.restart" }])
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.ELEVATE);
  assert.equal(decision.outcome, PolicyOutcome.REQUIRED_CONTROL_UNAVAILABLE);
  // Fails closed: the legacy effect is DENY, never a downgrade to CONFIRM.
  assert.equal(decision.effect, PolicyEffect.DENY);
});

test("privileged operation proceeds under ELEVATE when the mechanism is wired", () => {
  const engine = new PolicyEngine({ controlAvailability: { ELEVATE: true } });
  const decision = engine.decide(
    { overallRisk: RiskLevel.HIGH, dimensions: { [RiskDimension.PRIVILEGE]: "ELEVATED" } },
    planWith([{ capability: "service.restart" }])
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.ELEVATE);
  assert.equal(decision.outcome, PolicyOutcome.PROCEED);
});

test("critical-risk execution is hard-denied regardless of wired controls", () => {
  const engine = new PolicyEngine({ controlAvailability: { ELEVATE: true, SANDBOX: true } });
  const decision = engine.decide(
    { overallRisk: RiskLevel.CRITICAL, dimensions: { [RiskDimension.EXECUTION_RISK]: "UNTRUSTED_EXECUTION" } },
    planWith([{ capability: "package.install" }])
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.DENY);
  assert.equal(decision.outcome, PolicyOutcome.BLOCKED);
  assert.equal(decision.effect, PolicyEffect.DENY);
});

test("a capability demanding SANDBOX fails closed when SANDBOX is unavailable", () => {
  const engine = new PolicyEngine(); // SANDBOX unavailable
  const decision = engine.decide(
    { overallRisk: RiskLevel.MEDIUM, dimensions: {} },
    planWith([{ capability: "plugin.needs.sandbox" }]),
    { capabilities: [{ name: "plugin.needs.sandbox", risk: { policyRequirements: [ConfirmationLevel.SANDBOX] } }] }
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.SANDBOX);
  assert.equal(decision.outcome, PolicyOutcome.REQUIRED_CONTROL_UNAVAILABLE);
});

test("the strongest required control wins across independent rules", () => {
  const engine = new PolicyEngine({ controlAvailability: { ELEVATE: true } });
  const decision = engine.decide(
    {
      overallRisk: RiskLevel.HIGH,
      dimensions: {
        [RiskDimension.PRIVILEGE]: "ADMINISTRATOR", // -> ELEVATE
        [RiskDimension.MUTATION_IMPACT]: "DESTRUCTIVE", // -> CONFIRM
        [RiskDimension.DATA_SENSITIVITY]: "SECURITY_CRITICAL" // -> CONFIRM
      }
    },
    planWith([{ capability: "service.restart" }])
  );
  // ELEVATE (4) is stronger than CONFIRM (2), so it is the resolved control.
  assert.equal(decision.confirmationLevel, ConfirmationLevel.ELEVATE);
});

test("high uncertainty escalates an otherwise-benign decision to AUDIT", () => {
  const engine = new PolicyEngine();
  const decision = engine.decide(
    { overallRisk: RiskLevel.LOW, uncertainty: 0.5, dimensions: {} },
    planWith([{ capability: "fs.read" }])
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.AUDIT);
  // AUDIT still proceeds (no interactive approval) but is not silent.
  assert.equal(decision.effect, PolicyEffect.ALLOW);
});

test("informed-approval descriptor is attached whenever confirmation is required", () => {
  const engine = new PolicyEngine();
  const decision = engine.decide(
    { overallRisk: RiskLevel.HIGH, dimensions: { [RiskDimension.MUTATION_IMPACT]: "DESTRUCTIVE" }, mitigations: ["checkpoint first"] },
    planWith([{ capability: "fs.delete" }])
  );
  assert.equal(decision.confirmationLevel, ConfirmationLevel.CONFIRM);
  assert.ok(decision.informedApproval, "confirmation decisions must describe what is approved");
  assert.equal(decision.informedApproval.requiredControl, ConfirmationLevel.CONFIRM);
  assert.ok(Array.isArray(decision.informedApproval.whatItDoes));
});

// --- Layer 5: approval binds to the exact plan -------------------------------

// A broker with a FIXED installation key so commitments are deterministic
// across test runs within this process.
function brokerWithFixedKey() {
  return new PermissionBroker({ installationKey: Buffer.alloc(32, 7) });
}

test("approval commitment changes when a task's material inputs change", () => {
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "FLAG_A", value: "1" } }]));
  const b = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "FLAG_B", value: "1" } }]));
  assert.notEqual(a, b);
});

test("approval commitment changes when the selected capability changes", () => {
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "K" } }]));
  const b = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "service.restart", inputs: { key: "K" } }]));
  assert.notEqual(a, b);
});

test("approval commitment changes when a SECRET value changes (no redaction collapse)", () => {
  // The CENTRAL HIGH-1 fix: two distinct secret values must NOT collapse to the
  // same commitment via redaction. The secret is committed with a keyed HMAC.
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "API_KEY", value: "one" } }]));
  const b = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "API_KEY", value: "two" } }]));
  assert.notEqual(a, b);
});

test("approval commitment contains no plaintext secret", () => {
  const broker = brokerWithFixedKey();
  const built = broker.buildApprovalCommitment(
    planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "API_KEY", value: "super-secret-plaintext" } }])
  );
  const serialized = JSON.stringify(built);
  assert.equal(serialized.includes("super-secret-plaintext"), false);
});

test("approval commitment changes when the dependency graph changes", () => {
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([
    { taskId: "t1", capability: "env.set", inputs: { key: "K" }, dependencies: [] },
    { taskId: "t2", capability: "env.set", inputs: { key: "K2" }, dependencies: [] }
  ]));
  const b = broker.approvalCommitment(planWith([
    { taskId: "t1", capability: "env.set", inputs: { key: "K" }, dependencies: [] },
    { taskId: "t2", capability: "env.set", inputs: { key: "K2" }, dependencies: ["t1"] }
  ]));
  assert.notEqual(a, b);
});

test("approval commitment changes when elevation requirement changes", () => {
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "x", inputs: {}, requirements: { elevation: "NONE" } }]));
  const b = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "x", inputs: {}, requirements: { elevation: "ADMIN" } }]));
  assert.notEqual(a, b);
});

test("approval commitment is stable across the redaction persistence applies", () => {
  // The secret field is committed via HMAC and REMOVED from the retained
  // structure, so a pre-persist plan and its reloaded (redacted) self yield the
  // same commitment WHEN the prior manifest is supplied for the round-trip.
  const broker = brokerWithFixedKey();
  const live = planWith([{ taskId: "t1", capability: "secret.store", inputs: { key: "API_KEY", value: "super-secret" } }]);
  const built = broker.buildApprovalCommitment(live);
  const persisted = planWith([{ taskId: "t1", capability: "secret.store", inputs: { key: "API_KEY", value: "***REDACTED***" } }]);
  const reBuilt = broker.buildApprovalCommitment(persisted, { priorManifest: built.manifest });
  assert.equal(reBuilt.commitment, built.commitment);
});

test("object-key ordering does not create a false commitment difference", () => {
  const broker = brokerWithFixedKey();
  const a = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { a: "1", b: "2" } }]));
  const b = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { b: "2", a: "1" } }]));
  assert.equal(a, b);
});

test("broker echoes the operation-scoped commitment so a mutated plan can be detected", () => {
  const broker = brokerWithFixedKey();
  const commitment = broker.approvalCommitment(planWith([{ taskId: "t1", capability: "env.set", inputs: { key: "K", value: "1" } }]));
  const decision = broker.evaluate({
    policyDecision: { effect: PolicyEffect.CONFIRM, confirmationLevel: ConfirmationLevel.CONFIRM },
    autoApprove: true,
    approvalCommitment: commitment
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.approvalCommitment, commitment);
  assert.equal(decision.confirmationLevel, ConfirmationLevel.CONFIRM);
});

test("broker denies when the policy decision is missing (fail closed)", () => {
  const broker = new PermissionBroker();
  const decision = broker.evaluate({ policyDecision: null });
  assert.equal(decision.approved, false);
  assert.equal(decision.required, true);
});
