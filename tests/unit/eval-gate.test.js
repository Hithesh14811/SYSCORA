// CAN THE GATE SEE THE REGRESSION IT EXISTS TO CATCH?
//
// The eval's headline "median fresh tokens" was being read as a merge gate and
// is not one: it is a median-of-medians over a suite where most rows cost a few
// hundred tokens, and the SAME COMMIT scored 212 and 186 on consecutive runs.
//
// Worse, fresh tokens are decided by the PROVIDER'S CACHE. Measured 21 Aug 2026,
// the drawing row on identical code twenty minutes apart: 7,912 fresh at a 98%
// cache hit rate, 103,455 fresh at 68%. Thirteen times, for nothing the code did.
// Tokens SENT across that same pair moved 8%. So the gate is on tokens sent —
// what the agent actually did — and fresh tokens are reported as money beside
// the cache rate that explains them.
//
// These tests hold the instrument to its claim in both directions: it must fire
// on a 20% regression in a steady row, and it must NOT fire on a row whose own
// noise is larger than 20%, because a gate that cries wolf gets switched off and
// this project has already written that down twice.
//
// They import the real functions rather than restating the formula. A test that
// reimplements the thing it checks passes just as happily when the real one is
// reverted.

import test from "node:test";
import assert from "node:assert/strict";
import { budgetsFrom, checkBudgets, noiseBand, DETECTS } from "../eval/budgets.mjs";

// A summary in the shape `summarise()` produces, built from the runs themselves
// so the medians and spreads cannot disagree with the data they came from.
function rowFrom(id, sent, elapsed = sent.map(() => 5000), steps = sent.map(() => 2)) {
  const mid = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  return {
    id,
    category: "test",
    runs: sent.length,
    passes: sent.length,
    pass: true,
    medianTokensIn: mid(sent),
    minTokensIn: Math.min(...sent),
    maxTokensIn: Math.max(...sent),
    medianCacheRate: 98,
    medianFresh: Math.round(mid(sent) * 0.02),
    minFresh: Math.round(Math.min(...sent) * 0.02),
    maxFresh: Math.round(Math.max(...sent) * 0.02),
    medianElapsedMs: mid(elapsed),
    medianSteps: mid(steps),
    sentRuns: sent,
    elapsedRuns: elapsed,
    minElapsedMs: Math.min(...elapsed),
    maxElapsedMs: Math.max(...elapsed),
    maxSteps: Math.max(...steps),
    reason: null
  };
}

const META = { at: "2026-08-21T00:00:00.000Z", model: "test", repeat: 3 };
const worseBy = (row, factor) => rowFrom(
  row.id,
  row.sentRuns.map((value) => Math.round(value * factor)),
  row.elapsedRuns,
  [2, 2, 2]
);

// Real numbers, 20 Aug 2026. `messaging-send-to-self` — the flagship WhatsApp
// send — sends within 1% of the same total every run.
const STEADY = rowFrom("messaging-send-to-self", [55659, 56042, 56151], [17800, 17900, 18600]);
// `draw-shape-in-paint`, measured the next day, does not: its worst run sends
// nearly twice what its median does, because how long it flounders in Paint's
// Save-As dialog decides the whole run.
const THRASHES = rowFrom("draw-shape-in-paint", [177901, 180977, 326431], [70500, 72300, 89400]);

test("a 20% regression on a steady row breaches its budget", () => {
  const budgets = budgetsFrom([STEADY], META);
  const breaches = checkBudgets([worseBy(STEADY, DETECTS)], budgets);
  assert.equal(breaches.length, 1,
    "20% more work on a row that varies by 1% is the regression this gate exists to catch");
  assert.match(breaches[0], /messaging-send-to-self: .* tokens sent against a ceiling of/);
});

test("the same row unchanged does not breach — the gate must not cry wolf", () => {
  const budgets = budgetsFrom([STEADY], META);
  // Not the identical numbers: the row's own worst observed run, every time,
  // which is what a later run of unchanged code is entitled to produce.
  const unlucky = rowFrom(STEADY.id, [56151, 56151, 56151], STEADY.elapsedRuns);
  assert.deepEqual(checkBudgets([unlucky], budgets), [],
    "a run at the baseline's own worst measurement is noise, not a regression");
});

test("a row noisier than the regression size is reported as unable to see it, and is not gated on it", () => {
  const budgets = budgetsFrom([THRASHES], META);
  assert.equal(budgets.tasks[THRASHES.id].detects20.sent, false,
    "this row's spread is 82% of its median; claiming it can see 20% would be a lie");
  assert.deepEqual(checkBudgets([worseBy(THRASHES, DETECTS)], budgets), [],
    "tightening this row to catch 20% would fail on its own variance instead");
});

test("a row too noisy for 20% still catches a large regression", () => {
  const budgets = budgetsFrom([THRASHES], META);
  assert.equal(checkBudgets([worseBy(THRASHES, 2.5)], budgets).length, 1,
    "blunt is not blind: a row doing two and a half times the work must still be caught");
});

test("the steady row is the one claimed to be sharp, and the claim is recorded", () => {
  const budgets = budgetsFrom([STEADY, THRASHES], META);
  assert.equal(budgets.tasks[STEADY.id].detects20.sent, true);
  assert.equal(budgets.tasks[THRASHES.id].detects20.sent, false);
  assert.equal(budgets.detects, DETECTS,
    "the size of regression the ceilings are sized against belongs in the file, not in someone's head");
});

// FRESH TOKENS MUST NOT BE GATED ON, however alarming they look. This is the
// cache-collapse case as measured: the agent did slightly LESS work, and the
// endpoint served a fraction of what it served before.
test("a collapse in the provider's cache is not a regression", () => {
  const budgets = budgetsFrom([STEADY], META);
  const cacheWentCold = {
    ...rowFrom(STEADY.id, [55000, 55200, 55300], STEADY.elapsedRuns),
    medianFresh: 103455,
    minFresh: 48753,
    maxFresh: 103455,
    medianCacheRate: 68
  };
  assert.deepEqual(checkBudgets([cacheWentCold], budgets), [],
    "13x the fresh tokens for less work is the provider's cache, not the code, and failing a build on it is how a gate gets switched off");
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
// report a band several times too wide — which is why the per-run arrays are
// documented as being in repeat order.
test("the noise band pairs runs by repeat, not by rank", () => {
  const band = noiseBand(
    [rowFrom("a", [100, 300]), rowFrom("b", [300, 100])],
    (summary) => summary.sentRuns
  );
  assert.equal(band.sweeps, 2);
  assert.deepEqual(band.perRepeat, [200, 200],
    "sweep one is 100 and 300, sweep two is 300 and 100; both have a median of 200");
  assert.equal(band.swingPercent, 0,
    "this suite is perfectly stable sweep to sweep — sorting the runs first would report 100% swing");
});

test("one sweep has no band, and does not invent one", () => {
  assert.equal(noiseBand([rowFrom("a", [100])], (summary) => summary.sentRuns), null,
    "a single pass cannot measure its own reproducibility");
});
