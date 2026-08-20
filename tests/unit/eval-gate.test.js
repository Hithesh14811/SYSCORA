// CAN THE GATE SEE THE REGRESSION IT EXISTS TO CATCH?
//
// The eval's headline "median fresh tokens" was being read as a merge gate and
// is not one: it is a median-of-medians over a suite where most rows cost a few
// hundred tokens, and the SAME COMMIT scored 212 and 186 on consecutive runs.
// 13% of movement with no code change cannot detect a 20% regression.
//
// The per-row budgets are the instrument. These tests hold that instrument to
// its claim, in both directions — it must fire on a 20% regression in a steady
// row, and it must NOT fire on a row whose own noise is larger than 20%, because
// a gate that cries wolf gets switched off and this project has already written
// that down twice.
//
// They import the real functions rather than restating the formula. A test that
// reimplements the thing it checks passes just as happily when the real one is
// reverted.

import test from "node:test";
import assert from "node:assert/strict";
import { budgetsFrom, checkBudgets, noiseBand, DETECTS } from "../../tests/eval/budgets.mjs";

// A summary in the shape `summarise()` produces, from the runs themselves so the
// medians and spreads cannot disagree with the data they came from.
function rowFrom(id, fresh, elapsed = fresh.map(() => 5000), steps = fresh.map(() => 2)) {
  const mid = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  return {
    id,
    category: "test",
    runs: fresh.length,
    passes: fresh.length,
    pass: true,
    medianFresh: mid(fresh),
    medianElapsedMs: mid(elapsed),
    medianSteps: mid(steps),
    freshRuns: fresh,
    elapsedRuns: elapsed,
    minFresh: Math.min(...fresh),
    maxFresh: Math.max(...fresh),
    minElapsedMs: Math.min(...elapsed),
    maxElapsedMs: Math.max(...elapsed),
    maxSteps: Math.max(...steps),
    reason: null
  };
}

const META = { at: "2026-08-21T00:00:00.000Z", model: "test", repeat: 3 };
const worseBy = (row, factor) => rowFrom(
  row.id,
  row.freshRuns.map((value) => Math.round(value * factor)),
  row.elapsedRuns,
  [2, 2, 2]
);

// The real numbers from `messaging-send-to-self` — the flagship WhatsApp send —
// on 20 Aug 2026. It varies by 9% run to run, which is steady enough to gate.
const STEADY = rowFrom("messaging-send-to-self", [3691, 3946, 4055], [17800, 17900, 18600]);
// And from `app-type-into-notepad-and-save` the same day, which does not: its
// worst run is more than twice its median.
const THRASHES = rowFrom("app-type-into-notepad-and-save", [2569, 2960, 6253], [43400, 46500, 95100]);

test("a 20% cost regression on a steady row breaches its budget", () => {
  const budgets = budgetsFrom([STEADY], META);
  const breaches = checkBudgets([worseBy(STEADY, DETECTS)], budgets);
  assert.equal(breaches.length, 1,
    "20% more expensive on a row that varies by 9% is the regression this gate exists to catch");
  assert.match(breaches[0], /messaging-send-to-self: .* fresh tokens against a ceiling of/);
});

test("the same row unchanged does not breach — the gate must not cry wolf", () => {
  const budgets = budgetsFrom([STEADY], META);
  // Not the identical numbers: the row's own worst observed run, which is what a
  // later run of unchanged code is entitled to produce.
  const unlucky = rowFrom(STEADY.id, [4055, 4055, 4055], STEADY.elapsedRuns);
  assert.deepEqual(checkBudgets([unlucky], budgets), [],
    "a run at the baseline's own worst measurement is noise, not a regression");
});

test("a row noisier than the regression size is reported as unable to see it, and is not gated on it", () => {
  const budgets = budgetsFrom([THRASHES], META);
  assert.equal(budgets.tasks[THRASHES.id].detects20.fresh, false,
    "this row's spread is 124% of its median; claiming it can see 20% would be a lie");
  assert.deepEqual(checkBudgets([worseBy(THRASHES, DETECTS)], budgets), [],
    "tightening this row to catch 20% would fail on its own variance instead");
});

test("a row too noisy for 20% still catches a large regression", () => {
  const budgets = budgetsFrom([THRASHES], META);
  const breaches = checkBudgets([worseBy(THRASHES, 2.5)], budgets);
  assert.equal(breaches.length, 1,
    "blunt is not blind: a row that got two and a half times more expensive must still be caught");
});

test("the steady row is the one claimed to be sharp, and the claim is recorded", () => {
  const budgets = budgetsFrom([STEADY, THRASHES], META);
  assert.equal(budgets.tasks[STEADY.id].detects20.fresh, true);
  assert.equal(budgets.tasks[THRASHES.id].detects20.fresh, false);
  assert.equal(budgets.detects, DETECTS,
    "the size of regression the ceilings are sized against belongs in the file, not in someone's head");
});

test("a row that passed at baseline and now fails is a breach whatever it costs", () => {
  const budgets = budgetsFrom([STEADY], META);
  const failing = { ...worseBy(STEADY, 0.5), pass: false, passes: 1, reason: "the message was never sent" };
  const breaches = checkBudgets([failing], budgets);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /passed 3\/3 at baseline, now 1\/3 — the message was never sent/,
    "getting cheaper by failing is the oldest way to win a benchmark");
});

// THE BAND IS MEASURED ACROSS SWEEPS, NOT ACROSS ROWS.
//
// Each repeat is one complete pass over the suite, so the noise of the headline
// is how much it moves between passes. Sorting each row's runs before pairing
// them up would pair every row's best run with every other row's best run and
// report a band several times too wide — which is why `freshRuns` is documented
// as being in repeat order.
test("the noise band pairs runs by repeat, not by rank", () => {
  const band = noiseBand(
    [rowFrom("a", [100, 300]), rowFrom("b", [300, 100])],
    (summary) => summary.freshRuns
  );
  assert.equal(band.sweeps, 2);
  assert.deepEqual(band.perRepeat, [200, 200],
    "sweep one is 100 and 300, sweep two is 300 and 100; both have a median of 200");
  assert.equal(band.swingPercent, 0,
    "this suite is perfectly stable sweep to sweep — sorting the runs first would report 100% swing");
});

test("one sweep has no band, and does not invent one", () => {
  assert.equal(noiseBand([rowFrom("a", [100])], (summary) => summary.freshRuns), null,
    "a single pass cannot measure its own reproducibility");
});
