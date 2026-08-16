// A REPLAY MAY ONLY CONTINUE WHILE IT CAN PROVE IT IS ON TRACK.
//
// That is the entire safety argument for running somebody's machine without a
// model in the loop, and these tests are what hold it up: a step whose
// verification does not come back VERIFIED must stop, and what the model is
// handed afterwards must say which steps already happened — because a send that
// is redone is somebody's mother getting the message twice.

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeHandover,
  exampleToPattern,
  fillArguments,
  matchSkill,
  replaySkill
} from "../../packages/fast-agent/src/skill-replay.js";

const skill = {
  id: "whatsapp-send-message",
  title: "Send a WhatsApp message",
  match: { examples: ["send {contact} a message on whatsapp saying {text}", "whatsapp {contact}: {text}"] },
  preconditions: [
    { ensure: "app-running", application: "WhatsApp" },
    { ensure: "focused", application: "WhatsApp" }
  ],
  steps: [
    { tool: "click", args: { text: "{contact}", section: "Chats" }, verify: { kind: "window-title-contains", value: "{contact}" } },
    { tool: "type", args: { text: "{text}", submit: true }, irreversible: true, verify: { kind: "input-empty" } }
  ]
};

const recorder = (results = {}) => {
  const calls = [];
  return {
    calls,
    execute: async (tool, args) => {
      calls.push({ tool, args });
      return results[tool] ?? { ok: true, text: "done" };
    }
  };
};

test("a request is recognised and its values pulled out", () => {
  const match = matchSkill([skill], "send Chintu a message on whatsapp saying av byavarsi");
  assert.equal(match.skill.id, "whatsapp-send-message");
  assert.deepEqual(match.parameters, { contact: "Chintu", text: "av byavarsi" });
});

test("a sentence that only looks like the example is not a match", () => {
  // An empty capture would replay with a blank contact, which is how a message
  // goes to nobody and is reported as sent.
  assert.equal(matchSkill([skill], "whatsapp : hello"), null);
  assert.equal(matchSkill([skill], "what is the weather"), null);
});

test("a retired skill is never replayed", () => {
  const retired = { ...skill, stats: { retired: true } };
  assert.equal(matchSkill([retired], "whatsapp Chintu: hello"), null);
});

test("placeholders are filled everywhere in the arguments", () => {
  assert.deepEqual(
    fillArguments({ text: "{text}", nested: { to: "{contact}" }, list: ["{contact}"], keep: 5 },
      { contact: "Amma", text: "hi" }),
    { text: "hi", nested: { to: "Amma" }, list: ["Amma"], keep: 5 }
  );
});

test("an unknown placeholder is left alone rather than blanked", () => {
  assert.deepEqual(fillArguments({ text: "{unknown}" }, { contact: "x" }), { text: "{unknown}" });
});

test("a clean replay establishes preconditions, then every step in order", async () => {
  const { calls, execute } = recorder();
  const result = await replaySkill({
    skill, parameters: { contact: "Chintu", text: "av byavarsi" }, execute,
    verifyStep: async () => ({ status: "VERIFIED" })
  });
  assert.equal(result.replayed, true);
  assert.deepEqual(calls.map((call) => call.tool), ["launch", "focus", "click", "type"]);
  assert.deepEqual(calls[2].args, { text: "Chintu", section: "Chats" });
  assert.equal(calls[3].args.text, "av byavarsi");
});

test("a step whose verification fails stops the replay there", async () => {
  const { calls, execute } = recorder();
  const result = await replaySkill({
    skill, parameters: { contact: "Chintu", text: "hi" }, execute,
    verifyStep: async () => ({ status: "FAILED", message: "no element labelled \"Chintu\" under \"Chats\"" })
  });
  assert.equal(result.replayed, false);
  assert.equal(result.handover.failure.step, 1);
  assert.equal(calls.length, 3, "the second step must not run after the first could not be proved");
});

// UNCONFIRMED IS NOT FAILED — but it is not proof either, and the fast path may
// only continue on proof. It hands over, and it says which of the two it was.
test("a verification that could not check hands over, and says so", async () => {
  const { execute } = recorder();
  const result = await replaySkill({
    skill, parameters: { contact: "Chintu", text: "hi" }, execute,
    verifyStep: async () => ({ status: "UNCONFIRMED", message: "the window could not be read" })
  });
  assert.equal(result.replayed, false);
  assert.equal(result.handover.failure.unconfirmed, true);
  assert.match(result.handover.failure.reason, /could not confirm/);
});

// THE ONE THAT MATTERS MOST. The send went out; only the check afterwards
// failed. If the handover does not say so, the model reads a half-finished
// state, concludes the message never went, and sends it again.
test("an irreversible step that already happened is named in the handover", async () => {
  const { execute } = recorder();
  let call = 0;
  const result = await replaySkill({
    skill, parameters: { contact: "Chintu", text: "av byavarsi" }, execute,
    verifyStep: async () => (++call === 1 ? { status: "VERIFIED" } : { status: "FAILED", message: "the box still holds the text" })
  });
  assert.equal(result.replayed, false);
  assert.equal(result.handover.alreadyDone.length, 1);
  const text = describeHandover(result.handover);
  assert.match(text, /ALREADY DONE AND NOT REPEATABLE: 2\. type/);
  assert.match(text, /carry on from here/);
  assert.doesNotMatch(text, /ALREADY DONE AND NOT REPEATABLE: none/);
});

test("a missing application fails fast rather than asking the model to find it", async () => {
  const { calls, execute } = recorder({ launch: { ok: false, text: "WhatsApp is not installed" } });
  const result = await replaySkill({ skill, parameters: {}, execute, verifyStep: async () => ({ status: "VERIFIED" }) });
  assert.equal(result.failFast, true);
  assert.equal(calls.length, 1);
});

test("the handover names the completed work so it is not redone", async () => {
  const { execute } = recorder();
  const result = await replaySkill({
    skill, parameters: { contact: "Chintu", text: "hi" }, execute,
    verifyStep: async () => ({ status: "FAILED", message: "not there" })
  });
  const text = describeHandover(result.handover);
  assert.match(text, /app-running \(WhatsApp\)/);
  assert.match(text, /focused \(WhatsApp\)/);
  assert.match(text, /Failed at step 1/);
});

test("an example with no placeholders still matches exactly", () => {
  const { regex, names } = exampleToPattern("open my inbox");
  assert.deepEqual(names, []);
  assert.equal(regex.test("Open  my inbox "), true);
  assert.equal(regex.test("open my inbox now"), false);
});
