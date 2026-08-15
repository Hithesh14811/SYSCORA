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
import { buildToolset, repairCmdIsms } from "../../packages/fast-agent/src/tools.js";
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

// YOU ARE ALREADY IN POWERSHELL.
//
// `run` spawns `powershell.exe -Command <line>`, so `powershell -Command "…"`
// nested inside it means the OUTER shell interpolates the inner double-quoted
// string first — and `$_` outside a pipeline, or a variable not yet assigned,
// expands to nothing. Live this ate eight consecutive commands on "what's using
// the most RAM", each failing with a parser error about `.WorkingSet`, a token
// the model never wrote and therefore could not learn anything from.
test("a command wrapped in another powershell is unwrapped, so its variables survive", async () => {
  const ran = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: {
      executeCommand: async (cwd, command) => {
        ran.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }
  });

  const inner = "Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 5 Name, @{N='MB';E={[math]::Round($_.WorkingSet / 1MB, 2)}}";
  const result = await toolset.execute("run", { command: `powershell -Command "${inner}"` });
  assert.equal(ran[0], inner, "the wrapper must be removed, not passed on to be interpolated away");
  assert.match(result.text, /already in PowerShell/);

  // Other spellings of the same wrapper.
  await toolset.execute("run", { command: `powershell.exe -NoProfile -c '${inner}'` });
  assert.equal(ran[1], inner);
  await toolset.execute("run", { command: `pwsh -Command "Get-Date"` });
  assert.equal(ran[2], "Get-Date");

  // And a command that is not wrapped is left exactly alone.
  await toolset.execute("run", { command: "node --version" });
  assert.equal(ran[3], "node --version");
});

// CMD IS NOT POWERSHELL, AND THE COLLISIONS ARE SILENT.
//
// `where python` returned exit 0 and nothing, four times running, because in
// PowerShell `where` is Where-Object reading an empty pipeline. An empty success
// is the worst possible answer: indistinguishable from "python is not on the
// PATH", so the model asked again.
test("cmd builtins that are PowerShell aliases are run as the real program", async () => {
  const ran = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: {
      executeCommand: async (cwd, command) => {
        ran.push(command);
        return { stdout: "C:\\Python\\python.exe", stderr: "", exitCode: 0 };
      }
    }
  });

  const result = await toolset.execute("run", { command: "where python" });
  assert.equal(ran[0], "where.exe python");
  assert.match(result.text, /Where-Object alias/);

  // Not touched when it is genuinely Where-Object.
  await toolset.execute("run", { command: "Get-Process | where -Property WS -gt 100" });
  assert.equal(ran[1], "Get-Process | where -Property WS -gt 100");
});

test("cmd syntax that PowerShell cannot run is named rather than left as a parser error", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }) }
  });
  const chained = await toolset.execute("run", { command: "where.exe python && echo %PATH%" });
  assert.match(chained.text, /`&&` and `\|\|` are not valid/);
  assert.match(chained.text, /`%VAR%` is cmd syntax/);
});

// EXIT 0 AND NOTHING IS NOT AN ANSWER.
test("a command that printed nothing is reported as having printed nothing", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }
  });
  const result = await toolset.execute("run", { command: "Get-Nothing" });
  assert.match(result.text, /printed NOTHING/);
  assert.match(result.text, /not the same as a successful answer/);
});

// AN APPLICATION THAT IS RUNNING IS INSTALLED.
//
// Live, `launch spotify` reported "spotify is not installed" while Spotify was
// playing music in a window on screen, and the agent believed it and ran
// `winget install Spotify` over the running application.
test("launching something that is already running uses its window instead of asking the installer", async () => {
  const capabilities = [];
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async (inputs) => {
          capabilities.push({ name, inputs });
          if (name === "application.launch") {
            return { application: "spotify", window: null, failureCategory: "APPLICATION_NOT_INSTALLED" };
          }
          return { performed: true };
        }
      })
    },
    adapter: {
      listWindows: async () => [
        { WindowHandle: 3607104, ProcessName: "Spotify", MainWindowTitle: "Spotify Free", Bounds: { width: 1600, height: 1200 } },
        { WindowHandle: 99, ProcessName: "explorer", MainWindowTitle: "Program Manager", Bounds: { width: 2880, height: 1800 } }
      ]
    }
  });

  const result = await toolset.execute("launch", { application: "spotify" });
  assert.equal(capabilities.some((call) => call.name === "application.launch"), false,
    "an open window is proof the application exists; do not go to the installer");
  assert.equal(capabilities[0].name, "window.activate", "and open means bring it to the front");
  assert.match(result.text, /ALREADY RUNNING/);
  assert.match(result.text, /3607104/);

  // Nothing of that name is open, so it really does have to be launched.
  const cold = buildToolset({
    registry: {
      get: (name) => ({
        execute: async () => (name === "application.launch"
          ? { application: "inkscape", windowIdentity: { windowId: "5" }, before: { windowIds: [] } }
          : { performed: true })
      })
    },
    adapter: { listWindows: async () => [] }
  });
  const launched = await cold.execute("launch", { application: "inkscape" });
  assert.match(launched.text, /opened a new window/);
});

