// THE GATE THAT WOULD HAVE CAUGHT "Muted." BEFORE IT SHIPPED.
//
// One invariant — never claim something happened without evidence from a tool —
// has been patched five times at five different sites in this codebase, each
// patch written after the lie reached a user: a message reported sent that sat
// in a search box, a window reported focused that never took a keystroke, a
// volume reported muted while the music played, an invented version number, a
// song "playing" that never started.
//
// Every one of those was a `render` returning a string. Nothing structural
// stopped it, so each fix was another regex over English bolted on somewhere
// else, and the next tool added found a new way to do the same thing.
//
// This is the structural version. A tool's result carries a typed receipt (see
// evidence.js) and a success sentence is only reachable through `confirmed()`,
// which throws without one. These tests walk EVERY tool the model is offered and
// prove that:
//
//   1. no render can say anything at all from a result with no evidence, so
//      deleting a tool's evidence wiring fails a test rather than shipping;
//   2. no render says the same thing whether or not the machine agreed;
//   3. nothing that acts verifies itself with the capability that acted.
//
// The fixtures are not written by hand: every tool is EXECUTED against stubs and
// the real result is what gets tested, so a receipt that only exists in a
// literal in this file cannot pass.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import {
  CONFIRMED,
  EvidenceError,
  REFUTED,
  UNCONFIRMED,
  evidence,
  looksLikeSuccessClaim
} from "../../packages/fast-agent/src/evidence.js";

// ---------------------------------------------------------------------------
// A machine that answers plausibly and changes nothing.

const PAGE = { url: "https://example.com/", title: "Example", readyState: "complete" };
const DOM_TARGET = { targetId: "t1", source: "DOM", selector: "[data-syscora-target]", name: "Next", text: "Next" };
const FIELD_TARGET = { targetId: "f1", source: "DOM", selector: "#q" };

// The window's controls, as a reading gives them back. An Undo that is DISABLED
// is what "this document has nothing in it yet" looks like to every application
// with an edit history, which is how drag and draw prove they drew.
const ELEMENTS = [
  { role: "button", text: "Send", clickable: true, bounds: { x: 900, y: 700, width: 40, height: 40 } },
  { role: "button", text: "Undo", clickable: true, enabled: false, bounds: { x: 20, y: 20, width: 30, height: 30 } },
  { role: "edit", text: "Type a message", clickable: true, bounds: { x: 300, y: 700, width: 500, height: 40 } },
  { role: "pane", text: "", bounds: { x: 0, y: 100, width: 1200, height: 500 } }
];

