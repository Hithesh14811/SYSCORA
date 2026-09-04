// WHAT IS ACTUALLY REACHABLE FROM THE THINGS THAT RUN?
//
//   node scripts/probe-reachability.mjs
//   node scripts/probe-reachability.mjs --package packages/planner
//   node scripts/probe-reachability.mjs --importers packages/reasoning-engine/src/index.js
//
// WHY THIS EXISTS. This repository is about to have several thousand lines
// deleted, and every previous statement about what is dead here has been made by
// reading and has been wrong in at least one direction. The 22 Aug audit said
// "21,347 lines across the offline-pipeline packages" and then found, by
// checking, that `fast-agent` imports `capability-registry` for one helper and
// that `runCapability` resolves through the registry — so the registry is on the
// hot path and the real figure was 12-14k. That correction was worth more than
// the original number, and it was found by following imports rather than by
// classifying packages by name.
//
// So this follows imports. From the entry points that actually start — the
// daemon, the Electron shell, the CLI, the eval runner — it walks every static
// `import` and reports three populations:
//
//   HOT        reachable from the agent loop, which is the route every real
//              request takes
//   FALLBACK   reachable only through the offline staged pipeline, which answers
//              when no model can be reached
//   UNREACHED  not reachable from any entry point at all
//
// THE THREE ARE NOT THE SAME DECISION AND MUST NOT BE PRESENTED AS ONE.
// Deleting UNREACHED changes no behaviour by definition. Deleting FALLBACK
// changes what happens when the endpoint is down, which is a product decision
// somebody has to actually make — and this machine's own session store records
// the fallback being reached 5 times in 178 real sessions, so "it is never used"
// is false.
//
// WHAT IT CANNOT SEE, said plainly: dynamic `import()` with a computed
// specifier, and anything reached by string name through a registry. Both exist
// in this codebase — the capability registry dispatches on names — so a package
// this reports as UNREACHED still has to be grepped for its exported names
// before anything is deleted. This narrows the search; it does not end it.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
};

// The things that actually start a process. Anything not reachable from one of
// these is not running in the product, whatever else is true of it.
// `apps/desktop/demo.js` IS AN ENTRY POINT, and leaving it out reported 6,501
// lines of live chat surface as unreachable. It is not imported by anything in
// Node: demo.html loads it with `<script src="/demo.js">` and it pulls in the
// rest of the panel as ES modules from the browser. A reachability walk that
// only knows about Node's entry points will confidently offer to delete the
// entire user interface.
const ENTRY_POINTS = [
  "apps/daemon/src/server.js",
  "apps/daemon/src/index.js",
  "apps/desktop-shell/src/main.js",
  "apps/desktop/demo.js",
  "apps/cli/src/index.js",
  "tests/eval/runner.mjs"
];

// The agent loop. Everything reachable from here is on the route a real request
// takes, and is not a deletion candidate under any argument.
const HOT_ROOT = "packages/fast-agent/src/index.js";

// The offline staged pipeline's own entry. Reachable from `agent-runtime`, which
// also hosts the loop — so the package cannot be classified as a whole, only
// its files.
const FALLBACK_ROOTS = [
  "packages/agent-runtime/src/interactive-agent-controller.js",
  "packages/planner/src/index.js",
  "packages/reasoning-engine/src/index.js"
];

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // node: builtins and bare packages
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*|import\s*)["']([^"']+)["']/g;
const DYNAMIC_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); } catch { return []; }
  const found = new Set();
  for (const pattern of [IMPORT_PATTERN, DYNAMIC_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) found.add(resolved);
    }
  }
  return [...found];
}

/**
 * Every file reachable by static import from these roots.
 *
 * `stopAt` is what makes the FALLBACK question answerable. Walking from the
 * entry points normally reaches the staged pipeline AND everything the pipeline
 * imports, so a shared dependency looks pipeline-only. Walking again while
 * refusing to enter the pipeline's own files gives the set reachable WITHOUT it,
 * and the difference is what is genuinely reachable only through it.
 *
 * The first version of this had no `stopAt` and reported `model-providers` — the
 * 2,002 lines that talk to the model, imported directly by the daemon's own
 * runtime factory — as reachable only via the offline fallback. Deleting on that
 * basis would have removed the thing every request depends on.
 */
