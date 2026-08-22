// THE RECEIPTS, TAKEN OFF THE REAL MACHINE.
//
//   node scripts/probe-evidence.mjs
//
// The property test in tests/unit/tool-evidence.test.js proves that no tool can
// say a thing happened without a receipt. It cannot prove that the receipts are
// worth anything HERE — that `adapter.focusedElement` answers on this machine,
// that the foreground check sees the window it was asked about, that reading a
// file back after writing it costs what we think. Those are questions about the
// machine, and the only honest way to ask them is to ask the machine.
//
// So this runs the real toolset over the real Windows adapter and prints, for
// every step: the verdict, what was observed, which capability looked, which
// one acted, and how long the whole call took. The last number is the one to
// watch — every verification here is paid on every action, and W1 must not be
// the reason a GUI task got slower.
//
// Deliberately harmless: it reads, it writes to a temp file it deletes, it
// focuses the window that is ALREADY in front, and it puts the clipboard back
// the way it found it. It does not click anything, move the pointer, change the
// volume, or touch an application the user has open.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const toolset = buildToolset({
  registry: createDefaultCapabilityRegistry(adapter),
  adapter,
  basePath: process.cwd()
});

const pad = (value, width) => String(value).padEnd(width);
const MARK = { CONFIRMED: "✓", REFUTED: "✗", UNCONFIRMED: "?" };

async function step(label, tool, args) {
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await toolset.execute(tool, args);
  } catch (error) {
    console.log(`${pad(label, 22)} THREW  ${error?.message}`);
    return null;
  }
  const elapsed = Date.now() - startedAt;
  const receipt = outcome.raw?.evidence;
  if (!receipt) {
    // The one thing this probe is looking for. A tool with no receipt is a tool
    // that can still say anything it likes.
    console.log(`${pad(label, 22)} ${pad(`${elapsed}ms`, 8)} NO RECEIPT — ${String(outcome.text).slice(0, 80)}`);
    return outcome;
  }
  console.log(
    `${pad(label, 22)} ${pad(`${elapsed}ms`, 8)} ${MARK[receipt.verdict]} ${pad(receipt.verdict, 12)}` +
    `${pad(receipt.method, 26)}${receipt.actedVia ? `after ${receipt.actedVia}` : "(a reading)"}`
  );
  console.log(`${" ".repeat(24)}observed: ${String(receipt.observed).slice(0, 110)}`);
  console.log(`${" ".repeat(24)}said:     ${String(outcome.text).split("\n")[0].slice(0, 110)}`);
  return outcome;
}

// What each new check costs on its own, away from the tool that uses it. These
// are the per-action taxes W1 adds, and they are the numbers to argue about.
//
// COLD AND WARM SEPARATELY, because the first call to any of these starts the
// long-lived PowerShell host and pays for it — measured at 332ms against 20ms
// warm, which is a ten-fold difference and would make a per-click tax look
// unaffordable when it is not. A real run pays the cold cost once per process
// and the warm cost on every action after it.
async function timeRaw(label, run, repeats = 6) {
  const took = [];
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const startedAt = Date.now();
    try {
      await run();
    } catch (error) {
      console.log(`${pad(label, 34)} threw: ${error?.message}`);
      return;
    }
    took.push(Date.now() - startedAt);
  }
  const warm = [...took.slice(1)].sort((left, right) => left - right);
  const median = warm[Math.floor(warm.length / 2)];
  console.log(`${pad(label, 34)} cold ${pad(`${took[0]}ms`, 8)} warm p50 ${pad(`${median}ms`, 7)} (${warm.join(", ")})`);
}

const scratch = path.join(os.tmpdir(), `syscora-evidence-${Date.now()}.txt`);

console.log("\nTHE NEW PER-ACTION CHECKS, TIMED ON THEIR OWN");
console.log("-".repeat(78));
const windows = await adapter.listWindows().catch(() => []);
const front = (windows ?? []).find((window) => window.Foreground ?? window.foreground) ?? null;
await timeRaw("adapter.focusedElement (per click)", () => adapter.focusedElement({
  windowId: front ? String(front.WindowHandle ?? front.windowId) : null
}));
await timeRaw("adapter.getForegroundWindow (focus)", () => adapter.getForegroundWindow());
await timeRaw("adapter.listWindows (launch, state)", () => adapter.listWindows());

console.log("\nEVERY RECEIPT, FROM THE REAL MACHINE");
console.log("-".repeat(78));
console.log(`${pad("tool", 22)} ${pad("took", 8)}   ${pad("verdict", 14)}${pad("who looked", 26)}who acted`);
console.log("-".repeat(78));

await step("run", "run", { command: "where.exe git" });
await step("windows", "windows", {});
await step("wait", "wait", { ms: 20 });
await step("volume (read)", "volume", {});

// Writing, reading and editing a temp file: the readback is the whole point,
// and it is the check that catches a write of nothing at all.
await step("write_file", "write_file", { path: scratch, contents: "before\nsecond line\n" });
await step("read_file", "read_file", { path: scratch });
await step("edit_file", "edit_file", { path: scratch, old: "before", new: "after" });

// The clipboard, put back the way it was found.
const held = await toolset.execute("clipboard", {});
await step("clipboard (write)", "clipboard", { text: `syscora evidence probe ${Date.now()}` });
await step("clipboard (read)", "clipboard", {});
if (typeof held.raw?.text === "string") {
  await toolset.execute("clipboard", { text: held.raw.text }).catch(() => null);
  console.log(`${" ".repeat(24)}(the clipboard was put back the way it was found)`);
}

// The window that is ALREADY in front, so focusing it changes nothing the user
// can see while still exercising the check that used to be the word "Focused."
if (front) {
  const windowId = String(front.WindowHandle ?? front.windowId);
  console.log(`${" ".repeat(24)}(focusing ${front.ProcessName} — the window already in front, so nothing moves)`);
  await step("focus (already front)", "focus", { windowId });
  await step("screen", "screen", { windowId });
}

// And the case the whole thing exists for: a focus that will NOT take, so the
// REFUTED path is exercised on the real machine rather than only in a stub.
await step("focus (no such window)", "focus", { windowId: "999999999" });

await fs.rm(scratch, { force: true }).catch(() => {});
console.log("");
process.exit(0);
