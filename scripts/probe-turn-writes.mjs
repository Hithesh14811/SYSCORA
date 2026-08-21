#!/usr/bin/env node
// Does an agent turn still write inside the synced folder?
//
// The CPU before/after for W0 has a confounder: the desktop app was open for
// the "before" sample and closed for the "after", and neither number can be
// re-taken. This measures the MECHANISM instead, which has no confounder —
// snapshot every file under the OneDrive tree, do exactly what a turn does to
// the session store, snapshot again, and diff. If nothing under OneDrive
// changed, OneDrive has nothing to upload, whatever its CPU happened to read.
//
// Uses SessionStore, the class the product uses, rather than writing bytes at a
// path this script chose — a probe that invents its own write path proves
// something about the probe.
import path from "node:path";
import fs from "node:fs";
import { resolveStateDir, cloudSyncedRoot } from "../packages/shared-types/src/state-path.js";
import { SessionStore } from "../packages/agent-runtime/src/session-store.js";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const stateDir = resolveStateDir(repoRoot);
const syncRoot = cloudSyncedRoot(repoRoot) ?? path.join(process.env.USERPROFILE ?? "", "OneDrive");

console.log(`state dir   ${stateDir}`);
console.log(`sync root   ${syncRoot}`);
console.log(`state is inside sync root?  ${cloudSyncedRoot(stateDir) ? "YES" : "no"}\n`);

// Only the repository's own subtree: walking the whole of OneDrive would take
// minutes and pick up the user's documents changing for unrelated reasons.
const watched = path.join(syncRoot, "Documents", "SYSCORA");
function snapshot(dir, out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(full, out);
    else if (e.isFile()) {
      try { const s = fs.statSync(full); out.set(full, `${s.size}:${s.mtimeMs}`); } catch { /* vanished */ }
    }
  }
  return out;
}

console.log(`snapshotting ${watched} ...`);
const before = snapshot(watched);
console.log(`  ${before.size} files\n`);

const store = new SessionStore(path.join(stateDir, "sessions"));
const id = `session_probe_${Date.now()}`;
console.log("writing a session through SessionStore, five times, as a turn would ...");
for (let i = 0; i < 5; i += 1) {
  await store.save({
    sessionId: id,
    createdAt: new Date().toISOString(),
    currentState: i === 4 ? "COMPLETED" : "EXECUTING",
    intent: { intentType: "GENERAL", rawText: "probe: does this land in OneDrive" },
    taskResults: [],
    events: Array.from({ length: 40 }, (_, n) => ({ n, note: "x".repeat(500) }))
  });
}
const stored = await store.get(id);
console.log(`  wrote and read back ${id} — state ${stored.currentState}\n`);

const after = snapshot(watched);
const changed = [];
for (const [file, sig] of after) if (before.get(file) !== sig) changed.push(file);
for (const file of before.keys()) if (!after.has(file)) changed.push(`${file} (removed)`);

console.log(`files under the synced tree that changed: ${changed.length}`);
for (const f of changed.slice(0, 20)) console.log(`  ${f.replace(watched, "<repo>")}`);

await store.delete(id);
const verdict = changed.length === 0;
console.log(verdict
  ? "\nCONFIRMED: five session writes changed nothing inside the synced folder."
  : "\nNOT CONFIRMED: the writes above still touch the synced folder. See the list.");
process.exit(verdict ? 0 : 1);
