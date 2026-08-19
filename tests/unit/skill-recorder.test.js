// A WRONG SKILL IS WORSE THAN NO SKILL.
//
// It is a confident wrong answer, replayed for free, forever, and the user has
// no reason to look at it again. So the recorder refuses far more often than it
// accepts, and every refusal says why — §9.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSkillFromRun, candidateValues, parameterise } from "../../packages/fast-agent/src/skill-recorder.js";

const goodRun = {
  id: "whatsapp-send-message",
  userText: 'send Chintu a message on whatsapp saying "av byavarsi"',
  status: "COMPLETED",
  calls: [
    { tool: "launch", args: { application: "WhatsApp" }, ok: true, verified: true },
    { tool: "screen", args: {}, ok: true, verified: null },
    { tool: "click", args: { text: "Chintu", section: "Chats" }, ok: true, verified: true },
    { tool: "type", args: { text: "av byavarsi", submit: true }, ok: true, verified: true }
  ]
};

test("a completed, verified run becomes a route with the user's words as parameters", () => {
  const { recorded, skill } = buildSkillFromRun(goodRun);
  assert.equal(recorded, true);
  const typed = skill.steps.find((step) => step.tool === "type");
  assert.match(typed.args.text, /^\{p\d+\}$/, "the message body is a parameter, not a literal");
  assert.equal(skill.steps.some((step) => step.tool === "screen"), false, "a reading is not part of a route");
  assert.deepEqual(skill.preconditions[0], { ensure: "app-running", application: "WhatsApp" });
});

test("the send is marked as the thing that cannot be replayed twice", () => {
  const { skill } = buildSkillFromRun(goodRun);
  assert.equal(skill.steps.find((step) => step.tool === "type").irreversible, true);
});

test("a run that did not complete is never saved", () => {
  const { recorded, reasons } = buildSkillFromRun({ ...goodRun, status: "PARTIALLY_COMPLETED" });
  assert.equal(recorded, false);
  assert.match(reasons.join(" "), /completed run/);
});

test("a run with a step that failed its check is never saved", () => {
  const calls = goodRun.calls.map((call) => (call.tool === "type" ? { ...call, verified: false } : call));
  const { recorded, reasons } = buildSkillFromRun({ ...goodRun, calls });
  assert.equal(recorded, false);
  assert.match(reasons.join(" "), /verification did not pass/);
});

// The user's point: a recorder that captures a run containing tool-call markup
// bakes the garbage into a skill, and the skill replays it forever.
test("a run that contained malformed tool-call markup is never saved", () => {
  const { recorded, reasons } = buildSkillFromRun({ ...goodRun, malformedTurns: 1 });
  assert.equal(recorded, false);
  assert.match(reasons.join(" "), /malformed/);
});

test("a run that only looked at things has no route in it", () => {
  const { recorded, reasons } = buildSkillFromRun({
    ...goodRun,
    calls: [{ tool: "screen", args: {}, ok: true, verified: null }]
  });
  assert.equal(recorded, false);
  assert.match(reasons.join(" "), /nothing to replay/);
});

// THE INTERESTING REFUSAL. A step that can only be expressed with coordinates
// means perception could not name the control. That is a bug upstream, not a
// route to save, and the reason has to say so or nobody fixes it.
test("a run that clicked a coordinate is refused, pointing at perception", () => {
  const { recorded, reasons } = buildSkillFromRun({
    ...goodRun,
    calls: [...goodRun.calls, { tool: "click", args: { x: 718, y: 1151 }, ok: true, verified: true }]
  });
  assert.equal(recorded, false);
  assert.match(reasons.join(" "), /perception/);
});

test("longer values are replaced first, so no fragment is left behind", () => {
  // Replacing "Chintu" first would leave " jeppu" in the argument, and the skill
  // would type it every single time.
  const { args } = parameterise({ text: "Chintu jeppu" }, ["Chintu jeppu", "Chintu"]);
  assert.match(args.text, /^\{p1\}$/);
});

test("the same value twice is one parameter, not two", () => {
  const { args, names } = parameterise({ a: "Amma", b: "hello Amma" }, ["Amma"]);
  assert.equal(names.size, 1);
  assert.equal(args.a, "{p1}");
  assert.equal(args.b, "hello {p1}");
});

test("quoted text is taken as the user meaning exactly that", () => {
  assert.equal(candidateValues('send "av byavarsi" to Amma').includes("av byavarsi"), true);
});

// ---------------------------------------------------------------------------
// The first route this ever recorded against the real machine, and the three
// separate bugs it shipped with. Caught by the eval, because the eval checks the
// machine: the replay reported success and the file was not there.
// ---------------------------------------------------------------------------

const fileRun = {
  id: "create-routine-file",
  userText: "Create a file called routine.txt in C:\\Users\\hithe\\OneDrive\\Documents\\SYSCORA\\.syscora\\eval-workspace containing the word rehearsed",
  status: "COMPLETED",
  calls: [{
    tool: "run",
    args: { command: 'Set-Content -Path "C:\\Users\\hithe\\OneDrive\\Documents\\SYSCORA\\.syscora\\eval-workspace\\routine.txt" -Value "rehearsed"' },
    ok: true,
    verified: null
  }]
};

test("a filesystem path is one thing, not a sentence made of capitalised words", () => {
  const { skill } = buildSkillFromRun(fileRun);
  const command = skill.steps[0].args.command;
  assert.match(command, /C:\\Users\\hithe\\OneDrive\\Documents\\/,
    "Users and Documents are folders, not the user's own words");
  assert.doesNotMatch(command, /\{p\d+\}/, "nothing in this command should have become a parameter");
});

