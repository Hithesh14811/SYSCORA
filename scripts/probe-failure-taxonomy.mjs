// WHAT DOES THE AGENT ACTUALLY LEARN FROM ITS OWN HISTORY?
//
//   node scripts/probe-failure-taxonomy.mjs
//   node scripts/probe-failure-taxonomy.mjs --show-shapes
//
// THE QUESTION. `recordAdaptivePattern` files every failure under a class, and
// the class is the whole lesson: `spotify: play_music / tool-failed; recovery
// screen -> click` is what 21 observations bought. If the class is the catch-all
// then the lesson is "a tool failed and then the agent did some things", which
// is true of every run and changes nothing.
//
// So this replays every failed tool call the session store holds through the
// classifier and prints the distribution. A taxonomy whose commonest member is
// `tool-failed` is not a taxonomy, and that is measurable rather than arguable.
//
// IT READS NO CONTENT. Failure text is used only to classify, and nothing but
// counts and class names is ever printed — `--show-shapes` prints the failure
// SHAPES with quoted strings, paths and numbers already replaced. The session
// store holds the user's conversations and none of that leaves this process.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";
import { classifyFailureForLearning } from "../packages/fast-agent/src/index.js";

const argv = process.argv.slice(2);
const showShapes = argv.includes("--show-shapes");

// The taxonomy as it stood before 3 Sep 2026, kept here so the change can be
// measured rather than asserted. Do not "fix" these: they are the historical
// record, and the whole point is what they missed.
const HISTORICAL = [
  [/(?:matching[- ]track[- ]not[- ]found|track.*not found)/i, "matching-track-not-found"],
  [/(?:ambiguous[- ]target|matches? \d+ things|more than one)/i, "ambiguous-target"],
  [/(?:target[- ]not[- ]found|not on screen|could not find|label.*absent)/i, "target-not-found"],
  [/(?:input[- ]blocked|keyboard.*did not|keystrokes?.*refused)/i, "input-blocked"],
  [/(?:already work in this document|document.*occupied)/i, "document-occupied"],
  [/(?:screen.*unchanged|nothing.*changed|no progress)/i, "no-state-change"],
  [/(?:timed? out|timeout)/i, "timeout"],
  [/(?:not installed|unavailable|could not be launched)/i, "unavailable"],
  [/(?:unconfirmed|could not confirm|verification)/i, "verification-unconfirmed"]
];
const historicalClass = (text) => HISTORICAL.find(([pattern]) => pattern.test(text))?.[1] ?? "tool-failed";

// Every quoted string, path, URL and number out, so a shape can be counted
// without anyone's content being read.
const shapeOf = (text) => String(text)
  .replace(/"[^"]*"|'[^']*'/g, "X")
  .replace(/[a-z]:\\[^\s]*/gi, "PATH")
  .replace(/https?:\/\/\S+/g, "URL")
  .replace(/\d+/g, "N")
  .toLowerCase().replace(/\s+/g, " ").trim().slice(0, 70);

function loadFailures() {
  const dbPath = `${resolveStateDir()}/sessions/sessions.sqlite`;
  if (!fs.existsSync(dbPath)) return { error: `no session store at ${dbPath}` };
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT session_json FROM sessions").all();
  db.close();
  const failures = [];
  for (const row of rows) {
    let session;
    try { session = JSON.parse(row.session_json); } catch { continue; }
    for (const event of session.events ?? []) {
      if (event.eventType !== "TOOL_FINISHED") continue;
      const details = event.details ?? {};
      if (details.ok !== false) continue;
      failures.push({ tool: details.tool ?? "?", text: String(details.output ?? "") });
    }
  }
  return { failures, sessions: rows.length };
}

const loaded = loadFailures();
if (loaded.error) {
  console.error(loaded.error);
  process.exit(2);
}

const { failures, sessions } = loaded;
console.log("WHAT THE AGENT LEARNS FROM ITS OWN FAILURES");
console.log(`  ${failures.length} failed tool calls across ${sessions} real sessions\n`);

const before = new Map();
const after = new Map();
let boundaries = 0;
const shapes = new Map();
for (const failure of failures) {
  const shape = `${failure.tool} :: ${shapeOf(failure.text)}`;
  shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  const old = historicalClass(failure.text);
  before.set(old, (before.get(old) ?? 0) + 1);
  // The real thing, through the exported classifier — not a copy of it, so this
  // cannot drift away from what the loop actually does.
  const verdict = classifyFailureForLearning({ text: failure.text });
  if (!verdict.learnable) {
    boundaries += 1;
    continue;
  }
  after.set(verdict.failureClass, (after.get(verdict.failureClass) ?? 0) + 1);
}

const table = (counts, total) => [...counts.entries()]
  .sort((left, right) => right[1] - left[1])
  .map(([name, count]) => `    ${String(count).padStart(4)}  ${String(Math.round((count / total) * 100)).padStart(3)}%  ${name}`)
  .join("\n");

console.log("  BEFORE — the taxonomy as it stood to 3 Sep 2026");
console.log(table(before, failures.length));
console.log(`\n  AFTER — derived from these very failures, ${boundaries} excluded as boundaries`);
console.log(table(after, failures.length));

const catchAllBefore = before.get("tool-failed") ?? 0;
const catchAllAfter = after.get("tool-failed") ?? 0;
console.log("\nTHE ONE NUMBER THAT MATTERS");
console.log(`  failures that taught nothing:  ${catchAllBefore} (${Math.round(catchAllBefore / failures.length * 100)}%)` +
  `  ->  ${catchAllAfter} (${Math.round(catchAllAfter / failures.length * 100)}%)`);
console.log(`  refusals no longer learned as techniques to route around: ${boundaries}`);
console.log("  A taxonomy whose commonest member is the catch-all is not a taxonomy.");

if (showShapes) {
  console.log("\nFAILURE SHAPES, content stripped, commonest first");
  for (const [shape, count] of [...shapes.entries()].sort((left, right) => right[1] - left[1]).slice(0, 25)) {
    console.log(`  ${String(count).padStart(4)}  ${shape}`);
  }
}
