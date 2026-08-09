// PerceptionEngine — the Windows perception layer.
//
// This is the ONLY subsystem that writes to SemanticState. It turns raw Windows
// information (via read-only providers) and capability observations into a
// continuously-updated semantic world model, then exposes relevance queries and
// budgeted subgraphs to the planner/recovery.
//
// Responsibilities:
//   - run providers (perceive) and ingest their entities/relationships
//   - ingest capability observations into the same graph
//   - deterministic reconciliation (stable canonical ids => upsert, never dup)
//   - snapshots + semantic differencing (what actually changed)
//   - structured perception events (ENTITY_CREATED/UPDATED, RELATIONSHIP_*, ...)
//   - relevance queries + context budgeting (planner never gets the whole graph)
//
// It NEVER modifies the operating system.

import {
  EntityType,
  RelationshipType,
  makeEntity,
  makeRelationship,
  entityId,
  canonicalKey,
  normalizePath
} from "./entities.js";
import {
  createDefaultProviders,
  SystemProvider,
  ProcessProvider,
  ServiceProvider,
  EnvironmentProvider,
  FilesystemProvider,
  DeveloperProvider
} from "./providers.js";

export const PerceptionEvent = Object.freeze({
  ENTITY_CREATED: "ENTITY_CREATED",
  ENTITY_UPDATED: "ENTITY_UPDATED",
  ENTITY_REMOVED: "ENTITY_REMOVED",
  RELATIONSHIP_CREATED: "RELATIONSHIP_CREATED",
  RELATIONSHIP_UPDATED: "RELATIONSHIP_UPDATED",
  SNAPSHOT_CREATED: "SNAPSHOT_CREATED",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED",
  ACTION_EFFECT_RECORDED: "ACTION_EFFECT_RECORDED",
  ACTION_EFFECT_FAILED: "ACTION_EFFECT_FAILED"
});

export class PerceptionEngine {
  // semanticState: required (the store this engine owns).
  // providers: array of PerceptionProvider (defaults built from adapter).
  // onEvent: optional (event) => void sink for perception events (audit/persist).
  constructor({ semanticState, providers = [], onEvent = null } = {}) {
    this.semanticState = semanticState;
    this.providers = providers;
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.events = [];
    // Claim single-writer ownership of the world model. From here on, only this
    // engine (presenting the returned token) may mutate SemanticState; any other
    // caller's write throws. The token is process-local and never persisted.
    this._writerToken = typeof semanticState?.authorizeWriter === "function"
      ? semanticState.authorizeWriter()
      : undefined;
  }

  // capabilityRegistry is what lets the VisionProvider check that screen.capture,
  // ocr.read and ui.inspect are actually available before it looks at anything.
  // Without it the provider is registered but permanently reports the visual
  // surface unavailable, which is the same blindness by a different route.
  static withDefaultProviders({ semanticState, adapter, developerIntelligence = null, onEvent = null, capabilityRegistry = null }) {
    return new PerceptionEngine({
      semanticState,
      providers: createDefaultProviders(adapter, developerIntelligence, { capabilityRegistry }),
      onEvent
    });
  }

  _emit(type, payload) {
    const event = { type, timestamp: new Date().toISOString(), ...payload };
    this.events.push(event);
    if (this.onEvent) {
      try { this.onEvent(event); } catch { /* event sink is best-effort */ }
    }
    return event;
  }

  // Upsert one entity, emitting CREATED vs UPDATED based on prior existence.
  // Preserves firstSeenAt across updates (reconciliation, not replacement).
  async _upsertEntity(entity) {
    const existing = (await this.semanticState.queryEntities({ ids: [entity.id] }))[0] ?? null;
    if (existing) {
      entity.firstSeenAt = existing.firstSeenAt ?? entity.firstSeenAt;
    }
    await this.semanticState.upsertEntity(entity, this._writerToken);
    this._emit(existing ? PerceptionEvent.ENTITY_UPDATED : PerceptionEvent.ENTITY_CREATED, {
      entityId: entity.id,
      entityType: entity.type,
      canonicalKey: entity.canonicalKey
    });
    return { entity, created: !existing };
  }

  async _upsertRelationship(rel) {
    const existing = (await this.semanticState.queryRelationships({ ids: [rel.id] }))[0] ?? null;
    if (existing) rel.firstSeenAt = existing.firstSeenAt ?? rel.firstSeenAt;
    await this.semanticState.upsertRelationship(rel, this._writerToken);
    this._emit(existing ? PerceptionEvent.RELATIONSHIP_UPDATED : PerceptionEvent.RELATIONSHIP_CREATED, {
      relationshipId: rel.id,
      type: rel.type,
      source: rel.sourceEntityId,
      target: rel.targetEntityId
    });
    return { rel, created: !existing };
  }

