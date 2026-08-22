// WHERE DOES ONE LOOK AT THE SCREEN ACTUALLY SPEND ITS TIME?
//
//   node scripts/probe-perception-breakdown.mjs [app ...]
//
// probe-screen-p50.mjs times the `screen` tool end to end and stops there. That
// total is the number that matters, and it is useless for deciding WHAT to
// change: three separate claims about it were in the brief for this session —
// "OCR runs by default", "WebView2 windows are read twice", "listWindows costs
// 533ms and is called three times per look" — and a single elapsed figure can
// neither confirm nor refute any of them.
//
// So this wraps the two things underneath the tool and counts them: every
// `screen.read` the tool issues (with the `includeOcr` it was actually issued
// with, which is the whole of the first claim) and every `adapter.listWindows`.
// Wrapping is deliberate — reading the source tells you what a branch COULD do,
// and the question here is which branch a real look takes on a real window.
//
// Reported per application: the first look and the warm looks separately,
// because the first look is where the WebView2 redirect is paid and the memo is
// filled, and averaging the two hides both.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const apps = process.argv.slice(2).length ? process.argv.slice(2) : ["WhatsApp", "Spotify", "Chrome", "notepad"];
const READS = 5;

const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter);

// The ledger the current look writes into. Reset before each `screen` call so
// every entry belongs to exactly one look.
let look = null;
const freshLook = () => { look = { reads: [], listWindows: [], parents: [] }; return look; };
freshLook();

const screenRead = registry.get("screen.read");
const originalExecute = screenRead.execute.bind(screenRead);
screenRead.execute = async (inputs, options) => {
  const started = Date.now();
  const result = await originalExecute(inputs, options);
  look.reads.push({
    ms: Date.now() - started,
    ocr: inputs?.includeOcr !== false,
    windowId: String(inputs?.windowId ?? inputs?.application ?? "—"),
    elements: (result?.elements ?? []).length,
    textChars: String(result?.visibleText ?? "").length
  });
  return result;
};

const originalListWindows = adapter.listWindows.bind(adapter);
adapter.listWindows = async (...args) => {
  const started = Date.now();
  try { return await originalListWindows(...args); }
  finally { look.listWindows.push(Date.now() - started); }
};
if (typeof adapter.listProcessParents === "function") {
  const originalParents = adapter.listProcessParents.bind(adapter);
  adapter.listProcessParents = async (...args) => {
    const started = Date.now();
    try { return await originalParents(...args); }
    finally { look.parents.push(Date.now() - started); }
  };
}

const toolset = buildToolset({ registry, adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const describe = (label, entry) => {
  const ocrReads = entry.reads.filter((read) => read.ocr);
  console.log(
    `  ${label.padEnd(6)} ${String(entry.total + "ms").padStart(8)}` +
    `  screen.read ×${entry.reads.length}` +
    ` (${entry.reads.map((read) => `${read.ms}ms${read.ocr ? " +OCR" : ""}/${read.elements}el`).join(", ") || "none"})` +
    `  listWindows ×${entry.listWindows.length}${entry.listWindows.length ? ` (${sum(entry.listWindows)}ms)` : ""}` +
    `${entry.parents.length ? `  parents ×${entry.parents.length} (${sum(entry.parents)}ms)` : ""}` +
    `${ocrReads.length ? "  << OCR PAID" : ""}`
  );
};

// THE PIECES ON THEIR OWN, BEFORE ANYTHING COMPOSES THEM.
//
// A look is built out of three host round trips and the totals above cannot say
// which one is expensive. Timed here separately so a change to any of them has
// a number to be held to. `listWindows` is measured against a real desktop, so
// the figure moves with how many windows are open — say how many.
const componentSamples = 7;
const timeIt = async (fn) => {
  const samples = [];
  for (let i = 0; i < componentSamples; i++) {
    const started = Date.now();
    await fn().catch(() => null);
    samples.push(Date.now() - started);
  }
  return samples;
};
freshLook();
const windowCount = (await adapter.listWindows().catch(() => [])).length;
const componentTimings = [
  ["adapter.listWindows", await timeIt(() => originalListWindows())],
  ["adapter.getForegroundWindow", await timeIt(() => adapter.getForegroundWindow())]
];
console.log(`\nThe pieces on their own, ${componentSamples} calls each, ${windowCount} windows open\n`);
for (const [label, samples] of componentTimings) {
  console.log(`  ${label.padEnd(28)} p50 ${String(median(samples) + "ms").padStart(7)}   ` +
    `min ${Math.min(...samples)}ms  max ${Math.max(...samples)}ms`);
}

console.log(`\nWhat one \`screen\` call does underneath, ${READS} warm reads per application\n`);

const warmTotals = [];
let ocrLooks = 0;
let allLooks = 0;
for (const application of apps) {
  const focused = await toolset.execute("focus", { application }).catch(() => null);
  if (!focused?.ok) {
    console.log(`${application}: not running, or could not be focused — skipped\n`);
    continue;
  }
  console.log(application);
  const entries = [];
  for (let i = 0; i <= READS; i++) {
    const entry = freshLook();
    const started = Date.now();
    await toolset.execute("screen", { application });
    entry.total = Date.now() - started;
    entries.push(entry);
  }
  const [first, ...warm] = entries;
  describe("first", first);
  // Every warm look is printed rather than a median of them: the claim under
  // test is about what a look DOES, and one look in five taking a different
  // branch is exactly the thing a median would erase.
  warm.forEach((entry, index) => describe(`warm ${index + 1}`, entry));
  warmTotals.push(...warm.map((entry) => entry.total));
  allLooks += entries.length;
  ocrLooks += entries.filter((entry) => entry.reads.some((read) => read.ocr)).length;
  console.log("");
}

console.log("-".repeat(78));
console.log(`p50 across every warm look: ${median(warmTotals)}ms`);
console.log(`looks that paid for capture+OCR: ${ocrLooks} of ${allLooks}`);
adapter.close?.();
process.exit(0);
