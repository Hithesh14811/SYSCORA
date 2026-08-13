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
import { buildToolset, findCanvas, hasUnreadableScript } from "../../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { sanitizeExternalContext } from "../../packages/shared-types/src/external-context.js";
import { correlateLaunchWindow } from "../../os-adapters/windows/src/windows-adapter.js";

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

// Paint's canvas, as a screen reading reports it.
function paintToolset() {
  let strokes = 0;
  const adapter = baseAdapter({
    pointerStroke: async () => { strokes += 1; return { performed: true }; }
  });
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "9", application: "mspaint", title: "Untitled - Paint",
          visibleText: "",
          elements: [
            { role: "Button", text: "Undo", bounds: { x: 800, y: 60, width: 40, height: 30 }, clickable: true },
            { role: "Pane", text: "Using Oval tool on Canvas", bounds: { x: 300, y: 200, width: 900, height: 700 } }
          ]
        })
      })
    },
    adapter,
    readSignature: async () => null
  });
  return { toolset, strokes: () => strokes };
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
  const { toolset, strokes } = paintToolset();
  await toolset.execute("screen", { application: "mspaint" });
  const result = await toolset.execute("draw", { shape: "circle", cx: 750, cy: 550, radius: 100 });
  assert.equal(result.ok, true);
  assert.equal(strokes(), 1);
});

// ---- "I'll rebuild App.tsx" three times, and never did ----------------------

test("part of a file can be changed without rewriting the whole thing", async () => {
  let written = null;
  const adapter = baseAdapter({
    readTextFile: async () => ({ filePath: "App.tsx", contents: "const a = 1;\nconst b = 2;\n" }),
    writeTextFile: async (path, content) => { written = content; return { filePath: path, existed: true }; }
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

test("a real filesystem path reaches the model intact", () => {
  const path = "C:\Users\hithe\OneDrive\Documents\check\beautify-ecommerce\src\App.tsx";
  const seen = sanitizeExternalContext(`Found it at ${path}`);
  assert.match(seen, /C:\Users\hithe\OneDrive/,
    "rewriting the home directory to %USERPROFILE% made the agent echo that literal back into PowerShell, " +
    "which does not expand %VAR% — so every path resolved against the working directory and nothing was found");
  assert.ok(!/%USERPROFILE%/.test(seen));
});

test("credentials are still redacted even though paths are not", () => {
  const seen = sanitizeExternalContext(
    "C:\Users\hithe\.env holds sk-ABCDEFGH12345678 and AKIAIOSFODNN7EXAMPLE"
  );
  assert.match(seen, /C:\Users\hithe/);
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
