// THE FAULTS, AND THE TOOLS THEY ARE AIMED AT.
//
// Shared by `scripts/probe-fault-injection.mjs`, which reports the rates for the
// paper, and `tests/unit/fault-injection.test.js`, which holds them in CI. Two
// copies of a fault set that must agree are one edit away from not agreeing, and
// the one that drifts is the one guarding the honesty invariant.

import { ELEMENTS, DOM_TARGET, FIELD_TARGET } from "./mock-machine.js";

// The tools that CHANGE something. A read-only tool cannot claim it did work it
// did not do — it makes no claim about the world having moved — so including
// them would pad every rate in this file with cells that are not at risk.
export const ACTING_CALLS = [
  { tool: "click", args: { text: "Send" }, needsReading: true },
  { tool: "type", args: { text: "hello" }, needsReading: true },
  { tool: "key", args: { keys: "ctrl+s" }, needsReading: true },
  { tool: "scroll", args: { direction: "down" }, needsReading: true },
  { tool: "drag", args: { fromX: 400, fromY: 300, toX: 600, toY: 500 }, needsReading: true },
  { tool: "draw", args: { shape: "rect", x: 300, y: 200, width: 200, height: 150 }, needsReading: true },
  { tool: "launch", args: { application: "app" } },
  { tool: "focus", args: { windowId: "9" } },
  { tool: "window_state", args: { state: "maximize", windowId: "9" } },
  { tool: "write_file", args: { path: "C:\\fresh.txt", contents: "written body" } },
  { tool: "edit_file", args: { path: "C:\\edit.txt", old: "before", new: "after" }, file: ["c:\\edit.txt", "before\n"] },
  { tool: "clipboard", args: { text: "copied" }, label: "clipboard (write)" },
  { tool: "volume", args: { percent: 40 } },
  { tool: "close_app", args: { application: "app" } },
  { tool: "play_music", args: { query: "Señorita" } },
  { tool: "web_click", args: { text: "Next" } },
  { tool: "web_type", args: { text: "hello", into: "Search" } },
  { tool: "web_scroll", args: { y: 600 } }
];

const throws = (why) => async () => { throw new Error(why); };

