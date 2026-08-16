// UNCONFIRMED IS NOT FAILED, AND NEITHER OF THEM IS VERIFIED.
//
// Every gate in this codebase that collapsed "could not check" into "check
// failed" threw away correct work and blamed the model. A replayed step gets
// three states: the replayer stops on anything that is not VERIFIED, so an
// unconfirmed step costs a handover rather than a wrong claim.

import test from "node:test";
import assert from "node:assert/strict";

import { verifyReplayStep } from "../../packages/fast-agent/src/skill-verify.js";

const reading = (title, labels) => ({
  ok: true,
  text: [`Window: ${title}`, "", "Elements (index| role \"text\" @x,y):",
    ...labels.map((label, index) => `${index}| button "${label}" @10,${index * 20}`)].join("\n")
});

test("a click is proved by a reading, not by the click's own result", async () => {
  const calls = [];
  const execute = async (tool, args) => { calls.push(tool); return reading("Chintu — WhatsApp", ["Chintu", "Attach"]); };
  const result = await verifyReplayStep({ kind: "element-present", value: "Attach" }, { execute });
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(calls, ["screen"], "it re-reads rather than trusting what came back");
});

test("a label that is not there is a failure, not a shrug", async () => {
  const execute = async () => reading("WhatsApp", ["Amma", "Achu"]);
  const result = await verifyReplayStep({ kind: "element-present", value: "Chintu" }, { execute });
  assert.equal(result.status, "FAILED");
  assert.match(result.message, /nothing on screen is labelled "Chintu"/);
});

test("a screen that cannot be read is UNCONFIRMED, never FAILED", async () => {
  const execute = async () => ({ ok: false, text: "no window resolved" });
  const result = await verifyReplayStep({ kind: "element-present", value: "Chintu" }, { execute });
  assert.equal(result.status, "UNCONFIRMED");
});

test("the window title check reads the window the reading names", async () => {
  const execute = async () => reading("WhatsApp.Root — Chintu (windowId 1)", ["x"]);
  assert.equal((await verifyReplayStep({ kind: "window-title-contains", value: "Chintu" }, { execute })).status, "VERIFIED");
  assert.equal((await verifyReplayStep({ kind: "window-title-contains", value: "Amma" }, { execute })).status, "FAILED");
});

// SENDING IS NOT TYPING. This is the check that catches the failure this whole
// project was started over: a message reported sent that sat unsent in the box.
test("a message still sitting in the box is not sent", async () => {
  const execute = async () => reading("WhatsApp", ["av byavarsi"]);
  const result = await verifyReplayStep(
    { kind: "input-empty", value: "av byavarsi" },
    { execute, focusedValue: async () => "av byavarsi" }
  );
  assert.equal(result.status, "FAILED");
  assert.match(result.message, /still sitting in the box/);
});

// AND AN EMPTY BOX IS NOT PROOF IT WENT. This test used to assert the opposite,
// which is how the flagship run announced a message it had never sent: WhatsApp
// publishes value="\n" for a message box WITH NOTHING IN IT, the text had gone
// into the search field, and "the box is empty" was true and worthless.
test("an empty box is not proof it went — emptiness can only refute", async () => {
  const result = await verifyReplayStep(
    { kind: "input-empty", value: "av byavarsi" },
    { execute: async () => ({ ok: true, text: "" }), focusedValue: async () => "" }
  );
  assert.equal(result.status, "UNCONFIRMED");
  assert.match(result.message, /not evidence of a send/);
});

test("a check with nothing to look for is not a check", async () => {
  const empty = await verifyReplayStep(
    { kind: "input-empty" },
    { execute: async () => ({ ok: true, text: "" }), focusedValue: async () => "" }
  );
  assert.equal(empty.status, "UNCONFIRMED");
  const noNeedle = await verifyReplayStep(
    { kind: "message-in-conversation" },
    { execute: async () => reading("WhatsApp", ["anything"]) }
  );
  assert.equal(noNeedle.status, "UNCONFIRMED");
});

// THE PROOF THAT REPLACES IT: the words are in the conversation.
test("a message in the conversation is proof it went", async () => {
  const result = await verifyReplayStep(
    { kind: "message-in-conversation", value: "jingalala ho" },
    {
      execute: async () => ({
        ok: true,
        text: 'Window: WhatsApp\n0| text "jingalala ho" @1500,900\n1| text "9:52 pm" @1761,930\n' +
          '2| edit "Type a message to Amma" @1600,1400'
      })
    }
  );
  assert.equal(result.status, "VERIFIED");
  assert.match(result.message, /jingalala ho/);
});

// The distinction the whole product turns on: the same words, in the box.
test("the message showing ONLY in the input box is a failure, not a pass", async () => {
  const result = await verifyReplayStep(
    { kind: "message-in-conversation", value: "jingalala ho" },
    {
      execute: async () => ({
        ok: true,
        text: 'Window: WhatsApp\n0| edit "Type a message to Amma" holds "jingalala ho" @1600,1400'
      })
    }
  );
  assert.equal(result.status, "FAILED");
  assert.match(result.message, /ONLY in the input box/);
});

test("an application that will not say what it holds is UNCONFIRMED", async () => {
  const result = await verifyReplayStep(
    { kind: "input-empty", value: "hi" },
    { execute: async () => ({ ok: true, text: "" }), focusedValue: async () => null }
  );
  assert.equal(result.status, "UNCONFIRMED", "null means could not check, not empty");
});

test("a command is checked against the result it already produced", async () => {
  const calls = [];
  const execute = async (tool) => { calls.push(tool); return { ok: true, text: "ran again" }; };
  const result = await verifyReplayStep(
    { kind: "command-output-contains", value: "Python 3" },
    { execute, lastResult: { text: "Python 3.12.1" } }
  );
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(calls, [], "running it a second time to check it ran is how something installs twice");
});

// AN EMPTY NEEDLE MATCHES EVERYTHING. The first route ever replayed against
// this machine carried `command-output-contains` with no value, wrote its file
// to a corrupted path, and reported the step VERIFIED. Only the eval's own
// Test-Path noticed the file was not there.
test("a check with nothing to look for cannot pass", async () => {
  const result = await verifyReplayStep(
    { kind: "command-output-contains" },
    { execute: async () => ({ ok: true, text: "" }), lastResult: { text: "some unrelated output" } }
  );
  assert.equal(result.status, "UNCONFIRMED");
});

// A skill file is editable by the user, so it can name anything. Treating an
// unknown check as a pass would be the false success this exists to prevent.
test("a check nobody knows how to make is not a pass", async () => {
  const result = await verifyReplayStep({ kind: "vibes" }, { execute: async () => ({ ok: true, text: "" }) });
  assert.equal(result.status, "UNCONFIRMED");
});

test("a step with no check at all still passes, because none was asked for", async () => {
  assert.equal((await verifyReplayStep(null, {})).status, "VERIFIED");
});