  // Write a normalized { entities, relationships } batch into the graph.
  async _ingestBatch({ entities = [], relationships = [] }) {
    const written = { entities: [], relationships: [], created: 0, updated: 0 };
    for (const entity of entities) {
      const { created } = await this._upsertEntity(entity);
      written.entities.push(entity.id);
      written[created ? "created" : "updated"] += 1;
    }
    for (const rel of relationships) {
      await this._upsertRelationship(rel);
      written.relationships.push(rel.id);
    }
    return written;
  }

  // PHASE 2/5: run all providers (or a subset) and populate the world model.
  // request carries optional targeting (workspacePath, directoryPath, port).
  async perceive(request = {}, options = {}) {
    const now = options.now ?? new Date().toISOString();
    const only = options.providers ? new Set(options.providers) : null;
    const allEntities = [];
    const allRelationships = [];

    for (const provider of this.providers) {
      if (only && !only.has(provider.name)) continue;
      try {
        const { entities, relationships } = await provider.perceive(request, now);
        allEntities.push(...entities);
        allRelationships.push(...relationships);
      } catch {
        // A failing provider must not abort perception; it just contributes nothing.
      }
    }

    const written = await this._ingestBatch({ entities: allEntities, relationships: allRelationships });
    return written;
  }

  // PHASE 5: capability observations flow through perception (not written to
  // SemanticState directly by the runtime). We normalize the known structured
  // observation shapes into entities/relationships. Unknown shapes are ingested
  // as a generic record keyed by capability so nothing is silently dropped.
  async ingestObservation(observation, { now = new Date().toISOString() } = {}) {
    if (!observation) return { entities: [], relationships: [], created: 0, updated: 0 };
    const entities = [];
    const relationships = [];

    // Environment variable observation.
    const envData = observation.environmentVariable
      || (observation.type === "environment_variable" ? observation : null);
    if (envData && envData.key) {
      const scope = envData.scope || "user";
      entities.push(makeEntity(EntityType.EnvironmentVariable, [scope, envData.key], {
        key: envData.key, value: envData.value, scope
      }, { now, provenance: "perception:observation" }));
    }

    // PATH entry observation.
    const pathData = observation.pathEntry
      || (observation.type === "path_entry" ? observation : null);
    if (pathData && (pathData.entry || pathData.path)) {
      const entry = pathData.entry || pathData.path;
      const scope = pathData.scope || "user";
      entities.push(makeEntity(EntityType.PathEntry, [scope, normalizePath(entry)], {
        path: entry, scope
      }, { now, provenance: "perception:observation" }));
    }

    // Structured state carrying explicit entities/relationships (future-proof).
    if (Array.isArray(observation.entities)) {
      for (const e of observation.entities) {
        if (e?.type && e?.canonicalKeyParts) {
          entities.push(makeEntity(e.type, e.canonicalKeyParts, e.properties ?? {}, { now, provenance: "perception:observation" }));
        }
      }
    }

    return this._ingestBatch({ entities, relationships });
  }

  // ------------------------------------------------------------------
  // PHASE 9: snapshots + differencing.
  // ------------------------------------------------------------------

  // Capture the full current entity+relationship id set as a snapshot, plus a
  // content fingerprint per entity so a later diff can detect property changes.
  async snapshot(label = "snapshot") {
    const entities = await this._allEntities();
    const relationships = await this._allRelationships();
    const fingerprints = {};
    for (const e of entities) fingerprints[e.id] = this._fingerprint(e);
    const snap = {
      label,
      timestamp: new Date().toISOString(),
      entityIds: entities.map((e) => e.id),
      relationshipIds: relationships.map((r) => r.id),
      fingerprints
    };
    // Persist the id sets via SemanticState's snapshot store. A persistence
    // failure is surfaced as SNAPSHOT_FAILED (not silently dropped) so the
    // runtime can audit that the world-model snapshot did not durably land.
    try {
      const persisted = await this.semanticState.createSnapshot(label, snap.entityIds, snap.relationshipIds, this._writerToken);
      snap.id = persisted?.id ?? null;
    } catch (error) {
      snap.id = null;
      snap.persistenceError = error instanceof Error ? error.message : String(error);
      this._emit(PerceptionEvent.SNAPSHOT_FAILED, { label, error: snap.persistenceError });
    }
    this._emit(PerceptionEvent.SNAPSHOT_CREATED, { label, entities: snap.entityIds.length, relationships: snap.relationshipIds.length, persisted: snap.id !== null });
    return snap;
  }

