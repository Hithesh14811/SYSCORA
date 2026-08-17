// WHY A SENTENCE NEEDS A RECEIPT.
//
// A tool returns a plain object. Its `render` turns that object into a sentence.
// Nothing connected the sentence to whether the machine had actually been looked
// at — so "Muted.", "Sent." and "Volume is now 60%" were strings a function
// chose to return, and every one of those has shipped as a lie:
//
//   "Sent."          keyboard.press returned; the message sat in the search box.
//   "Muted."         SetMute was accepted; the user could still hear the music.
//   "Focused."       window.activate returned; the app shell never learned it.
//   "Wrote notes.md" filesystem.write returned; the file was empty, because the
//                    capability's input is `content` and the caller sent
//                    `contents`.
//
// The invariant "never claim something happened without evidence" has now been
// patched five times at five different sites, always after it shipped, always as
// another regex over English. This module makes it structural instead: a result
// carries a typed receipt, and the only way to reach a success phrasing is
// through a helper that checks the receipt first.
//
// THE RULE THE RECEIPT ENCODES. The observation must be a FRESH READ OF MACHINE
// STATE, never the actor's own report that it acted. `performed: true` from
// pointer.clickAt is the actor talking about itself; the focused control read
// back over UIA afterwards is the machine talking about the world. `actedVia`
// names the capability that acted and `method` names the one that looked, and
// they may not be the same thing — which is the house rule "verification must
// not share a code path with the thing it verifies", written down where it can
// be enforced rather than remembered.

export const CONFIRMED = "CONFIRMED";
export const REFUTED = "REFUTED";
// THE THIRD STATE. Three gates in this codebase have conflated "I could not
// check" with "the check failed", and each one threw away work that had
// succeeded. A verdict with two states is a verdict that lies half the time it
// is uncertain.
export const UNCONFIRMED = "UNCONFIRMED";

const VERDICTS = new Set([CONFIRMED, REFUTED, UNCONFIRMED]);

// NOBODY LOOKED, AND THE RECEIPT SAYS SO.
//
// Some actions have no cheap reading behind them on this machine — where the
// pointer ended up, what a bare keystroke did. The temptation is to name a check
// that did not happen, or to leave `method` blank and let it read as one. This
// is the third option: say out loud that nothing looked. It is only ever valid
// with an UNCONFIRMED verdict, which the constructor enforces — "nothing looked"
// can never be the basis of a CONFIRMED anything.
export const NOTHING_READ_IT_BACK = "(nothing read the machine back)";

/**
 * A render tried to say something the evidence does not support, or a tool
 * returned a result with no evidence at all.
 *
 * Thrown rather than logged: the toolset turns it into an honest failure the
 * model reads, so a wiring mistake costs one visible step instead of shipping a
 * confident sentence about something that never happened.
 */
export class EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceError";
  }
}

/**
 * Build the receipt a tool result carries.
 *
 * @param {object} args
 * @param {string} args.observed  What the machine said, in the machine's terms.
 * @param {string} args.method    The capability that READ it.
 * @param {string} args.verdict   CONFIRMED | REFUTED | UNCONFIRMED.
 * @param {string|null} args.actedVia  The capability that ACTED, for a tool that
 *   changed something. Null for a tool that only looks.
 */
export function evidence({ observed, method, verdict, actedVia = null, at = Date.now() }) {
  if (!VERDICTS.has(verdict)) {
    throw new EvidenceError(`"${verdict}" is not a verdict. Use CONFIRMED, REFUTED or UNCONFIRMED.`);
  }
  const said = String(observed ?? "").trim();
  // A CHECK WITH AN EMPTY NEEDLE IS NOT A CHECK. An empty `observed` is the
  // shape every vacuous check in this codebase has taken — WhatsApp's message
  // box publishing "\n" and every emptiness test passing on it. If nothing was
  // observed, say what stopped you observing it; that is still an observation.
  if (!said) {
    throw new EvidenceError(
      `evidence({ verdict: "${verdict}" }) has an empty \`observed\`. Say what the machine said, or ` +
      "why it said nothing — an empty observation is not one."
    );
  }
  const read = String(method ?? "").trim();
  if (!read) throw new EvidenceError("evidence() needs `method`: the capability that read this back.");
  const acted = actedVia == null ? null : String(actedVia).trim();
  if (actedVia != null && !acted) {
    throw new EvidenceError("evidence() was given an empty `actedVia`. Name the capability, or pass null.");
  }
  // VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES.
  //
  // Except when the thing it says about itself is that it FAILED. The failure
  // this rule guards against is a tool flattering itself — `performed: true`
  // from an injector whose keystrokes are being discarded. A capability
  // answering "I did not run: the window is gone" is the one self-report worth
  // taking at face value, because there is nothing in it to gain by lying, and
  // demanding a second opinion on it would mean paying for a reading of a
  // machine we already know we did not touch.
  if (acted && acted === read && verdict !== REFUTED) {
    throw new EvidenceError(
      `evidence() would verify ${acted} with ${read} — the same capability. That is the action grading ` +
      "its own homework, which is how every false success in this project was reported. Read the result " +
      "back through something else."
    );
  }
  if (read === NOTHING_READ_IT_BACK && verdict !== UNCONFIRMED) {
    throw new EvidenceError(
      `evidence() says nothing read the machine back and then returns a ${verdict} verdict. If nothing ` +
      "looked, the only honest verdict is UNCONFIRMED."
    );
  }
  return Object.freeze({ observed: said, method: read, at, verdict, actedVia: acted });
}

