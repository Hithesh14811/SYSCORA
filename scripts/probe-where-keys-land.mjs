// DO KEYSTROKES REACH THIS WINDOW AT ALL, OR JUST NOT THAT BOX?
//
// Typing into WhatsApp's message box landed twice on 16 Aug and then stopped,
// with the input engine reporting performed=true, method=clipboard-paste and the
// foreground verified on every attempt. Two very different faults look identical
// from there: input not reaching the WINDOW, or input reaching it and the
// message box refusing it.
//
// The search field separates them. It is in the same window, it is a plain
// input, and typing in it is harmless — Escape clears it.
//
//   node scripts/probe-where-keys-land.mjs

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { pickWebviewWindow } from "../os-adapters/windows/src/webview-windows.js";

const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter);
await adapter.automationHost?.warm?.();

const windows = await adapter.listWindows();
const parentOf = await adapter.listProcessParents?.().catch(() => new Map()) ?? new Map();
const frame = windows.find((window) => /whatsapp/i.test(String(window.ProcessName ?? "")));
const windowId = pickWebviewWindow({ frameWindowId: String(frame.WindowHandle), windows, parentOf })?.windowId
  ?? String(frame.WindowHandle);

const elementsOf = async () => {
  const ui = await adapter.inspectUi({ windowId, maxElements: 400 });
  return ui.elements ?? ui.targets ?? [];
};
const centreOf = (element) => {
  const rect = element.bounds ?? element.boundingRect;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
};

for (const needle of [/search or start/i, /type a message/i]) {
  const element = (await elementsOf()).find((candidate) => needle.test(String(candidate.name ?? "")));
  if (!element) { console.log(`${needle} — no such control`); continue; }
  const point = centreOf(element);
  await registry.get("window.activate").execute({ windowId });
  await registry.get("pointer.clickAt").execute({ ...point, windowId });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const focused = await adapter.focusedElement({ windowId });
  const before = focused?.value ?? null;
  await registry.get("keyboard.type").execute({ text: "zq", windowId });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = (await adapter.focusedElement({ windowId }))?.value ?? null;
  console.log(`${String(element.name).slice(0, 34).padEnd(36)} focused=${JSON.stringify(focused?.name ?? null)}\n` +
    `  before=${JSON.stringify(before)} after=${JSON.stringify(after)} -> ` +
    `${before !== after ? "KEYS ARRIVED" : "nothing arrived"}`);
  // Leave the search box as it was found.
  await registry.get("keyboard.press").execute({ keys: "{ESC}", windowId });
}

adapter.close?.();
process.exit(0);
