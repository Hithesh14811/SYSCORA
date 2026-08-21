// WHAT WAS DONE, HOW TO REVERSE IT, AND HOW LONG THAT STAYS POSSIBLE.
//
// THE ABSENCE OF THIS HAS ALREADY COST SOMETHING REAL, TWICE.
//
// A session set the user's system volume to 42% and COULD NOT PUT IT BACK,
// because nothing had recorded what it was before. And on 21 Aug 2026 the agent
// diagnosed a slow machine, killed OneDrive to break a stuck sync, and its
// restart failed on a path that does not exist on this machine — leaving the
// user's file sync dead, with the correct path sitting in a reading it had taken
// two steps earlier. In both cases the loop reported honestly. Neither could be
// undone, because the information needed to undo them was never written down.
//
// THE RULE THAT SHAPES ALL OF THIS: THE ENTRY IS WRITTEN BEFORE THE ACTION.
//
// An action that succeeded and then failed to journal has still happened. The
// only way the journal can be trusted to be complete is if the write comes
// first — so `record()` returns a handle, the tool acts, and then `settle()`
// says what actually happened. An entry that never settles is not evidence that
// nothing happened; it is evidence that we stopped knowing, and it reads that
// way.
//
// THREE STATES, NOT TWO. This is the same rule as the evidence verdicts and it
// exists for the same reason:
//
//   REVERSED         it was put back, and something other than the thing that
//                    put it back has confirmed so
//   COULD_NOT        it should have been reversible and the attempt failed —
//                    here is what the machine said
//   NEVER_REVERSIBLE the journal said at the time that nothing could undo this
//
// A journal that quietly omits the irreversible entries is WORSE THAN NONE,
// because it implies a coverage it does not have. "I sent that message and there
// is no way to unsend it" is information the user needs; silence is not.
//
// NOT KEYED ON ENGLISH. Entries carry the same typed receipt the tool already
// produced (see evidence.js). Nothing here parses a sentence to decide what
// happened — that is how a journal ends up disagreeing with the machine.

export const Reversal = Object.freeze({
  REVERSED: "REVERSED",
  COULD_NOT: "COULD_NOT",
  NEVER_REVERSIBLE: "NEVER_REVERSIBLE"
});

/** An entry that has been written but whose action has not reported back yet. */
const PENDING = "PENDING";
/** The action happened. This is the state an entry must be in to be undone. */
const DONE = "DONE";
/** The action did not happen, so there is nothing to undo. */
const ABANDONED = "ABANDONED";

let nextId = 1;

/**
 * A journal for one session.
 *
 * Deliberately in memory and per-run: an undo offered across restarts would be
 * offering to reverse a world that has moved on, and the window on most of these
 * reversals is minutes. Persistence is a later decision, not a free one.
 */
export function createUndoJournal({ now = () => Date.now() } = {}) {
  const entries = [];

  return {
    /**
     * Write down what is ABOUT to happen. Call this before acting.
     *
     * `reversal` is how to put it back — a typed descriptor the `undo` tool
     * knows how to execute, never a sentence. Passing `null` means nothing can
     * put this back, and `why` then has to say so; that is not an optional
     * field, because an entry that is silent about being irreversible is the one
     * failure mode this whole file exists to prevent.
     */
    record({ tool, summary, reversal = null, why = null, windowMs = null }) {
      if (!reversal && !why) {
        // Refusing loudly rather than storing a useless entry: a caller that has
        // not decided whether its action can be undone has not thought about it,
        // and the user is the one who pays for that later.
        throw new Error(
          `undo journal: ${tool} recorded no reversal and no reason. An action that cannot be undone ` +
          "must say why, or the journal implies a coverage it does not have."
        );
      }
      const entry = {
        id: nextId++,
        at: now(),
        tool,
        summary,
        reversal,
        why,
        // How long the reversal stays possible. WhatsApp's "delete for everyone"
        // has one; a volume level does not. Null means it does not expire, NOT
        // that nobody checked.
        expiresAt: windowMs == null ? null : now() + windowMs,
        state: PENDING,
        receipt: null,
        outcome: null
      };
      entries.push(entry);
      return entry.id;
    },

    /**
     * Say what actually happened, keyed on the tool's own receipt.
     *
     * A CONFIRMED or UNCONFIRMED verdict leaves the entry undoable — unconfirmed
     * is not failed, and an action we could not verify is exactly the one most
     * worth being able to reverse. Only a REFUTED verdict abandons it, because
     * that is the machine saying the thing did not happen.
     */
    settle(id, receipt) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      entry.receipt = receipt ?? null;
      entry.state = receipt?.verdict === "REFUTED" ? ABANDONED : DONE;
      return entry.state;
    },

    /**
     * The most recent thing that could still be put back, or null.
     *
     * Skips entries that were abandoned, already reversed, or whose window has
     * closed. Irreversible entries are NOT skipped — they are returned, because
     * the honest answer to "undo that" is often "that one cannot be undone, and
     * here is why", and the caller cannot say so if this hides them.
     */
    last({ at = now() } = {}) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.state !== DONE) continue;
        if (entry.outcome === Reversal.REVERSED) continue;
        if (entry.expiresAt != null && at > entry.expiresAt) {
          // Expired is not the same as irreversible, and the difference matters
          // to the person reading it: one was never possible, the other ran out.
          return { ...entry, expired: true };
        }
        return { ...entry, expired: false };
      }
      return null;
    },

    /** Record how the reversal went. Takes the outcome, not a sentence. */
    close(id, outcome) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      entry.outcome = outcome;
      return entry;
    },

    /** Everything, for tests and for showing the user what is on the record. */
    all() {
      return entries.map((entry) => ({ ...entry }));
    },

    /** How many entries could still be put back right now. */
    reversibleCount({ at = now() } = {}) {
      return entries.filter((entry) =>
        entry.state === DONE
        && entry.outcome !== Reversal.REVERSED
        && entry.reversal
        && (entry.expiresAt == null || at <= entry.expiresAt)
      ).length;
    }
  };
}

/**
 * How long is left on a reversal, in words a person can act on.
 *
 * Returns null when it does not expire. "About 4 minutes" is actionable;
 * "expiresAt: 1755792000000" is not, and the user is who reads this.
 */
export function timeLeft(entry, at = Date.now()) {
  if (!entry || entry.expiresAt == null) return null;
  const remaining = entry.expiresAt - at;
  if (remaining <= 0) return "no longer possible";
  const minutes = Math.floor(remaining / 60000);
  if (minutes >= 2) return `about ${minutes} minutes`;
  const seconds = Math.max(1, Math.round(remaining / 1000));
  return minutes === 1 ? "about a minute" : `about ${seconds} seconds`;
}
