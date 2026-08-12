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
    pointerStroke: { performed: true, strokes: 1, points: 4, durationMs: 12, injectedEvents: 4, requestedEvents: 4 },
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
    pointerStroke: record("pointerStroke"),
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
  // The recording adapter answers every read with a body, so this path counts as
  // an existing file: say what is meant by that, then check the wiring.
  const result = await toolset.execute("write_file", {
    path: "C:\\x.txt", contents: "written body", existing: "replace"
  });
  assert.equal(result.ok, true);
  const call = adapter.calls.find((entry) => entry.name === "writeTextFile");
  assert.equal(call.args[1], "written body", "the file must be written with the contents, not empty");
  assert.match(result.text, /Wrote C:\\x\.txt/);
});

// "Wrote notes.txt (replacing what was there)" is an obituary: it is printed
// after the only copy has gone, and the model had no idea a file was there.
test("writing over a file that already has something in it stops and says so first", async () => {
  const written = [];
  const files = new Map([["c:\\notes.txt", "the shopping list\nmilk\neggs"]]);
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          const target = String(inputs.filePath).toLowerCase();
          if (name === "filesystem.read") {
            if (!files.has(target)) throw new Error("ENOENT");
            return { filePath: inputs.filePath, contents: files.get(target) };
          }
          written.push(inputs);
          const existed = files.has(target);
          files.set(target, inputs.content);
          return { filePath: inputs.filePath, existed };
        }
      })
    },
    adapter: {}
  });

  const refused = await toolset.execute("write_file", { path: "C:\\notes.txt", contents: "a poem" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /already exists/);
  assert.match(refused.text, /the shopping list/);
  assert.equal(written.length, 0, "not one byte of the file may be touched");

  // Appending keeps what was there.
  const appended = await toolset.execute("write_file", { path: "C:\\notes.txt", contents: "a poem", existing: "append" });
  assert.equal(appended.ok, true);
  assert.match(appended.text, /keeping what was already in it/);
  assert.match(written.at(-1).content, /^the shopping list\nmilk\neggs\na poem$/);

  // A path with nothing at it is written without ceremony.
  const fresh = await toolset.execute("write_file", { path: "C:\\new.txt", contents: "hello" });
  assert.equal(fresh.ok, true);
  assert.equal(written.at(-1).content, "hello");
  // And a file this run wrote is ours to rewrite, with no second question.
  const again = await toolset.execute("write_file", { path: "C:\\new.txt", contents: "hello again" });
  assert.equal(again.ok, true);
  assert.equal(written.at(-1).content, "hello again");
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

  const screen = await toolset.execute("screen", { application: "the app under test" });
  for (const result of results) {
    assert.match(screen.text, new RegExp(result.text.replace(/[—]/g, "."), "i"),
      `"${result.text}" must survive the cut; window chrome must not crowd it out`);
  }
  // And the furniture is still reachable when it is genuinely what is wanted.
  assert.match(screen.text, /"Close"/);
});

// Live, asked to message Amma, the reading held "Amma" three times — the search
// box it had just been typed into, the results header, and the chat itself. All
// three scored the same, list order won, and the click landed on the SEARCH BOX.
// The message then went to whatever chat was already open, reported as sent to
// the user's mother.
test("a label matching several different things asks which one, instead of guessing", async () => {
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "9", application: "WhatsApp", title: "WhatsApp", visibleText: "",
          elements: [
            { role: "text", text: "Amma", bounds: { x: 280, y: 240, width: 60, height: 16 } },
            { role: "text", text: "Amma", bounds: { x: 1050, y: 130, width: 60, height: 16 } },
            { role: "text", text: "Amma", bounds: { x: 340, y: 520, width: 60, height: 16 } }
          ]
        })
      })
    },
    adapter: {}
  });

  await toolset.execute("screen", { application: "the app under test" });
  const click = await toolset.execute("click", { text: "Amma" });

  assert.equal(click.ok, false, "a three-way tie must not resolve into a silent click");
  assert.match(click.text, /matches 3 things/);
  // The candidates are named with their indices so the next call can be exact.
  assert.match(click.text, /@310,248/);
  assert.match(click.text, /@370,528/);
  assert.match(click.text, /by its index/);
});

