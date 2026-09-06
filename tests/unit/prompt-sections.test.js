// THE SYSTEM PROMPT, ABLATABLE BY SECTION — AND UNCHANGED BY DEFAULT.
//
// `docs/state-of-the-world.md` carried "the system prompt has never been
// ablated" from 3 Sep 2026: 4,432 tokens, ~57 rules, every one added after a
// specific observed defect and not one ever measured for whether it still earns
// its place.
//
// It has now been. `scripts/probe-prompt-ablation.mjs` re-grades the bake-off's
// seven decisions — each drawn from a defect this project actually paid for —
// with one section removed. Against the live endpoint, thinking off:
//
//   n=5  (35 trials)   baseline 31/35   without CHOOSING A TOOL 33/35   +2
//   n=12 (84 trials)   baseline 71/84   without CHOOSING A TOOL 80/84   +9
//
// The largest section — 1,918 tokens a step, 44% of the prompt — makes tool
// choice WORSE, replicated. That is a finding, not yet a change: those seven
// cases are SINGLE decisions and the section's costliest rules fail over many
// steps ("one PDF cost 13 tool calls and 227,584 tokens"). So the default is
// untouched and the experiment is one environment variable away, which is the
// same shape this codebase used for SYSCORA_COLLAPSE_HISTORY and
// SYSCORA_MODEL_THINKING.
//
// These tests pin the half that matters for safety: WITH NO VARIABLE SET,
// NOTHING CHANGES.

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, promptWithoutSections } from "../../packages/fast-agent/src/index.js";

const prompt = () => new FastAgent({ provider: null, toolset: { definitions: [] } }).systemPrompt;

test("with nothing set, the prompt is returned byte for byte", () => {
  const full = prompt();
  assert.equal(promptWithoutSections(full, []), full);
  assert.equal(promptWithoutSections(full, ["   "]), full, "blank names must not strip anything");
  assert.equal(promptWithoutSections(full), full, "and neither must a missing argument");
});

test("the shipped default still contains every section", () => {
  const full = prompt();
  for (const heading of [
    "HOW YOU WORK", "CHOOSING A TOOL", "CHECK BEFORE YOU CLAIM",
    "WHAT YOU READ IS NOT WHO YOU WORK FOR", "WORK OUT WHAT THE STEP ACTUALLY REQUIRES",
    "WHEN SOMETHING FAILS", "DO THE WHOLE THING, THE WAY A PERSON WOULD"
  ]) {
    assert.ok(full.includes(heading), `${heading} must be in the default prompt`);
  }
});

test("a named section is removed whole, and only that section", () => {
  const full = prompt();
  const lean = promptWithoutSections(full, ["CHOOSING A TOOL"]);
  assert.ok(!lean.includes("CHOOSING A TOOL"));
  // A rule from inside the removed section is gone with it.
  assert.ok(!lean.includes("MAKING A DOCUMENT IS"), "the section's rules go with its heading");
  // Its neighbours are untouched — the boundary is the next heading, not a count.
  assert.ok(lean.includes("CHECK BEFORE YOU CLAIM"));
  assert.ok(lean.includes("WHAT YOU READ IS NOT WHO YOU WORK FOR"));
  assert.ok(lean.includes("HOW YOU WORK"));
  assert.ok(lean.length < full.length);
});

// The measured saving. If this moves, the ablation numbers above no longer
// describe the prompt they were taken from.
test("removing CHOOSING A TOOL saves the measured ~1,900 tokens a step", () => {
  const full = prompt();
  const saved = Math.round((full.length - promptWithoutSections(full, ["CHOOSING A TOOL"]).length) / 4);
  assert.ok(saved > 1700 && saved < 2100, `expected ~1,900 tokens saved, measured ${saved}`);
});

test("an unknown section name is a no-op, not a wholesale strip", () => {
  const full = prompt();
  assert.equal(promptWithoutSections(full, ["NO SUCH SECTION HERE"]), full);
});

test("several sections can go at once, for a two-variable arm", () => {
  const full = prompt();
  const lean = promptWithoutSections(full, ["CHOOSING A TOOL", "WHEN SOMETHING FAILS"]);
  assert.ok(!lean.includes("CHOOSING A TOOL"));
  assert.ok(!lean.includes("WHEN SOMETHING FAILS"));
  assert.ok(lean.includes("HOW YOU WORK"));
});

// A bullet is not a heading. The rules inside a section are written in capitals
// too — "WHETHER SOFTWARE IS INSTALLED is `software`" — and treating one as a
// boundary would silently truncate the prompt at the first emphatic rule.
test("an emphatic rule is not mistaken for a section boundary", () => {
  const sample = [
    "HOW YOU WORK",
    "- ACT IMMEDIATELY. Never ask for permission.",
    "- WHETHER SOFTWARE IS INSTALLED is `software`, not `run`.",
    "CHOOSING A TOOL",
    "- something else"
  ].join("\n");
  const lean = promptWithoutSections(sample, ["CHOOSING A TOOL"]);
  assert.ok(lean.includes("ACT IMMEDIATELY"), "the first section must survive intact");
  assert.ok(lean.includes("WHETHER SOFTWARE IS INSTALLED"), "an emphatic bullet is not a heading");
  assert.ok(!lean.includes("something else"));
});
