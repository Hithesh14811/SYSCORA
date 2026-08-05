import test from "node:test";
import assert from "node:assert/strict";

import { assessGoalContractEvidence, createGoalContract } from "../../packages/shared-types/src/goal-contract.js";
import {
  appendEvidence,
  createEvidenceLedger,
  evaluateEvidenceLedger
} from "../../packages/shared-types/src/evidence-ledger.js";
import { GoalVerifier, GoalStatus } from "../../packages/agent-runtime/src/goal-verifier.js";
import { redactSensitiveData } from "../../packages/shared-types/src/redaction.js";

test("goal contracts are deeply immutable and preserve independent negative constraints", () => {
  const contract = createGoalContract({
    rawText: "Find the cheapest flight, but do not book. Only show results and ask before sending anything.",
    successCriteria: ["Sourced flight options are compared"],
    constraints: ["Do not book", "Only show results", "Ask before sending"]
  });
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.criteria), true);
  assert.ok(contract.criteria.some((criterion) => criterion.kind === "PROHIBITION" && /book/i.test(criterion.description)));
  assert.ok(contract.criteria.some((criterion) => criterion.kind === "CONSTRAINT" && /only show/i.test(criterion.description)));
  assert.throws(() => { contract.criteria[0].description = "changed"; }, TypeError);
});

test("verified action output alone cannot satisfy the evidence ledger", () => {
  const contract = { criteria: [{ criterionId: "c1", description: "File contains the requested value", required: true }] };
  const ledger = createEvidenceLedger();
  appendEvidence(ledger, {
    criterionIds: ["c1"],
    verification: { status: "VERIFIED" },
    observation: { structuredState: { contents: "expected" } },
    source: "filesystem.write",
    verificationMethod: "ACTION_RESULT",
    confidence: 1,
    independentFromActionResult: false
  });
  const evaluation = evaluateEvidenceLedger(contract, ledger);
  assert.equal(evaluation.satisfied, false);
  assert.equal(evaluation.criteria[0].rejectionReasons[0], "NOT_INDEPENDENT");
});

test("complete evidence records provenance, identity, time, confidence and independent verification", () => {
  const contract = { criteria: [{ criterionId: "c1", description: "Playback is active", required: true }] };
  const ledger = createEvidenceLedger();
  appendEvidence(ledger, {
    criterionIds: ["c1"],
    capability: "media.nowPlaying.inspect",
    verification: { status: "VERIFIED", evidence: { state: "playing" } },
    observation: { observationId: "obs-1", structuredState: { state: "playing" } },
    value: "playing",
    source: "OS_MEDIA_SESSION",
    verificationMethod: "MEDIA_SESSION_INSPECTION",
    identity: { application: "Example Player", windowId: "window-4" },
    confidence: 0.98,
    independentFromActionResult: true,
    timestamp: "2026-08-05T00:00:00.000Z"
  });
  const evaluation = evaluateEvidenceLedger(contract, ledger);
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.criteria[0].evidenceIds.length, 1);
  const persisted = redactSensitiveData(ledger);
  assert.equal(persisted.entries[0].value, "***REDACTED***");
  assert.match(persisted.entries[0].contentFingerprint, /^[a-f0-9]{64}$/);
});

test("goal completion is gated by the authoritative evidence ledger", () => {
  const contract = {
    enforceable: true,
    criteria: [
      { criterionId: "c1", description: "Playback is active", required: true },
      { criterionId: "c2", description: "Queued track is present", required: true }
    ]
  };
  const ledger = createEvidenceLedger();
  appendEvidence(ledger, {
    criterionIds: ["c1"], verification: { status: "VERIFIED" }, observation: { state: "playing" },
    source: "OS_MEDIA_SESSION", verificationMethod: "MEDIA_SESSION_INSPECTION",
    confidence: 1, independentFromActionResult: true
  });
  const result = new GoalVerifier().verify({
    intent: {
      operation: "media.play",
      operationProvenance: "EXPLICIT_CONTEXT",
      successCriteria: contract.criteria.map((criterion) => criterion.description),
      goalContract: contract
    },
    goalContract: contract,
    evidenceLedger: ledger,
    schedulerStatus: { status: "COMPLETED" },
    verifications: [{ status: "VERIFIED" }],
    observations: [{ detectedChanges: [] }]
  });
  assert.equal(result.status, GoalStatus.PARTIALLY_COMPLETED);
  assert.match(result.message, /1\/2/);
});

test("negative, modality and confirmation constraints are verified from the execution audit", () => {
  const registry = {
    get(name) {
      return { permissionModel: { type: name === "browser.research" ? "READ" : "WRITE" } };
    }
  };
  const noBooking = createGoalContract({ rawText: "Find a flight. Do not book.", successCriteria: ["Flight options found"] });
  const bookingAudit = assessGoalContractEvidence(noBooking, {
    taskGraph: { tasks: [{ capability: "browser.booking.submit", goal: "Book flight" }] },
    observations: []
  }, registry);
  assert.equal(bookingAudit.criteria.find((criterion) => /do not book/i.test(criterion.description)).satisfied, false);

  const desktop = createGoalContract({ rawText: "Play a track. Use the desktop app.", successCriteria: ["Track is playing"] });
  const browserAudit = assessGoalContractEvidence(desktop, {
    taskGraph: { tasks: [{ capability: "browser.media.play" }] }, observations: []
  }, registry);
  assert.equal(browserAudit.criteria.find((criterion) => /desktop app/i.test(criterion.description)).satisfied, false);

  const confirm = createGoalContract({ rawText: "Send the form. Ask before sending.", successCriteria: ["Form is sent"] });
  const unapproved = assessGoalContractEvidence(confirm, {
    taskGraph: { tasks: [{ capability: "browser.form.submit" }] }, observations: [], approvalGranted: false
  }, registry);
  const approved = assessGoalContractEvidence(confirm, {
    taskGraph: { tasks: [{ capability: "browser.form.submit" }] }, observations: [], approvalGranted: true
  }, registry);
  assert.equal(unapproved.criteria.find((criterion) => /ask before/i.test(criterion.description)).satisfied, false);
  assert.equal(approved.criteria.find((criterion) => /ask before/i.test(criterion.description)).satisfied, true);
});