test("an unambiguous label still clicks without ceremony", async () => {
  const clicked = [];
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          if (name === "pointer.clickAt") { clicked.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; }
          return {
            read: true, windowId: "9", application: "notepad", title: "Notepad", visibleText: "",
            elements: [
              { role: "button", text: "Save", bounds: { x: 10, y: 20, width: 40, height: 10 }, clickable: true, windowId: "9" },
              { role: "button", text: "Cancel", bounds: { x: 80, y: 20, width: 40, height: 10 }, clickable: true, windowId: "9" }
            ]
          };
        }
      })
    },
    adapter: {}
  });

  await toolset.execute("screen", { application: "the app under test" });
  const click = await toolset.execute("click", { text: "Save" });
  assert.equal(click.ok, true);
  assert.equal(clicked[0].x, 30);
  // With an exact handle in hand, the vague application name is NOT also sent:
  // a general name competing with a specific one is how a click on the page got
  // validated against a dialog in the corner.
  assert.equal(clicked[0].windowId, "9");
  assert.equal(clicked[0].application, undefined);
});

// Live, this made a whole task impossible. Two Avast Secure Browser windows were
// open — a 720x372 "Restore pages?" dialog and the maximised Google Flights
// window. Window resolution matched windowId OR process name in one pass over
// the list, so the dialog matched first on its process name and every click on
// the flights page was validated against it and refused as "outside the window".
// The exact windowId naming the right window was in the same call.
test("an exact window handle wins over a process name shared by other windows", async () => {
  const windows = [
    { WindowHandle: 132780, ProcessName: "AvastBrowser", MainWindowTitle: "Restore pages?", Bounds: { x: 2200, y: 140, width: 720, height: 372 } },
    { WindowHandle: 132888, ProcessName: "AvastBrowser", MainWindowTitle: "Google Flights", Bounds: { x: 0, y: 0, width: 2906, height: 1730 } }
  ];
  const clicked = [];
  const adapter = {
    listWindows: async () => windows,
    pointerAction: async (operation, params) => { clicked.push(params); return { performed: true }; }
  };
  const registry = createDefaultCapabilityRegistry(adapter);

  // The handle names the flights window; the point is inside it and outside the
  // dialog. This must land.
  const inFlights = await registry.get("pointer.clickAt").execute({ x: 699, y: 1186, windowId: "132888" });
  assert.equal(inFlights.performed, true);
  assert.equal(clicked[0].windowId, "132888");

  // With only the shared process name to go on, the window actually containing
  // the point is the one meant — not whichever shares the name first.
  const byName = await registry.get("pointer.clickAt").execute({ x: 699, y: 1186, application: "AvastBrowser" });
  assert.equal(byName.performed, true);
  assert.equal(clicked[1].windowId, "132888");

  // A point genuinely outside every candidate is still refused.
  await assert.rejects(
    registry.get("pointer.clickAt").execute({ x: 5000, y: 5000, windowId: "132888" }),
    /is outside/
  );
});

// Live, mid-way through drawing in Paint, the agent clicked a toolbar, called
// `screen` with no arguments, and got back a reading of the CLAUDE window — the
// user was watching, so their chat was the OS foreground window. Every
// conclusion after that was drawn from the wrong application.
test("reading the screen re-reads the window being worked in, not whatever is in front", async () => {
  const asked = [];
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          if (name === "application.launch") {
            return { application: "mspaint", windowIdentity: { windowId: "7408238" } };
          }
          asked.push(inputs);
          return { read: true, windowId: inputs.windowId ?? "0", application: "mspaint", title: "Paint", visibleText: "", elements: [] };
        }
      })
    },
    adapter: {}
  });

  await toolset.execute("launch", { application: "mspaint" });
  await toolset.execute("screen", {});
  assert.equal(asked[0].windowId, "7408238", "it must re-read the window it is working in");

  // And it can still deliberately look at whatever is in front when it says so.
  await toolset.execute("screen", { desktop: true });
  assert.equal(asked[1].windowId, undefined);
});

