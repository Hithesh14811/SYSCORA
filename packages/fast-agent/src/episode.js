// DID IT WORK, AND DID ANYTHING PROVE IT?
//
// Those are two questions and this product has always answered them with one
// word. A run ends COMPLETED whether every acting tool came back with a CONFIRMED
// receipt or none of them did — the receipts exist, they are typed, they are
// enforced at construction by `evidence.js`, and then the run status throws all
// of that away and says the same thing either way.
//
// arXiv:2605.13357 makes the separation its central point: its five-label outcome
// taxonomy exists so that `autonomous_verified_success` and `unverified_success`
// cannot be confused, because "the patch is correct" and "the agent produced
// evidence that the patch is correct" are different achievements and only the
// second one compounds. Its P3 says the same thing as a design principle: task
// completion is bound to EVIDENCE, never to a natural-language assertion.
//
// This codebase already has the harder half — the evidence — and was discarding
// it at the last step. Everything here is derived from counters the loop already
// keeps (`confirmedActions`, `refutedActions`, `declinedActions`) plus the
// intervention ledger. Nothing new is measured and no tool changes.
//
// WHY THIS IS A NEW FIELD AND NOT A NEW STATUS.
//
// `status` is read by the daemon, the desktop shell, the eval runner, the skill
// recorder and four test files, and several of them branch on the exact strings.
// Changing what COMPLETED means would break all of them at once for a
// classification improvement — so `verification` sits BESIDE the status and
// nothing that does not ask for it can see any difference. The loop keeps its own
// existing guard for the dangerous cell (something refuted, nothing confirmed,
// and a past-tense claim) because that one needs to change the SENTENCE, not just
// the label.

import { InterventionLog } from "./interventions.js";

/**
 * How well this run's own claims are backed, independent of whether it finished.
 *
 * Orthogonal to `status` on purpose. A run can be PARTIALLY_COMPLETED and
 * AUTONOMOUS_VERIFIED (it proved the three things it did and then ran out of
 * time) or COMPLETED and UNVERIFIED (it acted and nothing read the machine back).
 * Collapsing those into one axis is what made the distinction invisible.
 */
export const Verification = Object.freeze({
  /** Nothing acted, so there is nothing to verify. Most questions land here. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
  /** Something acted, a receipt confirmed it, and nobody had to help. */
  AUTONOMOUS_VERIFIED: "AUTONOMOUS_VERIFIED",
  /** Confirmed, but a person was asked for something along the way. */
  ASSISTED_VERIFIED: "ASSISTED_VERIFIED",
  /**
   * It acted and nothing read the machine back either way.
   *
   * NOT A FAILURE. `unconfirmed is not failed` is a house rule in this codebase
   * and three separate gates have already been shipped that broke it, each one
   * throwing away work that had succeeded. This label means exactly "nobody
   * looked", and a surface that renders it as an error is reintroducing that bug.
   */
  UNVERIFIED: "UNVERIFIED",
  /** A receipt positively said the action did not work. */
  REFUTED: "REFUTED"
});

/**
 * Which of the five, from the counters the loop already has.
 *
 * @param {object} counts
 * @param {number} counts.actingCalls  how many tools that ACT were called
 * @param {number} counts.confirmed    acting tools whose receipt was CONFIRMED
 * @param {number} counts.refuted      acting tools that came back REFUTED or not-ok
 * @param {boolean} counts.assisted    was a person asked for anything at all
 */
export function classifyVerification({ actingCalls = 0, confirmed = 0, refuted = 0, assisted = false } = {}) {
  // NOTHING ACTED IS NOT THE SAME AS NOTHING WORKED, and this is the cell that
  // decides whether the metric is usable at all: the median request on this
  // machine is four steps and most of them only LOOK. Grading "which windows are
  // open?" as unverified would make the number meaningless within a day.
  if (actingCalls === 0) return Verification.NOT_APPLICABLE;
  // A refutation outranks a confirmation. A run that saved one file and failed to
  // send the message is not a verified success, and reporting the confirmation is
  // how a partial failure gets published under a green tick.
  if (refuted > 0 && confirmed === 0) return Verification.REFUTED;
  if (confirmed === 0) return Verification.UNVERIFIED;
  return assisted ? Verification.ASSISTED_VERIFIED : Verification.AUTONOMOUS_VERIFIED;
}

