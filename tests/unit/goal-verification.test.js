import test from "node:test";
import assert from "node:assert/strict";
import { GoalVerifier, GoalStatus } from "../../packages/agent-runtime/src/goal-verifier.js";

const verifier = new GoalVerifier();

test("goal is COMPLETED when scheduler completed and no warnings", () => {
  const result = verifier.verify({
    intent: { successCriteria: ["done"] },
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED" }],
    observations: [{ detectedChanges: [] }]
  });
  assert.equal(result.status, GoalStatus.COMPLETED);
  assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0, "conclusion is justified with evidence");
});

test("goal is INCONCLUSIVE on partial verification", () => {
  const result = verifier.verify({
    intent: { successCriteria: ["done"] },
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED" }, { status: "PARTIALLY_VERIFIED" }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.INCONCLUSIVE);
  assert.ok(result.warnings.length > 0, "warnings explain the qualification");
});

test("goal is COMPLETED_WITH_WARNINGS on a hard timeout signal", () => {
  const result = verifier.verify({
    intent: {},
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED", category: "TIMEOUT", evidence: { timedOut: true } }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.COMPLETED_WITH_WARNINGS);
  assert.ok(result.warnings.some((w) => /timeout/i.test(w)));
});

test("unexpected mutations qualify an otherwise-complete goal", () => {
  const result = verifier.verify({
    intent: {},
    schedulerStatus: { status: "COMPLETED" },
    taskGraph: { tasks: [{ taskId: "t1", expectedStateChanges: ["env.file"] }] },
    verifications: [{ status: "VERIFIED" }],
    observations: [{ detectedChanges: ["env.file", "registry.hive"] }]
  });
  assert.equal(result.status, GoalStatus.COMPLETED_WITH_WARNINGS);
  const mutationEvidence = result.evidence.find((e) => e.kind === "mutations");
  assert.deepEqual(mutationEvidence.unexpected, ["registry.hive"]);
});

test("no executed tasks is INCONCLUSIVE, never a silent success", () => {
  const result = verifier.verify({ intent: {}, schedulerStatus: null, verifications: [], observations: [] });
  assert.equal(result.status, GoalStatus.INCONCLUSIVE);
});

test("all-failed is FAILED", () => {
  const result = verifier.verify({
    intent: {},
    schedulerStatus: { status: "FAILED" },
    verifications: [{ status: "FAILED", message: "boom" }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.FAILED);
});

// --- Independence from the scheduler's terminal status ---------------------
// The GoalVerifier is an independent judge, not a mirror of scheduler state. It
// must be able to DISAGREE when its own evidence contradicts a COMPLETED status.

test("disagrees with scheduler COMPLETED when a task actually failed (PARTIAL)", () => {
  const result = verifier.verify({
    intent: { successCriteria: ["done"] },
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED" }, { status: "FAILED", message: "config not written" }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.PARTIALLY_COMPLETED);
  assert.match(result.message, /COMPLETED, but/);
});

test("disagrees with scheduler COMPLETED when every task failed (FAILED)", () => {
  const result = verifier.verify({
    intent: {},
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "FAILED", message: "boom" }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.FAILED);
});

test("disagrees with scheduler COMPLETED when an outcome is inconclusive", () => {
  const result = verifier.verify({
    intent: {},
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED" }, { status: "INCONCLUSIVE", message: "could not confirm" }],
    observations: []
  });
  assert.equal(result.status, GoalStatus.INCONCLUSIVE);
  assert.match(result.message, /could not be independently confirmed/);
});
