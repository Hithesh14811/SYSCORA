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

// A row that sends less than this cannot meaningfully regress by 20%: a one-step
// row sends the fixed 8,500-token prefix and little else, and 20% of that is a
// longer sentence. Detectability is therefore only claimed — and only demanded —
// of rows doing enough work for it to mean something.
export const MATTERS_ABOVE_SENT = 25000;
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
// Sized against what the gate is looking for: margin plus allowance has to stay
// UNDER the 20% regression it claims to catch, or the claim is false on every
// row. At 0.12 a row sending 57,000 tokens gets a ceiling of 65,168 and a 20%
// regression lands at 68,216 — caught, with 14% of headroom above that row's own
// worst observed run.
const MIN_MARGIN = 0.12;

// On top of the proportional margin, not instead of it. A row costing 97 tokens
// has a relative spread of zero on a good day and jumps to 200 the moment the
// model writes a longer sentence; without an absolute allowance the steadiest
// rows would be the ones crying wolf. Sized to be irrelevant on an expensive row
// and decisive on a cheap one.
// Small on purpose. An absolute allowance exists so the cheapest rows do not
// breach on a single longer sentence, and every token of it eats into the
// sensitivity of the expensive rows — which are the only ones the gate claims to
// be sharp on. Rows below MATTERS_ABOVE_SENT are excluded from that claim
// anyway, so this only has to cover their ordinary jitter: a one-step row was
// measured at 9,465-9,567 tokens sent across a suite.
const SENT_ALLOWANCE = 1500;
const TIME_ALLOWANCE_MS = 1200;
const STEP_ALLOWANCE = 1;

const marginOf = (middle, low, high) => {
  if (!(middle > 0)) return MIN_MARGIN;
  return Math.max(MIN_MARGIN, (high - low) / middle);
};

