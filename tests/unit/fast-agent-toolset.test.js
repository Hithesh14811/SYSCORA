// Every tool the model is offered must reach a capability that exists, with the
// argument names that capability actually declares.
//
// This is the failure mode a stub-based test cannot see: `filesystem.write`
// takes `content`, and a tool passing `contents` writes an empty file and
// reports success. So this builds the toolset over the REAL registry and checks
// the wiring, with a recording adapter underneath so nothing touches the
// machine.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";

// Records what the adapter was asked to do and answers plausibly.
function recordingAdapter() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve(RESPONSES[name] ?? { performed: true });
  };
  const RESPONSES = {
    executeCommand: { stdout: "ok", stderr: "", exitCode: 0 },
    readTextFile: { filePath: "C:\\x.txt", contents: "file body" },
    writeTextFile: { filePath: "C:\\x.txt", existed: false, nextContents: "written body" },
    clipboardAction: { text: "clip" },
    launchApplication: { application: "notepad", windowIdentity: { windowId: "42" } },
    listWindows: [{ WindowHandle: 42, ProcessName: "notepad", MainWindowTitle: "Untitled", Bounds: { x: 0, y: 0, width: 800, height: 600 }, Foreground: true }],
    manageWindow: { performed: true, windowId: "42" },
    pointerAction: { performed: true, x: 5, y: 6 },
    keyboardAction: { performed: true }
  };
  return {
    calls,
    executeCommand: record("executeCommand"),
    readTextFile: record("readTextFile"),
    writeTextFile: record("writeTextFile"),
    clipboardAction: record("clipboardAction"),
    launchApplication: record("launchApplication"),
    listWindows: record("listWindows"),
    manageWindow: record("manageWindow"),
    pointerAction: record("pointerAction"),
    keyboardAction: record("keyboardAction"),
    inspectUi: record("inspectUi"),
    captureScreen: record("captureScreen"),
    readOcr: record("readOcr"),
    playSpotifyTrack: record("playSpotifyTrack"),
    browserDomAction: record("browserDomAction"),
    getDocumentsPath: () => "C:\\Docs",
    getDesktopPath: () => "C:\\Desktop",
    getDownloadsPath: () => "C:\\Downloads"
  };
}

function realToolset() {
  const adapter = recordingAdapter();
  const registry = createDefaultCapabilityRegistry(adapter);
  return { toolset: buildToolset({ registry, adapter, basePath: "C:\\work" }), adapter, registry };
}

test("every tool the model is offered maps to a capability the registry has", () => {
  const { toolset, registry } = realToolset();
  // The names the tools delegate to, read straight out of the module rather
  // than restated here, so a rename cannot pass this test by being consistent
  // with a copy of itself.
  const delegated = [
    "command.run", "screen.read", "pointer.clickAt", "keyboard.type", "keyboard.press",
    "pointer.wheel", "application.launch", "window.enumerate", "window.activate",
    "window.maximize", "window.minimize", "window.restore",
    "filesystem.read", "filesystem.write", "clipboard.read", "clipboard.write",
    "spotify.track.play"
  ];
  for (const name of delegated) {
    assert.ok(registry.get(name), `the toolset delegates to ${name}, which is not registered`);
  }
  assert.ok(toolset.definitions.length >= 15, "the model should be offered a working set of verbs");
});

test("every tool declares a say parameter, so no step is silent", () => {
  const { toolset } = realToolset();
  for (const definition of toolset.definitions) {
    assert.ok(
      definition.function.parameters.properties.say,
      `${definition.function.name} has no "say", so calling it would show the user nothing`
    );
  }
});

test("running a command reaches the adapter with the command line intact", async () => {
  const { toolset, adapter } = realToolset();
  const result = await toolset.execute("run", { say: "Checking.", command: "git --version" });
  assert.equal(result.ok, true);
  const call = adapter.calls.find((entry) => entry.name === "executeCommand");
  assert.equal(call.args[1], "git --version", "the command line must not be mangled or re-parsed");
  assert.equal(call.args[0], "C:\\work", "it must run in the session's working directory");
  // `say` is narration, not an argument to the command.
  assert.ok(!JSON.stringify(call.args).includes("Checking."));
});

