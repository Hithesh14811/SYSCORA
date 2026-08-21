#!/usr/bin/env node
// Move SYSCORA's working state out of the cloud-synced folder.
//
// WHY: `.syscora/` sat at C:\Users\hithe\OneDrive\Documents\SYSCORA\.syscora —
// 2.07 GB of databases rewritten on every agent turn, inside OneDrive, which
// does not read .gitignore. Plus API keys in plaintext, uploaded.
//
// THIS SCRIPT COPIES. IT NEVER MOVES AND NEVER DELETES.
// The 1,834 sessions in there are the user's own conversations. The old
// directory is left exactly as it was; removing it is a separate, explicit act
// once they have seen the product working from the new location.
//
//   node scripts/migrate-state-dir.mjs            # dry run: says what it would do
//   node scripts/migrate-state-dir.mjs --apply    # copy, verify, write the pointer
//   node scripts/migrate-state-dir.mjs --apply --target "D:\\somewhere"
//
// It NEVER prints file contents. `.syscora/config.json` holds keys.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  defaultStateDir,
  cloudSyncedRoot,
  STATE_POINTER_FILENAME,
  LEGACY_STATE_DIRNAME
} from "../packages/shared-types/src/state-path.js";

const apply = process.argv.includes("--apply");
const targetArg = process.argv[process.argv.indexOf("--target") + 1];
const repoRoot = path.resolve(process.argv[2]?.startsWith("--") ? "." : (process.argv[2] ?? "."));
const source = path.join(repoRoot, LEGACY_STATE_DIRNAME);
const target = process.argv.includes("--target") ? path.resolve(targetArg) : defaultStateDir();
const pointerFile = path.join(repoRoot, STATE_POINTER_FILENAME);

const mb = (n) => (n / 1024 / 1024).toFixed(1);

async function walk(dir, base = dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push({ rel: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// A copy taken while the daemon is mid-write is a torn database, and SQLite will
// not always tell you so. This does not kill anything — the house rule is to ask
// before closing an app the user has open — it names what it found and stops.
function processesHoldingState() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='electron.exe'\" "
      + "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { encoding: "utf8", timeout: 30_000 });
    const rows = JSON.parse(out || "[]");
    const list = Array.isArray(rows) ? rows : [rows];
    const needle = repoRoot.toLowerCase();
    return list.filter((p) => {
      const cmd = String(p?.CommandLine ?? "").toLowerCase();
      if (p?.ProcessId === process.pid) return false;
      if (cmd.includes("migrate-state-dir")) return false;
      return cmd.includes(needle) || cmd.includes("syscora");
    });
  } catch {
    return []; // not being able to look is not evidence that nothing is running
  }
}

if (!fs.existsSync(source)) {
  console.error(`Nothing to migrate: ${source} does not exist.`);
  process.exit(1);
}

const files = await walk(source);
const total = files.reduce((n, f) => n + f.size, 0);
const synced = cloudSyncedRoot(source);

console.log(`source      ${source}`);
console.log(`            ${files.length} files, ${mb(total)} MB`);
console.log(`            ${synced ? `INSIDE the synced folder ${synced}` : "not in a synced folder"}`);
console.log(`target      ${target}`);
console.log(`pointer     ${pointerFile}`);
console.log("");

const holders = processesHoldingState();
if (holders.length > 0) {
  console.log("STILL RUNNING — these have SYSCORA's databases open:");
  for (const p of holders) console.log(`  pid ${p.ProcessId}  ${String(p.CommandLine).slice(0, 110)}`);
  console.log("");
  console.log("  Copying a SQLite file mid-write produces a torn database that opens");
  console.log("  cleanly and is wrong. Close the SYSCORA desktop app / daemon first.");
  console.log("  (Not killing them from here: that is the user's call.)");
  if (apply) process.exit(2);
}

if (fs.existsSync(target) && (await walk(target)).length > 0) {
  console.error(`REFUSING: ${target} already exists and is not empty.`);
  console.error("Migrating onto existing state would merge two histories silently.");
  process.exit(3);
}

if (!apply) {
  console.log("DRY RUN. Nothing copied. Re-run with --apply to do it.");
  console.log(`Would copy ${files.length} files (${mb(total)} MB), verify every one by SHA-256,`);
  console.log(`then write ${STATE_POINTER_FILENAME}. The source is left untouched either way.`);
  process.exit(0);
}

console.log("copying ...");
let done = 0;
for (const f of files) {
  const from = path.join(source, f.rel);
  const to = path.join(target, f.rel);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  done += 1;
  if (f.size > 50 * 1024 * 1024) console.log(`  ${mb(f.size).padStart(8)} MB  ${f.rel}`);
}
console.log(`copied ${done} files`);

// VERIFY. A file count and a byte total both pass on a truncated copy of the
// right length; only the content proves it arrived. This is the same rule the
// rest of the codebase runs on — the check must not be the thing it checks.
console.log("verifying by SHA-256 ...");
const bad = [];
for (const f of files) {
  const from = path.join(source, f.rel);
  const to = path.join(target, f.rel);
  if (!fs.existsSync(to)) { bad.push([f.rel, "missing at target"]); continue; }
  const a = sha256(from);
  const b = sha256(to);
  if (a !== b) bad.push([f.rel, `hash differs (source may have been written during the copy)`]);
}

if (bad.length > 0) {
  console.error(`\nVERIFICATION FAILED on ${bad.length} of ${files.length} files:`);
  for (const [rel, why] of bad) console.error(`  ${rel} — ${why}`);
  console.error(`\nNO POINTER WRITTEN. ${source} is still the live state directory.`);
  console.error(`Delete ${target} and re-run with everything closed.`);
  process.exit(4);
}
console.log(`verified ${files.length}/${files.length} files byte-identical`);

await fsp.writeFile(pointerFile,
  `# Where SYSCORA keeps its working state. Written by scripts/migrate-state-dir.mjs.\n`
  + `# It was moved out of ${synced ?? "the repository"} because every agent turn\n`
  + `# rewrites databases here and a sync client re-uploads them continuously.\n`
  + `${target}\n`, "utf8");
console.log(`\nwrote ${pointerFile} -> ${target}`);
console.log(`\n${source} is UNTOUCHED. Delete it yourself once the product has run from the new path.`);
