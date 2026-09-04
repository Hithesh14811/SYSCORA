// Triggers: a saved skill plus a schedule, running with nobody watching.
//
// Every test here is one of the three rules from docs/trust-and-triggers.md §4,
// and the first of them is the reason the feature is dangerous at all: an
// unattended run cannot answer a confirmation card, so the decision about which
// routes may run unattended has to be made once, loudly, at creation — never by
// a timeout defaulting to "no" at 3am.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { whyNotSchedulable, isSchedulable } from "../../packages/policy-engine/src/unattended.js";
import { cronProblem, nextFireAfter, parseCron } from "../../packages/triggers/src/schedule.js";
import { dueTriggers, readTriggers, recordRun, validateTrigger, writeTrigger } from "../../packages/triggers/src/store.js";
import { runDueTriggers, triggerHealth } from "../../packages/triggers/src/runner.js";

const tempBase = () => fs.mkdtemp(path.join(os.tmpdir(), "syscora-triggers-"));

const skillOf = (steps, extra = {}) => ({ id: "a-skill", title: "A skill", steps, ...extra });

// ---- Rule 1: nothing that needs a person may run without one ---------------

test("a skill that would raise a card is refused a schedule, with the reason", () => {
  // The four shapes that end in a card, one per gate. Each names the rule that
  // caught it so the user can see what is in the way rather than being told no.
  const cases = [
    {
      what: "a click on Send",
      skill: skillOf([{ tool: "click", args: { text: "Send" } }]),
      expect: /send this/i
    },
    {
      what: "Delete for everyone",
      skill: skillOf([{ tool: "click", args: { text: "Delete for everyone" } }]),
      expect: /other person's phone/i
    },
    {
      what: "Enter in a messaging app",
      skill: skillOf([{ tool: "key", args: { keys: "enter", application: "WhatsApp" } }]),
      expect: /cannot be unsent/i
    },
    {
      what: "a delete command",
      skill: skillOf([{ tool: "run", args: { command: "Remove-Item C:\\Users\\me\\Documents\\old.txt" } }]),
      expect: /delete files or folders/i
    }
  ];
  for (const { what, skill, expect } of cases) {
    const reasons = whyNotSchedulable(skill);
    assert.ok(reasons.length > 0, `${what} must not be schedulable`);
    assert.match(reasons.join(" "), expect, what);
  }
});

test("a step that only reads or only types is schedulable", () => {
  // The feature has to be usable or nobody turns it on. Reading files, opening
  // an app, typing into a document and a read-only command are the ordinary
  // contents of an RPA route and none of them ends in a card.
  const skill = skillOf([
    { tool: "launch", args: { application: "notepad" } },
    { tool: "type", args: { text: "the daily note" } },
    { tool: "run", args: { command: "Get-ChildItem C:\\reports" } },
    { tool: "write_file", args: { path: "C:\\reports\\out.txt", contents: "x" } },
    { tool: "click", args: { text: "Save" } }
  ]);
  assert.deepEqual(whyNotSchedulable(skill), [], "an ordinary route must be automatable");
  assert.equal(isSchedulable(skill), true);
});

test("Enter with no application recorded is refused rather than assumed safe", () => {
  // "Which app was this?" is exactly the question whose wrong answer sends a
  // message at 3am. Absent means unknown, and unknown means no.
  const reasons = whyNotSchedulable(skillOf([{ tool: "key", args: { keys: "enter" } }]));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /does not record which application/);
  // Named, and not a messaging app, is fine: Enter in Notepad is a newline.
  assert.deepEqual(
    whyNotSchedulable(skillOf([{ tool: "key", args: { keys: "enter", application: "notepad" } }])),
    []
  );
});

test("a command needing approval every run is refused, not deferred to a card", () => {
  // Not in the CONFIRM table, but not a read either — the ASK path also ends in
  // a card, and a card is equally unanswerable on a schedule.
  const reasons = whyNotSchedulable(skillOf([{ tool: "run", args: { command: "New-Item -ItemType Directory X" } }]));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /nobody to ask on a schedule/);
});

// ---- The schedule itself ---------------------------------------------------

test("cron parses the grammar it claims to, and refuses the rest", () => {
  assert.equal(cronProblem("0 9 * * 1-5"), null);
  assert.equal(cronProblem("*/15 * * * *"), null);
  assert.equal(cronProblem("0 0,12 1 */2 *"), null);
  // A typo must not silently become "*", which is how one becomes a job that
  // runs every minute forever.
  assert.match(cronProblem("0 9 * *"), /five fields/);
  assert.match(cronProblem("0 99 * * *"), /outside 0-23/);
  assert.match(cronProblem("0 9 * * abc"), /not a number/);
  assert.match(cronProblem("*/0 * * * *"), /not a valid step/);
});

test("the next firing is strictly after the moment asked about", () => {
  // This is what stops a trigger firing twice: the runner asks from the last
  // firing, so 09:00 today yields 09:00 tomorrow rather than 09:00 again.
  const nineAm = new Date(2026, 8, 7, 9, 0, 0); // Monday 7 Sep 2026
  const next = nextFireAfter("0 9 * * 1-5", nineAm);
  assert.equal(next.getDate(), 8, "the same minute must not match again");
  assert.equal(next.getHours(), 9);
});

