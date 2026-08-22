// The daemon had no crash path at all. These pin the one it has now.
//
// The test that matters most is "a crash guard that does not exit is worse than
// none". From Node 15 an unhandled rejection already terminates the process, so
// installing a handler REPLACES that behaviour — a handler that logs and
// returns does not harden the daemon, it removes the only protection it had and
// lets it carry on holding a machine it has half-changed. That is a very easy
// thing to write by accident and impossible to notice in production, so it is
// asserted directly.
//
// Everything is injected — exit, fs, the host close, even `process.on` — so
// none of this can terminate the test runner or touch the real state directory.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
// Keys are built with path.join for the same reason the code does: on Windows
// these are backslash paths, and a test that hardcodes forward slashes passes
// against a fake filesystem and proves nothing about the real one.
import {
  CRASH_RECORD, describeCrash, describeInterruptedRun, installCrashGuards, reportInterruptedRun
} from "../../apps/daemon/src/crash-guard.js";

// A filesystem that lives in a Map, so these tests never write anywhere.
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (target) => files.has(target),
    readFileSync: (target) => {
      if (!files.has(target)) throw new Error(`ENOENT: ${target}`);
      return files.get(target);
    },
    writeFileSync: (target, contents) => files.set(target, contents),
    mkdirSync: () => {},
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    }
  };
}

function install({ runtime = null, fs = fakeFs(), throwOnClose = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const exits = [];
  installCrashGuards({
    runtime,
    stateDir: "/state",
    fs,
    log: () => calls.push("log"),
    closeHost: () => {
      calls.push("closeHost");
      if (throwOnClose) throw new Error("the host was already gone");
      return true;
    },
    exit: (code) => { calls.push("exit"); exits.push(code); },
    on: (event, handler) => handlers.set(event, handler)
  });
  return { handlers, calls, exits, fs };
}

test("a crash guard that does not exit is worse than none", () => {
  const { handlers, exits } = install();
  handlers.get("unhandledRejection")(new Error("a promise nobody caught"));
  assert.deepEqual(exits, [1],
    "an unhandled rejection already kills the process in modern Node; a handler that does not exit " +
    "REMOVES that protection and leaves the daemon running over a half-changed machine");
});

test("both fatal events are guarded, not just the obvious one", () => {
  const { handlers } = install();
  assert.ok(handlers.has("uncaughtException"));
  assert.ok(handlers.has("unhandledRejection"));
});

test("the automation host is stopped, or the crash leaks one", () => {
  const { handlers, calls } = install();
  handlers.get("uncaughtException")(new Error("boom"));
  assert.ok(calls.includes("closeHost"),
    "15 orphaned PowerShell hosts holding 801 MB were found from exactly this shape of exit");
  assert.ok(calls.indexOf("closeHost") < calls.indexOf("exit"), "the host must be stopped before the process goes");
});

test("what had already been done to the machine is written down", () => {
  const runtime = {
    interruptedWork: () => [
      { at: 1, tool: "write_file", summary: "overwrote notes.txt", reversible: true, why: null, finished: true },
      { at: 2, tool: "send_message", summary: "sent 'hello' to Amma", reversible: false, why: "it cannot be unsent", finished: true }
    ]
  };
  const { handlers, fs } = install({ runtime });
  handlers.get("uncaughtException")(new Error("boom"));

  const written = JSON.parse(fs.files.get(path.join("/state", CRASH_RECORD)));
  assert.equal(written.actions.length, 2);
  assert.equal(written.actions[0].summary, "overwrote notes.txt");
  assert.equal(written.actions[1].reversible, false);
  assert.equal(written.reason, "uncaughtException");
});

test("a crash while handling a crash does not loop", () => {
  const { handlers, exits } = install({ throwOnClose: true });
  const fatal = handlers.get("uncaughtException");
  fatal(new Error("first"));
  fatal(new Error("second, thrown by the handler for the first"));
  assert.deepEqual(exits, [1], "re-entering the handler turns one crash into a loop and buries the original error");
});

test("a runtime that throws when asked what it did still gets the process stopped", () => {
  const runtime = { interruptedWork: () => { throw new Error("the toolset is in pieces"); } };
  const { handlers, exits } = install({ runtime });
  handlers.get("uncaughtException")(new Error("boom"));
  assert.deepEqual(exits, [1], "a crash handler that throws is a crash handler that hides the crash");
});

test("an unwritable state directory does not stop the shutdown", () => {
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error("EACCES"); };
  const { handlers, calls, exits } = install({ fs });
  handlers.get("uncaughtException")(new Error("boom"));
  assert.deepEqual(exits, [1]);
  assert.ok(calls.includes("closeHost"), "the host still has to be stopped when the record cannot be written");
});

// ---- what the next start says about it --------------------------------------

test("the next start reports the crash in sentences, then moves the record aside", () => {
  const record = describeCrash({
    reason: "unhandledRejection",
    error: new Error("connect ECONNREFUSED"),
    at: "2026-08-22T09:00:00.000Z",
    actions: [
      { at: 1, tool: "write_file", summary: "overwrote notes.txt", reversible: true, why: null, finished: true },
      { at: 2, tool: "run", summary: "stopped OneDrive", reversible: false, why: "the restart path is unknown", finished: false }
    ]
  });
  const fs = fakeFs({ [path.join("/state", CRASH_RECORD)]: JSON.stringify(record) });
  const said = [];
  const returned = reportInterruptedRun({ stateDir: "/state", fs, log: (line) => said.push(line) });

  assert.ok(returned, "the record should be returned so a surface can show it too");
  const text = said.join("\n");
  assert.match(text, /stopped unexpectedly/);
  assert.match(text, /overwrote notes\.txt/);
  assert.match(text, /cannot be undone: the restart path is unknown/);
  assert.match(text, /never reported back/, "PENDING is not 'nothing happened', it is 'we stopped knowing'");
  assert.ok(!fs.existsSync(path.join("/state", CRASH_RECORD)), "the record must be moved aside or it is reported forever");
  assert.equal([...fs.files.keys()].filter((name) => name.includes("interrupted-run-")).length, 1,
    "moved aside, not deleted — it is the only account of a run that changed the machine and vanished");
});

test("a clean previous run says nothing at all", () => {
  const said = [];
  const returned = reportInterruptedRun({ stateDir: "/state", fs: fakeFs(), log: (line) => said.push(line) });
  assert.equal(returned, null);
  assert.deepEqual(said, [], "a daemon that warns about a crash that did not happen teaches people to ignore it");
});

test("a crash record that cannot be parsed is still reported as a crash", () => {
  const said = [];
  reportInterruptedRun({
    stateDir: "/state",
    fs: fakeFs({ [path.join("/state", CRASH_RECORD)]: "{ this is not json" }),
    log: (line) => said.push(line)
  });
  assert.match(said.join("\n"), /could not be read/);
});

test("a crash with nothing done yet says so rather than implying damage", () => {
  const text = describeInterruptedRun(describeCrash({ reason: "uncaughtException", error: new Error("boom"), actions: [] }));
  assert.match(text, /had not changed anything on this machine/);
});

// ---- the crash record must not become a place secrets are kept --------------

test("a key quoted in a stack trace is redacted before the record is written", () => {
  const error = new Error("request failed: https://inference.example.com/v1?key=ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr");
  const record = describeCrash({ reason: "uncaughtException", error, actions: [] });
  assert.ok(
    !JSON.stringify(record).includes("ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr"),
    "the crash file is written into the state directory, which the user syncs"
  );
});
