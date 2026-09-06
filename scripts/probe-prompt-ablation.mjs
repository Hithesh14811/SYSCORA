// IS THE SYSTEM PROMPT STILL EARNING ITS PLACE, SECTION BY SECTION?
//
//   node scripts/probe-prompt-ablation.mjs                       every section, 3 repeats
//   node scripts/probe-prompt-ablation.mjs --repeat 5
//   node scripts/probe-prompt-ablation.mjs --section "CHOOSING A TOOL"
//
// THE OPEN ITEM THIS ANSWERS. `docs/state-of-the-world.md` has carried, since
// 3 Sep 2026: "The system prompt has never been ablated. 4,392 tokens, ~75
// directives, every one of them added because of a specific observed defect and
// none of them ever measured for whether it still earns its place. Adding a rule
// is cheap and reversible; nobody has checked whether the twentieth NEVER
// weakens the first."
//
// `scripts/measure-prompt-cost.mjs` now prints what each section COSTS. The
// largest is CHOOSING A TOOL at ~1,945 tokens — 44% of the whole prompt, 24
// rules, roughly 48,600 tokens over a 25-step run, and much of it restates what
// the tool schema already declares in the same request. That is the standing
// bill. What it BUYS is what this measures.
//
// HOW IT MEASURES. It reuses the bake-off's seven graded decisions rather than
// inventing new ones — every case there is drawn from a defect this project
// actually paid for, and a second copy of them would drift. Each section is
// removed from the prompt, the same decisions are re-graded, and the two scores
// are printed side by side with the tokens saved.
//
// HOW TO READ IT. A section whose removal changes nothing is a section to cut, on
// this evidence, on these cases. A section whose removal drops a case is doing
// exactly the job it was added for, and the case it drops names the defect it is
// preventing — which is worth more than the score.
//
// WHAT IT CANNOT SAY. Seven single decisions are not a task suite: a rule about
// finishing a job, or about not narrating, cannot fail here because nothing here
// runs to completion. A section that looks free in this table may still be
// load-bearing over twenty steps. Treat a null result as "no evidence it helps
// on tool choice", never as "safe to delete".
//
// It makes model requests and costs money — 7 cases x repeats x (sections + 1).

import { CASES, askOnce, buildRealToolset } from "./probe-model-bakeoff.mjs";
import { FastAgent } from "../packages/fast-agent/src/index.js";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";

const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repeat = Math.max(1, Number(arg("--repeat", 3)) || 3);
const only = arg("--section", null);

const config = loadModelConfig(process.cwd());
const toolset = buildRealToolset();
const tools = toolset.definitions;
const fullPrompt = new FastAgent({ provider: null, toolset }).systemPrompt;