// Live, Paint exposes well over sixty elements, so "Shapes" and "Brushes" fell
// outside the cut — and because targets were built from the survivors, they were
// unreachable as well as unlisted. Spotify's "Dismiss" banner button went the
// same way, which is why the banner sat there for the whole session.
test("an element below the listing cut is still clickable by its label", async () => {
  const clicked = [];
  const many = Array.from({ length: 200 }, (_, index) => ({
    role: "listitem", text: `Colour ${index}`, clickable: true, windowId: "7",
    bounds: { x: index * 4, y: 300, width: 20, height: 20 }
  }));
  // The one that matters is buried far past any sane listing cut.
  many.splice(150, 0, {
    role: "button", text: "Dismiss", clickable: true, windowId: "7",
    bounds: { x: 900, y: 800, width: 80, height: 30 }
  });

  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          if (name === "pointer.clickAt") { clicked.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; }
          return { read: true, windowId: "7", application: "spotify", title: "Spotify", visibleText: "", elements: many };
        }
      })
    },
    adapter: {}
  });

  const screen = await toolset.execute("screen", { application: "the app under test" });
  const listed = screen.text.split("\n").filter((line) => /^\d+\| /.test(line));
  assert.ok(listed.length < many.length, "the listing must still be bounded");

  const click = await toolset.execute("click", { text: "Dismiss" });
  assert.equal(click.ok, true, "a label that was observed must remain clickable even if it was not listed");
  assert.equal(clicked[0].x, 940);
});

test("a label that is genuinely absent suggests the closest ones actually present", async () => {
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "7", application: "mspaint", title: "Paint", visibleText: "",
          elements: [
            { role: "button", text: "Pencil", clickable: true, bounds: { x: 10, y: 10, width: 20, height: 20 } },
            { role: "button", text: "Shapes and lines", clickable: true, bounds: { x: 40, y: 10, width: 20, height: 20 } }
          ]
        })
      })
    },
    adapter: {}
  });

  await toolset.execute("screen", { application: "the app under test" });
  const click = await toolset.execute("click", { text: "Rectangle tool" });
  assert.equal(click.ok, false);
  assert.match(click.text, /closest labels actually present/);
  assert.match(click.text, /Do not click a coordinate you have not read/);
});

// Asked to draw a circle, the agent selected the ellipse tool correctly and then
// had no verb for the one motion the task consists of. There was no drag tool at
// all, so everything drawn rather than clicked was unreachable.
test("dragging is available, and reaches the pointer as one press-move-release", async () => {
  const actions = [];
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "7", application: "mspaint", title: "Paint", visibleText: "",
          elements: [{ role: "text", text: "Canvas", bounds: { x: 400, y: 400, width: 800, height: 600 }, windowId: "7" }]
        })
      })
    },
    adapter: {
      pointerAction: async (operation, params) => {
        actions.push({ operation, params });
        return { performed: true, from: { x: params.fromX, y: params.fromY }, to: { x: params.toX, y: params.toY } };
      }
    }
  });

  await toolset.execute("screen", { application: "the app under test" });
  const drag = await toolset.execute("drag", { fromX: 500, fromY: 500, toX: 900, toY: 900 });

  assert.equal(drag.ok, true);
  assert.equal(actions[0].operation, "drag");
  assert.deepEqual(
    [actions[0].params.fromX, actions[0].params.fromY, actions[0].params.toX, actions[0].params.toY],
    [500, 500, 900, 900]
  );
  assert.equal(actions[0].params.windowId, "7", "the drag must be pinned to the window being worked in");
  assert.match(drag.text, /Dragged from 500,500 to 900,900/);
});

