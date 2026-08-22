// WHAT DOES THE FOCUSED CONTROL SAY IT HOLDS?
//
// The whole send check rests on this one answer, and live it came back "the
// focused control does not publish what it holds" for a box that a tree walk
// shows publishing value="\n". Either FocusedElement lands somewhere other than
// the box, or it lands on it and the value does not survive the trip.
//
// Clicks the message box first, because a focused-control question is
// meaningless without focus.
//
//   node scripts/probe-focused-value.mjs whatsapp "Type a message"

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { pickWebviewWindow } from "../os-adapters/windows/src/webview-windows.js";

const application = process.argv[2] ?? "whatsapp";
const label = process.argv[3] ?? "Type a message";
const adapter = new WindowsAdapter();
await adapter.automationHost?.warm?.();

const windows = await adapter.listWindows();
const parentOf = await adapter.listProcessParents?.().catch(() => new Map()) ?? new Map();
const filter = new RegExp(application, "i");
const frame = windows.find((window) => filter.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`));
const content = pickWebviewWindow({ frameWindowId: String(frame.WindowHandle), windows, parentOf });
const windowId = content?.windowId ?? String(frame.WindowHandle);

const ui = await adapter.inspectUi({ windowId, maxElements: 400 });
const box = (ui.elements ?? ui.targets ?? []).find((element) =>
  String(element.name ?? "").toLowerCase().includes(label.toLowerCase()));
if (!box) { console.log(`no control named like ${JSON.stringify(label)}`); process.exit(1); }
const rect = box.bounds ?? box.boundingRect;
const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
console.log(`box: ${box.controlType} ${JSON.stringify(box.name)} value=${JSON.stringify(box.value)} @${point.x},${point.y}`);

const registry = createDefaultCapabilityRegistry(adapter);
await registry.get("window.activate").execute({ windowId }).catch(() => {});
await registry.get("pointer.clickAt").execute({ x: point.x, y: point.y, windowId })
  .catch((error) => console.log(`click failed: ${error?.message}`));
await new Promise((resolve) => setTimeout(resolve, 400));

const started = Date.now();
const focused = await adapter.focusedElement({ windowId });
console.log(`\nfocusedElement (${Date.now() - started}ms): ${JSON.stringify(focused, null, 2)}`);

// And the same question the slow way, for comparison.
const again = await adapter.inspectUi({ windowId, maxElements: 400 });
const marked = (again.elements ?? again.targets ?? []).filter((element) => element.focused === true);
console.log(`\ninspectUi says focused: ${marked.map((element) =>
  `${element.controlType} ${JSON.stringify(element.name)} value=${JSON.stringify(element.value)}`).join("\n  ") || "nothing"}`);

adapter.close?.();
process.exit(0);
