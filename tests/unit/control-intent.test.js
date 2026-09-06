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

// A NON-TERMINAL SESSION, BUILT DIRECTLY RATHER THAN PLANNED INTO EXISTENCE.
//
// This used to call `runSetProjectEnvVariable(..., {autoApprove: false})` and rely
// on the STAGED PIPELINE parking the session in AWAITING_APPROVAL — plan, assess
// risk, apply policy, stop and wait. That pipeline is deleted, so the call now
// settles FAILED, which is TERMINAL, and `decideControl` correctly refuses to
// pause a terminal session. These tests then failed for a reason that had nothing
// to do with what they are testing.
//
// What they ARE testing is entirely live and unchanged: `submitControlIntent`,
// `policyEngine.decideControl`, the CONTROL_INTENT_EVALUATED audit record, the
// hash chain, and the persisted transition. All of that needs exactly one thing
// from this fixture — a session in a NON-TERMINAL state — so it now produces that
// and nothing else. Building it directly also drops a dependency on which
// capabilities happen to require approval this month, which is what made the old
// fixture fragile enough to need the .env comment above it.
async function awaitingConfirmationSession(runtime, workspace, key) {
  const session = runtime._createSession({});
  session.currentState = "REQUEST_CONFIRMATION_IF_REQUIRED";
  session.intent = {
    intentType: "SET_PROJECT_ENV",
    rawText: `Set ${key} for the current project`,
    entities: { workspacePath: workspace, key, value: "1" }
  };
  session.finalResponse = { status: "AWAITING_APPROVAL", reason: "Approval required." };
  await runtime.persistSession(session);
  return session;
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