// Live, the agent selected a tool that was not actually selected, dragged across
// the canvas, read the screen, and reported "the shape is now visible". The
// canvas was blank. OCR of a blank canvas and OCR of a drawing say the same
// nothing, so reading the screen could never have caught it.
test("a drag that changed nothing visible is reported as having drawn nothing", async () => {
  // A 64x64 signature grid. `moved` cells differ by more than the per-cell
  // threshold; the rest are identical.
  const grid = (moved) => Array.from({ length: 4096 }, (_, index) => (index < moved ? 200 : 100));
  const makeToolset = (signatures) => {
    let call = 0;
    return buildToolset({
      registry: {
        get: () => ({
          execute: async () => ({
            read: true, windowId: "7", application: "mspaint", title: "Paint", visibleText: "", elements: []
          })
        })
      },
      adapter: {
        pointerAction: async () => ({ performed: true, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }),
        captureScreen: async () => ({ captured: true, path: "capture.png", bounds: { x: 0, y: 0, width: 640, height: 640 } })
      },
      readSignature: async () => signatures[Math.min(call++, signatures.length - 1)]
    });
  };
  // The drag below runs from (10,10) to (30,30) in a 640x640 window, so on a
  // 64-cell grid it covers cells 1..3, and the two-cell pad widens that to 0..5.
  const inDragRegion = (index) => {
    const x = index % 64;
    const y = Math.floor(index / 64);
    return x <= 5 && y <= 5;
  };
  const gridIn = (moved) => {
    let placed = 0;
    return Array.from({ length: 4096 }, (_, index) => {
      if (inDragRegion(index) && placed < moved) { placed += 1; return 200; }
      return 100;
    });
  };
  // Change everywhere EXCEPT where the drag happened: a menu closing elsewhere.
  const gridOutside = () => Array.from({ length: 4096 }, (_, index) => (inDragRegion(index) ? 100 : 200));

  const drag = { fromX: 10, fromY: 10, toX: 30, toY: 30, application: "mspaint" };

  // THE APPLICATION'S OWN ANSWER, which beats every pixel measure: Undo is
  // disabled when there is nothing to undo and becomes enabled the moment the
  // document is modified. Verified against a live Paint window — false before
  // any drawing, true after one pencil stroke.
  const withUndo = (states) => {
    let call = 0;
    return buildToolset({
      registry: { get: () => ({ execute: async () => ({ read: true, windowId: "7", elements: [] }) }) },
      adapter: {
        pointerAction: async () => ({ performed: true, from: { x: 10, y: 10 }, to: { x: 30, y: 30 } }),
        inspectUi: async () => ({
          elements: [{ name: "Undo", enabled: states[Math.min(call++, states.length - 1)] }]
        }),
        captureScreen: async () => { throw new Error("must not capture when undo settles it"); }
      }
    });
  };

  const drewNothing = await withUndo([false, false]).execute("drag", drag);
  assert.match(drewNothing.text, /NOTHING TO UNDO/);
  assert.match(drewNothing.text, /nothing was drawn/);

  const drewSomething = await withUndo([false, true]).execute("drag", drag);
  assert.match(drewSomething.text, /something to undo — the document changed/);

  // Nothing moved at all.
  const identical = await makeToolset([grid(0), grid(0)]).execute("drag", drag);
  assert.equal(identical.ok, true, "the drag itself did happen");
  assert.match(identical.text, /NOTHING WAS DRAWN/);

  // The whole rest of the window changed, but not where the drag happened —
  // a menu closing between the two captures. Live, a whole-window comparison
  // called exactly this "it drew something" on a canvas that stayed blank.
  const elsewhere = await makeToolset([gridIn(0), gridOutside()]).execute("drag", drag);
  assert.match(elsewhere.text, /NOTHING WAS DRAWN/,
    "a change somewhere else in the window is not evidence the drag drew anything");

  // Marks in the dragged area itself. Reported as WEAK evidence, deliberately:
  // ground truth on a live Paint window showed this measure firing on a blank
  // canvas, so it must not be stated as proof.
  const drawn = await makeToolset([gridIn(0), gridIn(6)]).execute("drag", drag);
  assert.match(drawn.text, /that area of the window changed/);
  assert.match(drawn.text, /weak evidence/);

  // No signature and no comparison: say so rather than claiming either way.
  const blind = buildToolset({
    registry: { get: () => ({ execute: async () => ({ read: false }) }) },
    adapter: { pointerAction: async () => ({ performed: true, from: {}, to: {} }) }
  });
  const unknown = await blind.execute("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2, application: "mspaint" });
  assert.match(unknown.text, /UNCONFIRMED/);
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

// A DRAG CAN ONLY EVER BE A STRAIGHT LINE.
//
// Everything with a shape to it — a circle, an arc, a signature — had to be
// spelled as a series of drags, and the button comes up between drags. What
// arrived was disconnected chords, one model round trip and one undo entry
// each. `draw` is the verb for the motion the request actually names.
test("drawing a circle is one continuous stroke, not a ring of separate drags", async () => {
  const strokes = [];
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async () => ({
          read: true, windowId: "7", application: "mspaint", title: "Paint", visibleText: "", elements: []
        })
      })
    },
    adapter: {
      pointerStroke: async (params) => {
        strokes.push(params);
        return { performed: true, strokes: params.paths.length, points: params.paths[0].length / 2, durationMs: 400 };
      },
      inspectUi: async () => ({ elements: [{ name: "Undo", enabled: false }] })
    }
  });

  await toolset.execute("screen", { application: "the app under test" });
  const drawn = await toolset.execute("draw", { shape: "circle", cx: 900, cy: 600, radius: 200 });

  assert.equal(strokes.length, 1, "the whole circle must travel in ONE call");
  assert.equal(strokes[0].paths.length, 1, "a circle is one stroke — the pen never lifts");
  assert.equal(strokes[0].windowId, "7", "the stroke must be pinned to the window being worked in");

  const flat = strokes[0].paths[0];
  assert.ok(flat.length >= 400, `a circle of radius 200 needs many points, got ${flat.length / 2}`);
  assert.ok(flat.every((value) => Number.isInteger(value)), "every coordinate must be a whole pixel");
  // Every point sits on the circle, and consecutive points are close enough that
  // the application cannot render the path as a polygon.
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const off = Math.abs(Math.hypot(flat[index] - 900, flat[index + 1] - 600) - 200);
    assert.ok(off <= 1.5, `point ${flat[index]},${flat[index + 1]} is ${off.toFixed(2)}px off the circle`);
  }
  for (let index = 2; index + 1 < flat.length; index += 2) {
    const gap = Math.hypot(flat[index] - flat[index - 2], flat[index + 1] - flat[index - 1]);
    assert.ok(gap <= 3.5, `a ${gap.toFixed(2)}px gap would be drawn as a straight chord`);
  }
  assert.match(drawn.text, /Drew circle/);
});

