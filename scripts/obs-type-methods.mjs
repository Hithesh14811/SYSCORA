// Which typing method actually survives a modern text editor?
//
// Notepad on Windows 11 is a Windows App SDK editor, not the old EDIT control,
// and it does not take injected characters the way a WinForms text box does.
// This types the same string into a fresh tab by each available method, saves it
// through the Save dialog, and reads the file back off disk. No retry logic, one
// attempt per method, so the result says what the method does rather than what a
// recovery loop managed to patch up.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const TEXT = "int main() { return 100%2; }\r\npath: C:\\Users\\{name}\\AppData ^ +x ~y";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adapter = new WindowsAdapter();

const freshTab = async () => {
  let front = await adapter.getForegroundWindow();
  await adapter.keyboardAction("press", { windowId: String(front.windowId), keys: "ctrl+n" });
  const readyBy = Date.now() + 8000;
  while (Date.now() < readyBy) {
    await sleep(300);
    front = await adapter.getForegroundWindow();
    if (/notepad/i.test(String(front?.processName ?? "")) && /^\*?untitled/i.test(String(front?.title ?? ""))) break;
  }
  await sleep(800);
  return front;
};

const saveAs = async (target, filePath) => {
  const isDialog = (w) => String(w.ClassName ?? "") === "#32770" && /save/i.test(String(w.MainWindowTitle ?? ""));
  const before = new Set((await adapter.listWindows()).filter(isDialog).map((w) => String(w.WindowHandle)));
  await adapter.keyboardAction("press", { windowId: String(target.windowId), keys: "ctrl+s" });
  let dialog = null;
  const by = Date.now() + 8000;
  while (Date.now() < by && !dialog) {
    await sleep(300);
    dialog = (await adapter.listWindows()).find((w) => isDialog(w) && !before.has(String(w.WindowHandle))) ?? null;
  }
  if (!dialog) return false;
  // The filename box is short and pre-selected; the path goes in by paste so
  // this step cannot itself be the thing that corrupts the measurement.
  await adapter.keyboardAction("type", { windowId: String(dialog.WindowHandle), text: filePath, method: "clipboard" });
  await sleep(500);
  await adapter.keyboardAction("press", { keys: "enter" });
  await sleep(1500);
  return true;
};

spawn("notepad.exe", [], { detached: false, stdio: "ignore", windowsHide: false });
await sleep(4000);

const results = [];
for (const [label, options] of [
  ["unicode batched (0us)", { method: "keys", pacingMicros: 0 }],
  ["unicode paced 1500us", { method: "keys", pacingMicros: 1500 }],
  ["unicode paced 6000us", { method: "keys", pacingMicros: 6000 }],
  ["clipboard paste", { method: "clipboard" }]
]) {
  const out = path.join(os.tmpdir(), `typemethod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  const tab = await freshTab();
  const typed = await adapter.keyboardAction("type", { windowId: String(tab.windowId), text: TEXT, ...options });
  await sleep(800);
  const saved = await saveAs(tab, out);
  let arrived = "(not saved)";
  if (saved) arrived = await fs.readFile(out, "utf8").catch(() => "(file missing)");
  const exact = arrived.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "") === TEXT.replace(/\r\n/g, "\n");
  results.push({ label, exact, method: typed.method, arrived });
  console.log(`${label.padEnd(22)} ${exact ? "EXACT" : "WRONG"}  (host method ${typed.method})`);
  if (!exact) console.log(`   arrived: ${JSON.stringify(arrived.replace(/\r\n/g, "\\n")).slice(0, 150)}`);
  await fs.rm(out, { force: true }).catch(() => {});
}

console.log("");
console.log("sent   :", JSON.stringify(TEXT.replace(/\r\n/g, "\\n")));
const winner = results.find((r) => r.exact);
console.log(winner ? `\nUSE: ${winner.label}` : "\nNo method delivered this text exactly.");
