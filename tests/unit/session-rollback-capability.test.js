import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultCapabilityRegistry,
  LifecycleStatus
} from "../../packages/capability-registry/src/index.js";
import { RollbackManager } from "../../packages/agent-runtime/src/rollback-manager.js";

// Task 1.2 — session.rollback is a real capability that delegates to the shared
// RollbackManager and verifies restoration with an INDEPENDENT re-read, not a
// hardcoded VERIFIED. These tests drive execute/observe/verify directly.

// A stub adapter is enough: session.rollback never calls the adapter itself, it
// invokes the recorded capabilities' rollback/createCheckpoint handlers.
function makeRegistry() {
  const registry = createDefaultCapabilityRegistry({}, {});
  return registry;
}

// Register a controllable fake mutating capability whose live state we can steer,
// so we can force both a correct restore and a silently-wrong restore.
function registerFakeMutator(registry, liveState) {
  registry.register({
    name: "test.mutator",
    version: "1.0.0",
    description: "Fake mutating capability for rollback tests",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    riskMetadata: { level: "MEDIUM" },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: () => true,
    // `state` is a NON-secret field on purpose: verify() compares
    // redaction-normalized snapshots, so a secret-shaped field (value/token/...)
    // is normalized on both sides and cannot serve as the discriminator. The
    // verifiable surface is exactly the non-secret fields.
    execute: async (args) => { liveState.state = args.state; return { state: liveState.state }; },
    observe: async (result) => ({ structuredState: result }),
    verify: async () => ({ status: "VERIFIED" }),
    // createCheckpoint reads LIVE state — this is what verify() re-reads.
    createCheckpoint: async () => ({ state: liveState.state }),
    // rollback restores live state to the checkpoint value.
    rollback: async (inputs, checkpoint) => { liveState.state = checkpoint.state; return { restored: checkpoint.state }; },
    timeout: 1000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });
}

// Like registerFakeMutator but its checkpoint carries BOTH a non-secret field
// (`state`) and a secret-shaped field (`value`), to exercise redaction-normalized
// comparison in verify().
function registerFakeMutatorWithSecret(registry, liveState) {
  registry.register({
    name: "test.mutator.secret",
    version: "1.0.0",
    description: "Fake mutating capability with a secret field",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    riskMetadata: { level: "MEDIUM" },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: () => true,
    execute: async () => ({ ok: true }),
    observe: async (result) => ({ structuredState: result }),
    verify: async () => ({ status: "VERIFIED" }),
    createCheckpoint: async () => ({ state: liveState.state, value: liveState.value }),
    rollback: async () => ({ restored: true }),
    timeout: 1000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });
}

test("session.rollback is registered VERIFIED and honestly NOT_REQUIRED with null rollback", () => {
  const registry = makeRegistry();
  const cap = registry.get("session.rollback");
  assert.ok(cap, "session.rollback should be registered");
  assert.equal(cap.lifecycleStatus, LifecycleStatus.VERIFIED);
  assert.equal(cap.reversibility, "NOT_REQUIRED");
  assert.equal(cap.rollback, null);
});

test("session.rollback execute+observe+verify restores state and verifies via independent re-read", async () => {
  const registry = makeRegistry();
  const liveState = { state: "original" };
  registerFakeMutator(registry, liveState);
  registry.setRollbackManager(new RollbackManager(registry));
  const cap = registry.get("session.rollback");

  // Simulate a prior mutation: checkpoint captured "original", then state moved.
  const record = { taskId: "t1", capability: "test.mutator", inputs: { key: "K" }, dependencies: [], checkpoint: { state: "original" } };
  liveState.state = "mutated";

  const args = { sessionId: "s1", records: [record] };
  const result = await cap.execute(args);
  assert.equal(result.rolledBack, true);
  assert.equal(liveState.state, "original", "rollback should restore live state");

  const observation = await cap.observe(result, args);
  assert.equal(observation.structuredState.rolledBack, true);
  assert.ok(observation.detectedChanges.includes("rollback:test.mutator"));

  const verification = await cap.verify(observation, args);
  assert.equal(verification.status, "VERIFIED");
  assert.equal(verification.evidence.reReads, 1);
});

