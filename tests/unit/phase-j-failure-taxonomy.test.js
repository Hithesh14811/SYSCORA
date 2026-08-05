import test from "node:test";
import assert from "node:assert/strict";
import { TroubleshootingEngine, FailureClass } from "../../packages/troubleshooting-engine/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";

const engine = new TroubleshootingEngine();

function diagnose(input) {
  return engine.diagnose({ recoveryBudgetRemaining: 5, ...input });
}

test("a missing installed application is a prerequisite gap, not a generic verification failure", () => {
  const diagnosis = diagnose({
    task: { taskId: "t1", capability: "application.launch" },
    executionResult: { failureCategory: "APPLICATION_NOT_INSTALLED" },
    verification: {
      status: "FAILED",
      failureCategory: "APPLICATION_NOT_INSTALLED",
      message: "Zoom does not resolve to an installed application on this system."
    }
  });
  assert.equal(diagnosis.category, FailureClass.MISSING_PREREQUISITE);
});

test("a window that could not be grounded stays separate from a missing application", () => {
  const diagnosis = diagnose({
    task: { taskId: "t2", capability: "application.launch" },
    verification: {
      status: "FAILED",
      failureCategory: "WINDOW_GROUNDING_FAILED",
      message: "Could not ground a window for Spotify"
    }
  });
  assert.equal(diagnosis.category, FailureClass.TARGET_NOT_FOUND);
  assert.notEqual(diagnosis.category, FailureClass.MISSING_PREREQUISITE);
});

test("a wrong foreground window aborts and is never recovered by redirecting the action", () => {
  const diagnosis = diagnose({
    task: { taskId: "t3", capability: "ui.action" },
    executionResult: { performed: false, reason: "foreground-not-acquired" },
    verification: { status: "FAILED", message: "foreground-not-acquired" }
  });
  assert.equal(diagnosis.category, FailureClass.WRONG_FOREGROUND_WINDOW);
  const decision = new RecoveryEngine().recover({ diagnosis, budget: { total: 5, spent: 0 } });
  assert.equal(decision.action, "abort");
});

test("a stale target is refreshed rather than replanned from scratch", () => {
  const diagnosis = diagnose({
    task: { taskId: "t4", capability: "ui.action" },
    executionResult: { error: "STALE_OBSERVATION: window identity, bounds, display, or DPI changed" },
    verification: { status: "FAILED", message: "stale target" }
  });
  assert.equal(diagnosis.category, FailureClass.STALE_TARGET);
});

test("an authentication wall asks the user instead of retrying", () => {
  const diagnosis = diagnose({
    task: { taskId: "t5", capability: "browser.extract" },
    executionResult: { stderr: "", stdout: "Sign in to continue. HTTP 401 Unauthorized" },
    verification: { status: "FAILED", message: "login required" }
  });
  assert.equal(diagnosis.category, FailureClass.AUTHENTICATION_REQUIRED);
  const decision = new RecoveryEngine().recover({ diagnosis, budget: { total: 5, spent: 0 } });
  assert.equal(decision.action, "request_clarification");
});

test("a read-only inspection that legitimately found nothing is not retried", () => {
  const diagnosis = diagnose({
    task: { taskId: "t6", capability: "process.port.inspect" },
    executionResult: { port: 3000, status: "NOT_LISTENING", listening: false, probe: { ok: true } },
    verification: { status: "VERIFIED", message: "Port 3000 is not listening." }
  });
  assert.equal(diagnosis.category, FailureClass.EMPTY_DOMAIN_RESULT);
  const decision = new RecoveryEngine().recover({ diagnosis, budget: { total: 5, spent: 0 } });
  assert.equal(decision.action, "abort", "an empty but valid answer must terminate, not loop");
});

test("a broken probe is still a real failure and stays distinct from an empty result", () => {
  const diagnosis = diagnose({
    task: { taskId: "t7", capability: "process.port.inspect" },
    executionResult: { port: 3000, status: "INDETERMINATE", listening: null, probe: { ok: false } },
    verification: { status: "FAILED", message: "Port inspection returned an invalid or ambiguous result." }
  });
  assert.notEqual(diagnosis.category, FailureClass.EMPTY_DOMAIN_RESULT);
});

test("provider unavailability is distinguished from tool failure and keeps deterministic work going", () => {
  const diagnosis = diagnose({
    task: { taskId: "t8", capability: "system.inspect" },
    executionResult: { error: "Model provider unavailable: all configured providers failed health checks" },
    verification: { status: "FAILED", message: "provider unavailable" }
  });
  assert.equal(diagnosis.category, FailureClass.PROVIDER_UNAVAILABLE);
  const decision = new RecoveryEngine().recover({ diagnosis, budget: { total: 5, spent: 0 } });
  assert.equal(decision.action, "replan", "deterministic planning continues when the model is down");
});

test("user cancellation and an exhausted deadline terminate without spending recovery budget", () => {
  for (const [result, expected] of [
    [{ cancelled: true }, FailureClass.USER_CANCELLED],
    [{ timedOut: true, deadlineExhausted: true }, FailureClass.DEADLINE_EXHAUSTED]
  ]) {
    const diagnosis = diagnose({
      task: { taskId: "t9", capability: "ui.action" },
      executionResult: result,
      verification: { status: "FAILED", message: "ended" }
    });
    assert.equal(diagnosis.category, expected);
    const decision = new RecoveryEngine().recover({ diagnosis, budget: { total: 5, spent: 0 } });
    assert.equal(decision.action, "abort", expected);
    assert.equal(decision.budget.spent, 0, `${expected} must not consume recovery budget`);
  }
});

test("every taxonomy entry maps to a defined recovery action", () => {
  const recovery = new RecoveryEngine();
  for (const category of Object.values(FailureClass)) {
    const decision = recovery.recover({ diagnosis: { category }, budget: { total: 5, spent: 0 } });
    assert.ok(
      ["abort", "replan", "retry", "retry_with_backoff", "request_permission", "request_clarification", "rollback"]
        .includes(decision.action),
      `${category} produced an unhandled recovery action: ${decision.action}`
    );
  }
});

test("the pre-existing classifications are unchanged", () => {
  assert.equal(
    diagnose({ executionResult: { timedOut: true }, verification: { status: "FAILED" } }).category,
    FailureClass.TIMEOUT
  );
  assert.equal(
    diagnose({ executionResult: { stderr: "EACCES: permission denied" }, verification: { status: "FAILED" } }).category,
    FailureClass.PERMISSION
  );
  assert.equal(
    diagnose({ executionResult: { stderr: "ECONNREFUSED" }, verification: { status: "FAILED" } }).category,
    FailureClass.NETWORK
  );
  assert.equal(
    diagnose({ executionResult: { error: "unknown capability foo.bar" }, verification: { status: "FAILED" } }).category,
    FailureClass.UNSUPPORTED_CAPABILITY
  );
});
