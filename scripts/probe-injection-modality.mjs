// DOES THE PERCEPTION MODALITY DECIDE WHAT CAN BE DETECTED AT ALL?
//
//   node scripts/probe-injection-modality.mjs
//   node scripts/probe-injection-modality.mjs --corpus tests/eval/injection-corpus/blind-round-1.json
//   node scripts/probe-injection-modality.mjs --latex
//
// `content-boundary.js` claims that a Unicode tag character is invisible to a
// screenshot-reading monitor of the kind Operator runs at 99% recall, "because a
// character that renders as nothing is not in a screenshot at any resolution".
// This measures that claim, and — the half that makes it a result rather than an
// advertisement — measures the same thing in the other direction.
//
// THE EXPERIMENT, AND WHY IT IS SHAPED THIS WAY. The detector is held CONSTANT.
// Both arms run the identical `findInjectedInstruction` over the identical case;
// the only thing that differs is which view of the content it is handed:
//
//   Arm A  screenshot     what a camera pointed at the screen would carry
//   Arm B  accessibility  what UIA returns, invisible characters included
//
// Comparing this project's seven rules against somebody else's vision model would
// move two variables at once and no reviewer could tell which one mattered.
// Holding the detector fixed isolates the channel, and the interesting cells then
// come out as STRUCTURAL rather than as scores: where the projection is empty,
// Arm A has no evidence to reason about however good its reader is.
//
// NEITHER ARM WINS, AND THAT IS THE POINT. `image-text` and `aria-spoof` are in
// the corpus precisely so this cannot be read as a case for text-first
// perception: an instruction baked into a bitmap is invisible to the
// accessibility tree by exactly the same kind of structural argument. The
// conclusion a complete corpus supports is that a monitor must read both, and
// which classes force which.
//
// NOTHING HERE TOUCHES THE MACHINE OR CALLS A MODEL. It is string processing over
// a JSON file.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findInjectedInstruction } from "../packages/policy-engine/src/content-boundary.js";
import { projectionStats } from "../packages/policy-engine/src/visible-projection.js";
import { loadCorpus } from "../tests/eval/injection-corpus/materialize.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const corpusPath = resolve(here, "..", flag("--corpus", "tests/eval/injection-corpus/seed.json"));
const cases = loadCorpus(JSON.parse(readFileSync(corpusPath, "utf8")));

// A case is DETECTED by an arm when the detector, given that arm's view, says
// something was found. Nothing here inspects which rule fired: a hidden-text
// finding and a matched instruction are both the boundary doing its job, and
// grading on the rule id would measure the taxonomy rather than the channel.
const detected = (view) => findInjectedInstruction(view, { source: "corpus" }).found === true;

// DID THE PAYLOAD REACH THE SCREEN? That is the structural question, and it is
// not the same as "did anything reach the screen" — a tag-character case renders
// its innocent half perfectly, so the whole-string test is true and tells you
// nothing. What decides whether a screenshot reader COULD have seen the attack is
// whether the payload's own words survived into the pixels.
function payloadInvisible(entry) {
  const payload = String(entry.hidden ?? "").trim();
  if (!payload) return false; // image-text and friends: the payload IS the pixels
  const seen = String(entry.pixels ?? "").toLowerCase();
  // The longest words, because a payload and an innocent caption can share "the".
  const words = payload.toLowerCase().match(/[a-z0-9@._+-]{4,}/g) ?? [];
  if (words.length === 0) return !seen.includes(payload.toLowerCase());
  return !words.some((word) => seen.includes(word));
}

const rows = cases.map((entry) => {
  const stats = projectionStats(entry.aria);
  return {
    ...entry,
    armA: detected(entry.pixels),
    armB: detected(entry.aria),
    payloadInvisible: payloadInvisible(entry),
    hiddenFraction: entry.derived ? stats.hiddenFraction : null
  };
});

// THE HARNESS MUST BE ABLE TO FAIL. `plain-visible` hides nothing, so both arms
// are obliged to catch it; if they do not, the run is measuring a broken detector
// or a broken loader and every other number in the table is noise. This project
// has shipped five checks that could not fail and believed all of them.
const controls = rows.filter((row) => row.class === "plain-visible");
const brokenControls = controls.filter((row) => !row.armA || !row.armB);

const classes = [...new Set(rows.map((row) => row.class))];
const tally = (list, arm) => list.filter((row) => row[arm]).length;