test("a weekday schedule skips the weekend", () => {
  const fridayEvening = new Date(2026, 8, 11, 18, 0, 0); // Friday
  const next = nextFireAfter("0 9 * * 1-5", fridayEvening);
  assert.equal(next.getDay(), 1, "after Friday evening the next weekday firing is Monday");
  assert.equal(next.getDate(), 14);
});

test("day-of-month and day-of-week are OR when both are restricted", () => {
  // Real cron behaviour, and getting it backwards silently makes a weekday
  // schedule fire on weekends. `0 9 1 * 1` is "the 1st, AND every Monday".
  const parsed = parseCron("0 9 1 * 1");
  assert.equal(parsed.restrictsDayOfMonth, true);
  assert.equal(parsed.restrictsDayOfWeek, true);
  // 1 Sep 2026 is a Tuesday: matches on day-of-month alone.
  const fromAugust = nextFireAfter("0 9 1 * 1", new Date(2026, 7, 31, 12, 0, 0));
  assert.equal(fromAugust.getDate(), 1);
  // And the following Monday, the 7th, matches on day-of-week alone.
  const afterTheFirst = nextFireAfter("0 9 1 * 1", new Date(2026, 8, 1, 12, 0, 0));
  assert.equal(afterTheFirst.getDate(), 7);
  assert.equal(afterTheFirst.getDay(), 1);
});

test("a schedule that can never fire returns null instead of spinning", () => {
  assert.equal(nextFireAfter("0 0 30 2 *", new Date(2026, 0, 1)), null, "there is no 30th of February");
});

// ---- The store -------------------------------------------------------------

test("a trigger is refused unless it names a skill and a usable schedule", () => {
  assert.match(validateTrigger({}).join(" "), /no usable id/);
  assert.match(validateTrigger({ id: "t" }).join(" "), /no skill named/);
  assert.match(
    validateTrigger({ id: "t", skill: "s", when: { kind: "hotkey" } }).join(" "),
    /specified but unbuilt/,
    "an unbuilt kind must say it is unbuilt, not that it is invalid"
  );
  assert.match(
    validateTrigger({ id: "t", skill: "s", when: { kind: "schedule", cron: "nonsense" } }).join(" "),
    /unusable/
  );
  assert.deepEqual(validateTrigger({ id: "t", skill: "s", when: { kind: "schedule", cron: "0 9 * * *" } }), []);
});

test("writing a trigger computes when it will next actually happen", async () => {
  const base = await tempBase();
  const written = await writeTrigger(base, { id: "Morning Orders", skill: "portal-export", when: { kind: "schedule", cron: "0 9 * * 1-5" } });
  assert.equal(written.ok, true);
  assert.equal(written.trigger.id, "morning-orders", "an id becomes a file name, so it is made safe");
  // Shown before the first run, because a schedule that does not mean what the
  // user thought is only catchable before it has been wrong once.
  assert.ok(written.trigger.nextFireAt, "the next firing must be visible on creation");
  assert.equal(new Date(written.trigger.nextFireAt).getHours(), 9);

  const [reloaded] = await readTriggers(base);
  assert.equal(reloaded.id, "morning-orders");
});

test("a failed run is recorded as loudly as a successful one", async () => {
  const base = await tempBase();
  await writeTrigger(base, { id: "t", skill: "s", when: { kind: "schedule", cron: "0 9 * * *" } });
  const dueAt = new Date(2026, 8, 7, 9, 0, 0);
  const after = await recordRun(base, "t", { ok: false, detail: "the portal was down", at: dueAt, dueAt });

  assert.equal(after.lastRun.ok, false);
  assert.match(after.lastRun.detail, /portal was down/);
  // AND IT IS STILL SCHEDULED. A trigger that stops rescheduling after one bad
  // morning looks idle rather than broken, which is the failure this rule exists
  // to prevent.
  assert.ok(after.nextFireAt, "a failure must not silently stop the schedule");
  assert.equal(new Date(after.nextFireAt).getDate(), 8);
  assert.equal(triggerHealth(after).health, "failing");
  assert.match(triggerHealth(after).says, /FAILING/);
});

test("the next firing is measured from when it was due, not from when it finished", async () => {
  // A job that takes four minutes must not drift four minutes later every day.
  const base = await tempBase();
  await writeTrigger(base, { id: "t", skill: "s", when: { kind: "schedule", cron: "0 9 * * *" } });
  const dueAt = new Date(2026, 8, 7, 9, 0, 0);
  const finishedAt = new Date(2026, 8, 7, 9, 4, 30);
  const after = await recordRun(base, "t", { ok: true, detail: "done", at: finishedAt, dueAt });

  const next = new Date(after.nextFireAt);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0, "the schedule must not drift by however long the run took");
});

// ---- The runner ------------------------------------------------------------

