// DOES THE GATE CRY WOLF, AND CAN IT SEE A REAL REGRESSION?
//
//   node scripts/probe-gate-sensitivity.mjs <baseline-results.json> <later-results.json>
//
// The unit tests hold the budget formula to its claim on fixtures. This holds it
// to two REAL runs of the same code, which is the only way to answer the
// question that actually matters: how often does this gate go red for nothing?
//
// A tightened ceiling is worthless if unchanged code breaches it, because a gate
// that cries wolf gets switched off — this codebase has written that down twice
// and reverted two audits for it. So: derive budgets from run A, check run B,
// and count the breaches. Every one of them is a false alarm by construction.
//
// Then inject a 20% regression into each row in turn and count how many the gate
// catches. Those two numbers together are the gate's honest specification.
//
// Results files are gitignored, so run this against whatever is in
// tests/eval/results/ on the machine at hand.

import fs from "node:fs/promises";
import path from "node:path";
import { budgetsFrom, checkBudgets, DETECTS, MATTERS_ABOVE_FRESH } from "../tests/eval/budgets.mjs";

const [baselinePath, laterPath] = process.argv.slice(2);
if (!baselinePath || !laterPath) {
  console.error("Need two results files. See tests/eval/results/.");
  process.exit(1);
}

const read = async (file) => JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
const baseline = await read(baselinePath);
const later = await read(laterPath);

const summariesOf = (saved) => saved.summaries;
const meta = { at: baseline.at, model: baseline.model, repeat: baseline.repeat ?? 3 };
const budgets = budgetsFrom(summariesOf(baseline), meta);

console.log(`\nbaseline  ${path.basename(baselinePath)}  ${baseline.commit}`);
console.log(`later     ${path.basename(laterPath)}  ${later.commit}\n`);

// ---- 1. False alarms ---------------------------------------------------------

const falseAlarms = checkBudgets(summariesOf(later), budgets);
console.log(`FALSE ALARMS: ${falseAlarms.length}`);
for (const breach of falseAlarms) console.log(`  - ${breach}`);
if (!falseAlarms.length) console.log("  none — unchanged code stayed inside every ceiling");

// ---- 2. Real sensitivity, row by row -----------------------------------------

const worse = (summary, factor) => ({
  ...summary,
  medianFresh: Math.round(summary.medianFresh * factor),
  minFresh: Math.round(summary.minFresh * factor),
  maxFresh: Math.round(summary.maxFresh * factor)
});

const costly = summariesOf(later).filter((summary) => summary.medianFresh >= MATTERS_ABOVE_FRESH);
console.log(`\nA ${Math.round((DETECTS - 1) * 100)}% COST REGRESSION, INJECTED INTO ONE ROW AT A TIME`);
console.log(`(only the ${costly.length} rows over ${MATTERS_ABOVE_FRESH.toLocaleString()} fresh tokens — below that, 20% is a handful of tokens)\n`);

let caught = 0;
for (const summary of costly) {
  const others = summariesOf(later).filter((row) => row.id !== summary.id);
  const breaches = checkBudgets([...others, worse(summary, DETECTS)], budgets);
  const mine = breaches.filter((breach) => breach.startsWith(`${summary.id}:`));
  if (mine.length) caught += 1;
  const ceiling = budgets.tasks[summary.id]?.freshTokens ?? 0;
  console.log(
    `  ${mine.length ? "CAUGHT " : "missed "} ${summary.id.padEnd(32)} ` +
    `${String(summary.medianFresh).padStart(6)} → ${String(Math.round(summary.medianFresh * DETECTS)).padStart(6)} ` +
    `against a ceiling of ${String(ceiling).padStart(6)}`
  );
}

console.log(`\n${caught} of ${costly.length} caught.`);
console.log(
  falseAlarms.length === 0
    ? "The gate stayed quiet on unchanged code, which is what earns it the right to be believed."
    : "SOME BREACHES ABOVE ARE FALSE ALARMS — the ceilings are too tight to survive this suite's own noise."
);
