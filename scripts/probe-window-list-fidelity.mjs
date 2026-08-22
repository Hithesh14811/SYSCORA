// DOES THE FASTER WINDOW LIST STILL SAY THE SAME THING?
//
//   node scripts/probe-window-list-fidelity.mjs
//   node scripts/probe-window-list-fidelity.mjs --break
//
// Get-WindowList stopped calling `Get-Process -Id` once per window and started
// building one lookup table instead — 405ms to 30ms. Speed is the easy half.
// The half that matters is that every window still comes back with the SAME
// process name, because a window list that is fast and wrong aims clicks and
// keystrokes at the wrong application, and it looks like evidence while doing
// it.
//
// So this checks the adapter's answer against a source that shares no code with
// it: `Get-Process` run in a separate powershell.exe, out of process, out of the
// automation host entirely. Every window's processId is looked up there and
// compared with the name the host reported.
//
// `--break` corrupts one row before comparing, to prove the check can fail. A
// check that has never been seen to fail is not a check.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const shouldBreak = process.argv.includes("--break");
const run = promisify(execFile);

const adapter = new WindowsAdapter();
await adapter.automationHost?.warm?.();
const windows = await adapter.listWindows();

// A DIFFERENT CODE PATH ON PURPOSE. Not the automation host, not the adapter's
// own PowerShell helper — a plain child process, so a defect inside the host
// cannot hide itself by answering both questions.
const { stdout } = await run("powershell", [
  "-NoProfile", "-Command",
  "Get-Process -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)`t$($_.ProcessName)\" }"
], { maxBuffer: 8 * 1024 * 1024 });

const truth = new Map();
for (const line of stdout.split(/\r?\n/)) {
  const [id, name] = line.split("\t");
  if (id && name) truth.set(Number(id), name.trim());
}

const rows = windows.map((window) => ({
  windowId: String(window.WindowHandle),
  processId: Number(window.Id),
  reported: window.ProcessName ?? null,
  title: window.MainWindowTitle ?? "",
  bounds: window.Bounds ?? {},
  dpi: window.Dpi ?? null
}));
if (shouldBreak && rows.length) rows[0].reported = "definitely-not-this-process";

const mismatches = [];
let checked = 0;
for (const row of rows) {
  const expected = truth.get(row.processId);
  // A process that exited between the two enumerations is not a mismatch, it is
  // a race. Only windows whose process is still alive can be judged.
  if (expected === undefined) continue;
  checked += 1;
  if (row.reported !== expected) mismatches.push({ ...row, expected });
}

console.log(`\n${rows.length} windows reported, ${checked} whose process was still alive and could be judged\n`);
for (const row of rows.slice(0, 40)) {
  console.log(
    `  ${row.windowId.padEnd(10)} ${String(row.reported ?? "—").padEnd(22)} ` +
    `pid ${String(row.processId).padEnd(7)} dpi ${String(row.dpi ?? "—").padEnd(5)} ` +
    `${String(row.bounds.width ?? 0)}x${String(row.bounds.height ?? 0)}  ${row.title.slice(0, 32)}`
  );
}

// Fields other than the name must survive too: the N+1 that was removed sat in
// the middle of the object literal that builds all of them.
const missingBounds = rows.filter((row) => !Number.isFinite(Number(row.bounds.width)));
const missingDpi = rows.filter((row) => !Number.isFinite(Number(row.dpi)) || Number(row.dpi) <= 0);
const missingName = rows.filter((row) => !row.reported && truth.has(row.processId));

console.log("");
console.log(`  process names disagreeing with a separate Get-Process : ${mismatches.length}`);
console.log(`  windows with no process name but a live process       : ${missingName.length}`);
console.log(`  windows with no bounds                                : ${missingBounds.length}`);
console.log(`  windows with no DPI                                   : ${missingDpi.length}`);
for (const row of mismatches) {
  console.log(`    MISMATCH ${row.windowId} pid ${row.processId}: host said "${row.reported}", Get-Process says "${row.expected}"`);
}

const failed = mismatches.length > 0 || missingName.length > 0 || missingBounds.length > 0 || missingDpi.length > 0;
console.log(`\n${failed ? "FAIL — the window list does not agree with the machine" : "PASS — every window agrees with a separate Get-Process"}\n`);
adapter.close?.();
process.exit(failed ? 1 : 0);