async function baseWithTrigger(overrides = {}) {
  const base = await tempBase();
  await writeTrigger(base, { id: "t", skill: "s", when: { kind: "schedule", cron: "* * * * *" }, ...overrides });
  return base;
}

test("a due trigger runs its skill and records that it worked", async () => {
  const base = await baseWithTrigger();
  const ran = [];
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "write_file", args: { path: "x", contents: "y" } }]),
    runSkill: async (skill, args) => { ran.push({ skill: skill.id, args }); return { ok: true, detail: "3 steps" }; },
    now: () => new Date(Date.now() + 120000)
  });

  assert.deepEqual(tally, { fired: 1, skipped: 0, failed: 0 });
  assert.equal(ran.length, 1);
  const [stored] = await readTriggers(base);
  assert.equal(stored.lastRun.ok, true);
});

test("nothing fires while the machine is busy, and it stays due", async () => {
  // One mouse. Deliberately no recordRun, so `nextFireAt` does not move and the
  // next tick tries again — the "queue" half of the rule.
  const base = await baseWithTrigger();
  const before = (await readTriggers(base))[0].nextFireAt;
  let called = 0;
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "type", args: { text: "x" } }]),
    runSkill: async () => { called += 1; return { ok: true, detail: "" }; },
    isBusy: () => true,
    now: () => new Date(Date.now() + 120000)
  });

  assert.equal(called, 0, "a trigger must never interleave with a user's own request");
  assert.deepEqual(tally, { fired: 0, skipped: 1, failed: 0 });
  assert.equal((await readTriggers(base))[0].nextFireAt, before, "it stays due so the next tick retries");
});

test("a firing that is hours late is abandoned rather than run at the wrong time", async () => {
  const base = await baseWithTrigger();
  let called = 0;
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "type", args: { text: "x" } }]),
    runSkill: async () => { called += 1; return { ok: true, detail: "" }; },
    now: () => new Date(Date.now() + 5 * 60 * 60 * 1000)
  });

  assert.equal(called, 0, "a nightly job must not run at lunchtime");
  assert.deepEqual(tally, { fired: 0, skipped: 1, failed: 0 });
  const [stored] = await readTriggers(base);
  assert.match(stored.lastRun.detail, /Skipped/, "and the user is told, rather than it appearing idle");
});

test("a run that hits an approval card stops instead of waiting for an answer", async () => {
  // THE 3AM CASE. Waiting is the one thing that must not happen: 120 seconds of
  // silence then a timeout reading as "no" is a quiet failure, and quiet failure
  // is the thing this whole feature is built to avoid.
  const base = await baseWithTrigger();
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "click", args: { text: "Save" } }]),
    runSkill: async () => ({ ok: false, needsApproval: true, detail: "clicking \"Send\"" }),
    now: () => new Date(Date.now() + 120000)
  });

  assert.deepEqual(tally, { fired: 0, skipped: 0, failed: 1 });
  const [stored] = await readTriggers(base);
  assert.match(stored.lastRun.detail, /needed your approval/);
  assert.match(stored.lastRun.detail, /Nothing was approved on your behalf/);
});

test("a skill edited to contain a gated step stops being run", async () => {
  // Skills are plain JSON the user is meant to edit. A route that was safe to
  // automate in March can have a Send click added to it in April, and a check
  // that only ran at creation would never see it.
  const base = await baseWithTrigger();
  let called = 0;
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "click", args: { text: "Send" } }]),
    runSkill: async () => { called += 1; return { ok: true, detail: "" }; },
    now: () => new Date(Date.now() + 120000)
  });

  assert.equal(called, 0, "schedulability is re-checked on every firing, not only at creation");
  assert.deepEqual(tally, { fired: 0, skipped: 0, failed: 1 });
  assert.match((await readTriggers(base))[0].lastRun.detail, /nobody to ask/);
});

test("a trigger whose skill has been deleted says so instead of failing silently", async () => {
  const base = await baseWithTrigger();
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => null,
    runSkill: async () => ({ ok: true, detail: "" }),
    now: () => new Date(Date.now() + 120000)
  });

  assert.deepEqual(tally, { fired: 0, skipped: 0, failed: 1 });
  assert.match((await readTriggers(base))[0].lastRun.detail, /no longer exists/);
});

test("a disabled trigger is never due", async () => {
  const base = await baseWithTrigger({ enabled: false });
  const stored = await readTriggers(base);
  assert.equal(dueTriggers(stored, new Date(Date.now() + 600000)).length, 0);
  assert.equal(triggerHealth(stored[0]).health, "off");
});

test("a skill that throws is recorded as a failure, not lost", async () => {
  const base = await baseWithTrigger();
  const tally = await runDueTriggers({
    basePath: base,
    loadSkill: async () => skillOf([{ tool: "type", args: { text: "x" } }]),
    runSkill: async () => { throw new Error("the window vanished"); },
    now: () => new Date(Date.now() + 120000)
  });

  assert.deepEqual(tally, { fired: 0, skipped: 0, failed: 1 });
  assert.match((await readTriggers(base))[0].lastRun.detail, /window vanished/);
});
