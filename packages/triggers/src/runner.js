// FIRING A TRIGGER, WITH NOBODY WATCHING.
//
// The whole design is in three rules from docs/trust-and-triggers.md, and every
// one of them is about the same thing: the user is not here, so nothing may
// depend on the user being here.
//
//   ONE AT A TIME     "a schedule that fires while a user is typing must queue
//                      or skip, never interleave". There is one mouse.
//   FAILURE IS LOUD   "a trigger that silently stops working is worse than no
//                      trigger — the user believes the work is happening".
//   NO CARDS          an unattended run cannot answer a confirmation.
//
// PURE, AND INJECTED. Everything that touches the world arrives as a function:
// the clock, the skill lookup, the runner that actually performs a skill, the
// lock. So the awkward cases — the machine busy at 9am, a skill deleted after
// its trigger was made, a run that raises a card at 3am — are ordinary unit
// tests instead of things discovered in production at 3am.

import { whyNotSchedulable } from "../../policy-engine/src/unattended.js";
import { dueTriggers, readTriggers, recordRun } from "./store.js";

// HOW LATE IS TOO LATE.
//
// A trigger that came due while the machine was busy stays due, which is the
// "queue" half of the rule above — better an order export at 09:20 than none.
// But an hour of that becomes absurd: a nightly cleanup running at lunchtime is
// not the job the user scheduled, it is a surprise. Past this, the firing is
// abandoned WITH A RECORDED REASON and the next one is scheduled normally. The
// user finds out; they are not quietly given a different product.
export const DEFAULT_MAX_LATENESS_MS = 60 * 60 * 1000;

/**
 * Run every trigger that has come due.
 *
 * @param {object} deps
 * @param {string} deps.basePath
 * @param {(id: string) => Promise<object|null>} deps.loadSkill
 * @param {(skill: object, parameters: object) => Promise<{ok: boolean, detail: string, needsApproval?: boolean}>} deps.runSkill
 * @param {() => boolean} [deps.isBusy]  true when something else holds the machine
 * @param {(event: {type: string, details: object}) => void} [deps.onEvent]
 * @param {() => Date} [deps.now]
 * @param {number} [deps.maxLatenessMs]
 * @returns {Promise<{fired: number, skipped: number, failed: number}>}
 */
