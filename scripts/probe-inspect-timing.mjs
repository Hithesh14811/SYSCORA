// WHAT DOES ONE inspectUi COST, REPEATED?
//
// A reading of WhatsApp was measured at 1.4s on 15 Aug and 4.9s warm on 16 Aug,
// on a window that had grown to 138 unread chats in between. Before blaming a
// change, measure the operation on its own: same window, several times, median
// rather than first — the first crossing pays for the UIA connection.
//
//   node scripts/probe-inspect-timing.mjs 197286
//   node scripts/probe-inspect-timing.mjs whatsapp 5

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const target = process.argv[2] ?? "whatsapp";
const runs = Number(process.argv[3] ?? 5);
const adapter = new WindowsAdapter();
await adapter.automationHost?.warm?.();

let windowId = /^\d+$/.test(target) ? target : null;
if (!windowId) {
  const windows = await adapter.listWindows();
  const filter = new RegExp(target, "i");
  const hit = windows.find((window) => filter.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`));
  windowId = String(hit?.WindowHandle ?? "");
}

const times = [];
let count = 0;
let texts = 0;
for (let run = 0; run < runs; run += 1) {
  const startedAt = Date.now();
  const ui = await adapter.inspectUi({ windowId, maxElements: 240 });
  times.push(Date.now() - startedAt);
  const elements = ui.elements ?? ui.targets ?? [];
  count = elements.length;
  texts = elements.filter((element) => /Text$/i.test(String(element.controlType ?? element.role ?? ""))).length;
}
times.sort((left, right) => left - right);
console.log(`window ${windowId}: ${count} elements (${texts} Text)`);
console.log(`times: ${times.join("ms, ")}ms   median ${times[Math.floor(times.length / 2)]}ms`);

adapter.close?.();
process.exit(0);
