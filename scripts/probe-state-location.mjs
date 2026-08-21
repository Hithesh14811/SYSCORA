#!/usr/bin/env node
// Where does the product ACTUALLY read its state from, and did the sessions
// survive the move?
//
// Deliberately not the migration script's own report. That script copied the
// files and hashed them, so it is the wrong thing to ask whether the copy is
// usable — same rule as evidence.js: verification must not share a code path
// with the thing it verifies. This opens the database through SessionStore,
// the class the product uses, and counts rows.
import path from "node:path";
import { resolveStateDir, cloudSyncedRoot } from "../packages/shared-types/src/state-path.js";
import { SessionStore } from "../packages/agent-runtime/src/session-store.js";

const repoRoot = path.resolve(process.argv[2] ?? ".");
const stateDir = resolveStateDir(repoRoot);
const synced = cloudSyncedRoot(stateDir);

console.log(`repo         ${repoRoot}`);
console.log(`state dir    ${stateDir}`);
console.log(`synced?      ${synced ? `YES — inside ${synced}` : "no"}`);

const store = new SessionStore(path.join(stateDir, "sessions"));
const stats = await store.stats();
console.log(`\nsessions     ${stats.sessions}`);
console.log(`json bytes   ${(stats.jsonBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`largest row  ${(stats.largestBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`file         ${(stats.fileBytes / 1024 / 1024).toFixed(1)} MB`);

// Read one real session end to end. A row count proves the table copied; only
// parsing a session proves the bytes in it are still a session.
const newest = (await store.listSummaries({ limit: 1 }))[0];
if (newest) {
  const full = await store.get(newest.sessionId);
  const asked = full?.intent?.rawText ?? "(no intent recorded)";
  console.log(`\nnewest       ${newest.createdAt}  ${newest.state}`);
  console.log(`  asked      ${String(asked).slice(0, 90)}`);
  console.log(`  parses     yes — ${Object.keys(full).length} fields`);
}

// The oldest one too: the point of not deleting anything is that July still reads.
const all = await store.listSummaries({ limit: 100000 });
const oldest = all.at(-1);
if (oldest) {
  const full = await store.get(oldest.sessionId);
  console.log(`\noldest       ${oldest.createdAt}  ${oldest.state}`);
  console.log(`  asked      ${String(full?.intent?.rawText ?? "(none)").slice(0, 90)}`);
  console.log(`  parses     yes — ${Object.keys(full).length} fields`);
}
console.log(`\nspan         ${all.length} sessions, ${oldest?.createdAt?.slice(0, 10)} .. ${newest?.createdAt?.slice(0, 10)}`);
