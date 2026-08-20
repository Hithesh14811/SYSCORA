// HOW LONG DOES ONE LOOK AT THE SCREEN TAKE?
//
//   node scripts/probe-screen-p50.mjs [app ...]
//
// W8's target is a p50 under 1.2s on the applications the agent actually spends
// its time in. This times the `screen` TOOL — not the adapter underneath it —
// because the tool is what a step of the loop pays for: window resolution, the
// WebView2 redirect and the rendering are all inside that number.
//
// The FIRST look at a WebView2 application costs more than the rest on purpose.
// It reads the frame, finds six caption buttons, works out which sibling window
// holds the interface, and remembers it. Every look after that goes straight
// there. Both numbers are reported because both are real: the first is what a
// task pays once, the p50 is what it pays per step.
//
// Before the cache-scope fix of 20 Aug 2026 the WhatsApp numbers here were 25.7s
// for the frame and ~3.0s for the content window. See New-UiCacheRequest.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const apps = process.argv.slice(2).length ? process.argv.slice(2) : ["WhatsApp", "Spotify", "Chrome"];
const READS = 5;

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

console.log(`\nOne look at the screen, ${READS} reads per application after the first\n`);
console.log(`${"application".padEnd(12)} ${"first".padStart(8)} ${"p50".padStart(8)} ${"min".padStart(8)} ${"max".padStart(8)}  window`);
console.log("-".repeat(72));

const all = [];
for (const application of apps) {
  // Focus rather than launch: launching is a different measurement and can open
  // a second window, which changes what is being timed halfway through.
  const focused = await toolset.execute("focus", { application }).catch(() => null);
  if (!focused?.ok) {
    console.log(`${application.padEnd(12)} ${"—".padStart(8)}  not running, or could not be focused`);
    continue;
  }
  const times = [];
  let heading = "";
  for (let i = 0; i <= READS; i++) {
    const started = Date.now();
    const result = await toolset.execute("screen", { application });
    times.push(Date.now() - started);
    if (!heading) heading = String(result?.text ?? "").match(/^Window: (.*)$/m)?.[1] ?? "?";
  }
  const [first, ...warm] = times;
  all.push(...warm);
  console.log(
    `${application.padEnd(12)} ${String(first + "ms").padStart(8)} ${String(median(warm) + "ms").padStart(8)} ` +
    `${String(Math.min(...warm) + "ms").padStart(8)} ${String(Math.max(...warm) + "ms").padStart(8)}  ${heading.slice(0, 40)}`
  );
}

if (all.length) {
  console.log("-".repeat(72));
  console.log(`p50 across every warm read: ${median(all)}ms  ${median(all) < 1200 ? "— under the 1.2s target" : "— OVER the 1.2s target"}`);
}
adapter.close?.();
process.exit(0);
