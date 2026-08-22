// WHERE DOES THE TEXT OF A MESSAGE GO?
//
// The flagship failure: the agent "sent" a WhatsApp message and confirmed it by
// noticing the input box was empty. It was never sent. Confirming a send
// honestly means READING THE SENT MESSAGE in the conversation — and a live
// reading showed `group "You:"`, `group "Amma❤️:"`, `button "9:37 pm Read"` and
// not one word of any message.
//
// This asks the window directly, with no filtering and no cap, so the answer is
// "the tree does not carry it" or "we are dropping it" rather than a guess.
//
//   node scripts/probe-conversation-text.mjs whatsapp
//   node scripts/probe-conversation-text.mjs whatsapp --render   # what the model would see
//
// Exits explicitly: the automation host is a long-lived child and holds the
// event loop open forever otherwise.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { pickWebviewWindow } from "../os-adapters/windows/src/webview-windows.js";
import { renderElementsForTest } from "../packages/fast-agent/src/tools.js";

const filter = new RegExp(process.argv[2] ?? "whatsapp", "i");
const render = process.argv.includes("--render");
const adapter = new WindowsAdapter();

const windows = await adapter.listWindows().catch(() => []);
const parentOf = await adapter.listProcessParents?.().catch(() => new Map()) ?? new Map();
const frame = windows.find((window) =>
  filter.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`));
if (!frame) {
  console.log(`nothing open matching /${filter.source}/`);
  process.exit(1);
}

const content = pickWebviewWindow({ frameWindowId: String(frame.WindowHandle), windows, parentOf });
const target = content?.windowId ?? String(frame.WindowHandle);
console.log(`frame   ${frame.ProcessName} "${frame.MainWindowTitle}" (${frame.WindowHandle})`);
console.log(`reading ${content ? `${content.processName} "${content.title}" (${content.windowId})` : "the frame itself"}\n`);

const ui = await adapter.inspectUi({ windowId: target, maxElements: 1000 });
const elements = ui.elements ?? ui.targets ?? [];
console.log(`${elements.length} elements\n`);

for (const [index, element] of elements.entries()) {
  const type = String(element.controlType ?? element.role ?? "").replace("ControlType.", "");
  const bounds = element.bounds ?? element.boundingRect ?? {};
  const name = JSON.stringify(String(element.name ?? element.text ?? "").slice(0, 90));
  const value = element.value === null || element.value === undefined
    ? ""
    : ` value=${JSON.stringify(String(element.value).slice(0, 60))}`;
  console.log(`${String(index).padStart(4)} ${type.padEnd(12)} ${name.padEnd(60)}${value} @${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
}

if (render) {
  const table = [];
  const lines = renderElementsForTest(elements.map((element) => ({
    ...element,
    role: String(element.controlType ?? element.role ?? "").replace("ControlType.", "").toLowerCase(),
    text: element.name ?? element.text ?? "",
    bounds: element.bounds ?? element.boundingRect
  })), table);
  console.log(`\n── what the model is shown (${lines.length} of ${table.length} rows)\n`);
  console.log(lines.join("\n"));
}

process.exit(0);
