// Defects found by driving the product, each of which reported success or
// blamed the model for something the code had done to it.
//
// Every one of these came out of a single live session, and none of them looked
// like the bug it was: a login typed a redaction placeholder, "switch accounts"
// was ignored because the accounts were indistinguishable, Paint drew nothing
// three times, an installer appeared that nobody asked for, and a request to
// improve a file was answered with the same sentence three times running.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildToolset, findActiveTool, findCanvas, hasUnreadableScript, wrongUrlNotice
} from "../../packages/fast-agent/src/tools.js";
import { describeMachine } from "../../packages/fast-agent/src/machine-profile.js";
import { reportsProgress } from "../../packages/fast-agent/src/command-progress.js";
import { createWingetWatcher, isWingetInstall } from "../../packages/fast-agent/src/winget-progress.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { sanitizeExternalContext } from "../../packages/shared-types/src/external-context.js";
import {
  WindowsAdapter, correlateLaunchWindow, applicationWindowScore
} from "../../os-adapters/windows/src/windows-adapter.js";

function baseAdapter(overrides = {}) {
  return {
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    listWindows: async () => [],
    listProcesses: async () => ({ processes: [] }),
    inspectUi: async () => ({ elements: [] }),
    captureScreen: async () => ({ captured: false }),
    readOcr: async () => ({ text: "" }),
    pointerAction: async () => ({ performed: true }),
    pointerStroke: async () => ({ performed: true }),
    keyboardAction: async () => ({ performed: true }),
    getDocumentsPath: () => "C:\\Docs",
    getDesktopPath: () => "C:\\Desktop",
    getDownloadsPath: () => "C:\\Downloads",
    ...overrides
  };
}

const toolsetOver = (adapter) =>
  buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: "C:\\work" });

// ---- The email the user typed reached the model as a placeholder ------------

test("an email address survives the trip to the model; a credential does not", () => {
  const sent = sanitizeExternalContext(
    "log in with hitheshs096@gmail.com, the key is sk-ABCDEFGH12345678"
  );
  assert.match(sent, /hitheshs096@gmail\.com/,
    "the user typed this address as the instruction — redacting it made the agent type the placeholder");
  assert.ok(!/REDACTED_EMAIL/.test(sent));
  assert.match(sent, /\*\*\*REDACTED\*\*\*/, "an API key is still a secret and still goes");
});

test("two accounts can be told apart, which is what 'switch if it is not the right one' needs", () => {
  const reading = sanitizeExternalContext(
    'Google Account: Prathibha Shetty (hitheshshettyvines@gmail.com); Hithesh Shetty hitheshs096@gmail.com'
  );
  const addresses = new Set(reading.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []);
  assert.equal(addresses.size, 2,
    "both accounts read as ***REDACTED_EMAIL***, so the comparison the model was asked to make was impossible");
});

// ---- launch grounded onto SYSCORA's own window ------------------------------

test("a window that is merely new and in front is not the application that was launched", () => {
  // Exactly what happened live: `launch mspaint` and `launch WhatsApp` both
  // grounded onto SYSCORA's Electron chat window, because it was foreground and
  // absent from the previous enumeration.
  const result = correlateLaunchWindow({
    application: "mspaint",
    beforeWindows: [],
    afterWindows: [
      { WindowHandle: 198792, ProcessName: "electron", MainWindowTitle: "SYSCORA", Foreground: true }
    ]
  });
  assert.equal(result.grounded, false,
    "no signal here names mspaint — accepting this window sends every later step to the wrong app");
});

test("a window that really is the application is still grounded", () => {
  for (const window of [
    { WindowHandle: 5, ProcessName: "mspaint", MainWindowTitle: "Untitled - Paint" },
    { WindowHandle: 6, ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp" }
  ]) {
    const result = correlateLaunchWindow({
      application: /paint/i.test(window.ProcessName) ? "mspaint" : "WhatsApp",
      beforeWindows: [],
      afterWindows: [window]
    });
    assert.equal(result.grounded, true, `${window.ProcessName} should still be found`);
    assert.equal(String(result.window.WindowHandle), String(window.WindowHandle));
  }
});

test("the launched process wins even when an unrelated window also appeared", () => {
  const result = correlateLaunchWindow({
    application: "notepad",
    beforeWindows: [],
    afterWindows: [
      { WindowHandle: 1, ProcessName: "electron", MainWindowTitle: "SYSCORA", Foreground: true },
      { WindowHandle: 2, ProcessName: "notepad", MainWindowTitle: "Untitled - Notepad" }
    ]
  });
  assert.equal(String(result.window.WindowHandle), "2");
});

// ---- Paint drew nothing, three times ---------------------------------------

test("the drawing surface is found, and is not the whole window", () => {
  const canvas = findCanvas([
    { text: "Undo", bounds: { x: 0, y: 0, width: 40, height: 20 } },
    { text: "", bounds: { x: 100, y: 200, width: 800, height: 600 } },
    { text: "", bounds: { x: 0, y: 0, width: 1000, height: 900 } }
  ]);
  // Returning the frame would put "the middle of the canvas" on the ribbon.
  assert.deepEqual(canvas, { x: 100, y: 200, width: 800, height: 600 });
});

test("an application that names its canvas is believed over any geometry guess", () => {
  const canvas = findCanvas([
    { text: "Using Oval tool on Canvas", bounds: { x: 300, y: 120, width: 900, height: 700 } },
    { text: "", bounds: { x: 0, y: 0, width: 1600, height: 1000 } }
  ]);
  assert.deepEqual(canvas, { x: 300, y: 120, width: 900, height: 700 });
});

// Paint's canvas, as a screen reading reports it. `tool` is the one named in
// the status bar, because which tool has the mouse decides whether a stroke is
// traced or reduced to the press-and-release a shape tool reads.
function paintToolset(tool = "Oval") {
  let strokes = 0;
  const drags = [];
  const adapter = baseAdapter({
    pointerStroke: async () => { strokes += 1; return { performed: true }; },
    pointerAction: async (kind, args) => {
      if (kind === "drag") drags.push(args);
      return { performed: true };
    }
  });
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "9", application: "mspaint", title: "Untitled - Paint",
          visibleText: "",
          elements: [
            { role: "Button", text: "Undo", bounds: { x: 800, y: 60, width: 40, height: 30 }, clickable: true },
            { role: "Pane", text: `Using ${tool} tool on Canvas`, bounds: { x: 300, y: 200, width: 900, height: 700 } }
          ]
        })
      })
    },
    adapter,
    readSignature: async () => null
  });
  return { toolset, strokes: () => strokes, drags: () => drags };
}

