// W0 — the machine was being made slow by us.
//
// Two defects, measured on the real installation 21 Aug 2026:
//   1. `.syscora/` sat inside the user's OneDrive folder. 2.07 GB of databases,
//      rewritten every agent turn, re-uploaded continuously, with plaintext API
//      keys in the same tree.
//   2. SessionStore had no DELETE and no ceiling on a row. One session was
//      396.4 MB — 27% of the whole 1,443 MB file — because agent-runtime
//      serialises the offline pipeline's entire result object into the session.
//
// These tests state what they would FAIL on:
//   - a state path that ignores its pointer file, or that leaks one caller's
//     state into another's (which would break ~40 tests using temp roots),
//   - a save that stores a row over the cap, by ANY route, including the
//     pathological one where the oversized field is a protected one,
//   - a trim that happens silently, or that writes a row the schema rejects,
//   - a prune that reports a deletion it did not perform.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, boundSession, MAX_SESSION_BYTES } from "../../packages/agent-runtime/src/session-store.js";
import {
  resolveStateDir,
  defaultStateDir,
  cloudSyncedRoot,
  STATE_POINTER_FILENAME
} from "../../packages/shared-types/src/state-path.js";
import { validateExecutionSession } from "../../packages/shared-types/src/domain.js";

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "syscora-w0-"));
}

function sessionOfSize(megabytes, extra = {}) {
  // One giant field, shaped like the real offender: agent-runtime writes the
  // whole InteractiveAgentController result onto the session.
  return {
    sessionId: "session_test",
    createdAt: new Date().toISOString(),
    currentState: "COMPLETED",
    intent: { intentType: "GENERAL", rawText: "what is my disk space" },
    taskResults: [],
    interactiveController: { blob: "x".repeat(megabytes * 1024 * 1024) },
    ...extra
  };
}

// ---------------------------------------------------------------- state path

test("state path: no pointer means the old behaviour, so temp-root callers stay isolated", async () => {
  const root = await tempRoot();
  delete process.env.SYSCORA_STATE_DIR;
  assert.equal(resolveStateDir(root), path.join(root, ".syscora"));

  const other = await tempRoot();
  assert.notEqual(resolveStateDir(root), resolveStateDir(other));
});

test("state path: a pointer file redirects, and a pointer to nowhere does NOT silently split state", async () => {
  const root = await tempRoot();
  const real = path.join(await tempRoot(), "state");
  await fs.mkdir(real, { recursive: true });
  delete process.env.SYSCORA_STATE_DIR;

  await fs.writeFile(path.join(root, STATE_POINTER_FILENAME), `# comment\n${real}\n`, "utf8");
  assert.equal(resolveStateDir(root), real);

  // The half-finished-migration case. It must fall back AND say so — going
  // quiet here is how state ends up in two places and looks like data loss.
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on("warning", onWarning);
  await fs.writeFile(path.join(root, STATE_POINTER_FILENAME), path.join(real, "does-not-exist"), "utf8");
  assert.equal(resolveStateDir(root), path.join(root, ".syscora"));
  await new Promise((r) => setImmediate(r));
  process.off("warning", onWarning);
  assert.ok(warnings.some((m) => m.includes("does not exist")), "a dead pointer must warn, not fall back in silence");
});

test("state path: SYSCORA_STATE_DIR outranks the pointer file", async () => {
  const root = await tempRoot();
  const pointed = await tempRoot();
  const forced = await tempRoot();
  await fs.writeFile(path.join(root, STATE_POINTER_FILENAME), pointed, "utf8");
  process.env.SYSCORA_STATE_DIR = forced;
  try {
    assert.equal(resolveStateDir(root), path.resolve(forced));
  } finally {
    delete process.env.SYSCORA_STATE_DIR;
  }
});

test("state path: the default is outside any repository, and OneDrive is detected as synced", () => {
  const fallback = defaultStateDir();
  assert.ok(path.isAbsolute(fallback));
  assert.ok(!fallback.toLowerCase().includes("onedrive"), "the default must not land back inside OneDrive");

  // The exact path this whole workstream exists because of.
  const synced = cloudSyncedRoot(path.join("C:", "Users", "hithe", "OneDrive", "Documents", "SYSCORA", ".syscora"));
  assert.ok(synced && synced.toLowerCase().endsWith("onedrive"), `expected a OneDrive root, got ${synced}`);
  assert.equal(cloudSyncedRoot(os.tmpdir()), null);
});

// -------------------------------------------------------------- size ceiling

test("the store bounds itself: a 5 MB session is stored under the cap and says what went", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  await store.save(sessionOfSize(5));

  const stats = await store.stats();
  assert.ok(stats.largestBytes <= MAX_SESSION_BYTES,
    `row is ${stats.largestBytes} bytes, cap is ${MAX_SESSION_BYTES}`);

  const back = await store.get("session_test");
  assert.equal(back.intent.rawText, "what is my disk space", "the user's own question must survive");
  assert.ok(Array.isArray(back.trimmed) && back.trimmed.length === 1, "the trim must be recorded in the row");
  assert.ok(back.trimmed[0].fields.some((f) => f.field === "interactiveController"),
    "the record must NAME the field that went");
  assert.ok(back.trimmed[0].originalBytes > 5 * 1024 * 1024);
});

