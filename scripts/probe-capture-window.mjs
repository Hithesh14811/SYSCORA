#!/usr/bin/env node
// Save a PNG of one window, so a HUMAN can look at it.
//
// Reading the screen cannot see a drawing: OCR of a canvas with a car on it and
// OCR of a blank one return the same nothing, and the UIA tree has no node for
// a shape. `draw` proves the document CHANGED, which is the right evidence for
// the agent — but "the undo stack grew" is not something to show a user who
// asked for a beautiful car. This is for that: the pixels, on disk, for eyes.
//
// It is not evidence the agent may use. It is evidence for the person.
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import path from "node:path";
import fs from "node:fs";

const wanted = (process.argv[2] ?? "Paint").toLowerCase();
const out = process.argv[3] ?? path.join(process.env.USERPROFILE ?? ".", "SYSCORA", `capture-${Date.now()}.png`);

const adapter = new WindowsAdapter();
// The host returns Win32-shaped records — Id/ProcessName/MainWindowTitle/
// WindowHandle — not the friendly names the tool layer uses. Reading the shape
// rather than assuming it is the difference between this working and printing
// seventeen blank rows.
const windows = await adapter.listWindows?.() ?? [];
const named = windows.filter((w) => String(w.MainWindowTitle ?? "").trim() !== "");
const match = named.find((w) =>
  String(w.MainWindowTitle ?? "").toLowerCase().includes(wanted) ||
  String(w.ProcessName ?? "").toLowerCase().includes(wanted));

if (!match) {
  console.log(`No window matching ${JSON.stringify(wanted)}. Open windows:`);
  for (const w of named) console.log(`  ${w.ProcessName} — ${w.MainWindowTitle}`);
  process.exit(1);
}

console.log(`capturing: ${match.ProcessName} — "${match.MainWindowTitle}" (handle ${match.WindowHandle})`);
const result = await adapter.hostRequest("screen.capture", { windowId: match.WindowHandle, path: out }, { timeoutMs: 30000 });
console.log("result:", JSON.stringify(result).slice(0, 300));

// The host reporting a path is not the same as a file existing at it — that
// distinction is the whole reason this codebase has an evidence module.
if (fs.existsSync(out)) {
  console.log(`WROTE ${out} — ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
} else {
  console.log(`NO FILE at ${out} — the host reported success and wrote nothing.`);
  process.exitCode = 1;
}
await adapter.close?.();
process.exit(process.exitCode ?? 0);