test("the screen reading states where the canvas is, because a canvas has no label to list", async () => {
  const { toolset } = paintToolset();
  const reading = await toolset.execute("screen", { application: "mspaint" });
  assert.match(reading.text, /Drawing surface/);
  assert.match(reading.text, /x 300 to 1200/);
  assert.match(reading.text, /y 200 to 900/);
});

test("a stroke outside the canvas is refused before the mouse moves, and says where the canvas is", async () => {
  const { toolset, strokes } = paintToolset();
  await toolset.execute("screen", { application: "mspaint" });

  // The coordinates the agent actually guessed live, three times over.
  const result = await toolset.execute("draw", { shape: "circle", cx: 2592, cy: 1300, radius: 150 });
  assert.equal(result.ok, false);
  assert.match(result.text, /outside the drawing surface/);
  assert.match(result.text, /300 to 1200/, "it must say where the canvas is, or the next guess is blind too");
  assert.equal(strokes(), 0, "nothing should have been sent to the mouse");
});

test("a stroke inside the canvas still draws", async () => {
  // This fixture always had the Oval tool in its status bar, which is why the
  // assertion below is now a drag rather than a stroke: with a shape tool
  // selected, a traced loop is the thing that draws NOTHING. See the shape-tool
  // tests further down for the failure this went with.
  const { toolset, drags, strokes } = paintToolset("Oval");
  await toolset.execute("screen", { application: "mspaint" });
  const result = await toolset.execute("draw", { shape: "circle", cx: 750, cy: 550, radius: 100 });
  assert.equal(result.ok, true);
  assert.equal(drags().length, 1);
  assert.equal(strokes(), 0);
});

test("a stroke inside the canvas is traced when a freehand tool has the mouse", async () => {
  const { toolset, strokes, drags } = paintToolset("Pencil");
  await toolset.execute("screen", { application: "mspaint" });
  const result = await toolset.execute("draw", { shape: "circle", cx: 750, cy: 550, radius: 100 });
  assert.equal(result.ok, true);
  assert.equal(strokes(), 1);
  assert.equal(drags().length, 0);
});

// ---- "I'll rebuild App.tsx" three times, and never did ----------------------

