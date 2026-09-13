// THE MOCK MACHINE, SHARED BY EVERYTHING THAT NEEDS ONE.
//
// Lifted verbatim out of `tool-evidence.test.js`, which built it first and is
// still its largest caller. It moved here the moment a SECOND thing needed it —
// `scripts/probe-fault-injection.mjs`, which injects actuator failures into the
// same stubs and counts how many tools would claim success anyway.
//
// WHY IT IS SHARED RATHER THAN COPIED. Two mock machines that are supposed to
// agree are one edit away from not agreeing, and the one that drifts is the one
// grading the safety invariant. This codebase has already paid for that: the
// honesty backstop's verb list was written out three times and the copies had
// ALREADY diverged before anyone noticed — `renamed it` was uncaught while
// `I renamed it` was caught.
//
// `overrides.adapter` and `overrides.capabilities` are the seams. A healthy
// machine is the default; a broken one is the default with a few entries
// replaced, which is what makes fault injection a fixture change rather than a
// second harness.

import { buildToolset } from "../../../packages/fast-agent/src/tools.js";

// ---------------------------------------------------------------------------
// A machine that answers plausibly and changes nothing.

export const PAGE = { url: "https://example.com/", title: "Example", readyState: "complete" };
export const DOM_TARGET = { targetId: "t1", source: "DOM", selector: "[data-syscora-target]", name: "Next", text: "Next" };
export const FIELD_TARGET = { targetId: "f1", source: "DOM", selector: "#q" };

// The window's controls, as a reading gives them back. An Undo that is DISABLED
// is what "this document has nothing in it yet" looks like to every application
// with an edit history, which is how drag and draw prove they drew.
export const ELEMENTS = [
  { role: "button", text: "Send", clickable: true, bounds: { x: 900, y: 700, width: 40, height: 40 } },
  { role: "button", text: "Undo", clickable: true, enabled: false, bounds: { x: 20, y: 20, width: 30, height: 30 } },
  { role: "edit", text: "Type a message", clickable: true, bounds: { x: 300, y: 700, width: 500, height: 40 } },
  { role: "pane", text: "", bounds: { x: 0, y: 100, width: 1200, height: 500 } }
];

