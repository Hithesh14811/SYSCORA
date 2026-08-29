import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSensitiveData } from "../../shared-types/src/redaction.js";

/**
 * THE STORE HAD NO DELETE IN IT AT ALL, AND NO CEILING ON A ROW.
 *
 * Measured 21 Aug 2026 on the real installation: 1,834 sessions, 1,443 MB. The
 * standing explanation was "1,830 sessions at ~800 KB each, because every screen
 * reading is kept forever". THAT AVERAGE IS ARITHMETIC AND IT NAMES THE WRONG
 * MECHANISM. The real distribution:
 *
 *   newest 1,000 sessions        31.4 MB      (the median session is ~2 KB)
 *   123 sessions from 8 Aug     843.6 MB      58% of the file, one day
 *   ONE session                 396.4 MB      27% of the file, one row
 *
 * Inside that one row: `events` 140.7 MB across 35 entries — 4 MB per event —
 * and `interactiveController` 123.1 MB, which is the whole result object of the
 * offline staged pipeline serialised into the session by agent-runtime. So the
 * fix is not a retention policy. Deleting the user's old conversations would
 * have "worked" while leaving the actual defect — an unbounded row — in place,
 * ready to write another 400 MB the next time that path runs.
 *
 * Hence a SIZE cap, applied per row, with the user's transcript protected. All
 * 1,834 conversations survive; what cannot survive is one of them being 396 MB.
 * Retention by count exists below and is deliberately OFF: which conversations
 * to delete is the user's call, not a cleanup task to slip into a session.
 */

// 256 KB. Chosen against the measured distribution, not picked round: the
// newest 1,000 real sessions average 32 KB and the largest legitimate one in
// the last week is 0.2 MB, so this leaves an order of magnitude of headroom
// above normal traffic and still refuses a 396 MB row.
export const MAX_SESSION_BYTES = 256 * 1024;

// Below this a string is not what made a row enormous, and truncating it would
// damage a transcript to save nothing.
const MAX_STRING_BYTES = 4 * 1024;

// The fields that ARE the user's record of what happened. Everything else is
// working state that the machine can do without once the session has settled.
// Kept small and closed on purpose: this is the allow-list, and the shedding
// below is deliberately shape-based (largest first) rather than a list of the
// field names that happened to be big in August — a name list is wrong again
// the first time the pipeline grows a new field.
const PROTECTED = new Set([
  "sessionId", "createdAt", "updatedAt", "currentState", "state",
  "intent", "goalContract", "finalMessage", "summary", "status", "error",
  "protocolVersion", "rollback", "trimmed"
]);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

/**
 * Empty a field while keeping its TYPE. `validateExecutionSession` requires
 * `taskResults` to be an array and validates `plan` when it is truthy, so a
 * tombstone object in either slot turns a size problem into a session that can
 * never be saved again — which is worse than the size problem.
 */
function emptied(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") return null;
  return null;
}

function truncateStrings(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES) return value;
    return `${value.slice(0, MAX_STRING_BYTES)}… [truncated by SessionStore]`;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = truncateStrings(item, seen);
  return out;
}

/**
 * Bring a session under the cap, and SAY SO IN THE ROW.
 *
 * The note is not decoration. A session that silently lost its evidence ledger
 * looks, to anything reading it back, exactly like a session that never had one
 * — and this codebase has been burned repeatedly by state that was absent for an
 * unrecorded reason. `session.trimmed` is what tells a later reader the
 * difference.
 *
 * Exported for the test that proves the bound; not called from anywhere else.
 */
export function boundSession(session, limit = MAX_SESSION_BYTES) {
  if (bytes(session) <= limit) return { session, trimmed: [] };

  const bounded = { ...session };
  const trimmed = [];

  // Pass 1 — shed unprotected fields, largest first, stopping the moment it
  // fits. Largest-first matters: one 123 MB field is the whole problem, and
  // shedding it leaves everything else intact.
  const shedable = Object.keys(bounded)
    .filter((key) => !PROTECTED.has(key))
    .map((key) => [key, bytes(bounded[key])])
    .sort((a, b) => b[1] - a[1]);
  for (const [key, size] of shedable) {
    if (bytes(bounded) <= limit) break;
    bounded[key] = emptied(bounded[key]);
    trimmed.push({ field: key, bytes: size, how: "dropped" });
  }

  // Pass 2 — the protected fields are themselves oversized. Truncate long
  // strings anywhere in what is left rather than dropping a whole field, so a
  // huge rawText loses its tail and not the user's question.
  if (bytes(bounded) > limit) {
    const before = bytes(bounded);
    for (const key of Object.keys(bounded)) {
      if (key === "trimmed") continue;
      bounded[key] = truncateStrings(bounded[key]);
    }
    trimmed.push({ field: "(long strings)", bytes: before - bytes(bounded), how: "truncated" });
  }

  // Pass 3 — the guarantee. If a session is still over the cap after both passes
  // then something pathological is in the protected set, and the store must
  // still bound itself: keep identity and the settled state, name what went.
  if (bytes(bounded) > limit) {
    const before = bytes(bounded);
    for (const key of Object.keys(bounded)) {
      if (["sessionId", "createdAt", "updatedAt", "currentState", "taskResults", "trimmed"].includes(key)) continue;
      bounded[key] = emptied(bounded[key]);
    }
    trimmed.push({ field: "(everything but identity)", bytes: before - bytes(bounded), how: "dropped" });
  }

  bounded.trimmed = [
    ...(Array.isArray(session.trimmed) ? session.trimmed : []),
    { at: new Date().toISOString(), originalBytes: bytes(session), limit, fields: trimmed }
  ];
  return { session: bounded, trimmed };
}