function harness({ files = new Map(), overrides = {}, basePath } = {}) {
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

// ---------------------------------------------------------------------------
// One successful call per tool, run for real. `needsReading` first takes a look
// at the screen, because clicking by label is resolved against one.

const SUCCESS_CALLS = [
  { tool: "run", args: { command: "git --version" } },
  { tool: "run_jobs", args: { operation: "list" }, readOnly: true },
  { tool: "software", args: { name: "python" }, readOnly: true },
  { tool: "screen", args: { application: "app" } },
  { tool: "click", args: { text: "Send" }, needsReading: true },
  { tool: "type", args: { text: "hello" }, needsReading: true },
  { tool: "key", args: { keys: "ctrl+s" }, needsReading: true },
  { tool: "scroll", args: { direction: "down" }, needsReading: true },
  { tool: "drag", args: { fromX: 400, fromY: 300, toX: 600, toY: 500 }, needsReading: true },
  { tool: "draw", args: { shape: "rect", x: 300, y: 200, width: 200, height: 150 }, needsReading: true },
  { tool: "move_mouse", args: { x: 400, y: 300 }, needsReading: true },
  { tool: "launch", args: { application: "app" } },
  { tool: "new_document", args: { application: "app" }, needsReading: true },
  { tool: "open_url", args: { url: "https://example.com/" } },
  { tool: "windows", args: {} },
  { tool: "focus", args: { windowId: "9" } },
  { tool: "window_state", args: { state: "maximize", windowId: "9" } },
  { tool: "read_file", args: { path: "C:\\notes.txt" }, file: ["c:\\notes.txt", "a line"] },
  { tool: "write_file", args: { path: "C:\\fresh.txt", contents: "written body" } },
  { tool: "edit_file", args: { path: "C:\\edit.txt", old: "before", new: "after" }, file: ["c:\\edit.txt", "before\n"] },
  // WRITES A REAL FILE, so it gets a real directory. It goes to the filesystem
  // directly rather than through `filesystem.write`, because what it writes is
  // bytes rather than text — and its receipt comes from reading those bytes
  // back through documents.js, which is a parser that has never heard of the
  // writer. A stub here would prove nothing at all: the whole claim is that the
  // PDF on disk is one an independent extractor can read.
  {
    tool: "create_document",
    args: {
      filename: "Evidence check",
      format: "pdf",
      title: "Evidence check",
      content: "## A heading\n\nA paragraph with **bold** in it.\n\n- one\n- two"
    },
    needsRealFolder: true
  },
  // Two tools answer a question when called with nothing and change something
  // when called with an argument. Only the second is an action, and the receipt
  // for a pure reading names no capability that acted because none did.
  { tool: "clipboard", args: {}, label: "clipboard (read)", readOnly: true },
  { tool: "clipboard", args: { text: "copied" }, label: "clipboard (write)" },
  { tool: "play_music", args: { query: "Señorita" } },
  // Reaches the network in production, so this file gives it a query and
  // asserts the receipt shape; whether DuckDuckGo answers is measured by
  // tests/unit/web-search.test.js against a stubbed fetch.
  { tool: "search", args: { query: "syscora evidence test" }, readOnly: true },
  { tool: "web_open", args: { url: "https://example.com/" } },
  // Reaches api.github.com in production, like `search` above. Whatever comes
  // back — the repository, a 404, or GitHub having a bad afternoon — a receipt
  // comes with it, which is the whole thing this file exists to prove. The
  // parsing and the rate-limit path are tested against a stubbed fetch in
  // tests/unit/github-read.test.js, where they can be made to fail on demand.
  { tool: "github", args: { repo: "sindresorhus/slugify" }, readOnly: true },
  // The dispatcher for capabilities the agent saved itself. `list` is the one
  // action that needs nothing on disk and reaches no network, and it still has
  // to carry a receipt — see capabilities.js.
  { tool: "capability", args: { action: "list" }, readOnly: true },
  { tool: "web_read", args: {} },
  { tool: "web_click", args: { text: "Next" } },
  { tool: "web_type", args: { text: "hello", into: "Search" } },
  { tool: "web_scroll", args: { y: 600 } },
  { tool: "volume", args: { percent: 40 } },
  { tool: "volume", args: {}, label: "volume (read)", readOnly: true },
  { tool: "close_app", args: { application: "app" } },
  { tool: "remember", args: { fact: "the project lives in C:\\work" }, needsNotes: true },
  // Draws a card and sends nothing — `readOnly`, because it names no capability
  // that acted, and there is nothing in the world for a reading to check. The
  // fact that it CANNOT send is asserted separately, in email-draft.test.js.
  {
    tool: "email_draft",
    args: { to: "someone@example.com", subject: "Hello", body: "A short note." },
    readOnly: true
  },
  { tool: "wait", args: { ms: 1 } },
  { tool: "batch", args: { steps: [{ tool: "wait", args: { ms: 1 } }] } },
  // Undo needs something on the record to put back, so the volume moves first.
  // Called with an empty journal it takes a different path and returns a
  // different receipt, which is why both are here: a tool that only carries
  // evidence on its happy path carries it nowhere that matters.
  { tool: "undo", args: {}, needsUndoable: true },
  // Nothing on the record means nothing was touched, so this call reports
  // rather than acts — the same shape as `volume` and `clipboard` with no
  // arguments.
  { tool: "undo", args: {}, label: "undo (nothing on the record)", readOnly: true }
];

// Where `remember` writes. A real directory, thrown away afterwards, because the
// note it writes has to be readable back for the tool to prove it wrote it.
let notesRoot = null;
// Where `create_document` writes. Also a real directory, and for a stronger
// reason: its receipt is the file being read back by an independent parser, so
// there has to BE a file.
let documentsRoot = null;
test.before(async () => {
  notesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-evidence-"));
  documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-documents-"));
});
test.after(async () => {
  if (notesRoot) await fs.rm(notesRoot, { recursive: true, force: true }).catch(() => {});
  if (documentsRoot) await fs.rm(documentsRoot, { recursive: true, force: true }).catch(() => {});
});

async function runOne(call) {
  const files = new Map(call.file ? [call.file] : []);
  const { toolset } = harness({ files, basePath: call.needsNotes ? notesRoot : undefined });
  if (call.needsReading) await toolset.execute("screen", { application: "app" });
  if (call.needsUndoable) await toolset.execute("volume", { percent: 40 });
  const args = call.needsRealFolder ? { ...call.args, folder: documentsRoot } : call.args;
  const outcome = await toolset.execute(call.tool, args);
  return { outcome, raw: outcome.raw };
}

// Every tool executed once, keyed by the label used in failure messages.
//
// A tool whose receipt is missing fails HERE, with the reason, rather than three
// tests later as "cannot read properties of undefined": the toolset catches the
// EvidenceError its own render threw and returns no `raw` at all, so every later
// assertion trips over the absence instead of reporting the cause.
async function everyToolRun() {
  const runs = [];
  for (const call of SUCCESS_CALLS) {
    const label = call.label ?? call.tool;
    const { outcome, raw } = await runOne(call);
    assert.ok(
      raw?.evidence,
      `${label} produced no evidence, so nothing it says can be checked. What it said instead:\n` +
        `  ${String(outcome.text).split("\n").slice(0, 3).join("\n  ")}\n` +
        "Its execute() must return evidence({ observed, method, verdict }) on every path — see evidence.js."
    );
    runs.push({ call, label, outcome, raw });
  }
  return runs;
}

// ---------------------------------------------------------------------------

test("every tool the model is offered is exercised by this file", () => {
  const { toolset } = harness();
  const offered = toolset.definitions.map((definition) => definition.function.name).sort();
  const covered = [...new Set(SUCCESS_CALLS.map((call) => call.tool))].sort();
  assert.deepEqual(
    offered.filter((name) => !covered.includes(name)),
    [],
    "a tool was added without a successful call here, so nothing proves its evidence is wired"
  );
});

// THE CENTRAL TEST. Delete a tool's evidence wiring and this fails, rather than
// a user discovering it.
test("no tool can render anything from a result with no evidence", async () => {
  const { toolset } = harness();
  const byName = new Map(toolset.toolsForTest.map((tool) => [tool.name, tool]));
  for (const { call, label, raw } of await everyToolRun()) {
    const stripped = { ...raw };
    delete stripped.evidence;
    assert.throws(
      () => byName.get(call.tool).render(stripped),
      EvidenceError,
      `${label}.render() spoke without evidence. Every sentence it can return must go through ` +
        "confirmed(), refuted(), unconfirmed() or reported()."
    );
  }
});

// A render that says the same thing whether or not the machine agreed is not
// reading the evidence — it is decorating it.
test("no tool that acts says the same thing when the machine did not confirm it", async () => {
  const { toolset } = harness();
  const byName = new Map(toolset.toolsForTest.map((tool) => [tool.name, tool]));
  for (const { call, label, raw } of await everyToolRun()) {
    const tool = byName.get(call.tool);
    if (!tool.acts || call.readOnly) continue;
    if (raw.evidence.verdict !== CONFIRMED) continue;
    const confirmedText = tool.render(raw);
    for (const verdict of [UNCONFIRMED, REFUTED]) {
      const downgraded = {
        ...raw,
        evidence: evidence({
          observed: "nothing could be read back",
          method: raw.evidence.method,
          actedVia: raw.evidence.actedVia,
          verdict
        })
      };
      let text = null;
      try {
        text = tool.render(downgraded);
      } catch (error) {
        // Refusing to speak at all is the strongest possible answer here.
        assert.ok(error instanceof EvidenceError, `${label} threw something other than EvidenceError`);
        continue;
      }
      assert.notEqual(
        text, confirmedText,
        `${label} says exactly the same thing on ${verdict} as on CONFIRMED, so its sentence is not ` +
          "reading the evidence"
      );
      assert.equal(
        looksLikeSuccessClaim(text), false,
        `${label} claims success on a ${verdict} result: ${JSON.stringify(text.slice(0, 200))}`
      );
    }
  }
});

// VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES.
test("every tool that acts is verified by a capability other than the one that acted", async () => {
  const { toolset } = harness();
  const byName = new Map(toolset.toolsForTest.map((tool) => [tool.name, tool]));
  for (const { call, label, raw } of await everyToolRun()) {
    const tool = byName.get(call.tool);
    if (!tool.acts || call.readOnly) continue;
    assert.ok(
      raw.evidence.actedVia,
      `${label} is declared as acting but its evidence names no capability that acted`
    );
    assert.notEqual(
      raw.evidence.method, raw.evidence.actedVia,
      `${label} checks ${raw.evidence.actedVia} with itself`
    );
  }
});

test("every tool's evidence is a complete receipt", async () => {
  for (const { label, raw } of await everyToolRun()) {
    const receipt = raw.evidence;
    assert.ok(String(receipt.observed ?? "").trim(), `${label} observed nothing — an empty check is not a check`);
    assert.ok(String(receipt.method ?? "").trim(), `${label} does not say what read it back`);
    assert.ok(Number.isFinite(receipt.at), `${label} has no timestamp`);
    assert.ok([CONFIRMED, REFUTED, UNCONFIRMED].includes(receipt.verdict), `${label} has verdict ${receipt.verdict}`);
  }
});

// ---------------------------------------------------------------------------
// The five sentences that actually shipped. Each one is now unreachable without
// the machine having agreed, and each is pinned here by name.

test('"Sent." is unreachable when the box still holds the message', async () => {
  const { toolset } = harness({
    overrides: {
      capabilities: {
        // Enter is only gated as a SEND in a messaging window, and the gate is
        // what turns on the read-back. The window has to look like one.
        "screen.read": async () => ({
          read: true, windowId: "9", application: "WhatsApp", title: "Amma — WhatsApp",
          visibleText: "", elements: ELEMENTS
        })
      },
      adapter: {
        // The message is still sitting in the box after Enter: nothing went.
        focusedElement: async () => ({ found: true, name: "Type a message", value: "kabhi kushi", boundingRect: { x: 300, y: 700, width: 500, height: 40 } })
      }
    }
  });
  await toolset.execute("screen", { application: "whatsapp" });
  await toolset.execute("type", { text: "kabhi kushi", into: "Type a message" });
  const pressed = await toolset.execute("key", { keys: "enter" });
  assert.equal(pressed.raw.evidence.verdict, REFUTED);
  assert.equal(looksLikeSuccessClaim(pressed.text), false);
  assert.doesNotMatch(pressed.text, /^Sent\.$/);
});

test('"Muted." is unreachable when the endpoint is still emitting', async () => {
  const { toolset } = harness({
    overrides: {
      capabilities: {
        // The flag took. The meter says sound is still coming out, which is the
        // contradiction the user could hear.
        "system.volume.set": async () => ({ requestedPercent: 40, percent: 40, muted: true, peak: 0.4, applied: true }),
        "system.volume.inspect": async () => ({ available: true, percent: 40, muted: true, peak: 0.4 })
      }
    }
  });
  const muted = await toolset.execute("volume", { mute: true });
  assert.notEqual(muted.raw.evidence.verdict, CONFIRMED);
  assert.match(muted.text, /still emitting/i);
});

test('"Focused." is unreachable when another window is in front', async () => {
  const { toolset } = harness({
    overrides: {
      adapter: {
        getForegroundWindow: async () => ({ windowId: "77", processName: "somethingelse", title: "Not it" })
      }
    }
  });
  const focused = await toolset.execute("focus", { windowId: "9" });
  assert.equal(focused.raw.evidence.verdict, REFUTED);
  assert.equal(focused.ok, false);
  assert.equal(looksLikeSuccessClaim(focused.text), false);
});

// The capability's input is `content`, singular. Getting it wrong writes an
// empty file and used to report "Wrote notes.txt".
test('"Wrote …" is unreachable when the file did not get the bytes', async () => {
  const { toolset } = harness({
    overrides: {
      capabilities: {
        "filesystem.write": async () => ({ filePath: "C:\\fresh.txt", existed: false }),
        "filesystem.read": async () => ({ filePath: "C:\\fresh.txt", contents: "" })
      }
    }
  });
  const wrote = await toolset.execute("write_file", { path: "C:\\fresh.txt", contents: "written body" });
  assert.equal(wrote.raw.evidence.verdict, REFUTED);
  assert.equal(wrote.ok, false);
  assert.doesNotMatch(wrote.text, /^Wrote /);
});

test("a click nothing confirms is reported as unconfirmed, not as a click that worked", async () => {
  const { toolset } = harness({
    overrides: {
      adapter: {
        // Nothing claims focus, so the application says nothing about the click.
        focusedElement: async () => null
      }
    }
  });
  await toolset.execute("screen", { application: "app" });
  const clicked = await toolset.execute("click", { text: "Send" });
  assert.equal(clicked.raw.evidence.verdict, UNCONFIRMED);
  // Unconfirmed is NOT failed: the step still counts as having run.
  assert.equal(clicked.ok, true);
  assert.equal(looksLikeSuccessClaim(clicked.text), false);
});

// ---------------------------------------------------------------------------

test("evidence() refuses a receipt that verifies an action with itself", () => {
  assert.throws(
    () => evidence({ observed: "performed: true", method: "keyboard.type", actedVia: "keyboard.type", verdict: CONFIRMED }),
    EvidenceError
  );
});

test("evidence() refuses an empty observation", () => {
  assert.throws(
    () => evidence({ observed: "   ", method: "uia.focusedElement", verdict: UNCONFIRMED }),
    EvidenceError
  );
});

test("a render that speaks without evidence becomes an honest failure, not a crash", async () => {
  const { toolset } = harness({
    overrides: {
      capabilities: {
        // A capability that answers with nothing at all: the tool cannot build a
        // receipt from it, and must not invent one.
        "clipboard.read": async () => { throw new Error("the clipboard is unreadable"); }
      }
    }
  });
  const read = await toolset.execute("clipboard", {});
  assert.equal(read.ok, false);
  assert.equal(looksLikeSuccessClaim(read.text), false);
});