test("session.rollback verify FAILS when live state does not match the pre-mutation checkpoint (negative case)", async () => {
  const registry = makeRegistry();
  const liveState = { state: "original" };
  registerFakeMutator(registry, liveState);

  // A rollback manager whose restore LIES: it reports ROLLED_BACK but does not
  // actually fix live state. verify()'s independent re-read must catch this.
  const lyingManager = {
    rollback: async (records) => ({
      rolledBack: true,
      entries: records.map((r) => ({ taskId: r.taskId, capability: r.capability, status: "ROLLED_BACK" }))
    })
  };
  registry.setRollbackManager(lyingManager);
  const cap = registry.get("session.rollback");

  const record = { taskId: "t1", capability: "test.mutator", inputs: { key: "K" }, dependencies: [], checkpoint: { state: "original" } };
  // Live state is wrong (still "mutated") because the lying manager didn't restore it.
  liveState.state = "mutated";

  const args = { sessionId: "s1", records: [record] };
  const result = await cap.execute(args);
  const observation = await cap.observe(result, args);
  const verification = await cap.verify(observation, args);

  assert.equal(verification.status, "FAILED", "verify must catch a rollback that did not truly restore state");
  assert.deepEqual(verification.evidence.mismatches, ["test.mutator"]);
});

test("session.rollback verify normalizes redaction: a secret-only difference is not a false mismatch", async () => {
  // Records are persisted through the session store, which redacts secret-shaped
  // fields. A live re-read is unredacted. verify() normalizes both sides, so a
  // difference that exists ONLY in a redacted (secret) field must NOT fail
  // verification — the secret plaintext is unrecoverable post-persistence and its
  // restore is the capability rollback's own responsibility. All non-secret
  // fields still match here, so this must VERIFY.
  const registry = makeRegistry();
  const liveState = { state: "original", value: "live-secret" };
  registerFakeMutatorWithSecret(registry, liveState);
  registry.setRollbackManager({
    rollback: async (records) => ({ rolledBack: true, entries: records.map((r) => ({ taskId: r.taskId, capability: r.capability, status: "ROLLED_BACK" })) })
  });
  const cap = registry.get("session.rollback");

  // Persisted checkpoint has the secret redacted; live re-read has plaintext.
  const record = { taskId: "t1", capability: "test.mutator.secret", inputs: { key: "K" }, dependencies: [], checkpoint: { state: "original", value: "***REDACTED***" } };
  const args = { sessionId: "s1", records: [record] };
  const result = await cap.execute(args);
  const observation = await cap.observe(result, args);
  const verification = await cap.verify(observation, args);
  assert.equal(verification.status, "VERIFIED", "a secret-only difference must not be a false mismatch");
});

test("session.rollback execute is fail-closed when no rollback manager is wired", async () => {
  const registry = makeRegistry();
  const cap = registry.get("session.rollback");
  const result = await cap.execute({ sessionId: "s1", records: [{ taskId: "t1", capability: "x" }] });
  assert.equal(result.rolledBack, false);
  assert.match(result.reason, /not configured/);
});

test("session.rollback respects targetRecordIds subset", async () => {
  const registry = makeRegistry();
  const seen = [];
  registry.setRollbackManager({
    rollback: async (records) => { seen.push(...records.map((r) => r.taskId)); return { rolledBack: true, entries: records.map((r) => ({ taskId: r.taskId, capability: r.capability, status: "ROLLED_BACK" })) }; }
  });
  const cap = registry.get("session.rollback");
  await cap.execute({
    sessionId: "s1",
    records: [
      { taskId: "t1", capability: "a" },
      { taskId: "t2", capability: "b" }
    ],
    targetRecordIds: ["t2"]
  });
  assert.deepEqual(seen, ["t2"], "only the targeted record should be rolled back");
});