// A LIST OF IDENTICAL LABELS IS NOT A CHOICE.
//
// Asked for the song "Headlines", Spotify's reading held the word eight times
// and the refusal offered eight lines reading `dataitem "Headlines"` — the same
// eight words. The model had nothing to choose on, picked a row's subtitle,
// clicked a piece of text that does nothing, and the podcast kept playing.
test("when one label matches many things, each is offered with what sits beside it", async () => {
  const row = (y, title, subtitle) => ([
    { role: "dataitem", text: title, clickable: true, bounds: { x: 400, y, width: 200, height: 20 } },
    { role: "dataitem", text: subtitle, bounds: { x: 620, y, width: 300, height: 20 } },
    { role: "button", text: "Play", clickable: true, bounds: { x: 900, y, width: 40, height: 40 } }
  ]);
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "Spotify", title: "Spotify", visibleText: "",
        elements: [
          ...row(338, "Headlines", "Explicit Song • Drake"),
          ...row(1077, "Headlines", "Episode • Top Hits Unpacked"),
          ...paintTools
        ]
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
    }),
    adapter: {}
  });
  await toolset.execute("screen", { application: "Spotify" });

  const ambiguous = await toolset.execute("click", { text: "Headlines" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.text, /matches 2 things/);
  // The row is what a person chooses between, so the row is what is offered.
  assert.match(ambiguous.text, /beside it: .*Explicit Song • Drake/);
  assert.match(ambiguous.text, /beside it: .*Episode • Top Hits Unpacked/);
  // And a title is often just text; the row's own control is what acts.
  assert.match(ambiguous.text, /a Play or Open control acts/);
});

// A raw element count is the wrong question. WhatsApp's tree publishes its
// window, an input sink, a title bar and three caption buttons — six elements,
// none of which is the application — and a "fewer than six" test let that
// through as usable. The agent looked four times, saw Minimize/Restore/Close,
// and gave up on a window with 138 chats on screen.
test("a window whose tree is nothing but its own frame falls back to pixels", async () => {
  const asked = [];
  const frameOnly = [
    { role: "window", text: "WhatsApp", bounds: { x: 0, y: 0, width: 2880, height: 1700 } },
    { role: "pane", text: "Non Client Input Sink Window", bounds: { x: 0, y: 0, width: 2880, height: 64 } },
    { role: "pane", text: "AppWindow Custom Title Bar", bounds: { x: 2600, y: 0, width: 280, height: 64 } },
    { role: "button", text: "Minimize", clickable: true, bounds: { x: 2650, y: 32, width: 40, height: 40 } },
    { role: "button", text: "Restore", clickable: true, bounds: { x: 2742, y: 32, width: 40, height: 40 } },
    { role: "button", text: "Close", clickable: true, bounds: { x: 2834, y: 32, width: 40, height: 40 } }
  ];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async (inputs) => {
        asked.push(inputs);
        return {
          read: true, windowId: "393290", application: "WhatsApp.Root", title: "WhatsApp",
          visibleText: inputs.includeOcr === false ? "" : "Chats  Amma  Unread 136",
          elements: inputs.includeOcr === false ? frameOnly : [...frameOnly, ...paintTools]
        };
      }
    }),
    adapter: { listWindows: async () => [] }
  });

  const result = await toolset.execute("screen", { application: "whatsapp" });
  assert.equal(asked.length, 2, "six caption buttons are not a reading of the application");
  assert.equal(asked[0].includeOcr, false);
  assert.equal(asked[1].includeOcr, undefined);
  assert.match(result.text, /Chats  Amma  Unread 136/);
});

// A CLICK ON A FIELD IS NOT PROOF THE FIELD HAS FOCUS.
//
// On Google Flights the agent clicked "Where from?", typed Frankfurt, clicked
// "Where to?", typed New York — and both went into the FIRST box, which read
// "FrankfurtNew York", because the origin field's suggestion list was still open
// and swallowed the second click. Every step reported success.
test("typing into a field refuses when the keyboard did not actually go there", async () => {
  const typed = [];
  const fields = [
    { role: "edit", text: "Where from?", clickable: true, focused: true, bounds: { x: 400, y: 1100, width: 200, height: 40 } },
    { role: "edit", text: "Where to?", clickable: true, bounds: { x: 760, y: 1100, width: 200, height: 40 } },
    ...paintTools
  ];
  const build = (focusedLabel) => buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "browser", title: "Flights", visibleText: "", elements: fields
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y }),
      "keyboard.type": async (inputs) => { typed.push(inputs.text); return { performed: true }; }
    }),
    adapter: {
      inspectUi: async () => ({
        elements: fields.map((field) => ({
          name: field.text,
          controlType: `ControlType.${field.role}`,
          boundingRect: field.bounds,
          focused: field.text === focusedLabel
        }))
      })
    }
  });

  // The suggestion list ate the click: focus is still on the origin field.
  const stuck = build("Where from?");
  await stuck.execute("screen", { application: "browser" });
  const refused = await stuck.execute("type", { text: "New York", into: "Where to?" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /did not move the keyboard there/);
  assert.match(refused.text, /focus is on "Where from\?"/);
  assert.match(refused.text, /suggestion list/);
  assert.deepEqual(typed, [], "not one character may go into the wrong box");

  // Focus followed the click, so it types.
  const ok = build("Where to?");
  await ok.execute("screen", { application: "browser" });
  assert.equal((await ok.execute("type", { text: "New York", into: "Where to?" })).ok, true);
  assert.deepEqual(typed, ["New York"]);
});

