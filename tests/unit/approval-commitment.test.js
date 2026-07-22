// M2.1 Part H — cryptographic approval-commitment adversarial suite.
//
// Proves the ApprovalManifest commitment is an EXACT, cryptographic binding to
// the security-material meaning of a plan. Every test is an attack: a way to
// change WHAT runs / WHERE / WITH WHAT args / IN WHAT order / WITH WHAT
// privilege|permissions|rollback while keeping the SAME approval — and asserts
// the commitment changes (or, for the redaction/secret cases, that a distinct
// secret cannot collapse behind the redaction marker).

import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";

import {
  buildApprovalManifest,
  canonicalize,
  APPROVAL_MANIFEST_VERSION
} from "../../packages/permission-broker/src/approval-manifest.js";
import { REDACTED } from "../../packages/shared-types/src/redaction.js";

const KEY = crypto.createHash("sha256").update("test-installation-key").digest();

function plan(tasks) {
  return { taskGraph: { tasks } };
}
function task(overrides = {}) {
  return {
    taskId: overrides.taskId ?? "t1",
    capability: overrides.capability ?? "environment.project.set",
    inputs: overrides.inputs ?? { workspacePath: "/ws", key: "FLAG", value: "1" },
    dependencies: overrides.dependencies ?? [],
    requirements: overrides.requirements ?? { permissions: ["filesystem.write"], elevation: "NONE" },
    rollbackRequired: overrides.rollbackRequired,
    reversibility: overrides.reversibility,
    capabilityVersion: overrides.capabilityVersion
  };
}

function commit(p, opts = {}) {
  return buildApprovalManifest(p, { key: KEY, ...opts }).commitment;
}

// --- canonicalization ---------------------------------------------------------

test("canonicalize is object-key-order independent", () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});

test("canonicalize preserves array order (order is semantically meaningful)", () => {
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
});

test("canonicalize distinguishes null from undefined from absent", () => {
  assert.notEqual(canonicalize({ a: null }), canonicalize({ a: undefined }));
  assert.notEqual(canonicalize({ a: null }), canonicalize({}));
});

test("commitment is a 64-hex SHA-256 and carries the manifest version", () => {
  const built = buildApprovalManifest(plan([task()]), { key: KEY });
  assert.match(built.commitment, /^[0-9a-f]{64}$/);
  assert.equal(built.version, APPROVAL_MANIFEST_VERSION);
});

// --- scenario 1: same plan -> same commitment (restart stability) -------------

test("1. identical plan yields identical commitment (stable across restart)", () => {
  assert.equal(commit(plan([task()])), commit(plan([task()])));
});

// --- scenario 2: different normal input --------------------------------------

test("2. a different non-secret input changes the commitment", () => {
  const a = commit(plan([task({ inputs: { workspacePath: "/ws", key: "FLAG_A", value: "1" } })]));
  const b = commit(plan([task({ inputs: { workspacePath: "/ws", key: "FLAG_B", value: "1" } })]));
  assert.notEqual(a, b);
});

// --- scenario 3: different SECRET value, no plaintext ------------------------

test("3. distinct secret values yield distinct commitments (no plaintext, no redaction collapse)", () => {
  const one = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "secret-one" } })]), { key: KEY });
  const two = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "secret-two" } })]), { key: KEY });
  assert.notEqual(one.commitment, two.commitment);
  // And no plaintext secret leaks into the manifest anywhere. (The sealed
  // commitment lists the field PATH, e.g. "value", which is not the secret; what
  // must never appear is the plaintext itself.)
  const serialized = JSON.stringify(one.manifest);
  assert.equal(serialized.includes("secret-one"), false);
  // The retained (scrubbed) inputs must not carry the secret value itself.
  const scrubbedInputs = JSON.stringify(one.manifest.tasks[0].inputs);
  assert.equal(scrubbedInputs.includes("secret-one"), false);
  assert.equal("value" in one.manifest.tasks[0].inputs, false, "secret field omitted from retained inputs");
});

test("3b. two DISTINCT redacted secrets do NOT collapse to the same commitment via the OLD weak path", () => {
  // The previous weak signature redacted BEFORE hashing, so value:"one" and
  // value:"two" both became ***REDACTED*** -> identical. Here, distinct live
  // secrets commit distinctly (scenario 3). A redacted-only reload reuses the
  // prior commitment ONLY when a prior manifest is supplied (legitimate
  // round-trip) — never collapses two different live secrets.
  const a = buildApprovalManifest(plan([task({ inputs: { key: "K", value: "aaa" } })]), { key: KEY });
  const b = buildApprovalManifest(plan([task({ inputs: { key: "K", value: "bbb" } })]), { key: KEY });
  assert.notEqual(a.commitment, b.commitment);
});

// --- scenario 4: dependency-only mutation ------------------------------------

