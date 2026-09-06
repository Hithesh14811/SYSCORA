// A FINISHED TASK THAT NOBODY WAS TOLD ABOUT.
//
// The product's premise is that you ask for something and go and do something
// else — a run is 20-80 seconds of real work. Until now the finish was visible
// only to somebody already looking at the chat window, which is the one person
// who did not need telling.
//
// These are static source checks, in the same shape and for the same reason as
// desktop-chrome.test.js: the renderer, the preload and the main process are
// three files that have to agree about one IPC channel, and when they drift the
// control is simply dead. That is exactly how the one-click suggestions broke.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const main = read("apps/desktop-shell/src/main.js");
const preload = read("apps/desktop-shell/src/preload.js");
const renderer = read("apps/desktop/demo.js");
const manifest = JSON.parse(read("package.json"));

test("the three files agree about one channel name", () => {
  assert.match(main, /ipcMain\.handle\("syscora:notify"/, "the main process must handle the channel");
  assert.match(preload, /ipcRenderer\.invoke\("syscora:notify"/, "the preload must invoke the same channel");
  assert.match(renderer, /window\.syscora\?\.notify/, "the renderer must reach it through the bridge");
});

// WINDOWS FILES A TOAST UNDER AN APPLICATION USER MODEL ID.
//
// Without one, a notification is attributed to Electron's default id — it shows
// somebody else's name, or on a machine where that id was never registered it
// does not appear at all. The installed build and a `desktop:dev` build must
// claim the SAME id, or they notify as two different products.
test("the app id is set and matches the installer's", () => {
  const called = main.match(/app\.setAppUserModelId\("([^"]+)"\)/);
  assert.ok(called, "setAppUserModelId is what makes a Windows toast show SYSCORA's name");
  assert.equal(called[1], manifest.build.appId,
    "the running app and the installed app must be the same identity to Windows");
});

// THE RENDERER ASKS; THE MAIN PROCESS DECIDES.
//
// Every renderer permission is denied on purpose (`setPermissionRequestHandler`
// → false), notifications included, so a page cannot raise a Web Notification.
// This bridge must not become a way around that: the main process is what
// refuses when a toast is unwanted.
test("the toast is suppressed while the chat window is in front", () => {
  assert.match(main, /function chatIsInFront\(\)/);
  assert.match(main, /if \(chatIsInFront\(\)\) return false;/,
    "a toast repeating something already on screen is noise, and noise gets notifications turned off");
});

test("renderer permissions are still denied", () => {
  assert.match(main, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/,
    "the notification bridge must not have been paid for by weakening this");
});

// REPLAYING A CONVERSATION IS NOT A RUN FINISHING.
//
// `renderFinal` is called from four places: three live completions and one that
// redraws a stored session when the window is reopened. Notifying from that
// fourth one would raise a toast for work that finished yesterday, every time
// the chat is opened.
test("history replay does not notify", () => {
  const sites = [...renderer.matchAll(/renderFinal\(turn, (?:stored\.)?session\);?/g)];
  assert.ok(sites.length >= 4, `expected the four renderFinal call sites, found ${sites.length}`);
  const replay = renderer.match(/if \(stored\.session\) renderFinal\(turn, stored\.session\);\n(.*)/);
  assert.ok(replay, "the stored-session call site should still exist");
  assert.doesNotMatch(replay[1], /notifyRunFinished/,
    "re-opening a chat must not re-announce every run it contains");
});

test("every live completion notifies", () => {
  // Each live `renderFinal(turn, session)` is followed by the notify call.
  const live = [...renderer.matchAll(/renderFinal\(turn, session\);\n([^\n]*)\n?([^\n]*)/g)];
  assert.equal(live.length, 3, "three live completion paths: send, attach, resume");
  for (const [, next, after] of live) {
    assert.match(`${next}\n${after}`, /notifyRunFinished\(session\)/,
      "a completion path that does not notify is one the user is never told about");
  }
});

// THE HEADLINE IS THE STATUS, NEVER A CLAIM THIS FILE INVENTS.
//
// A toast saying "Done" over a run the transcript is about to draw as FAILED
// would be the same defect the evidence layer exists to prevent, arriving on a
// surface nothing audits. The title comes from a table keyed on the settled
// status and the body is the model's own closing sentence.
test("the title is derived from the settled status, and failure is not called done", () => {
  const table = renderer.match(/const NOTIFY_TITLE = \{([\s\S]*?)\};/);
  assert.ok(table, "the titles must be a table keyed on status, not a sentence built at the call site");
  assert.match(table[1], /FAILED: "Didn't work"/);
  assert.match(table[1], /PARTIALLY_COMPLETED: "Partly done"/);
  assert.match(table[1], /DECLINED: "Not done — you declined it"/);
  assert.doesNotMatch(table[1], /FAILED: "Done"/);
});

test("a run with nothing to say raises no toast", () => {
  assert.match(renderer, /if \(!body\) return;/,
    "an empty body would show a title with a blank line under it");
});

// A toast is a nicety. Failing a finished run because Windows would not show one
// would be trading the product for the ornament.
test("the notification can never fail the run", () => {
  const fn = renderer.match(/function notifyRunFinished\(session\) \{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /try \{[\s\S]*\} catch \{/, "the call must be guarded");
  assert.match(main, /\} catch \{[\s\S]*?return false;/, "and so must the main-process side");
});