// THE COST METRIC THE GATE USES IS NOT THE COST METRIC THE INVOICE USES, AND
// THAT IS NOT A CONTRADICTION.
//
// `tokensFresh` is money — it is what the endpoint bills at full rate, and every
// figure quoted to a human should be in it. It is also HOSTAGE TO THE PROVIDER'S
// CACHE, which is not part of this codebase and does not change when the code
// does. Measured 21 Aug 2026, the drawing row run six times on identical code
// inside twenty minutes:
//
//   cache hit 97.8-98.7%   fresh   7,912 - 12,809
//   cache hit 66.6-73.1%   fresh  48,753 - 103,455
//
// At the SAME 23 steps that is 7,912 against 103,455 — thirteen times — while
// `tokensIn` for those two runs was 353,512 and 326,431, eight per cent apart.
// So a gate on fresh tokens fires when someone else's cache went cold, and a
// gate that cries wolf gets switched off.
//
// `tokensIn` is what the agent actually did: how many steps, carrying how much
// conversation. It moves when the AGENT changes and holds still when only the
// endpoint does. That is the definition of the signal this gate wants.
//
// Fresh tokens stay on the scoreboard, beside the cache rate that explains them,
// and are not gated on.
const sentCeiling = (summary) =>
  Math.round(summary.medianTokensIn * (1 + marginOf(summary.medianTokensIn, summary.minTokensIn, summary.maxTokensIn)))
  + SENT_ALLOWANCE;

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
  const sentMatters = summary.medianTokensIn >= MATTERS_ABOVE_SENT;
  const timeMatters = summary.medianElapsedMs >= MATTERS_ABOVE_MS;
  return {
    sentMatters,
    timeMatters,
    sent: sentMatters && summary.medianTokensIn * DETECTS > ceilings.tokensIn,
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
      "COST IS GATED ON tokensIn, NOT tokensFresh: fresh tokens are the money but they are decided " +
      "by the provider's cache, which moved the drawing row between 7,912 and 103,455 on identical " +
      "code in twenty minutes. tokensIn moved 8% across the same pair. " +
      "`detects20` says whether the row is steady enough to see a 20% regression at this repeat " +
      "count; where it is false the row is reported, not gated on, and raising --repeat is what " +
      "fixes it.",
    tasks: Object.fromEntries(summaries.map((summary) => {
      const ceilings = {
        tokensIn: sentCeiling(summary),
        elapsedMs: timeCeiling(summary),
        steps: stepCeiling(summary)
      };
      const detects = detectability(summary, ceilings);
      return [summary.id, {
        ...ceilings,
        detects20: { sent: detects.sent, time: detects.time },
        baseline: {
          pass: summary.pass,
          passes: `${summary.passes}/${summary.runs}`,
          medianTokensIn: summary.medianTokensIn,
          medianFresh: summary.medianFresh,
          // What share of the input the endpoint served from its cache when this
          // baseline was recorded. Not gated on — it is the provider's business,
          // not the code's — but a later run whose fresh tokens look alarming
          // should be read against this before anyone goes looking for a bug.
          cacheHitRate: summary.medianCacheRate,
          medianElapsedMs: summary.medianElapsedMs,
          medianSteps: summary.medianSteps,
          // How wide this row is. A row whose worst run is three times its median
          // cannot detect a small regression, and knowing that is the difference
          // between reading the scoreboard and believing it.
          spread: `${summary.minTokensIn?.toLocaleString()}–${summary.maxTokensIn?.toLocaleString()} sent · ` +
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
    // A NOISY ROW IS GATED BLUNTLY, NOT LEFT UNGATED. `detects20` is a REPORT on
    // whether this row could see a 20% regression, and it is deliberately not a
    // switch: suppressing the ceilings where it is false would leave the widest
    // rows — the expensive ones — unguarded at any magnitude. The protection for
    // a noisy row is that its ceiling is WIDE, sized from its own spread, so 20%
    // fits under it and 250% does not. That was tried as a switch on 21 Aug 2026
    // and "a row too noisy for 20% still catches a large regression" caught it
    // immediately, which is the test doing exactly what it was written for.
    //
    // What actually went wrong on that run was upstream of here: see the
    // `rederived` blocks in budgets.json. A ceiling is only wide when the sweep
    // it was recorded from actually OBSERVED the row's spread.
    if (budget.tokensIn && summary.medianTokensIn > budget.tokensIn) {
      breaches.push(`${summary.id}: ${summary.medianTokensIn.toLocaleString()} tokens sent against a ceiling of ` +
        `${budget.tokensIn.toLocaleString()} (baseline median ${budget.baseline?.medianTokensIn?.toLocaleString() ?? "?"})`);
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

export const spread = (numbers, format = (value) => value.toLocaleString()) => {
  if (numbers.length <= 1) return "";
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return low === high ? "" : `${format(low)}–${format(high)}`;
};

// One row per task, whatever the repeat count. Runs stay in the JSON record for
// anyone who wants to look at an individual one.
export function summarise(records, costOf = () => 0) {
  const byTask = new Map();
  for (const record of records) {
    if (!byTask.has(record.id)) byTask.set(record.id, []);
    byTask.get(record.id).push(record);
  }
  return [...byTask.entries()].map(([id, runs]) => {
    const fresh = runs.map((run) => run.tokensFresh);
    const sent = runs.map((run) => run.tokensIn);
    const times = runs.map((run) => run.elapsedMs);
    const steps = runs.map((run) => run.steps);
    const passes = runs.filter((run) => run.pass).length;
    return {
      id,
      category: runs[0].category,
      runs: runs.length,
      passes,
      // A task that passes twice out of three is not a passing task. Anything
      // less than every run is a flake, and a flake is a defect that has not
      // been diagnosed yet — grading it as a pass is how it stays undiagnosed.
      pass: passes === runs.length,
      medianFresh: median(fresh),
      medianElapsedMs: median(times),
      medianSteps: median(steps),
      medianTokensSent: median(runs.map((run) => run.tokensIn + run.tokensOut)),
      // IN REPEAT ORDER, not sorted. Every repeat is a complete sweep of the
      // suite, so lining the rows up by repeat index is what lets the scoreboard
      // measure how much its own headline moves between identical passes. Sorting
      // these would destroy exactly that.
      freshRuns: fresh,
      sentRuns: sent,
      elapsedRuns: times,
      // WHAT THE AGENT DID, as distinct from what it was billed. See budgets.mjs:
      // fresh tokens are decided by the provider's cache and moved 13x on
      // identical code; tokens SENT moved 8% across the same pair.
      medianTokensIn: median(sent),
      minTokensIn: Math.min(...sent),
      maxTokensIn: Math.max(...sent),
      // The number that explains a fresh-token swing before anyone hunts a bug.
      medianCacheRate: median(runs.map((run) =>
        (run.tokensIn > 0 ? Math.round((run.tokensCached / run.tokensIn) * 1000) / 10 : 0))),
      minFresh: Math.min(...fresh),
      maxFresh: Math.max(...fresh),
      minElapsedMs: Math.min(...times),
      maxElapsedMs: Math.max(...times),
      maxSteps: Math.max(...steps),
      freshSpread: spread(fresh),
      timeSpread: spread(times, (value) => `${(value / 1000).toFixed(1)}s`),
      stepSpread: spread(steps),
      cost: runs.reduce((sum, run) => sum + costOf(run), 0) / runs.length,
      tools: runs.find((run) => run.tools.length)?.tools ?? [],
      reason: runs.find((run) => !run.pass)?.reason ?? null
    };
  });
}