test("a figure that lifts the pen is still a single call", async () => {
  const strokes = [];
  const toolset = buildToolset({
    registry: { get: () => ({ execute: async () => ({ read: true, windowId: "7", elements: [] }) }) },
    adapter: {
      pointerStroke: async (params) => {
        strokes.push(params);
        return { performed: true, strokes: params.paths.length, points: 100, durationMs: 300 };
      },
      inspectUi: async () => ({ elements: [{ name: "Undo", enabled: false }] })
    }
  });
  await toolset.execute("screen", { application: "the app under test" });
  await toolset.execute("draw", {
    strokes: [
      { shape: "line", fromX: 10, fromY: 10, toX: 100, toY: 10 },
      { shape: "line", fromX: 10, fromY: 40, toX: 100, toY: 40 }
    ]
  });
  assert.equal(strokes.length, 1, "two strokes must not cost two round trips");
  assert.equal(strokes[0].paths.length, 2);
});

// The same evidence rules a drag is held to. OCR cannot see a drawing, so the
// application's own undo state is what answers it.
test("a stroke the application did not record is reported as having drawn nothing", async () => {
  const withUndo = (states) => {
    let call = 0;
    return buildToolset({
      registry: { get: () => ({ execute: async () => ({ read: true, windowId: "7", elements: [] }) }) },
      adapter: {
        pointerStroke: async () => ({ performed: true, strokes: 1, points: 40, durationMs: 100 }),
        inspectUi: async () => ({ elements: [{ name: "Undo", enabled: states[Math.min(call++, states.length - 1)] }] }),
        captureScreen: async () => { throw new Error("must not capture when undo settles it"); }
      }
    });
  };
  const spec = { shape: "circle", cx: 100, cy: 100, radius: 30 };

  const nothing = await withUndo([false, false]).execute("draw", spec);
  assert.match(nothing.text, /NOTHING TO UNDO/);
  assert.match(nothing.text, /nothing was drawn/);

  const something = await withUndo([false, true]).execute("draw", spec);
  assert.match(something.text, /the document changed, so it drew/);

  // Neither check available is "I cannot tell", which is not the same as "it
  // failed" and must never be reported as either success or failure.
  const blind = buildToolset({
    registry: { get: () => ({ execute: async () => ({ read: false }) }) },
    adapter: { pointerStroke: async () => ({ performed: true, strokes: 1, points: 40, durationMs: 100 }) }
  });
  const unknown = await blind.execute("draw", spec);
  assert.match(unknown.text, /UNCONFIRMED/);
});

// Windows accepts fewer events than it was offered when something blocks them —
// an elevated window in the foreground is the usual cause. Reporting that as a
// successful draw is the false success this codebase keeps having to undo.
test("input the system refused is reported as refused, not as drawn", async () => {
  const toolset = buildToolset({
    registry: { get: () => ({ execute: async () => ({ read: true, windowId: "7", elements: [] }) }) },
    adapter: {
      pointerStroke: async () => ({
        performed: false, reason: "input-blocked: Windows accepted 0 of 300 events.",
        strokes: 1, points: 150, injectedEvents: 0, requestedEvents: 300
      })
    }
  });
  const result = await toolset.execute("draw", { shape: "rect", x: 10, y: 10, width: 50, height: 50 });
  assert.match(result.text, /Nothing was drawn/);
  assert.match(result.text, /input-blocked/);
});

