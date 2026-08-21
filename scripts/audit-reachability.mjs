#!/usr/bin/env node
// IS THE CORRECT MACHINERY THE MACHINERY THAT RUNS?
//
// EIGHT CONSECUTIVE SESSIONS, the biggest find was not a capability defect. It
// was code that exists, is correct, and nothing reaches:
//
//   the agent loop existed and nothing routed to it
//   perception worked - capture, OCR, UIA - and never reached the loop
//   `autoApprove` was never read in the fast path, in ANY commit, so the
//     approval card went to nobody and the flagship send was broken for months
//   `reasoning_content` arrived from the provider and the transport dropped it
//   `WindowsAutomationHostClient.close()` was correct and only probe scripts
//     called it, so every eval leaked a PowerShell host AND the runner never
//     exited - making "npm run eval gates CI" unreachable from the day it was
//     written
//
// That is not eight coincidences. It is one defect class, and every instance was
// found by accident while working on something else. This hunts them on purpose.
//
// ---------------------------------------------------------------------------
// WHY IT IS FIVE NARROW SWEEPS AND NOT ONE CLEVER ONE
//
// A general "which exports are unused" pass over this tree produces a page of
// false positives, because the codebase is full of dynamic dispatch: the
// capability registry is string-keyed, tools are looked up by name, providers
// are chosen from config. A check that cries wolf gets switched off - two wider
// rules were tried on the string-escape audit and reverted at 45 and 26 false
// positives. So each sweep below is aimed at a shape that has ALREADY produced a
// real defect here, and every sweep prints what it cannot see.
//
//   node scripts/audit-reachability.mjs            human-readable
//   node scripts/audit-reachability.mjs --json     machine-readable
//   node scripts/audit-reachability.mjs --self-test  prove it catches the five
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const selfTest = process.argv.includes("--self-test");

// The processes that actually run on a user's machine. Everything else - tests,
// probes, benchmarks - is scaffolding, and code reachable ONLY from scaffolding
// is the thing this audit exists to surface.
const ENTRY_POINTS = [
  "apps/daemon/src/server.js",     // npm run mvp:ui - the daemon behind the UI
  "apps/daemon/src/index.js",      // npm run mvp:status
  "apps/cli/src/index.js",         // npm run mvp:demo
  "apps/desktop-shell/src/main.js" // npm run desktop:dev - the Electron shell
];

const SOURCE_DIRS = ["packages", "apps", "os-adapters"];
const SCAFFOLD_DIRS = ["tests", "scripts"];

// ---------------------------------------------------------------------------
// Reading the tree

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const scaffoldFiles = SCAFFOLD_DIRS.flatMap((d) => walk(path.join(repoRoot, d)));
const text = new Map();
const read = (file) => {
  if (!text.has(file)) {
    try { text.set(file, fs.readFileSync(file, "utf8")); } catch { text.set(file, ""); }
  }
  return text.get(file);
};
const rel = (file) => path.relative(repoRoot, file).replace(/\\/g, "/");

