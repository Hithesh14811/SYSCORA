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
import { renderElementsForTest } from "../../packages/fast-agent/src/tools.js";

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
