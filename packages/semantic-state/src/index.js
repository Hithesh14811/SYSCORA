import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// A process-unique token that marks the single controlled writer. Perception
// obtains it via authorizeWriter(); every mutation method requires it once a
// writer has been authorized, so no other subsystem can mutate the world model
// even though the low-level methods remain on the class.
const WRITER_TOKEN = Symbol("semantic-state-writer");

export class SemanticState {
  constructor(baseDirectory) {
    this.baseDirectory = baseDirectory;
    this.dbPath = path.join(baseDirectory, "semantic-state.sqlite");
    // Null until a controlled writer claims ownership. When null, writes are
    // allowed (test/direct-construction convenience); once claimed, every
    // mutation must present the writer token.
    this._writerClaimed = false;
  }

  // Claim single-writer ownership. Returns the token the controlled writer
  // (PerceptionEngine) must present on every mutation. Idempotent per process:
  // the same token is returned so re-wiring perception (e.g. after attaching
  // developer intelligence) does not lock out the existing writer.
  authorizeWriter() {
    this._writerClaimed = true;
    return WRITER_TOKEN;
  }

  // Enforce the single-writer invariant. Once a writer has been authorized,
  // every mutation must present the token; unauthorized writes throw.
  _assertWriter(token, method) {
    if (this._writerClaimed && token !== WRITER_TOKEN) {
      throw new Error(
        `SemanticState.${method} is a controlled write; only the authorized Perception writer may mutate the world model.`
      );
    }
  }