export function verdictOf(result) {
  return result?.evidence?.verdict ?? null;
}

function gate(result, wanted, sentence, helper) {
  const receipt = result?.evidence;
  if (!receipt) {
    throw new EvidenceError(
      `${helper}() was given a result with no evidence, so there is nothing behind: ${JSON.stringify(
        String(sentence).slice(0, 120)
      )}. The tool's execute() must attach evidence({ observed, method, verdict }) to everything it returns.`
    );
  }
  if (wanted && receipt.verdict !== wanted) {
    throw new EvidenceError(
      `${helper}() needs a ${wanted} verdict and this result is ${receipt.verdict} ` +
      `(${receipt.method} observed: ${JSON.stringify(String(receipt.observed).slice(0, 160))}). ` +
      `The sentence it would have said is ${JSON.stringify(String(sentence).slice(0, 120))}.`
    );
  }
  return sentence;
}

/** The thing happened, and something other than the actor said so. */
export const confirmed = (result, sentence) => gate(result, CONFIRMED, sentence, "confirmed");

/** The thing demonstrably did NOT happen. */
export const refuted = (result, sentence) => gate(result, REFUTED, sentence, "refuted");

/** It could not be told either way — which is not the same as failed. */
export const unconfirmed = (result, sentence) => gate(result, UNCONFIRMED, sentence, "unconfirmed");

/**
 * Say what was DELIVERED or what was READ, rather than what became true.
 *
 * "Clicked "Send" at 927,277" and a window's element listing are both of this
 * kind: the first reports an input the pointer accepted, the second quotes the
 * machine verbatim. Neither asserts an outcome, so neither needs a CONFIRMED
 * verdict — but both still need the tool to have wired evidence at all, which is
 * what this checks. It is the difference between a transcript and a claim.
 */
export const reported = (result, sentence) => gate(result, null, sentence, "reported");

// A SECOND LINE, NOT THE MECHANISM.
//
// The mechanism is the gate above: a success sentence is unreachable without a
// CONFIRMED receipt, and that is enforced by construction rather than by reading
// English. This is the belt to that pair of braces — it is applied by the CI
// property test to whatever a render returns for an UNCONFIRMED or REFUTED
// result, and catches the one thing the gate cannot: a success sentence written
// into the honest branch by hand.
//
// It reads a text as a claim only when nothing in it says otherwise, because
// "Dragged from 1,2 to 3,4, but the application still has NOTHING TO UNDO"
// contains a past-tense verb and is the opposite of a success claim.
const HEDGED =
  /\b(?:not|nothing|never|no|cannot|can'?t|could not|couldn'?t|did not|didn'?t|does not|doesn'?t|unconfirmed|refused|failed|unable|still|whether|if |but )\b/i;

// The shapes a success claim actually takes in this file's renders: a bare past
// participle standing as the whole answer, and an outcome asserted about the
// machine.
const BARE_CLAIM =
  /^(?:ok(?:ay)?[,.\s]*)?(?:done|sent|muted|unmuted|focused|typed|clicked|closed|opened|saved|played|paused|stopped|started|deleted|removed|installed|created|changed|cleared|copied|moved|renamed|wrote|written|drew|drawn|dragged|scrolled|pressed|remembered|waited|set)\b[\s.!]*$/i;
const OUTCOME_ASSERTED =
  /\b(?:is (?:now )?(?:playing|muted|closed|open|focused|empty|a fresh|maximi[sz]ed|minimi[sz]ed)|now holds|has been (?:sent|saved|written|closed|set|opened)|it left the box|volume is \d|the document changed|so it drew|clipboard set)\b/i;

export function looksLikeSuccessClaim(text) {
  const said = String(text ?? "").trim();
  if (!said) return false;
  if (HEDGED.test(said)) return false;
  return BARE_CLAIM.test(said) || OUTCOME_ASSERTED.test(said);
}
