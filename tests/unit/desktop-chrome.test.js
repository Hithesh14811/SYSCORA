// THE FRAME AROUND THE CONVERSATION, PINNED.
//
// Three things about the window said "unfinished" louder than anything inside
// it: Electron's own `File Edit View Window Help` menu bar, Electron's atom for
// an icon in the title bar, the taskbar and the installer, and a developer
// checkbox in the chrome of a product for people who do not read JSON.
//
// These are static source checks, in the same shape and for the same reason as
// desktop-suggestions.test.js: the ids in demo.html and the ids demo.js looks up
// are two lists that can drift apart silently, and when they do the control is
// simply dead — which is exactly how the one-click suggestions broke.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
// LINE ENDINGS NORMALISED, BECAUSE THESE CHECKS ARE ABOUT CONTENT. The repo is
// checked out with autocrlf, and demo.css is a MIX — the older passes came back
// from git as CRLF and the newest was appended as LF. A `\n}` in a pattern here
// therefore matched or missed depending on which pass the rule happened to be
// written in, which is a test that fails for a reason having nothing to do with
// the thing it is testing. Found exactly that way: the print-stylesheet check
// reported "the print sheet does not hide the sidebar" about a rule that hides
// the sidebar.
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const html = read("apps/desktop/demo.html");
const js = read("apps/desktop/demo.js");
const shell = read("apps/desktop-shell/src/main.js");
const css = read("apps/desktop/demo.css");

test("every control the client looks up exists in the markup", () => {
  for (const id of ["moreButton", "moreMenu", "healthPill", "healthDot", "healthLabel", "debugToggle"]) {
    assert.match(html, new RegExp(`id="${id}"`), `demo.html has no #${id}`);
    assert.match(js, new RegExp(`getElementById\\("${id}"\\)`), `demo.js never looks up #${id}`);
  }
});

// THE RAIL WAS REDRAWN FROM A REFERENCE, AND A REFERENCE IS A PICTURE.
//
// The design it was taken from has seven navigation rows — Images, Library,
// Plugins, Projects, Codex — and SYSCORA has an equivalent of none of them.
// Copying the picture would have put five rows in the chrome that go nowhere,
// which is precisely the defect desktop-suggestions.test.js exists for: the
// one-click suggestions were dead for weeks because the markup and the handlers
// were two lists nobody checked against each other. So: every row in the rail
// is looked up and wired, and the ones that were there before still are.
test("every row in the sidebar goes somewhere", () => {
  for (const id of ["panelNewChat", "chatsClose", "chatSearch", "chatList", "chatsSearchToggle", "chatsSearchItem", "sideStatus"]) {
    assert.match(html, new RegExp(`id="${id}"`), `demo.html has no #${id}`);
  }
  for (const id of ["chatsSearchToggle", "chatsSearchItem"]) {
    assert.match(
      js,
      new RegExp(`getElementById\\("${id}"\\)\\?\\.addEventListener`),
      `#${id} is in the markup and nothing listens to it — it is a dead row`
    );
  }
});

