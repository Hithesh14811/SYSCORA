import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { Memory } from "../../packages/memory/src/index.js";
import { SemanticState } from "../../packages/semantic-state/src/index.js";
import {
  applyRetentionPolicy,
  createPrivacyExport,
  deleteAllLocalData,
  privacySummary,
  savePrivacySettings
} from "../../apps/daemon/src/privacy-service.js";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-privacy-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const state = path.join(base, ".syscora");
  const runtime = {
    sessionStore: new SessionStore(path.join(state, "sessions")),
    auditRepository: new AuditRepository(path.join(state, "audit")),
    memory: new Memory(path.join(state, "memory")),
    semanticState: new SemanticState(path.join(state, "semantic-state"))
  };
  return { base, state, runtime };
}

test("configured retention prunes old sessions, memory, and semantic state", async (t) => {
  const { base, runtime } = await fixture(t);
  const old = "2020-01-01T00:00:00.000Z";
  const recent = "2026-08-26T00:00:00.000Z";
  await runtime.sessionStore.save({ sessionId: "old", createdAt: old, updatedAt: old, currentState: "COMPLETED" });
  await runtime.sessionStore.save({ sessionId: "new", createdAt: recent, updatedAt: recent, currentState: "COMPLETED" });
  const sessionsDb = new DatabaseSync(runtime.sessionStore.databasePath);
  sessionsDb.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = 'old'").run(old);
  sessionsDb.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = 'new'").run(recent);
  sessionsDb.close();
  await runtime.memory.store({ id: "old", type: "EPISODIC", content: {}, provenance: "test", createdAt: old, updatedAt: old });
  await runtime.memory.store({ id: "new", type: "EPISODIC", content: {}, provenance: "test", createdAt: recent, updatedAt: recent });
  await runtime.semanticState.upsertEntity({ id: "old", type: "File", canonicalKey: "old", properties: {}, firstSeenAt: old, lastSeenAt: old, provenance: "test" });
  await runtime.semanticState.upsertEntity({ id: "new", type: "File", canonicalKey: "new", properties: {}, firstSeenAt: recent, lastSeenAt: recent, provenance: "test" });
  await savePrivacySettings(base, { retentionDays: 30 });

  const result = await applyRetentionPolicy(runtime, base, { now: Date.parse("2026-08-27T00:00:00.000Z") });
  assert.equal(result.sessions.removed, 1);
  assert.equal(result.memory.removed, 1);
  assert.equal(result.semantic.removed.entities, 1);
  assert.equal((await runtime.sessionStore.list()).length, 1);
  assert.equal((await runtime.memory.list()).length, 1);
});

test("data export is streamed, includes browser chats, and excludes credential fields", async (t) => {
  const { base, state, runtime } = await fixture(t);
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify({ model: { provider: "openai", primaryApiKey: "dpapi:model-primary.bin" } }));
  await runtime.sessionStore.save({ sessionId: "one", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentState: "COMPLETED" });
  const result = await createPrivacyExport(runtime, base, {
    browserChats: [{ id: "chat-1", title: "Hello" }],
    outputDirectory: base
  });
  const exported = await fs.readFile(result.destination, "utf8");
  assert.match(exported, /syscora-data-export-v1/);
  assert.match(exported, /chat-1/);
  assert.doesNotMatch(exported, /primaryApiKey|model-primary\.bin/);
});

test("delete all local data leaves only a non-sensitive deletion receipt", async (t) => {
  const { base, state } = await fixture(t);
  await fs.mkdir(path.join(state, "secrets"), { recursive: true });
  await fs.writeFile(path.join(state, "config.json"), "sensitive config");
  await fs.writeFile(path.join(state, "secrets", "key.bin"), "secret bytes");

  const result = await deleteAllLocalData(base);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(await fs.readdir(state), ["privacy-deletion-receipt.json"]);
  const summary = await privacySummary(base);
  assert.equal(summary.files, 1);
});
