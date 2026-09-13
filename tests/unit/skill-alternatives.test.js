// A SAVED ROUTE THAT SURVIVES THE SITUATION IT MEETS.
//
// `docs/state-of-the-world.md` concedes the limitation this file addresses: "a
// saved skill replays a route verbatim, so it is useless the moment the task
// differs slightly." arXiv:2601.21123 (CUA-Skill) reaches the same conclusion
// from the other direction and answers it with an execution GRAPH — guarded
// branches for the ordinary UI variations that break a straight line.
//
// The branching is worth nothing if it can be used to get around a person, so
// most of this file is the two cases where a branch may NEVER be taken.

import test from "node:test";
import assert from "node:assert/strict";

import { matchSkill, normalizeRequest, replaySkill } from "../../packages/fast-agent/src/skill-replay.js";
import { MAX_ALTERNATIVES, validateSkill } from "../../packages/fast-agent/src/skills.js";

const verified = () => ({ status: "VERIFIED" });
const unconfirmed = () => ({ status: "UNCONFIRMED", message: "nothing read it back" });

/** An `execute` that fails for the named tools and succeeds for everything else. */
const executor = (failing = [], { calls = [] } = {}) => async (tool, args) => {
  calls.push({ tool, args });
  return failing.includes(tool)
    ? { ok: false, text: `${tool} did not work` }
    : { ok: true, text: `${tool} ok` };
};

// ---------------------------------------------------------------------------
// THE BRANCH
// ---------------------------------------------------------------------------

test("a step that fails falls through to its alternative instead of handing over", async () => {
  const calls = [];
  const skill = {
    id: "open-settings",
    steps: [{
      tool: "click",
      args: { text: "Settings" },
      alternatives: [{ tool: "key", args: { keys: "^," } }]
    }]
  };
  const outcome = await replaySkill({
    skill,
    execute: executor(["click"], { calls }),
    verifyStep: verified
  });
  assert.equal(outcome.replayed, true, "the replay handed over rather than taking the branch");
  assert.deepEqual(calls.map((call) => call.tool), ["click", "key"]);
  // The transcript says which route was actually taken. A replay that quietly
  // took a different one and reported the recorded one has statistics that mean
  // nothing.
  assert.match(outcome.completed[0], /via alternative 1/);
});

test("a step whose CHECK fails also falls through", async () => {
  // The commonest real shape: the click landed on something, and the thing that
  // should have appeared did not.
  let checked = 0;
  const skill = {
    id: "compose",
    steps: [{
      tool: "click",
      args: { text: "New" },
      verify: { kind: "element-present", value: "Untitled" },
      alternatives: [{ tool: "key", args: { keys: "^n" } }]
    }]
  };
  const outcome = await replaySkill({
    skill,
    execute: executor([]),
    // Fail the first check, pass the second.
    verifyStep: () => (++checked === 1 ? unconfirmed() : verified())
  });
  assert.equal(outcome.replayed, true);
  assert.equal(checked, 2, "the alternative did not have to prove anything");
});

test("when every branch fails, the handover names all of them", async () => {
  const skill = {
    id: "stuck",
    steps: [{
      tool: "click",
      args: { text: "Send" },
      alternatives: [{ tool: "key", args: { keys: "enter" } }]
    }]
  };
  const outcome = await replaySkill({
    skill,
    execute: executor(["click", "key"]),
    verifyStep: verified
  });
  assert.equal(outcome.replayed, false);
  // A handover saying only how the LAST branch failed sends the model straight
  // back to the first one.
  assert.match(outcome.handover.failure.reason, /click:/);
  assert.match(outcome.handover.failure.reason, /key:/);
  assert.equal(outcome.handover.failure.triedAlternatives, 1);
});

// ---------------------------------------------------------------------------
// THE TWO CASES WHERE A BRANCH MAY NEVER BE TAKEN
// ---------------------------------------------------------------------------

test("AN IRREVERSIBLE STEP NEVER BRANCHES — a second route would send it twice", async () => {
  const calls = [];
  const skill = {
    id: "send-it",
    steps: [{
      tool: "click",
      args: { text: "Send" },
      irreversible: true,
      verify: { kind: "message-in-conversation", value: "hello" },
      alternatives: [{ tool: "key", args: { keys: "enter" } }]
    }]
  };
  const outcome = await replaySkill({
    skill,
    execute: executor([], { calls }),
    // The send went out and the check could not confirm it.
    verifyStep: unconfirmed
  });
  assert.equal(outcome.replayed, false);
  assert.deepEqual(calls.map((call) => call.tool), ["click"], "the alternative was tried on a send");
  // And it must say the send HAS gone out, or the model sends it again itself.
  assert.equal(outcome.handover.alreadyDone.length, 1);
});

