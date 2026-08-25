// THE COMPOSER GROWS WITH THE TEXT, AND THE REASON IT DID NOT IS PINNED HERE.
//
// The bug was invisible in either file on its own, which is why it survived
// several passes over both of them. demo.js had computed the right height since
// the composer was written, and set it inline. demo.css gave `#chatInput`
// `flex: 1` back when `.chat-bar` was a flex ROW and the textarea sat beside the
// send button; a later pass turned the composer into a COLUMN and left the item
// alone. `flex: 1` means `flex-basis: 0%`, and on a flex item the basis replaces
// `height` for main-axis sizing — which had just become the vertical one. So the
// height was computed, applied, and discarded by layout.
//
// Measured in the running app before the fix: inline `height: 160px`, computed
// `41.25px`. You typed a paragraph and the box stayed one line tall while your
// own words scrolled up out of sight above the caret.
//
// These are static source checks, in the shape desktop-chrome.test.js uses and
// for the same reason: the two files are edited independently and nothing else
// in the suite renders this stylesheet.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const css = read("apps/desktop/demo.css");
const js = read("apps/desktop/demo.js");

// Every `#chatInput { … }` block in the file, in source order. The stylesheet is
// a stack of passes and the same selector is written many times, so what matters
// is not that a good declaration exists somewhere — it is which one is LAST.
function chatInputBlocks() {
  return [...css.matchAll(/#chatInput\s*\{([^}]*)\}/g)].map((match) => match[1]);
}

function lastDeclaration(property) {
  let found = null;
  for (const block of chatInputBlocks()) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(block);
    if (match) found = match[1].trim();
  }
  return found;
}

test("the composer's height is not overridden by a flex-basis", () => {
  const flex = lastDeclaration("flex");
  assert.ok(flex, "#chatInput sets no `flex` at all — it used to set `flex: 1`, which is what broke this");
  // `flex: 1` / `flex: 1 1 0` / any `flex-basis` of 0 all reintroduce the defect:
  // the basis wins over `height` on the main axis, and the main axis is vertical.
  assert.doesNotMatch(
    flex,
    /^1(\s|$)|^\d+\s+\d+\s+0(%|px)?$/,
    `#chatInput has \`flex: ${flex}\` — a zero flex-basis replaces the height demo.js sets, so the box cannot grow`
  );
  assert.match(flex, /\bauto\b/, `#chatInput needs an \`auto\` flex-basis so its height is honoured, not \`${flex}\``);
});

test("the growth has a ceiling, and the ceiling is only in the stylesheet", () => {
  const maxHeight = lastDeclaration("max-height");
  assert.ok(maxHeight, "#chatInput has no max-height — a pasted document would push the send button off screen");

  // ONE NUMBER, ONE PLACE. Both files used to carry the cap and they disagreed:
  // the stylesheet said 160px and demo.js said 160 as well, until one of them was
  // tuned. demo.js now sets the natural height and CSS clamps it.
  const grow = /function growComposer\(\)[\s\S]*?\n}/.exec(js)?.[0] ?? "";
  assert.ok(grow, "demo.js no longer has growComposer()");
  assert.match(grow, /scrollHeight/, "growComposer no longer measures the content");
  assert.doesNotMatch(
    grow,
    /Math\.min|Math\.max/,
    `growComposer clamps the height itself: ${grow.trim()} — the cap belongs in max-height, or the two drift apart`
  );
});

test("it grows on every way text arrives, and shrinks back when the box is emptied", () => {
  for (const [event, why] of [
    ["input", "typing"],
    ["paste", "a paste is what makes the box jump three lines at once"],
    ["resize", "narrowing the window rewraps the text, so it is a different number of lines"]
  ]) {
    assert.match(
      js,
      new RegExp(`addEventListener\\("${event}",\\s*(?:\\(\\)\\s*=>\\s*)?[^)]*growComposer`),
      `nothing regrows the composer on ${event} — ${why}`
    );
  }
  // Sending clears the value; if the height is not recomputed the empty box
  // stays as tall as the message that is no longer in it.
  const submit = /chatForm\.addEventListener\("submit"[\s\S]*?\n\}\);/.exec(js)?.[0] ?? "";
  assert.match(submit, /chatInput\.value = "";[\s\S]{0,240}growComposer\(\)/, "the composer is cleared but never resized back");
});

// THE STRIPE, THE BADGE AND THE WASH. A tool call was drawing one boolean five
// times — a coloured left stripe, a tinted icon in a framed badge, two capsules,
// a marker at the end of the row, and a gradient across the whole card when it
// failed. Anything that puts the stripe or the capsules back should have to
// argue with a test first.
test("a tool call is a log row, not a card with five status channels", () => {
  const pass = css.slice(css.indexOf("PASS 12"));
  assert.ok(pass.length > 0, "the last pass is gone — every rule below depends on being last");
  assert.match(pass, /\.step\.ok[^{]*\{[^}]*border-left-color:\s*transparent/,
    "the coloured left stripe is back on successful steps");
  assert.match(pass, /\.step-tool\s*\{[^}]*background:\s*transparent/,
    "the tool id is in a tinted capsule again");
  assert.match(pass, /\.step-arg\s*\{[^}]*background:\s*transparent/,
    "the argument is in a tinted capsule again");

  // The seam between two adjacent steps is cancelled against the turn's flex
  // `gap`, and gap is not a margin — an item can only pull back across it. If
  // the two numbers stop being the same number the block silently comes apart.
  assert.match(pass, /\.turn\s*\{[^}]*--turn-gap:/, "the turn's gap is no longer a named number");
  assert.match(pass, /\.step \+ \.step\s*\{[^}]*var\(--turn-gap\)/,
    "the step seam hard-codes the gap instead of reading it — they will drift");
});