// THE FAULTS ARE NOT INVENTED. Each one is the mechanism behind an incident this
// repository has a written record of; the comment names it.
export const FAULTS = {
  // "Sent." / "Muted." / "Focused." — the actuator accepts the call, reports
  // success, and the world does not move. The single most expensive class here.
  "silent-no-op": {
    adapter: {
      focusedElement: async () => ({
        found: true, name: "Something else entirely", value: "",
        boundingRect: { x: 10, y: 10, width: 10, height: 10 }
      }),
      getForegroundWindow: async () => ({ windowId: "77", processName: "other", title: "Another window" }),
      listWindows: async () => ([{
        WindowHandle: 9, ProcessName: "app", MainWindowTitle: "The app",
        Bounds: { x: 0, y: 0, width: 1200, height: 800 }, Foreground: false
      }]),
      // Undo stays DISABLED, which is the document saying nothing was drawn.
      inspectUi: async () => ({ windows: [{ ProcessName: "app", MainWindowTitle: "The app" }], elements: ELEMENTS }),
      pointerAction: async () => ({ performed: true, x: 5, y: 6, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
      pointerStroke: async () => ({ performed: true, strokes: 1, durationMs: 40 }),
      keyboardAction: async () => ({ performed: true })
    },
    capabilities: {
      // Accepts the bytes and stores nothing, so the read-back finds no file.
      "filesystem.write": async (inputs) => ({ filePath: inputs.filePath, existed: false }),
      "clipboard.write": async () => ({ performed: true }),
      "system.volume.set": async (inputs) => ({
        requestedPercent: inputs.percent, percent: 5, muted: false, peak: 0, applied: true
      }),
      "system.volume.inspect": async () => ({ available: true, percent: 5, muted: false, peak: 0.4 }),
      "window.activate": async () => ({ performed: true, foregroundWindowId: "77" }),
      "window.maximize": async () => ({ performed: true }),
      "application.close": async () => ({ performed: true }),
      "spotify.track.play": async () => ({ available: true, playback: { playing: false, nowPlaying: null } }),
      "browser.click": async () => ({ performed: true, target: DOM_TARGET }),
      "browser.type": async () => ({ performed: true, landed: "", target: FIELD_TARGET }),
      "browser.scroll": async () => ({
        performed: true, moved: false, scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 0 }
      })
    }
  },

  // The action lands, on the wrong thing. "still playing X, which is not what was
  // asked" — twelve of the 113 real failures in the store.
  "wrong-target": {
    adapter: {
      focusedElement: async () => ({
        found: true, name: "Delete", value: "", boundingRect: { x: 1, y: 1, width: 5, height: 5 }
      }),
      // The stroke landed in a DIFFERENT window, so this document's Undo stays
      // disabled. Without this the mock's drag still dirties the document and
      // "the document changed, so it drew" is true — an honest sentence that the
      // fault never made false.
      inspectUi: async () => ({ windows: [{ ProcessName: "app", MainWindowTitle: "The app" }], elements: ELEMENTS }),
      pointerAction: async () => ({ performed: true, x: 5, y: 6, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
      pointerStroke: async () => ({ performed: true, strokes: 1, durationMs: 40 }),
      getForegroundWindow: async () => ({ windowId: "42", processName: "notepad", title: "Untitled - Notepad" })
    },
    capabilities: {
      "filesystem.write": async (inputs) => ({ filePath: inputs.filePath, existed: false }),
      "system.volume.set": async () => ({ requestedPercent: 40, percent: 90, muted: false, peak: 0, applied: true }),
      "system.volume.inspect": async () => ({ available: true, percent: 90, muted: false, peak: 0 }),
      "spotify.track.play": async () => ({ available: true, playback: { playing: true, nowPlaying: "A completely different song" } }),
      "browser.type": async (inputs) => ({ performed: true, landed: `${inputs.text}corrupted`, target: FIELD_TARGET }),
      "clipboard.write": async () => ({ performed: true }),
      "clipboard.read": async () => ({ text: "something else" })
    }
  },

  // The actuator refuses outright. The honest failure, included because a tool
  // that cannot report THIS correctly has nothing else going for it.
  "actuator-throws": {
    adapter: {
      pointerAction: throws("the pointer queue rejected it"),
      pointerStroke: throws("the pointer queue rejected it"),
      keyboardAction: throws("the input queue rejected it")
    },
    capabilities: {
      "keyboard.type": throws("SendInput returned 0"),
      "keyboard.press": throws("SendInput returned 0"),
      "pointer.clickAt": throws("SendInput returned 0"),
      "pointer.wheel": throws("SendInput returned 0"),
      "filesystem.write": throws("EACCES: permission denied"),
      "clipboard.write": throws("the clipboard is locked by another process"),
      "system.volume.set": throws("the endpoint is gone"),
      "window.activate": throws("the window vanished"),
      "window.maximize": throws("the window vanished"),
      "application.launch": throws("the executable is missing"),
      "application.close": throws("access denied"),
      "spotify.track.play": throws("Spotify is not running"),
      "browser.click": throws("the page navigated away"),
      "browser.type": throws("the page navigated away"),
      "browser.scroll": throws("the page navigated away")
    }
  },

  // NOBODY LOOKED. The actuator works and the verifier cannot answer. The correct
  // result is UNCONFIRMED — not success, and NOT failure either. `unconfirmed is
  // not failed` is a house rule three shipped gates have already broken, so a
  // tool reporting REFUTED here is its own kind of defect.
  "reader-blind": {
    adapter: {
      focusedElement: async () => ({ found: false }),
      getForegroundWindow: async () => null,
      inspectUi: async () => ({ windows: [], elements: [] }),
      listWindows: async () => ([])
    },
    capabilities: {
      "screen.read": async () => ({ read: false, elements: [] }),
      "system.volume.inspect": async () => ({ available: false }),
      "clipboard.read": throws("the clipboard is locked"),
      "filesystem.read": throws("ENOENT"),
      "window.enumerate": async () => ({ windows: [] }),
      "browser.currentState": throws("the page is gone"),
      "browser.read": async () => ({ found: false })
    }
  }
};
