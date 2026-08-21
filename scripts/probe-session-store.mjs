#!/usr/bin/env node
// What is actually IN sessions.sqlite, and where its 1.4 GB goes.
//
// Written because the store was known to be huge and unbounded but nobody had
// asked what the bytes were. A size on disk does not tell you whether the fix is
// a retention policy, a VACUUM, or dropping one oversized field.
//
// It does NOT JSON.parse the whole table. The first version of this probe did,
// and spent 330 CPU-seconds at 1.26 GB resident before printing anything — on
// the machine whose owner had just asked why it felt slow. Aggregate in SQL,
// parse exactly one row.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const dbPath = process.argv[2]
  ?? path.join(process.cwd(), ".syscora", "sessions", "sessions.sqlite");

const onDisk = fs.statSync(dbPath).size;
const db = new DatabaseSync(dbPath, { readOnly: true });
const mb = (n) => (Number(n ?? 0) / 1024 / 1024).toFixed(1);
const one = (sql) => Object.values(db.prepare(sql).get())[0];

console.log(`file on disk        ${mb(onDisk)} MB`);
console.log(`sessions            ${one("SELECT COUNT(*) FROM sessions")}`);
console.log(`pages               ${one("PRAGMA page_count")} x ${one("PRAGMA page_size")} B, free ${one("PRAGMA freelist_count")}`);

console.log("\n=== sessions and bytes per day (newest first) ===");
const buckets = db.prepare(`
  SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
         SUM(LENGTH(session_json)) AS b, MAX(LENGTH(session_json)) AS mx
  FROM sessions GROUP BY day ORDER BY day DESC
`).all();
let running = 0;
let runningN = 0;
for (const r of buckets) {
  running += Number(r.b);
  runningN += r.n;
  console.log(`  ${r.day}  ${String(r.n).padStart(5)} sessions  ${mb(r.b).padStart(8)} MB  biggest ${mb(r.mx).padStart(6)} MB   | keeping this day and newer: ${String(runningN).padStart(5)} sessions, ${mb(running)} MB`);
}

console.log("\n=== what a retention policy would keep, by newest-N ===");
for (const keep of [50, 100, 200, 500, 1000]) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n, SUM(LENGTH(session_json)) AS b FROM (
      SELECT session_json FROM sessions ORDER BY created_at DESC LIMIT ?
    )
  `).get(keep);
  console.log(`  newest ${String(keep).padStart(5)}:  ${String(r.n).padStart(5)} sessions  ${mb(r.b).padStart(8)} MB`);
}

// Where inside ONE session the bytes are. The hypothesis on record is "screen
// readings kept forever"; this either confirms it or names the real field.
console.log("\n=== where the bytes are, in the largest session ===");
const biggest = db.prepare(`
  SELECT session_id, LENGTH(session_json) AS n FROM sessions
  ORDER BY LENGTH(session_json) DESC LIMIT 1
`).get();
console.log(`  session ${biggest.session_id.slice(0, 24)} — ${mb(biggest.n)} MB`);
const row = db.prepare("SELECT session_json FROM sessions WHERE session_id = ?").get(biggest.session_id);
const s = JSON.parse(row.session_json);
for (const [k, v] of Object.entries(s)
  .map(([k, v]) => [k, JSON.stringify(v ?? null).length])
  .sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${k.padEnd(24)} ${mb(v).padStart(7)} MB`);
}
for (const field of ["events", "steps", "history", "messages", "observations"]) {
  if (!Array.isArray(s[field])) continue;
  const byType = new Map();
  for (const e of s[field]) {
    const t = e?.type ?? e?.kind ?? e?.role ?? "(untyped)";
    const cur = byType.get(t) ?? { n: 0, b: 0 };
    cur.n += 1;
    cur.b += JSON.stringify(e).length;
    byType.set(t, cur);
  }
  console.log(`  --- ${field}: ${s[field].length} entries by type ---`);
  for (const [t, v] of [...byType].sort((a, b) => b[1].b - a[1].b).slice(0, 8)) {
    console.log(`  ${String(t).padEnd(24)} ${String(v.n).padStart(5)} x  ${mb(v.b).padStart(7)} MB`);
  }
}
db.close();