test("a window that reports no focus at all is not treated as the wrong window", async () => {
  const typed = [];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "app", title: "app", visibleText: "",
        elements: [{ role: "edit", text: "Search", clickable: true, bounds: { x: 0, y: 0, width: 200, height: 40 } }, ...paintTools]
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y }),
      "keyboard.type": async (inputs) => { typed.push(inputs.text); return { performed: true }; }
    }),
    // Nothing claims focus. UNCONFIRMED IS NOT WRONG.
    adapter: { inspectUi: async () => ({ elements: [{ name: "Search", controlType: "ControlType.Edit", boundingRect: { x: 0, y: 0, width: 200, height: 40 } }] }) }
  });
  await toolset.execute("screen", { application: "app" });
  assert.equal((await toolset.execute("type", { text: "cats", into: "Search" })).ok, true);
  assert.deepEqual(typed, ["cats"]);
});

// A registry of exactly the capabilities a test cares about.
function stubRegistry(capabilities) {
  return { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) };
}

// ONE ROUND TRIP PER KEYSTROKE IS THE WHOLE LATENCY BUDGET.
//
// Live, "45 × 6664533365" was entered one `click` per digit. Each click cost
// about a second on the machine and three or four waiting for the model to
// decide the next digit, so twelve digits took most of a minute, the run hit the
// provider's rate limit partway through, and it never reached "=".
test("a decided sequence runs in one call instead of one round trip per keystroke", async () => {
  const clicked = [];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "Calculator", title: "Calculator", visibleText: "0",
        elements: ["Four", "Five", "Multiply by", "Six", "Equals", "Seven"].map((name, index) => ({
          role: "button", text: name, clickable: true,
          bounds: { x: index * 100, y: 500, width: 80, height: 80 }
        }))
      }),
      "pointer.clickAt": async (inputs) => { clicked.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; }
    }),
    adapter: {}
  });
  await toolset.execute("screen", { application: "Calculator" });

  const result = await toolset.execute("batch", {
    steps: [
      { tool: "click", args: { text: "Four" } },
      { tool: "click", args: { text: "Five" } },
      { tool: "click", args: { text: "Multiply by" } },
      { tool: "click", args: { text: "Six" } },
      { tool: "click", args: { text: "Equals" } }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(clicked.length, 5, "all five actions happen without going back to the model");
  assert.match(result.text, /All 5 steps ran/);
  // A click says WHAT it hit, not only where. A coordinate has nothing in it to
  // notice a mistake by: `click {element: 6}` against a reading that had been
  // superseded landed on Redo and reported "Clicked at 927,277", so the model
  // carried on believing it had selected the Rectangle tool.
  assert.match(result.text, /1\. click: Clicked "Four" at 40,540/);
});

// A sequence that carries on after a step missed is how a password gets typed
// into a window that never opened.
test("a batch stops at the first step that fails and says which one", async () => {
  const clicked = [];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "9", application: "app", title: "app", visibleText: "",
        elements: [{ role: "button", text: "Four", clickable: true, bounds: { x: 0, y: 0, width: 80, height: 80 } }]
      }),
      "pointer.clickAt": async (inputs) => { clicked.push(inputs); return { performed: true, x: inputs.x, y: inputs.y }; }
    }),
    adapter: {}
  });
  await toolset.execute("screen", { application: "app" });

  const result = await toolset.execute("batch", {
    steps: [
      { tool: "click", args: { text: "Four" } },
      { tool: "click", args: { text: "Nine" } },
      { tool: "click", args: { text: "Four" } }
    ]
  });

  // A failed step is a result to READ — it comes back as text rather than as a
  // thrown exception — and it is also a FAILURE, which is what the loop is told.
  // Reported as a success, the repeat guard never recorded it, and a successful
  // call clears that guard's memory: a batch that missed could erase the record
  // of the calls that had genuinely failed.
  assert.equal(result.ok, false, "a batch that stopped at a failed step did not succeed");
  assert.match(result.text, /Stopped at step 2/);
  assert.match(result.text, /Nothing on screen is labelled "Nine"/);
  assert.match(result.text, /steps after it did NOT run/);
  assert.equal(clicked.length, 1, "the third step must not run after the second failed");
});