test("a shape the geometry cannot build fails as a result, not as an exception", async () => {
  const toolset = buildToolset({
    registry: { get: () => ({ execute: async () => ({ read: true, windowId: "7", elements: [] }) }) },
    adapter: { pointerStroke: async () => ({ performed: true }) }
  });
  const result = await toolset.execute("draw", { shape: "hexadecagram", cx: 1, cy: 1 });
  assert.equal(result.ok, false);
  assert.match(result.text, /Unknown shape/);
});

// THE WINDOW YOU WERE HANDED IS NOT THE WINDOW YOU OPENED.
//
// Asked to write something in Notepad, the agent launched Notepad, was given the
// window that was already open with the user's document in it, and typed into
// the middle of that document. Nothing in the loop reported anything false —
// Notepad was open, the window was grounded, the keystrokes landed. The loop had
// simply never been told which of the two things had happened.
//
// These check the observation, not a rule about Notepad: nothing below depends
// on the application's name, and the same signals decide it for any editor.
function editorToolset({
  windows = [],
  elements = [],
  launched = { WindowHandle: 42, title: "Untitled - Notepad" },
  keyboard = () => ({ performed: true }),
  pointer = () => ({ performed: true, x: 1, y: 1 })
} = {}) {
  const calls = [];
  const registry = {
    get: (name) => ({
      execute: async (inputs) => {
        calls.push({ name, inputs });
        if (name === "application.launch") {
          return {
            application: "notepad",
            windowIdentity: { windowId: String(launched.WindowHandle), title: launched.title },
            before: { windowIds: windows.map((window) => String(window.WindowHandle)) }
          };
        }
        if (name === "keyboard.press" || name === "keyboard.type") return keyboard(inputs);
        if (name === "pointer.clickAt") return pointer(inputs);
        return { performed: true };
      }
    })
  };
  const inspections = [];
  const adapter = {
    inspectUi: async () => {
      const next = elements[Math.min(inspections.length, elements.length - 1)] ?? [];
      inspections.push(next);
      return { windows: [{ MainWindowTitle: launched.title }], elements: next };
    },
    getForegroundWindow: async () => ({
      windowId: String(launched.WindowHandle), title: launched.title, processName: "notepad"
    })
  };
  return { toolset: buildToolset({ registry, adapter }), calls, inspections };
}

// A pane filling the window, so the Edit control below counts as the document
// rather than as an address bar.
const documentSurface = (chars, { undo = null } = {}) => [
  { name: "", controlType: "ControlType.Pane", boundingRect: { x: 0, y: 0, width: 1000, height: 800 } },
  {
    name: "Text editor", controlType: "ControlType.Edit", value: "x".repeat(chars),
    boundingRect: { x: 0, y: 100, width: 1000, height: 700 }
  },
  ...(undo === null ? [] : [{ name: "Undo", enabled: undo, boundingRect: { x: 10, y: 10, width: 20, height: 20 } }])
];

test("launching an application that was already running says so, instead of implying a fresh window", async () => {
  const already = editorToolset({ windows: [{ WindowHandle: 42 }] });
  const reused = await already.toolset.execute("launch", { application: "notepad" });
  assert.match(reused.text, /ALREADY RUNNING/);
  assert.match(reused.text, /not a new one/);

  const fresh = editorToolset({ windows: [{ WindowHandle: 9 }] });
  const opened = await fresh.toolset.execute("launch", { application: "notepad" });
  assert.match(opened.text, /open in a new window/);
  assert.doesNotMatch(opened.text, /ALREADY RUNNING/);
});

test("typing into a document that was already open refuses once and says what is in it", async () => {
  const { toolset, calls } = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [documentSurface(120, { undo: true })]
  });
  await toolset.execute("launch", { application: "notepad" });

  const refused = await toolset.execute("type", { text: "a poem" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /ALREADY OPEN/);
  assert.match(refused.text, /120 characters/);
  assert.match(refused.text, /unsaved edits/);
  assert.match(refused.text, /new_document/);
  assert.equal(calls.filter((call) => call.name === "keyboard.type").length, 0,
    "not one keystroke may reach the user's document");

  // Saying what it means gets through, and settles the question for that window
  // so the next line is not gated again.
  const appended = await toolset.execute("type", { text: "a poem", existing: "append" });
  assert.equal(appended.ok, true);
  const second = await toolset.execute("type", { text: "more" });
  assert.equal(second.ok, true);
  assert.equal(calls.filter((call) => call.name === "keyboard.type").length, 2);
});

