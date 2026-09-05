// SYSCORA MUST NOT WORK ON SYSCORA.
//
// This was already the most expensive class of mistake in this codebase: the
// window in front is usually this product's own, and `tools.js` records
// `launch WhatsApp` coming back "already running (windowId 984410, SYSCORA)",
// after which the agent read, clicked and typed into itself for the rest of the
// run. Identity scoring stopped it being TARGETED by name; it was still LISTED,
// so it remained something the model could reach for.
//
// The floating overlay makes that decisive rather than merely embarrassing. It
// is always on top, over every application, and it is where the user types — so
// an agent that can see it can click it, and an agent that clicks it is driving
// its own input box while it believes it is driving Spotify.
//
// The second half of this file is the half that matters. A filter this blunt
// could easily make some OTHER Electron application unreachable, and that is a
// defect nobody would think to look for.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";

const box = { x: 0, y: 0, width: 1200, height: 800 };

// The `windows` tool renders `window.enumerate` from the REGISTRY; `launch`
// asks `adapter.listWindows`. Both have to be fed, because the filter has to be
// in both places — putting it in only one was the first version of this change,
// and this file is what caught it.
function toolsetOver(windows) {
  return buildToolset({
    registry: {
      get: (name) => ({
        execute: async () => (name === "window.enumerate" ? { windows } : { performed: true })
      })
    },
    adapter: { listWindows: async () => windows }
  });
}

const OWN = [
  { WindowHandle: 1, ProcessName: "SYSCORA", MainWindowTitle: "SYSCORA", Bounds: box },
  { WindowHandle: 2, ProcessName: "electron", MainWindowTitle: "SYSCORA", Bounds: box }
];

test("the window list the model is shown never contains SYSCORA itself", async () => {
  const toolset = toolsetOver([
    ...OWN,
    { WindowHandle: 3, ProcessName: "Spotify", MainWindowTitle: "Spotify Free", Bounds: box }
  ]);
  const result = await toolset.execute("windows", {});
  assert.match(result.text, /Spotify/);
  assert.doesNotMatch(result.text, /SYSCORA/,
    "the overlay floats over everything; if the model can see it, it can click it");
});

// `launch` asks the window list whether the application is already open, and
// answering with SYSCORA's own window is exactly how the original defect ran.
test("launch never resolves an application to a SYSCORA window", async () => {
  const toolset = toolsetOver(OWN);
  const result = await toolset.execute("launch", { application: "syscora" });
  assert.doesNotMatch(result.text ?? "", /ALREADY RUNNING/,
    "even asked for by name, its own window must not become a working target");
});

// ---- and now the half that must NOT be filtered --------------------------
//
// Matched narrowly on purpose: `electron` alone is not enough, because plenty of
// applications a user may legitimately want automated are built on it.
const OTHERS = [
  { WindowHandle: 10, ProcessName: "Code", MainWindowTitle: "demo.js - SYSCORA - Visual Studio Code", Bounds: box },
  { WindowHandle: 11, ProcessName: "electron", MainWindowTitle: "Slack", Bounds: box },
  { WindowHandle: 12, ProcessName: "chrome", MainWindowTitle: "SYSCORA documentation", Bounds: box },
  { WindowHandle: 13, ProcessName: "WhatsApp.Root", MainWindowTitle: "WhatsApp", Bounds: box }
];

test("another Electron application is still reachable", async () => {
  const result = await toolsetOver(OTHERS).execute("windows", {});
  assert.match(result.text, /Slack/, "a different Electron app must not be swept up");
});

test("a window merely NAMED SYSCORA is still reachable", async () => {
  const result = await toolsetOver(OTHERS).execute("windows", {});
  assert.match(result.text, /Visual Studio Code/, "editing this repository must not hide the editor");
  assert.match(result.text, /SYSCORA documentation/, "a browser tab about SYSCORA is not SYSCORA");
  assert.match(result.text, /WhatsApp/);
});
