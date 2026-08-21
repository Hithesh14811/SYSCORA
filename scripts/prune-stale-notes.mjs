#!/usr/bin/env node
// Drop remembered facts that name a path which no longer exists.
//
// SYSCORA's notes go into EVERY prompt. When the state directory moved into a
// package container, the agent correctly worked out that Notepad and Paint
// could not save there and wrote three facts saying so. Those facts were true,
// useful, and are now false — the directory they name is gone — and a false fact
// in the prompt is not inert: the eval's file rows began spending an extra turn
// verifying every write, and skill-replay-file-write went 19,025 -> 30,175
// tokens sent with no code change at all.
//
// Deliberately narrow. It removes a fact ONLY when the fact names an absolute
// path that does not exist any more. It does not try to judge whether a fact is
// still true in general — that is the agent's job, not a script's, and a cleaner
// that deletes memories on a heuristic is worse than a stale memory.
//
//   node scripts/prune-stale-notes.mjs           # dry run
//   node scripts/prune-stale-notes.mjs --apply
import fs from "node:fs";
import { notesPath } from "../packages/fast-agent/src/notes.js";
import { redirectedTarget } from "../packages/shared-types/src/state-path.js";

// "DOES THE PATH EXIST" IS THE WRONG QUESTION, AND ASKING IT FOUND NOTHING.
//
// The stale facts name `C:\Users\hithe\AppData\Local\SYSCORA\eval-workspace`,
// which still exists — that is the whole problem with it. From inside the
// package container it resolves happily; from Notepad's Save dialog it does not.
// So a path is dead to us if it is missing OR if it resolves into somebody
// else's container, which is the same signal the state resolver now uses.
function unusable(target) {
  const clean = target.replace(/[.,;)]+$/, "");
  if (!fs.existsSync(clean)) return "no longer exists";
  const real = redirectedTarget(clean);
  if (real && /[\\/]Packages[\\/][^\\/]+[\\/]LocalCache/i.test(real)) {
    return `resolves into an application container (${real})`;
  }
  return null;
}

const apply = process.argv.includes("--apply");
const file = notesPath(process.cwd());
if (!fs.existsSync(file)) {
  console.log(`no notes at ${file}`);
  process.exit(0);
}

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const kept = [];
const dropped = [];
for (const line of lines) {
  const isFact = /^\s*[-*]\s/.test(line);
  if (!isFact) { kept.push(line); continue; }
  // Absolute Windows paths named inside the fact.
  const paths = line.match(/[A-Za-z]:\\[^\s,;"'`)]+/g) ?? [];
  const dead = paths.map((p) => [p, unusable(p)]).filter(([, why]) => why);
  if (dead.length > 0) dropped.push({ line, dead });
  else kept.push(line);
}

console.log(`notes: ${file}`);
console.log(`facts kept: ${kept.filter((l) => /^\s*[-*]\s/.test(l)).length}, dropped: ${dropped.length}\n`);
for (const d of dropped) {
  console.log(`  DROP ${d.line.trim().slice(0, 96)}`);
  console.log(`       because ${d.dead[0][0]} ${d.dead[0][1]}`);
}
if (dropped.length === 0) { console.log("  nothing stale"); process.exit(0); }

if (!apply) { console.log("\nDRY RUN. Re-run with --apply."); process.exit(0); }

fs.copyFileSync(file, `${file}.bak`);
fs.writeFileSync(file, kept.join("\n"), "utf8");

// Read it back, through a fresh read of the file rather than from the array we
// just wrote — the same rule the rest of this codebase runs on.
const after = fs.readFileSync(file, "utf8");
const stillThere = dropped.filter((d) => after.includes(d.line.trim()));
console.log(`\nwrote ${file} (previous kept as ${file}.bak)`);
console.log(stillThere.length === 0
  ? `verified: ${dropped.length} stale fact(s) gone, ${after.split(/\r?\n/).filter((l) => /^\s*[-*]\s/.test(l)).length} remain`
  : `VERIFICATION FAILED: ${stillThere.length} still present`);
process.exit(stillThere.length === 0 ? 0 : 1);