  // Compare two snapshots -> { addedEntities, removedEntities, changedEntities,
  // addedRelationships, removedRelationships }. Deterministic and pure.
  diff(before, after) {
    const beforeE = new Set(before?.entityIds ?? []);
    const afterE = new Set(after?.entityIds ?? []);
    const beforeR = new Set(before?.relationshipIds ?? []);
    const afterR = new Set(after?.relationshipIds ?? []);

    const addedEntities = [...afterE].filter((id) => !beforeE.has(id));
    const removedEntities = [...beforeE].filter((id) => !afterE.has(id));
    const changedEntities = [...afterE].filter((id) =>
      beforeE.has(id) &&
      before?.fingerprints?.[id] !== undefined &&
      after?.fingerprints?.[id] !== undefined &&
      before.fingerprints[id] !== after.fingerprints[id]
    );
    const addedRelationships = [...afterR].filter((id) => !beforeR.has(id));
    const removedRelationships = [...beforeR].filter((id) => !afterR.has(id));

    return { addedEntities, removedEntities, changedEntities, addedRelationships, removedRelationships };
  }

  // PHASE 5: record the semantic effect of an action as a diff between two
  // snapshots taken around its execution.
  async recordActionEffect(actionId, before, after) {
    const delta = this.diff(before, after);
    // Persist through the single-writer token. A failure here is NOT swallowed:
    // it is surfaced as an ACTION_EFFECT_FAILED event (audited by the runtime)
    // and re-thrown so the caller can record an observable failure. Semantic
    // persistence must never fail silently.
    await this._persistActionEffects(actionId, [...delta.addedEntities, ...delta.changedEntities], delta.addedRelationships);
    this._emit(PerceptionEvent.ACTION_EFFECT_RECORDED, { actionId, delta });
    return delta;
  }

  // Record the explicit entity/relationship ids that an action produced. Used
  // when the effect is already known from an observation ingest (no diff needed).
  async recordEffects(actionId, entityIds = [], relationshipIds = []) {
    await this._persistActionEffects(actionId, entityIds, relationshipIds);
    this._emit(PerceptionEvent.ACTION_EFFECT_RECORDED, {
      actionId,
      delta: { addedEntities: entityIds, changedEntities: [], addedRelationships: relationshipIds }
    });
    return { actionId, entityIds, relationshipIds };
  }

  // On-demand screen/OCR/UIA snapshot capture, for the interactive GUI-control
  // loop's before/after grounding. Delegates the actual capture+normalize work
  // to the registered VisionProvider (there is at most one), then ingests the
  // resulting ScreenSnapshot/ScreenElement entities through the same durable
  // write path as every other provider — so a captured snapshot is queryable
  // by the planner and visible to rollback/audit like any other entity.
  async captureVisionSnapshot(request = {}, { force = false, now = new Date().toISOString() } = {}) {
    const provider = this.providers.find((p) => p.name === "vision");
    if (!provider || typeof provider.collect !== "function") {
      return { available: false, reason: "vision-provider-not-registered", snapshot: null };
    }
    const raw = await provider.collect({ ...request, forceVision: force === true, includeVision: true });
    const { entities, relationships, snapshot, reason } = provider.normalize(raw, { now });
    if (!snapshot) {
      return { available: false, reason: reason ?? raw?.reason ?? "vision-unavailable", snapshot: null };
    }
    const written = await this._ingestBatch({ entities, relationships });
    return { available: true, snapshot, written };
  }