test("an empty document, a window we opened ourselves, and a search box are never gated", async () => {
  const empty = editorToolset({ windows: [{ WindowHandle: 42 }], elements: [documentSurface(0, { undo: false })] });
  await empty.toolset.execute("launch", { application: "notepad" });
  assert.equal((await empty.toolset.execute("type", { text: "hello" })).ok, true,
    "an open but empty document is not somebody's work");

  // We opened this one, so whatever is in it is ours. No probe, no gate.
  const ours = editorToolset({ windows: [{ WindowHandle: 9 }], elements: [documentSurface(500, { undo: true })] });
  await ours.toolset.execute("launch", { application: "notepad" });
  assert.equal((await ours.toolset.execute("type", { text: "hello" })).ok, true);
  assert.equal(ours.inspections.length, 0, "a window we created needs no interrogation");

  // A browser: the address bar holds a URL, and it is a small control rather
  // than a document. Typing into a search box must never be gated.
  const browser = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [[
      { name: "", controlType: "ControlType.Pane", boundingRect: { x: 0, y: 0, width: 1000, height: 800 } },
      {
        name: "Address and search bar", controlType: "ControlType.Edit", value: "https://example.com",
        boundingRect: { x: 100, y: 40, width: 600, height: 30 }
      }
    ]]
  });
  await browser.toolset.execute("launch", { application: "chrome" });
  assert.equal((await browser.toolset.execute("type", { text: "cats" })).ok, true);
});

// A REAL EDITOR MAY NOT SAY WHAT IS IN IT.
//
// Reading a surface's contents needs UI Automation's ValuePattern, and Windows
// 11's Notepad hosts a rich edit control that answers with nothing. Reading that
// silence as "zero characters" would call the document empty in precisely the
// application this was reported against — so a saved file, open, with nothing to
// undo, would be typed into.
test("a document whose contents cannot be read is not assumed to be empty", async () => {
  const opaque = (title) => [
    { name: "", controlType: "ControlType.Pane", boundingRect: { x: 0, y: 0, width: 1000, height: 800 } },
    // No `value`, no ValuePattern: the control declines to say.
    {
      name: "Text editor", controlType: "ControlType.Document", supportedPatterns: ["InvokePatternIdentifiers.Pattern"],
      boundingRect: { x: 0, y: 100, width: 1000, height: 700 }
    },
    { name: "Undo", enabled: false, boundingRect: { x: 10, y: 10, width: 20, height: 20 } }
  ];

  // A saved file is open. Nothing to undo, nothing readable — the name is all
  // there is, and it is the name of somebody's document.
  const saved = editorToolset({
    windows: [{ WindowHandle: 42 }],
    launched: { WindowHandle: 42, title: "quarterly-report.txt - Notepad" },
    elements: [opaque()]
  });
  await saved.toolset.execute("launch", { application: "notepad" });
  const refused = await saved.toolset.execute("type", { text: "a poem" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /quarterly-report\.txt/);
  assert.match(refused.text, /cannot assume it is empty/);

  // An untitled one is a blank page, and typing into it needs no ceremony.
  const blank = editorToolset({
    windows: [{ WindowHandle: 42 }],
    launched: { WindowHandle: 42, title: "Untitled - Notepad" },
    elements: [opaque()]
  });
  await blank.toolset.execute("launch", { application: "notepad" });
  assert.equal((await blank.toolset.execute("type", { text: "a poem" })).ok, true);
});

test("new_document prefers the application's own New control over the Ctrl+N convention", async () => {
  // Before: a full document, with a "New tab" control published. After: empty.
  const tabbed = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [
      [
        ...documentSurface(300, { undo: true }),
        { name: "New tab", controlType: "ControlType.Button", boundingRect: { x: 200, y: 30, width: 20, height: 20 } }
      ],
      documentSurface(0, { undo: false })
    ]
  });
  const opened = await tabbed.toolset.execute("new_document", { windowId: "42" });
  assert.match(opened.text, /New tab/);
  assert.match(opened.text, /fresh document/);
  const click = tabbed.calls.find((call) => call.name === "pointer.clickAt");
  assert.deepEqual([click.inputs.x, click.inputs.y], [210, 40], "it must click the control it found");
  assert.equal(tabbed.calls.some((call) => call.name === "keyboard.press"), false,
    "Ctrl+N is the fallback, not the first move");

  // A fresh surface is ours, so typing into it is not gated.
  assert.equal((await tabbed.toolset.execute("type", { text: "a poem" })).ok, true);

  // No New control published: fall back to the convention.
  const plain = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [documentSurface(300, { undo: true }), documentSurface(0, { undo: false })]
  });
  await plain.toolset.execute("new_document", { windowId: "42" });
  const press = plain.calls.find((call) => call.name === "keyboard.press");
  assert.equal(press.inputs.keys, "ctrl+n");
});