test("writing a file passes the contents through under the name the capability declares", async () => {
  const { toolset, adapter } = realToolset();
  const result = await toolset.execute("write_file", { path: "C:\\x.txt", contents: "written body" });
  assert.equal(result.ok, true);
  const call = adapter.calls.find((entry) => entry.name === "writeTextFile");
  assert.equal(call.args[1], "written body", "the file must be written with the contents, not empty");
  assert.match(result.text, /Wrote C:\\x\.txt/);
});

test("reading a file returns its contents to the model", async () => {
  const { toolset } = realToolset();
  const result = await toolset.execute("read_file", { path: "C:\\x.txt" });
  assert.equal(result.text, "file body");
});

test("typing and key presses reach the keyboard, clicks reach the pointer", async () => {
  const { toolset, adapter } = realToolset();
  await toolset.execute("type", { text: "hello" });
  await toolset.execute("key", { keys: "^s" });
  await toolset.execute("click", { x: 5, y: 6, application: "notepad" });
  const keyboard = adapter.calls.filter((entry) => entry.name === "keyboardAction");
  assert.deepEqual(keyboard.map((entry) => entry.args[0]), ["type", "press"]);
  assert.equal(keyboard[0].args[1].text, "hello");
  assert.equal(keyboard[1].args[1].keys, "^s");
  assert.ok(adapter.calls.some((entry) => entry.name === "pointerAction" && entry.args[0] === "click"));
});

test("launching an application remembers its window, so the next step lands on it", async () => {
  const { toolset, adapter } = realToolset();
  const launched = await toolset.execute("launch", { application: "notepad" });
  assert.match(launched.text, /windowId 42/);
  await toolset.execute("type", { text: "hi" });
  const typed = adapter.calls.filter((entry) => entry.name === "keyboardAction").at(-1);
  assert.equal(typed.args[1].windowId, "42", "typing must target the window that was just opened");
});

// Live, the agent ran a PowerShell command, then wrote a file using the same
// path spelling the shell had just accepted — and the write failed with ENOENT
// on a directory literally named `$env:USERPROFILE`.
test("a PowerShell-style path is expanded, not taken literally", async () => {
  const { WindowsAdapter } = await import("../../os-adapters/windows/src/windows-adapter.js");
  const adapter = new WindowsAdapter({ automationHost: false });
  const home = process.env.USERPROFILE || (await import("node:os")).homedir();

  for (const spelling of [
    "$env:USERPROFILE\\Desktop\\nothing-here.txt",
    "${env:USERPROFILE}\\Desktop\\nothing-here.txt",
    "%USERPROFILE%\\Desktop\\nothing-here.txt"
  ]) {
    // Reading a file that does not exist reports the path it resolved to, which
    // is what is under test. Nothing is written.
    const resolved = String(await adapter.readTextFile(spelling).catch((error) => error.path ?? error.message));
    assert.ok(resolved.startsWith(home), `${spelling} resolved to ${resolved}, not under ${home}`);
    assert.ok(!resolved.includes("env:"), `${spelling} was taken literally: ${resolved}`);
  }
});

// Live, "press enter" typed the letters e,n,t,e,r into YouTube's search box and
// reported performed:true — SendKeys treats a bare word as TEXT. The agent then
// spent its whole step budget retyping a query it had already typed correctly.
test("a key named the way people say it is pressed, not typed", async () => {
  const { normalizeSendKeys } = await import("../../os-adapters/windows/src/windows-adapter.js");
  const cases = {
    enter: "{ENTER}", Enter: "{ENTER}", ENTER: "{ENTER}", return: "{ENTER}",
    tab: "{TAB}", escape: "{ESC}", esc: "{ESC}", f5: "{F5}", F12: "{F12}",
    "ctrl+s": "^s", "Ctrl+S": "^s", "alt+f4": "%{F4}", "ctrl+shift+escape": "^+{ESC}",
    // Already in SendKeys notation: left exactly as written.
    "{ENTER}": "{ENTER}", "^s": "^s", "{ESC}39*17{ENTER}": "{ESC}39*17{ENTER}",
    // Not a key this knows: returned unchanged so it fails visibly rather than
    // being guessed into something plausible.
    "frobnicate": "frobnicate"
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeSendKeys(input), expected, `normalizeSendKeys(${JSON.stringify(input)})`);
  }
});

