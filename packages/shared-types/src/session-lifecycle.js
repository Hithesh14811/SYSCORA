// User-facing session lifecycle.
//
// The runtime has ~27 internal states; a person watching a request needs about
// a dozen. This module is the single projection between them, so every surface
// (desktop shell, CLI, daemon) describes a request the same way and none of them
// re-derive "is it done?" from raw events.
//
// Two rules shape the wording:
//   1. Having run an action is not having achieved the goal. Only verified
//      evidence produces a COMPLETED phase or a "done" headline.
//   2. Nothing is described as happening until execution has actually begun.

export const LifecyclePhase = Object.freeze({
  UNDERSTANDING: "UNDERSTANDING",
  INSPECTING: "INSPECTING",
  PLANNING: "PLANNING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  WORKING: "WORKING",
  VERIFYING: "VERIFYING",
  RECOVERING: "RECOVERING",
  AWAITING_USER_INPUT: "AWAITING_USER_INPUT",
  COMPLETED: "COMPLETED",
  PARTIALLY_COMPLETED: "PARTIALLY_COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMED_OUT: "TIMED_OUT"
});

const STATE_TO_PHASE = Object.freeze({
  RECEIVE_INTENT: LifecyclePhase.UNDERSTANDING,
  AMBIGUOUS_INTENT: LifecyclePhase.AWAITING_USER_INPUT,
  BUILD_CONTEXT: LifecyclePhase.INSPECTING,
  GENERATE_PLAN: LifecyclePhase.PLANNING,
  VALIDATE_PLAN: LifecyclePhase.PLANNING,
  ASSESS_RISK: LifecyclePhase.PLANNING,
  APPLY_POLICY: LifecyclePhase.PLANNING,
  PLAN_REJECTED: LifecyclePhase.FAILED,
  REQUEST_CONFIRMATION_IF_REQUIRED: LifecyclePhase.AWAITING_APPROVAL,
  CLARIFICATION_REQUIRED: LifecyclePhase.AWAITING_USER_INPUT,
  EXECUTE_NEXT_ACTION: LifecyclePhase.WORKING,
  EXECUTING: LifecyclePhase.WORKING,
  OBSERVE_RESULT: LifecyclePhase.VERIFYING,
  VERIFY_RESULT: LifecyclePhase.VERIFYING,
  VERIFY_FINAL_GOAL: LifecyclePhase.VERIFYING,
  UPDATE_SEMANTIC_STATE: LifecyclePhase.VERIFYING,
  UPDATE_MEMORY: LifecyclePhase.VERIFYING,
  GENERATE_RESPONSE: LifecyclePhase.VERIFYING,
  DIAGNOSING: LifecyclePhase.RECOVERING,
  RECOVERING: LifecyclePhase.RECOVERING,
  ROLLING_BACK: LifecyclePhase.RECOVERING,
  ROLLED_BACK: LifecyclePhase.FAILED,
  PAUSED: LifecyclePhase.AWAITING_USER_INPUT,
  CANCELLED: LifecyclePhase.CANCELLED,
  TIMED_OUT: LifecyclePhase.TIMED_OUT,
  COMPLETED: LifecyclePhase.COMPLETED,
  FAILED: LifecyclePhase.FAILED
});

// Phases after which nothing further will happen without a new request.
const TERMINAL_PHASES = new Set([
  LifecyclePhase.COMPLETED,
  LifecyclePhase.PARTIALLY_COMPLETED,
  LifecyclePhase.FAILED,
  LifecyclePhase.CANCELLED,
  LifecyclePhase.TIMED_OUT
]);

// Phases at which the request has begun changing something.
const EXECUTION_STARTED_PHASES = new Set([
  LifecyclePhase.WORKING,
  LifecyclePhase.VERIFYING,
  LifecyclePhase.RECOVERING
]);

