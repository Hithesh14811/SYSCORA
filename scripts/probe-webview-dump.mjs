// What is actually IN the webview tree, name by name.
//
// probe-webview-tree.mjs answers "how many". This answers "which", which is the
// question that decides whether a skill can be written: a count of 34 means
// nothing if none of them is the message input or the emoji button.
//
//   node scripts/probe-webview-dump.mjs whatsapp
//
// Exits explicitly: the automation host is a long-lived child and holds the
// event loop open forever otherwise — the first run of the tree probe looked
// hung for six minutes when it had actually finished in one second.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const filter = new RegExp(process.argv[2] ?? ".", "i");
const adapter = new WindowsAdapter();

const windows = await adapter.listWindows().catch(() => []);
const candidates = windows.filter((window) =>
  filter.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`));

for (const window of candidates) {
  const windowId = String(window.WindowHandle);
  console.log(`\n── ${window.ProcessName} — ${window.MainWindowTitle} (${windowId})`);
  const ui = await adapter.inspectUi({ windowId, maxElements: 2000 }).catch((error) => ({ error: error?.message }));
  if (ui?.error) { console.log(`   failed: ${ui.error}`); continue; }
  const elements = ui.elements ?? ui.targets ?? [];
  console.log(`   ${elements.length} elements`);
  for (const element of elements) {
    const type = String(element.controlType ?? element.role ?? "").replace("ControlType.", "");
    const bounds = element.bounds ?? {};
    console.log(`   ${type.padEnd(12)} ${JSON.stringify(String(element.name ?? "").slice(0, 70)).padEnd(50)} ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  }
}

process.exit(0);