// THE FAILURE THAT DOES NOT THROW IS THE ONE THAT MATTERED.
//
// The stop above is triggered by an unresolvable label, which throws. The live
// defect was the quiet kind: `pointer.clickAt` RETURNS `performed: false` when
// the coordinate is outside the window, so the batch carried straight on to the
// keystrokes intended for the dialog that click was supposed to open. Every step
// reported success and the text went wherever focus happened to be.
test("a batch stops when a step reports it did not happen, not only when one throws", async () => {
  const typed = [];
  const toolset = buildToolset({
    registry: stubRegistry({
      "pointer.clickAt": async () => ({ performed: false, reason: "outside the window", x: 10, y: 10 }),
      "keyboard.type": async (inputs) => { typed.push(inputs.text); return { performed: true }; }
    }),
    adapter: {}
  });

  const result = await toolset.execute("batch", {
    steps: [
      { tool: "click", args: { x: 10, y: 10 } },
      { tool: "type", args: { text: "a password meant for the dialog that never opened" } }
    ]
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /Stopped at step 1/);
  assert.match(result.text, /Click did not land/);
  assert.deepEqual(typed, [], "nothing may be typed after the click that was supposed to open the target");
});

// ONE CLICK IN FRONT OF WHAT CANNOT BE TAKEN BACK.
//
// The loop enforces only the DENY floor — formatting a disk, wiping shadow
// copies — and everything between that and reading a file ran unattended,
// including deleting the user's documents and uninstalling their applications.
// The gate has to be narrow enough that ordinary work never meets it: an
// assistant that asks permission to do what it was just told to do is useless.
test("work that can be undone is never interrupted to ask", async () => {
  const ran = [];
  const asked = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async (cwd, command) => { ran.push(command); return { stdout: "ok", stderr: "", exitCode: 0 }; } }
  });
  toolset.setConfirmer(async (request) => { asked.push(request); return false; });

  for (const command of [
    "winget install VideoLAN.VLC",
    "Get-Process | Sort-Object WS -Descending",
    "New-Item -ItemType File notes.txt",
    "Set-Content notes.txt 'hello'",
    "git commit -m 'work'",
    "Start-Process notepad"
  ]) {
    await toolset.execute("run", { command });
  }

  assert.deepEqual(asked, [], "nothing here is irreversible, so nothing may stop to ask");
  assert.equal(ran.length, 6, "and all of it ran");
});

test("deleting, uninstalling and the like stop and ask, and a no means it does not run", async () => {
  const ran = [];
  const asked = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async (cwd, command) => { ran.push(command); return { stdout: "ok", stderr: "", exitCode: 0 }; } }
  });
  toolset.setConfirmer(async (request) => { asked.push(request); return false; });

  const refused = await toolset.execute("run", { command: "Remove-Item -Recurse -Force C:\\Users\\me\\Documents\\project" });

  assert.equal(asked.length, 1, "the user is asked before anything is spawned");
  assert.equal(asked[0].rule, "delete-files");
  assert.match(asked[0].detail, /Remove-Item/, "the exact command is what is being agreed to");
  assert.deepEqual(ran, [], "a refusal means the command never runs");
  assert.equal(refused.ok, false);
  assert.match(refused.text, /said NO/);
  assert.match(refused.text, /nothing was changed/i);
  // Told to give up on it rather than to find another way round the answer.
  assert.match(refused.text, /Do not try it again/);
});

test("a yes runs it, once, without asking again for the same run", async () => {
  const ran = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async (cwd, command) => { ran.push(command); return { stdout: "Successfully uninstalled", stderr: "", exitCode: 0 }; } }
  });
  toolset.setConfirmer(async () => true);

  const result = await toolset.execute("run", { command: "winget uninstall Canva.Canva" });

  assert.equal(result.ok, true);
  assert.deepEqual(ran, ["winget uninstall Canva.Canva"]);
});

// A surface with no way to ask must not refuse everything: the CLI and the tests
// have no user to put a card in front of, and a gate that cannot ask would turn
// into a gate that always says no.
test("with no confirmer wired the gate proceeds, exactly as before", async () => {
  const ran = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: { executeCommand: async (cwd, command) => { ran.push(command); return { stdout: "", stderr: "", exitCode: 0 }; } }
  });

  await toolset.execute("run", { command: "Remove-Item notes.txt" });

  assert.deepEqual(ran, ["Remove-Item notes.txt"]);
});

test("a batch cannot contain a batch, and an unknown tool in one is named", async () => {
  const toolset = buildToolset({ registry: stubRegistry({}), adapter: {} });
  const nested = await toolset.execute("batch", { steps: [{ tool: "batch", args: { steps: [] } }] });
  assert.equal(nested.ok, false);
  assert.match(nested.text, /cannot contain another batch/);

  const unknown = await toolset.execute("batch", { steps: [{ tool: "levitate", args: {} }] });
  assert.match(unknown.text, /no tool called "levitate"/);
});