test("part of a file can be changed without rewriting the whole thing", async () => {
  let written = null;
  // The file as it actually is, before and AFTER — `edit_file` reads it back to
  // check the change took, so a fixture whose read always returns the original
  // is a fixture where every successful edit looks like it did not happen.
  let contents = "const a = 1;\nconst b = 2;\n";
  const adapter = baseAdapter({
    readTextFile: async () => ({ filePath: "App.tsx", contents }),
    writeTextFile: async (path, content) => {
      written = content;
      contents = content;
      return { filePath: path, existed: true };
    }
  });
  const toolset = toolsetOver(adapter);
  const result = await toolset.execute("edit_file", {
    path: "App.tsx", old: "const b = 2;", new: "const b = 42;"
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /line 2/);
  assert.equal(written, "const a = 1;\nconst b = 42;\n");
});

test("an edit whose anchor is not in the file changes nothing and shows the nearest line", async () => {
  const adapter = baseAdapter({
    readTextFile: async () => ({ filePath: "App.tsx", contents: "  const value = 1;\n" }),
    writeTextFile: async () => { throw new Error("must not write"); }
  });
  const result = await toolsetOver(adapter).execute("edit_file", {
    path: "App.tsx", old: "const value = 2;", new: "x"
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /not in/);
  assert.match(result.text, /const value = 1;/, "the closest real line is what turns this into a correction");
});

test("an ambiguous edit refuses rather than changing the wrong one", async () => {
  const adapter = baseAdapter({
    readTextFile: async () => ({ filePath: "a.ts", contents: "x();\nx();\n" }),
    writeTextFile: async () => { throw new Error("must not write"); }
  });
  const result = await toolsetOver(adapter).execute("edit_file", { path: "a.ts", old: "x();", new: "y();" });
  assert.equal(result.ok, false);
  assert.match(result.text, /appears 2 times/);
});

// ---- Text this machine cannot read back ------------------------------------

test("text in a script the OCR cannot read is flagged, so it is not re-sent", () => {
  assert.equal(hasUnreadableScript("好的！我来给你打几个中文词："), true);
  assert.equal(hasUnreadableScript("hello there"), false);
  assert.equal(hasUnreadableScript("Señorita — café"), false, "Latin accents are read fine");
});

// ---- Typing on a web page was gated as if it were somebody's document -------

test("a browser page is never treated as an unsaved document", async () => {
  let typed = 0;
  const adapter = baseAdapter({
    keyboardAction: async () => { typed += 1; return { performed: true }; },
    inspectUi: async () => ({
      windows: [{ WindowHandle: "3", ProcessName: "chrome", MainWindowTitle: "Google Flights" }],
      // A rendered page publishes itself as a Document with content in it —
      // which is exactly the shape the gate refuses on.
      elements: [
        { controlType: "Document", name: "Google Flights", value: "x".repeat(117),
          boundingRect: { x: 0, y: 0, width: 1600, height: 1200 }, supportedPatterns: ["Value"] },
        { name: "Undo", controlType: "Button", enabled: true, boundingRect: { x: 0, y: 0, width: 20, height: 20 } }
      ]
    })
  });
  const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
  const result = await toolset.execute("type", { text: "Sydney", application: "chrome" });
  assert.equal(result.ok, true, "typing into a web form must not be refused as overwriting a document");
  assert.equal(typed, 1);
});

test("a real editor with somebody's work in it is still gated", async () => {
  const adapter = baseAdapter({
    inspectUi: async () => ({
      windows: [{ WindowHandle: "4", ProcessName: "notepad", MainWindowTitle: "budget.txt - Notepad" }],
      elements: [
        { controlType: "Document", name: "Text editor", value: "the user's notes",
          boundingRect: { x: 0, y: 0, width: 800, height: 600 }, supportedPatterns: ["Value"] }
      ]
    })
  });
  const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
  const result = await toolset.execute("type", { text: "a poem", application: "notepad" });
  assert.equal(result.ok, false);
  assert.match(result.text, /already work in this document/);
});

// ---- Eight WhatsApp reads at three seconds each -----------------------------

test("a window with no accessibility tree is only probed once, not before every look", async () => {
  let treeOnlyReads = 0;
  let fullReads = 0;
  const adapter = baseAdapter({
    // WhatsApp's tree: a window, an input sink and the caption buttons.
    inspectUi: async ({ includeOcr } = {}) => ({
      windows: [{ WindowHandle: "7", ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp" }],
      elements: [
        { controlType: "Window", name: "WhatsApp", boundingRect: { x: 0, y: 0, width: 900, height: 700 } },
        { controlType: "Button", name: "Minimize", boundingRect: { x: 1, y: 1, width: 10, height: 10 } },
        { controlType: "Button", name: "Close", boundingRect: { x: 2, y: 1, width: 10, height: 10 } }
      ]
    }),
    captureScreen: async () => { fullReads += 1; return { captured: true, path: "x.png", bounds: null }; },
    readOcr: async () => ({ text: "Amma  Type a message" })
  });
  const registry = createDefaultCapabilityRegistry(adapter);
  const original = registry.get("screen.read").execute;
  registry.get("screen.read").execute = async (args) => {
    if (args?.includeOcr === false) treeOnlyReads += 1;
    return original(args);
  };
  const toolset = buildToolset({ registry, adapter, readSignature: async () => null });

  await toolset.execute("screen", { application: "WhatsApp" });
  await toolset.execute("screen", { application: "WhatsApp" });
  await toolset.execute("screen", { application: "WhatsApp" });

  assert.equal(treeOnlyReads, 1,
    "after the first look proved the tree is empty, probing it again before every read is pure latency");
});

// ---- The agent was handed %USERPROFILE% and could not open anything ---------

// THIS TEST HAD NO BACKSLASHES IN IT, WHICH IS THE ONE THING IT IS ABOUT.
//
// Written as `"C:\Users\hithe\OneDrive\…"` — single backslashes in a normal
// string literal. `\U`, `\h` and `\O` are identity escapes, so the string was
// actually `C:UsershitheOneDrive…`, and `\b` in `\beautify` was a literal
// BACKSPACE character. The assertion `/C:\Users\hithe\OneDrive/` collapsed the
// same way, so both sides were corrupted identically and the test passed —
// proving that a path with no separators in it survives sanitisation, which
// nobody ever doubted.
//
// The defect it exists for is real: rewriting the home directory to
// %USERPROFILE% made the agent echo that literal back into PowerShell, which
// does not expand %VAR%, so every path resolved against the working directory
// and nothing was found. Catching a regression in that needs the separators.
// String.raw, so there is nothing left to get wrong.
test("a real filesystem path reaches the model intact", () => {
  const path = String.raw`C:\Users\hithe\OneDrive\Documents\check\beautify-ecommerce\src\App.tsx`;
  assert.ok(path.includes("\\"), "if this string has no separators the test below is vacuous");
  const seen = sanitizeExternalContext(`Found it at ${path}`);
  assert.ok(seen.includes(String.raw`C:\Users\hithe\OneDrive`),
    "the home directory must survive with its separators intact");
  assert.ok(seen.includes(path), "the whole path must reach the model unaltered");
  assert.ok(!/%USERPROFILE%/.test(seen));
});

test("credentials are still redacted even though paths are not", () => {
  const seen = sanitizeExternalContext(
    String.raw`C:\Users\hithe\.env holds sk-ABCDEFGH12345678 and AKIAIOSFODNN7EXAMPLE`
  );
  assert.ok(seen.includes(String.raw`C:\Users\hithe\.env`), "the path is not a secret");
  assert.ok(!/sk-ABCDEFGH12345678/.test(seen));
  assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(seen));
});

// ---- A podcast episode played instead of the song --------------------------

test("a song row qualifies even though its title omits the artist", () => {
  // The exact rows Spotify returned. The old rule needed EVERY query token in
  // the label, so the song lost to an episode whose title happened to contain
  // the artist's name.
  const tokens = ["shake", "it", "off", "taylor", "swift"];
  const scoreOf = (label) => {
    const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return tokens.filter((token) => words.includes(token)).length;
  };
  const needed = Math.max(1, Math.ceil(tokens.length * 0.5));

  assert.ok(scoreOf("Shake It Off") >= needed, "the song row must be a candidate at all");
  assert.ok(scoreOf("Shake It Off - Taylor Swift") >= needed, "the episode is still a candidate");
  assert.ok(scoreOf("Shake It Off") < tokens.length,
    "and it still does not match every token — which is exactly why the all-or-nothing rule dropped it");
});

test("the matcher script asks which kind of row it found, and says when it settled for an episode", async () => {
  const { WindowsAdapter } = await import("../../os-adapters/windows/src/windows-adapter.js");
  const adapter = new WindowsAdapter({ automationHost: false });
  let script = null;
  adapter.runPowerShell = async (text) => { script = text; return { stdout: "null", stderr: "", exitCode: 0 }; };
  await adapter._invokeSpotifyPlayButton("Shake It Off Taylor Swift", 2000, 999);

  assert.match(script, /\$isEpisode=/, "it must be able to tell a podcast row from a song row");
  assert.match(script, /Your Episodes/);
  assert.match(script, /if\(-not \$play -and \$episodePlay\)/,
    "an episode may only be used when nothing else answered to the name");
  assert.match(script, /pickedEpisode=\$pickedEpisode/,
    "and the caller has to be told, or it will report a podcast as the song");
});

test("playing a podcast is reported as a podcast, not as the track", async () => {
  const adapter = baseAdapter({
    playSpotifyTrack: async () => ({
      query: "Shake It Off Taylor Swift",
      available: true,
      playedEpisode: true,
      playback: { playing: true, nowPlaying: "Shake It Off - Taylor Swift" }
    })
  });
  const result = await toolsetOver(adapter).execute("play_music", { query: "Shake It Off Taylor Swift" });
  assert.match(result.text, /PODCAST EPISODE/);
  assert.ok(!/^Playing "Shake It Off - Taylor Swift"\.$/.test(result.text),
    "the old render said 'Playing …' for a talk show about the song");
});

test("an ordinary song still reports plainly", async () => {
  const adapter = baseAdapter({
    playSpotifyTrack: async () => ({
      query: "Shake It Off Taylor Swift",
      available: true,
      playedEpisode: false,
      playback: { playing: true, nowPlaying: "Taylor Swift - Shake It Off" }
    })
  });
  const result = await toolsetOver(adapter).execute("play_music", { query: "Shake It Off Taylor Swift" });
  assert.match(result.text, /Playing "Taylor Swift - Shake It Off"/);
  assert.ok(!/PODCAST/.test(result.text));
});

// ---- launch grounded on SYSCORA again, through a second code path ----------

function launchToolset(windows, launchResult = { application: "WhatsApp", failureCategory: "APPLICATION_NOT_INSTALLED" }) {
  const adapter = baseAdapter({ listWindows: async () => windows });
  return buildToolset({
    registry: { get: () => ({ execute: async () => launchResult }) },
    adapter
  });
}

test("the window that happens to be in front is not every application", async () => {
  // findRunningWindow added a +0.5 foreground bonus to an identity score of ZERO
  // and then filtered on `score > 0`, so the foreground window matched any name
  // asked for. The foreground window is nearly always SYSCORA's own chat.
  const toolset = launchToolset([
    { WindowHandle: 984410, ProcessName: "electron", MainWindowTitle: "SYSCORA", Foreground: true, Bounds: { width: 2400, height: 1600 } },
    { WindowHandle: 67276, ProcessName: "ChatGPT", MainWindowTitle: "ChatGPT", Bounds: { width: 2906, height: 1730 } }
  ]);
  const result = await toolset.execute("launch", { application: "WhatsApp" });
  assert.ok(!/SYSCORA/.test(result.text),
    "returning SYSCORA's own window sends every later read, click and keystroke to the wrong application");
  assert.ok(!/984410/.test(result.text));
});

test("an application that really is running is still found, foreground or not", async () => {
  const toolset = launchToolset([
    { WindowHandle: 984410, ProcessName: "electron", MainWindowTitle: "SYSCORA", Foreground: true, Bounds: { width: 2400, height: 1600 } },
    { WindowHandle: 393290, ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp", Bounds: { width: 1600, height: 1200 } }
  ], { performed: true });
  const result = await toolset.execute("launch", { application: "WhatsApp" });
  assert.match(result.text, /393290/, "the real WhatsApp window must still win");
  assert.match(result.text, /ALREADY RUNNING/);
});

test("foreground still breaks ties between windows that do answer to the name", async () => {
  const toolset = launchToolset([
    { WindowHandle: 1, ProcessName: "chrome", MainWindowTitle: "Docs - Google Chrome", Bounds: { width: 800, height: 600 } },
    { WindowHandle: 2, ProcessName: "chrome", MainWindowTitle: "Mail - Google Chrome", Foreground: true, Bounds: { width: 800, height: 600 } }
  ], { performed: true });
  const result = await toolset.execute("launch", { application: "chrome" });
  assert.match(result.text, /windowId 2/, "between two real Chrome windows, the one in front is the one meant");
});

// ---- scrolling the wrong way, four times, then blaming the tool ------------

async function scrollWith(args) {
  const sent = [];
  const toolset = buildToolset({
    registry: { get: () => ({ execute: async (inputs) => { sent.push(inputs.notches); return { performed: true }; } }) },
    adapter: baseAdapter()
  });
  const result = await toolset.execute("scroll", args);
  return { wheel: sent[sent.length - 1], text: result.text };
}

test("asking to scroll down 6 scrolls down, which the sign convention got backwards", async () => {
  // Live: the agent wanted the bottom of a flight list, sent 6, then 12, then
  // 20 — and was returned to the TOP each time, because positive meant up.
  const down = await scrollWith({ notches: 6 });
  assert.equal(down.wheel, -6, "a plain number must mean the direction a person means: down");
  assert.match(down.text, /Scrolled down 6 notches/);
});

test("direction can be said outright, and the reply says which way it went", async () => {
  const up = await scrollWith({ direction: "up", notches: 3 });
  assert.equal(up.wheel, 3);
  assert.match(up.text, /Scrolled up 3 notches/,
    "'Scrolled.' gave no clue it had been going the wrong way for four steps");

  const down = await scrollWith({ direction: "down", notches: 4 });
  assert.equal(down.wheel, -4);
  assert.match(down.text, /Scrolled down 4 notches/);
});

test("a negative notch count still means down, so older callers are unaffected", async () => {
  const legacy = await scrollWith({ notches: -6 });
  assert.equal(legacy.wheel, -6);
  assert.match(legacy.text, /down 6/);
});

test("scrolling with nothing said at all goes down a sensible distance", async () => {
  const bare = await scrollWith({});
  assert.equal(bare.wheel, -5);
  assert.match(bare.text, /down 5/);
});

// ---- A window's TITLE is its content, not its identity ---------------------
//
// The user keeps a Notepad document of prompts. Its first line begins "send
// message to amma on whatsapp sa…", so Windows titles the window
// "*send message to amma on whatsapp sa - Notepad" — and every title-substring
// test in this codebase concluded that window was WhatsApp.
//
// `launch WhatsApp` returned it: the user's own 203,436-character file. The next
// `type` would have written into it. This is the same defect that put a Chrome
// tab named "Spotify - Web Player" forward as the Spotify desktop client, in a
// fourth and fifth place, which is why the rule now lives in ONE function.

test("a document named after the task is not the application it mentions", () => {
  const notepad = {
    ProcessName: "Notepad",
    MainWindowTitle: "*send message to amma on whatsapp sa - Notepad"
  };
  assert.equal(applicationWindowScore(notepad, "WhatsApp"), 0,
    "this window is the user's prompt file; returning it as WhatsApp risks typing into their document");
});

test("a browser tab named after an app is not that app", () => {
  assert.equal(
    applicationWindowScore({ ProcessName: "chrome", MainWindowTitle: "Spotify - Web Player: Music for everyone" }, "spotify"),
    0
  );
});

test("the real applications still resolve, and exact process names rank highest", () => {
  assert.equal(applicationWindowScore({ ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp" }, "WhatsApp"), 2);
  assert.equal(applicationWindowScore({ ProcessName: "Spotify", MainWindowTitle: "Spotify Free" }, "spotify"), 3);
  assert.equal(applicationWindowScore({ ProcessName: "mspaint", MainWindowTitle: "Untitled - Paint" }, "mspaint"), 3);
});

test("a packaged app is still found by title, because its host has no identity", () => {
  // Settings, Calculator and Realtek run inside ApplicationFrameHost. For those
  // the title is the ONLY identity there is, so it is trusted — and only there.
  assert.equal(
    applicationWindowScore({ ProcessName: "ApplicationFrameHost", MainWindowTitle: "Realtek Audio Console" }, "Realtek"),
    1
  );
  assert.equal(
    applicationWindowScore({ ProcessName: "ApplicationFrameHost", MainWindowTitle: "Settings" }, "Settings"),
    1
  );
  assert.equal(
    applicationWindowScore({ ProcessName: "ApplicationFrameHost", MainWindowTitle: "Realtek Audio Console" }, "WhatsApp"),
    0,
    "a generic host still has to match the name asked for"
  );
});

test("launching WhatsApp does not hand back a Notepad document", async () => {
  const toolset = launchToolset([
    {
      WindowHandle: 8195020,
      ProcessName: "Notepad",
      MainWindowTitle: "*send message to amma on whatsapp sa - Notepad",
      Foreground: true,
      Bounds: { width: 2160, height: 1242 }
    }
  ]);
  const result = await toolset.execute("launch", { application: "WhatsApp" });
  assert.ok(!/Notepad/i.test(result.text), "this is the failure the user hit: their prompt file returned as WhatsApp");
  assert.ok(!/8195020/.test(result.text));
});

// ---- The second live session ------------------------------------------------
//
// A train, a spider, a song and a file that was said not to exist. Same shape as
// everything above: each read as the model being poor at the task, and each was
// the code telling it something untrue about the machine it was standing on.

// ---- "Documents" was not where the code said it was -------------------------

test("a machine whose Documents lives in OneDrive says so before anything is searched", () => {
  // Asked to open a file in Documents, the agent searched
  // `$env:USERPROFILE\Documents` — a directory that exists, and that on this
  // machine is not the user's Documents. The search SUCCEEDED and found
  // nothing, so the file was reported as not existing while it sat in
  // OneDrive\Documents. It then recursed the entire user profile looking for it
  // and timed out after ninety seconds.
  const facts = describeMachine({
    read: true,
    user: "hithe",
    home: "C:\\Users\\hithe",
    folders: {
      Documents: "C:\\Users\\hithe\\OneDrive\\Documents",
      Desktop: "C:\\Users\\hithe\\OneDrive\\Desktop",
      Downloads: "C:\\Users\\hithe\\Downloads"
    },
    oneDrive: "C:\\Users\\hithe\\OneDrive",
    redirected: true,
    apps: [],
    browser: null
  });
  assert.match(facts, /C:\\Users\\hithe\\OneDrive\\Documents/,
    "the real path has to be in front of the model before it writes its first command");
  assert.match(facts, /USERPROFILE\\Documents/,
    "and the trap has to be named, because that is the path it reaches for");
  assert.match(facts, /DIFFERENT/,
    "an empty result from the wrong folder looks exactly like a thorough search that found nothing");
});

test("a machine with no redirection is not told a story about one", () => {
  // Not every machine has OneDrive, and telling one that does not that its
  // files are somewhere else would be the same defect pointing the other way.
  const facts = describeMachine({
    read: true,
    user: "sam",
    home: "C:\\Users\\sam",
    folders: { Documents: "C:\\Users\\sam\\Documents" },
    redirected: false,
    apps: [],
    browser: null
  });
  assert.ok(!/ONEDRIVE HOLDS/.test(facts));
  assert.match(facts, /C:\\Users\\sam\\Documents/, "it still says where Documents is");
});

test("a machine that could not be read adds nothing to the prompt", () => {
  assert.equal(describeMachine({ read: false }), "");
  assert.equal(describeMachine(null), "");
});

test("a profile-relative Documents path resolves to wherever Windows says Documents is", async (t) => {
  // The other half of the same defect. The staged pipeline writes
  // `%USERPROFILE%\Documents` for "what's in my documents", and that expands to
  // a directory which exists, lists cleanly, and is not the user's Documents.
  if (process.platform !== "win32") return t.skip("known folders are a Windows concept");
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: { close() {} } });
  const documents = adapter.getDocumentsPath();
  const listed = await adapter.listDirectory("%USERPROFILE%\\Documents", { depth: 1, maxEntries: 1 });
  assert.equal(listed.root, documents, "both routes have to reach the same folder Explorer shows");
  const nested = await adapter.listDirectory("%USERPROFILE%\\Documents\\check", { depth: 1, maxEntries: 1 });
  assert.equal(nested.root, `${documents}\\check`, "the rest of the path has to survive the redirect");
  // Downloads is not a folder Windows redirects, and must not be moved.
  const downloads = await adapter.listDirectory("%USERPROFILE%\\Downloads", { depth: 1, maxEntries: 1 });
  assert.equal(downloads.root, adapter.getDownloadsPath());
});

test("an installed desktop app is named as the route, because its website is a login screen", () => {
  // "send keerti a message on whatsapp" opened web.whatsapp.com, which showed a
  // QR code and asked for the user's phone — while the signed-in WhatsApp
  // desktop app was installed. The user had to type "app" to redirect it.
  const facts = describeMachine({
    read: true, user: "hithe", home: "C:\\Users\\hithe", folders: {},
    redirected: false, apps: ["WhatsApp", "Spotify"], browser: null
  });
  assert.match(facts, /WhatsApp/);
  assert.match(facts, /ALREADY SIGNED IN/i);
});

// ---- Paint drew nothing, and the message sent it to the wrong menu ----------

test("the active drawing tool is read out of the window, because it decides what a stroke must be", () => {
  assert.deepEqual(findActiveTool([{ text: "Using Oval tool on Canvas" }]), { name: "Oval", kind: "box" });
  assert.deepEqual(findActiveTool([{ text: "Using Pencil tool on Canvas" }]), { name: "Pencil", kind: "trace" });
  assert.deepEqual(findActiveTool([{ text: "Using Line tool on Canvas" }]), { name: "Line", kind: "line" });
  assert.deepEqual(findActiveTool([{ text: "Using Rectangle tool on Canvas" }]), { name: "Rectangle", kind: "box" });
  assert.equal(findActiveTool([{ text: "Colours" }, { text: "Shapes" }]), null);
});

test("with a shape tool active, a circle is one press-and-release rather than a traced loop", async () => {
  // THE DEFECT, EXACTLY. Paint's Oval tool ignores the path and draws its own
  // ellipse in the box between where the button went down and where it came up.
  // A traced circle ends where it began, so it asked for a zero-size oval and
  // got one — three times, reported as "NOTHING TO UNDO", with the Oval tool
  // confirmed active on screen. The message blamed tool selection, so the agent
  // went through the Shapes group and the Shape fill menu looking for a fault
  // that was not there, and only got a shape onto the canvas when it abandoned
  // `draw` for `drag`. Every shape in that train was then drawn one drag at a
  // time with a screen read between them.
  const { toolset, strokes, drags } = paintToolset("Oval");
  await toolset.execute("screen", { application: "mspaint" });
  await toolset.execute("draw", { shape: "circle", cx: 750, cy: 550, radius: 150 });
  assert.equal(strokes(), 0, "tracing the outline is the thing that drew nothing");
  assert.equal(drags().length, 1, "a shape tool takes exactly one press-move-release");
  const [drag] = drags();
  assert.equal(Math.round(drag.fromX), 600, "the drag is the shape's bounding box");
  assert.equal(Math.round(drag.toX), 900);
  assert.equal(Math.round(drag.fromY), 400);
  assert.equal(Math.round(drag.toY), 700);
});

test("a figure of several shapes is still one call, one drag per shape", async () => {
  // The train was drawn one `drag` at a time with a screen read between them —
  // twenty round trips for a picture. `strokes` was always meant to draw a whole
  // figure in one call, and now it does that for shape tools too.
  const { toolset, drags } = paintToolset("Rectangle");
  await toolset.execute("screen", { application: "mspaint" });
  await toolset.execute("draw", {
    strokes: [
      { shape: "rect", x: 400, y: 400, width: 200, height: 120 },
      { shape: "rect", x: 700, y: 400, width: 200, height: 120 }
    ]
  });
  assert.equal(drags().length, 2);
  assert.equal(Math.round(drags()[1].fromX), 700);
});

test("a shape tool is not assumed — an unrecognised status line still traces", async () => {
  const { toolset, strokes, drags } = paintToolset("Magic Wand");
  await toolset.execute("screen", { application: "mspaint" });
  await toolset.execute("draw", { shape: "circle", cx: 750, cy: 550, radius: 100 });
  assert.equal(strokes(), 1, "an unknown tool must not change what draw has always done");
  assert.equal(drags().length, 0);
});

test("the screen reading says which tool has the mouse and what that means", async () => {
  const { toolset } = paintToolset("Oval");
  const reading = await toolset.execute("screen", { application: "mspaint" });
  assert.match(reading.text, /Active tool: Oval/);
  assert.match(reading.text, /SHAPE tool/,
    "the fact was already in the reading as one group among a hundred, and was never read as operative");
});

// ---- Spotify would not press the one result Spotify itself had picked -------

test("the play control is found whatever kind of element Chromium calls it", async () => {
  // Spotify's search rows come back as DataItems, not Buttons, and the big
  // top-result card exposes its play control as a bare DataItem named "Play".
  // Restricted to ControlType.Button, the UIA walk found nothing and returned
  // matching-track-not-found — so "Dildara" never started, the previous song
  // kept playing, and the honest report of THAT ("still playing Stand By Me")
  // read as a matching failure. The model then re-typed the query by hand, read
  // the screen, and clicked the very control this had skipped, which is how we
  // know it was there and pressable the whole time.
  let script = "";
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: { close() {} } });
  adapter.runPowerShell = async (text) => {
    script = text;
    return { stdout: JSON.stringify({ found: false, invoked: false, reason: "matching-track-not-found" }), stderr: "", exitCode: 0 };
  };
  await adapter._invokeSpotifyPlayButton("Dildara", 800, 4242);
  assert.match(script, /ControlType\]::DataItem/,
    "the top-result card's Play is a DataItem — this is the control a person clicks");
  assert.match(script, /OrCondition/,
    "control type was never the right filter; the name and the Invoke pattern are");
  assert.match(script, /ControlType\]::Button/, "buttons still match, for the apps that use them");
});

// ---- A 404 was reported as a page that might be blocking us -----------------

// ---- A click by index landed on Redo and said only "Clicked at 927,277" -----

test("a click says what it hit, so a stale index is visible the moment it is used", async () => {
  // Indices renumber on every look. `click {element: 6}` meant Rectangle in the
  // reading taken with Paint's shape palette open; by the time it ran the
  // palette had closed and index 6 was Redo. It clicked Redo, reported a bare
  // coordinate, and the model went on believing the Rectangle tool was selected
  // — then drew nothing, twice, before working out what had happened.
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => (name === "pointer.clickAt"
          ? { performed: true, x: inputs.x, y: inputs.y }
          : {
              read: true, windowId: "9", application: "mspaint", title: "Untitled - Paint", visibleText: "",
              elements: ["File", "Edit", "View", "Save", "Share", "Undo", "Redo"].map((label, index) => ({
                role: "button", text: label, clickable: true,
                bounds: { x: 300 + index * 90, y: 260, width: 60, height: 30 }
              }))
            })
      })
    },
    adapter: baseAdapter(),
    readSignature: async () => null
  });
  const reading = await toolset.execute("screen", { application: "mspaint" });
  assert.match(reading.text, /6\| button "Redo"/, "the fixture has to reproduce the index that went wrong");
  const byIndex = await toolset.execute("click", { element: 6 });
  assert.match(byIndex.text, /Clicked "Redo"/, "the label is what makes the mistake noticeable");
  assert.match(byIndex.text, /element 6/);
  assert.match(byIndex.text, /read the screen and click by label/);

  const byLabel = await toolset.execute("click", { text: "Undo" });
  assert.match(byLabel.text, /Clicked "Undo" at/);
  assert.ok(!/read the screen and click by label/.test(byLabel.text),
    "clicking by label is the right thing to do and must not be nagged about");
});

