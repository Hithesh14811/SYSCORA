// The persistence layer is on `node:sqlite`, which Node itself calls
// experimental and which landed in 22.5. Eight production modules use it —
// sessions, audit, memory, approval tokens, capability grants, elevation
// grants, secrets, semantic state — so if a Node upgrade moves it, they all
// fail at once, deep inside a constructor, with a stack trace that says nothing
// about Node versions.
//
// These pin that the check EXERCISES the API rather than inspecting it. A
// constructor that exists is not a constructor that works, and the breakages
// worth catching are exactly the ones a `typeof` waves through.

import test from "node:test";
import assert from "node:assert/strict";
import { MINIMUM_NODE, checkPersistenceSupport, reportPreflight } from "../../apps/daemon/src/preflight.js";

test("the real node:sqlite on this machine passes", () => {
  const result = checkPersistenceSupport();
  assert.equal(result.ok, true, result.reason);
  assert.match(result.reason, /works on Node/);
});

test("a missing module is reported with the version that would have it", () => {
  const result = checkPersistenceSupport({
    require: () => { throw new Error("Cannot find module 'node:sqlite'"); }
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be loaded/);
  assert.ok(result.reason.includes(MINIMUM_NODE), "the message has to name the version that has it");
});

test("a DatabaseSync that is not a constructor is caught", () => {
  const result = checkPersistenceSupport({ require: () => ({ DatabaseSync: { open: () => {} } }) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a constructor/);
});

test("a constructor that exists but throws is caught", () => {
  const result = checkPersistenceSupport({
    require: () => ({ DatabaseSync: function Broken() { throw new Error("unknown option ':memory:'"); } })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /write-then-read failed/);
});

// The one a typeof check would miss, and the one an API change is most likely to
// look like: everything present, everything callable, wrong answer.
test("an API that accepts every call and returns the wrong row is caught", () => {
  const result = checkPersistenceSupport({
    require: () => ({
      DatabaseSync: function Liar() {
        return {
          exec: () => {},
          prepare: () => ({ run: () => {}, get: () => ({ value: "something else entirely" }) }),
          close: () => {}
        };
      }
    })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /for a row that was just written/);
});

test("a failure says what to do about it, and a success says nothing", () => {
  const said = [];
  reportPreflight({ log: (line) => said.push(line), check: () => ({ ok: false, reason: "it is broken" }) });
  const text = said.join("\n");
  assert.match(text, /NOT WORKING ON THIS NODE VERSION/);
  assert.match(text, /just upgraded Node/, "the actual cause has to be named, not left to be guessed");

  const quiet = [];
  reportPreflight({ log: (line) => quiet.push(line), check: () => ({ ok: true, reason: "fine" }) });
  assert.deepEqual(quiet, [], "a warning printed on every healthy start is a warning nobody reads");
});