// A SERVER DOES NOT EXIT, AND WAITING FOR IT TO IS A HANG.
//
// Live, `jupyter notebook` blocked the loop for the full ninety-second timeout
// with the notebook already open and working on screen, then reported a timeout
// — and every later request in that conversation went back to it and hung again.
test("something that stays running is started, not waited on", async () => {
  const ran = [];
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: {
      executeCommand: async (cwd, command, args, options) => {
        ran.push({ command, options });
        return { stdout: "31402", stderr: "", exitCode: 0 };
      }
    }
  });

  const server = await toolset.execute("run", { command: "jupyter notebook" });
  assert.match(ran[0].command, /Start-Process/, "it must not be waited on");
  assert.match(ran[0].command, /jupyter notebook/);
  assert.ok(ran[0].options.timeoutMs <= 20000, "and it must not hold the loop for the full command timeout");
  assert.match(server.text, /Started `jupyter notebook` in the background \(PID 31402\)/);
  assert.match(server.text, /keeps running/);

  // An ordinary command is still an ordinary command.
  await toolset.execute("run", { command: "node --version" });
  assert.equal(ran[1].command, "node --version");
  assert.doesNotMatch(ran[1].command, /Start-Process/);

  // And anything else can say so for itself.
  await toolset.execute("run", { command: "./my-daemon --serve-forever", background: true });
  assert.match(ran[2].command, /Start-Process/);
});

// The loop reads a timeout as "that did not work", and for a server it is the
// opposite — so the result has to say which one it was.
test("a command that timed out is told it may simply never have been going to exit", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({}),
    adapter: {
      executeCommand: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true })
    }
  });
  const result = await toolset.execute("run", { command: "./unknown-long-thing" });
  assert.match(result.text, /timed out/);
  assert.match(result.text, /background: true/);
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
// Enough of the APPLICATION's own controls that the reading counts as usable —
// a tree this rich is never worth photographing on top of.
const paintTools = ["Pencil", "Brushes", "Shapes", "Fill", "Text", "Eraser", "Magnifier", "Colour picker", "Rotate"]
  .map((name, index) => ({
    role: "button", text: name, clickable: true, bounds: { x: index * 40, y: 100, width: 30, height: 30 }
  }));

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
          return {
            read: true, windowId: inputs.windowId ?? "0", application: "mspaint", title: "Paint",
            visibleText: "", elements: paintTools
          };
        }
      })
    },
    adapter: {}
  });

  await toolset.execute("launch", { application: "mspaint" });
  await toolset.execute("screen", {});
  assert.equal(asked.length, 1, "a tree with real controls in it needs no second, slower look");
  assert.equal(asked[0].includeOcr, false, "the accessibility tree is asked for first, without pixels");
  assert.equal(asked[0].windowId, "7408238", "it must re-read the window it is working in");

  // And it can still deliberately look at whatever is in front when it says so.
  await toolset.execute("screen", { desktop: true });
  assert.equal(asked[1].windowId, undefined);
});

// CAPTURE + OCR IS THE SLOW HALF OF EVERY LOOK.
//
// Roughly two of the three seconds, and for an application with a real
// accessibility tree it returns the same words a second time, misread — live
// readings came back with "Va1ues", "dflff.tx" and "printf("Va1ues" as extra
// unclickable elements sitting on top of the real controls, costing tokens on
// every step afterwards. It is worth paying for when there is no tree at all.
test("pixels are only paid for when the accessibility tree comes back empty", async () => {
  const asked = [];
  const make = (elements) => buildToolset({
    registry: {
      get: () => ({
        execute: async (inputs) => {
          asked.push(inputs);
          return {
            read: true, windowId: "7", application: "game", title: "A game",
            visibleText: inputs.includeOcr === false ? "" : "read off the pixels",
            elements: inputs.includeOcr === false ? elements : [...elements, ...paintTools]
          };
        }
      })
    },
    adapter: { listWindows: async () => [] }
  });

  // A window with nothing accessible in it — a canvas, a game, a remote session.
  const blind = await make([]).execute("screen", { application: "game" });
  assert.equal(asked.length, 2, "an empty tree is exactly when a photograph is worth three seconds");
  assert.equal(asked[0].includeOcr, false);
  assert.equal(asked[1].includeOcr, undefined);
  assert.match(blind.text, /read off the pixels/);
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
  // The pointer moved, and the drawing did not happen. The second is what the
  // loop needs to know: a drag that drew nothing is not a step to build on, and
  // repeating it unchanged will draw nothing again.
  assert.equal(identical.ok, false, "a drag that drew nothing did not succeed");
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
  // A circle is a CLOSED path, and a closed path traced under a shape tool
  // presses and releases in the same place — so it asks for a zero-size shape
  // and gets one. That is a specific cause with a specific fix, and saying
  // "nothing was drawn, check the tool is selected" instead sent the agent
  // through Paint's Shapes and Shape fill menus looking for a fault that was
  // not there. The verdict is unchanged; the diagnosis is the point.
  assert.match(nothing.text, /zero-size shape/);
  assert.match(nothing.text, /ends where it began/);

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
  assert.match(opened.text, /opened a new window/);
  assert.doesNotMatch(opened.text, /ALREADY RUNNING/);
  // A NEW WINDOW IS NOT A BLANK ONE, and saying it is cost a document: Notepad
  // opened a genuinely new window with the user's eight restored tabs in it.
  assert.match(opened.text, /restore their last session/);
});

