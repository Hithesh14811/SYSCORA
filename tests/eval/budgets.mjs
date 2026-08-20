// WHAT THE EVAL IS FOR. Without this it is a report; with it, it is a gate.
//
// Lives apart from the runner so it can be tested against real recorded runs.
// `runner.mjs` executes `main()` on import, so anything that needs to CHECK the
// gate — a unit test, a probe re-deriving budgets from a saved results file —
// cannot import it there without driving Notepad and WhatsApp around. The
// alternative is a test that reimplements the formula, which passes just as
// happily when the real one is reverted, and this project has been bitten by
// exactly that shape of hollow check more than once.

export const median = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// THE SIZE OF THE REGRESSION THIS GATE IS SUPPOSED TO CATCH.
//
// Stated as a number rather than left implicit, because every ceiling below is
// sized against it and because the scoreboard reports, per row, whether that row
// can actually see something this small. A gate whose sensitivity is unstated is
// a gate nobody can trust.
export const DETECTS = 1.2;

// A row that costs less than this cannot meaningfully regress by 20%: twenty per
// cent of ninety-seven tokens is nineteen tokens, which is one different word in
// one reply. Detectability is therefore only claimed — and only demanded — of
// rows where the money is.
export const MATTERS_ABOVE_FRESH = 1000;
export const MATTERS_ABOVE_MS = 5000;

// HOW MUCH WORSE THAN THE BASELINE IS STILL NOISE — PER ROW, AND MEASURED.
//
// This replaced a flat `median x 1.4, or max x 1.1, whichever is larger`. That
// rule had one number for twenty rows of wildly different steadiness, and it was
// sized against the spread of a SINGLE run while the thing it compares is the
// MEDIAN of three. So it was loose everywhere: `messaging-send-to-self` varies
// by 9% run to run and was given 40% of headroom, which means a change that made
// the flagship send a third more expensive would have passed as green.
//
// Now each row gets headroom proportional to ITS OWN observed spread, with a
// floor for the steady ones. A row that really is steady becomes a sharp
// instrument; a row that thrashes stays blunt and SAYS SO on the scoreboard
// rather than pretending.
const MIN_MARGIN = 0.15;

// On top of the proportional margin, not instead of it. A row costing 97 tokens
// has a relative spread of zero on a good day and jumps to 200 the moment the
// model writes a longer sentence; without an absolute allowance the steadiest
// rows would be the ones crying wolf. Sized to be irrelevant on an expensive row
// and decisive on a cheap one.
const FRESH_ALLOWANCE = 120;
const TIME_ALLOWANCE_MS = 1200;
const STEP_ALLOWANCE = 1;

const marginOf = (middle, low, high) => {
  if (!(middle > 0)) return MIN_MARGIN;
  return Math.max(MIN_MARGIN, (high - low) / middle);
};

const freshCeiling = (summary) =>
  Math.round(summary.medianFresh * (1 + marginOf(summary.medianFresh, summary.minFresh, summary.maxFresh)))
  + FRESH_ALLOWANCE;

const timeCeiling = (summary) =>
  Math.round(summary.medianElapsedMs * (1 + marginOf(summary.medianElapsedMs, summary.minElapsedMs, summary.maxElapsedMs)))
  + TIME_ALLOWANCE_MS;

const stepCeiling = (summary) =>
  Math.ceil(summary.medianSteps * (1 + MIN_MARGIN)) + STEP_ALLOWANCE;

/**
 * Could this row see a `DETECTS` regression, or is its own noise larger than the
 * thing we are looking for?
 *
 * Reported per row and counted in the summary. On a row too noisy to see it, the
 * honest answer is "no" — printing a ceiling and letting a reader assume it means
 * something is how a gate stops being one.
 */
export function detectability(summary, ceilings) {
  const freshMatters = summary.medianFresh >= MATTERS_ABOVE_FRESH;
  const timeMatters = summary.medianElapsedMs >= MATTERS_ABOVE_MS;
  return {
    freshMatters,
    timeMatters,
    fresh: freshMatters && summary.medianFresh * DETECTS > ceilings.freshTokens,
    time: timeMatters && summary.medianElapsedMs * DETECTS > ceilings.elapsedMs
  };
}

