// Does `launch` still find the right window — and does it now refuse the wrong one?
//
// Live, `launch mspaint` and `launch WhatsApp` both came back grounded on
// SYSCORA's own Electron chat window, because it was in front and absent from
// the previous enumeration. Everything afterwards read and typed into the wrong
// application while reporting success.
//
// This drives the real adapter against real windows: it launches Notepad, checks
// the window it gets back really is Notepad, and closes it again.
//
//   node scripts/probe-launch-identity.mjs

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const results = [];
const check = (name, passed, detail) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ").slice(0, 400)}` : ""}`);
};

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });

const before = await adapter.listWindows().catch(() => []);
console.log(`${before.length} windows open before launching. Foreground: ` +
  `${before.find((w) => w.Foreground)?.ProcessName ?? "?"}\n`);

try {
  const launched = await toolset.execute("launch", { application: "notepad" });
  console.log(`launch → ${launched.text}\n`);
  check("launching notepad reports a window", /windowId/.test(launched.text), launched.text);

  const windowId = (launched.text.match(/windowId (\d+)/) ?? [])[1];
  const windows = await adapter.listWindows().catch(() => []);
  const got = windows.find((w) => String(w.WindowHandle ?? w.windowId) === String(windowId));
  check("the window it returned is actually Notepad, not whatever was in front",
    Boolean(got) && /notepad/i.test(String(got.ProcessName ?? "")),
    got ? `${got.ProcessName} — "${got.MainWindowTitle}"` : `windowId ${windowId} is not in the window list`);

  // The reading must now say which application it is in, rather than "? — ?".
  const reading = await toolset.execute("screen", {});
  const header = String(reading.text).split("\n")[0];
  check("the reading names the application instead of \"? — ?\"",
    /notepad/i.test(header), header);

  // ONLY CLOSE WHAT THIS PROBE OPENED.
  //
  // The first version closed Notepad unconditionally, and twice that was the
  // user's own window with unsaved work in it. Windows 11 restored the session
  // both times, but a probe has no business gambling on that.
  const wasAlreadyOpen = /ALREADY RUNNING/.test(launched.text);
  if (wasAlreadyOpen) {
    console.log("SKIP  closing — Notepad was already open before this probe, so it is not ours to close");
  } else {
    const closed = await toolset.execute("close_app", { application: "notepad" });
    check("and the window this probe opened can be closed again", /is closed/.test(closed.text), closed.text);
  }
} catch (error) {
  check("the probe ran to completion", false, error?.stack ?? String(error));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
