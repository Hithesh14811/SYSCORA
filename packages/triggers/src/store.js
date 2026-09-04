// A trigger is a saved skill plus a schedule.
//
// Plain JSON, one file per trigger, in the user's own state directory — exactly
// like skills and notes, and for the same reason: this drives their machine
// while they are not watching, so being able to open it in Notepad and see what
// it will do is not a nicety. A trigger the user cannot inspect is one they
// cannot correct, and the whole feature depends on them trusting it.
//
// THE SHAPE, from docs/trust-and-triggers.md §4:
//
//   { id, skill, arguments, when: { kind: "schedule", cron }, enabled,
//     createdAt, lastRun: { at, ok, detail }, nextFireAt }
//
// `lastRun` is not bookkeeping, it is the product. "A trigger that silently
// stops working is worse than no trigger — the user believes the work is
// happening." Every read surfaces it, and the runner writes it on every firing
// including the failures.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../shared-types/src/state-path.js";
import { cronProblem, nextFireAfter } from "./schedule.js";

export const TRIGGER_KINDS = Object.freeze(new Set(["schedule"]));

export function triggersDirectory(basePath) {
  return path.join(resolveStateDir(basePath), "triggers");
}

// An id becomes a file name, so it may not become a path. Same rule as skills.
export function safeTriggerId(id) {
  return String(id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function triggerPath(basePath, id) {
  return path.join(triggersDirectory(basePath), `${safeTriggerId(id)}.json`);
}

/**
 * Why this trigger cannot be stored, or an empty array.
 *
 * Deliberately does NOT check whether the skill is schedulable: that needs the
 * skill itself, which this module does not read, and the check belongs next to
 * the other safety rules. The daemon does both — see `whyNotSchedulable` in
 * policy-engine. Splitting them keeps this file about storage.
 */
export function validateTrigger(trigger) {
  const problems = [];
  if (!trigger || typeof trigger !== "object") return ["not an object"];
  if (!safeTriggerId(trigger.id)) problems.push("no usable id");
  if (!safeTriggerId(trigger.skill)) problems.push("no skill named");
  const kind = trigger.when?.kind;
  if (!TRIGGER_KINDS.has(kind)) {
    // `hotkey` and `file-appears` are named in the spec and are not built. Say
    // so, rather than refusing with "invalid kind" as though they never will be.
    problems.push(
      `"${kind ?? "none"}" is not a trigger kind that exists yet — only "schedule" is built ` +
      "(hotkey and file-appears are specified but unbuilt)"
    );
  }
  if (kind === "schedule") {
    const problem = cronProblem(trigger.when?.cron);
    if (problem) problems.push(`the schedule is unusable: ${problem}`);
  }
  return problems;
}

async function readOne(file) {
  try {
    const trigger = JSON.parse(await fs.readFile(file, "utf8"));
    // A file edited into something unusable is left on disk — it is theirs — and
    // simply not run. Same rule as a corrupted skill.
    return validateTrigger(trigger).length === 0 ? trigger : null;
  } catch {
    return null;
  }
}

/** Every stored trigger. Never throws; no directory means none. */
export async function readTriggers(basePath) {
  let names = [];
  try {
    names = (await fs.readdir(triggersDirectory(basePath))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const triggers = [];
  for (const name of names) {
    const trigger = await readOne(path.join(triggersDirectory(basePath), name));
    if (trigger) triggers.push(trigger);
  }
  return triggers.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export async function readTrigger(basePath, id) {
  return readOne(triggerPath(basePath, id));
}

/**
 * Write a trigger, or refuse and say why.
 *
 * `nextFireAt` is computed here rather than by the runner so that a trigger is
 * inspectable the moment it is created: the user can read the file, or the
 * panel, and see when it will actually happen. A schedule whose next firing is
 * not what the user expected is the commonest cron mistake there is, and it is
 * only catchable if the answer is shown before the first run rather than after.
 */
export async function writeTrigger(basePath, trigger) {
  const problems = validateTrigger(trigger);
  if (problems.length) return { ok: false, problems };
  const id = safeTriggerId(trigger.id);
  const now = new Date();
  const stored = {
    ...trigger,
    id,
    skill: safeTriggerId(trigger.skill),
    enabled: trigger.enabled !== false,
    createdAt: trigger.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    lastRun: trigger.lastRun ?? null,
    nextFireAt: trigger.when?.kind === "schedule"
      ? (nextFireAfter(trigger.when.cron, now)?.toISOString() ?? null)
      : null
  };
  await fs.mkdir(triggersDirectory(basePath), { recursive: true });
  await fs.writeFile(triggerPath(basePath, id), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return { ok: true, trigger: stored };
}

export async function deleteTrigger(basePath, id) {
  try {
    await fs.unlink(triggerPath(basePath, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record what happened on a firing, and when the next one is due.
 *
 * ALWAYS WRITES, INCLUDING ON FAILURE. This is the loud half of "failure must be
 * loud": a run that threw still moves `lastRun` and still schedules the next
 * firing, so a trigger that has been failing every morning for a week says so
 * the moment anybody looks instead of appearing idle.
 *
 * `nextFireAt` is computed from the firing that was DUE, not from the moment the
 * run happened to finish. A job that takes four minutes must not drift four
 * minutes later every day, and a job that overran its next slot must not
 * immediately fire again to catch up.
 */
export async function recordRun(basePath, id, { ok, detail, at = new Date(), dueAt = null }) {
  const trigger = await readTrigger(basePath, id);
  if (!trigger) return null;
  const from = dueAt ? new Date(dueAt) : at;
  const stored = {
    ...trigger,
    lastRun: {
      at: new Date(at).toISOString(),
      ok: ok === true,
      detail: String(detail ?? "").slice(0, 500)
    },
    nextFireAt: trigger.when?.kind === "schedule"
      ? (nextFireAfter(trigger.when.cron, from)?.toISOString() ?? null)
      : null,
    updatedAt: new Date().toISOString()
  };
  await fs.mkdir(triggersDirectory(basePath), { recursive: true });
  await fs.writeFile(triggerPath(basePath, stored.id), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return stored;
}

/** The triggers whose next firing has come round. */
export function dueTriggers(triggers, now = new Date()) {
  return (triggers ?? []).filter((trigger) => {
    if (trigger?.enabled === false) return false;
    if (!trigger?.nextFireAt) return false;
    return new Date(trigger.nextFireAt).getTime() <= now.getTime();
  });
}