export function budgetsFrom(summaries, meta) {
  return {
    recordedAt: meta.at,
    model: meta.model,
    repeat: meta.repeat,
    detects: DETECTS,
    note:
      "Recorded from a measured baseline with --write-budgets, not chosen by hand. Each ceiling is " +
      "that row's baseline MEDIAN plus headroom proportional to that row's OWN measured spread, " +
      "with a floor. A later run breaches when ITS median exceeds the ceiling, so one unlucky run " +
      "cannot fail the gate and a row that got quietly more expensive cannot pass it. " +
      "`detects20` says whether the row is steady enough to see a 20% regression at this repeat " +
      "count; where it is false the row is reported, not gated on, and raising --repeat is what " +
      "fixes it.",
    tasks: Object.fromEntries(summaries.map((summary) => {
      const ceilings = {
        freshTokens: freshCeiling(summary),
        elapsedMs: timeCeiling(summary),
        steps: stepCeiling(summary)
      };
      const detects = detectability(summary, ceilings);
      return [summary.id, {
        ...ceilings,
        detects20: { fresh: detects.fresh, time: detects.time },
        baseline: {
          pass: summary.pass,
          passes: `${summary.passes}/${summary.runs}`,
          medianFresh: summary.medianFresh,
          medianElapsedMs: summary.medianElapsedMs,
          medianSteps: summary.medianSteps,
          // How wide this row is. A row whose worst run is three times its median
          // cannot detect a small regression, and knowing that is the difference
          // between reading the scoreboard and believing it.
          spread: `${summary.minFresh}–${summary.maxFresh} fresh · ` +
            `${(summary.minElapsedMs / 1000).toFixed(1)}–${(summary.maxElapsedMs / 1000).toFixed(1)}s`
        }
      }];
    }))
  };
}

export function checkBudgets(summaries, budgets) {
  if (!budgets) return [];
  const breaches = [];
  for (const summary of summaries) {
    const budget = budgets.tasks?.[summary.id];
    if (!budget) continue;
    // A TASK THAT USED TO PASS AND NOW DOES NOT IS THE WORST REGRESSION THERE IS,
    // and it is not a token budget — so it is checked here rather than left to
    // the pass column, where a task that was already failing at baseline would
    // have made the whole gate red forever and got the gate switched off.
    if (budget.baseline?.pass && !summary.pass) {
      breaches.push(`${summary.id}: passed ${budget.baseline.passes} at baseline, now ${summary.passes}/${summary.runs}` +
        (summary.reason ? ` — ${summary.reason}` : ""));
    }
    if (summary.medianFresh > budget.freshTokens) {
      breaches.push(`${summary.id}: ${summary.medianFresh.toLocaleString()} fresh tokens against a ceiling of ` +
        `${budget.freshTokens.toLocaleString()} (baseline median ${budget.baseline?.medianFresh?.toLocaleString() ?? "?"})`);
    }
    if (summary.medianElapsedMs > budget.elapsedMs) {
      breaches.push(`${summary.id}: ${(summary.medianElapsedMs / 1000).toFixed(1)}s against a ceiling of ` +
        `${(budget.elapsedMs / 1000).toFixed(1)}s (baseline median ${((budget.baseline?.medianElapsedMs ?? 0) / 1000).toFixed(1)}s)`);
    }
    if (summary.medianSteps > budget.steps) {
      breaches.push(`${summary.id}: ${summary.medianSteps} steps against a ceiling of ${budget.steps} ` +
        `(baseline median ${budget.baseline?.medianSteps ?? "?"})`);
    }
  }
  return breaches;
}

/**
 * How much the headline median moves between identical passes over the suite.
 *
 * THE NUMBER THAT STOPPED BEING A GATE. `Median fresh tokens` is a
 * median-of-medians over a suite dominated by cheap rows, so the middle of the
 * list drifts for free: the SAME COMMIT scored 212 and 186 on consecutive runs,
 * which is 13% of movement with no code change at all. A gate that noisy cannot
 * see the 20% regression it exists to catch.
 *
 * Every repeat is a complete independent sweep of the suite, so the spread
 * between per-repeat medians is that noise, measured from the run's own data
 * rather than asserted. Reported beside the headline so nobody gates on it again
 * without seeing what it is worth.
 *
 * Returns null when there is only one repeat — with one sweep there is no band,
 * and inventing one would be worse than admitting it.
 */
export function noiseBand(summaries, pick) {
  const depth = Math.min(...summaries.map((summary) => summary.runs ?? 0));
  if (!Number.isFinite(depth) || depth < 2) return null;
  const perRepeat = [];
  for (let index = 0; index < depth; index += 1) {
    perRepeat.push(median(summaries.map((summary) => pick(summary)[index])));
  }
  const low = Math.min(...perRepeat);
  const high = Math.max(...perRepeat);
  const middle = median(perRepeat);
  return {
    sweeps: depth,
    perRepeat,
    low,
    high,
    // As a share of the middle, which is how it has to be compared against the
    // 20% the gate is looking for.
    swingPercent: middle > 0 ? Math.round(((high - low) / middle) * 100) : 0
  };
}