test("the store bounds itself even when the oversized field is a PROTECTED one", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  // Nothing sheddable at all — the whole 3 MB is inside `intent`, which pass 1
  // may not touch. If only pass 1 existed this row would be stored whole.
  await store.save({
    sessionId: "session_protected",
    createdAt: new Date().toISOString(),
    currentState: "COMPLETED",
    intent: { intentType: "GENERAL", rawText: "y".repeat(3 * 1024 * 1024) },
    taskResults: []
  });
  const stats = await store.stats();
  assert.ok(stats.largestBytes <= MAX_SESSION_BYTES,
    `protected-field row is ${stats.largestBytes} bytes, cap is ${MAX_SESSION_BYTES}`);
});

test("a bounded session still passes the schema — an unsaveable session is worse than a big one", () => {
  for (const megabytes of [1, 5, 20]) {
    // A REAL plan, not a stub: a fixture that was already invalid would make
    // this test pass or fail for a reason that has nothing to do with trimming.
    const { session } = boundSession(sessionOfSize(megabytes, {
      plan: {
        planId: "p", goal: "g", summary: "s",
        taskGraph: { graphId: "g1", tasks: [{ taskId: "t1", capability: "system.info.read", dependencies: [] }] }
      },
      taskResults: [{ big: "z".repeat(megabytes * 1024 * 1024) }]
    }));
    assert.doesNotThrow(() => validateExecutionSession(session),
      `a ${megabytes} MB session must still validate after trimming`);
    assert.ok(Array.isArray(session.taskResults), "taskResults must stay an array, not become a tombstone object");
  }
});

test("a session already under the cap is returned untouched, with no trim record", () => {
  const small = {
    sessionId: "s", createdAt: new Date().toISOString(), currentState: "COMPLETED",
    intent: { intentType: "GENERAL", rawText: "hello" }, taskResults: [], evidenceLedger: { entries: [] }
  };
  const { session, trimmed } = boundSession(small);
  assert.equal(trimmed.length, 0);
  assert.equal(session, small, "no copy, no trimmed field, nothing said");
  assert.equal(session.trimmed, undefined);
});

test("trimming is loud", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on("warning", onWarning);
  await store.save(sessionOfSize(2));
  await new Promise((r) => setImmediate(r));
  process.off("warning", onWarning);
  assert.ok(warnings.some((m) => m.includes("trimmed") && m.includes("session_test")),
    "a row losing megabytes must warn; silence is how it goes unnoticed for weeks");
});

// -------------------------------------------------------------- delete/prune

test("delete removes a row and reports whether it actually did", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  await store.save({ sessionId: "a", createdAt: new Date().toISOString(), currentState: "COMPLETED", taskResults: [] });

  assert.equal(await store.delete("a"), true);
  assert.equal(await store.delete("a"), false, "deleting what is not there must report false, not true");
  await assert.rejects(() => store.get("a"));
});

test("prune keeps the newest N, names what it removed, and refuses to guess the number", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  for (let i = 0; i < 10; i += 1) {
    await store.save({
      sessionId: `s${i}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      currentState: "COMPLETED",
      taskResults: []
    });
  }

  await assert.rejects(() => store.prune({}), /refusing to guess/);
  await assert.rejects(() => store.prune({ keepNewest: -1 }), /refusing to guess/);

  const result = await store.prune({ keepNewest: 4 });
  assert.equal(result.removed.length, 6);
  assert.equal(result.remaining, 4);
  // The report must match the store, not merely be plausible.
  const left = (await store.listSummaries()).map((r) => r.sessionId).sort();
  assert.deepEqual(left, ["s6", "s7", "s8", "s9"]);
  for (const row of result.removed) {
    await assert.rejects(() => store.get(row.sessionId), `${row.sessionId} was reported removed and is still there`);
  }
});

test("listSummaries does not deserialise the sessions", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  await store.save(sessionOfSize(1));
  const rows = await store.listSummaries();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "session_test");
  assert.ok(typeof rows[0].bytes === "number" && rows[0].bytes > 0);
  assert.equal(rows[0].session_json, undefined, "a summary that carries the payload is not a summary");
});

test("a store constructed with keepNewest bounds its ROW COUNT on every save", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"), { keepNewest: 3 });
  for (let i = 0; i < 12; i += 1) {
    await store.save({
      sessionId: `s${i}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      currentState: "COMPLETED",
      taskResults: []
    });
  }
  assert.equal((await store.stats()).sessions, 3);
});

test("the default store deletes NOTHING — retention is the user's call", async () => {
  const root = await tempRoot();
  const store = new SessionStore(path.join(root, "sessions"));
  assert.equal(store.keepNewest, null);
  for (let i = 0; i < 40; i += 1) {
    await store.save({
      sessionId: `s${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      currentState: "COMPLETED",
      taskResults: []
    });
  }
  assert.equal((await store.stats()).sessions, 40);
});