const HEADLINES = Object.freeze({
  [LifecyclePhase.UNDERSTANDING]: "Reading your request.",
  [LifecyclePhase.INSPECTING]: "Looking at the current state of your computer.",
  [LifecyclePhase.PLANNING]: "Working out the steps this will take.",
  [LifecyclePhase.AWAITING_APPROVAL]: "Waiting for your approval before making changes.",
  [LifecyclePhase.WORKING]: "Carrying out the steps.",
  [LifecyclePhase.VERIFYING]: "Checking the result against what you asked for.",
  [LifecyclePhase.RECOVERING]: "The last step did not work; trying a different approach.",
  [LifecyclePhase.AWAITING_USER_INPUT]: "Waiting for something only you can do.",
  [LifecyclePhase.COMPLETED]: "Finished — everything you asked for was confirmed.",
  [LifecyclePhase.PARTIALLY_COMPLETED]: "Finished part of this. Some of what you asked for was not confirmed.",
  [LifecyclePhase.FAILED]: "This did not work, and nothing further was attempted.",
  [LifecyclePhase.CANCELLED]: "Cancelled.",
  [LifecyclePhase.TIMED_OUT]: "Stopped because it ran past its time limit."
});

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

// A step description a person can read. Capability identifiers are internal and
// never surface here.
function currentStepDescription(session) {
  const tasks = session?.plan?.taskGraph?.tasks ?? [];
  const current = tasks.find((task) => task.goal || task.description);
  return current?.goal ?? current?.description ?? null;
}

export function projectSessionLifecycle(session, { developerMode = false } = {}) {
  const final = session?.finalResponse ?? null;
  const coverage = final?.evidenceCoverage ?? null;
  const outcome = final?.outcome ?? null;

  // The declared final status refines a terminal internal state: a session that
  // reached COMPLETED internally may still only be partially verified, and one
  // marked FAILED may simply be inconclusive.
  let phase = STATE_TO_PHASE[session?.currentState] ?? LifecyclePhase.UNDERSTANDING;
  if (TERMINAL_PHASES.has(phase) || final?.status) {
    if (final?.status === "PARTIALLY_COMPLETED") phase = LifecyclePhase.PARTIALLY_COMPLETED;
    else if (final?.status === "INCONCLUSIVE") phase = LifecyclePhase.PARTIALLY_COMPLETED;
    else if (final?.status === "COMPLETED") phase = LifecyclePhase.COMPLETED;
    else if (final?.status === "AWAITING_APPROVAL") phase = LifecyclePhase.AWAITING_APPROVAL;
    else if (final?.status === "NEEDS_CLARIFICATION") phase = LifecyclePhase.AWAITING_USER_INPUT;
  }
  // Completion is a claim about evidence, not about having reached the end of
  // the pipeline. Unverified criteria demote it.
  const verifiedCompletion = phase === LifecyclePhase.COMPLETED
    && (coverage ? coverage.satisfied === true : true);
  if (phase === LifecyclePhase.COMPLETED && !verifiedCompletion) {
    phase = LifecyclePhase.PARTIALLY_COMPLETED;
  }
  // An inconclusive result with nothing verified is a plain failure to achieve
  // the goal, not a partial success.
  if (phase === LifecyclePhase.PARTIALLY_COMPLETED && coverage && coverage.satisfiedCount === 0) {
    phase = LifecyclePhase.FAILED;
  }

  const terminal = TERMINAL_PHASES.has(phase);
  const notCompleted = list(outcome?.notCompleted).length > 0
    ? list(outcome.notCompleted)
    : list(coverage?.unsatisfiedCriteria);

  return {
    phase,
    terminal,
    executionStarted: EXECUTION_STARTED_PHASES.has(phase) || terminal,
    verifiedCompletion,
    headline: HEADLINES[phase],
    detail: final?.message ?? null,
    currentStep: terminal ? null : currentStepDescription(session),
    completed: list(outcome?.completed),
    notCompleted,
    changed: list(outcome?.changed),
    uncertain: list(outcome?.uncertain),
    userActionNeeded: outcome?.userActionNeeded ?? final?.reason ?? null,
    approvalScope: list(session?.approval?.scope),
    approvalChanges: list(session?.approval?.changes),
    progress: {
      verified: coverage?.satisfiedCount ?? 0,
      total: coverage?.totalCriteria ?? 0
    },
    canCancel: !terminal,
    canResume: session?.currentState === "PAUSED",
    // Capability identifiers, event types and task ids live here and nowhere
    // else, so the normal view stays readable.
    diagnostics: developerMode
      ? {
          internalState: session?.currentState ?? null,
          capabilities: (session?.plan?.taskGraph?.tasks ?? []).map((task) => task.capability).filter(Boolean),
          eventTypes: (session?.events ?? []).map((event) => event.eventType).filter(Boolean)
        }
      : null
  };
}
