// Control-intent convergence: pause and cancel run through the canonical
// submitControlIntent lane, which shares the runtime's authorization + audit +
// persistence guarantees without dragging the halt through the (irrelevant)
// planning / risk / scheduler pipeline. These tests assert that:
//   - each control transition emits a CONTROL_INTENT_EVALUATED authorization
//     record plus the concrete transition record, and the chain verifies;
//   - the new state is persisted;
//   - control commands on a terminal session are denied (no-op) yet still audited.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

async function awaitingConfirmationSession(runtime, workspace, key) {
  // Under the autonomous-execution policy, approval is required only for the three
  // risky classes — one of which is EDITING AN EXISTING FILE. Setting a project env
  // var edits the workspace .env, so pre-create it to make this a genuine edit that
  // parks in AWAITING_APPROVAL (the state these control-lane tests need to exercise
  // pause/cancel). Creating a brand-new .env would now be autonomous.
  await fs.writeFile(path.join(workspace, ".env"), "EXISTING=preexisting\n", "utf8");
  return runtime.runSetProjectEnvVariable(
    {
      rawText: `Set ${key} for the current project`,
      entities: { workspacePath: workspace, key, value: "1" }
    },
    { autoApprove: false }
  );
}

async function eventTypesFor(runtime, sessionId) {
  const events = await runtime.auditRepository.readAll();
  return events.filter((e) => e.sessionId === sessionId).map((e) => e.eventType);
}

test("pause routes through the control-intent lane with authorization + audit", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-control-"));
  try {
    const workspace = path.join(tempRoot, "ws");
    await fs.mkdir(workspace, { recursive: true });
    const runtime = createRuntime(workspace);

    const awaiting = await awaitingConfirmationSession(runtime, workspace, "PAUSE_ME");
    const paused = await runtime.pauseSessionById(awaiting.sessionId, "Pause test");

    assert.equal(paused.currentState, "PAUSED");
    assert.equal(paused.finalResponse.status, "PAUSED");

    // Persisted, not just returned.
    const reloaded = await runtime.sessionStore.get(awaiting.sessionId);
    assert.equal(reloaded.currentState, "PAUSED");

    const types = await eventTypesFor(runtime, awaiting.sessionId);
    assert.ok(types.includes("CONTROL_INTENT_EVALUATED"), "expected an authorization record");
    assert.ok(types.includes("SESSION_PAUSED"), "expected the transition record");

    const verification = await runtime.auditRepository.verifyChain();
    assert.equal(verification.valid, true, verification.error);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("cancel routes through the control-intent lane with authorization + audit", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-control-"));
  try {
    const workspace = path.join(tempRoot, "ws");
    await fs.mkdir(workspace, { recursive: true });
    const runtime = createRuntime(workspace);

    const awaiting = await awaitingConfirmationSession(runtime, workspace, "CANCEL_ME");
    const cancelled = await runtime.cancelSessionById(awaiting.sessionId, "Cancel test");

    assert.equal(cancelled.currentState, "CANCELLED");
    assert.equal(cancelled.finalResponse.status, "CANCELLED");

    const reloaded = await runtime.sessionStore.get(awaiting.sessionId);
    assert.equal(reloaded.currentState, "CANCELLED");

    const types = await eventTypesFor(runtime, awaiting.sessionId);
    assert.ok(types.includes("CONTROL_INTENT_EVALUATED"));
    assert.ok(types.includes("SESSION_CANCELLED"));

    const verification = await runtime.auditRepository.verifyChain();
    assert.equal(verification.valid, true, verification.error);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("control commands on a terminal session are denied but still audited", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-control-"));
  try {
    const workspace = path.join(tempRoot, "ws");
    await fs.mkdir(workspace, { recursive: true });
    const runtime = createRuntime(workspace);

    const awaiting = await awaitingConfirmationSession(runtime, workspace, "TERMINAL_ME");
    await runtime.cancelSessionById(awaiting.sessionId, "Cancel first");

    // A second cancel on the now-terminal session must be a no-op transition.
    const again = await runtime.cancelSessionById(awaiting.sessionId, "Cancel again");
    assert.equal(again.currentState, "CANCELLED");

    // ...but the denied attempt is still authorization-audited (an evaluated
    // control intent), and the chain remains valid.
    const types = await eventTypesFor(runtime, awaiting.sessionId);
    const evaluated = types.filter((t) => t === "CONTROL_INTENT_EVALUATED").length;
    assert.ok(evaluated >= 2, `expected >=2 authorization records, got ${evaluated}`);

    const verification = await runtime.auditRepository.verifyChain();
    assert.equal(verification.valid, true, verification.error);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