// The prompt's sections are its ALL-CAPS headings. Splitting on them here rather
// than hard-coding the list means a section added tomorrow is measured tomorrow.
function splitSections(prompt) {
  const lines = prompt.split("\n");
  const sections = [];
  let current = { name: "(preamble)", lines: [] };
  for (const line of lines) {
    if (/^[A-Z][A-Z ,'’\-()/]{6,}$/.test(line.trim()) && !line.trim().startsWith("-")) {
      sections.push(current);
      current = { name: line.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections.filter((section) => section.lines.join("\n").trim());
}

const sections = splitSections(fullPrompt);
const without = (name) => sections.filter((section) => section.name !== name)
  .map((section) => section.lines.join("\n")).join("\n");

const tokens = (text) => Math.round(text.length / 4);

async function score(prompt) {
  let correct = 0;
  let total = 0;
  const failed = [];
  for (const testCase of CASES) {
    for (let run = 0; run < repeat; run += 1) {
      total += 1;
      const result = await askOnce({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: prompt,
        tools,
        testCase,
        thinkingOff: true
      });
      if (result.ok && result.rightTool && result.rightArgs) correct += 1;
      else failed.push(testCase.id);
    }
  }
  return { correct, total, failed };
}

console.log(`  model      ${config.model}`);
console.log(`  cases      ${CASES.length} x ${repeat} repeats`);
console.log(`  prompt     ${tokens(fullPrompt)} tokens across ${sections.length} sections\n`);

const baseline = await score(fullPrompt);
console.log(`  BASELINE, whole prompt        ${baseline.correct}/${baseline.total}`
  + (baseline.failed.length ? `   missed: ${[...new Set(baseline.failed)].join(", ")}` : ""));
console.log("");

const targets = only ? sections.filter((section) => section.name === only) : sections;
if (only && targets.length === 0) {
  console.log(`  No section named ${JSON.stringify(only)}. Sections are:`);
  for (const section of sections) console.log(`    ${section.name}`);
  process.exit(1);
}

const rows = [];
for (const section of targets) {
  if (section.name === "(preamble)") continue;
  const trimmed = without(section.name);
  const saved = tokens(fullPrompt) - tokens(trimmed);
  const result = await score(trimmed);
  const delta = result.correct - baseline.correct;
  // AN EQUAL SCORE IS NOT AN EQUAL RESULT. Removing CHOOSING A TOOL first
  // measured 19/21 against a 19/21 baseline — and the two nineteens were not the
  // same nineteen: it recovered `relayed-instruction` and lost `arithmetic`.
  // Printing "same" there would report a wash where the composition moved, which
  // is the difference between "no effect" and "an effect this suite cannot
  // resolve". The names are what tell them apart.
  const before = new Set(baseline.failed);
  const after = new Set(result.failed);
  const gained = [...before].filter((id) => !after.has(id));
  const lost = [...after].filter((id) => !before.has(id));
  const moved = gained.length > 0 || lost.length > 0;
  rows.push({
    name: section.name, saved, correct: result.correct, total: result.total,
    delta, failed: result.failed, lost, gained, moved
  });
  console.log(`  without ${section.name.slice(0, 42).padEnd(42)} ${result.correct}/${result.total}  `
    + `${delta === 0 ? (moved ? "same*" : " same") : delta > 0 ? `  +${delta}` : `  ${delta}`}`
    + `  saves ${String(saved).padStart(4)} tok/step`
    + (lost.length ? `   LOST: ${lost.join(", ")}` : "")
    + (gained.length ? `   recovered: ${gained.join(", ")}` : ""));
}

console.log("\nRESULT\n");
// A section EARNS its place if removing it loses a case that was passing — by
// name, not by arithmetic. A section that drops one case and picks up another
// scored zero on the old test and is the interesting one: something moved and
// this suite is too small to say what.
const earning = rows.filter((row) => row.lost.length > 0).sort((a, b) => b.lost.length - a.lost.length);
const free = rows.filter((row) => row.lost.length === 0).sort((a, b) => b.saved - a.saved);

if (earning.length) {
  console.log("  EARNING THEIR PLACE — removing these lost a case that was passing:");
  for (const row of earning) {
    console.log(`    ${row.name}`);
    console.log(`      lost: ${row.lost.join(", ")}${row.gained.length ? `   (recovered: ${row.gained.join(", ")})` : ""}`);
  }
} else {
  console.log("  No section's removal lost a case that was passing.");
}
console.log("");
if (free.length) {
  console.log("  NO EVIDENCE OF HELP HERE — candidates for a real ablation, largest first:");
  for (const row of free) console.log(`    ${String(row.saved).padStart(4)} tok/step  ${row.name}`);
  const best = free[0];
  console.log(`\n  Cutting ${JSON.stringify(best.name)} would save ~${best.saved} tokens per step`);
  console.log(`  — about ${(best.saved * 25).toLocaleString("en-GB")} over a 25-step run, before caching.`);
}
console.log("\n  Seven single decisions are not a task suite. A null result here means");
console.log("  \"no evidence it helps tool choice\", never \"safe to delete\": nothing in");
console.log("  these cases runs to completion, so a rule about finishing cannot fail.");