export class SessionStore {
  /**
   * @param {string} baseDirectory
   * @param {{maxSessionBytes?: number, keepNewest?: number|null}} [options]
   *   `keepNewest` is null by default — the store never deletes a conversation
   *   unless a caller names a number. See the header.
   */
  constructor(baseDirectory, options = {}) {
    this.baseDirectory = baseDirectory;
    this.databasePath = path.join(baseDirectory, "sessions.sqlite");
    this.maxSessionBytes = options.maxSessionBytes ?? MAX_SESSION_BYTES;
    this.keepNewest = options.keepNewest ?? null;
  }

  async ensureSchema() {
    await fs.mkdir(this.baseDirectory, { recursive: true });
    const db = new DatabaseSync(this.databasePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          state TEXT NOT NULL,
          session_json TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }
  }

  async save(session) {
    await this.ensureSchema();
    const sanitized = redactSensitiveData(session);
    const { session: bounded, trimmed } = boundSession(sanitized, this.maxSessionBytes);
    if (trimmed.length > 0) {
      // Loud, because a row quietly losing 400 MB of evidence is exactly the
      // kind of thing that is discovered three weeks later by accident.
      process.emitWarning(
        `SessionStore trimmed ${sanitized.sessionId}: `
        + trimmed.map((t) => `${t.field} (${(t.bytes / 1024 / 1024).toFixed(1)} MB, ${t.how})`).join(", ")
      );
    }
    const db = new DatabaseSync(this.databasePath);
    try {
      const statement = db.prepare(`
        INSERT INTO sessions (session_id, created_at, updated_at, state, session_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          updated_at=excluded.updated_at,
          state=excluded.state,
          session_json=excluded.session_json
      `);
      statement.run(
        bounded.sessionId,
        bounded.createdAt,
        new Date().toISOString(),
        bounded.currentState ?? "UNKNOWN",
        JSON.stringify(bounded)
      );
    } finally {
      db.close();
    }
    if (this.keepNewest !== null) await this.prune({ keepNewest: this.keepNewest });
  }

  async get(sessionId) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const statement = db.prepare("SELECT session_json FROM sessions WHERE session_id = ?");
      const row = statement.get(sessionId);
      if (!row) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return JSON.parse(row.session_json);
    } finally {
      db.close();
    }
  }

  async list() {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const statement = db.prepare("SELECT session_json FROM sessions ORDER BY created_at ASC");
      const rows = statement.all();
      return rows.map((row) => JSON.parse(row.session_json));
    } finally {
      db.close();
    }
  }

  /**
   * Identity and state only, straight out of the indexed columns. Reading a
   * session list should not parse every session: on the real installation
   * `list()` deserialises 1,443 MB of JSON to build a menu, and the daemon
   * serves that whole thing on GET /api/sessions.
   */
  async listSummaries({ limit = 200 } = {}) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      return db.prepare(`
        SELECT session_id AS sessionId, created_at AS createdAt,
               updated_at AS updatedAt, state,
               LENGTH(session_json) AS bytes
        FROM sessions ORDER BY created_at DESC LIMIT ?
      `).all(limit);
    } finally {
      db.close();
    }
  }

  /** The DELETE this store never had. Returns whether a row went. */
  async delete(sessionId) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const before = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId).n;
      db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      const after = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get(sessionId).n;
      return before === 1 && after === 0;
    } finally {
      db.close();
    }
  }

  /**
   * Retention by count. NOT called unless a caller asks for it, and it returns
   * what it removed rather than a bare count, because "deleted 834 sessions" is
   * not something a user should have to take on trust.
   *
   * SQLite does not return pages to the filesystem on DELETE, so `vacuum` is
   * offered separately: a caller that prunes and does not vacuum will see the
   * row count fall and the file size not move, and would reasonably conclude
   * the delete did nothing.
   */
  async prune({ keepNewest, vacuum = false }) {
    if (!Number.isInteger(keepNewest) || keepNewest < 0) {
      throw new Error("prune requires an integer keepNewest — refusing to guess how much history to delete");
    }
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const doomed = db.prepare(`
        SELECT session_id AS sessionId, created_at AS createdAt, LENGTH(session_json) AS bytes
        FROM sessions ORDER BY created_at DESC LIMIT -1 OFFSET ?
      `).all(keepNewest);
      const statement = db.prepare("DELETE FROM sessions WHERE session_id = ?");
      for (const row of doomed) statement.run(row.sessionId);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
      if (vacuum && doomed.length > 0) db.exec("VACUUM");
      return { removed: doomed, remaining, vacuumed: Boolean(vacuum && doomed.length > 0) };
    } finally {
      db.close();
    }
  }

  async pruneBefore(cutoff, { vacuum = false } = {}) {
    const iso = new Date(cutoff).toISOString();
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const result = db.prepare("DELETE FROM sessions WHERE datetime(updated_at) < datetime(?)").run(iso);
      if (vacuum && result.changes > 0) db.exec("VACUUM");
      return { removed: Number(result.changes), cutoff: iso, vacuumed: Boolean(vacuum && result.changes > 0) };
    } finally {
      db.close();
    }
  }

  /** File size and row count, for the probe and for anyone asking "is it bounded". */
  async stats() {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS sessions, SUM(LENGTH(session_json)) AS jsonBytes,
               MAX(LENGTH(session_json)) AS largestBytes
        FROM sessions
      `).get();
      let fileBytes = 0;
      try { fileBytes = (await fs.stat(this.databasePath)).size; } catch { /* no file yet */ }
      return { ...row, jsonBytes: Number(row.jsonBytes ?? 0), fileBytes };
    } finally {
      db.close();
    }
  }
}