test("a 404 is reported as a wrong URL rather than a page worth re-reading", () => {
  const notice = wrongUrlNotice("404 Not Found", "https://www.youtube.com/@ashishchanchlani/videos");
  assert.match(notice, /DOES NOT EXIST/);
  assert.match(notice, /search for the thing by name/,
    "it re-read the same wrong URL, then opened it in the user's browser, and got the same 404 there");
  assert.equal(wrongUrlNotice("ashish chanchlani vines - YouTube", "https://youtube.com"), null);
});

// ---- winget ran for forty seconds behind a spinner --------------------------

test("winget's progress is measured from the download, because winget hides its bar when piped", async () => {
  // winget only draws its progress bar when its output is a console. Through a
  // pipe the whole 180 MB download is one line — "Downloading <url>" — and then
  // forty seconds of nothing. So the URL gives the total and the file winget is
  // writing gives the bytes; both are measurements, neither is an estimate.
  const events = [];
  const sizes = new Map();
  const watcher = createWingetWatcher({
    onProgress: (progress) => events.push(progress),
    intervalMs: 5,
    readDirectory: async () => new Map(sizes),
    measure: async () => 180 * 1024 * 1024
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  await settle();
  watcher.note("Downloading https://desktop-release.canva.com/Canva%20Setup.exe\r\n");
  sizes.set("C:\\Temp\\WinGet\\Canva\\Canva.exe", 90 * 1024 * 1024);
  await settle();
  watcher.note("Starting package install...\r\n");
  watcher.stop();

  const measured = events.find((event) => event.percent === 50);
  assert.ok(measured, "half of 180 MB on disk is half the download");
  assert.match(measured.label, /90\.0 MB of 180\.0 MB/);
  assert.equal(events.at(-1).phase, "Installing");
  assert.equal(events.at(-1).percent, null,
    "the download's percentage must not carry into an install that has not started");
});

test("a leftover from an earlier download is not counted as this one's progress", async () => {
  const events = [];
  const sizes = new Map([["C:\\Temp\\WinGet\\Old\\previous.exe", 50 * 1024 * 1024]]);
  const watcher = createWingetWatcher({
    onProgress: (progress) => events.push(progress),
    intervalMs: 5,
    readDirectory: async () => new Map(sizes),
    measure: async () => 100 * 1024 * 1024
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  watcher.note("Downloading https://example.test/setup.exe\r\n");
  await new Promise((resolve) => setTimeout(resolve, 40));
  watcher.stop();
  assert.ok(!events.some((event) => event.percent > 0),
    "the WinGet temp directory is full of previous downloads; only growth is progress");
});

test("progress is only attached to the commands that report it", () => {
  assert.ok(isWingetInstall("winget install --id Canva.Canva"));
  assert.ok(isWingetInstall("winget upgrade --all"));
  assert.ok(!isWingetInstall("winget list --id Canva.Canva"));
  assert.ok(!isWingetInstall("winget uninstall --id Canva.Canva"));
  assert.ok(reportsProgress("pip install numpy"));
  assert.ok(!reportsProgress("Get-Process | Select-Object Name"));
});

// ---- A reading of WhatsApp that contained Visual Studio Code ----------------

// The cache request's TreeScope is how much to prefetch AROUND each element the
// search returns, not how much tree to search. Set to Descendants, a FindAll
// that finds 530 controls asks UIA to cache 530 subtrees, and on a WebView2
// frame the prefetch crosses the child-HWND boundary and UIA throws from inside
// FindAll. Measured 20 Aug 2026: 2299ms against 281ms for identical output on
// the content window, and 25.7 SECONDS returning nothing on the frame — which
// reached a live transcript as a reading headed "WhatsApp" full of other
// applications' menus.
//
// This FAILS if anyone puts Descendants or Subtree back into that assignment.
// It cannot check the timing — that is `node scripts/probe-screen-p50.mjs` —
// but the one line is what the timing depends on.
test("the UIA cache request prefetches one element, not every element's subtree", () => {
  const host = readFileSync(new URL("../../os-adapters/windows-host/restore-host.ps1", import.meta.url), "utf8");
  const start = host.indexOf("function New-UiCacheRequest");
  assert.ok(start >= 0, "New-UiCacheRequest is where every screen reading gets its properties");
  const body = host.slice(start, host.indexOf("\nfunction ", start + 1));
  const assignment = /\$cache\.TreeScope\s*=\s*(.+)/.exec(body)?.[1] ?? "";
  assert.ok(assignment, "the cache request must set a TreeScope rather than inherit one");
  assert.ok(
    !/Descendants|Subtree/.test(assignment),
    `the cache request must prefetch the element only; found: ${assignment.trim()}`
  );
  assert.match(assignment, /TreeScope\]::Element/);
});

// ---- A third of every look at the screen was one PowerShell idiom ------------

// `Get-Process -Id` reads like a lookup and is an enumeration: it walks every
// process on the machine and then filters. Get-WindowList called it once per
// window, so describing 28 windows meant 28 full process enumerations, and that
// single line was 96% of the call. Measured 22 Aug 2026 by
// `scripts/probe-window-list-cost.ps1`, 28 visible windows:
//
//   Get-Process -Id, once per window   290.9ms      one Get-Process   12.4ms
//
// It mattered far past `window.enumerate`, because Resolve-Window calls
// Get-WindowList and every host request that names a window calls
// Resolve-Window — so the N+1 was paid again inside every inspect, click, type
// and focus. End to end (`scripts/probe-perception-breakdown.mjs`):
// listWindows 405ms -> 30ms, and the p50 of one `screen` call 1,418ms -> 442ms.
//
// This FAILS if the per-window call comes back. It cannot check the timing —
// that is the probe — but the shape is what the timing depends on.
test("the window list looks processes up once, not once per window", () => {
  const host = readFileSync(new URL("../../os-adapters/windows-host/restore-host.ps1", import.meta.url), "utf8");
  const start = host.indexOf("function Get-WindowList");
  assert.ok(start >= 0, "Get-WindowList is what every window-naming host request resolves through");
  const body = host.slice(start, host.indexOf("\nfunction ", start + 1));
  // Comments are stripped first: the body carries a comment explaining what the
  // removed call used to do, and a test that reads its own explanation as a
  // violation would fail forever for the wrong reason.
  const code = body.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.ok(
    !/Get-Process\s+-Id/.test(code),
    "Get-WindowList must not call Get-Process -Id — that is one full process enumeration per window"
  );
  assert.match(code, /Get-Process\b/, "it still needs process names, from one enumeration into a lookup");
});
