// End-to-end validation against the REAL production runtime.
//
// Unlike the other integration suites (which inject deterministic planners or
// stub providers), this builds the runtime exactly as the daemon does — via
// createRuntime() — and drives a real mutating workflow through the full
// canonical pipeline on real hardware (real .env file write, real DPAPI secret
// round-trip). It ties together the milestone's new subsystems and asserts they
// hold together in production wiring:
//
//   - a mutating intent completes end-to-end (planner -> validator -> risk ->
//     policy -> permission GRANT -> scheduler -> observe -> verify -> goal),
//   - capability grants are issued and consumed (deny-by-default is real),
//   - the audit trail is a verifiable hash chain,
//   - a semantic snapshot is written by perception,
//   - a real Windows DPAPI secret store/retrieve round-trips (stdin path),
//   - manual rollback restores prior state.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { WindowsSecretBroker } from "../../packages/secrets/src/index.js";

describe("End-to-end production runtime", () => {
  let tempRoot;
  let workspace;
  let runtime;

  before(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-e2e-"));
    workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    runtime = createRuntime(workspace);
  });

  after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs a mutating env-set intent through the full pipeline and enforces grants", async () => {
    const session = await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set E2E_KEY for the current project",
        entities: { workspacePath: workspace, key: "E2E_KEY", value: "e2e-value" }
      },
      { autoApprove: true }
    );

    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(session.currentState, "COMPLETED");

    // The .env file was really written.
    const envContents = await fs.readFile(path.join(workspace, ".env"), "utf8");
    assert.ok(envContents.includes("E2E_KEY=e2e-value"));

    // Deny-by-default is real: a grant was issued and consumed for the mutating
    // capability (not merely approved by policy).
    const auditEvents = await runtime.auditRepository.readAll();
    const types = auditEvents.map((e) => e.eventType);
    assert.ok(types.includes("CAPABILITY_GRANT_ISSUED"), "a capability grant should have been issued");
    assert.ok(types.includes("CAPABILITY_GRANT_CONSUMED"), "the grant should have been consumed at execution");
    assert.ok(types.includes("TASK_EXECUTED"));
    assert.ok(types.includes("FINAL_VERIFICATION_COMPLETED"));
  });

  it("produces a tamper-evident, verifiable audit chain", async () => {
    const verification = await runtime.auditRepository.verifyChain();
    assert.equal(verification.valid, true, verification.error ?? "chain should verify");
    assert.ok(verification.length > 0);
  });

  it("records a semantic snapshot via perception", async () => {
    const auditEvents = await runtime.auditRepository.readAll();
    assert.ok(auditEvents.some((e) => e.eventType === "SEMANTIC_STATE_UPDATED"));
  });

  it("manually rolls back the mutating session and restores prior state", async () => {
    // A fresh workspace + session so the rollback target is unambiguous.
    const rollbackWorkspace = path.join(tempRoot, "rollback-ws");
    await fs.mkdir(rollbackWorkspace, { recursive: true });
    const local = createRuntime(rollbackWorkspace);

    const session = await local.runSetProjectEnvVariable(
      {
        rawText: "Set ROLLBACK_KEY for the current project",
        entities: { workspacePath: rollbackWorkspace, key: "ROLLBACK_KEY", value: "temp" }
      },
      { autoApprove: true }
    );
    assert.equal(session.finalResponse.status, "COMPLETED");
    // The file exists after the write.
    const afterWrite = await fs.readFile(path.join(rollbackWorkspace, ".env"), "utf8");
    assert.ok(afterWrite.includes("ROLLBACK_KEY=temp"));

    const rolledBack = await local.rollbackSessionById(session.sessionId);
    assert.equal(rolledBack.finalResponse.status, "ROLLED_BACK");

    // The checkpoint captured a non-existent .env, so rollback removes the file
    // (or restores it empty). Either way ROLLBACK_KEY must be gone.
    let contentsAfterRollback = "";
    try {
      contentsAfterRollback = await fs.readFile(path.join(rollbackWorkspace, ".env"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(!contentsAfterRollback.includes("ROLLBACK_KEY=temp"), "rollback must remove the written value");

    // Task 1.3: the rollback is NOT a side-channel. It is dispatched as a real
    // session.rollback intent that flows through the SAME canonical pipeline —
    // risk assessment, policy decision, observation, and independent verification
    // all run for it, and the restore is confirmed by verify()'s own re-read.
    const rollbackSessionId = rolledBack.finalResponse.rollbackSessionId;
    assert.ok(rollbackSessionId, "rollback should spawn its own pipeline session");
    const rollbackSession = (await local.sessionStore.list()).find((s) => s.sessionId === rollbackSessionId);
    assert.ok(rollbackSession, "the rollback session should be persisted");
    const rollbackEvents = (rollbackSession.events ?? []).map((e) => e.eventType);
    for (const expected of ["RISK_ASSESSED", "POLICY_DECIDED", "OBSERVATION_COLLECTED"]) {
      assert.ok(rollbackEvents.includes(expected), `rollback session must emit ${expected} (full pipeline, not a side-channel)`);
    }
    const rollbackTask = rollbackSession.plan.taskGraph.tasks[0];
    assert.equal(rollbackTask.capability, "session.rollback", "rollback runs via the session.rollback capability");
    const rollbackVerification = rollbackSession.verifications.at(-1);
    assert.equal(rollbackVerification.status, "VERIFIED", "verify() must independently confirm restoration");
    assert.equal(rollbackVerification.evidence.reReads, 1, "verify() re-read the mutated capability's live state");
  });

  it("round-trips a real Windows DPAPI secret without exposing plaintext on the command line", async () => {
    // This exercises the real DPAPI store/retrieve path (stdin, not command
    // line). Skipped automatically off-Windows where DPAPI is unavailable.
    if (process.platform !== "win32") return;

    const broker = new WindowsSecretBroker(path.join(tempRoot, "secrets"));
    const stored = await broker.storeSecret("E2E_SECRET", "dpapi-round-trip-value", "user");
    assert.ok(stored.secretRef.startsWith("secret_"));

    const retrieved = await broker.retrieveSecret(stored.secretRef);
    assert.equal(retrieved, "dpapi-round-trip-value");

    // Metadata carries the name/scope but never the value.
    const metadata = await broker.listMetadata();
    const serialized = JSON.stringify(metadata);
    assert.ok(!serialized.includes("dpapi-round-trip-value"), "secret value must not appear in metadata");
  });
});
