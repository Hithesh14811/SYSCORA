import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditRepository } from "../../packages/audit/src/index.js";

test("audit chain is contiguous and verifies as valid after appends", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const repo = new AuditRepository(path.join(root, "audit"));
    for (let i = 0; i < 5; i += 1) {
      await repo.append("session_a", "TEST_EVENT", { index: i });
    }
    const events = await repo.readAll();
    assert.equal(events.length, 5);
    // Sequence is contiguous and reflects append order regardless of timestamp.
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(events[0].prevHash, "0".repeat(64));
    // Each entry links to the previous entry's hash.
    for (let i = 1; i < events.length; i += 1) {
      assert.equal(events[i].prevHash, events[i - 1].entryHash);
    }
    const verification = await repo.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.length, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit chain detects a tampered payload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    await repo.append("session_b", "EVENT_ONE", { value: "original" });
    await repo.append("session_b", "EVENT_TWO", { value: "second" });
    await repo.append("session_b", "EVENT_THREE", { value: "third" });

    // Tamper directly in the database: edit a payload without recomputing hashes.
    const db = new DatabaseSync(path.join(auditDir, "audit.sqlite"));
    try {
      db.prepare(`UPDATE audit_events SET payload_json = ? WHERE seq = 2`)
        .run(JSON.stringify({ value: "TAMPERED" }));
    } finally {
      db.close();
    }

    const verification = await repo.verifyChain();
    assert.equal(verification.valid, false);
    assert.equal(verification.brokenAtSeq, 2);
    assert.match(verification.error, /Tampered/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit chain detects a deleted (reordered) entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    await repo.append("session_c", "A", {});
    await repo.append("session_c", "B", {});
    await repo.append("session_c", "C", {});

    const db = new DatabaseSync(path.join(auditDir, "audit.sqlite"));
    try {
      db.prepare(`DELETE FROM audit_events WHERE seq = 2`).run();
    } finally {
      db.close();
    }

    const verification = await repo.verifyChain();
    assert.equal(verification.valid, false);
    // The gap (missing seq 2) or the broken link at seq 3 is detected.
    assert.ok(verification.brokenAtSeq === 2 || verification.brokenAtSeq === 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit chain detects tail truncation via the authenticated anchor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    for (let i = 0; i < 5; i += 1) {
      await repo.append("session_t", "TEST_EVENT", { index: i });
    }
    // Healthy baseline: full chain + anchor agree.
    assert.equal((await repo.verifyChain()).valid, true);

    // Truncate the TAIL. The remaining 3-row prefix is itself a valid chain, so
    // the hash walk alone cannot detect this — only the anchor (still at seq 5) can.
    const db = new DatabaseSync(path.join(auditDir, "audit.sqlite"));
    try {
      db.prepare(`DELETE FROM audit_events WHERE seq IN (4, 5)`).run();
    } finally {
      db.close();
    }

    const verification = await repo.verifyChain();
    assert.equal(verification.valid, false);
    assert.match(verification.error, /Truncation detected/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit chain detects anchor tampering (forged high-water mark)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    for (let i = 0; i < 3; i += 1) {
      await repo.append("session_anchor", "TEST_EVENT", { index: i });
    }
    assert.equal((await repo.verifyChain()).valid, true);

    // Rewrite the anchor file to lower the high-water mark without the HMAC key —
    // an attacker's attempt to make a future truncation look legitimate. The HMAC
    // no longer verifies, so the anchor itself is flagged as tampered.
    const anchorPath = path.join(auditDir, "audit.anchor");
    await fs.writeFile(anchorPath, JSON.stringify({ maxSeq: 1, entryHash: "0".repeat(64), hmac: "deadbeef" }));

    const verification = await repo.verifyChain();
    assert.equal(verification.valid, false);
    assert.match(verification.error, /anchor tampered/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit chain rejects a stray unsequenced row inserted after migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    await repo.append("session_u", "A", {});
    await repo.append("session_u", "B", {});

    // Insert a row with NULL seq directly — the classic evasion the old
    // `WHERE seq IS NOT NULL` filter allowed to slip past verification.
    const db = new DatabaseSync(path.join(auditDir, "audit.sqlite"));
    try {
      db.prepare(
        `INSERT INTO audit_events (event_id, session_id, event_type, event_timestamp, protocol_version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("stray-1", "session_u", "INJECTED", "2020-01-01T00:00:00.000Z", "1.0", JSON.stringify({ evil: true }));
    } finally {
      db.close();
    }

    const verification = await repo.verifyChain();
    assert.equal(verification.valid, false);
    assert.match(verification.error, /unsequenced/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy rows (seq NULL) are backfilled into the chain and then verified", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-"));
  try {
    const auditDir = path.join(root, "audit");
    const repo = new AuditRepository(auditDir);
    // Create the schema, then insert rows the OLD way — no seq/prev_hash/
    // entry_hash — simulating entries written before the integrity migration.
    await repo.ensureSchema();
    const dbPath = path.join(auditDir, "audit.sqlite");
    let db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO audit_events (event_id, session_id, event_type, event_timestamp, protocol_version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      insert.run("legacy-1", "session_legacy", "OLD_EVENT", "2020-01-01T00:00:00.000Z", "1.0", JSON.stringify({ n: 1 }));
      insert.run("legacy-2", "session_legacy", "OLD_EVENT", "2020-01-01T00:00:01.000Z", "1.0", JSON.stringify({ n: 2 }));
    } finally {
      db.close();
    }

    // A fresh append triggers ensureSchema → backfill, then chains the new row.
    await repo.append("session_legacy", "NEW_EVENT", { n: 3 });

    const events = await repo.readAll();
    assert.equal(events.length, 3);
    // Every row — including the two legacy ones — now has a contiguous seq.
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(events[0].prevHash, "0".repeat(64));

    // The WHOLE chain (legacy + new) verifies, proving legacy rows are covered.
    const verification = await repo.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.length, 3);

    // And tampering a backfilled legacy row is now detected — previously these
    // rows were invisible to verifyChain (seq IS NULL) and could be altered.
    db = new DatabaseSync(dbPath);
    try {
      db.prepare(`UPDATE audit_events SET payload_json = ? WHERE event_id = 'legacy-1'`)
        .run(JSON.stringify({ n: "TAMPERED" }));
    } finally {
      db.close();
    }
    const tampered = await repo.verifyChain();
    assert.equal(tampered.valid, false);
    assert.equal(tampered.brokenAtSeq, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