// A HIDDEN CONTROL THAT IS STILL FILTERING IS A LIST THAT HAS SILENTLY LOST
// ROWS. The search field folds away now, and if closing it left `chatFilter`
// set, chats would be missing from the rail for a reason with nothing on screen
// to explain it — the same shape as a check with an empty needle.
test("folding the search away clears what it was filtering by", () => {
  const fn = /function openChatSearch\([\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.ok(fn, "demo.js no longer has openChatSearch()");
  assert.match(fn, /chatSearch\.value = ""/, "closing the field leaves the text in it");
  assert.match(fn, /chatFilter = ""/, "closing the field leaves the filter applied");
  assert.match(fn, /renderChatList\(\)/, "the list is never redrawn, so the filtered rows stay gone");
});

// TWO PLACES READING ONE DAEMON IS HOW ONE OF THEM SAYS "Ready" WHILE THE OTHER
// SAYS "Not connected". The footer must be written by the same function that
// writes the pill, not by a poll of its own.
test("the sidebar footer status comes from the one health verdict", () => {
  const setter = /function setDaemonReachable[\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.match(setter, /sideStatus/, "the footer status is not written by setDaemonReachable");
  assert.doesNotMatch(
    js.replace(setter, ""),
    /sideStatus[\s\S]{0,80}api\/health/,
    "something outside setDaemonReachable is polling health for the footer"
  );
});

// The old marble had two layers and read as a spinner in a costume. The core has
// to move independently of the film, and two pseudo-elements cannot do that —
// so the layers are real children, created here. If they stop being created the
// stylesheet has nothing to animate and the indicator goes dark.
test("the working indicator has the four layers the stylesheet animates", () => {
  const start = /startWorking\(\)\s*\{[\s\S]*?\n {2}\}/.exec(js)?.[0] ?? "";
  assert.ok(start, "demo.js no longer has startWorking()");
  for (const layer of ["orb-film", "orb-core", "orb-core-2", "orb-gloss"]) {
    assert.match(start, new RegExp(`"${layer}"`), `startWorking no longer builds .${layer}`);
    assert.match(css, new RegExp(`\\.${layer}[\\s,]`), `demo.css has no rule for .${layer}`);
  }
  // Motion is opt-out, not opt-in: this thing is on screen for a minute at a time.
  const motion = /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?orb-film[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  assert.match(motion, /animation/, "the sphere animates outside a reduced-motion guard, or not at all");
});

// THE SPHERE MUST NOT START OVER BETWEEN STEPS.
//
// `keepWorkingLast()` used to re-append the working row after every step, and
// re-inserting a node restarts every CSS animation on it. Measured live: the
// core's animations read 15,367ms before the move and 0ms after it. On a run
// firing four tool calls in six seconds the sphere reset four times.
test("the working row is kept last by layout, not by being moved", () => {
  assert.ok(js.includes("keepWorkingLast()"), "demo.js no longer has keepWorkingLast()");
  // Anchored on the MOVE itself rather than on a slice of the function. The
  // first version of this check matched `keepWorkingLast()` and got the first
  // CALL SITE, several hundred lines above the definition, so it read a region
  // that never contained the defect and passed against the bug reinstated.
  // There is exactly one way to move that row, and this is it.
  assert.ok(
    !/appendChild\(\s*this\.working\.wrap\s*\)/.test(js),
    "the working row is being re-appended again — re-inserting a node restarts every animation on it"
  );
  // …and something has to actually put it last, or it renders above the steps.
  assert.match(css, /\.working\s*\{[^}]*order:\s*99/, "nothing orders the working row last");
});

// THE SPHERE STAYS WHEN THE RUN ENDS.
//
// It used to be removed the instant a run settled, so the one object that had
// been on screen for the whole turn vanished at the exact moment the answer
// arrived — the transcript twitched and nothing was left to say it had run.
test("a finished run leaves its sphere behind, stopped", () => {
  const stop = /stop: \(\) => \{[\s\S]*?\n {6}\}/.exec(js)?.[0] ?? "";
  assert.ok(stop, "the working indicator has no stop()");
  assert.doesNotMatch(stop, /wrap\.remove\(\)/, "stop() still deletes the row instead of freezing it");
  assert.match(stop, /classList\.add\("done"\)/, "nothing marks the row as finished");
  // "Working…" beside a finished answer is the small lie that reads as a stuck
  // interface; the elapsed time is a fact and stays.
  assert.match(stop, /label\.remove\(\)/, "the row keeps saying it is working after it has stopped");

  // `paused`, not `animation: none`. Clearing the animation would snap every
  // layer back to its starting pose at the instant the answer appeared, which
  // is the same twitch by another route.
  const pass = css.slice(css.indexOf("PASS 16"));
  assert.match(pass, /\.working\.done[\s\S]{0,200}animation-play-state:\s*paused/,
    "the finished sphere is not frozen — it either keeps turning or snaps to frame one");
});

// A MENU YOU CAN SEE AND CANNOT PRESS.
//
// Four siblings shared `z-index: 1`, so document order decided and `.demo-layout`
// painted over the whole of `.demo-topbar`. The ⋯ menu's own `z-index: 40` was
// compared only with ITS siblings inside a context that was already underneath,
// so every click went through the menu to the transcript. Verified by hit test —
// elementFromPoint at a menu item's centre returned `.feed`, not the item.
test("the corner menu is above the conversation, not inside a buried layer", () => {
  const pass = css.slice(css.indexOf("PASS 15"));
  assert.ok(pass, "PASS 15 is gone");
  const topbar = /\.demo-topbar\s*\{[^}]*z-index:\s*(\d+)/.exec(pass);
  assert.ok(topbar, "nothing in PASS 15 lifts the top bar out of the shared layer");
  assert.ok(Number(topbar[1]) > 1, `the top bar is still at z-index ${topbar[1]} — the menu will be unclickable`);
});

// The shell grid was written when the top bar spanned the window. Left as it
// was, the rail starts one whole row down and there is a band of empty chrome
// above it.
test("the rail runs the full height of the window", () => {
  const pass = css.slice(css.indexOf("PASS 15"));
  assert.match(pass, /grid-template-areas:\s*"side topbar"\s*"side main"/,
    "the rail no longer spans both grid rows, so there is dead space above it");
});

// THE RAIL COLLAPSES, IT DOES NOT LEAVE.
//
// It used to have two states, "there" and "gone", and the button that brought it
// back lived in a strip above the conversation. That strip is now deleted, so if
// anything ever sets `chatsPanel.hidden = true` again the sidebar becomes
// unreachable and the only way back is clearing localStorage.
test("the sidebar can never be hidden outright", () => {
  const open = /function openChatsPanel\([\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.ok(open, "demo.js no longer has openChatsPanel()");
  assert.match(open, /chatsPanel\.hidden = false/, "openChatsPanel can still hide the rail — there is no control left to bring it back");
  assert.match(open, /rail-collapsed/, "nothing puts the rail into its collapsed state");
  assert.doesNotMatch(css.slice(css.indexOf("PASS 14")), /\.chats-panel\[hidden\]\s*\{[^}]*display:\s*none/,
    "a `[hidden]` rule still collapses the rail to nothing");

  // Choosing a chat used to close the panel, which was right when closing meant
  // "stop covering the conversation". Collapsing the whole rail every time you
  // open something from it is not the same thing.
  assert.match(js, /function dismissRailOverlay\(\)[\s\S]*?NARROW\(\)/,
    "the overlay dismissal no longer checks that it IS an overlay");
  for (const caller of ["switchToChat", "startNewChat"]) {
    const fn = new RegExp(`function ${caller}\\([\\s\\S]*?\\n}`).exec(js)?.[0] ?? "";
    assert.doesNotMatch(fn, /openChatsPanel\(false\)/, `${caller} collapses the whole rail on a wide window`);
  }
});

// FIVE VERBS, ONE DEFINITION, TWO MENUS. Two of them cannot be undone — `undo`
// covers files and messages and has never covered a chat — so the ⋯ in the
// window corner and the ⋯ on a row must be built by the same function. Written
// out twice is two places for them to stop agreeing about what Delete does.
test("the chat menu is defined once and used in both places", () => {
  const items = /function chatActionItems\([\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.ok(items, "demo.js no longer has chatActionItems()");
  for (const label of ["Download chat as PDF", "Pin chat", "Archive", "Report a problem", "Delete"]) {
    assert.ok(items.includes(label), `chatActionItems no longer offers "${label}"`);
  }
  // Both consumers must call it rather than build their own rows.
  assert.match(/function openMoreMenu\([\s\S]*?\n}/.exec(js)?.[0] ?? "", /chatActionItems\(activeChatId\)/,
    "the corner menu no longer builds its rows from chatActionItems");
  assert.match(/function openChatMenu\([\s\S]*?\n}/.exec(js)?.[0] ?? "", /chatActionItems\(id\)/,
    "the row menu no longer builds its rows from chatActionItems");
  // Rebuilt per open, because the labels read the chat's own state.
  assert.match(js, /if \(open && actions\)[\s\S]{0,200}chatActionItems/,
    "the corner menu is filled once, so it will say Pin on something already pinned");
});

// ARCHIVED IS FILED, NOT GONE. If it stopped being rendered the chat would still
// exist in storage with no way to reach it — worse than deleting it, because the
// user would believe it was deleted.
test("archiving files a chat rather than losing it", () => {
  const render = /function renderChatList\(\)[\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.match(render, /"Archived"/, "archived chats have no heading, so they are simply missing from the rail");
  assert.match(render, /chat\.pinned \? 0 : chat\.archived \? 2 : 1/, "the pinned/archived banding is gone");
  // Sorted at render time on a copy — `chats` order belongs to touchActiveChat.
  assert.match(render, /listed = \[\.\.\.listed\]\.sort/, "renderChatList reorders the shared array instead of a copy");
});

// A PDF OF THE WRONG CONVERSATION IS THE QUIET WRONG ANSWER THIS PRODUCT EXISTS
// NOT TO GIVE. print() prints the document, so the chat has to be on screen
// first; ordering these the other way round hands you someone else's transcript.
test("printing a chat opens it first", () => {
  const fn = /function downloadChatPdf\([\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.ok(fn, "demo.js no longer has downloadChatPdf()");
  const switchAt = fn.indexOf("switchToChat");
  const printAt = fn.indexOf("window.print()");
  assert.ok(switchAt !== -1 && printAt !== -1, "downloadChatPdf no longer switches and prints");
  assert.ok(switchAt < printAt, "it prints before switching, so a row that is not open prints the wrong chat");
  // And the print stylesheet has to strip the chrome, or the PDF is a screenshot
  // of the application rather than a transcript.
  const print = /@media print \{[\s\S]*?\n\}\n/.exec(css)?.[0] ?? "";
  assert.match(print, /\.chats-panel/, "the print sheet does not hide the sidebar");
  assert.match(print, /\.chat-bar/, "the print sheet does not hide the composer");
  assert.match(print, /\.step > \.step-output/, "collapsed tool output prints as one line — the evidence is the reason to keep the paper");
});

// A switch that shows raw session JSON belongs behind a menu, not in the header.
// It has to stay REACHABLE, though — moving a control and losing it are the same
// thing to the person looking for it.
test("developer mode is inside the menu, and the menu can be opened", () => {
  const menu = /<div id="moreMenu"[\s\S]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
  assert.match(menu, /id="debugToggle"/, "developer mode is no longer inside the ⋯ menu");
  assert.match(js, /moreButton\?\.addEventListener\("click"/, "nothing opens the menu");
  assert.match(js, /openMoreMenu\(false\)/, "nothing closes the menu");
});

// A STATUS NOBODY CAN SEE UNTIL THEY OPEN A MENU IS NOT A STATUS. The reading
// moved into the menu; the failure has to stay outside it.
test("an unreachable daemon is reported outside the menu", () => {
  assert.match(html, /id="healthPill"[^>]*hidden/, "the pill must start hidden — it is silent while things work");
  const setter = /function setDaemonReachable[\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.match(setter, /healthPill/, "the pill is never updated, so a dead daemon shows nothing");
  assert.match(setter, /hidden = reachable !== false/, "the pill must appear exactly when the daemon is known to be down");
});

test("the window has no Electron menu bar, and keeps the shortcuts it carried", () => {
  assert.match(shell, /Menu\.setApplicationMenu\(null\)/, "the default File/Edit/View menu bar is back");
  // Removing the menu removes its accelerators with it. Losing reload while
  // developing is a bad trade for a tidy window.
  assert.match(shell, /before-input-event/, "no key handling replaced the menu's accelerators");
  assert.match(shell, /webContents\.reload\(\)/, "Ctrl+R no longer reloads");
  assert.match(shell, /toggleDevTools\(\)/, "F12 no longer opens developer tools");
});

// A LINK IN AN ANSWER MUST LEAVE THIS WINDOW, AND THIS WINDOW MUST STAY.
//
// The agent answers research questions with URLs and the renderer makes them
// real links, and nothing in the shell had ever been told what to do with one.
// Both Electron defaults are wrong: `target="_blank"` opens a window that
// INHERITS this one's webPreferences — including the preload that hands the page
// the daemon's API token — and a plain click navigates this window, replacing
// the conversation with a web page on a window that has no back button.
test("a link in an answer opens in the real browser, not in the application", () => {
  assert.match(shell, /setWindowOpenHandler/, "target=_blank is unhandled — a stranger's page would inherit the preload and its API token");
  assert.match(shell, /action:\s*"deny"/, "the window-open handler must refuse to open a window at all");
  assert.match(shell, /shell\.openExternal/, "nothing hands the URL to the user's own browser");
  assert.match(shell, /will-navigate/, "a same-window navigation still replaces the chat surface");

  // Only http(s). A `file:` or `javascript:` URL in an answer must not be
  // openable with one click from a window this trusted.
  const opener = /const openOutside[\s\S]*?\n {2}};/.exec(shell)?.[0] ?? "";
  assert.match(opener, /\^https\?:\\\/\\\//, `openExternal is not restricted to http(s): ${opener}`);
});

// The icon is generated by scripts/make-icon.mjs rather than checked in as a
// binary nobody can regenerate — so the thing to guard is that it is still THERE
// and still an icon, since electron-builder names it in three places.
test("the application ships a real icon, at every size Windows asks for", () => {
  const iconPath = path.join(repoRoot, "apps/desktop/icon.ico");
  assert.ok(fs.existsSync(iconPath), "apps/desktop/icon.ico is missing — run npm run icon");
  const ico = fs.readFileSync(iconPath);
  assert.equal(ico.readUInt16LE(0), 0, "not an ICO: reserved field");
  assert.equal(ico.readUInt16LE(2), 1, "not an ICO: type is not 1");
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 5, `only ${count} sizes — Windows picks different ones for the title bar, the taskbar and the installer`);
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(length > 0 && offset + length <= ico.length, `image ${index} points outside the file`);
    // PNG-compressed entries, which is what Windows has taken since Vista.
    assert.equal(ico.readUInt32BE(offset), 0x89504e47, `image ${index} is not a PNG`);
  }

  assert.match(shell, /icon: path\.join\(__dirname, "\.\.\/\.\.\/desktop\/icon\.ico"\)/, "the window does not use it");
  const packaging = JSON.parse(read("package.json"));
  assert.equal(packaging.build.win.icon, "apps/desktop/icon.ico", "the packaged application does not use it");
  assert.equal(packaging.build.nsis.installerIcon, "apps/desktop/icon.ico", "the installer does not use it");
});
