import test from "node:test";
import assert from "node:assert/strict";
import {
  LifecyclePhase,
  projectSessionLifecycle
} from "../../packages/shared-types/src/session-lifecycle.js";

function session(overrides = {}) {
  return { sessionId: "s1", currentState: "RECEIVE_INTENT", events: [], ...overrides };
}

test("every internal runtime state maps to exactly one user-visible phase", () => {
  const internalStates = [
    "RECEIVE_INTENT", "BUILD_CONTEXT", "GENERATE_PLAN", "ASSESS_RISK", "APPLY_POLICY",
    "REQUEST_CONFIRMATION_IF_REQUIRED", "EXECUTE_NEXT_ACTION", "OBSERVE_RESULT", "VERIFY_RESULT",
    "UPDATE_SEMANTIC_STATE", "UPDATE_MEMORY", "VERIFY_FINAL_GOAL", "GENERATE_RESPONSE",
    "PAUSED", "CANCELLED", "TIMED_OUT", "COMPLETED", "FAILED", "ROLLED_BACK",
    "CLARIFICATION_REQUIRED", "AMBIGUOUS_INTENT", "VALIDATE_PLAN", "PLAN_REJECTED",
    "EXECUTING", "DIAGNOSING", "RECOVERING", "ROLLING_BACK"
  ];
  for (const currentState of internalStates) {
    const view = projectSessionLifecycle(session({ currentState }));
    assert.ok(Object.values(LifecyclePhase).includes(view.phase), `${currentState} -> ${view.phase}`);
    assert.ok(view.headline, `${currentState} needs a headline`);
  }
});

test("the pre-execution phases never claim anything is happening yet", () => {
  for (const currentState of ["RECEIVE_INTENT", "BUILD_CONTEXT", "GENERATE_PLAN", "ASSESS_RISK", "VALIDATE_PLAN"]) {
    const view = projectSessionLifecycle(session({ currentState }));
    assert.equal(view.executionStarted, false, currentState);
    assert.doesNotMatch(view.headline, /\bright now\b|\bdone\b|\bcompleted\b/i, currentState);
  }
});

test("awaiting approval states what the approval covers and offers cancel", () => {
  const view = projectSessionLifecycle(session({
    currentState: "REQUEST_CONFIRMATION_IF_REQUIRED",
    finalResponse: { status: "AWAITING_APPROVAL" },
    approval: {
      scope: ["Install Acme Notes from winget"],
      risk: "MEDIUM",
      changes: ["Installs Acme Notes 3.1.0 by Acme Inc."]
    }
  }));
  assert.equal(view.phase, LifecyclePhase.AWAITING_APPROVAL);
  assert.deepEqual(view.approvalScope, ["Install Acme Notes from winget"]);
  assert.equal(view.canCancel, true);
  assert.equal(view.terminal, false);
});

test("actions having run is not reported as the goal being done", () => {
  const view = projectSessionLifecycle(session({
    currentState: "FAILED",
    finalResponse: {
      status: "INCONCLUSIVE",
      message: "Interactive actions finished, but independent evidence satisfies only 0/2 goal criteria.",
      evidenceCoverage: {
        satisfied: false,
        satisfiedCount: 0,
        totalCriteria: 2,
        unsatisfiedCriteria: ["Spotify is playing Good For You", "Billie Jean is in the queue"]
      }
    }
  }));
  assert.notEqual(view.phase, LifecyclePhase.COMPLETED);
  assert.equal(view.verifiedCompletion, false);
  assert.deepEqual(view.notCompleted, ["Spotify is playing Good For You", "Billie Jean is in the queue"]);
  assert.doesNotMatch(view.headline, /\bdone\b/i);
});

