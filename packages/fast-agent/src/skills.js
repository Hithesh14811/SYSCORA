// The verified route, saved once and replayed.
//
// "Send Chintu a message" costs twelve steps and a minute EVERY time, and the
// hundredth time is exactly as expensive as the first. A skill is what was
// actually true at each step of a run that worked, plus how to re-establish it —
// so the replay is three seconds and no model calls, and it still refuses to
// carry on the moment it cannot prove it is on track.
//
// The store only. Recording, matching and replay live elsewhere (docs/skills.md
// §10); this file knows how a skill is written down, how it is bounded, and when
// it has stopped earning its place.
//
// Deliberately plain JSON in the user's own state directory, one file per skill,
// exactly like notes.js: they can read it, edit it in Notepad, or delete it. A
// skill the user cannot inspect is a skill they cannot correct — and this one
// drives their machine, so that matters more here than it does for a note.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../shared-types/src/state-path.js";

// A recorded route is a handful of steps. Something claiming ninety is a
// transcript of the agent flailing, and replaying it would be worse than
// deriving the task again.
export const MAX_STEPS = 40;
export const MAX_SKILL_BYTES = 64_000;

// §8. A skill that falls back constantly is the worst of both worlds: replay
// latency AND full model cost, felt as an unexplained slowdown rather than an
// error. Judged only once there are enough runs to mean anything.
export const RETIRE_BELOW = 0.7;
export const RETIRE_AFTER_RUNS = 5;

// §4.1. Indices are valid only for the reading they came from; coordinates only
// for the layout they came from. Both are the brittleness this design exists to
// avoid — a recorded `click(718, 1151)` is how RPA ends up clicking a blank
// pixel and reporting success.
const FORBIDDEN_ARGS = new Set(["x", "y", "element", "windowId", "coordinate", "coordinates"]);

// The check kinds that are a SEARCH, and are therefore meaningless without
// something to search for. `input-empty` and `file-exists` are not here: they
// name their own subject and can fail on their own terms. See the refusal below.
const NEEDLE_REQUIRED = new Set([
  "element-present",
  "element-absent",
  "window-title-contains",
  "message-in-conversation",
  "file-contains",
  "command-output-contains"
]);

export function skillsDirectory(basePath) {
  return path.join(resolveStateDir(basePath), "skills");
}

export function skillPath(basePath, id) {
  return path.join(skillsDirectory(basePath), `${safeId(id)}.json`);
}

