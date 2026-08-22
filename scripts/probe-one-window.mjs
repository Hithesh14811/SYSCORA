// WHAT DOES THE AGENT ACTUALLY SEE WHEN IT LOOKS AT ONE WINDOW?
//
//   node scripts/probe-one-window.mjs <application>
//   node scripts/probe-one-window.mjs --window <windowId>
//
// probe-perception-breakdown.mjs counts elements. A count of zero has two very
// different causes — a window with nothing in it, and a window we are reading in
// the wrong place — and only the rendered text tells them apart. This prints
// what the model would be handed, verbatim, plus the raw window list so the
// candidates that were NOT read can be seen beside the one that was.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const byWindow = process.argv[2] === "--window";
const target = byWindow ? { windowId: process.argv[3] } : { application: process.argv[2] };
if (!target.windowId && !target.application) {
  console.log("usage: node scripts/probe-one-window.mjs <application> | --window <windowId>");
  process.exit(1);
}

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

if (!byWindow) await toolset.execute("focus", target).catch(() => null);
const started = Date.now();
const result = await toolset.execute("screen", target);
const elapsed = Date.now() - started;

const rendered = String(result?.text ?? JSON.stringify(result));
// Characters ÷ 4, the same approximation measure-prompt-cost.mjs uses, so the
// two numbers can be compared. It is a ratio, not a tokenizer.
console.log(`\n=== what the model is handed for ${JSON.stringify(target)} — ` +
  `${elapsed}ms, ${rendered.length} chars, ~${Math.round(rendered.length / 4)} tokens ===\n`);
console.log(rendered.slice(0, 4000));

console.log(`\n=== every window the desktop reports ===\n`);
const windows = await adapter.listWindows().catch(() => []);
for (const window of windows) {
  const bounds = window.Bounds ?? window.bounds ?? {};
  console.log(
    `${String(window.WindowHandle ?? window.windowId).padEnd(10)} ` +
    `${String(window.ProcessName ?? window.processName ?? "?").padEnd(22)} ` +
    `${String(bounds.width ?? 0).padStart(5)}x${String(bounds.height ?? 0).padEnd(5)} ` +
    `${String(window.MainWindowTitle ?? window.title ?? "").slice(0, 40)}`
  );
}
adapter.close?.();
process.exit(0);
