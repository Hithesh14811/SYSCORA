// PUTTING IT BACK, AND SAYING SO ONLY WHEN THE MACHINE AGREES.
//
// The motivating defect, verbatim: a session set this user's system volume to
// 42% and could not restore it, because nothing had recorded what it was before.
// So the first case here is exactly that — move the volume, undo, and require
// the endpoint to report the ORIGINAL level.
//
// The second thing these tests are for is the shape of the answer. "I put it
// back", "I tried and could not" and "this was never reversible" are three
// different sentences, and a tool that collapses them into two is lying in one
// of the three cases.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";

// An audio endpoint that remembers. `set` and `inspect` are separate functions
// on purpose: the tool must confirm through the getter, never through the
// setter's own report of itself, and one test below makes the setter lie to
// prove that is really what happens.
function endpoint({ startAt = 42, startMuted = false, readable = true } = {}) {
  const device = { percent: startAt, muted: startMuted };
  const seen = [];
  // Flipped by the test AFTER the first change, so the volume really does move
  // and then really does refuse to move back. Setting it false from the start
  // would mean the level never left where it began, and "restored" would be
  // true by accident — which is a different test that proves nothing.
  const control = { honest: true };
  return {
    device,
    seen,
    control,
    registry: {
      get: (name) => ({
        "system.volume.inspect": {
          execute: async () => (readable
            ? { available: true, percent: device.percent, muted: device.muted, peak: 0 }
            : { available: false })
        },
        "system.volume.set": {
          execute: async (inputs) => {
            seen.push(inputs);
            if (control.honest) {
              device.percent = Number(inputs.percent);
              if (inputs.mute != null) device.muted = Boolean(inputs.mute);
            }
            // Reports success either way. A dishonest endpoint is the whole
            // point of verifying through a different call.
            return { requestedPercent: Number(inputs.percent), percent: Number(inputs.percent), muted: Boolean(inputs.mute ?? device.muted), peak: 0, applied: true };
          }
        }
      }[name] ?? null)
    }
  };
}

const adapter = {
  executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  listWindows: async () => [],
  listProcessParents: async () => new Map(),
  inspectUi: async () => ({ elements: [] }),
  captureScreen: async () => ({ captured: false }),
  readOcr: async () => ({ text: "" }),
  getDocumentsPath: () => "C:\\Docs",
  getDesktopPath: () => "C:\\Desktop",
  getDownloadsPath: () => "C:\\Downloads"
};

const toolsetOver = (registry) => buildToolset({ registry, adapter, basePath: "C:\\work" });

test("the volume goes back to what it was, confirmed by reading the endpoint", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  assert.equal(audio.device.percent, 20, "precondition: the volume actually moved");

  const undone = await toolset.execute("undo", {});
  assert.equal(audio.device.percent, 42,
    "this is the defect that motivated the whole feature — 42% was where the user had it");
  assert.match(undone.text, /Put back/);
  assert.equal(undone.raw.outcome, "REVERSED");
  assert.equal(undone.raw.evidence.verdict, "CONFIRMED");
});

// THE CHECK THAT WOULD FAIL IF `undo` GRADED ITS OWN HOMEWORK.
//
// The setter returns `applied: true` and the device never moves. Every reversal
// in this system has to survive that, because "applied" reporting on itself is
// the exact claim this codebase has caught over and over.
test("a setter that claims success while the endpoint does not move is not a reversal", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  assert.equal(audio.device.percent, 20, "precondition: it really did move away from 42");
  // From here the endpoint accepts every request and changes nothing.
  audio.control.honest = false;

  const undone = await toolset.execute("undo", {});
  assert.equal(audio.device.percent, 20, "precondition: it really did not go back");

  assert.equal(undone.raw.outcome, "COULD_NOT");
  assert.equal(undone.raw.evidence.verdict, "REFUTED");
  assert.doesNotMatch(undone.text, /Put back/,
    "the endpoint never went back to 42, so no sentence may say it did");
  assert.match(undone.text, /could not put that back/i);
});

test("an action recorded as irreversible says why, and does not claim to have tried", async () => {
  // The endpoint cannot be read, so there is no previous level to return to.
  // The journal records that at the time rather than inventing a target.
  const audio = endpoint({ readable: false });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  const before = audio.seen.length;
  const undone = await toolset.execute("undo", {});

  assert.equal(undone.raw.outcome, "NEVER_REVERSIBLE");
  assert.match(undone.text, /cannot be undone/);
  assert.match(undone.text, /could not be read before the change/);
  assert.equal(audio.seen.length, before,
    "there was nothing to go back to, so it must not have set anything and then reported on it");
});

test("with nothing on the record it says so, rather than reporting a reversal", async () => {
  const toolset = toolsetOver(endpoint().registry);
  const undone = await toolset.execute("undo", {});
  assert.ok(undone.raw.nothingToUndo);
  assert.match(undone.text, /nothing on this session's record/);
});

test("undoing twice does not put the same change back twice", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  await toolset.execute("undo", {});
  const settings = audio.seen.length;
  const again = await toolset.execute("undo", {});

  assert.ok(again.raw.nothingToUndo,
    "the entry was closed as reversed; offering it again would re-apply a level that is already current");
  assert.equal(audio.seen.length, settings, "and it must not touch the endpoint to find that out");
});

test("the most recent change is the one put back", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  await toolset.execute("volume", { percent: 70 });
  await toolset.execute("undo", {});

  assert.equal(audio.device.percent, 20,
    "undo reverses the last step, not the whole session — 20% was the state before the last change");
});