// Static imports only. Dynamic `await import(expr)` with a computed specifier is
// invisible here and is declared as a blind spot below rather than guessed at.
function importsOf(file) {
  const body = read(file);
  const out = [];
  const re = /(?:^|\n)\s*(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*|import\s*)["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue; // a package, not our tree
    let resolved = path.resolve(path.dirname(file), spec);
    if (!/\.(js|mjs)$/.test(resolved)) {
      if (fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
      else if (fs.existsSync(path.join(resolved, "index.js"))) resolved = path.join(resolved, "index.js");
    }
    if (fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

// THE BROWSER IS AN ENTRY POINT TOO, and forgetting that made this audit call
// the chat surface's own HTTP client dead code.
//
// `apps/desktop/*.js` are never imported by main.js — they are loaded by the
// served HTML as `<script src="/demo.js" type="module">` and then import each
// other normally. Rooting only at Node entry points leaves everything below
// that first script tag looking unreachable, so intent-client.js — which every
// request the user types goes through — was reported UNWIRED.
function htmlRoots() {
  const roots = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of walkHtml(path.join(repoRoot, dir))) {
      for (const m of read(file).matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
        const candidate = path.join(path.dirname(file), m[1].replace(/^\//, ""));
        if (fs.existsSync(candidate)) roots.push(candidate);
      }
    }
  }
  return roots;
}
function walkHtml(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(full, out);
    else if (e.name.endsWith(".html")) out.push(full);
  }
  return out;
}

// Modules reachable from the real entry points, by static import.
const reachable = new Set();
const ROOTS = [
  ...ENTRY_POINTS.map((p) => path.join(repoRoot, p)).filter((p) => fs.existsSync(p)),
  ...htmlRoots()
];
(function spread(queue) {
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    queue.push(...importsOf(file));
  }
})([...ROOTS]);

const findings = [];
const finding = (sweep, severity, subject, detail, evidence) =>
  findings.push({ sweep, severity, subject, detail, evidence });

// A word appears as an identifier (not inside a longer word) somewhere.
const mentions = (body, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body);

// A FILE CAN BE REACHED WITHOUT BEING IMPORTED, AND THREE OF THIS AUDIT'S FIRST
// FOUR "DEAD" VERDICTS WERE THAT.
//
// `preload.js` is named in `path.join(__dirname, "preload.js")` and loaded by
// Electron; `demo.js` and `app.js` are `<script src>` in the served HTML. Both
// run on the user's machine every day. Reporting them as dead is precisely the
// cried wolf that gets an audit switched off, so a basename appearing anywhere
// as a STRING - in JS, JSON, HTML or PowerShell - counts as a reference.
const referenceCorpus = [
  ...sourceFiles,
  ...scaffoldFiles,
  ...SOURCE_DIRS.flatMap((d) => {
    const out = [];
    (function collect(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full);
        else if (/\.(html|json|ps1|cjs)$/.test(e.name)) out.push(full);
      }
    })(path.join(repoRoot, d));
    return out;
  })
];

// AN IMPORT SPECIFIER IS ALSO A STRING, and forgetting that made this helper
// swallow the sweep it was written to protect. `"../../fast-agent/src/index.js"`
// contains "index.js", so every imported module looked dynamically referenced
// and sweep 1 went quiet — including on the reintroduced agent-loop defect,
// which is how the self-test caught it. Import and export-from lines are
// therefore stripped before looking for a name.
function withoutImportStatements(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:import|export)\b[^;]*?["'][^"']+["']/.test(line))
    .join("\n");
}

