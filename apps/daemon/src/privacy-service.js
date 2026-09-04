import fsSync, { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { redactSensitiveData } from "../../../packages/shared-types/src/redaction.js";

export const DEFAULT_PRIVACY_SETTINGS = Object.freeze({ retentionDays: 90 });
const ALLOWED_RETENTION_DAYS = new Set([0, 7, 30, 90, 365]);

async function readConfig(basePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(resolveStateDir(basePath), "config.json"), "utf8"));
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Privacy settings are unavailable until config.json is valid: ${error?.message ?? error}`);
  }
}

async function writeConfig(basePath, config) {
  const stateDirectory = resolveStateDir(basePath);
  const configPath = path.join(stateDirectory, "config.json");
  await fs.mkdir(stateDirectory, { recursive: true });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, configPath);
}

export async function readPrivacySettings(basePath = process.cwd()) {
  const config = await readConfig(basePath);
  const requested = Number(config?.privacy?.retentionDays);
  return {
    retentionDays: ALLOWED_RETENTION_DAYS.has(requested)
      ? requested
      : DEFAULT_PRIVACY_SETTINGS.retentionDays
  };
}

export async function savePrivacySettings(basePath, value) {
  const retentionDays = Number(value?.retentionDays);
  if (!ALLOWED_RETENTION_DAYS.has(retentionDays)) {
    throw new Error("Retention must be one of: forever, 7, 30, 90, or 365 days.");
  }
  const config = await readConfig(basePath);
  await writeConfig(basePath, {
    ...config,
    privacy: { ...(config.privacy ?? {}), retentionDays }
  });
  return { retentionDays };
}

async function directoryBytes(directory) {
  let bytes = 0;
  let files = 0;
  const visit = async (current) => {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        try { bytes += (await fs.stat(target)).size; files += 1; } catch {}
      }
    }
  };
  await visit(directory);
  return { bytes, files };
}

export async function privacySummary(basePath = process.cwd()) {
  const stateDirectory = resolveStateDir(basePath);
  const settings = await readPrivacySettings(basePath);
  const usage = await directoryBytes(stateDirectory);
  return {
    ...settings,
    stateDirectory,
    bytes: usage.bytes,
    files: usage.files,
    includes: ["conversations", "audit events", "memory", "semantic state", "permissions", "integration settings"],
    credentialsIncludedInExport: false
  };
}

export async function applyRetentionPolicy(runtime, basePath = process.cwd(), { now = Date.now(), vacuum = false } = {}) {
  const settings = await readPrivacySettings(basePath);
  if (settings.retentionDays === 0) return { ...settings, skipped: true, reason: "keep-until-deleted" };
  const cutoff = new Date(now - settings.retentionDays * 24 * 60 * 60 * 1000);
  const [sessions, memory, semantic] = await Promise.all([
    runtime?.sessionStore?.pruneBefore?.(cutoff, { vacuum }),
    runtime?.memory?.pruneBefore?.(cutoff, { vacuum }),
    runtime?.semanticState?.pruneBefore?.(cutoff, { vacuum })
  ]);
  // AND GIVE THE DISK BACK, WHEN THAT IS CHEAP.
  //
  // The sweep above deletes rows and SQLite keeps the pages. Measured on the real
  // installation: 169 sessions, 3.5 MB live, an 86 MB file, 95.7% of it free
  // pages. Retention had been running correctly at every start for weeks and the
  // file had never once got smaller.
  //
  // `reclaim` decides for itself and refuses when the rewrite would be expensive
  // — see the note on it — so this is safe on the startup path, which is where it
  // matters: a user who never opens the privacy screen still gets their disk
  // back. An explicit `vacuum: true` from that screen still forces the full
  // rewrite through `pruneBefore` above.
  const reclaimed = vacuum ? null : await runtime?.sessionStore?.reclaim?.().catch(() => null);
  const result = { ...settings, cutoff: cutoff.toISOString(), sessions, memory, semantic, reclaimed };
  await runtime?.auditRepository?.append?.("privacy", "RETENTION_APPLIED", result).catch?.(() => {});
  return result;
}

const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item);

async function writeLine(stream, record) {
  if (!stream.write(`${json(record)}\n`)) await once(stream, "drain");
}

function sanitizedConfig(config) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:api.?key|secret|token|password|credential)/i.test(key)) continue;
      out[key] = visit(item);
    }
    return out;
  };
  return visit(config);
}

async function exportTable(stream, databasePath, query, section, transform = (row) => row) {
  if (!fsSync.existsSync(databasePath)) return 0;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let count = 0;
  try {
    for (const row of db.prepare(query).iterate()) {
      await writeLine(stream, { section, data: redactSensitiveData(transform(row)) });
      count += 1;
    }
  } finally {
    db.close();
  }
  return count;
}

const parse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export async function createPrivacyExport(runtime, basePath = process.cwd(), { browserChats = [], outputDirectory = null } = {}) {
  const stateDirectory = resolveStateDir(basePath);
  await Promise.all([
    runtime.sessionStore.ensureSchema(),
    runtime.auditRepository.ensureSchema(),
    runtime.memory.ensureSchema(),
    runtime.semanticState.ensureSchema()
  ]);
  const downloads = outputDirectory ? path.resolve(outputDirectory) : path.join(os.homedir(), "Downloads");
  await fs.mkdir(downloads, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(downloads, `SYSCORA-data-export-${stamp}.jsonl`);
  const stream = createWriteStream(destination, { flags: "wx", encoding: "utf8", mode: 0o600 });
  const counts = {};
  try {
    await writeLine(stream, {
      section: "manifest",
      data: {
        format: "syscora-data-export-v1",
        exportedAt: new Date().toISOString(),
        note: "One JSON object per line. Provider credentials and protected credential references are excluded."
      }
    });
    const config = await readConfig(basePath);
    await writeLine(stream, { section: "settings", data: sanitizedConfig(config) });
    for (const chat of Array.isArray(browserChats) ? browserChats.slice(0, 100) : []) {
      await writeLine(stream, { section: "desktopChat", data: redactSensitiveData(chat) });
    }
    counts.desktopChats = Math.min(Array.isArray(browserChats) ? browserChats.length : 0, 100);
    counts.sessions = await exportTable(
      stream,
      runtime.sessionStore.databasePath,
      "SELECT session_json FROM sessions ORDER BY updated_at ASC",
      "session",
      (row) => parse(row.session_json, { unreadable: true })
    );
    counts.auditEvents = await exportTable(
      stream,
      runtime.auditRepository.databasePath,
      "SELECT event_id, session_id, event_type, event_timestamp, protocol_version, payload_json FROM audit_events ORDER BY seq ASC, event_timestamp ASC",
      "auditEvent",
      (row) => ({ ...row, payload: parse(row.payload_json, {}), payload_json: undefined })
    );
    counts.memory = await exportTable(stream, runtime.memory.dbPath, "SELECT * FROM memory_records ORDER BY updated_at ASC", "memoryRecord", (row) => ({
      ...row,
      content: parse(row.content, {}),
      related_entities: parse(row.related_entities, [])
    }));
    counts.semanticEntities = await exportTable(stream, runtime.semanticState.dbPath, "SELECT * FROM semantic_entities ORDER BY last_seen_at ASC", "semanticEntity", (row) => ({ ...row, properties: parse(row.properties, {}) }));
    counts.semanticRelationships = await exportTable(stream, runtime.semanticState.dbPath, "SELECT * FROM semantic_relationships ORDER BY last_seen_at ASC", "semanticRelationship", (row) => ({ ...row, properties: parse(row.properties, {}) }));
    counts.semanticSnapshots = await exportTable(stream, runtime.semanticState.dbPath, "SELECT * FROM system_snapshots ORDER BY timestamp ASC", "semanticSnapshot");
    await writeLine(stream, { section: "complete", data: { counts } });
  } catch (error) {
    stream.destroy();
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  stream.end();
  await once(stream, "close");
  await runtime?.auditRepository?.append?.("privacy", "DATA_EXPORTED", { destination: path.basename(destination), counts }).catch?.(() => {});
  return { destination, counts, bytes: (await fs.stat(destination)).size };
}

export async function deleteAllLocalData(basePath = process.cwd()) {
  const stateDirectory = resolveStateDir(basePath);
  const entries = await fs.readdir(stateDirectory, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    await fs.rm(path.join(stateDirectory, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  const receipt = {
    format: "syscora-deletion-receipt-v1",
    deletedAt: new Date().toISOString(),
    removedTopLevelEntries: removed,
    restartRequired: true
  };
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, "privacy-deletion-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}
