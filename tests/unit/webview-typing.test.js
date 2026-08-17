// 42 STEPS, 599,352 TOKENS, AND THE MESSAGE WAS NEVER SENT.
//
// A live request on 16 Aug 2026 — "send message to amma on whatsapp" — read the
// chat perfectly, found the message box, and then could not put a word in it.
// Two separate defects, both of which these tests pin:
//
// 1. Following a reading into an application's CONTENT window made WhatsApp
//    arrive with a Document control holding the conversation, and the gate that
//    protects somebody's unsaved work read that as a file with work in it:
//    "There is already work in this document — its title is "(137) WhatsApp",
//    and the document holds 129 characters." Every keystroke was refused.
//
// 2. An input's NAME is its placeholder, and a placeholder does not change when
//    you type. So the box read `edit "Type a message to Amma❤️"` before and
//    after, the re-read came back IDENTICAL, and nothing in the reading could
//    tell the agent whether its text had landed.

import test from "node:test";
import assert from "node:assert/strict";

import { isWebviewHostProcess } from "../../os-adapters/windows/src/webview-windows.js";
import { buildToolset, renderElementsForTest } from "../../packages/fast-agent/src/tools.js";

test("a rendered page is recognised whoever is hosting it", () => {
  // The window WhatsApp's interface actually lives in.
  assert.equal(isWebviewHostProcess("msedgewebview2"), true);
  assert.equal(isWebviewHostProcess("msedgewebview2.exe"), true);
  assert.equal(isWebviewHostProcess("electron"), true);
  // A real editor must keep every bit of its protection.
  assert.equal(isWebviewHostProcess("notepad"), false);
  assert.equal(isWebviewHostProcess("WINWORD"), false);
  assert.equal(isWebviewHostProcess(""), false);
});

// THE EVIDENCE THAT SEPARATES TYPED FROM SENT.
test("a reading says what an input holds, not just what it is called", () => {
  const table = [];
  const lines = renderElementsForTest([
    {
      role: "edit",
      text: "Type a message to Amma❤️",
      value: "jingalala ho",
      bounds: { x: 1900, y: 1600, width: 50, height: 50 },
      center: { x: 1925, y: 1628 },
      clickable: true
    }
  ], table);
  const line = lines.join("\n");
  assert.match(line, /holds "jingalala ho"/);
});

test("an empty box is visibly empty, so it is proof a message went", () => {
  const table = [];
  const lines = renderElementsForTest([
    {
      role: "edit",
      text: "Type a message to Amma❤️",
      value: "",
      bounds: { x: 1900, y: 1600, width: 50, height: 50 },
      center: { x: 1925, y: 1628 },
      clickable: true
    }
  ], table);
  assert.doesNotMatch(lines.join("\n"), /holds/);
});

// A button's "value" is noise; printing it would cost tokens on every row of
// every reading for the rest of the task.
test("only controls that hold typed text report a value", () => {
  const table = [];
  const lines = renderElementsForTest([
    {
      role: "button", text: "Send", value: "Send",
      bounds: { x: 10, y: 10, width: 20, height: 20 }, center: { x: 20, y: 20 }, clickable: true
    }
  ], table);
  assert.doesNotMatch(lines.join("\n"), /holds/);
});

test("a value identical to the label is not repeated", () => {
  const table = [];
  const lines = renderElementsForTest([
    {
      role: "edit", text: "Search", value: "Search",
      bounds: { x: 10, y: 10, width: 20, height: 20 }, center: { x: 20, y: 20 }, clickable: true
    }
  ], table);
  assert.doesNotMatch(lines.join("\n"), /holds/);
});

// ---- The working window must not slide back to the frame -------------------
//
// Measured live, 17 Aug 2026. `launch WhatsApp` hands back the frame (198130),
// `screen WhatsApp` redirects into the content window (197286) and reads the
// conversation — and then a later `focus` or `launch` writes the frame back into
// the working window. The next `screen the working window` reads the frame,
// finds the same two caption buttons it found before, and reports "IDENTICAL —
// nothing at all has changed on screen".
//
// The agent's own words for that were "the screen tool isn't returning the chat
// content": it read the TOOL as broken rather than the WINDOW as wrong, and
// burned five steps and about 30,000 tokens before reaching the content window
// again by accident.

const FRAME = "198130";
const CONTENT = "197286";

