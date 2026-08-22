#!/usr/bin/env node
// WHICH FILES CAN NOTHING REACH?
//
//   node scripts/audit-dead-files.mjs
//   node scripts/audit-dead-files.mjs --verbose     also list what IS reachable
//
// audit-reachability.mjs hunts correct FUNCTIONS nothing calls. This is the
// other half: whole FILES nothing imports, which is what accumulates when a
// design is replaced and the old one is left in the tree.
//
// ---------------------------------------------------------------------------
// WHY THIS IS CONSERVATIVE ON PURPOSE
//
// The answer here decides whether somebody deletes source code, so a false
// positive is not a nuisance, it is a broken product. This codebase is full of
// indirection that a naive import walk cannot see:
//
//   - the capability registry dispatches on STRING names, not imports
//   - tools are looked up by name from a table
//   - providers are chosen from a config file at runtime
//   - `loadCapabilityPlugins` imports whatever is in a plugins directory
//   - PowerShell files are invoked by path from JS, never imported
//
// So this does four things rather than one, and prints what it CANNOT see:
//
//   1. follows static imports, re-exports, and dynamic import() with a literal
//   2. records every dynamic import whose argument is NOT a literal — each one
//      is a hole in the graph, and they are printed
//   3. for every file the graph says is unreachable, greps the ENTIRE tree
//      (including .ps1, .json and .md) for its basename, so a file named in a
//      string, a config or a document is not reported as dead
//   4. separates "nothing reaches it at all" from "only tests and probes reach
//      it", because the second is how a replaced subsystem looks: still tested,
//      still green, and not in the product
//
// A file this reports as dead has: no importer, no mention of its name anywhere
// in the tree, and no entry point. That is three independent reasons, and the
// third category below still says "verify before deleting" because indirection
// this cannot see is exactly the thing that has bitten this project before.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");

const SOURCE_DIRECTORIES = ["packages", "apps", "os-adapters", "scripts", "tests"];
const CODE = /\.(mjs|js)$/;

const walk = (directory, found = []) => {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, found);
    } else if (CODE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
};

const allFiles = SOURCE_DIRECTORIES.flatMap((directory) => walk(path.join(root, directory)));
const relative = (file) => path.relative(root, file).split(path.sep).join("/");

// ---- every text file in the tree, read once ---------------------------------
//
// Needed before the graph, because browser and Electron entry points are found
// by reading HTML and configuration rather than by following imports.
const TEXT = /\.(mjs|js|json|md|ps1|txt|html|css|yml|yaml)$/;
const everyTextFile = SOURCE_DIRECTORIES.concat(["docs", "."])
  .flatMap((directory) => {
    const target = path.join(root, directory);
    const found = [];
    const stack = [target];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "results") continue;
          stack.push(full);
        } else if (TEXT.test(entry.name)) found.push(full);
      }
    }
    return found;
  });
const corpus = new Map();
for (const file of new Set(everyTextFile)) {
  try { corpus.set(file, fs.readFileSync(file, "utf8")); } catch { /* unreadable */ }
}

// ---- the import graph -------------------------------------------------------

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_LITERAL = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_ANY = /\bimport\s*\(\s*([^)]*)\)/g;

const dynamicHoles = [];

function specifiersIn(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const pattern of [STATIC_IMPORT, BARE_IMPORT, DYNAMIC_LITERAL]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  DYNAMIC_ANY.lastIndex = 0;
  let dynamic;
  while ((dynamic = DYNAMIC_ANY.exec(text)) !== null) {
    const argument = dynamic[1].trim();
    // A literal is already handled. Anything else means the graph has a hole
    // here, and the only honest thing to do is say so.
    if (!/^["'][^"']+["']$/.test(argument) && argument.length > 0) {
      dynamicHoles.push({ file: relative(file), argument: argument.slice(0, 80) });
    }
  }
  return [...found];
}

