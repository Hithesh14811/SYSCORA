// DOES THE TEXT LAND IN THE BOX, AND WHEN?
//
// The send check now says "the focused control does NOT contain this text" for
// every message typed into WhatsApp. That is either true — typing genuinely does
// not reach a WebView2 edit box — or the check is reading the value before
// Chromium has published it, which would make the fix worse than the bug.
//
// So: click the box, type, and read the value back at intervals. Types the text
// only; NEVER presses Enter, so nothing is sent.
//
//   node scripts/probe-typing-lands.mjs whatsapp "probe text"

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { pickWebviewWindow } from "../os-adapters/windows/src/webview-windows.js";

const application = process.argv[2] ?? "whatsapp";
const text = process.argv[3] ?? "probe text";
const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter);
await adapter.automationHost?.warm?.();

const windows = await adapter.listWindows();
const parentOf = await adapter.listProcessParents?.().catch(() => new Map()) ?? new Map();
const filter = new RegExp(application, "i");
const frame = windows.find((window) => filter.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`));
const content = pickWebviewWindow({ frameWindowId: String(frame.WindowHandle), windows, parentOf });
const windowId = content?.windowId ?? String(frame.WindowHandle);

const ui = await adapter.inspectUi({ windowId, maxElements: 400 });
const box = (ui.elements ?? ui.targets ?? []).find((element) =>
  /type a message/i.test(String(element.name ?? "")));
if (!box) { console.log("no message box found"); process.exit(1); }
const rect = box.bounds ?? box.boundingRect;
const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };

await registry.get("window.activate").execute({ windowId });
await registry.get("pointer.clickAt").execute({ x: point.x, y: point.y, windowId });
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(`before typing: ${JSON.stringify((await adapter.focusedElement({ windowId }))?.value)}`);

const typed = await registry.get("keyboard.type").execute({ text, windowId });
console.log(`keyboard.type: ${JSON.stringify(typed)}`);

for (const delay of [0, 100, 250, 500, 1000, 2000]) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  const focused = await adapter.focusedElement({ windowId });
  console.log(`+${delay}ms  focused=${JSON.stringify(focused?.name)} value=${JSON.stringify(focused?.value)}`);
}

console.log("\nNothing was sent. Clear the box by hand if the text is in it.");
adapter.close?.();
process.exit(0);