function walk(roots, stopAt = new Set()) {
  const seen = new Set();
  const queue = roots.map((root) => path.resolve(ROOT, root)).filter((file) => fs.existsSync(file));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (stopAt.has(file)) continue;
    for (const next of importsOf(file)) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

function everySourceFile() {
  const files = [];
  const skip = new Set(["node_modules", ".git", "dist", "release", "artifacts", "anaconda_projects"]);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  visit(path.join(ROOT, "packages"));
  visit(path.join(ROOT, "apps"));
  visit(path.join(ROOT, "os-adapters"));
  return files;
}

const lineCount = (file) => {
  try { return fs.readFileSync(file, "utf8").split("\n").length; } catch { return 0; }
};

// --importers: who pulls this file in? The question that actually matters before
// deleting something.
const importersTarget = flag("importers");
if (importersTarget) {
  const target = path.resolve(ROOT, importersTarget);
  const importers = everySourceFile().filter((file) => importsOf(file).includes(target));
  console.log(`IMPORTERS OF ${rel(target)}`);
  if (!importers.length) console.log("  (nothing imports it by a static path)");
  for (const file of importers) console.log(`  ${rel(file)}`);
  process.exit(0);
}

const fallbackFiles = new Set(FALLBACK_ROOTS.map((root) => path.resolve(ROOT, root)));
const fromEntries = walk(ENTRY_POINTS);
// The same walk, refusing to step into the staged pipeline. Everything the
// product still reaches with the pipeline gone.
const withoutFallback = walk(ENTRY_POINTS, fallbackFiles);
const fromHot = walk([HOT_ROOT]);
const all = everySourceFile();

const classify = (file) => {
  if (fromHot.has(file)) return "HOT";
  if (!fromEntries.has(file)) return "UNREACHED";
  // Reachable, but ONLY by going through the pipeline. `withoutFallback`
  // contains the pipeline's own root files (the walk stops AT them rather than
  // before them), so those are named explicitly.
  if (fallbackFiles.has(file)) return "FALLBACK";
  return withoutFallback.has(file) ? "REACHED" : "FALLBACK";
};

const packageOf = (file) => {
  const parts = rel(file).split("/");
  return parts.slice(0, 2).join("/");
};

const byPackage = new Map();
for (const file of all) {
  const bucket = byPackage.get(packageOf(file)) ?? { HOT: 0, REACHED: 0, FALLBACK: 0, UNREACHED: 0, lines: {} };
  const verdict = classify(file);
  bucket[verdict] += lineCount(file);
  bucket.lines[verdict] = (bucket.lines[verdict] ?? 0) + 1;
  byPackage.set(packageOf(file), bucket);
}

const only = flag("package");
console.log("REACHABILITY — static imports, from the entry points that actually start");
console.log(`  entry points   ${ENTRY_POINTS.length}`);
console.log(`  source files   ${all.length}`);
console.log("");
console.log("  HOT        on the agent loop's own import graph — never a deletion candidate");
console.log("  REACHED    reachable from an entry point but not from the loop");
console.log("  FALLBACK   reachable only through the offline staged pipeline");
console.log("  UNREACHED  no static path from any entry point\n");

const header = `${"package".padEnd(38)}${"HOT".padStart(8)}${"REACHED".padStart(9)}${"FALLBACK".padStart(10)}${"UNREACHED".padStart(11)}`;
console.log(header);
console.log("-".repeat(header.length));
let totals = { HOT: 0, REACHED: 0, FALLBACK: 0, UNREACHED: 0 };
for (const [name, bucket] of [...byPackage.entries()].sort()) {
  if (only && !name.startsWith(only)) continue;
  for (const key of Object.keys(totals)) totals[key] += bucket[key];
  console.log(
    name.padEnd(38) +
    String(bucket.HOT || "").padStart(8) +
    String(bucket.REACHED || "").padStart(9) +
    String(bucket.FALLBACK || "").padStart(10) +
    String(bucket.UNREACHED || "").padStart(11)
  );
}
console.log("-".repeat(header.length));
console.log(
  "TOTAL LINES".padEnd(38) +
  String(totals.HOT).padStart(8) + String(totals.REACHED).padStart(9) +
  String(totals.FALLBACK).padStart(10) + String(totals.UNREACHED).padStart(11)
);

console.log("\nBEFORE DELETING ANYTHING");
console.log("  UNREACHED is the only population whose removal cannot change behaviour, and even");
console.log("  then only after grepping its exported names: this walk cannot see a capability");
console.log("  dispatched by string through the registry, and this codebase does exactly that.");
console.log("  FALLBACK is reachable. The session store on this machine records the offline");
console.log("  pipeline answering 5 times in 178 real sessions — deleting it is a product");
console.log("  decision about what happens when the model endpoint is down, not a cleanup.");