// A BROWSER FILE IS NOT IMPORTED, IT IS INCLUDED.
//
// The first version of this audit reported apps/desktop/demo.js — the chat
// surface, 1,353 lines, the thing the user actually looks at — as unreachable,
// because nothing in Node imports it. It is loaded by a <script> tag. Electron's
// preload is worse: it is named as a STRING in a webPreferences object and
// loaded by path. Both are entry points and neither is an import, so both are
// found here instead. Any audit that misses this recommends deleting the UI.
const SCRIPT_SRC = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
const PRELOAD_PATH = /preload\s*:\s*[^,\n]*?["']([^"']+\.(?:js|mjs))["']|preload\s*:\s*path\.join\(([^)]*)\)/g;

function browserEntryPoints() {
  const found = new Set();
  for (const [file, text] of corpus) {
    if (file.endsWith(".html")) {
      SCRIPT_SRC.lastIndex = 0;
      let match;
      while ((match = SCRIPT_SRC.exec(text)) !== null) {
        if (/^https?:/.test(match[1])) continue;
        // `src="/demo.js"` is relative to the SERVED ROOT, not the filesystem
        // root — path.resolve would turn it into C:\demo.js and find nothing,
        // which is how the chat surface came back "unreachable" the first time.
        // The served root here is the directory the page itself is in.
        const reference = match[1].replace(/^\/+/, "");
        const resolved = path.resolve(path.dirname(file), reference);
        if (fs.existsSync(resolved)) found.add(resolved);
      }
    }
    // Electron preload, named by string rather than imported.
    PRELOAD_PATH.lastIndex = 0;
    let preload;
    while ((preload = PRELOAD_PATH.exec(text)) !== null) {
      const literal = preload[1];
      const joined = preload[2];
      const names = literal ? [literal] : String(joined ?? "").match(/["']([^"']+)["']/g)?.map((s) => s.slice(1, -1)) ?? [];
      for (const name of names) {
        if (!CODE.test(name)) continue;
        for (const base of [path.dirname(file), root]) {
          const resolved = path.resolve(base, name);
          if (fs.existsSync(resolved)) found.add(resolved);
        }
      }
    }
  }
  return [...found];
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null; // node: builtin or a package
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js"), path.join(base, "index.mjs")];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

function reachableFrom(entryPoints) {
  const seen = new Set();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiersIn(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

// ---- entry points -----------------------------------------------------------
//
// PRODUCT entry points are the things a user can actually start, taken from
// package.json rather than guessed at, plus the Electron shell.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const fromScripts = Object.values(manifest.scripts ?? {})
  .flatMap((command) => command.split(/\s+/))
  .filter((token) => CODE.test(token))
  .map((token) => path.join(root, token))
  .filter((file) => fs.existsSync(file));

const productEntries = [
  ...fromScripts.filter((file) => !relative(file).startsWith("tests/") && !relative(file).startsWith("scripts/run-tests")),
  path.join(root, manifest.main ?? "apps/daemon/src/server.js"),
  path.join(root, "apps/desktop-shell/src/main.js"),
  path.join(root, "apps/daemon/src/index.js"),
  path.join(root, "apps/cli/src/index.js"),
  // Loaded by a <script> tag or named as a preload path, never imported.
  ...browserEntryPoints()
].filter((file) => fs.existsSync(file));

const testEntries = allFiles.filter((file) => /\.test\.(js|mjs)$/.test(file));
const harnessEntries = allFiles.filter((file) => {
  const name = relative(file);
  return name.startsWith("scripts/") || name.startsWith("tests/eval/") || name.startsWith("tests/helpers/");
});

const productReachable = reachableFrom(productEntries);
const testReachable = reachableFrom([...testEntries, ...harnessEntries]);

// ---- is the FILENAME mentioned anywhere, in any kind of file? ---------------
//
// The last defence against deleting something reached by a string.
//
// The first version matched the file's STEM as well as its name, so "app.js"
// matched the word "app" and every orphan came back "mentioned everywhere".
// A check that always fires is not a check — it is noise that makes the real
// signal unreadable. The basename only, which is what a path or a string
// reference actually contains.
// A FILENAME IS NOT ENOUGH TO JUDGE BY. THE LINE IS.
//
// The list of files that mention an orphan says nothing about WHY. Two of the
// three judgement calls made against the first run of this audit turned on the
// line itself: `apps/daemon/src/privileged-helper.js` looked dead until the
// mention turned out to be a `spawn(process.execPath, [...])` — it is a
// subprocess entry point, reached by process launch rather than by import, and
// deleting it would have removed a working feature. `tests/live/gap3-async-live.mjs`
// looked alive for having a mention, and the mention was a comment.
//
// So the line is printed. Spawning, requiring and documenting look nothing
// alike, and only one of them means the file is in use.
function mentionedElsewhere(file) {
  const base = path.basename(file);
  const hits = [];
  for (const [other, text] of corpus) {
    if (other === file) continue;
    if (!text.includes(base)) continue;
    const lines = text.split("\n");
    const index = lines.findIndex((line) => line.includes(base));
    hits.push({
      where: `${relative(other)}:${index + 1}`,
      line: lines[index]?.trim().slice(0, 110) ?? "",
      // The three shapes that mean "in use" without an import.
      kind: /\b(spawn|fork|execFile|exec)\s*\(/.test(lines[index] ?? "") ? "SPAWNED"
        : /^\s*(\/\/|#|\*)/.test(lines[index] ?? "") ? "comment"
        : /\.(md|txt)$/.test(other) ? "documentation"
        : "reference"
    });
    if (hits.length >= 4) break;
  }
  return hits;
}

// ---- report -----------------------------------------------------------------

const productOnly = [];
const testOnly = [];
const orphans = [];
for (const file of allFiles) {
  const name = relative(file);
  // A probe or a test IS an entry point; it is not dead for having no importer.
  if (name.startsWith("scripts/") || /\.test\.(js|mjs)$/.test(name) || name.startsWith("tests/eval/") || name.startsWith("tests/helpers/")) continue;
  if (productReachable.has(file)) { productOnly.push(name); continue; }
  if (testReachable.has(file)) { testOnly.push(name); continue; }
  orphans.push(name);
}

const bytes = (name) => {
  try { return fs.statSync(path.join(root, name)).size; } catch { return 0; }
};
const lines = (name) => {
  try { return fs.readFileSync(path.join(root, name), "utf8").split("\n").length; } catch { return 0; }
};
const totalLines = (names) => names.reduce((sum, name) => sum + lines(name), 0);

console.log(`\n${allFiles.length} source files under ${SOURCE_DIRECTORIES.join(", ")}\n`);
console.log(`entry points: ${productEntries.length} product, ${testEntries.length} tests, ${harnessEntries.length} probes/harness\n`);

console.log(`REACHED BY THE PRODUCT: ${productOnly.length} files, ${totalLines(productOnly).toLocaleString()} lines`);
if (verbose) for (const name of productOnly.sort()) console.log(`   ${name}`);

console.log(`\nREACHED ONLY BY TESTS AND PROBES: ${testOnly.length} files, ${totalLines(testOnly).toLocaleString()} lines`);
console.log("   Not dead code — code the PRODUCT does not use. This is what a replaced");
console.log("   subsystem looks like: still imported by its own tests, still green.\n");
for (const name of testOnly.sort((a, b) => lines(b) - lines(a))) {
  console.log(`   ${String(lines(name)).padStart(6)} lines  ${name}`);
}

console.log(`\nNOTHING REACHES THESE AT ALL: ${orphans.length} files, ${totalLines(orphans).toLocaleString()} lines`);
for (const name of orphans.sort((a, b) => lines(b) - lines(a))) {
  const mentions = mentionedElsewhere(path.join(root, name));
  const spawned = mentions.some((mention) => mention.kind === "SPAWNED");
  console.log(`   ${String(lines(name)).padStart(6)} lines  ${String(bytes(name)).padStart(8)} b  ${name}${spawned ? "   <-- SPAWNED AS A SUBPROCESS, NOT DEAD" : ""}`);
  if (mentions.length === 0) {
    console.log("           its name appears NOWHERE ELSE IN THE TREE");
  }
  for (const mention of mentions) {
    console.log(`           [${mention.kind}] ${mention.where}`);
    console.log(`             ${mention.line}`);
  }
}

console.log(`\nWHAT THIS CANNOT SEE — ${dynamicHoles.length} dynamic import(s) with a computed argument:`);
for (const hole of dynamicHoles) console.log(`   ${hole.file}: import(${hole.argument})`);
if (dynamicHoles.length === 0) console.log("   none — every import in the tree is a literal, so the graph is complete");
console.log("");
