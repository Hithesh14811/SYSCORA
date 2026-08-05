// GoalVerifier
//
// Task completion is not the same as goal completion. The scheduler tells us
// whether individual tasks executed and verified; the GoalVerifier decides
// whether the USER'S GOAL was actually achieved. It weighs multiple independent
// sources of evidence and JUSTIFIES its conclusion with that evidence:
//
//   - declared success criteria (intent.successCriteria)
//   - per-task verification outcomes (VERIFIED / PARTIALLY_VERIFIED / FAILED / …)
//   - the scheduler's terminal status (current state after any recovery/replan)
//   - observation evidence, including detected changes (expected mutations) and
//     changes that were NOT expected by any task (unexpected mutations)
//   - the semantic world-state snapshot
//   - explicit warnings (partial verifications, timeouts, recovered failures)
//
// It returns one of:
//   COMPLETED, COMPLETED_WITH_WARNINGS, PARTIALLY_COMPLETED, FAILED, INCONCLUSIVE

import { assessPlanGoalCoverage } from "../../planner/src/index.js";
import { assessGoalContractEvidence } from "../../shared-types/src/goal-contract.js";

export const GoalStatus = Object.freeze({
  COMPLETED: "COMPLETED",
  COMPLETED_WITH_WARNINGS: "COMPLETED_WITH_WARNINGS",
  PARTIALLY_COMPLETED: "PARTIALLY_COMPLETED",
  FAILED: "FAILED",
  INCONCLUSIVE: "INCONCLUSIVE"
});

export class GoalVerifier {
  constructor(capabilityRegistry = null) {
    this.capabilityRegistry = capabilityRegistry;
  }

