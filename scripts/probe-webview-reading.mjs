// Does a look at a WebView2 application now see the application?
//
// The unit tests prove pickWebviewWindow's arithmetic against a fabricated
// window list, which is the Mock-provider trap this codebase keeps falling into:
// everything passes and nothing has been looked at. This runs the tool the model
// is actually given, `screen`, against whatever real window is open, and reports
// what came back and what it cost.
//
//   node scripts/probe-webview-reading.mjs whatsapp
//
// What it is checking, on this machine, before the change:
//   application "whatsapp" -> WhatsApp.Root, 6 elements, then ~3s of OCR
// and after:
//   application "whatsapp" -> the webview window, ~90 elements, no capture.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const application = process.argv[2] ?? "whatsapp";
const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });

// The daemon warms the automation host at startup, so charging its 1.1s to the
// first reading would measure process start, not perception.
await adapter.automationHost?.warm?.();

const look = async (label) => {
  const startedAt = Date.now();
  const result = await toolset.execute("screen", { application });
  const elapsed = Date.now() - startedAt;
  const text = String(result.text ?? "");
  const lines = text.split("\n").length;
  console.log(`\n── ${label}: ${elapsed}ms, ${text.length} characters, ${lines} lines`);
  console.log(text.split("\n").slice(0, 5).join("\n"));
  return { elapsed, text };
};

const first = await look("first look (cold: resolves the window)");
const second = await look("second look (warm: the window is remembered)");

// WHAT THE OLD ROUTE COST, measured rather than remembered: the frame window,
// with the capture and the OCR over it, which is what a thin tree used to mean.
const registry = createDefaultCapabilityRegistry(adapter);
const windows = await adapter.listWindows();
const frame = windows.find((window) =>
  new RegExp(application, "i").test(String(window.ProcessName ?? "")));
let before = null;
if (frame) {
  const startedAt = Date.now();
  const reading = await registry.get("screen.read").execute({
    windowId: String(frame.WindowHandle), maxElements: 240
  });
  before = {
    elapsed: Date.now() - startedAt,
    elements: reading.elements?.length ?? 0,
    characters: JSON.stringify(reading.elements ?? []).length + String(reading.visibleText ?? "").length
  };
  console.log(`\n── the old route (frame window ${frame.ProcessName}, with OCR): ${before.elapsed}ms, ` +
    `${before.elements} elements, ${before.characters} characters of payload`);
  console.log(`   visible text OCR returned: ${JSON.stringify(String(reading.visibleText ?? "").slice(0, 120))}`);
}

// The controls that only exist in the webview tree. Finding these by OCR is the
// thing that has never worked — an icon has no text to read.
const ICONS = ["Attach", "Voice message", "Emojis", "Type a message", "Search"];
const found = ICONS.filter((icon) => first.text.includes(icon));
console.log(`\nicon controls present: ${found.length ? found.join(", ") : "NONE"}`);
console.log(`captured pixels: ${/capture|screenshot/i.test(first.text) ? "yes" : "no evidence in the reading"}`);
console.log(`warm look was ${first.elapsed - second.elapsed}ms faster than the cold one`);
if (before) {
  console.log(`\nold route: ${before.elapsed}ms for ${before.elements} elements of window frame`);
  console.log(`new route: ${first.elapsed}ms for a reading of the application itself`);
  console.log(first.elapsed < before.elapsed
    ? `FASTER by ${before.elapsed - first.elapsed}ms, and it can see the application`
    : `SLOWER by ${first.elapsed - before.elapsed}ms — the definition of done says this must not happen`);
}

adapter.close();
process.exit(0);