// An id becomes a file name, so it may not become a path. "../../etc" is not a
// skill.
export function safeId(id) {
  return String(id ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Is this a skill that can be replayed safely?
 *
 * Returns the reasons it is not, rather than a bare false: recording is supposed
 * to ABORT with the reason when a route cannot be expressed without geometry,
 * because that is a bug in perception worth fixing upstream, not a limitation to
 * paper over. Silence here would turn it into one.
 */
export function validateSkill(skill) {
  const problems = [];
  if (!skill || typeof skill !== "object") return ["not an object"];
  if (!safeId(skill.id)) problems.push("no usable id");
  if (!Array.isArray(skill.steps) || skill.steps.length === 0) problems.push("no steps");
  if (Array.isArray(skill.steps) && skill.steps.length > MAX_STEPS) {
    problems.push(`${skill.steps.length} steps is a transcript, not a route (max ${MAX_STEPS})`);
  }
  for (const [index, step] of (skill.steps ?? []).entries()) {
    if (!step?.tool) problems.push(`step ${index + 1}: no tool`);
    for (const key of Object.keys(step?.args ?? {})) {
      if (FORBIDDEN_ARGS.has(key)) {
        problems.push(
          `step ${index + 1} is positional (${key}). A step that can only be expressed with coordinates or an ` +
          "index is not skill-able: the control could not be named, which is a perception bug to fix rather " +
          "than a route to save."
        );
      }
    }
    // A CHECK WITH AN EMPTY NEEDLE IS NOT A CHECK, AND IT IS WORSE THAN NO CHECK
    // BECAUSE IT READS AS ONE.
    //
    // The recorder's fallback for any tool it had no rule for was
    // `{ kind: "element-present" }` with nothing to look for, and the verifier
    // read an absent needle as "did anything come back at all" — so a
    // `write_file` step was VERIFIED because the window behind it happened to
    // have buttons on it. Every saved route was proceeding on that. Measured
    // 19 Aug 2026 on the first route the eval ever recorded end to end: two
    // steps, both checked, neither check capable of failing.
    //
    // Refused here rather than in the recorder alone, so the rule holds for a
    // skill that arrived any other way — hand-edited on disk, or offered by a
    // model. A step with NO check is fine and is not this: the replayer still
    // requires the step's own result to be ok, and those receipts are typed and
    // read the world back by a different capability than the one that acted.
    // What is refused is claiming to check and checking nothing.
    if (step?.verify?.kind && NEEDLE_REQUIRED.has(step.verify.kind)) {
      const needle = String(step.verify.value ?? step.verify.text ?? "").trim();
      if (!needle) {
        problems.push(
          `step ${index + 1}: the ${step.verify.kind} check has nothing to look for, so it passes on any screen ` +
          "at all. Give it the words the step should put on screen, or leave the step unchecked and let its own " +
          "receipt speak."
        );
      }
    }
  }
  return problems;
}

/** Every saved skill, newest first. Never throws; no directory means none. */
export async function readSkills(basePath) {
  let names = [];
  try {
    names = (await fs.readdir(skillsDirectory(basePath))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const skills = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(path.join(skillsDirectory(basePath), name), "utf8");
      const skill = JSON.parse(raw);
      // A file the user has edited into something unusable must not take the
      // fast path. It is left on disk — it is theirs — and simply not replayed.
      if (validateSkill(skill).length === 0) skills.push(skill);
    } catch {
      // A skill that will not parse is one skill lost, not a broken agent.
    }
  }
  return skills.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export async function readSkill(basePath, id) {
  try {
    const raw = await fs.readFile(skillPath(basePath, id), "utf8");
    const skill = JSON.parse(raw);
    return validateSkill(skill).length === 0 ? skill : null;
  } catch {
    return null;
  }
}

/**
 * Save a skill, or refuse and say why.
 *
 * §9: never record a failed or unverified run. That check belongs to the
 * recorder, which knows how the run went; what belongs here is that nothing
 * invalid reaches the disk, so a later replay cannot find a route it should
 * never have been given.
 */
export async function writeSkill(basePath, skill) {
  const problems = validateSkill(skill);
  if (problems.length) return { saved: false, problems };
  const now = Date.now();
  const record = {
    ...skill,
    id: safeId(skill.id),
    createdAt: skill.createdAt ?? now,
    updatedAt: now,
    stats: {
      runs: 0, cleanReplays: 0, fallbacks: 0, lastRunAt: 0, retired: false,
      ...(skill.stats ?? {})
    }
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (serialized.length > MAX_SKILL_BYTES) {
    return { saved: false, problems: [`${serialized.length} bytes is too large for one skill`] };
  }
  await fs.mkdir(skillsDirectory(basePath), { recursive: true });
  await fs.writeFile(skillPath(basePath, record.id), serialized, "utf8");
  return { saved: true, skill: record };
}

export async function deleteSkill(basePath, id) {
  try {
    await fs.rm(skillPath(basePath, id));
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

/**
 * Record how a run of a skill went, and retire it when it stops paying.
 *
 * `clean` means the replay finished without handing over. A fallback is not a
 * failure — the run still succeeded, through the model — but a skill that needs
 * the model most of the time is costing replay latency ON TOP of the derivation
 * it was supposed to replace.
 */
export async function recordSkillRun(basePath, id, { clean }) {
  const skill = await readSkill(basePath, id);
  if (!skill) return { recorded: false };
  const stats = {
    runs: (skill.stats?.runs ?? 0) + 1,
    cleanReplays: (skill.stats?.cleanReplays ?? 0) + (clean ? 1 : 0),
    fallbacks: (skill.stats?.fallbacks ?? 0) + (clean ? 0 : 1),
    lastRunAt: Date.now(),
    retired: skill.stats?.retired === true
  };
  stats.retired = shouldRetire(stats);
  const saved = await writeSkill(basePath, { ...skill, stats });
  return { recorded: saved.saved, stats, retired: stats.retired };
}

export function shouldRetire(stats) {
  const runs = stats?.runs ?? 0;
  if (runs < RETIRE_AFTER_RUNS) return stats?.retired === true;
  return (stats.cleanReplays ?? 0) / runs < RETIRE_BELOW;
}

/** What the model is told exists, or "" when there is nothing. */
export function describeSkills(skills) {
  const live = (skills ?? []).filter((skill) => skill.stats?.retired !== true);
  if (!live.length) return "";
  return [
    "ROUTES YOU HAVE ALREADY VERIFIED for this user, replayable without working them out again:",
    ...live.map((skill) => `- ${skill.id}: ${skill.title ?? ""}`.trimEnd())
  ].join("\n");
}