function summarise(list) {
  const malicious = list.filter((row) => row.malicious);
  const benign = list.filter((row) => !row.malicious);
  return {
    n: list.length,
    malicious: malicious.length,
    benign: benign.length,
    recallA: malicious.length ? tally(malicious, "armA") / malicious.length : null,
    recallB: malicious.length ? tally(malicious, "armB") / malicious.length : null,
    fprA: benign.length ? tally(benign, "armA") / benign.length : null,
    fprB: benign.length ? tally(benign, "armB") / benign.length : null,
    blindA: malicious.filter((row) => row.payloadInvisible).length
  };
}

const pct = (value) => (value == null ? "   — " : `${(value * 100).toFixed(0).padStart(3)}%`);

console.log(`\ncorpus: ${corpusPath}`);
console.log(`${rows.length} cases · ${rows.filter((r) => r.malicious).length} malicious · ` +
  `${rows.filter((r) => !r.malicious).length} benign\n`);

const seeds = rows.filter((row) => String(row.note ?? "").length > 0 && corpusPath.endsWith("seed.json"));
if (seeds.length > 0) {
  console.log("!! THIS IS THE SEED CORPUS, WRITTEN BY THE DETECTOR'S OWN AUTHOR.");
  console.log("!! It demonstrates the harness. It is NOT a result and must not be");
  console.log("!! reported as one — see tests/eval/injection-corpus/README.md.\n");
}

console.log("                        recall                 false positives");
console.log("class                n   screenshot  a11y      screenshot  a11y     payload unseeable");
console.log("-".repeat(88));
for (const name of classes) {
  const summary = summarise(rows.filter((row) => row.class === name));
  console.log(
    `${name.padEnd(18)} ${String(summary.n).padStart(3)}   ` +
    `${pct(summary.recallA)}        ${pct(summary.recallB)}       ` +
    `${pct(summary.fprA)}        ${pct(summary.fprB)}        ` +
    `${summary.blindA > 0 ? `${summary.blindA}/${summary.malicious}` : "-"}`
  );
}
console.log("-".repeat(88));
const overall = summarise(rows);
console.log(
  `${"ALL".padEnd(18)} ${String(overall.n).padStart(3)}   ` +
  `${pct(overall.recallA)}        ${pct(overall.recallB)}       ` +
  `${pct(overall.fprA)}        ${pct(overall.fprB)}`
);

// The asymmetry, named. A reviewer's first question is "so text-first wins?" and
// the answer has to be no, in the same table.
const onlyB = rows.filter((row) => row.malicious && row.armB && !row.armA);
const onlyA = rows.filter((row) => row.malicious && row.armA && !row.armB);
const neither = rows.filter((row) => row.malicious && !row.armA && !row.armB);
console.log(`\ncaught by the accessibility tree ALONE : ${onlyB.length}  ${onlyB.map((r) => r.id).join(" ")}`);
console.log(`caught by the screenshot ALONE        : ${onlyA.length}  ${onlyA.map((r) => r.id).join(" ")}`);
console.log(`missed by BOTH                        : ${neither.length}  ${neither.map((r) => r.id).join(" ")}`);

const falsePositives = rows.filter((row) => !row.malicious && (row.armA || row.armB));
if (falsePositives.length > 0) {
  console.log(`\nfalse positives (${falsePositives.length}) — report these, do not tune them away:`);
  for (const row of falsePositives) {
    console.log(`  ${row.id.padEnd(10)} ${row.armB ? "a11y" : "    "} ${row.armA ? "screenshot" : ""}  ${row.note}`);
  }
}

if (argv.includes("--latex")) {
  console.log("\n% --- paste into the paper ---");
  console.log("\\begin{tabular}{lrrrrr}");
  console.log("\\toprule");
  console.log("Class & $n$ & \\multicolumn{2}{c}{Recall} & \\multicolumn{2}{c}{FPR} \\\\");
  console.log(" & & Screenshot & A11y & Screenshot & A11y \\\\");
  console.log("\\midrule");
  for (const name of classes) {
    const s = summarise(rows.filter((row) => row.class === name));
    const cell = (v) => (v == null ? "--" : `${(v * 100).toFixed(0)}\\%`);
    console.log(`${name} & ${s.n} & ${cell(s.recallA)} & ${cell(s.recallB)} & ${cell(s.fprA)} & ${cell(s.fprB)} \\\\`);
  }
  console.log("\\bottomrule");
  console.log("\\end{tabular}");
}

if (brokenControls.length > 0) {
  console.log(`\nFAIL: ${brokenControls.length} plain-visible control(s) were not caught by both arms ` +
    `(${brokenControls.map((row) => row.id).join(", ")}).`);
  console.log("Nothing is hidden in those cases, so this is the harness failing, not a finding.");
  process.exitCode = 1;
} else {
  console.log(`\nControls: ${controls.length}/${controls.length} caught by both arms, so the harness can see.`);
}