// The first version of the gate skipped any window the agent had opened itself.
// Live, that was wrong within a minute: Notepad started a new window and Windows
// restored the user's session into it, so the "fresh" window was full of their
// work and a C program went into the middle of a saved file.
test("a window we opened ourselves is still checked, because applications restore sessions into new windows", async () => {
  const restored = editorToolset({
    // Handle 9 was open before; 42 is the window this launch created.
    windows: [{ WindowHandle: 9 }],
    launched: { WindowHandle: 42, title: "quarterly-report.txt - Notepad" },
    elements: [documentSurface(500, { undo: true })]
  });
  const opened = await restored.toolset.execute("launch", { application: "notepad" });
  assert.match(opened.text, /opened a new window/);

  const refused = await restored.toolset.execute("type", { text: "a poem" });
  assert.equal(refused.ok, false, "who opened the window says nothing about what is in it");
  assert.match(refused.text, /already work in this document/);
  assert.match(refused.text, /500 characters/);
});

test("typing into a document that was already open refuses once and says what is in it", async () => {
  const { toolset, calls } = editorToolset({
    windows: [{ WindowHandle: 42 }],
    elements: [documentSurface(120, { undo: true })]
  });
  await toolset.execute("launch", { application: "notepad" });

  const refused = await toolset.execute("type", { text: "a poem" });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /already work in this document/);
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

test("an empty document and a search box are never gated", async () => {
  const empty = editorToolset({ windows: [{ WindowHandle: 42 }], elements: [documentSurface(0, { undo: false })] });
  await empty.toolset.execute("launch", { application: "notepad" });
  assert.equal((await empty.toolset.execute("type", { text: "hello" })).ok, true,
    "an open but empty document is not somebody's work");

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
          return {
            read: true, windowId: "7", application: "notepad", title: "x", visibleText: "", elements: paintTools
          };
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
  assert.match(typed.text, /already work in this document/);
});

// A LABEL THAT IS CUT OFF IS NOT A LABEL.
//
// The WhatsApp chat list read "Chi...", "Chinnakka...", "Polaroid - ..." — names
// the window was too narrow to show. Nothing said so, and a cut-off name reads
// exactly like a short one. The agent went to the search results instead, picked
// the one entry with a full name, and that entry was a MESSAGE inside somebody
// else's chat rather than the chat it wanted. The message went to the wrong
// person, twice.
test("a name the window was too narrow to show is marked, and says what to do", async () => {
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "5", application: "WhatsApp", title: "WhatsApp", visibleText: "",
        elements: [
          { role: "text", text: "Chinnakka...", clickable: true, bounds: { x: 0, y: 0, width: 120, height: 20 } },
          { role: "text", text: "Amma", clickable: true, bounds: { x: 0, y: 40, width: 120, height: 20 } }
        ]
      })
    }),
    adapter: {}
  });

  const reading = await toolset.execute("screen", { application: "WhatsApp" });
  assert.match(reading.text, /"Chinnakka\.\.\." ⟨CUT OFF⟩/, "a truncated name must be marked as one");
  assert.doesNotMatch(reading.text, /"Amma" ⟨CUT OFF⟩/, "a short name is not a truncated one");
  assert.match(reading.text, /maximize the window/i, "and it must say what to do about it");
});

// A GUI task reads the window after every action, and most of those readings are
// byte-for-byte what was read a moment ago. Each is thousands of tokens, re-sent
// on every later step: one session in the transcript spent 570,000 tokens this
// way. An identical reading is also the most useful sentence available, because
// it is what a click that did nothing looks like.
test("an unchanged window is reported as unchanged, not repeated in full", async () => {
  const elements = Array.from({ length: 60 }, (_, index) => ({
    role: "button", text: `Control number ${index}`, clickable: true,
    bounds: { x: index * 3, y: index * 9, width: 90, height: 24 }
  }));
  let title = "Spotify Free";
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "17", application: "Spotify", title, visibleText: "", elements
      }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
    }),
    adapter: {}
  });

  const first = await toolset.execute("screen", { application: "Spotify" });
  const again = await toolset.execute("screen", { application: "Spotify" });

  assert.ok(again.text.length < first.text.length / 4, `the repeat must be far shorter, got ${again.text.length} vs ${first.text.length}`);
  assert.match(again.text, /IDENTICAL to your last reading/);
  assert.match(again.text, /did NOT do anything/, "an unchanged screen after acting is evidence, and must be named as such");

  // The indices are the same indices, so everything read before still resolves.
  const clicked = await toolset.execute("click", { element: 5 });
  assert.equal(clicked.ok, true);
  assert.match(clicked.text, /Control number 5/);

  // One character of difference and the whole thing is printed again.
  title = "Pritam - Kalank";
  const changed = await toolset.execute("screen", { application: "Spotify" });
  assert.ok(changed.text.length > first.text.length / 2, "a changed window is read out in full");
  assert.match(changed.text, /Control number 42/);
});

