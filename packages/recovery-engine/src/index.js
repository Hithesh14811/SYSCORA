// RecoveryEngine
//
// Two responsibilities:
//   1. decide the next recovery action for a diagnosed failure, within a bounded
//      budget (recover) — this is the operational decision layer of the
//      closed loop;
//   2. run a single capability execution with a bounded retry budget and backoff
//      (executeWithBudget) — used by the scheduler at execution time.
//
// The engine never loops on its own; the runtime owns the loop and the budget so
// the closed loop always terminates.

// Diagnosis category (uppercase, from TroubleshootingEngine) -> recovery action
// (lowercase, understood by the runtime's handleTaskFailure switch).
const CATEGORY_TO_ACTION = {
  PERMISSION: "request_permission",
  DEPENDENCY: "replan",
  TIMEOUT: "retry_with_backoff",
  VERIFICATION_FAILURE: "replan",
  RESOURCE_UNAVAILABLE: "replan",
  APPLICATION_STATE_MISMATCH: "replan",
  ENVIRONMENT: "replan",
  NETWORK: "retry_with_backoff",
  UNSUPPORTED_CAPABILITY: "abort",
  UNEXPECTED: "replan"
};

export const DEFAULT_RECOVERY_BUDGET = 6;

export function createRecoveryBudget(budget = {}) {
  return {
    total: Math.max(0, Number(budget.total ?? DEFAULT_RECOVERY_BUDGET)),
    spent: Math.max(0, Number(budget.spent ?? budget.used ?? 0)),
    attempts: Array.isArray(budget.attempts) ? [...budget.attempts] : []
  };
}

export class RecoveryEngine {
  // Decide the next recovery action.
  //   input: { diagnosis, budget: { total, spent, attempts }, replanAttempts, maxReplanAttempts }
  //   returns: { action, reason, budget }
  // The budget is always returned (updated) so the caller can persist it.
  recover({
    diagnosis,
    budget,
    replanAttempts = 0,
    maxReplanAttempts = 2,
    failureFingerprint = null,
    stateFingerprint = null
  } = {}) {
    const currentBudget = createRecoveryBudget(budget);
    const category = diagnosis?.category ?? diagnosis?.failureClass ?? "UNEXPECTED";
    const remaining = currentBudget.total - currentBudget.spent;

    const record = (action, reason, consumes = true) => {
      if (consumes) {
        currentBudget.spent += 1;
        currentBudget.attempts.push({
          action,
          category,
          failureFingerprint,
          stateFingerprint,
          at: new Date().toISOString()
        });
      }
      return { action, reason, category, budget: currentBudget };
    };

    // Budget exhausted -> stop looping. Roll back if possible (handled by the
    // runtime), otherwise abort.
    if (remaining <= 0) {
      return record("rollback", "Recovery budget exhausted; stopping.", false);
    }

    // Non-recoverable: unsupported capability. No point spending budget.
    if (category === "UNSUPPORTED_CAPABILITY") {
      return record("abort", "Capability is unsupported; no recovery possible.", false);
    }

    // Permission failures need an explicit approval from the user; surface it
    // rather than looping.
    if (category === "PERMISSION") {
      return record("request_permission", "Failure requires explicit or elevated permission.");
    }

    // If we've already replanned the maximum number of times, stop.
    const preferredAction = CATEGORY_TO_ACTION[category] ?? "replan";
    if ((preferredAction === "replan") && replanAttempts >= maxReplanAttempts) {
      return record("rollback", "Maximum replan attempts reached.", false);
    }

    const duplicate = currentBudget.attempts.some((attempt) =>
      attempt.action === preferredAction
      && attempt.failureFingerprint === failureFingerprint
      && attempt.stateFingerprint === stateFingerprint
    );
    if (duplicate && failureFingerprint && stateFingerprint) {
      return {
        action: "abort",
        reason: "Identical recovery rejected because no relevant state changed.",
        category: "IDENTICAL_RECOVERY_REJECTED",
        budget: currentBudget
      };
    }

    return record(
      preferredAction,
      diagnosis?.rootCause ? `Recovering (${category}): ${diagnosis.rootCause}` : `Recovering from ${category}.`
    );
  }

  // Execution-time bounded retry with backoff. `task.action.retryPolicy`
  // provides { maxAttempts, backoffMs }.
  async executeWithBudget(task, operation) {
    const policy = task.action?.retryPolicy ?? {};
    const maxAttempts = Math.max(1, Number(policy.maxAttempts ?? 1));
    const backoffMs = Math.max(0, Number(policy.backoffMs ?? 0));
    const errors = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const output = await operation(attempt);
        return { success: true, attempt, output, errors };
      } catch (error) {
        errors.push({
          attempt,
          message: error instanceof Error ? error.message : String(error)
        });
        if (attempt < maxAttempts && backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
      }
    }

    return { success: false, attempt: maxAttempts, output: null, errors };
  }

  suggestCommandFallbacks(action, executionOutput) {
    if (action.actionType !== "CommandExecutionAction") {
      return [];
    }
    const stderr = executionOutput?.stderr ?? "";
    if (/npm\s+ERR|not found|ENOENT/i.test(stderr)) {
      return [
        { ...action, parameters: { ...action.parameters, command: "pnpm", args: action.parameters.args } },
        { ...action, parameters: { ...action.parameters, command: "yarn", args: action.parameters.args } }
      ];
    }
    return [];
  }
}