test("partial completion reads differently from completion", () => {
  const partial = projectSessionLifecycle(session({
    currentState: "COMPLETED",
    finalResponse: {
      status: "PARTIALLY_COMPLETED",
      evidenceCoverage: { satisfied: false, satisfiedCount: 1, totalCriteria: 2, unsatisfiedCriteria: ["Billie Jean is in the queue"] },
      outcome: { completed: ["Spotify is playing Good For You"], notCompleted: ["Billie Jean is in the queue"], changed: [], uncertain: [], userActionNeeded: null }
    }
  }));
  const complete = projectSessionLifecycle(session({
    currentState: "COMPLETED",
    finalResponse: {
      status: "COMPLETED",
      evidenceCoverage: { satisfied: true, satisfiedCount: 2, totalCriteria: 2, unsatisfiedCriteria: [] },
      outcome: { completed: ["a", "b"], notCompleted: [], changed: [], uncertain: [], userActionNeeded: null }
    }
  }));
  assert.equal(partial.phase, LifecyclePhase.PARTIALLY_COMPLETED);
  assert.equal(complete.phase, LifecyclePhase.COMPLETED);
  assert.notEqual(partial.headline, complete.headline);
  assert.equal(complete.verifiedCompletion, true);
  assert.equal(partial.verifiedCompletion, false);
  assert.equal(complete.progress.verified, 2);
  assert.equal(complete.progress.total, 2);
});

test("terminal phases are marked terminal and non-terminal phases are not", () => {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "ROLLED_BACK"];
  for (const currentState of terminal) {
    assert.equal(projectSessionLifecycle(session({ currentState })).terminal, true, currentState);
  }
  for (const currentState of ["EXECUTING", "RECOVERING", "GENERATE_PLAN", "REQUEST_CONFIRMATION_IF_REQUIRED"]) {
    assert.equal(projectSessionLifecycle(session({ currentState })).terminal, false, currentState);
  }
});

test("a paused session can be resumed and a running one can be cancelled", () => {
  const paused = projectSessionLifecycle(session({ currentState: "PAUSED" }));
  assert.equal(paused.canResume, true);
  assert.equal(paused.canCancel, true);

  const running = projectSessionLifecycle(session({ currentState: "EXECUTING" }));
  assert.equal(running.canCancel, true);
  assert.equal(running.canResume, false);

  const finished = projectSessionLifecycle(session({ currentState: "COMPLETED" }));
  assert.equal(finished.canCancel, false);
  assert.equal(finished.canResume, false);
});

test("a request needing the user says exactly what is needed", () => {
  const view = projectSessionLifecycle(session({
    currentState: "CLARIFICATION_REQUIRED",
    finalResponse: { status: "NEEDS_CLARIFICATION", reason: "Sign in to the site to continue." }
  }));
  assert.equal(view.phase, LifecyclePhase.AWAITING_USER_INPUT);
  assert.equal(view.userActionNeeded, "Sign in to the site to continue.");
});

test("the user-facing view never leaks capability names or raw event noise", () => {
  const view = projectSessionLifecycle(session({
    currentState: "EXECUTING",
    plan: { taskGraph: { tasks: [{ capability: "ui.action", goal: "Type the search query" }] } },
    events: [
      { eventType: "EVIDENCE_RECORDED", details: { evidenceId: "e1" } },
      { eventType: "TASK_EXECUTED", details: { taskId: "t1" } }
    ]
  }));
  const rendered = JSON.stringify(view);
  assert.doesNotMatch(rendered, /ui\.action|EVIDENCE_RECORDED|TASK_EXECUTED|taskId/);
  assert.match(view.currentStep ?? "", /search query/i);
});

test("developer detail is available but only when explicitly requested", () => {
  const built = session({
    currentState: "EXECUTING",
    plan: { taskGraph: { tasks: [{ capability: "ui.action", goal: "Type the search query" }] } },
    events: [{ eventType: "TASK_EXECUTED", details: { taskId: "t1" } }]
  });
  const developer = projectSessionLifecycle(built, { developerMode: true });
  assert.ok(developer.diagnostics);
  assert.deepEqual(developer.diagnostics.capabilities, ["ui.action"]);
  assert.equal(projectSessionLifecycle(built).diagnostics, null);
});

test("the same phase projected twice is identical, so one request yields one stream", () => {
  const built = session({ currentState: "EXECUTING", plan: { taskGraph: { tasks: [{ capability: "x", goal: "Do the thing" }] } } });
  assert.deepEqual(projectSessionLifecycle(built), projectSessionLifecycle(built));
});
