// Semantic entity + relationship type vocabularies and canonical-key helpers.
//
// Perception is the ONLY subsystem that writes to SemanticState. To keep entity
// identity stable across time (so PID churn, re-scans and re-observations never
// create duplicates), every entity's `id` is derived deterministically from its
// canonical key. SemanticState upserts by `id`, so a stable canonical key gives
// reconciliation for free: the same real-world thing always maps to the same row.

export const EntityType = Object.freeze({
  Computer: "Computer",
  OperatingSystem: "OperatingSystem",
  CPU: "CPU",
  Memory: "Memory",
  Disk: "Disk",
  NetworkAdapter: "NetworkAdapter",
  User: "User",
  Process: "Process",
  Executable: "Executable",
  Service: "Service",
  File: "File",
  Directory: "Directory",
  EnvironmentVariable: "EnvironmentVariable",
  PathEntry: "PathEntry",
  Port: "Port",
  Application: "Application",
  Repository: "Repository",
  Project: "Project",
  Runtime: "Runtime",
  PackageManager: "PackageManager",
  Container: "Container",
  Workspace: "Workspace",
  Window: "Window",
  ScreenSnapshot: "ScreenSnapshot",
  ScreenElement: "ScreenElement"
});

export const RelationshipType = Object.freeze({
  RUNS: "RUNS",
  USES: "USES",
  DEPENDS_ON: "DEPENDS_ON",
  CONTAINS: "CONTAINS",
  LISTENS_ON: "LISTENS_ON",
  BELONGS_TO: "BELONGS_TO",
  STARTED_BY: "STARTED_BY",
  INSTALLED_AT: "INSTALLED_AT",
  MODIFIED_BY: "MODIFIED_BY",
  EXECUTES: "EXECUTES",
  HOSTS: "HOSTS",
  REFERENCES: "REFERENCES"
});

// A canonical key uniquely identifies a real-world entity independent of
// volatile attributes (e.g. a process is keyed by executable+pid, an executable
// by its normalized path, a PATH entry by scope+normalized-path). Keys are
// lowercased where the underlying identifier is case-insensitive on Windows.
export function canonicalKey(type, parts) {
  const flat = (Array.isArray(parts) ? parts : [parts])
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join("|");
  return `${type}:${flat}`.toLowerCase();
}

// Deterministic id derived from the canonical key. Identical inputs always yield
// the same id, so upserts reconcile rather than duplicate. (No hashing needed —
// the canonical key is already unique and stable; we just namespace it.)
export function entityId(type, parts) {
  return canonicalKey(type, parts);
}

export function relationshipId(sourceId, type, targetId) {
  return `rel:${type}:${sourceId}=>${targetId}`.toLowerCase();
}

// Normalize a filesystem-ish path for use in canonical keys: forward/back slashes
// unified, trailing separators stripped, lowercased (Windows is case-insensitive).
export function normalizePath(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  return s.replace(/[\\/]+/g, "\\").replace(/\\+$/g, "").toLowerCase();
}

// Build a fully-formed entity record ready for SemanticState.upsertEntity.
export function makeEntity(type, keyParts, properties = {}, options = {}) {
  const key = canonicalKey(type, keyParts);
  const now = options.now ?? new Date().toISOString();
  return {
    id: key,
    type,
    canonicalKey: key,
    properties,
    confidence: options.confidence ?? 1.0,
    firstSeenAt: now,
    lastSeenAt: now,
    staleAfter: options.staleAfter ?? null,
    provenance: options.provenance ?? "perception"
  };
}

export function makeRelationship(sourceId, type, targetId, properties = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  return {
    id: relationshipId(sourceId, type, targetId),
    sourceEntityId: sourceId,
    type,
    targetEntityId: targetId,
    properties,
    confidence: options.confidence ?? 1.0,
    firstSeenAt: now,
    lastSeenAt: now,
    provenance: options.provenance ?? "perception"
  };
}
