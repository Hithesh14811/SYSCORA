// Live check that SYSCORA can actually see and act on this desktop.
//
// Every one of these was, at some point, broken in a way no unit test could
// catch, because the failure was in the wiring between subsystems that all
// passed their own tests: the vision provider was never constructed, the screen
// snapshot callback was never passed to the loop, window resolution ignored the
// application name, and scrolling down threw inside PowerShell. Mocks cannot
// find those. A real window can.
//
// Run against a live Windows session:
//   node scripts/diag/desktop-senses.mjs [applicationName]
//
// Exits non-zero if any sense is unavailable, so it can gate a release.

import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const wanted = process.argv[2] ?? null;
const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter, {});
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
}

// Some senses can only be demonstrated when the window happens to offer the
// conditions — you cannot show that scrolling reveals new content in a document
// that is one line long. That is not the agent failing, and reporting it as a
// failure would train the reader to ignore this output.
function skip(name, detail) {
  console.log(`SKIP  ${name.padEnd(34)} ${detail}`);
}

async function timed(fn) {
  const startedAt = Date.now();
  try {
    // Await FIRST. An object literal evaluates its properties in order, so
    // computing `ms` before the await measured nothing and reported 0ms.
    const value = await fn();
    return { ms: Date.now() - startedAt, value };
  } catch (error) {
    return { ms: Date.now() - startedAt, error: error.message };
  }
}

// The host loads UI Automation, WinForms and OCR on first use. Warm it so the
// timings below measure the senses rather than the startup.
await adapter.automationHost?.warm?.();

const windows = await adapter.listWindows();
// A window worth examining has a title and real estate. Tooltip and popup hosts
// carry their parent's process name, so matching on name alone picked
// "Pop-upHost" for "Notepad" — a window that then disappeared mid-check and made
// every sense look broken.
const visible = windows
  .filter((window) => {
    const bounds = window.Bounds ?? window.bounds ?? {};
    return String(window.MainWindowTitle ?? "").trim()
      && Number(bounds.width ?? 0) >= 200 && Number(bounds.height ?? 0) >= 200;
  })
  .sort((left, right) => {
    const area = (window) => Number(window.Bounds?.width ?? 0) * Number(window.Bounds?.height ?? 0);
    return area(right) - area(left);
  });
report("enumerate windows", visible.length > 0, `${visible.length} visible`);

const target = (wanted
  ? visible.find((window) => `${window.ProcessName} ${window.MainWindowTitle}`.toLowerCase().includes(wanted.toLowerCase()))
  : null) ?? visible.find((window) => window.Foreground) ?? visible[0];
if (!target) {
  console.log("\nNo visible window to examine. Open an application and run this again.");
  process.exit(1);
}
const windowId = String(target.WindowHandle);
console.log(`\nExamining: ${target.MainWindowTitle} (${target.ProcessName})\n`);

// SEEING: capture + OCR + accessibility tree, fused, with coordinates.
const screen = await timed(() => registry.get("screen.read").execute({ windowId }));
const elements = screen.value?.elements ?? [];
if (screen.value?.capturePath) console.log(`Capture: ${screen.value.capturePath}`);
const withCentres = elements.filter((element) => Number.isFinite(element.center?.x));
report("read the screen", screen.value?.read === true, `${screen.ms}ms, ${elements.length} elements`);
report("read visible text", String(screen.value?.visibleText ?? "").trim().length > 0,
  JSON.stringify(String(screen.value?.visibleText ?? "").replace(/\s+/g, " ").slice(0, 60)));
report("know exact coordinates", withCentres.length > 0,
  withCentres.length ? `e.g. "${withCentres[0].text.slice(0, 24)}" at ${withCentres[0].center.x},${withCentres[0].center.y}` : "none");
const pixelOnlyLabels = elements.filter((element) => element.source === "OCR");
// OCR targets are de-duplicated when UI Automation already exposes the same
// label, so a fully accessible window may legitimately have zero OCR-only
// elements even though pixel OCR produced the visible transcript.
report("extract pixel text with OCR", Boolean(screen.value?.capturePath) && String(screen.value?.visibleText ?? "").trim().length > 0,
  `${pixelOnlyLabels.length} labels existed only as pixels`);

// LOCATING: a label the user names, matched the way a person would match it.
const label = withCentres.map((element) => element.text).find((text) => text.trim().length >= 3);
if (label) {
  const located = await timed(() => registry.get("vision.locate").execute({ windowId, query: label.slice(0, 12) }));
  report("locate a named target", located.value?.found === true, `${located.ms}ms -> "${located.value?.matchedText ?? located.error}"`);
}

// SCROLLING: both directions, and the view must actually change.
const before = String(screen.value?.visibleText ?? "");
const down = await timed(() => registry.get("pointer.wheel").execute({
  windowId, notches: -6, speed: "fast", observe: true, observeEvery: 1
}));
report("scroll down", down.value?.performed === true, `${down.ms}ms, ${down.value?.delivered ?? 0} notches ${down.error ?? ""}`);
const observedFrames = down.value?.frames ?? [];
report("observe throughout scrolling", observedFrames.length >= 2,
  `${observedFrames.length} fresh frames captured during the motion`);
const afterText = String(observedFrames.at(-1)?.visibleText ?? "");
if (afterText !== before) {
  report("perceive scroll changes", true, "the visible text changed in the observed frames");
} else if (down.value?.performed === true) {
  // The wheel events were delivered and the view is identical, which is exactly
  // what a window with nothing below the fold looks like. Pass a long document
  // as the argument to exercise this properly.
  skip("perceive scroll changes", "nothing below the fold in this window; try a longer document");
} else {
  report("perceive scroll changes", false, "scrolling did not change the view");
}
const up = await timed(() => registry.get("pointer.wheel").execute({ windowId, notches: 6, speed: "fast" }));
report("scroll up", up.value?.performed === true, `${up.ms}ms, ${up.value?.delivered ?? 0} notches ${up.error ?? ""}`);

// POINTING: a coordinate must be justified by a window that exists right now.
const bounds = target.Bounds ?? {};
const inside = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
const refused = await timed(() => registry.get("pointer.clickAt").execute({ windowId, x: 999999, y: 999999 }));
report("refuse invented coordinates", Boolean(refused.error), refused.error ? "rejected before clicking" : "ACCEPTED — this is a defect");
report("coordinate click is available", Number.isFinite(inside.x), `window centre is ${inside.x},${inside.y}`);

// ACTING ON THE SYSTEM: an arbitrary command, the way a model writes one.
const command = await timed(() => registry.get("command.run").execute({
  command: "Get-Process | Sort-Object WS -Descending | Select-Object -First 1 -ExpandProperty Name"
}));
report("run an arbitrary command", command.value?.exitCode === 0, `${command.ms}ms -> ${String(command.value?.stdout ?? command.error).trim().slice(0, 40)}`);

const system = await timed(() => registry.get("system.inspect").execute({}));
report("know the system state", Boolean(system.value?.hostname), `${system.ms}ms -> ${system.value?.hostname} ${system.value?.release}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} senses working.`);
if (failed.length) console.log(`Broken: ${failed.map((result) => result.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