test("4. a dependency-only change changes the commitment", () => {
  const a = commit(plan([task({ taskId: "t1" }), task({ taskId: "t2", dependencies: [] })]));
  const b = commit(plan([task({ taskId: "t1" }), task({ taskId: "t2", dependencies: ["t1"] })]));
  assert.notEqual(a, b);
});

// --- scenario 5/6: task addition / removal -----------------------------------

test("5. adding a task changes the commitment", () => {
  const a = commit(plan([task({ taskId: "t1" })]));
  const b = commit(plan([task({ taskId: "t1" }), task({ taskId: "t2", capability: "filesystem.read" })]));
  assert.notEqual(a, b);
});

test("6. removing a task changes the commitment", () => {
  const a = commit(plan([task({ taskId: "t1" }), task({ taskId: "t2", capability: "filesystem.read" })]));
  const b = commit(plan([task({ taskId: "t1" })]));
  assert.notEqual(a, b);
});

// --- scenario 7: capability / version mutation -------------------------------

test("7a. changing the capability changes the commitment", () => {
  const a = commit(plan([task({ capability: "environment.project.set" })]));
  const b = commit(plan([task({ capability: "service.restart" })]));
  assert.notEqual(a, b);
});

test("7b. changing the capability VERSION changes the commitment", () => {
  const resolveA = () => "1.0.0";
  const resolveB = () => "2.0.0";
  const a = buildApprovalManifest(plan([task()]), { key: KEY, resolveVersion: resolveA });
  const b = buildApprovalManifest(plan([task()]), { key: KEY, resolveVersion: resolveB });
  assert.notEqual(a.commitment, b.commitment);
});

// --- scenario 8: permission / elevation / rollback mutation ------------------

test("8a. changing required permissions changes the commitment", () => {
  const a = commit(plan([task({ requirements: { permissions: ["filesystem.read"], elevation: "NONE" } })]));
  const b = commit(plan([task({ requirements: { permissions: ["filesystem.write"], elevation: "NONE" } })]));
  assert.notEqual(a, b);
});

test("8b. changing the elevation requirement changes the commitment", () => {
  const a = commit(plan([task({ requirements: { permissions: ["p"], elevation: "NONE" } })]));
  const b = commit(plan([task({ requirements: { permissions: ["p"], elevation: "ADMIN" } })]));
  assert.notEqual(a, b);
});

test("8c. changing the rollback requirement changes the commitment", () => {
  const a = commit(plan([task({ reversibility: "NOT_REQUIRED" })]));
  const b = commit(plan([task({ reversibility: "ROLLBACK_SUPPORTED" })]));
  assert.notEqual(a, b);
});

// --- scenario 9: object-key ordering does not create false differences -------

test("9. reordering keys within inputs does NOT change the commitment", () => {
  const a = commit(plan([task({ inputs: { workspacePath: "/ws", key: "K", extra: "x" } })]));
  const b = commit(plan([task({ inputs: { extra: "x", key: "K", workspacePath: "/ws" } })]));
  assert.equal(a, b);
});

// --- scenario 10: task REORDER is caught (old weak hash ignored order) --------

test("10. reordering tasks changes the commitment (taskOrder is committed)", () => {
  const a = commit(plan([task({ taskId: "t1" }), task({ taskId: "t2", capability: "filesystem.read" })]));
  const b = commit(plan([task({ taskId: "t2", capability: "filesystem.read" }), task({ taskId: "t1" })]));
  assert.notEqual(a, b);
});

// --- secret round-trip on resume ---------------------------------------------

test("a legitimately-redacted secret round-trips to the SAME commitment with the prior manifest", () => {
  const live = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "live-secret" } })]), { key: KEY });
  // On reload the secret value is redacted; supplying the prior manifest lets the
  // unchanged secret reuse its commitment rather than forcing re-approval.
  const reloaded = buildApprovalManifest(
    plan([task({ inputs: { key: "API_KEY", value: REDACTED } })]),
    { key: KEY, priorManifest: live.manifest }
  );
  assert.equal(reloaded.commitment, live.commitment);
});

test("tampering a redacted secret to a DIFFERENT string breaks the commitment", () => {
  const live = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "live-secret" } })]), { key: KEY });
  // An attacker who edited the persisted (already-redacted) plan to a different
  // string is NOT the redaction marker, so it is hashed fresh and diverges.
  const tampered = buildApprovalManifest(
    plan([task({ inputs: { key: "API_KEY", value: "attacker-value" } })]),
    { key: KEY, priorManifest: live.manifest }
  );
  assert.notEqual(tampered.commitment, live.commitment);
});

test("the installation key matters: a different key yields a different secret commitment", () => {
  const k2 = crypto.createHash("sha256").update("other-key").digest();
  const a = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "s" } })]), { key: KEY });
  const b = buildApprovalManifest(plan([task({ inputs: { key: "API_KEY", value: "s" } })]), { key: k2 });
  assert.notEqual(a.commitment, b.commitment);
});

test("building a manifest without a key fails closed", () => {
  assert.throws(() => buildApprovalManifest(plan([task()]), {}), /installation key/i);
});
