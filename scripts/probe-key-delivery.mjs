// DOES A KEYSTROKE REACH A WEBVIEW AT ALL?
//
// `keyboard.type` lands text in WhatsApp's message box every time. `key enter`
// answers "Sent." and nothing is sent, and ctrl+A / Delete leave the box exactly
// as it was. Two different routes: typing goes through the clipboard and
// SendInput, a key press goes through System.Windows.Forms.SendKeys.
//
// This puts text in the box with the route that works, then tries to clear it
// with each key route in turn. Whichever one empties the box is the one that
// reaches Chromium. NOTHING IS EVER SENT — Enter is never pressed.
//
//   node scripts/probe-key-delivery.mjs

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { pickWebviewWindow } from "../os-adapters/windows/src/webview-windows.js";

const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter);
await adapter.automationHost?.warm?.();

const windows = await adapter.listWindows();
const parentOf = await adapter.listProcessParents?.().catch(() => new Map()) ?? new Map();
const frame = windows.find((window) => /whatsapp/i.test(String(window.ProcessName ?? "")));
const content = pickWebviewWindow({ frameWindowId: String(frame.WindowHandle), windows, parentOf });
const windowId = content?.windowId ?? String(frame.WindowHandle);

const ui = await adapter.inspectUi({ windowId, maxElements: 400 });
const box = (ui.elements ?? ui.targets ?? []).find((element) => /type a message/i.test(String(element.name ?? "")));
const rect = box.bounds ?? box.boundingRect;
const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };

const held = async () => (await adapter.focusedElement({ windowId }))?.value ?? null;
const focusBox = async () => {
  await registry.get("window.activate").execute({ windowId });
  await registry.get("pointer.clickAt").execute({ x: point.x, y: point.y, windowId });
  await new Promise((resolve) => setTimeout(resolve, 300));
};

for (const route of [{ keys: "^a" }, { keys: "^a", chord: "ctrl+a" }]) {
  await focusBox();
  await registry.get("keyboard.type").execute({ text: "clearme", windowId });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const before = await held();
  const result = await registry.get("keyboard.press").execute({ ...route, windowId });
  await registry.get("keyboard.press").execute(
    route.chord ? { keys: "{DEL}", chord: "delete", windowId } : { keys: "{DEL}", windowId });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await held();
  console.log(`${route.chord ? "chord (SendInput)" : "sendkeys         "}  method=${result.method}  ` +
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}  ` +
    `${String(after ?? "").trim() === "" ? "CLEARED — the keys arrived" : "unchanged — the keys went nowhere"}`);
}

adapter.close?.();
process.exit(0);
