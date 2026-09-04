import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Memory } from "../../packages/memory/src/index.js";
import crypto from "node:crypto";

test("Memory - store and retrieveRelevant", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);

  const recordId = crypto.randomUUID();
  await memory.store({
    id: recordId,
    type: "EPISODIC",
    content: { message: "Test content" },
    summary: "Test summary",
    provenance: "test",
    confidence: 1.0,
    sensitivity: "LOW",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
    relatedEntities: [],
    relatedSession: null,
    relatedIntent: null
  });

  const records = await memory.retrieveRelevant({});
  assert.equal(records.length, 1);
  assert.equal(records[0].id, recordId);

  await memory.close();
});

test("Memory - secrets are redacted", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);

  const secretValue = "sk_test_123456789";
  const recordId = crypto.randomUUID();
  const stored = await memory.store({
    id: recordId,
    type: "EPISODIC",
    content: { apiKey: secretValue },
    summary: "Test secret content",
    provenance: "test",
    confidence: 1.0,
    sensitivity: "LOW",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
    relatedEntities: [],
    relatedSession: null,
    relatedIntent: null
  });

  const records = await memory.list({});
  assert.equal(records.length, 1);
  // Secret should be redacted
  assert.notEqual(records[0].content.apiKey, secretValue);
  assert.equal(records[0].content.apiKey, "***REDACTED***");

  await memory.close();
});

test("Memory - delete and expire", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);

  const recordId = crypto.randomUUID();
  await memory.store({
    id: recordId,
    type: "EPISODIC",
    content: { message: "Delete test" },
    summary: "Delete summary",
    provenance: "test",
    confidence: 1.0,
    sensitivity: "LOW",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: null,
    relatedEntities: [],
    relatedSession: null,
    relatedIntent: null
  });

  let records = await memory.list({});
  assert.equal(records.length, 1);

  await memory.delete(recordId);
  records = await memory.list({});
  assert.equal(records.length, 0);

  // Test expire
  const expiredRecordId = crypto.randomUUID();
  await memory.store({
    id: expiredRecordId,
    type: "EPISODIC",
    content: { message: "Expired test" },
    summary: "Expired summary",
    provenance: "test",
    confidence: 1.0,
    sensitivity: "LOW",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    relatedEntities: [],
    relatedSession: null,
    relatedIntent: null
  });

  records = await memory.list({});
  assert.equal(records.length, 1);

  await memory.expire();
  records = await memory.list({});
  assert.equal(records.length, 0);

  await memory.close();
});

test("Memory - recordSuccessfulWorkflow and recordFailurePattern", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);

  await memory.recordSuccessfulWorkflow({ summary: "Success test" });
  await memory.recordFailurePattern({ summary: "Failure test" });

  const records = await memory.list({});
  assert.equal(records.length, 2);

  await memory.close();
});

test("Memory - adaptive outcomes aggregate without retaining task content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);

  await memory.recordAdaptivePattern({
    tool: "play_music",
    application: "Spotify",
    failureClass: "matching-track-not-found",
    recoverySequence: ["screen", "click"],
    recovered: true
  });
  await memory.recordAdaptivePattern({
    tool: "play_music",
    application: "Spotify",
    failureClass: "matching-track-not-found",
    recoverySequence: ["screen", "click"],
    recovered: true
  });

  const records = (await memory.list({ type: "FAILURE_PATTERN" }))
    .filter((record) => record.provenance === "outcome_learning");
  assert.equal(records.length, 1, "the same generalized pattern is evidence, not duplicate memories");
  assert.deepEqual(records[0].content.counts, { observations: 2, recoveries: 2, unresolved: 0, neededTime: 0 });
  assert.equal(JSON.stringify(records[0]).includes("Justin Bieber"), false);

  const relevant = await memory.retrieveAdaptiveGuidance("play music on spotify");
  assert.equal(relevant.length, 1);
  // THE SILENCE IS THE HALF WORTH KEEPING. An application's quirks are not
  // advice about writing a document, however many times they have been seen.
  assert.equal((await memory.retrieveAdaptiveGuidance("write a document")).length, 0);
});

test("Memory - a lesson resolved by waiting is counted as needing time", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);
  const pattern = {
    tool: "play_music", application: "Spotify", failureClass: "nothing-started",
    recoverySequence: ["wait", "play_music"], recovered: true
  };
  await memory.recordAdaptivePattern({ ...pattern, neededTime: true });
  await memory.recordAdaptivePattern({ ...pattern, neededTime: true });
  await memory.recordAdaptivePattern({ ...pattern, neededTime: false });

  const [record] = (await memory.list({ type: "FAILURE_PATTERN" }))
    .filter((entry) => entry.provenance === "outcome_learning");
  // COUNTED, NOT PART OF THE IDENTITY. Hashing it would have split this into two
  // patterns of one and two observations, and orphaned every pattern the real
  // store had already learned — the 21-observation Spotify one included.
  assert.equal(record.content.counts.observations, 3, "one pattern, not two");
  assert.equal(record.content.counts.neededTime, 2, "\"needed time in 2 of 3\" beats a boolean");
});

test("Memory - a general lesson with real evidence is reachable without being named", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);
  // MEASURED ON THE REAL STORE, 3 SEP 2026: 20 of 39 learned patterns were filed
  // under `general`, whose token appears in no request anybody has ever typed,
  // so not one of them could ever be retrieved. They were written and never read.
  const general = {
    tool: "click", application: "general", failureClass: "ambiguous-target",
    recoverySequence: ["screen", "click"], recovered: true
  };
  for (let seen = 0; seen < 3; seen += 1) await memory.recordAdaptivePattern(general);

  const unrelated = await memory.retrieveAdaptiveGuidance("summarise this pdf for me");
  assert.equal(unrelated.length, 1, "a tool lesson is not about a topic — it applies wherever that tool is used");
  assert.equal(unrelated[0].content.failureClass, "ambiguous-target");
});

test("Memory - a thin general lesson stays quiet", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-test-"));
  const memory = new Memory(tempDir);
  // One sighting, and nothing that fixed it. Carrying this into every unrelated
  // request is how a memory becomes noise and then gets switched off.
  await memory.recordAdaptivePattern({
    tool: "key", application: "general", failureClass: "input-blocked",
    recoverySequence: [], recovered: false
  });

  assert.equal((await memory.retrieveAdaptiveGuidance("summarise this pdf for me")).length, 0,
    "standing lessons need three observations AND a verified recovery");
});
