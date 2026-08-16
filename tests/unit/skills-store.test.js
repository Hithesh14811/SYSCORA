// A SKILL THAT STORES GEOMETRY IS A MACRO, AND MACROS ARE WHY RPA BREAKS.
//
// UiPath records click(718, 1151), somebody resizes a window, and the robot
// clicks a blank pixel and reports success. docs/skills.md §4.1 forbids
// coordinates and indices for that reason, and §9 says a wrong skill is worse
// than no skill — so the store has to refuse them rather than trust whoever
// wrote the file, including a user editing it by hand.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RETIRE_AFTER_RUNS,
  deleteSkill,
  describeSkills,
  readSkill,
  readSkills,
  recordSkillRun,
  safeId,
  shouldRetire,
  validateSkill,
  writeSkill
} from "../../packages/fast-agent/src/skills.js";

const workspace = async () => fs.mkdtemp(path.join(os.tmpdir(), "syscora-skills-"));

const sendMessage = {
  id: "whatsapp-send-message",
  title: "Send a WhatsApp message",
  parameters: [{ name: "contact" }, { name: "text" }],
  steps: [
    { tool: "click", args: { text: "{contact}", section: "Chats" }, verify: { kind: "window-title-contains", value: "{contact}" } },
    { tool: "type", args: { text: "{text}" }, irreversible: true, verify: { kind: "input-empty" } }
  ]
};

test("a route described by label round-trips", async () => {
  const base = await workspace();
  const saved = await writeSkill(base, sendMessage);
  assert.equal(saved.saved, true);
  const read = await readSkill(base, "whatsapp-send-message");
  assert.equal(read.steps.length, 2);
  assert.equal(read.steps[0].args.section, "Chats");
  assert.equal(read.stats.runs, 0);
  assert.equal(read.stats.retired, false);
});

test("a step that can only be expressed with coordinates is refused, with the reason", async () => {
  const base = await workspace();
  const saved = await writeSkill(base, {
    ...sendMessage,
    steps: [{ tool: "click", args: { x: 718, y: 1151 } }]
  });
  assert.equal(saved.saved, false);
  assert.match(saved.problems.join(" "), /positional/);
  // The reason matters as much as the refusal: it points at perception, which is
  // where the actual bug is when a control could not be named.
  assert.match(saved.problems.join(" "), /perception/);
});

test("an index is refused too — it is only valid for the reading it came from", async () => {
  const base = await workspace();
  const saved = await writeSkill(base, { ...sendMessage, steps: [{ tool: "click", args: { element: 6 } }] });
  assert.equal(saved.saved, false);
});

test("a skill the user has edited into nonsense is skipped, not fatal", async () => {
  const base = await workspace();
  await writeSkill(base, sendMessage);
  await fs.mkdir(path.join(base, ".syscora", "skills"), { recursive: true });
  await fs.writeFile(path.join(base, ".syscora", "skills", "broken.json"), "{ not json", "utf8");
  await fs.writeFile(path.join(base, ".syscora", "skills", "positional.json"),
    JSON.stringify({ id: "positional", steps: [{ tool: "click", args: { x: 1, y: 2 } }] }), "utf8");
  const skills = await readSkills(base);
  assert.equal(skills.length, 1, "the good skill still loads");
  assert.equal(skills[0].id, "whatsapp-send-message");
});

test("an id cannot escape the skills directory", async () => {
  assert.equal(safeId("../../etc/passwd"), "etc-passwd");
  assert.equal(safeId("Send WhatsApp!"), "send-whatsapp");
});

// §8. Replay latency PLUS full model cost is worse than either alone, and it
// feels like an unexplained slowdown rather than an error.
test("a skill that mostly falls back retires itself, but not before it has been tried", async () => {
  const base = await workspace();
  await writeSkill(base, sendMessage);
  for (let run = 0; run < RETIRE_AFTER_RUNS - 1; run += 1) {
    const result = await recordSkillRun(base, "whatsapp-send-message", { clean: false });
    assert.equal(result.retired, false, "one bad run is not a verdict");
  }
  const final = await recordSkillRun(base, "whatsapp-send-message", { clean: false });
  assert.equal(final.retired, true);
  assert.equal(describeSkills(await readSkills(base)), "", "a retired skill is not offered");
});

test("a skill that keeps working is never retired", () => {
  assert.equal(shouldRetire({ runs: 20, cleanReplays: 19 }), false);
  assert.equal(shouldRetire({ runs: 20, cleanReplays: 13 }), true);
  assert.equal(shouldRetire({ runs: 2, cleanReplays: 0 }), false);
});

test("a skill with no steps is not a skill", () => {
  assert.deepEqual(validateSkill({ id: "x", steps: [] }).includes("no steps"), true);
});

test("deleting one is unceremonious", async () => {
  const base = await workspace();
  await writeSkill(base, sendMessage);
  assert.equal((await deleteSkill(base, "whatsapp-send-message")).deleted, true);
  assert.equal(await readSkill(base, "whatsapp-send-message"), null);
});
