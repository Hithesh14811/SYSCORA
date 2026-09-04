// One number format, whatever machine this is running on.
//
// THE DEFECT, QUOTED FROM A REAL TRANSCRIPT, 1 Sep 2026:
//
//   "I stopped here: this request has cost 1,50,285 billed tokens, which is the
//    ceiling I run under (1,50,000)."
//
// That is lakh grouping, because this machine's locale is en-IN and
// `(150285).toLocaleString()` with no argument asks the HOST. The rest of the
// sentence is en-GB English. Nothing in the codebase chose that; it simply
// inherited whatever the machine was set to, which means the same build prints
// different text for different users and an eval that asserts on a rendered
// sentence can pass on one machine and fail on another.
//
// These tests are the guard, and the first one is the one that matters: it fails
// if any user-facing surface goes back to calling `toLocaleString()` bare.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DISPLAY_LOCALE, formatCount } from "../../packages/shared-types/src/format.js";
import { DISPLAY_LOCALE as RENDERER_LOCALE, formatCount as rendererFormatCount } from "../../apps/desktop/format.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every file that prints a number a person reads. Adding a surface means adding
// it here — the sweep below is over this list, not over the whole tree, because
// a probe script formatting a number for a developer is nobody's problem.
const USER_FACING = [
  "packages/fast-agent/src/index.js",
  "packages/fast-agent/src/tools.js",
  "packages/reasoning-engine/src/index.js",
  "apps/desktop/demo.js",
  "apps/desktop/attachments.js",
  "apps/desktop/file-card.js"
];

test("no user-facing surface asks the machine what a number looks like", async () => {
  const offenders = [];
  for (const relative of USER_FACING) {
    const source = await fs.readFile(path.join(repoRoot, relative), "utf8");
    source.split(/\r?\n/).forEach((line, index) => {
      // A bare call — no locale argument at all. `toLocaleString(DISPLAY_LOCALE)`
      // and `toLocaleString("en-GB", …)` both pass.
      if (/\.toLocaleString\(\s*\)/.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    "these print a number in whatever grouping the machine happens to use:\n" + offenders.join("\n")
  );
});

test("the two halves of the formatter agree", () => {
  // They are duplicated on purpose — the daemon serves static files only from
  // the desktop directory — so the thing to pin is that they never drift.
  assert.equal(DISPLAY_LOCALE, RENDERER_LOCALE);
  for (const value of [0, 7, 1000, 150285, 1234567]) {
    assert.equal(formatCount(value), rendererFormatCount(value));
  }
});

test("a token count is grouped in thousands, not lakhs", () => {
  assert.equal(formatCount(150285), "150,285");
  assert.equal(formatCount(150000), "150,000");
  assert.equal(formatCount(1234567), "1,234,567");
  // The exact string from the transcript that started this.
  assert.notEqual(formatCount(150285), "1,50,285");
});

test("the format does not follow the machine", () => {
  // The real check: whatever this host is set to, the answer is the same. On an
  // en-IN machine `toLocaleString()` returns "1,50,285" here and the assertion
  // above would fail without the named locale.
  const hostFormatted = (150285).toLocaleString();
  assert.equal(formatCount(150285), (150285).toLocaleString("en-GB"));
  if (hostFormatted !== "150,285") {
    assert.notEqual(formatCount(150285), hostFormatted, "the formatter must not inherit the host locale");
  }
});

test("something that is not a number is passed through rather than mangled", () => {
  // `Number("")` is 0, and printing "0" where a caller passed nothing is the
  // kind of confidently wrong number this whole file exists to prevent.
  assert.equal(formatCount("not a number"), "not a number");
  assert.equal(formatCount(undefined), "undefined");
  assert.equal(formatCount(Number.POSITIVE_INFINITY), "Infinity");
});
