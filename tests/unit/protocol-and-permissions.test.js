import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PolicyEffect } from "../../packages/shared-types/src/domain.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { buildEnvelope, parseRequestBodyWithEnvelope } from "../../packages/protocol/src/envelope.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";

test("permission broker enforces confirmation when required", () => {
  const broker = new PermissionBroker();
  const denied = broker.evaluate({
    policyDecision: { effect: PolicyEffect.DENY, reason: "Denied by policy" },
    autoApprove: true
  });
  assert.equal(denied.approved, false);

  const confirmNeedsApproval = broker.evaluate({
    policyDecision: { effect: PolicyEffect.CONFIRM, reason: "Need approval" },
    autoApprove: false
  });
  assert.equal(confirmNeedsApproval.required, true);
  assert.equal(confirmNeedsApproval.approved, false);

  const confirmApproved = broker.evaluate({
    policyDecision: { effect: PolicyEffect.CONFIRM, reason: "Need approval" },
    autoApprove: true
  });
  assert.equal(confirmApproved.approved, true);
});

test("protocol envelope parser validates and preserves requestId", () => {
  const body = {
    envelope: buildEnvelope("set_env_intent_request", { key: "A" }, "req-1")
  };
  const parsed = parseRequestBodyWithEnvelope(body, "set_env_intent_request");
  assert.equal(parsed.requestId, "req-1");
  assert.equal(parsed.payload.key, "A");
});

test("session and audit repositories persist data in sqlite baseline", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-sqlite-"));
  try {
    const sessionsDir = path.join(tempRoot, "sessions");
    const auditDir = path.join(tempRoot, "audit");
    const sessionStore = new SessionStore(sessionsDir);
    const auditRepository = new AuditRepository(auditDir);

    const sampleSession = {
      sessionId: "session_test",
      createdAt: new Date().toISOString(),
      currentState: "COMPLETED",
      intent: { rawText: "Set value", entities: { workspacePath: ".", key: "X", value: "secret" } }
    };

    await sessionStore.save(sampleSession);
    const loaded = await sessionStore.get("session_test");
    assert.equal(loaded.sessionId, "session_test");
    assert.equal(loaded.intent.entities.value, "***REDACTED***");

    await auditRepository.append("session_test", "TEST_EVENT", { value: "secret" });
    const events = await auditRepository.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.value, "***REDACTED***");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("recovery engine honors attempt budgets", async () => {
  const recoveryEngine = new RecoveryEngine();
  let attempts = 0;
  const result = await recoveryEngine.executeWithBudget(
    {
      action: {
        retryPolicy: {
          maxAttempts: 2
        }
      }
    },
    async () => {
      attempts += 1;
      throw new Error("transient failure");
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.attempt, 2);
  assert.equal(attempts, 2);
});

test("recovery engine rejects an identical strategy until relevant state changes", () => {
  const recoveryEngine = new RecoveryEngine();
  const diagnosis = { category: "NETWORK", rootCause: "connection reset" };
  const first = recoveryEngine.recover({
    diagnosis,
    budget: { total: 4, spent: 0, attempts: [] },
    failureFingerprint: "browser.navigate:connection-reset",
    stateFingerprint: "tabs:v1"
  });
  assert.equal(first.action, "retry_with_backoff");

  const duplicate = recoveryEngine.recover({
    diagnosis,
    budget: first.budget,
    failureFingerprint: "browser.navigate:connection-reset",
    stateFingerprint: "tabs:v1"
  });
  assert.equal(duplicate.action, "abort");
  assert.equal(duplicate.category, "IDENTICAL_RECOVERY_REJECTED");
  assert.equal(duplicate.budget.spent, 1, "rejected duplicate does not consume budget");

  const changed = recoveryEngine.recover({
    diagnosis,
    budget: duplicate.budget,
    failureFingerprint: "browser.navigate:connection-reset",
    stateFingerprint: "tabs:v2"
  });
  assert.equal(changed.action, "retry_with_backoff");
  assert.equal(changed.budget.spent, 2);
});