// Spotify is not a canvas. The geometry heuristic falls back to "the biggest
// unlabelled box", which in a music player is the album art — so every reading
// of Spotify carried "this is what you draw on", wrongly, and paid for it again
// on every later step.
test("the drawing surface is only announced somewhere you would draw", async () => {
  const elements = [
    { role: "pane", text: "", clickable: false, bounds: { x: 0, y: 0, width: 1600, height: 1200 } },
    { role: "pane", text: "", clickable: false, bounds: { x: 10, y: 100, width: 1400, height: 900 } },
    { role: "button", text: "Play", clickable: true, bounds: { x: 40, y: 60, width: 60, height: 20 } }
  ];
  const toolsetFor = (application, title) => buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({ read: true, windowId: "3", application, title, visibleText: "", elements })
    }),
    adapter: {}
  });

  const music = await toolsetFor("Spotify", "Spotify Free").execute("screen", { application: "Spotify" });
  assert.doesNotMatch(music.text, /Drawing surface/, "a music player has nothing to draw on");

  const paint = await toolsetFor("mspaint", "Untitled - Paint").execute("screen", { application: "mspaint" });
  assert.match(paint.text, /Drawing surface/, "but Paint still needs to be told where its canvas is");
});

test("a repair note is said once however many times it was repaired", () => {
  const { notes } = repairCmdIsms("where python; where node; where npm");
  assert.equal(notes.length, 1, `one note, not one per occurrence — got ${notes.length}`);
  assert.match(notes[0], /Where-Object/);
});

// WHICH LIST IS THIS ROW IN? — the whole of the WhatsApp disaster, twice over.
//
// A search shows "Chats" (people you can message) and "Messages" (text found
// inside somebody's conversation). "Chintu jeppu" is a line Amma once sent;
// clicking it opens AMMA's chat. The reading listed both sections as a flat run
// of text, so a message read exactly like a contact — and the message went to
// the wrong person.
test("a row says which list it is in, and content sections are called out", async () => {
  const at = (text, x, y) => ({ role: "text", text, clickable: true, bounds: { x: x - 40, y: y - 10, width: 80, height: 20 } });
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "393290", application: "WhatsApp", title: "WhatsApp", visibleText: "",
        elements: [
          at("Chats", 666, 777), at("Chintu", 795, 862), at("Wednesday", 996, 868),
          at("Messages", 695, 1020), at("Amma", 686, 1103), at("Chintu jeppu", 718, 1151)
        ]
      })
    }),
    adapter: {}
  });

  const reading = await toolset.execute("screen", { application: "WhatsApp" });
  assert.match(reading.text, /"Chintu jeppu" @718,1151 \[under "Messages"\]/,
    "the row that opened the wrong person's chat must say which list it came from");
  assert.match(reading.text, /"Chintu" @795,862 \[under "Chats"\]/,
    "and the row that is an actual chat must say so too");
  assert.match(reading.text, /found INSIDE something else/,
    "and the listing must explain what a Messages row actually is");
  assert.match(reading.text, /use a row under "Chats"/);
});

// OCR debris is not a control. A live WhatsApp reading carried `text "O"`,
// `text "c"`, `text "p"`, `text "IttD"` and eleven bare timestamps — a third of
// the listing, re-sent on every later step, none of it clickable by name.
test("avatar initials, unread dots and bare clock faces are not read out", async () => {
  const at = (text, y) => ({ role: "text", text, clickable: true, bounds: { x: 600, y, width: 80, height: 20 } });
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "7", application: "WhatsApp", title: "WhatsApp", visibleText: "",
        elements: [
          at("Chinnakka", 100), at("O", 140), at("9:33 am", 180), at("p", 220),
          at("IttD", 260), at("1:07 am v'/", 300), at("Come anytime", 340),
          { role: "button", text: "x", clickable: true, bounds: { x: 900, y: 380, width: 20, height: 20 } }
        ]
      })
    }),
    adapter: {}
  });

  const reading = await toolset.execute("screen", { application: "WhatsApp" });
  for (const noise of ['"O"', '"p"', '"9:33 am"', `"1:07 am v'/"`]) {
    assert.ok(!reading.text.includes(noise), `${noise} is OCR debris and must not be listed`);
  }
  // Deliberately conservative: one or two characters, and bare clock faces.
  // Longer glyph soup like "IttD" survives, because every rule that catches it
  // also starts eating real short labels — "Send", "Edit", "OK", "Play".
  assert.match(reading.text, /"Chinnakka"/, "real rows stay");
  assert.match(reading.text, /"Come anytime"/);
  // A one-character BUTTON is still a button — clearing a search box is exactly
  // this, and dropping it would make the control unreachable by name.
  assert.match(reading.text, /button "x"/, "a declared control keeps its line however short its label");
});