  // input: { intent, plan, taskGraph, schedulerStatus, verifications, observations, semanticState }
  // schedulerStatus: { status: COMPLETED | FAILED | UNCERTAIN | PARTIALLY_COMPLETED } | null
  verify(input = {}) {
    const {
      intent = {},
      taskGraph = null,
      taskResults = [],
      verifications = [],
      schedulerStatus = null,
      observations = [],
      semanticState = []
    } = input;

    const timestamp = new Date().toISOString();
    const evidence = [];
    const warnings = [];

    // 1. Aggregate task-level verification signal.
    const total = verifications.length;
    const verified = verifications.filter((v) => v && v.status === "VERIFIED").length;
    const fullyVerified = verifications.filter((v) => v && v.status === "VERIFIED").length;
    const partiallyVerified = verifications.filter((v) => v && v.status === "PARTIALLY_VERIFIED").length;
    const failed = verifications.filter((v) => v && v.status === "FAILED").length;
    const inconclusive = verifications.filter(
      (v) => v && (v.status === "INCONCLUSIVE" || v.status === "UNCERTAIN")
    ).length;
    const timedOut = verifications.filter((v) => v && (v.category === "TIMEOUT" || v.evidence?.timedOut)).length;

    evidence.push({ kind: "task_verifications", total, verified, fullyVerified, partiallyVerified, failed, inconclusive, timedOut });
    if (partiallyVerified > 0) warnings.push(`${partiallyVerified} task(s) only partially verified.`);
    if (timedOut > 0) warnings.push(`${timedOut} task(s) hit a hard timeout during execution.`);

    // 2. Scheduler terminal status (primary signal: reflects state after recovery).
    if (schedulerStatus?.status) {
      evidence.push({ kind: "scheduler_status", status: schedulerStatus.status });
    }

    // 3. Success criteria.
    const successCriteria = Array.isArray(intent.successCriteria) ? intent.successCriteria : [];
    evidence.push({ kind: "success_criteria", criteria: successCriteria });
    // A structured operation is already bound to an explicit caller-selected
    // capability contract. Semantic text overlap is for untyped natural
    // language plans; applying it to operation ids would reject valid custom
    // capabilities whose human wording differs from their registered name.
    const semanticCoverage = intent.operationProvenance === "EXPLICIT_CONTEXT"
      ? {
          covered: true,
          score: 1,
          matchedTerms: [intent.operation],
          missingTerms: [],
          reason: "structured-operation-bound-to-capability"
        }
      : assessPlanGoalCoverage(intent, taskGraph, this.capabilityRegistry);
    evidence.push({ kind: "semantic_goal_coverage", ...semanticCoverage });
    const goalContract = input.goalContract ?? intent.goalContract ?? null;
    const contractEvidence = goalContract?.enforceable
      ? assessGoalContractEvidence(goalContract, {
          taskGraph,
          taskResults,
          verifications,
          observations
        }, this.capabilityRegistry)
      : null;
    if (contractEvidence) evidence.push({ kind: "goal_contract_evidence", ...contractEvidence });

    // 4. Mutation evidence: expected vs unexpected. Every task may declare
    //    expectedStateChanges; observations report detectedChanges. Changes that
    //    no task expected are "unexpected mutations" and are a warning signal —
    //    the goal may have had side effects the plan didn't intend.
    const expectedChanges = new Set();
    for (const task of taskGraph?.tasks ?? []) {
      for (const change of task.expectedStateChanges ?? []) expectedChanges.add(String(change));
    }
    const detectedChanges = [];
    for (const obs of observations) {
      for (const change of obs?.detectedChanges ?? []) detectedChanges.push(String(change));
    }
    const unexpectedMutations = expectedChanges.size > 0
      ? [...new Set(detectedChanges.filter((c) => !expectedChanges.has(c)))]
      : [];
    evidence.push({
      kind: "mutations",
      expected: [...expectedChanges],
      detected: [...new Set(detectedChanges)],
      unexpected: unexpectedMutations
    });
    if (unexpectedMutations.length > 0) {
      warnings.push(`Unexpected state changes observed: ${unexpectedMutations.join(", ")}.`);
    }

    // 5. Semantic world-state corroboration (best-effort context, not decisive).
    evidence.push({ kind: "semantic_state", entityCount: Array.isArray(semanticState) ? semanticState.length : 0 });

    // 6. Failure evidence: collect messages from failed/inconclusive tasks.
    const failureEvidence = verifications
      .filter((v) => v && v.status !== "VERIFIED")
      .map((v) => v.message)
      .filter(Boolean);
    if (failureEvidence.length > 0) evidence.push({ kind: "failure_evidence", messages: failureEvidence });

    const build = (status, message, confidence) => ({ status, message, confidence, evidence, warnings, timestamp });

    // --- Decision ---------------------------------------------------------
    // The scheduler's terminal status is the authoritative signal for the
    // CURRENT state of every task after recovery. A recovered failure must not
    // drag a genuinely-completed goal down; but partial verifications, unexpected
    // mutations, and timeouts qualify a success as COMPLETED_WITH_WARNINGS.

    if (schedulerStatus?.status === "COMPLETED") {
      // INDEPENDENCE: the scheduler's COMPLETED is a signal, not a verdict. The
      // GoalVerifier corroborates it against its own evidence and may DISAGREE.
      // If the per-task verification record contradicts "every task verified"
      // (a hard failure, an inconclusive task, or fewer verified than total),
      // the goal is NOT reported COMPLETED regardless of scheduler status.
      if (total > 0 && failed > 0) {
        if (verified > 0) {
          return build(
            GoalStatus.PARTIALLY_COMPLETED,
            `Scheduler reported COMPLETED, but goal verification found ${failed} failed task(s): ${failureEvidence.join(" ") || "no detail"}`,
            0.6
          );
        }
        return build(
          GoalStatus.FAILED,
          `Scheduler reported COMPLETED, but every task failed goal verification (${failed}/${total}).`,
          0.85
        );
      }
      if (total > 0 && inconclusive > 0) {
        return build(
          GoalStatus.INCONCLUSIVE,
          `Scheduler reported COMPLETED, but ${inconclusive} task outcome(s) could not be independently confirmed.`,
          0.5
        );
      }
      if (total > 0 && partiallyVerified > 0) {
        return build(
          GoalStatus.INCONCLUSIVE,
          `Scheduler reported COMPLETED, but ${partiallyVerified} task outcome(s) were only partially verified.`,
          0.45
        );
      }
      if (total > 0 && verified < total) {
        return build(
          GoalStatus.PARTIALLY_COMPLETED,
          `Scheduler reported COMPLETED, but only ${verified}/${total} tasks corroborate as verified.`,
          0.6
        );
      }

      if (!semanticCoverage.covered) {
        return build(
          GoalStatus.INCONCLUSIVE,
          `Tasks completed, but their evidence does not establish the original goal. Missing goal terms: ${semanticCoverage.missingTerms.join(", ") || "unknown"}.`,
          0.85
        );
      }

      if (contractEvidence && !contractEvidence.satisfied) {
        const status = contractEvidence.satisfiedCount > 0
          ? GoalStatus.PARTIALLY_COMPLETED
          : GoalStatus.INCONCLUSIVE;
        return build(
          status,
          `Tasks completed, but independent evidence satisfies only ${contractEvidence.satisfiedCount}/${contractEvidence.totalCriteria} original goal criteria. Missing: ${contractEvidence.unsatisfiedCriteria.join("; ") || "unspecified criteria"}.`,
          0.9
        );
      }

      if (warnings.length > 0) {
        return build(
          GoalStatus.COMPLETED_WITH_WARNINGS,
          `Goal achieved: scheduler reports every task verified, with ${warnings.length} warning(s): ${warnings.join(" ")}`,
          0.8
        );
      }
      return build(GoalStatus.COMPLETED, "All success criteria satisfied: scheduler reports every task verified.", 0.95);
    }

    if (schedulerStatus?.status === "PARTIALLY_COMPLETED") {
      return build(GoalStatus.PARTIALLY_COMPLETED, "Some tasks completed but the goal was only partially achieved.", 0.6);
    }

    if (schedulerStatus?.status === "UNCERTAIN") {
      return build(GoalStatus.INCONCLUSIVE, "Scheduler could not confirm the outcome of one or more tasks.", 0.5);
    }

    // No scheduler status: fall back to task-level aggregation.

    // No tasks executed → nothing was done.
    if (total === 0) {
      return build(GoalStatus.INCONCLUSIVE, "No verifiable tasks were executed for this goal.", 0.3);
    }

    // Any hard failure.
    if (failed > 0) {
      if (verified > 0) {
        return build(GoalStatus.PARTIALLY_COMPLETED, `${verified}/${total} tasks verified; ${failed} failed.`, 0.6);
      }
      return build(GoalStatus.FAILED, `All progress failed verification (${failed}/${total} failed).`, 0.9);
    }

    // No failures, but some inconclusive.
    if (inconclusive > 0 && verified < total) {
      return build(GoalStatus.INCONCLUSIVE, `${verified}/${total} tasks verified; ${inconclusive} inconclusive.`, 0.5);
    }

    if (partiallyVerified > 0) {
      return build(
        GoalStatus.INCONCLUSIVE,
        `${verified}/${total} tasks were independently verified; ${partiallyVerified} were only partially verified.`,
        0.45
      );
    }

    // Every task independently verified and scheduler absent/COMPLETED.
    if (verified === total && (!schedulerStatus || schedulerStatus.status === "COMPLETED")) {
      if (warnings.length > 0) {
        return build(
          GoalStatus.COMPLETED_WITH_WARNINGS,
          `Goal achieved with ${warnings.length} warning(s): ${warnings.join(" ")}`,
          0.8
        );
      }
      return build(GoalStatus.COMPLETED, "All success criteria satisfied: every task verified.", 0.95);
    }

    // Fallback: partial.
    return build(GoalStatus.PARTIALLY_COMPLETED, `${verified}/${total} tasks verified.`, 0.6);
  }
}