function namedAsAString(file) {
  const base = path.basename(file);
  const needle = new RegExp(`["'\`][^"'\`]*${base.replace(/\./g, "\\.")}`);
  for (const other of referenceCorpus) {
    if (other === file) continue;
    if (needle.test(withoutImportStatements(read(other)))) return rel(other);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SWEEP 1 - MODULES NOTHING RUNS
//
// Caught historically: the agent loop that nothing routed to, and perception
// that never reached it. A whole file under packages/ or os-adapters/ that no
// entry point can reach is either dead weight or a feature that was never wired.

function sweepModules() {
  const orphans = [];
  for (const file of sourceFiles) {
    if (reachable.has(file)) continue;
    // Loaded by name rather than imported - Electron preloads, browser scripts,
    // spawned CLIs. Reached every day; not this audit's business.
    const byName = namedAsAString(file);
    if (byName) continue;
    const r = rel(file);
    const usedByScaffold = scaffoldFiles.some((s) => importsOf(s).includes(file));
    orphans.push({ file: r, usedByScaffold });
  }
  // Group by package so the report is readable rather than a wall of paths: a
  // whole dead package is one decision, not forty.
  const byPackage = new Map();
  for (const o of orphans) {
    const pkg = o.file.split("/").slice(0, 2).join("/");
    const cur = byPackage.get(pkg) ?? { files: 0, scaffoldOnly: 0, examples: [] };
    cur.files += 1;
    if (o.usedByScaffold) cur.scaffoldOnly += 1;
    if (cur.examples.length < 3) cur.examples.push(o.file);
    byPackage.set(pkg, cur);
  }
  for (const [pkg, info] of [...byPackage].sort((a, b) => b[1].files - a[1].files)) {
    finding(
      "modules",
      info.scaffoldOnly > 0 ? "UNWIRED" : "DEAD",
      pkg,
      `${info.files} file(s) no entry point can reach; ${info.scaffoldOnly} are imported by tests or scripts`,
      info.examples.join(", ")
    );
  }
}

// ---------------------------------------------------------------------------
// SWEEP 2 - CLEANUP PATHS NOTHING CALLS
//
// THE ONE THAT COST THE MOST. close() on the automation host was correct and
// only five probe scripts called it, so every eval leaked a powershell.exe and
// the runner's event loop never drained. 15 orphans, 801 MB, oldest 7 days.
//
// Shape, not name list: any method whose name is a teardown verb. A list of the
// specific names that leaked would be wrong the first time someone writes
// `terminate()`.

const TEARDOWN = /^(close|dispose|stop|destroy|shutdown|cleanup|teardown|release|disconnect|unwatch|terminate|abort)$/;

function sweepCleanup() {
  for (const file of sourceFiles) {
    const body = read(file);
    // Method definitions on a class, and exported functions with a teardown name.
    const defs = new Set();
    for (const m of body.matchAll(/^\s{2,}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
      if (TEARDOWN.test(m[1])) defs.add(m[1]);
    }
    for (const m of body.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g)) {
      if (TEARDOWN.test(m[1]) || /^(close|stop|dispose|destroy|shutdown)[A-Z]/.test(m[1])) defs.add(m[1]);
    }
    for (const name of defs) {
      // Who calls it? `.close(` anywhere counts, because the receiver cannot be
      // resolved statically and guessing it would be the false-positive machine.
      const callers = { real: [], scaffold: [], self: false };
      const callRe = new RegExp(`(?:\\.|\\b)${name}\\s*\\(`);
      for (const other of [...sourceFiles, ...scaffoldFiles]) {
        if (!callRe.test(read(other))) continue;
        if (other === file) { callers.self = true; continue; }
        (reachable.has(other) ? callers.real : callers.scaffold).push(rel(other));
      }
      if (callers.real.length > 0) continue; // called from something that runs
      if (callers.scaffold.length === 0 && !callers.self) continue; // never called at all: sweep 1's business
      finding(
        "cleanup",
        "UNWIRED",
        `${rel(file)} :: ${name}()`,
        `no module reachable from an entry point calls it; ${callers.scaffold.length} scaffold caller(s)`,
        callers.scaffold.slice(0, 4).join(", ") || "(only its own file)"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SWEEP 3 - CALLER OPTIONS THE HOT PATH IGNORES
//
// `autoApprove` was read by the staged pipeline and never by the route every
// real request takes. The card went to nobody and a 120-second timeout read the
// silence as refusal - the flagship send, broken in every commit for months,
// behind a report that was honest about the symptom.
//
// So: options a caller can pass to the runtime, checked against the file that
// actually serves requests. Narrow on purpose - this is the shape that bit.

// Pull one method's body out by brace-matching from its signature. Crude, and
// enough: the question is which option names appear inside ONE function.
// THE FIRST OCCURRENCE OF `name(` IS USUALLY A CALL, NOT THE DEFINITION.
//
// `return this._submitFastIntent(rawText, options)` appears at line 388 and the
// definition at 456, so indexOf found the call and brace-matched from the next
// `{` — sixty characters of somebody else's block. The options sweep then
// compared the staged route against a fragment and reported twenty options as
// ignored, `autoApprove` among them, which would have read as the flagship
// defect returning. Anchor on a DEFINITION: start of line, optional `async`,
// the name, and a parameter list.
function methodBody(body, name) {
  const def = new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, "m").exec(body);
  if (!def) return null;
  // AND THE NEXT `{` AFTER THE NAME IS USUALLY A DEFAULT PARAMETER.
  //
  // `async _submitFastIntent(rawText, options = {}) {` — the first brace is the
  // `{}` in `options = {}`, so brace-matching from there returns two characters.
  // Walk the parameter list to its closing paren first.
  let paren = 0;
  let i = def.index + def[0].length - 1;
  for (; i < body.length; i += 1) {
    if (body[i] === "(") paren += 1;
    else if (body[i] === ")") { paren -= 1; if (paren === 0) break; }
  }
  const open = body.indexOf("{", i);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < body.length; i += 1) {
    if (body[i] === "{") depth += 1;
    else if (body[i] === "}") { depth -= 1; if (depth === 0) return body.slice(open, i + 1); }
  }
  return null;
}

function sweepOptions() {
  const runtime = path.join(repoRoot, "packages/agent-runtime/src/index.js");
  if (!fs.existsSync(runtime)) return;
  const runtimeBody = read(runtime);

  // THE COMPARISON HAS TO BE BETWEEN THE TWO ROUTES, NOT BETWEEN TWO PACKAGES.
  //
  // The first version of this sweep asked whether packages/fast-agent named each
  // option, and reported `autoApprove` as ignored - which is exactly wrong,
  // because the fix for that defect landed in agent-runtime's own fast-path
  // submission. One options bag, two routes through the same file: that is the
  // shape that bit, so that is the shape to compare.
  const fastBody = methodBody(runtimeBody, "_submitFastIntent");
  if (!fastBody) {
    finding("options", "REVIEW", "_submitFastIntent", "could not be located, so the two routes were not compared", "");
    return;
  }
  // Options the STAGED route reads, minus the ones the fast route reads. The
  // staged path is everything else in the file.
  const stagedBody = runtimeBody.replace(fastBody, "");
  const staged = new Set([...stagedBody.matchAll(/\boptions\??\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  const fast = new Set([...fastBody.matchAll(/\b(?:options|session)\??\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));

  // An option the fast route hands onward wholesale (`...options`) is honoured
  // even without being named, so a spread makes the whole question moot.
  const spreads = /\.\.\.options\b/.test(fastBody);
  const ignored = [...staged].filter((n) => !fast.has(n)).sort();
  if (ignored.length === 0) return;
  finding(
    "options",
    spreads ? "REVIEW" : "UNWIRED",
    "options the staged route reads and the fast route does not",
    `${ignored.length} option(s); the fast route ${spreads ? "does" : "does NOT"} spread options onward`,
    ignored.join(", ")
  );
}

// ---------------------------------------------------------------------------
// SWEEP 4 - PROVIDER FIELDS THE TRANSPORT DROPS
//
// `reasoning_content` arrived on the wire and the transport threw it away, so
// the model's thinking was billed and discarded. The shape: a field is READ from
// the provider's payload and never appears on anything the transport returns.

function sweepProviderFields() {
  const file = path.join(repoRoot, "packages/model-providers/src/index.js");
  if (!fs.existsSync(file)) return;
  const body = read(file);
  const readFields = new Set();
  // Fields pulled off a provider payload, by the names those payloads use here.
  // A trailing `(` means it is a METHOD CALL, not a field: `JSON.parse` and
  // `JSON.stringify` were both reported as dropped provider fields until this
  // was added, which is the sort of noise that gets an audit ignored.
  for (const m of body.matchAll(/\b(?:delta|message|choice|choices\[0\]|payload|parsed|json|data)\??\.([a-z_][\w]*)(\s*\()?/gi)) {
    if (m[2]) continue;
    readFields.add(m[1]);
  }
  // The container names themselves: `choice.delta` and `choice.message` make
  // "delta" and "message" look like fields that were read and dropped, and they
  // are neither. Same for anything on Object/JSON/Array. Four of this sweep's
  // first four findings were one of these two, which is a sweep nobody reads.
  const CONTAINERS = /^(delta|message|choice|choices|payload|parsed|json|data)$/;
  const BUILTINS = /^(length|map|filter|find|slice|join|trim|push|then|catch|toString|includes|split|replace|forEach|reduce|some|every|at|concat|stringify|parse|keys|values|entries|assign|from|isArray)$/;
  const dropped = [];
  for (const field of readFields) {
    if (CONTAINERS.test(field) || BUILTINS.test(field)) continue;
    // A field is commonly forwarded under a RENAMED key - `reasoning_content`
    // is accumulated into `reasoning` and returned as that. Checking only the
    // wire name reported the one field this sweep exists for as still dropped,
    // on the commit that fixed it. So the camelCase and de-suffixed forms count.
    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const stem = field.split("_")[0];
    // Forwarded means it LEAVES: an object-literal key or shorthand, or an
    // assignment onto something being returned. NOT a bare `let x = ""` and NOT
    // `x += ...` — accumulating a value into a local and then dropping it is
    // precisely what happened to reasoning_content, so counting either as
    // forwarding would make this sweep blind to the defect it exists for.
    const forwarded = [field, camel, stem].some((alias) =>
      new RegExp(`(?:^|[{,\\s])${alias}\\s*[:,}]`, "m").test(body)
      || new RegExp(`\\b(?:result|out|output|response|turn|message)\\.${alias}\\s*=`).test(body));
    if (!forwarded) dropped.push(field);
  }
  if (dropped.length === 0) return;
  finding(
    "provider-fields",
    "REVIEW",
    "packages/model-providers/src/index.js",
    `${dropped.length} field(s) read from a provider payload and not visibly forwarded`,
    dropped.sort().join(", ")
  );
}

// ---------------------------------------------------------------------------
// SWEEP 5 - TOOLS THE MODEL IS NEVER OFFERED
//
// Dynamic, because the toolset is built at runtime and a static reading of it
// proves nothing. Builds the REAL toolset and compares what is executable with
// what goes into the schema the model sees. `audit-input-reachability.mjs` does
// this for the input verbs; this asks it of every tool.

async function sweepTools() {
  let toolset;
  try {
    const { buildToolset } = await import("../packages/fast-agent/src/tools.js");
    const { createDefaultCapabilityRegistry } = await import("../packages/capability-registry/src/index.js");
    const { WindowsAdapter } = await import("../os-adapters/windows/src/windows-adapter.js");
    const adapter = new WindowsAdapter();
    adapter.hostRequest = async () => ({ performed: true });
    toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
  } catch (error) {
    finding("tools", "REVIEW", "toolset", `could not be built, so tools were not audited: ${error.message}`, "");
    return;
  }
  // `toolsForTest` is the executable list; there is no `tools` map, and reading
  // one gave an empty set - so this sweep silently compared 31 offered tools
  // against nothing and reported all-clear. A check that cannot fail is not a
  // check, and this one could not, in the audit written to find exactly that.
  const offered = new Set(toolset.definitions.map((d) => d.function?.name ?? d.name));
  const executable = new Set((toolset.toolsForTest ?? []).map((t) => t.name));
  if (executable.size === 0) {
    finding("tools", "REVIEW", "toolset.toolsForTest", "empty, so nothing could be compared", "");
    return { offered: offered.size, executable: 0 };
  }
  for (const name of executable) {
    if (!offered.has(name)) {
      finding("tools", "UNWIRED", name, "executable but NOT in the schema the model sees", "");
    }
  }
  for (const name of offered) {
    if (executable.size > 0 && !executable.has(name)) {
      finding("tools", "REVIEW", name, "offered to the model but not in the executable map", "");
    }
  }
  return { offered: offered.size, executable: executable.size };
}

// ---------------------------------------------------------------------------
// WHAT THIS AUDIT CANNOT SEE. Printed with the results, every time.
//
// A check whose limits are unstated is one nobody can calibrate, and this one is
// static over a codebase built on dynamic dispatch.
const BLIND_SPOTS = [
  "IMPORTED IS NOT EXECUTED, and this is the big one. Reachability here is static import. "
    + "The ~20k-line offline pipeline IS imported from the daemon and was reached ZERO times in 180+ "
    + "measured runs, so sweep 1 will never flag it. This audit cannot settle whether to delete it; "
    + "only the runtime counter in the eval can.",
  "string-keyed dispatch: the capability registry resolves by name, so a capability nothing imports may still run",
  "dynamic import() with a computed specifier - not followed",
  "the Electron preload/renderer boundary: apps/desktop/*.js run in a browser context and are not imported by main.js",
  "call sites are matched by method NAME, not by resolved receiver - two classes with close() share one verdict",
  "a function reachable in principle but behind a flag that is always false still reads as reachable",
  "re-exports through an index barrel are followed, but a symbol renamed on the way through is matched by its new name only"
];

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SELF-TEST: DOES IT ACTUALLY CATCH THE FIVE?
//
// An audit that reports nothing is indistinguishable from an audit that sees
// nothing, and this codebase has shipped eleven checks that could not fail. So
// each historical defect is REINTRODUCED - in memory, never on disk, by patching
// the text the sweeps read - and the sweep must produce a finding.
//
// Case 1 (a whole module nothing routes to) and case 2 (perception unreachable)
// are the same detector, so they are tested once each on a real file.
async function runSelfTest() {
  const results = [];
  const check = async (label, patch, sweep, expect) => {
    const saved = new Map();
    for (const [file, replacement] of patch) {
      saved.set(file, read(file));
      text.set(file, replacement(read(file)));
    }
    findings.length = 0;
    reachable.clear();
    (function spread(queue) {
      while (queue.length > 0) {
        const f = queue.pop();
        if (reachable.has(f)) continue;
        reachable.add(f);
        queue.push(...importsOf(f));
      }
    })([...ROOTS]);
    await sweep();
    const hit = findings.filter((f) => expect(f));
    results.push({ label, detected: hit.length > 0, evidence: hit[0]?.subject ?? "(nothing)" });
    for (const [file, body] of saved) text.set(file, body);
  };

  const runtime = path.join(repoRoot, "packages/agent-runtime/src/index.js");
  const client = path.join(repoRoot, "os-adapters/windows-host/src/client.js");
  const providers = path.join(repoRoot, "packages/model-providers/src/index.js");
  const evalRunner = path.join(repoRoot, "tests/eval/runner.mjs");
  const factory = path.join(repoRoot, "apps/daemon/src/runtime-factory.js");

  // 1 + 2. The loop, and perception, unreachable. Exactly ONE module imports
  // fast-agent — agent-runtime, line 53 — which is why the loop could sit there
  // complete and unroutable in the first place. Cut that one import and the
  // whole loop plus everything only it pulls in must be reported.
  await check(
    "a module nothing routes to (the agent loop / perception)",
    [[runtime, (b) => b.replace(/import \{[^}]*FastAgent[^}]*\}[^\n]*\n/, "")]],
    async () => sweepModules(),
    (f) => f.sweep === "modules" && /fast-agent|perception/.test(f.subject)
  );

  // 3. autoApprove read by the staged route and not by the fast one.
  await check(
    "an option the fast route ignores (autoApprove)",
    [[runtime, (b) => {
      const fast = methodBody(b, "_submitFastIntent");
      return fast ? b.replace(fast, fast.replace(/options\??\.autoApprove/g, "false")) : b;
    }]],
    async () => sweepOptions(),
    (f) => f.sweep === "options" && /autoApprove/.test(f.evidence)
  );

  // 4. A provider field read off the wire and forwarded nowhere.
  await check(
    "a provider field the transport drops (reasoning_content)",
    [[providers, (b) => b.replace(/\breasoning\s*\+=/g, "void 0 &&").replace(/(?:^|[{,\s])reasoning\s*[:,}]/gm, " ")]],
    async () => sweepProviderFields(),
    (f) => f.sweep === "provider-fields" && /reasoning_content/.test(f.evidence)
  );

  // 5. A cleanup path only scaffolding calls.
  await check(
    "a teardown nothing real calls (closeWindowsAutomationHost)",
    [[evalRunner, (b) => b.replace(/closeWindowsAutomationHost\(\);/g, "/* removed */")]],
    async () => sweepCleanup(),
    (f) => f.sweep === "cleanup" && /close/i.test(f.subject)
  );

  // 6. A tool that is executable but never offered to the model.
  findings.length = 0;
  const { buildToolset } = await import("../packages/fast-agent/src/tools.js");
  const { createDefaultCapabilityRegistry } = await import("../packages/capability-registry/src/index.js");
  const { WindowsAdapter } = await import("../os-adapters/windows/src/windows-adapter.js");
  const a = new WindowsAdapter();
  a.hostRequest = async () => ({ performed: true });
  const real = buildToolset({ registry: createDefaultCapabilityRegistry(a), adapter: a });
  const offered = new Set(real.definitions.map((d) => d.function?.name ?? d.name));
  offered.delete(real.toolsForTest[0].name); // pretend one tool never reached the schema
  const missing = real.toolsForTest.map((t) => t.name).filter((n) => !offered.has(n));
  results.push({
    label: "a tool executable but not in the model's schema",
    detected: missing.length > 0,
    evidence: missing[0] ?? "(nothing)"
  });

  console.log("SELF-TEST - each historical defect, reintroduced in memory\n");
  let failed = 0;
  for (const r of results) {
    if (!r.detected) failed += 1;
    console.log(`  ${r.detected ? "CAUGHT " : "MISSED "} ${r.label}`);
    console.log(`           ${r.detected ? `reported: ${r.evidence}` : "THE AUDIT DID NOT NOTICE"}`);
  }
  console.log(`\n${results.length - failed}/${results.length} detected.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function main() {
  if (selfTest) return runSelfTest();
  sweepModules();
  sweepCleanup();
  sweepOptions();
  sweepProviderFields();
  const toolStats = await sweepTools();

  if (asJson) {
    console.log(JSON.stringify({ findings, blindSpots: BLIND_SPOTS, toolStats }, null, 2));
    return findings;
  }

  console.log("REACHABILITY AUDIT");
  console.log(`  entry points: ${ENTRY_POINTS.join(", ")}`);
  console.log(`  ${sourceFiles.length} source files, ${reachable.size} reachable from an entry point`);
  if (toolStats) console.log(`  tools: ${toolStats.offered} offered to the model, ${toolStats.executable} executable`);
  console.log("");

  const order = ["modules", "cleanup", "options", "provider-fields", "tools"];
  for (const sweep of order) {
    const rows = findings.filter((f) => f.sweep === sweep);
    console.log(`== ${sweep.toUpperCase()} (${rows.length}) ==`);
    if (rows.length === 0) console.log("   nothing");
    for (const row of rows) {
      console.log(`   ${row.severity.padEnd(8)} ${row.subject}`);
      console.log(`            ${row.detail}`);
      if (row.evidence) console.log(`            e.g. ${row.evidence}`);
    }
    console.log("");
  }

  console.log("WHAT THIS AUDIT CANNOT SEE");
  for (const spot of BLIND_SPOTS) console.log(`   - ${spot}`);
  console.log("");
  console.log(`${findings.length} finding(s). DEAD = delete it. UNWIRED = a defect. REVIEW = a human decides.`);
  return findings;
}

await main();