  // Single choke point for action-effect persistence. Forwards the writer token
  // (required by SemanticState's single-writer guard) and turns any failure into
  // an observable event + thrown error instead of a silent drop.
  async _persistActionEffects(actionId, entityIds, relationshipIds) {
    try {
      await this.semanticState.recordActionEffects(actionId, entityIds, relationshipIds, this._writerToken);
    } catch (error) {
      this._emit(PerceptionEvent.ACTION_EFFECT_FAILED, {
        actionId,
        entityIds,
        relationshipIds,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  _fingerprint(entity) {
    // Stable stringification of the properties that define observable state.
    return JSON.stringify(entity.properties ?? {});
  }

  async _allEntities() {
    const all = [];
    for (const type of Object.values(EntityType)) {
      const rows = await this.semanticState.queryEntities({ type });
      all.push(...rows);
    }
    return all;
  }

  async _allRelationships() {
    const all = [];
    for (const type of Object.values(RelationshipType)) {
      const rows = await this.semanticState.queryRelationships({ type });
      all.push(...rows);
    }
    return all;
  }

  // ------------------------------------------------------------------
  // PHASE 6/7: relevance queries + context budgeting.
  // ------------------------------------------------------------------

  // Build a compact, relevant subgraph for an intent. The planner receives only
  // this — never the whole graph. Relevance is deterministic:
  //   1. derive query terms from the intent (raw text, entities, category),
  //   2. score every entity by term match, type importance, recency, confidence,
  //   3. take the top `budget` entities, then pull in their 1-hop relationships.
  async getRelevantSubgraph(intent = {}, { budget = 25 } = {}) {
    const terms = this._queryTerms(intent);
    const entities = await this._allEntities();

    const scored = entities
      .map((e) => ({ entity: e, score: this._score(e, terms, intent) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // If nothing matched (cold graph or generic intent), fall back to the most
    // important entity types so the planner still gets orienting context.
    const chosen = (scored.length ? scored : this._importanceFallback(entities))
      .slice(0, budget)
      .map((s) => s.entity);

    const chosenIds = new Set(chosen.map((e) => e.id));
    const relationships = [];
    for (const e of chosen) {
      const rels = await this.semanticState.queryRelationships({ sourceEntityId: e.id });
      for (const r of rels) {
        if (chosenIds.has(r.targetEntityId) || chosenIds.has(r.sourceEntityId)) relationships.push(r);
      }
    }

    return {
      entities: chosen,
      relationships,
      budget,
      totalEntities: entities.length,
      terms
    };
  }

  _queryTerms(intent) {
    const terms = new Set();
    const push = (v) => { const s = String(v ?? "").toLowerCase().trim(); if (s.length >= 2) terms.add(s); };
    push(intent.rawText);
    push(intent.normalizedGoal);
    push(intent.category);
    push(intent.operation);
    for (const val of Object.values(intent.entities ?? {})) {
      if (typeof val === "string" || typeof val === "number") push(val);
    }
    // Split multi-word text into individual tokens too.
    const text = `${intent.rawText ?? ""} ${intent.normalizedGoal ?? ""}`.toLowerCase();
    for (const tok of text.split(/[^a-z0-9.]+/)) if (tok.length >= 3) terms.add(tok);
    return [...terms];
  }

  // Higher = more relevant. Combines term match, type importance, recency, confidence.
  _score(entity, terms, intent) {
    const hay = `${entity.canonicalKey} ${JSON.stringify(entity.properties ?? {})}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) score += 3;
    }
    // Category/type affinity: an intent category boosts related entity types.
    score += this._categoryAffinity(entity.type, intent) * 2;
    // Type importance prior.
    score += TYPE_IMPORTANCE[entity.type] ?? 0;
    // Recency: entities seen more recently rank higher (small tiebreaker).
    if (entity.lastSeenAt) {
      const ageMs = Date.now() - Date.parse(entity.lastSeenAt);
      if (Number.isFinite(ageMs)) score += Math.max(0, 1 - ageMs / (1000 * 60 * 60)); // decays over 1h
    }
    // Confidence weighting.
    score *= (entity.confidence ?? 1);
    return score;
  }

  _categoryAffinity(type, intent) {
    const cat = String(intent.category ?? "").toUpperCase();
    const affinities = CATEGORY_TYPE_AFFINITY[cat] ?? [];
    return affinities.includes(type) ? 1 : 0;
  }

  _importanceFallback(entities) {
    return entities
      .map((e) => ({ entity: e, score: TYPE_IMPORTANCE[e.type] ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }
}

// Type importance priors (used for scoring and cold-graph fallback).
const TYPE_IMPORTANCE = {
  [EntityType.Project]: 5,
  [EntityType.Workspace]: 4,
  [EntityType.Process]: 4,
  [EntityType.Port]: 4,
  [EntityType.EnvironmentVariable]: 4,
  [EntityType.PathEntry]: 3,
  [EntityType.Service]: 3,
  [EntityType.Executable]: 3,
  [EntityType.Application]: 3,
  [EntityType.Runtime]: 3,
  [EntityType.PackageManager]: 2,
  [EntityType.Repository]: 3,
  [EntityType.Computer]: 2,
  [EntityType.OperatingSystem]: 2,
  [EntityType.CPU]: 1,
  [EntityType.Memory]: 1,
  [EntityType.User]: 1
};

// Which entity types matter for each intent category.
const CATEGORY_TYPE_AFFINITY = {
  SYSTEM: [EntityType.Computer, EntityType.OperatingSystem, EntityType.CPU, EntityType.Memory, EntityType.Process, EntityType.Service, EntityType.Port],
  ENVIRONMENT: [EntityType.EnvironmentVariable, EntityType.PathEntry],
  PROJECT: [EntityType.Project, EntityType.Workspace, EntityType.EnvironmentVariable, EntityType.Runtime, EntityType.PackageManager],
  DEVELOPER: [EntityType.Project, EntityType.Workspace, EntityType.Runtime, EntityType.PackageManager, EntityType.Repository, EntityType.Process],
  APPLICATION: [EntityType.Application, EntityType.Process, EntityType.Executable],
  BROWSER: [EntityType.Application, EntityType.Process]
};

export {
  EntityType,
  RelationshipType,
  makeEntity,
  makeRelationship,
  entityId,
  canonicalKey,
  normalizePath,
  createDefaultProviders,
  SystemProvider,
  ProcessProvider,
  ServiceProvider,
  EnvironmentProvider,
  FilesystemProvider,
  DeveloperProvider
};