test("A REFUSAL IS NOT A FAILURE TO ROUTE AROUND", async () => {
  const calls = [];
  const skill = {
    id: "delete-it",
    steps: [{
      tool: "click",
      args: { text: "Delete for everyone" },
      alternatives: [{ tool: "key", args: { keys: "delete" } }]
    }]
  };
  const outcome = await replaySkill({
    skill,
    execute: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: false, text: "the user declined", raw: { refusedByUser: true } };
    },
    verifyStep: verified
  });
  assert.equal(outcome.replayed, false);
  assert.deepEqual(calls.map((call) => call.tool), ["click"],
    "a branch was tried after the user said no, which automates routing around a refusal");
});

test("A REFUSED IRREVERSIBLE STEP IS NOT REPORTED AS ALREADY DONE", async () => {
  // The mirror of the send-twice bug: telling the model a send already happened
  // when the tool refused it is how the message never gets sent at all.
  const skill = {
    id: "send-it",
    steps: [{ tool: "click", args: { text: "Send" }, irreversible: true }]
  };
  const outcome = await replaySkill({
    skill,
    execute: async () => ({ ok: false, text: "refused" }),
    verifyStep: verified
  });
  assert.equal(outcome.handover.alreadyDone.length, 0);
});

// ---------------------------------------------------------------------------
// THE SCHEMA
// ---------------------------------------------------------------------------

test("a branch is held to the same no-coordinates bar as the step it replaces", () => {
  const problems = validateSkill({
    id: "positional-branch",
    steps: [{
      tool: "click",
      args: { text: "Send" },
      alternatives: [{ tool: "click", args: { x: 100, y: 200 } }]
    }]
  });
  // One problem per offending key, exactly as a positional STEP already reports
  // them — the branch is not a special case, which is the point.
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => /step 1 alternative 1 is positional/.test(problem)));
});

test("a branch with no tool is refused", () => {
  const problems = validateSkill({
    id: "no-tool",
    steps: [{ tool: "click", args: { text: "x" }, alternatives: [{ args: {} }] }]
  });
  assert.ok(problems.some((problem) => /alternative 1: no tool/.test(problem)));
});

test("too many branches is a step nobody understood", () => {
  const problems = validateSkill({
    id: "flailing",
    steps: [{
      tool: "click",
      args: { text: "x" },
      alternatives: Array.from({ length: MAX_ALTERNATIVES + 1 }, () => ({ tool: "key", args: { keys: "a" } }))
    }]
  });
  assert.ok(problems.some((problem) => /alternatives \(max/.test(problem)));
});

test("a skill with no alternatives at all is still valid — nothing existing changes", () => {
  assert.deepEqual(
    validateSkill({ id: "plain", steps: [{ tool: "launch", args: { application: "notepad" } }] }),
    []
  );
});

// ---------------------------------------------------------------------------
// TOLERANT MATCHING
// ---------------------------------------------------------------------------

test("politeness is stripped, so an ordinary way of asking still finds the route", () => {
  const skills = [{
    id: "msg",
    match: { examples: ["send {contact} a message saying {text}"] },
    steps: [{ tool: "type", args: { text: "{text}" } }]
  }];
  const found = matchSkill(skills, "can you please send amma a message saying hello, thanks");
  assert.ok(found, "the route was missed because the request was polite");
  assert.equal(found.parameters.contact, "amma");
  assert.equal(found.parameters.text, "hello");
  assert.equal(found.normalized, "send amma a message saying hello");
});

test("A GREETING IS NOT A WRAPPER — 'hi mum' keeps its first word", () => {
  // Eating the first word of a message is how a route replays with the wrong
  // text in it.
  assert.equal(normalizeRequest("hi mum how are you"), "hi mum how are you");
  assert.equal(normalizeRequest("hey there"), "hey there");
});

test("an exact match still wins, and widening never changes an existing answer", () => {
  const skills = [
    { id: "exact", match: { examples: ["open {app}"] }, steps: [{ tool: "launch", args: { application: "{app}" } }] }
  ];
  const found = matchSkill(skills, "open notepad");
  assert.equal(found.skill.id, "exact");
  // No `normalized` field, because nothing was rewritten.
  assert.equal(found.normalized, undefined);
});

test("normalising cannot invent a match out of an empty capture", () => {
  const skills = [{ id: "msg", match: { examples: ["send {contact} a message"] }, steps: [{ tool: "type", args: {} }] }];
  assert.equal(matchSkill(skills, "please send  a message"), null);
});

test("a retired skill is not offered however the request is phrased", () => {
  const skills = [{
    id: "old",
    stats: { retired: true },
    match: { examples: ["open {app}"] },
    steps: [{ tool: "launch", args: { application: "{app}" } }]
  }];
  assert.equal(matchSkill(skills, "can you open notepad"), null);
});
