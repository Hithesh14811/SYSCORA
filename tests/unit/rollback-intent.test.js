import { test } from "node:test";
import assert from "node:assert/strict";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";

// Task 1.1 — the rollback intent is a system-internal explicit operation. It is
// built deterministically (no model, no keyword classifier) and enforces its own
// required-field contract that USER_INTENT_SCHEMA's untyped `entities` cannot.

test("rollback intent is built deterministically and passes schema validation", async () => {
  // No reasoning engine wired: proves the rollback path never needs the model.
  const engine = new IntentEngine(null);
  const intent = await engine.classify("", {
    operation: "session.rollback",
    workspacePath: "C:/ws",
    entities: {
      sessionId: "session_abc123",
      targetRecordIds: ["rec_1", "rec_2"],
      reason: "user requested undo"
    }
  });

  assert.equal(intent.operation, "session.rollback");
  assert.equal(intent.category, "ROLLBACK");
  assert.equal(intent.entities.sessionId, "session_abc123");
  assert.deepEqual(intent.entities.targetRecordIds, ["rec_1", "rec_2"]);
  assert.equal(intent.entities.reason, "user requested undo");
  assert.deepEqual(intent.entities.records, []);
  assert.equal(intent.entities.workspacePath, "C:/ws");
  assert.equal(intent.ambiguity, false);
  assert.deepEqual(intent.requiredCapabilities, ["session.rollback"]);
  assert.ok(intent.rawText.includes("session_abc123"));
});

test("rollback intent defaults targetRecordIds to empty (all records) and reason to null", async () => {
  const engine = new IntentEngine(null);
  const intent = await engine.classify("", {
    operation: "session.rollback",
    entities: { sessionId: "session_only" }
  });
  assert.deepEqual(intent.entities.targetRecordIds, []);
  assert.equal(intent.entities.reason, null);
});

test("rollback intent without sessionId is rejected", async () => {
  const engine = new IntentEngine(null);
  await assert.rejects(
    () => engine.classify("", { operation: "session.rollback", entities: {} }),
    /entities\.sessionId is required/
  );
});

test("rollback intent with a non-string sessionId is rejected", async () => {
  const engine = new IntentEngine(null);
  await assert.rejects(
    () => engine.classify("", { operation: "session.rollback", entities: { sessionId: 42 } }),
    /entities\.sessionId is required/
  );
});