// THE WINDOW IN FRONT IS THE USER'S, NOT THE AGENT'S.
//
// `screen` with nothing to go on read the OS foreground window — and the user is
// watching SYSCORA work, so the window in front is SYSCORA's own chat. On the
// first look of a task, that produced a reading of this conversation, which the
// model then reasoned about as though it were the application it had been asked
// to use.
test("looking at the screen before anything is open asks which window, instead of reading its own", async () => {
  const asked = [];
  const toolset = buildToolset({
    registry: {
      get: () => ({
        execute: async (inputs) => {
          asked.push(inputs);
          return { read: true, windowId: "7", application: "notepad", title: "x", visibleText: "", elements: [] };
        }
      })
    },
    adapter: {
      listWindows: async () => [
        { WindowHandle: 42, ProcessName: "notepad", MainWindowTitle: "notes.txt", Bounds: { width: 800, height: 600 } },
        { WindowHandle: 43, ProcessName: "chrome", MainWindowTitle: "YouTube", Bounds: { width: 1200, height: 900 } }
      ]
    }
  });

  const blind = await toolset.execute("screen", {});
  assert.equal(asked.length, 0, "it must not read a window it was never given");
  assert.match(blind.text, /have not opened or read any window/);
  assert.match(blind.text, /notepad — notes\.txt \(windowId 42\)/);
  assert.match(blind.text, /chrome — YouTube \(windowId 43\)/);

  // Named, it reads. And having read it, a bare `screen` re-reads that one.
  await toolset.execute("screen", { application: "notepad" });
  await toolset.execute("screen", {});
  assert.equal(asked.length, 2);
  assert.equal(asked[1].windowId, "7", "the working window is the one it re-reads");
});

// The toolset outlives one request so the agent keeps its place on the machine
// between messages — but the user has had the keyboard in between, so the
// element table from last turn is not evidence of anything.
test("a new turn forgets what was on screen and keeps where it was working", async () => {
  const clicked = [];
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          if (name === "pointer.clickAt") { clicked.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; }
          return {
            read: true, windowId: "7", application: "notepad", title: "x", visibleText: "",
            elements: [{ role: "button", text: "Save", clickable: true, bounds: { x: 10, y: 10, width: 40, height: 20 } }]
          };
        }
      })
    },
    adapter: {}
  });

  await toolset.execute("screen", { application: "notepad" });
  assert.equal((await toolset.execute("click", { text: "Save" })).ok, true);

  toolset.beginTurn();
  const stale = await toolset.execute("click", { text: "Save" });
  assert.equal(stale.ok, false, "a control seen before the user's last message is not on screen now");
  assert.match(stale.text, /Nothing on screen is labelled "Save"/);
  assert.equal(clicked.length, 1);

  // But the working window survives, which is what makes "now write in it" mean
  // something: a bare `screen` still knows which window it meant.
  const reread = await toolset.execute("screen", {});
  assert.equal(reread.ok, true);
  assert.match(reread.text, /windowId 7/);
});

test("new_document that did not actually open one says so rather than reporting success", async () => {
  const stuck = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [documentSurface(300, { undo: true })]
  });
  const result = await stuck.toolset.execute("new_document", { windowId: "42" });
  assert.match(result.text, /did NOT/);
  assert.match(result.text, /300 characters/);
  // And the window stays gated, because nothing about it has changed.
  const typed = await stuck.toolset.execute("type", { text: "a poem" });
  assert.equal(typed.ok, false);
  assert.match(typed.text, /ALREADY OPEN/);
});