export async function runDueTriggers({
  basePath,
  loadSkill,
  runSkill,
  isBusy = () => false,
  onEvent = () => {},
  now = () => new Date(),
  maxLatenessMs = DEFAULT_MAX_LATENESS_MS
}) {
  const at = now();
  const due = dueTriggers(await readTriggers(basePath), at);
  const tally = { fired: 0, skipped: 0, failed: 0 };
  if (!due.length) return tally;

  for (const trigger of due) {
    const dueAt = new Date(trigger.nextFireAt);
    const lateness = at.getTime() - dueAt.getTime();

    // TOO LATE TO BE WHAT WAS ASKED FOR.
    if (lateness > maxLatenessMs) {
      tally.skipped += 1;
      const minutes = Math.round(lateness / 60000);
      await recordRun(basePath, trigger.id, {
        ok: false,
        at,
        dueAt,
        detail: `Skipped: it came due ${minutes} minutes ago and the machine was busy until now. ` +
          "Running it this late would not be what was scheduled, so it was abandoned and the next run is set normally."
      });
      onEvent({ type: "TRIGGER_SKIPPED", details: { trigger: trigger.id, lateMinutes: minutes } });
      continue;
    }

    // ONE MOUSE. Left due on purpose — no `recordRun`, so `nextFireAt` does not
    // move and the next tick tries again. That is the "queue" the spec asks for,
    // bounded by the lateness rule above.
    if (isBusy()) {
      tally.skipped += 1;
      onEvent({ type: "TRIGGER_DEFERRED", details: { trigger: trigger.id, reason: "the machine is busy" } });
      continue;
    }

    const skill = await loadSkill(trigger.skill).catch(() => null);
    if (!skill) {
      tally.failed += 1;
      await recordRun(basePath, trigger.id, {
        ok: false,
        at,
        dueAt,
        detail: `The skill "${trigger.skill}" this trigger runs no longer exists. Nothing ran.`
      });
      onEvent({ type: "TRIGGER_FAILED", details: { trigger: trigger.id, reason: "skill missing" } });
      continue;
    }

    // CHECKED AGAIN, EVERY TIME, NOT ONLY WHEN THE TRIGGER WAS MADE.
    //
    // Skills are plain JSON in the user's own directory and are meant to be
    // edited. A route that was safe to automate in March can have a "Send"
    // click added to it in April by the person who owns the file, and a check
    // that only ran at creation would never see it. This costs nothing and
    // closes the gap.
    const blockers = whyNotSchedulable(skill);
    if (blockers.length) {
      tally.failed += 1;
      await recordRun(basePath, trigger.id, {
        ok: false,
        at,
        dueAt,
        detail: `Not run: this skill now contains a step that needs someone to approve it — ${blockers[0]}. ` +
          "A scheduled run has nobody to ask."
      });
      onEvent({ type: "TRIGGER_BLOCKED", details: { trigger: trigger.id, blockers } });
      continue;
    }

    onEvent({ type: "TRIGGER_FIRED", details: { trigger: trigger.id, skill: skill.id, dueAt: dueAt.toISOString() } });
    let outcome;
    try {
      outcome = await runSkill(skill, trigger.arguments ?? {});
    } catch (error) {
      outcome = { ok: false, detail: `It threw: ${error?.message ?? String(error)}` };
    }

    // A CARD RAISED MID-RUN IS A FAILURE, NOT A WAIT.
    //
    // The creation-time check cannot be complete: a skill's arguments are fixed
    // but the screen is not, so a click that was safe when recorded can land on
    // something gated today. Waiting is the one thing that must not happen —
    // 120 seconds of silence then a timeout reading as "no" is precisely the
    // quiet failure this whole feature is built to avoid. It stops, and it says
    // why in words the user will understand when they read it in the morning.
    if (outcome?.needsApproval) {
      tally.failed += 1;
      await recordRun(basePath, trigger.id, {
        ok: false,
        at,
        dueAt,
        detail: `Stopped part-way: it reached a step that needed your approval (${outcome.detail}). ` +
          "Nothing was approved on your behalf. Run it yourself when you are here."
      });
      onEvent({ type: "TRIGGER_NEEDS_APPROVAL", details: { trigger: trigger.id, detail: outcome.detail } });
      continue;
    }

    if (outcome?.ok) tally.fired += 1;
    else tally.failed += 1;
    await recordRun(basePath, trigger.id, {
      ok: outcome?.ok === true,
      at,
      dueAt,
      detail: String(outcome?.detail ?? (outcome?.ok ? "Ran." : "It did not finish."))
    });
    onEvent({
      type: outcome?.ok ? "TRIGGER_SUCCEEDED" : "TRIGGER_FAILED",
      details: { trigger: trigger.id, detail: outcome?.detail ?? null }
    });
  }
  return tally;
}

/**
 * What the user is owed when they look at the panel.
 *
 * A trigger that has failed every morning for a week must say so in its first
 * line. `health` is what the surface colours on, so the judgement is made here
 * once rather than in every place that renders a trigger.
 */
export function triggerHealth(trigger) {
  if (trigger?.enabled === false) return { health: "off", says: "Off. It will not run." };
  if (!trigger?.lastRun) {
    return {
      health: "new",
      says: trigger?.nextFireAt
        ? `Has not run yet. First run ${new Date(trigger.nextFireAt).toLocaleString()}.`
        : "Has not run yet, and has no next run scheduled."
    };
  }
  const when = new Date(trigger.lastRun.at).toLocaleString();
  if (trigger.lastRun.ok) return { health: "ok", says: `Last ran ${when} and it worked.` };
  return { health: "failing", says: `FAILING since ${when} — ${trigger.lastRun.detail}` };
}
