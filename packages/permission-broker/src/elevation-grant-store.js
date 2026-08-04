import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Persistent, authoritative store of SESSION-SCOPED ELEVATION grants.
//
// An elevation grant records that the user consented, once, to SYSCORA running
// elevated operations for a bounded period within one session. It is the
// difference between "the user approved this one admin action" (a single-use
// privilege token) and "the user elevated this session" (this store).
//
// Deliberate properties:
//   - Never implicitly created. Absence of an active grant means NOT elevated.
//   - Always time-bounded. A grant without an expiry is rejected, so an
//     elevated session can never become permanent by omission.
//   - Scoped to an operation allow-list. A grant for {service.restart} does not
//     authorize package.install.
//   - Revocable, and revocation is immediate for every future check.
//   - Records the consent evidence (how the user elevated) for the audit chain.
export const DEFAULT_ELEVATION_LIFETIME_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_ELEVATION_LIFETIME_MS = 8 * 60 * 60 * 1000; // 8 hours, hard cap

// A grant may name specific operations, or this wildcard for "any elevated
// operation this build supports". The wildcard still cannot authorize an
// operation the privileged helper does not implement.
export const ELEVATION_SCOPE_ALL = "*";

export class ElevationGrantStore {
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.databasePath = path.join(baseDirectory, "elevation-grants.sqlite");
  }

  async ensureSchema() {
    await fs.mkdir(this.baseDirectory, { recursive: true });
    const db = new DatabaseSync(this.databasePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS elevation_grants (
          grant_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          operations_json TEXT NOT NULL,
          consent_kind TEXT NOT NULL,
          consent_evidence TEXT,
          unattended INTEGER NOT NULL DEFAULT 0,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_elevation_grants_session
          ON elevation_grants(session_id);
      `);
    } finally {
      db.close();
    }
  }

  /**
   * Record that a session is elevated.
   *
   * consentKind describes HOW the user consented and is written to the audit
   * chain verbatim:
   *   "UAC_PROMPT"        - Windows itself prompted and the user accepted.
   *   "PRECONFIGURED"     - the operator enabled unattended elevation in config.
   * There is no "implied" or "inferred" consent kind, by design.
   */
  async grant({
    sessionId,
    operations = [ELEVATION_SCOPE_ALL],
    lifetimeMs = DEFAULT_ELEVATION_LIFETIME_MS,
    consentKind,
    consentEvidence = null,
    unattended = false
  }) {
    if (!sessionId) throw new Error("ElevationGrantStore.grant requires sessionId");
    if (!consentKind) throw new Error("ElevationGrantStore.grant requires consentKind");
    const scoped = [...new Set((Array.isArray(operations) ? operations : [operations]).filter(Boolean))];
    if (scoped.length === 0) throw new Error("ElevationGrantStore.grant requires at least one operation scope");

    // An elevated session must always expire. A caller asking for an unbounded
    // or absurd lifetime gets the capped default, never permanence.
    const requested = Number(lifetimeMs);
    const ttlMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_ELEVATION_LIFETIME_MS)
      : DEFAULT_ELEVATION_LIFETIME_MS;

    await this.ensureSchema();
    const grantId = `elevation_${crypto.randomUUID()}`;
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const db = new DatabaseSync(this.databasePath);
    try {
      db.prepare(`
        INSERT INTO elevation_grants
          (grant_id, session_id, operations_json, consent_kind, consent_evidence, unattended, issued_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        grantId,
        sessionId,
        JSON.stringify(scoped),
        consentKind,
        consentEvidence == null ? null : String(consentEvidence),
        unattended === true ? 1 : 0,
        issuedAt,
        expiresAt
      );
    } finally {
      db.close();
    }
    return { grantId, sessionId, operations: scoped, consentKind, unattended: unattended === true, issuedAt, expiresAt, ttlMs };
  }

  /**
   * Is this session currently elevated for this operation?
   *
   * Returns { elevated, reason, grant }. Deny-by-default: any doubt (no grant,
   * expired, revoked, out of scope) is NOT elevated.
   */
  async check({ sessionId, operation }) {
    if (!sessionId) return { elevated: false, reason: "No session." };
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const rows = db.prepare(
        "SELECT * FROM elevation_grants WHERE session_id = ? ORDER BY issued_at DESC"
      ).all(sessionId);
      if (rows.length === 0) return { elevated: false, reason: "Session is not elevated." };

      const now = Date.now();
      let sawRevoked = false;
      let sawExpired = false;
      for (const row of rows) {
        if (row.revoked_at) { sawRevoked = true; continue; }
        if (Date.parse(row.expires_at) <= now) { sawExpired = true; continue; }
        const operations = JSON.parse(row.operations_json);
        const covers = operations.includes(ELEVATION_SCOPE_ALL)
          || (operation != null && operations.includes(operation));
        if (!covers) continue;
        return { elevated: true, grant: this._toRecord(row) };
      }
      if (sawRevoked) return { elevated: false, reason: "Elevation grant was revoked." };
      if (sawExpired) return { elevated: false, reason: "Elevation grant expired." };
      return { elevated: false, reason: `Elevation grant does not cover ${operation ?? "this operation"}.` };
    } finally {
      db.close();
    }
  }

  // Revoke every active elevation grant for a session. Returns the number
  // revoked. Used on session end, on explicit user revocation, and whenever the
  // runtime drops elevation defensively.
  async revokeSession(sessionId) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const result = db.prepare(
        "UPDATE elevation_grants SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL"
      ).run(new Date().toISOString(), sessionId);
      return Number(result.changes ?? 0);
    } finally {
      db.close();
    }
  }

  async list(sessionId) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.databasePath);
    try {
      const rows = sessionId
        ? db.prepare("SELECT * FROM elevation_grants WHERE session_id = ? ORDER BY issued_at DESC").all(sessionId)
        : db.prepare("SELECT * FROM elevation_grants ORDER BY issued_at DESC").all();
      return rows.map((row) => this._toRecord(row));
    } finally {
      db.close();
    }
  }

  _toRecord(row) {
    return {
      grantId: row.grant_id,
      sessionId: row.session_id,
      operations: JSON.parse(row.operations_json),
      consentKind: row.consent_kind,
      consentEvidence: row.consent_evidence,
      unattended: row.unattended === 1,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    };
  }
}