test("the opening verb of a request is not a parameter", () => {
  assert.equal(candidateValues("Create a file called notes.txt").includes("Create"), false);
});

// THE ONE THAT CORRUPTED THE PATH. "Users" was {p2} in the command and {p3} in
// the example that captures it, so the replay filled the step from the wrong
// capture and wrote to a path that did not exist.
test("a placeholder means the same thing in the example and in every step", () => {
  const { skill } = buildSkillFromRun({
    ...fileRun,
    userText: 'message Chintu on whatsapp saying "hello there"',
    calls: [
      { tool: "click", args: { text: "Chintu" }, ok: true, verified: true },
      { tool: "type", args: { text: "hello there" }, ok: true, verified: true }
    ]
  });
  const used = new Set();
  for (const step of skill.steps) {
    for (const found of JSON.stringify(step.args).matchAll(/\{(p\d+)\}/g)) used.add(found[1]);
  }
  const inExample = new Set([...skill.match.examples[0].matchAll(/\{(p\d+)\}/g)].map((found) => found[1]));
  for (const name of used) {
    assert.ok(inExample.has(name), `${name} is used by a step but never captured by the example`);
  }
  const declared = new Set(skill.parameters.map((parameter) => parameter.name));
  for (const name of inExample) assert.ok(declared.has(name), `${name} is captured but not declared`);
});

// A shell command reports its own exit code. The alternative was a check with
// nothing to look for, and an empty needle matches everything.
test("a command step carries no vacuous check", () => {
  const { skill } = buildSkillFromRun(fileRun);
  assert.equal(skill.steps[0].verify, undefined);
});

// THE RULE, OVER EVERY ROUTE THIS FILE CAN PRODUCE.
//
// The test above covers `run`, which was reasoned about correctly when it was
// written. The same reasoning was never applied to the fallback beside it: any
// tool without an entry in the table got `{ kind: "element-present" }` with
// nothing to look for, and so did `type`, `click` and `launch`. The verifier
// read an absent needle as "did anything come back at all", so those checks
// passed on any screen in existence — measured 19 Aug 2026 on the first route
// the eval recorded end to end: two steps, both checked, neither able to fail.
//
// Stated as a property rather than case by case, because the defect was in the
// DEFAULT — the next tool added would have inherited it silently.
const unknownToolRun = {
  id: "write-a-file-directly",
  userText: "put the word rehearsed in routine.txt",
  status: "COMPLETED",
  calls: [
    { tool: "write_file", args: { path: String.raw`C:\tmp\routine.txt`, contents: "rehearsed" }, ok: true, verified: true },
    { tool: "read_file", args: { path: String.raw`C:\tmp\routine.txt` }, ok: true, verified: true }
  ]
};

test("no recorded step ever carries a check with nothing to look for", () => {
  let checked = 0;
  for (const run of [goodRun, fileRun, unknownToolRun]) {
    const { recorded, skill } = buildSkillFromRun(run);
    assert.equal(recorded, true, `${run.id} should have recorded`);
    for (const [index, step] of skill.steps.entries()) {
      if (!step.verify?.kind) continue;
      checked += 1;
      const needle = String(step.verify.value ?? step.verify.text ?? "").trim();
      assert.notEqual(needle, "",
        `${skill.id} step ${index + 1} (${step.tool}) claims to check "${step.verify.kind}" and looks for nothing`);
    }
  }
  assert.ok(checked > 0, "if nothing carried a check at all this test would be proving nothing");
});

// A tool the recorder has no rule for gets NO check rather than a hollow one.
// write_file and read_file confirm themselves by reading the file back, which is
// a different capability from the one that wrote it; the replayer still requires
// each step's own result to come back ok. Silence here is honest. The old
// fallback claimed to have looked at the screen.
test("a tool with no verification rule is left unchecked, not checked vacuously", () => {
  const { recorded, skill } = buildSkillFromRun(unknownToolRun);
  assert.equal(recorded, true);
  assert.equal(skill.steps.length, 2);
  for (const step of skill.steps) {
    assert.equal(step.verify, undefined, `${step.tool} must not carry an invented check`);
  }
});

// The needle for a typed step is the words themselves, carrying the SAME
// placeholder as the argument, so both are filled from one capture at replay.
// Built from the raw arguments instead, `{p1}` in the step would have been
// checked against whatever literal happened to be typed when it was recorded.
test("a typed step is checked against the words it typed, in placeholder form", () => {
  // goodRun's type step is a SEND, which gets the stronger message-in-conversation
  // check; this is the ordinary case.
  const typingRun = {
    id: "type-a-note",
    userText: 'write "buy milk" in the note',
    status: "COMPLETED",
    calls: [
      { tool: "launch", args: { application: "Notepad" }, ok: true, verified: true },
      { tool: "type", args: { text: "buy milk" }, ok: true, verified: true }
    ]
  };
  const { recorded, skill } = buildSkillFromRun(typingRun);
  assert.equal(recorded, true);
  const typed = skill.steps.find((step) => step.tool === "type");
  assert.equal(typed.verify.kind, "element-present");
  assert.match(typed.args.text, /^\{p\d+\}$/, "the words are a parameter");
  assert.equal(typed.verify.value, typed.args.text,
    "the check and the argument must be the same string, placeholders included");
});