  async ensureSchema() {
    await fs.promises.mkdir(this.baseDirectory, { recursive: true });
    const db = new DatabaseSync(this.dbPath);

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_entities (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          properties TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          stale_after TEXT,
          provenance TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_entities_type ON semantic_entities(type);
        CREATE INDEX IF NOT EXISTS idx_entities_canonical_key ON semantic_entities(canonical_key);
        CREATE INDEX IF NOT EXISTS idx_entities_stale_after ON semantic_entities(stale_after);

        CREATE TABLE IF NOT EXISTS semantic_relationships (
          id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL,
          type TEXT NOT NULL,
          target_entity_id TEXT NOT NULL,
          properties TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          provenance TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_relationships_source ON semantic_relationships(source_entity_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_target ON semantic_relationships(target_entity_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_type ON semantic_relationships(type);

        CREATE TABLE IF NOT EXISTS system_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          entity_ids TEXT NOT NULL,
          relationship_ids TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_session ON system_snapshots(session_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON system_snapshots(timestamp);
      `);
    } finally {
      db.close();
    }
  }

  async upsertEntity(entity, token = undefined) {
    this._assertWriter(token, "upsertEntity");
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    const now = new Date().toISOString();

    try {
      const stmt = db.prepare(`
        INSERT INTO semantic_entities (
          id, type, canonical_key, properties, confidence, 
          first_seen_at, last_seen_at, stale_after, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          canonical_key = excluded.canonical_key,
          properties = excluded.properties,
          confidence = excluded.confidence,
          last_seen_at = excluded.last_seen_at,
          stale_after = excluded.stale_after,
          provenance = excluded.provenance
      `);

      stmt.run(
        entity.id,
        entity.type,
        entity.canonicalKey,
        JSON.stringify(entity.properties || {}),
        entity.confidence || 1.0,
        entity.firstSeenAt || now,
        entity.lastSeenAt || now,
        entity.staleAfter || null,
        entity.provenance || "unknown"
      );

      return entity;
    } finally {
      db.close();
    }
  }

  async upsertRelationship(relationship, token = undefined) {
    this._assertWriter(token, "upsertRelationship");
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    const now = new Date().toISOString();

    try {
      const stmt = db.prepare(`
        INSERT INTO semantic_relationships (
          id, source_entity_id, type, target_entity_id, properties, 
          confidence, first_seen_at, last_seen_at, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_entity_id = excluded.source_entity_id,
          type = excluded.type,
          target_entity_id = excluded.target_entity_id,
          properties = excluded.properties,
          confidence = excluded.confidence,
          last_seen_at = excluded.last_seen_at,
          provenance = excluded.provenance
      `);

      stmt.run(
        relationship.id,
        relationship.sourceEntityId,
        relationship.type,
        relationship.targetEntityId,
        JSON.stringify(relationship.properties || {}),
        relationship.confidence || 1.0,
        relationship.firstSeenAt || now,
        relationship.lastSeenAt || now,
        relationship.provenance || "unknown"
      );

      return relationship;
    } finally {
      db.close();
    }
  }

  async queryEntities(filters = {}) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      let query = "SELECT * FROM semantic_entities WHERE 1=1";
      const params = [];

      if (filters.type) {
        query += " AND type = ?";
        params.push(filters.type);
      }

      if (filters.canonicalKey) {
        query += " AND canonical_key = ?";
        params.push(filters.canonicalKey);
      }

      if (filters.ids && Array.isArray(filters.ids)) {
        const placeholders = filters.ids.map(() => "?").join(",");
        query += ` AND id IN (${placeholders})`;
        params.push(...filters.ids);
      }

      const stmt = db.prepare(query);
      const rows = stmt.all(...params);

      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        canonicalKey: row.canonical_key,
        properties: JSON.parse(row.properties),
        confidence: row.confidence,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        staleAfter: row.stale_after,
        provenance: row.provenance
      }));
    } finally {
      db.close();
    }
  }

  async queryRelationships(filters = {}) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      let query = "SELECT * FROM semantic_relationships WHERE 1=1";
      const params = [];

      if (filters.type) {
        query += " AND type = ?";
        params.push(filters.type);
      }

      if (filters.sourceEntityId) {
        query += " AND source_entity_id = ?";
        params.push(filters.sourceEntityId);
      }

      if (filters.targetEntityId) {
        query += " AND target_entity_id = ?";
        params.push(filters.targetEntityId);
      }

      if (filters.ids && Array.isArray(filters.ids)) {
        const placeholders = filters.ids.map(() => "?").join(",");
        query += ` AND id IN (${placeholders})`;
        params.push(...filters.ids);
      }

      const stmt = db.prepare(query);
      const rows = stmt.all(...params);

      return rows.map((row) => ({
        id: row.id,
        sourceEntityId: row.source_entity_id,
        type: row.type,
        targetEntityId: row.target_entity_id,
        properties: JSON.parse(row.properties),
        confidence: row.confidence,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        provenance: row.provenance
      }));
    } finally {
      db.close();
    }
  }

  async getNeighborhood(entityId, relationshipTypes = null) {
    const relationships = await this.queryRelationships({
      sourceEntityId: entityId
    });
    const targetIds = relationships.map((r) => r.targetEntityId);
    const entities = await this.queryEntities({ ids: targetIds });
    return { relationships, entities };
  }

  async markStale(entityId, staleAfter = new Date().toISOString(), token = undefined) {
    this._assertWriter(token, "markStale");
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);

    try {
      const stmt = db.prepare(
        "UPDATE semantic_entities SET stale_after = ? WHERE id = ?"
      );
      stmt.run(staleAfter, entityId);
    } finally {
      db.close();
    }
  }

  async createSnapshot(sessionId, entityIds, relationshipIds, token = undefined) {
    this._assertWriter(token, "createSnapshot");
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    const id = `snapshot_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    try {
      const stmt = db.prepare(`
        INSERT INTO system_snapshots (
          id, session_id, timestamp, entity_ids, relationship_ids
        ) VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        sessionId,
        now,
        JSON.stringify(entityIds || []),
        JSON.stringify(relationshipIds || [])
      );
      return {
        id,
        sessionId,
        timestamp: now,
        entityIds,
        relationshipIds
      };
    } finally {
      db.close();
    }
  }

  async recordActionEffects(actionId, entityIds, relationshipIds, token = undefined) {
    // Action-effect persistence is a controlled write: it goes through
    // createSnapshot, which enforces the single-writer token. The token MUST be
    // forwarded here — omitting it made every recordActionEffects call throw once
    // Perception had claimed the writer, and the effect was silently lost.
    this._assertWriter(token, "recordActionEffects");
    return this.createSnapshot(`action_${actionId}`, entityIds, relationshipIds, token);
  }

  // Read a persisted snapshot by its session/action id. Read-only, so it needs
  // no writer token. Returns { id, sessionId, timestamp, entityIds,
  // relationshipIds } or null. Used to confirm action-effect persistence.
  async getSnapshot(sessionId) {
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    try {
      const row = db.prepare(
        `SELECT id, session_id, timestamp, entity_ids, relationship_ids
         FROM system_snapshots WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`
      ).get(sessionId);
      if (!row) return null;
      return {
        id: row.id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        entityIds: JSON.parse(row.entity_ids ?? "[]"),
        relationshipIds: JSON.parse(row.relationship_ids ?? "[]")
      };
    } finally {
      db.close();
    }
  }

  async getRelevantState(intent, contextBudget = 100) {
    const relevantTypes = [
      "OperatingSystem",
      "Computer",
      "User",
      "Application",
      "Process",
      "Service",
      "File",
      "Directory",
      "EnvironmentVariable",
      "PathEntry",
      "Port",
      "Project",
      "Workspace"
    ];

    let entities = [];
    for (const type of relevantTypes) {
      const typeEntities = await this.queryEntities({ type });
      entities.push(...typeEntities);
      if (entities.length >= contextBudget) break;
    }

    return entities.slice(0, contextBudget);
  }

  async ingestContext(contextItems) {
    throw new Error("SemanticState.ingestContext is deprecated; send context through PerceptionEngine.perceive().");
    const entities = [];
    const relationships = [];
    const now = new Date().toISOString();

    for (const item of contextItems) {
      switch (item.type) {
        case "system":
          entities.push(...this._processSystemContext(item.data));
          break;
        case "processes":
          entities.push(...this._processProcessesContext(item.data));
          break;
        case "port":
          const portEntities = this._processPortContext(item.data);
          entities.push(...portEntities);
          break;
        case "services":
          entities.push(...this._processServicesContext(item.data));
          break;
        case "environment":
          entities.push(...this._processEnvironmentContext(item.data));
          break;
      }
    }

    // Upsert entities and relationships
    for (const entity of entities) {
      await this.upsertEntity(entity);
    }

    for (const relationship of relationships) {
      await this.upsertRelationship(relationship);
    }

    return { entities, relationships };
  }

  async ingestObservations(observations) {
    throw new Error("SemanticState.ingestObservations is deprecated; send observations through PerceptionEngine.ingestObservation().");
    const updatedEntities = [];
    const now = new Date().toISOString();

    for (const observation of observations) {
      if (!observation) continue;

      // Process environment variable observations
      if (observation.type === 'environment_variable' || observation.environmentVariable) {
        const envData = observation.environmentVariable || observation;
        const entity = {
          id: `env-var-${envData.scope || 'user'}-${envData.key}`,
          type: 'EnvironmentVariable',
          canonicalKey: `env-var-${envData.scope || 'user'}-${envData.key}`,
          properties: {
            key: envData.key,
            value: envData.value,
            scope: envData.scope || 'user'
          },
          confidence: 1.0,
          firstSeenAt: now,
          lastSeenAt: now,
          provenance: 'observation'
        };
        await this.upsertEntity(entity);
        updatedEntities.push(entity);
      }

      // Process PATH entry observations
      if (observation.type === 'path_entry' || observation.pathEntry) {
        const pathData = observation.pathEntry || observation;
        const entry = pathData.entry || pathData.path;
        if (entry) {
          const entity = {
            id: `path-entry-${(pathData.scope || 'user')}-${entry.toLowerCase()}`,
            type: 'PathEntry',
            canonicalKey: `path-entry-${(pathData.scope || 'user')}-${entry.toLowerCase()}`,
            properties: {
              path: entry,
              scope: pathData.scope || 'user'
            },
            confidence: 1.0,
            firstSeenAt: now,
            lastSeenAt: now,
            provenance: 'observation'
          };
          await this.upsertEntity(entity);
          updatedEntities.push(entity);
        }
      }
    }

    return { updated: updatedEntities };
  }

  _processSystemContext(systemData) {
    if (!systemData) return [];
    const now = new Date().toISOString();
    const entities = [];
    
    // Computer entity
    entities.push({
      id: `computer-${systemData.hostname || crypto.randomUUID()}`,
      type: "Computer",
      canonicalKey: `computer-${systemData.hostname || crypto.randomUUID()}`,
      properties: {
        hostname: systemData.hostname,
        platform: systemData.platform,
        release: systemData.release,
        architecture: systemData.architecture,
        totalMemory: systemData.totalMemory,
        freeMemory: systemData.freeMemory,
        cpus: systemData.cpus
      },
      confidence: 1.0,
      firstSeenAt: now,
      lastSeenAt: now,
      provenance: "context-engine-system"
    });

    // OperatingSystem entity
    entities.push({
      id: `os-${systemData.hostname || crypto.randomUUID()}`,
      type: "OperatingSystem",
      canonicalKey: `os-${systemData.hostname || crypto.randomUUID()}`,
      properties: {
        caption: systemData.windowsDetails?.caption,
        version: systemData.windowsDetails?.version,
        build: systemData.windowsDetails?.build
      },
      confidence: 1.0,
      firstSeenAt: now,
      lastSeenAt: now,
      provenance: "context-engine-system"
    });

    // User entity
    entities.push({
      id: `user-${systemData.username || crypto.randomUUID()}`,
      type: "User",
      canonicalKey: `user-${systemData.username || crypto.randomUUID()}`,
      properties: {
        username: systemData.username
      },
      confidence: 1.0,
      firstSeenAt: now,
      lastSeenAt: now,
      provenance: "context-engine-system"
    });

    return entities;
  }

  _processProcessesContext(processesData) {
    if (!Array.isArray(processesData)) return [];
    const now = new Date().toISOString();
    const entities = [];

    for (const proc of processesData) {
      if (!proc) continue;
      entities.push({
        id: `process-${proc.Id || crypto.randomUUID()}`,
        type: "Process",
        canonicalKey: `process-${proc.Id || crypto.randomUUID()}`,
        properties: {
          pid: proc.Id,
          name: proc.ProcessName,
          cpu: proc.CPU,
          workingSet: proc.WorkingSet64,
          path: proc.Path
        },
        confidence: 1.0,
        firstSeenAt: now,
        lastSeenAt: now,
        provenance: "context-engine-processes"
      });
    }

    return entities;
  }

  _processPortContext(portData) {
    if (!portData) return [];
    const now = new Date().toISOString();
    const entities = [];
    
    entities.push({
      id: `port-${portData.port || crypto.randomUUID()}`,
      type: "Port",
      canonicalKey: `port-${portData.port || crypto.randomUUID()}`,
      properties: {
        number: portData.port,
        connections: portData.inspect?.connections || []
      },
      confidence: 1.0,
      firstSeenAt: now,
      lastSeenAt: now,
      provenance: "context-engine-port"
    });

    return entities;
  }

  _processServicesContext(servicesData) {
    if (!Array.isArray(servicesData)) return [];
    const now = new Date().toISOString();
    const entities = [];

    for (const service of servicesData) {
      if (!service) continue;
      entities.push({
        id: `service-${service.Name || crypto.randomUUID()}`,
        type: "Service",
        canonicalKey: `service-${service.Name || crypto.randomUUID()}`,
        properties: {
          name: service.Name,
          displayName: service.DisplayName,
          status: service.Status,
          startType: service.StartType
        },
        confidence: 1.0,
        firstSeenAt: now,
        lastSeenAt: now,
        provenance: "context-engine-services"
      });
    }

    return entities;
  }

  _processEnvironmentContext(envData) {
    if (!envData) return [];
    const now = new Date().toISOString();
    const entities = [];
    
    if (envData.userPath?.value) {
      const entries = envData.userPath.value.split(';').filter(e => e.trim());
      for (const entry of entries) {
        if (!entry) continue;
        entities.push({
          id: `path-entry-${crypto.randomUUID()}`,
          type: "PathEntry",
          canonicalKey: `path-entry-${entry.toLowerCase()}`,
          properties: {
            path: entry,
            scope: "User"
          },
          confidence: 1.0,
          firstSeenAt: now,
          lastSeenAt: now,
          provenance: "context-engine-environment"
        });
      }
    }

    return entities;
  }

  async close() {
    // Since we create a new DB connection per operation, no persistent handle to close
  }

  async pruneBefore(cutoff, { vacuum = false } = {}) {
    const iso = new Date(cutoff).toISOString();
    await this.ensureSchema();
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const snapshots = db.prepare("DELETE FROM system_snapshots WHERE datetime(timestamp) < datetime(?)").run(iso);
        const relationships = db.prepare("DELETE FROM semantic_relationships WHERE datetime(last_seen_at) < datetime(?)").run(iso);
        const entities = db.prepare("DELETE FROM semantic_entities WHERE datetime(last_seen_at) < datetime(?)").run(iso);
        db.exec("COMMIT");
        if (vacuum && (snapshots.changes + relationships.changes + entities.changes) > 0) db.exec("VACUUM");
        return {
          removed: {
            snapshots: Number(snapshots.changes),
            relationships: Number(relationships.changes),
            entities: Number(entities.changes)
          },
          cutoff: iso,
          vacuumed: Boolean(vacuum)
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
}