/** The paper's five labels, plus the three this product genuinely needs. */
export const Outcome = Object.freeze({
  AUTONOMOUS_VERIFIED_SUCCESS: "autonomous_verified_success",
  ASSISTED_VERIFIED_SUCCESS: "assisted_verified_success",
  UNVERIFIED_SUCCESS: "unverified_success",
  FAILED: "failed",
  UNSAFE_INVALID: "unsafe_invalid",
  // THREE THIS PRODUCT NEEDS AND A PATCH BENCHMARK DOES NOT.
  //
  // The paper's taxonomy grades one attempt at one code change. This agent holds
  // conversations, is told no, and is stopped by people — and every one of those
  // is a legitimate ending rather than a degraded success.
  /** A question answered, or a chat. No tool acted and none needed to. */
  ANSWERED: "answered",
  /** Work was done and the run did not get to the end of it. */
  PARTIAL: "partial",
  /** The user declined an irreversible action. An answer, not a failure. */
  DECLINED: "declined",
  /** The user pressed stop. */
  CANCELLED: "cancelled"
});

/**
 * One label for the whole episode, from the run status and the verification.
 *
 * `unsafe` is never INFERRED. Nothing here can tell whether a boundary was
 * crossed — that is known at the tool boundary, by the thing that refused — so it
 * is a parameter a caller sets deliberately and defaults to false. Guessing at it
 * would produce exactly the accusation-without-evidence this codebase forbids
 * everywhere else.
 */
export function classifyOutcome(status, verification, { unsafe = false } = {}) {
  if (unsafe) return Outcome.UNSAFE_INVALID;
  switch (status) {
    case "DECLINED": return Outcome.DECLINED;
    case "CANCELLED": return Outcome.CANCELLED;
    case "FAILED": return Outcome.FAILED;
    case "PARTIALLY_COMPLETED": return Outcome.PARTIAL;
    case "COMPLETED":
      if (verification === Verification.NOT_APPLICABLE) return Outcome.ANSWERED;
      if (verification === Verification.AUTONOMOUS_VERIFIED) return Outcome.AUTONOMOUS_VERIFIED_SUCCESS;
      if (verification === Verification.ASSISTED_VERIFIED) return Outcome.ASSISTED_VERIFIED_SUCCESS;
      // UNVERIFIED and REFUTED both land here. The run said it finished and
      // nothing backs that — which is precisely what `unverified_success` names,
      // and why the label exists rather than being folded into success.
      return Outcome.UNVERIFIED_SUCCESS;
    default:
      return Outcome.FAILED;
  }
}

// How much of a trace is kept. An episode package that grows with the
// conversation is the 396 MB session row this project already wrote once — see
// the 256 KB per-row cap in SessionStore and the 32 KB cap in the audit log.
// The package is a SUMMARY; the full transcript is already stored elsewhere.
const MAX_TRACE_ENTRIES = 60;

function boundedTrace(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= MAX_TRACE_ENTRIES) return { entries: list, dropped: 0 };
  // The head and the tail, because the interesting parts of a long run are how
  // it started and how it ended. The middle of a forty-step loop is the same
  // three calls over and over, which the repeat guard has already recorded.
  const keep = Math.floor(MAX_TRACE_ENTRIES / 2);
  return {
    entries: [...list.slice(0, keep), ...list.slice(-keep)],
    dropped: list.length - keep * 2
  };
}

