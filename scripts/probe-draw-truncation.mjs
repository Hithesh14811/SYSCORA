#!/usr/bin/env node
// WHAT DID THE MODEL ACTUALLY TRY TO SAY WHEN THE DRAWING TURN WAS CUT OFF?
//
// Written after a live run where "draw a beautiful and detailed car" opened
// Paint, made a fresh document, read the screen, and then stopped with "I hit
// the output length limit twice". Three hypotheses fit that shape equally well
// from the outside, and they need completely different fixes:
//
//   A. the model emitted an enormous `points` array — the freehand path for a
//      detailed figure, one {x,y} object per vertex, at ~12 tokens each;
//   B. the model's REASONING ate the ceiling before any tool call was written.
//      This endpoint is a reasoning model and reasoning_content is billed and
//      counted as output, so a long deliberation leaves nothing for the call;
//   C. many `strokes`, each cheap, but too many of them.
//
// The failure is already on disk. Re-running it would cost money, drive the
// user's Paint, and could easily land on a different hypothesis than the one
// that actually happened. So this reads the recorded run instead.
//
// It parses ONE session, not the table: see probe-session-store.mjs for what
// parsing all of them costs on this machine.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function stateDir() {
  // The pointer file is gitignored, so a cold session cannot see where state
  // lives. Fall back the same way the daemon does rather than guessing once.
  const explicit = process.env.SYSCORA_STATE_DIR;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(os.homedir(), "SYSCORA"),
    path.join(process.cwd(), ".syscora")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "sessions", "sessions.sqlite"))) return dir;
  }
  throw new Error(`No sessions.sqlite under any of: ${candidates.join(", ")}`);
}

const dbPath = path.join(stateDir(), "sessions", "sessions.sqlite");
console.log(`reading ${dbPath}\n`);
const db = new DatabaseSync(dbPath, { readOnly: true });

// Find candidate sessions by a SQL LIKE over the raw JSON — cheap, no parsing.
// The needle is the user's own words, and an empty needle would match every row,
// so it is asserted rather than assumed.
const needle = process.argv[2] ?? "draw a car";
if (!needle.trim()) throw new Error("Empty needle: that would match every session and check nothing.");

const rows = db.prepare(`
  SELECT session_id, created_at, LENGTH(session_json) AS bytes
  FROM sessions
  WHERE session_json LIKE ?
  ORDER BY created_at DESC
  LIMIT 10
`).all(`%${needle}%`);

console.log(`=== sessions mentioning ${JSON.stringify(needle)}: ${rows.length} ===`);
for (const r of rows) {
  console.log(`  ${r.created_at}  ${r.session_id.slice(0, 28)}  ${(r.bytes / 1024).toFixed(1)} KB`);
}
if (rows.length === 0) {
  console.log("\nNothing matched. Try a different phrase from the request.");
  process.exit(0);
}

const target = rows[0];
console.log(`\n=== newest match: ${target.session_id} ===`);
const raw = db.prepare("SELECT session_json FROM sessions WHERE session_id = ?").get(target.session_id);
const session = JSON.parse(raw.session_json);

// Walk every array of event-shaped objects, wherever the store keeps them.
const events = [];
(function walk(node, depth = 0) {
  if (depth > 6 || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object" && typeof item.type === "string") events.push(item);
      else walk(item, depth + 1);
    }
    return;
  }
  for (const value of Object.values(node)) walk(value, depth + 1);
})(session);

console.log(`\n=== ${events.length} recorded events, by type ===`);
const byType = new Map();
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${type}`);
}

// The three hypotheses separate here.
console.log("\n=== truncation events (hypothesis A/B/C separator) ===");
const truncations = events.filter((e) => e.type === "TURN_TRUNCATED");
if (truncations.length === 0) console.log("  none recorded in this session");
for (const e of truncations) {
  console.log(`  toolCalls in the cut-off turn: ${e.details?.toolCalls}`);
  console.log(`  text head: ${JSON.stringify(String(e.details?.text ?? "").slice(0, 200))}`);
}

console.log("\n=== per-step token usage (reasoning vs content) ===");
for (const e of events) {
  const d = e.details ?? {};
  const usage = d.usage ?? d.tokens ?? null;
  if (!usage || typeof usage !== "object") continue;
  console.log(`  ${e.type}: ${JSON.stringify(usage)}`);
}

console.log("\n=== every tool call this run made ===");
for (const e of events) {
  if (!/TOOL/.test(e.type)) continue;
  const d = e.details ?? {};
  const name = d.name ?? d.tool ?? "?";
  const args = d.args ? JSON.stringify(d.args) : "";
  console.log(`  ${e.type.padEnd(18)} ${String(name).padEnd(14)} ${args.slice(0, 160)}`);
}

console.log("\n=== final settle ===");
const settled = events.filter((e) => /SETTLE|COMPLETE|FAIL|RESULT/.test(e.type));
for (const e of settled.slice(-3)) {
  console.log(`  ${e.type}: ${JSON.stringify(e.details ?? {}).slice(0, 500)}`);
}