// A machine shaped like a WebView2 application: a frame window with nothing in
// it, and a sibling from a child process holding the whole interface.
function webviewMachine() {
  const readsOf = [];
  const caption = [
    { role: "button", text: "Minimize", clickable: true, bounds: { x: 1, y: 1, width: 10, height: 10 } },
    { role: "button", text: "Close", clickable: true, bounds: { x: 20, y: 1, width: 10, height: 10 } }
  ];
  // Enough of them to clear the redirect's own quality bar: a sibling window is
  // only accepted when its tree is genuinely better than the frame's, because a
  // wrong window that reads badly is worse than a right one that does.
  const conversation = [
    ...["Amma ❤️", "Rezoni", "Papa", "College group", "aa dekhen zara",
      "kabhi kushi kabhi gam", "chalo ek baar phir se", "picture abhi baaki hai"]
      .map((text, index) => ({
        role: "text", text, bounds: { x: 300, y: 200 + index * 30, width: 300, height: 20 }
      })),
    { role: "edit", text: "Type a message", clickable: true, bounds: { x: 300, y: 700, width: 500, height: 40 } }
  ];
  const adapter = {
    // The shape pickWebviewWindow actually reads: the content window belongs to
    // a DIFFERENT process that descends from the frame's, covers the frame, and
    // is Chromium-hosted. Nothing else identifies the pair.
    listWindows: async () => [
      {
        WindowHandle: Number(FRAME), ProcessName: "WhatsApp.Root", ProcessId: 1000,
        MainWindowTitle: "WhatsApp", Bounds: { x: 0, y: 0, width: 1200, height: 800 }
      },
      {
        WindowHandle: Number(CONTENT), ProcessName: "msedgewebview2", ProcessId: 2000,
        MainWindowTitle: "(136) WhatsApp", Bounds: { x: 0, y: 0, width: 1200, height: 800 }
      }
    ],
    listProcessParents: async () => new Map([[2000, 1000]]),
    getForegroundWindow: async () => ({ windowId: FRAME, processName: "WhatsApp.Root", title: "WhatsApp" }),
    inspectUi: async () => ({ windows: [{ ProcessName: "WhatsApp.Root" }], elements: [] }),
    captureScreen: async () => ({ captured: false }),
    focusedElement: async () => null,
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 })
  };
  const registry = {
    get: (name) => ({
      execute: async (inputs) => {
        if (name === "screen.read") {
          const windowId = String(inputs.windowId ?? "");
          readsOf.push(windowId || `application:${inputs.application}`);
          // Reading the frame publishes nothing an agent can use — that is the
          // whole shape of the bug.
          const content = windowId === CONTENT;
          return {
            read: true,
            windowId: content ? CONTENT : FRAME,
            application: content ? "msedgewebview2" : "WhatsApp.Root",
            title: content ? "(136) WhatsApp" : "WhatsApp",
            visibleText: "",
            elements: content ? conversation : caption
          };
        }
        if (name === "application.launch") {
          return { application: "WhatsApp", windowIdentity: { windowId: FRAME, title: "WhatsApp" } };
        }
        if (name === "window.activate") return { performed: true, foregroundWindowId: FRAME };
        return { performed: true };
      }
    })
  };
  return { toolset: buildToolset({ registry, adapter, basePath: "C:\\work" }), readsOf };
}

test("focusing a webview application still reads the window its interface is in", async () => {
  const { toolset, readsOf } = webviewMachine();
  // The redirect happens here, and costs a process-tree lookup once.
  const first = await toolset.execute("screen", { application: "WhatsApp" });
  assert.match(first.text, /picture abhi baaki hai/, "the redirect must find the conversation");

  // Focus is aimed at the FRAME, which is correct — input has to reach it.
  await toolset.execute("focus", { windowId: FRAME });

  readsOf.length = 0;
  const again = await toolset.execute("screen", {});
  assert.deepEqual(readsOf, [CONTENT], "the working window must still be the content window");
  // Headed with the content window, not the frame. Reading the frame here is
  // what produced "IDENTICAL — nothing at all has changed on screen" over a
  // conversation that was right there, and the agent blamed the tool for it.
  assert.match(again.text, new RegExp(`windowId ${CONTENT}`));
  assert.doesNotMatch(again.text, new RegExp(`windowId ${FRAME}`));
  assert.doesNotMatch(again.text, /Minimize/, "the frame's caption buttons are not the application");
});

test("launching an application again does not throw away the window that was found", async () => {
  const { toolset, readsOf } = webviewMachine();
  await toolset.execute("screen", { application: "WhatsApp" });
  await toolset.execute("launch", { application: "WhatsApp" });

  readsOf.length = 0;
  const again = await toolset.execute("screen", {});
  assert.deepEqual(readsOf, [CONTENT]);
  assert.match(again.text, new RegExp(`windowId ${CONTENT}`));
  assert.doesNotMatch(again.text, /Minimize/);
});
