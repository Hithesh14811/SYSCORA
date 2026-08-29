import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Memory {
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.dbPath = path.join(baseDirectory, "memory.sqlite");
  }

  async ensureSchema() {
    await fs.promises.mkdir(this.baseDirectory, { recursive: true });
    const db = new DatabaseSync(this.dbPath);

    try {
      // Add verified_success column if it doesn't exist
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_records (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          summary TEXT,
          provenance TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          sensitivity TEXT NOT NULL DEFAULT 'LOW',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          related_entities TEXT,
          related_session TEXT,
          related_intent TEXT,
          verified_success BOOLEAN DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_records(type);
        CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_records(related_session);
        CREATE INDEX IF NOT EXISTS idx_memory_intent ON memory_records(related_intent);
        CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_records(expires_at);
      `);

      // Check if verified_success column exists, add if not
      const colsResult = db.prepare("PRAGMA table_info(memory_records)").all();
      const hasVerifiedSuccess = colsResult.some(c => c.name === 'verified_success');
      if (!hasVerifiedSuccess) {
        db.exec("ALTER TABLE memory_records ADD COLUMN verified_success BOOLEAN DEFAULT 0");
      }
    } finally {
      db.close();
    }
  }

  async store(record) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    const now = new Date().toISOString();
    const redactedRecord = redactSensitiveData(record);

    try {
      const stmt = db.prepare(`
        INSERT INTO memory_records (
          id, type, content, summary, provenance, confidence,
          sensitivity, created_at, updated_at, expires_at,
          related_entities, related_session, related_intent, verified_success
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          content = excluded.content,
          summary = excluded.summary,
          provenance = excluded.provenance,
          confidence = excluded.confidence,
          sensitivity = excluded.sensitivity,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          related_entities = excluded.related_entities,
          related_session = excluded.related_session,
          related_intent = excluded.related_intent,
          verified_success = excluded.verified_success
      `);

      stmt.run(
        redactedRecord.id,
        redactedRecord.type,
        JSON.stringify(redactedRecord.content || {}),
        redactedRecord.summary || null,
        redactedRecord.provenance || "unknown",
        redactedRecord.confidence || 1.0,
        redactedRecord.sensitivity || "LOW",
        redactedRecord.createdAt || now,
        redactedRecord.updatedAt || now,
        redactedRecord.expiresAt || null,
        JSON.stringify(redactedRecord.relatedEntities || []),
        redactedRecord.relatedSession || null,
        redactedRecord.relatedIntent || null,
        redactedRecord.verifiedSuccess ? 1 : 0
      );

      return redactedRecord;
    } finally {
      db.close();
    }
  }

  _calculateRelevanceScore(intent, record) {
    let score = 0;
    // Recency
    const recordDate = new Date(record.updated_at);
    const now = new Date();
    const hoursSince = (now - recordDate) / (1000 * 60 * 60);
    score += Math.max(0, 100 - hoursSince);

    // Verified success
    if (record.verified_success) {
      score += 50;
    }

    // Confidence
    score += (record.confidence * 30);

    // Type priority
    const typePriorities = {
      PROCEDURAL: 50,
      EPISODIC: 30,
      FAILURE_PATTERN: 25,
      SYSTEM_HISTORY: 20,
      WORKING: 15,
      PREFERENCE: 10
    };
    score += (typePriorities[record.type] || 0);

    // Intent keywords (simple)
    const intentKeywords = (intent?.rawText || "").toLowerCase().split(/\s+/);
    const summaryKeywords = (record.summary || "").toLowerCase().split(/\s+/);
    const matches = intentKeywords.filter(k => summaryKeywords.includes(k)).length;
    score += (matches * 5);

    return score;
  }

  async retrieveRelevant(intent, maxResults = 20) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      const stmt = db.prepare(`
        SELECT * FROM memory_records 
        WHERE (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
        ORDER BY updated_at DESC 
        LIMIT 1000
      `);
      const allRows = stmt.all();

      // Score and sort
      const scoredRows = allRows.map(row => ({
        ...row,
        relevanceScore: this._calculateRelevanceScore(intent, row)
      })).sort((a, b) => b.relevanceScore - a.relevanceScore);

      return scoredRows.slice(0, maxResults).map((row) => ({
        id: row.id,
        type: row.type,
        content: JSON.parse(row.content),
        summary: row.summary,
        provenance: row.provenance,
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        relatedEntities: JSON.parse(row.related_entities || "[]"),
        relatedSession: row.related_session,
        relatedIntent: row.related_intent,
        verifiedSuccess: !!row.verified_success
      }));
    } finally {
      db.close();
    }
  }

  async list(filters = {}) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      let query = "SELECT * FROM memory_records WHERE 1=1";
      const params = [];

      if (filters.type) {
        query += " AND type = ?";
        params.push(filters.type);
      }

      if (filters.relatedSession) {
        query += " AND related_session = ?";
        params.push(filters.relatedSession);
      }

      query += " ORDER BY updated_at DESC";

      const stmt = db.prepare(query);
      const rows = stmt.all(...params);

      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        content: JSON.parse(row.content),
        summary: row.summary,
        provenance: row.provenance,
        confidence: row.confidence,
        sensitivity: row.sensitivity,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        relatedEntities: JSON.parse(row.related_entities || "[]"),
        relatedSession: row.related_session,
        relatedIntent: row.related_intent,
        verifiedSuccess: !!row.verified_success
      }));
    } finally {
      db.close();
    }
  }

  async delete(id) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      const stmt = db.prepare("DELETE FROM memory_records WHERE id = ?");
      stmt.run(id);
    } finally {
      db.close();
    }
  }

  async expire() {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      const stmt = db.prepare(
        "DELETE FROM memory_records WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')"
      );
      stmt.run();
    } finally {
      db.close();
    }
  }

  async pruneBefore(cutoff, { vacuum = false } = {}) {
    const iso = new Date(cutoff).toISOString();
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    try {
      const result = db.prepare("DELETE FROM memory_records WHERE datetime(updated_at) < datetime(?)").run(iso);
      if (vacuum && result.changes > 0) db.exec("VACUUM");
      return { removed: Number(result.changes), cutoff: iso, vacuumed: Boolean(vacuum && result.changes > 0) };
    } finally {
      db.close();
    }
  }

  async recordSuccessfulWorkflow(workflow, verified = true) {
    return this.store({
      id: `memory_${crypto.randomUUID()}`,
      type: "EPISODIC",
      content: workflow,
      summary: workflow.summary,
      provenance: "verified_workflow",
      confidence: 1.0,
      sensitivity: "LOW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null,
      verifiedSuccess: verified
    });
  }

  async recordFailurePattern(failure, recovery = null) {
    return this.store({
      id: `memory_${crypto.randomUUID()}`,
      type: "FAILURE_PATTERN",
      content: { failure, recovery },
      summary: failure.summary,
      provenance: "failed_workflow",
      confidence: 1.0,
      sensitivity: "LOW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null,
      verifiedSuccess: false
    });
  }

  /**
   * Learn a generalized local recovery without retaining the user's content.
   * The stable id turns repeated observations into evidence counts rather than
   * thousands of one-off memories. Only tool/app/failure taxonomy and tool
   * names in the recovery are stored; queries, messages and file names never
   * enter this record.
   */
  async recordAdaptivePattern({ tool, application = "general", failureClass, recoverySequence = [], recovered = false }) {
    const clean = (value, fallback) => String(value ?? "").toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
    const normalized = {
      tool: clean(tool, "unknown-tool"),
      application: clean(application, "general"),
      failureClass: clean(failureClass, "tool-failed"),
      recoverySequence: [...new Set((recoverySequence ?? []).map((item) => clean(item, "")).filter(Boolean))].slice(0, 6)
    };
    const key = JSON.stringify(normalized);
    const id = `adaptive_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    let prior = null;
    try {
      prior = db.prepare("SELECT content, created_at FROM memory_records WHERE id = ?").get(id) ?? null;
    } finally {
      db.close();
    }
    let counts = { observations: 0, recoveries: 0, unresolved: 0 };
    try { counts = { ...counts, ...(JSON.parse(prior?.content ?? "{}")?.counts ?? {}) }; } catch { /* start clean */ }
    counts.observations += 1;
    if (recovered) counts.recoveries += 1;
    else counts.unresolved += 1;
    const confidence = Math.min(0.98, 0.45 + counts.observations * 0.08 + (counts.recoveries / counts.observations) * 0.25);
    const recovery = normalized.recoverySequence.length ? normalized.recoverySequence.join(" -> ") : "none verified";
    return this.store({
      id,
      type: "FAILURE_PATTERN",
      content: { ...normalized, counts },
      summary: `${normalized.application}: ${normalized.tool} / ${normalized.failureClass}; recovery ${recovery}`,
      provenance: "outcome_learning",
      confidence,
      sensitivity: "LOW",
      createdAt: prior?.created_at ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null,
      relatedEntities: [],
      verifiedSuccess: recovered
    });
  }

  async retrieveAdaptiveGuidance(rawText, maxResults = 4) {
    const requestTokens = new Set(String(rawText ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const records = (await this.list({ type: "FAILURE_PATTERN" }))
      .filter((record) => record.provenance === "outcome_learning")
      .map((record) => {
        const content = record.content ?? {};
        const contextTokens = `${content.application ?? ""} ${content.tool ?? ""}`.split(/[^a-z0-9]+/).filter(Boolean);
        const relevance = contextTokens.filter((token) => requestTokens.has(token)).length;
        const counts = content.counts ?? {};
        const evidence = Number(counts.recoveries ?? 0) + Number(counts.unresolved ?? 0);
        return { ...record, relevance, evidence };
      })
      .filter((record) => record.relevance > 0)
      .sort((left, right) => right.relevance - left.relevance || right.evidence - left.evidence ||
        new Date(right.updatedAt) - new Date(left.updatedAt));
    return records.slice(0, Math.max(0, Math.min(10, Number(maxResults) || 4)));
  }

  async storeWorkingMemory(sessionId, key, value, expiresAt = null) {
    return this.store({
      id: `working_${sessionId}_${key}`,
      type: "WORKING",
      content: value,
      summary: `Working memory: ${key} for session ${sessionId}`,
      provenance: `session_${sessionId}`,
      confidence: 1.0,
      sensitivity: "LOW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
      relatedSession: sessionId
    });
  }

  async getWorkingMemory(sessionId, key) {
    const records = await this.list({
      type: "WORKING",
      relatedSession: sessionId
    });
    const record = records.find(r => r.id === `working_${sessionId}_${key}`);
    return record?.content;
  }

  async close() {
    // No persistent DB handle, just a placeholder for future implementation
  }
}