export function harness({ files = new Map(), overrides = {}, basePath } = {}) {
  const calls = [];
  const record = (name, value) => { calls.push(name); return value; };
  // Undo goes from disabled to enabled the moment something is drawn, which is
  // the application itself saying the document changed.
  let drawn = false;
  let clipboard = "on the clipboard";

  const adapter = {
    executeCommand: async (cwd, command) => record("executeCommand", { stdout: "", stderr: "", exitCode: 0, command }),
    inspectCommand: async (name) => record("inspectCommand", {
      checked: true,
      installed: true,
      requested: name,
      command: String(name).toLowerCase(),
      path: "C:\\Python312\\python.exe",
      paths: ["C:\\Python312\\python.exe"],
      version: "Python 3.12.4"
    }),
    listWindows: async () => record("listWindows", [{
      WindowHandle: 9, ProcessName: "app", MainWindowTitle: "The app",
      Bounds: { x: 0, y: 0, width: 1200, height: 800 }, Foreground: true
    }]),
    listProcessParents: async () => new Map(),
    listProcesses: async () => record("listProcesses", { processes: [] }),
    inspectUi: async () => record("inspectUi", {
      windows: [{ ProcessName: "app", MainWindowTitle: "The app" }],
      elements: ELEMENTS.map((element) => (
        /^undo/i.test(element.text) ? { ...element, enabled: drawn } : element
      ))
    }),
    captureScreen: async () => record("captureScreen", { captured: false }),
    readOcr: async () => ({ text: "" }),
    pointerAction: async (kind, inputs) => {
      if (kind === "drag") drawn = true;
      return record("pointerAction", { performed: true, x: inputs?.toX ?? 5, y: inputs?.toY ?? 6, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    },
    pointerStroke: async () => { drawn = true; return record("pointerStroke", { performed: true, strokes: 1, durationMs: 40 }); },
    keyboardAction: async () => record("keyboardAction", { performed: true }),
    focusedElement: async () => record("focusedElement", {
      found: true, name: "Send", value: "", boundingRect: { x: 900, y: 700, width: 40, height: 40 }
    }),
    invokeControl: async () => record("invokeControl", { performed: false, reason: "unavailable" }),
    getForegroundWindow: async () => record("getForegroundWindow", { windowId: "9", processName: "app", title: "The app" }),
    getDocumentsPath: () => "C:\\Docs",
    getDesktopPath: () => "C:\\Desktop",
    getDownloadsPath: () => "C:\\Downloads",
    ...overrides.adapter
  };

  const capabilities = {
    "command.run": async (inputs) => ({ stdout: "git version 2.45", stderr: "", exitCode: 0, command: inputs.command }),
    "screen.read": async () => ({
      read: true, windowId: "9", application: "app", title: "The app",
      visibleText: "The app", elements: ELEMENTS
    }),
    "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y }),
    "pointer.wheel": async () => ({ performed: true }),
    "keyboard.type": async () => ({ performed: true }),
    "keyboard.press": async () => ({ performed: true }),
    "application.launch": async (inputs) => ({
      application: inputs.application, windowIdentity: { windowId: "9", title: "The app" }
    }),
    "application.close": async () => ({ performed: true }),
    "window.enumerate": async () => ({
      windows: [{ WindowHandle: 9, ProcessName: "app", MainWindowTitle: "The app", Bounds: { x: 0, y: 0, width: 1200, height: 800 } }]
    }),
    "window.activate": async () => ({ performed: true, foregroundWindowId: "9" }),
    "window.maximize": async () => ({ performed: true }),
    "window.minimize": async () => ({ performed: true }),
    "window.restore": async () => ({ performed: true }),
    "filesystem.read": async (inputs) => {
      const key = String(inputs.filePath).toLowerCase();
      if (!files.has(key)) throw new Error("ENOENT");
      return { filePath: inputs.filePath, contents: files.get(key) };
    },
    "filesystem.write": async (inputs) => {
      files.set(String(inputs.filePath).toLowerCase(), String(inputs.content ?? ""));
      return { filePath: inputs.filePath, existed: false };
    },
    // Reading the tree, not changing it. Both answer with the real result shape
    // — the counters included — because the renders quote them, and a stub that
    // omits a field would let a render that never reads it pass.
    "filesystem.findFiles": async (inputs) => ({
      root: inputs.rootDirectory,
      glob: inputs.glob,
      files: [{ path: "C:\\work\\src\\server.js", relative: "src/server.js", size: 42, modified: null }],
      filesScanned: 3,
      unreadableDirectories: 0,
      truncated: false,
      scanLimited: false
    }),
    "filesystem.searchCode": async (inputs) => ({
      root: inputs.rootDirectory,
      query: inputs.query,
      regex: false,
      glob: inputs.glob ?? null,
      matches: [{ relative: "src/server.js", path: "C:\\work\\src\\server.js", line: 2, column: 3, text: "  return listen(4317);" }],
      fileCount: 1,
      filesRead: 3,
      filesScanned: 3,
      skippedBinary: 0,
      skippedLarge: 0,
      unreadableDirectories: 0,
      truncated: false,
      scanLimited: false
    }),
    // Stateful, because the point of the write path is that it reads back what
    // it put there: a clipboard stub that always answers the same thing would
    // make the readback prove nothing.
    "clipboard.read": async () => ({ text: clipboard }),
    "clipboard.write": async (inputs) => { clipboard = String(inputs.text ?? ""); return { performed: true }; },
    "spotify.track.play": async () => ({
      available: true, playback: { playing: true, nowPlaying: "Señorita" }
    }),
    "browser.launch": async () => ({ launched: true }),
    "browser.wait": async () => ({ waited: true }),
    "browser.currentState": async () => ({ ...PAGE }),
    "browser.inspect": async () => ([{ controlType: "a", text: "Next", clickable: true, href: "https://example.com/next" }]),
    "browser.read": async () => ({ found: true, text: "Some page text that is long enough to be a page." }),
    "browser.findBest": async () => ({ found: true, target: DOM_TARGET, textCoverage: 1 }),
    "browser.findField": async () => ({ found: true, target: FIELD_TARGET, label: "Search" }),
    "browser.click": async () => ({ performed: true, target: DOM_TARGET }),
    "browser.type": async (inputs) => ({ performed: true, landed: String(inputs.text ?? ""), target: FIELD_TARGET }),
    "browser.key": async () => ({ performed: true }),
    "browser.scroll": async () => ({ performed: true, moved: true, scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 600 } }),
    "browser.dismissCookieNotice": async () => ({ performed: true }),
    "system.volume.inspect": async () => ({ available: true, percent: 40, muted: false, peak: 0 }),
    "system.volume.set": async (inputs) => ({
      requestedPercent: inputs.percent, percent: inputs.percent, muted: inputs.mute === true, peak: 0, applied: true
    }),
    ...overrides.capabilities
  };

  const registry = { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) };
  const toolset = buildToolset({ registry, adapter, basePath: basePath ?? "C:\\work" });
  // This suite deliberately exercises every optional tool, including arbitrary
  // shell and confirmation-gated actions. Production now fails closed when
  // either capability is not explicitly enabled, so the fixture must opt in.
  toolset.setAccessPolicy({ approvalMode: "balanced", developerMode: true, shellExecutionMode: "host" });
  toolset.setConfirmer(async () => true);
  return {
    toolset,
    calls,
    files,
    capabilities
  };
}
