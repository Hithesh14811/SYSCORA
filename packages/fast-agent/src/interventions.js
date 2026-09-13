// WHO HAD TO STEP IN, AND WHETHER THIS HARNESS SHOULD HAVE HANDLED IT ITSELF.
//
// This product records what the AGENT did in enormous detail — a typed receipt on
// every tool, an event stream, a hash-chained audit log — and recorded nothing at
// all about what the PERSON had to do to get the job finished. So the one
// question that decides whether an OS agent is actually usable ("how often did I
// have to take over?") was unanswerable over a week of use, in exactly the way
// `failureReason` was: computed on every path and persisted nowhere.
//
// The idea is from arXiv:2605.13357 (AI Harness Engineering), which names
// `intervention recording` as one of eleven harness responsibilities and defines
// the missing-harness human intervention rate:
//
//     M-HIR = missing-harness interventions / episodes
//
// and its argument for it is the part worth keeping: in conventional agent
// evaluation a human helping mid-run is either disallowed or treated as noise.
// Here it is the most valuable diagnostic there is, because each kind of help
// names a DIFFERENT missing component. A user who has to say which window it is
// has found a perception gap; a user who has to click a control themselves has
// found a grounding gap; a user who has to stop a run has found a gap in this
// loop's own convergence guards.
//
// THE DISTINCTION THAT MAKES THIS USABLE, AND IT IS THIS CODEBASE'S OWN RULE.
//
// An approval card is NOT a missing-harness intervention. It is the permission
// boundary working exactly as designed, and counting it as a defect would make
// the metric say that the safest possible run is the worst one — which would put
// pressure on the gates, and `shell-rules.js` already records where that ends:
// "a gate that refuses arbitrary things trains the thing it is gating to evade
// it." The same goes for the user answering no. `index.js` states it plainly:
// **a boundary is not a defect, and the user saying no is an answer, not an
// obstacle.**
//
// So `avoidable` is set per KIND, from that rule, and never from the outcome.

/** The kinds of help a person can give a run, and what each one means. */
export const InterventionKind = Object.freeze({
  /** A gate asked, and the person answered. The boundary working. */
  APPROVAL_ASKED: "approval-asked",
  /** They said no. An answer, not an obstacle — see the note above. */
  APPROVAL_DECLINED: "approval-declined",
  /** They pressed stop. The run did not decide for itself that it was going nowhere. */
  USER_STOPPED: "user-stopped",
  /** The agent ran out of approaches and asked a question instead of finishing. */
  AGENT_ASKED: "agent-asked",
  /** A saved route stopped part-way and handed the task back to the model. */
  SKILL_HANDOVER: "skill-handover",
  /** The person did the step themselves — reported by the surface, not inferred. */
  TOOK_OVER: "took-over"
});

// Which kinds mean the harness was missing something, and WHICH something.
//
// `gap` names the component from the eleven, so a week of logs answers "what
// should we build next" rather than only "how often did this go wrong". Nothing
// here is inferred from how the run ended: the kind decides it, always, so the
// metric cannot be improved by getting luckier.
const MEANING = Object.freeze({
  [InterventionKind.APPROVAL_ASKED]: {
    avoidable: false,
    gap: null,
    why: "the permission boundary asked before an irreversible action, which is the design"
  },
  [InterventionKind.APPROVAL_DECLINED]: {
    avoidable: false,
    gap: null,
    why: "the user declined, which is an answer rather than a failure"
  },
  [InterventionKind.USER_STOPPED]: {
    avoidable: true,
    gap: "task-state",
    why: "the run did not work out for itself that it should stop, so a person had to"
  },
  [InterventionKind.AGENT_ASKED]: {
    avoidable: true,
    gap: "context-manager",
    why: "the agent could not find what it needed and had to ask rather than finish"
  },
  [InterventionKind.SKILL_HANDOVER]: {
    avoidable: true,
    gap: "project-memory",
    why: "a saved route did not survive the situation it met and fell back to the model"
  },
  [InterventionKind.TOOK_OVER]: {
    avoidable: true,
    gap: "tool-registry",
    why: "the person did the step by hand, so no tool here could reach it"
  }
});

/** What a kind means, for a caller that wants to explain one. */
export function meaningOf(kind) {
  return MEANING[kind] ?? { avoidable: true, gap: "unknown", why: "unrecognised intervention" };
}

/**
 * The interventions of one run.
 *
 * Deliberately in memory and deliberately tiny: it is built during a run whether
 * or not anything consumes it, so it may not cost a syscall, may not throw, and
 * may not grow without bound. A run that needs help forty times has a problem
 * this list is not going to solve by recording all forty.
 */
const MAX_RECORDED = 40;

export class InterventionLog {
  constructor() {
    this.entries = [];
    this.overflowed = 0;
  }

  /**
   * Record one, and never throw.
   *
   * Called from inside the tool loop and from the approval path, both of which
   * are on the hot path and neither of which may fail because bookkeeping did.
   */
  record(kind, { detail = null, at = Date.now() } = {}) {
    if (!MEANING[kind]) return null;
    if (this.entries.length >= MAX_RECORDED) {
      this.overflowed += 1;
      return null;
    }
    const meaning = MEANING[kind];
    const entry = Object.freeze({
      kind,
      at,
      avoidable: meaning.avoidable,
      gap: meaning.gap,
      why: meaning.why,
      // Bounded: a detail is a window name or a rule id, never a screen reading.
      detail: detail == null ? null : String(detail).slice(0, 200)
    });
    this.entries.push(entry);
    return entry;
  }

  all() {
    return [...this.entries];
  }

  /** How many times a person did something this harness should have done. */
  missingHarnessCount() {
    return this.entries.filter((entry) => entry.avoidable).length;
  }

  /** Was the person asked for anything at all? Decides ASSISTED vs AUTONOMOUS. */
  assisted() {
    return this.entries.length > 0;
  }

  /** The components that would have removed the help, most pressing first. */
  gaps() {
    const counts = new Map();
    for (const entry of this.entries) {
      if (!entry.avoidable || !entry.gap) continue;
      counts.set(entry.gap, (counts.get(entry.gap) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([gap, count]) => ({ gap, count }));
  }

  /**
   * The run's own line in the ledger.
   *
   * `missingHarness` is the numerator of M-HIR; the denominator is episodes, and
   * that is counted where episodes are, not here.
   */
  summary() {
    return {
      total: this.entries.length + this.overflowed,
      recorded: this.entries.length,
      missingHarness: this.missingHarnessCount(),
      assisted: this.assisted(),
      gaps: this.gaps(),
      kinds: this.entries.reduce((counts, entry) => {
        counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
        return counts;
      }, {})
    };
  }
}
