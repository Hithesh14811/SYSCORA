// WHAT MAY RUN WITH NOBODY WATCHING.
//
// A trigger is a saved skill plus a schedule, and the moment a schedule exists
// the product's central safety assumption stops holding. Every gate in this
// codebase — the CONFIRM tables, the click gate, the send gate, the shell ASK
// path — ends in a card put in front of a person. At 3am there is no person.
//
// THE FAILURE MODE THIS EXISTS TO PREVENT, NAMED IN docs/trust-and-triggers.md:
// "do not let this be decided by a timeout defaulting to 'no' at 3am". That
// default is safe in the narrow sense — nothing happens — and it is a disaster
// in the sense that matters, because the user believes the work is happening.
// A trigger that silently stops working is worse than no trigger at all.
//
// So the decision is made ONCE, LOUDLY, AT CREATION TIME. A skill containing a
// step that would raise a card cannot be scheduled, and the reason names the
// step and the rule, so the user can see exactly what is in the way and decide
// whether to run it themselves or record a route without that step.
//
// THE RULES ARE NOT RESTATED HERE, THEY ARE CALLED.
//
// `requiresClickConfirmation`, `requiresSendConfirmation`, `requiresConfirmation`
// and `classifyShellCommand` are the same functions the tool boundary uses. A
// second copy of "which clicks are irreversible" is how this file and
// shell-rules.js would come to disagree, and the one that disagrees silently is
// the one guarding the unattended path. This codebase has already paid for that
// once: three copies of one verb list, which had drifted before anyone noticed.
//
// WHAT THIS IS NOT. It is not the only defence. A card raised during an
// unattended run is still possible — a skill's arguments are fixed but the
// screen is not, so a click that was safe when recorded can land on a different
// control today. The runner therefore ABORTS such a run rather than waiting for
// an answer nobody will give. Refuse at creation, fail loudly at runtime; this
// file is the first half.

import {
  ShellVerdict,
  classifyShellCommand,
  requiresClickConfirmation,
  requiresConfirmation,
  requiresSendConfirmation
} from "./shell-rules.js";

/** The tools whose risk lives in a command line. */
const SHELL_TOOLS = new Set(["run", "run_jobs", "project"]);

/**
 * Why this skill may not be scheduled, or an empty array if it may.
 *
 * Returns reasons rather than a bare false for the same reason `validateSkill`
 * does: the user is being told they cannot automate something they just watched
 * work, and "no" without a reason is indistinguishable from a bug.
 *
 * @param {{id?: string, steps?: Array<{tool: string, args?: object}>}} skill
 * @returns {string[]}
 */
export function whyNotSchedulable(skill) {
  const reasons = [];
  const steps = Array.isArray(skill?.steps) ? skill.steps : [];
  if (!steps.length) return ["it has no steps, so there is nothing to schedule"];

  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1} (${step?.tool ?? "no tool"})`;
    const args = step?.args ?? {};

    // A CLICK ON SOMETHING THAT CANNOT BE TAKEN BACK. "Send", "Delete for
    // everyone", "Post". The label is matched whole and anchored by the same
    // rule the click tool uses.
    if (step?.tool === "click") {
      const gate = requiresClickConfirmation(args.text ?? args.label);
      if (gate.confirm) {
        reasons.push(`${at} clicks "${args.text ?? args.label}", which would ${gate.summary} — ${gate.reason}`);
      }
    }

    // ENTER IN A MESSAGING APPLICATION IS A SEND. The application is on the step
    // when the recorder captured it; when it is absent the step is treated as
    // unschedulable rather than assumed safe, because "which app was this?" is
    // exactly the question whose wrong answer sends a message at 3am.
    if (step?.tool === "key" && /^(?:enter|return)$/i.test(String(args.keys ?? "").trim())) {
      const application = args.application ?? skill?.application ?? "";
      if (!application) {
        reasons.push(`${at} presses Enter and does not record which application in — in a messaging app that sends`);
      } else {
        const gate = requiresSendConfirmation(args.keys, application);
        if (gate.confirm) reasons.push(`${at} presses Enter in ${application}, which would ${gate.summary} — ${gate.reason}`);
      }
    }

    // A COMMAND LINE. Two separate questions, and both must be no.
    if (SHELL_TOOLS.has(step?.tool)) {
      const command = String(args.command ?? args.action ?? "");
      const gate = requiresConfirmation(command);
      if (gate.confirm) {
        reasons.push(`${at} runs a command that would ${gate.summary} — ${gate.reason}`);
      } else {
        // Not in the CONFIRM table, but still not a read. The ASK path also ends
        // in a card, so it is equally unanswerable unattended.
        const verdict = classifyShellCommand(command);
        if (verdict.verdict === ShellVerdict.DENY) {
          reasons.push(`${at} runs a command the floor refuses outright: ${verdict.reason}`);
        } else if (verdict.verdict === ShellVerdict.ASK) {
          reasons.push(
            `${at} runs \`${command.slice(0, 60)}\`, which needs approval every time it runs ` +
            `(${verdict.reason.replace(/^`[^`]*` /, "")}) — there is nobody to ask on a schedule`
          );
        }
      }
    }
  }
  return reasons;
}

/** Convenience predicate. Prefer `whyNotSchedulable` — the reasons are the point. */
export function isSchedulable(skill) {
  return whyNotSchedulable(skill).length === 0;
}