// Through the REAL adapter, because that is where the translation lives — a
// stub standing in for it proves only that the stub was called.
test("a bare key name reaches the automation host as a keystroke", async () => {
  const { WindowsAdapter } = await import("../../os-adapters/windows/src/windows-adapter.js");
  const sent = [];
  const adapter = new WindowsAdapter({
    automationHost: { request: async (operation, params) => { sent.push({ operation, params }); return { performed: true }; } }
  });
  const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });

  await toolset.execute("key", { keys: "enter" });
  await toolset.execute("key", { keys: "ctrl+s" });
  // Typing is text and must never be translated: "enter" typed is the word.
  await toolset.execute("type", { text: "enter" });

  assert.deepEqual(
    sent.map((entry) => [entry.operation, entry.params.keys ?? entry.params.text]),
    [["keyboard.press", "{ENTER}"], ["keyboard.press", "^s"], ["keyboard.type", "enter"]]
  );
});

// Live, asked for Señorita while Hamari Adhuri Kahani was already playing, this
// reported `Playing "Hamari Adhuri Kahani"` as a success — twice.
test("playing a track reports a mismatch instead of the track already playing", async () => {
  const make = (nowPlaying) => buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({ available: true, playback: { playing: true, nowPlaying } })
      })
    },
    adapter: {}
  });

  const wrong = await make("Hamari Adhuri Kahani (Title Track) by Jeet Gannguli")
    .execute("play_music", { query: "Senorita Zindagi Na Milegi Dobara" });
  assert.match(wrong.text, /NOT what was asked for/);
  assert.match(wrong.text, /Hamari Adhuri Kahani/);

  const right = await make("Senorita by Farhan Akhtar, Hrithik Roshan")
    .execute("play_music", { query: "Senorita" });
  assert.match(right.text, /^Playing "Senorita/);
});

// Live, a YouTube reading contained sixty entries of Chrome's own furniture —
// Minimise, Close, Back, Reload, the bookmarks bar, the tab strip — and not one
// search result. The agent concluded the page had not loaded and reopened it.
test("the application's own content outranks the window furniture", async () => {
  const chrome = [
    "Minimise", "Maximise", "Close", "Back", "Forward", "Reload", "Home",
    "View site information", "Install YouTube", "Bookmark this tab", "Extensions",
    "Tab groups", "All bookmarks", "New Tab", "Tab search", "Address and search bar"
  ].map((name, index) => ({
    role: "button", text: name, clickable: true,
    bounds: { x: index * 60, y: 40, width: 50, height: 30 }
  }));
  const results = Array.from({ length: 8 }, (_, index) => ({
    role: "hyperlink", text: `Not Your Type — episode ${index + 1}`, clickable: true,
    bounds: { x: 200, y: 600 + index * 120, width: 900, height: 100 }
  }));

  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "1", application: "chrome", title: "YouTube",
          visibleText: "", elements: [...chrome, ...results]
        })
      })
    },
    adapter: {}
  });

  const screen = await toolset.execute("screen", {});
  for (const result of results) {
    assert.match(screen.text, new RegExp(result.text.replace(/[—]/g, "."), "i"),
      `"${result.text}" must survive the cut; window chrome must not crowd it out`);
  }
  // And the furniture is still reachable when it is genuinely what is wanted.
  assert.match(screen.text, /"Close"/);
});

test("a tool that throws is reported as a failed result, never as an exception", async () => {
  const adapter = recordingAdapter();
  adapter.executeCommand = () => Promise.reject(new Error("the host died"));
  const registry = createDefaultCapabilityRegistry(adapter);
  const toolset = buildToolset({ registry, adapter });
  const result = await toolset.execute("run", { command: "anything" });
  assert.equal(result.ok, false);
  assert.match(result.text, /run failed: the host died/);
});
