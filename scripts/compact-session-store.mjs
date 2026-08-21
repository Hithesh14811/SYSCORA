#!/usr/bin/env node
// Apply the per-row size cap to sessions that were written before it existed.
//
// The cap in SessionStore bounds what is SAVED. It does nothing to the 1,834
// rows already on disk, one of which is 396.4 MB. This walks them once.
//
// IT DELETES NO CONVERSATIONS. Every session_id survives, with its intent —
// what the user actually asked — intact. What goes is the working state the
// offline pipeline serialised into the row: `interactiveController`, the
// evidence ledger, the observation blobs. Each row records what it lost, in
// `trimmed`, because a session that quietly has no ledger is indistinguishable
// from one that never had one.
//
//   node scripts/compact-session-store.mjs           # dry run
//   node scripts/compact-session-store.mjs --apply
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";
import { boundSession, MAX_SESSION_BYTES } from "../packages/agent-runtime/src/session-store.js";

const apply = process.argv.includes("--apply");
const repoRoot = path.resolve(process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]) ?? ".");
const dbPath = path.join(resolveStateDir(repoRoot), "sessions", "sessions.sqlite");
const mb = (n) => (Number(n ?? 0) / 1024 / 1024).toFixed(1);

console.log(`database    ${dbPath}`);
console.log(`cap         ${(MAX_SESSION_BYTES / 1024).toFixed(0)} KB per session\n`);

const db = new DatabaseSync(dbPath);
const before = db.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(session_json)) AS b FROM sessions").get();
console.log(`before      ${before.n} sessions, ${mb(before.b)} MB of JSON, file ${mb(fs.statSync(dbPath).size)} MB`);

// Only the rows that are actually over. Rewriting 1,700 tiny rows to change
// nothing would churn the file for no reason.
const oversized = db.prepare(`
  SELECT session_id AS id, LENGTH(session_json) AS n FROM sessions
  WHERE LENGTH(session_json) > ? ORDER BY n DESC
`).all(MAX_SESSION_BYTES);
console.log(`oversized   ${oversized.length} sessions, ${mb(oversized.reduce((s, r) => s + Number(r.n), 0))} MB\n`);

if (!apply) {
  for (const row of oversized.slice(0, 10)) console.log(`  ${mb(row.n).padStart(8)} MB  ${row.id}`);
  if (oversized.length > 10) console.log(`  ... and ${oversized.length - 10} more`);
  console.log("\nDRY RUN. Nothing written. Re-run with --apply.");
  db.close();
  process.exit(0);
}

const read = db.prepare("SELECT session_json FROM sessions WHERE session_id = ?");
const write = db.prepare("UPDATE sessions SET session_json = ? WHERE session_id = ?");
let reclaimed = 0;
let touched = 0;
const kept = [];
for (const row of oversized) {
  const original = JSON.parse(read.get(row.id).session_json);
  const { session } = boundSession(original, MAX_SESSION_BYTES);
  // Record the pair so the check below is not the loop's own opinion.
  kept.push({ id: row.id, intent: original?.intent?.rawText ?? null, createdAt: original?.createdAt ?? null });
  write.run(JSON.stringify(session), row.id);
  reclaimed += Number(row.n) - Buffer.byteLength(JSON.stringify(session), "utf8");
  touched += 1;
  if (Number(row.n) > 10 * 1024 * 1024) console.log(`  ${mb(row.n).padStart(8)} MB -> ${mb(Buffer.byteLength(JSON.stringify(session)))} MB  ${row.id}`);
}
console.log(`\nrewrote ${touched} rows, reclaimed ${mb(reclaimed)} MB of JSON`);

console.log("vacuuming (SQLite does not return pages on UPDATE) ...");
db.exec("VACUUM");

const after = db.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(session_json)) AS b, MAX(LENGTH(session_json)) AS mx FROM sessions").get();
console.log(`\nafter       ${after.n} sessions, ${mb(after.b)} MB of JSON, file ${mb(fs.statSync(dbPath).size)} MB`);
console.log(`largest row ${mb(after.mx)} MB`);

// VERIFY, and not by trusting the loop above. Re-read every row that was
// touched and check the session_id and the user's own question are still there
// — a compaction that lost a conversation must not be able to report success.
let lost = 0;
for (const k of kept) {
  const back = read.get(k.id);
  if (!back) { console.error(`  LOST: ${k.id}`); lost += 1; continue; }
  const parsed = JSON.parse(back.session_json);
  if (parsed.sessionId !== k.id) { console.error(`  WRONG ID: ${k.id}`); lost += 1; continue; }
  if ((parsed?.intent?.rawText ?? null) !== k.intent) { console.error(`  INTENT CHANGED: ${k.id}`); lost += 1; }
  if ((parsed?.createdAt ?? null) !== k.createdAt) { console.error(`  CREATED_AT CHANGED: ${k.id}`); lost += 1; }
}
console.log(lost === 0
  ? `verified    ${kept.length}/${kept.length} rewritten sessions still carry their id, question and timestamp`
  : `VERIFICATION FAILED on ${lost} sessions`);
if (Number(after.n) !== Number(before.n)) {
  console.error(`SESSION COUNT CHANGED: ${before.n} -> ${after.n}. That should be impossible; nothing here deletes.`);
}
db.close();
process.exit(lost === 0 && Number(after.n) === Number(before.n) ? 0 : 1);