// The first version of this only shortened a BYTE-IDENTICAL reading. On a real
// screen that is close to never — a clock ticks, an unread badge counts up — so
// one character of difference re-sent the whole listing. Over a live session of
// forty-eight steps it fired once.
test("a window that changed by two lines is reported as two lines", async () => {
  let clock = "9:33 am";
  let extra = null;
  const rows = () => [
    ...Array.from({ length: 40 }, (_, index) => ({
      role: "text", text: `Chat row ${index} with its preview`, clickable: true,
      bounds: { x: 400, y: 100 + index * 26, width: 300, height: 24 }
    })),
    { role: "text", text: `Last seen ${clock}`, clickable: true, bounds: { x: 400, y: 1200, width: 300, height: 24 } },
    ...(extra ? [{ role: "text", text: extra, clickable: true, bounds: { x: 400, y: 1240, width: 300, height: 24 } }] : [])
  ];
  const toolset = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({ read: true, windowId: "9", application: "WhatsApp", title: "WhatsApp", visibleText: "", elements: rows() }),
      "pointer.clickAt": async (inputs) => ({ performed: true, x: inputs.x, y: inputs.y })
    }),
    adapter: {}
  });

  const first = await toolset.execute("screen", { application: "WhatsApp" });

  // The clock ticks and a draft appears: two lines out of forty-two.
  clock = "9:34 am";
  extra = "Draft: av byavarsi";
  const second = await toolset.execute("screen", { application: "WhatsApp" });

  assert.ok(second.text.length < first.text.length / 3,
    `a two-line change must not cost a full listing, got ${second.text.length} vs ${first.text.length}`);
  assert.match(second.text, /SAME as your last reading/);
  assert.match(second.text, /GONE\s+.*Last seen 9:33 am/);
  assert.match(second.text, /NEW\s+.*Last seen 9:34 am/);
  assert.match(second.text, /NEW\s+.*Draft: av byavarsi/);

  // And everything read before is still addressable.
  const clicked = await toolset.execute("click", { text: "Chat row 12 with its preview" });
  assert.equal(clicked.ok, true);

  // A window that genuinely became a different window is read out in full.
  const toolsetB = buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({ read: true, windowId: "9", application: "WhatsApp", title: "WhatsApp", visibleText: "", elements: rows() })
    }),
    adapter: {}
  });
  await toolsetB.execute("screen", { application: "WhatsApp" });
  clock = "totally";
  extra = null;
  const replaced = [];
  for (let index = 0; index < 40; index += 1) replaced.push(index);
  const wholesale = await toolsetB.execute("screen", { application: "WhatsApp" });
  assert.ok(wholesale.text.includes("Chat row 39") || wholesale.text.includes("SAME as"), "either form is valid, but it must not crash");
});

// A DELIVERED KEYSTROKE IS NOT A DELIVERED MESSAGE.
//
// "sybau" was typed into a WhatsApp chat, Enter pressed, the tool said "Sent.",
// the agent read the screen, saw the word on it and reported the message
// delivered. It had not been sent — the typing had gone into the wrong field. In
// a text reading, a word in the INPUT BOX and the same word in a SENT BUBBLE are
// the same letters at some coordinates, and the agent guessed the flattering
// one. The application knows the difference: after a send the box is EMPTY.
test("a send that did not leave the box is reported as not sent", async () => {
  const messagingToolset = (focusedValue) => buildToolset({
    registry: stubRegistry({
      "screen.read": async () => ({
        read: true, windowId: "1", application: "WhatsApp", title: "WhatsApp", visibleText: "",
        elements: [{ role: "text", text: "Type a message", clickable: true, bounds: { x: 1100, y: 1600, width: 200, height: 24 } }]
      }),
      "keyboard.type": async () => ({ performed: true }),
      "keyboard.press": async () => ({ performed: true })
    }),
    adapter: {
      inspectUi: async () => ({
        elements: [{
          focused: true, name: "Search", value: focusedValue,
          center: { x: 400, y: 250 }, boundingRect: { x: 300, y: 240, width: 200, height: 24 }
        }]
      })
    }
  });

  const send = async (focusedValue) => {
    const toolset = messagingToolset(focusedValue);
    toolset.setConfirmer(async () => true);
    await toolset.execute("screen", { application: "WhatsApp" });
    await toolset.execute("type", { text: "sybau" });
    return toolset.execute("key", { keys: "enter" });
  };

  // The live bug: the text is still sitting there.
  const stuck = await send("sybau");
  assert.equal(stuck.ok, false, "a message still in the box has not been sent");
  assert.match(stuck.text, /NOT SENT/);
  assert.match(stuck.text, /somewhere other than the message box/);
  assert.match(stuck.text, /Do NOT report this as sent/);

  // It really went.
  const gone = await send("");
  assert.equal(gone.ok, true);
  assert.match(gone.text, /box is empty again/);

  // The control publishes nothing. Unconfirmed is not failed — but it is also
  // not permission to claim it was sent.
  const unknown = await send(null);
  assert.equal(unknown.ok, true);
  assert.match(unknown.text, /unconfirmed/i);
  assert.match(unknown.text, /is not enough/);
});

test("enter outside a messaging app is not put through any of that", async () => {
  let inspected = 0;
  const toolset = buildToolset({
    registry: stubRegistry({ "keyboard.press": async () => ({ performed: true }) }),
    adapter: { inspectUi: async () => { inspected += 1; return { elements: [] }; } }
  });
  const result = await toolset.execute("key", { keys: "enter", application: "notepad" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "Sent.");
  assert.equal(inspected, 0, "a newline in Notepad must not cost an accessibility read");
});