/**
 * The auditable record of one run.
 *
 * arXiv:2605.13357 calls this an "episode package" and requires eight traces.
 * This product already EMITS every one of them — into three different places: the
 * event stream, the session store and the hash-chained audit log. What it has
 * never done is put them in one object that a person can be handed when they ask
 * why something went wrong, which is the difference between having observability
 * and being able to use it.
 *
 * Assembled from what the loop already holds. Nothing here reads a file, calls a
 * model or touches the machine, so building it costs a few object allocations at
 * the end of a run and cannot fail in a way that matters.
 */
export function buildEpisodePackage({
  request = "",
  status = "FAILED",
  verification = Verification.NOT_APPLICABLE,
  outcome = Outcome.FAILED,
  steps = 0,
  toolCalls = 0,
  elapsedMs = 0,
  tokens = null,
  performed = [],
  failures = [],
  interventions = null,
  entropy = null,
  context = null,
  failureReason = null,
  startedAt = null
} = {}) {
  const action = boundedTrace(performed.map((call) => ({
    tool: call?.tool ?? "?",
    ok: call?.ok === true,
    // Three states, kept as three. `verified: null` is "no receipt spoke", and
    // flattening it to false is the two-state verdict bug this codebase has
    // shipped three times.
    verified: call?.verified ?? null
  })));
  const log = interventions instanceof InterventionLog ? interventions.summary() : interventions;
  return {
    // Identity, so two packages can be told apart when they are read later.
    episode: {
      request: String(request ?? "").slice(0, 500),
      startedAt,
      elapsedMs,
      steps,
      toolCalls
    },
    // The eight traces, named as the paper names them so the mapping is obvious
    // to anyone holding it.
    actionTrace: action.entries,
    actionTraceDropped: action.dropped,
    toolTrace: {
      calls: toolCalls,
      // What was actually reached for, most-used first. The single most useful
      // line in a post-mortem here has repeatedly been "ten of its twenty-one
      // tool calls were `screen`".
      byTool: performed.reduce((counts, call) => {
        const name = call?.tool ?? "?";
        counts[name] = (counts[name] ?? 0) + 1;
        return counts;
      }, {}),
      failed: performed.filter((call) => call?.ok !== true).length
    },
    contextTrace: context ?? null,
    verificationTrace: {
      verification,
      confirmed: performed.filter((call) => call?.verified === true).length,
      refuted: performed.filter((call) => call?.verified === false).length,
      unread: performed.filter((call) => call?.verified == null).length
    },
    failureAttribution: boundedTrace(failures).entries,
    interventionLog: log ?? null,
    entropyAudit: entropy ?? null,
    outcomeRecord: {
      status,
      outcome,
      verification,
      failureReason,
      tokens: tokens ?? null
    }
  };
}

/**
 * The sentence a person reads when they ask how a run went.
 *
 * Written to be read out loud, because the whole reason the distinction matters
 * is that "it worked" and "it says it worked" sound identical until somebody
 * spells out which one this was.
 */
export function describeVerification(verification, { confirmed = 0, refuted = 0 } = {}) {
  switch (verification) {
    case Verification.AUTONOMOUS_VERIFIED:
      return `Verified: ${confirmed} action${confirmed === 1 ? "" : "s"} were read back off the machine ` +
        "by something other than the tool that performed them.";
    case Verification.ASSISTED_VERIFIED:
      return `Verified, with help: ${confirmed} action${confirmed === 1 ? "" : "s"} were read back off the ` +
        "machine, and you were asked for something along the way.";
    case Verification.UNVERIFIED:
      return "NOT verified: something acted and nothing read the machine back either way. That is not the " +
        "same as it having failed — it means nothing here can tell you whether it worked.";
    case Verification.REFUTED:
      return `Refuted: ${refuted} action${refuted === 1 ? "" : "s"} reported that ${refuted === 1 ? "it" : "they"} ` +
        "did not work, and nothing confirmed that anything did.";
    default:
      return "Nothing acted on the machine, so there was nothing to verify.";
  }
}
