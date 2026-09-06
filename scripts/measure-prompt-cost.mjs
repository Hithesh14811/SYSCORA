// What one step of the agent loop costs to ask, in characters and in tokens.
//
// The loop re-sends the system prompt and the whole tool schema on EVERY step,
// so anything in either is paid for again for each decision the agent makes.
// That is the number this prints, because it is the one that was invisible: a
// paragraph added to a tool description reads as free and is not — at twenty
// steps a task, 400 characters costs 2,000 tokens.
//
// The token figures are characters ÷ 4, which is the usual English-text
// approximation and is close enough to compare a before against an after. It is
// not a tokenizer and does not claim to be; treat the RATIO as the measurement.
//
//   node scripts/measure-prompt-cost.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolset } from "../packages/fast-agent/src/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = (chars) => Math.round(chars / 4);
const pad = (value, width) => String(value).padStart(width);

const source = await fs.readFile(path.join(root, "packages/fast-agent/src/index.js"), "utf8");
const systemPrompt = source.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)?.[1] ?? "";

// A toolset with no machine behind it: the definitions do not depend on either.
const toolset = buildToolset({ registry: { get: () => null }, adapter: {} });
const definitions = toolset.definitions;
const schema = JSON.stringify(definitions);

// How much of the schema is the two narration fields, which are attached to
// every tool and therefore paid for once per tool per step.
let narration = 0;
for (const definition of definitions) {
  const properties = definition.function.parameters.properties;
  narration += JSON.stringify(properties.saw ?? "").length + JSON.stringify(properties.say ?? "").length;
}

const fixed = systemPrompt.length + schema.length;

console.log("Fixed cost, re-sent on every step of every task");
console.log(`  system prompt      ${pad(systemPrompt.length, 7)} chars  ~${pad(tokens(systemPrompt.length), 6)} tokens`);
console.log(`  tool schema        ${pad(schema.length, 7)} chars  ~${pad(tokens(schema.length), 6)} tokens   (${definitions.length} tools)`);
console.log(`    of which saw/say ${pad(narration, 7)} chars  ~${pad(tokens(narration), 6)} tokens   (${Math.round((100 * narration) / schema.length)}% of the schema)`);
console.log(`  TOTAL PER STEP     ${pad(fixed, 7)} chars  ~${pad(tokens(fixed), 6)} tokens`);
console.log("");
console.log("Projected input, fixed cost only (a real run adds the conversation)");
for (const steps of [5, 10, 25, 50]) {
  console.log(`  ${pad(steps, 3)} steps          ${pad(tokens(fixed) * steps, 12)} tokens`);
}
console.log("");

const sizes = definitions
  .map((definition) => [definition.function.name, JSON.stringify(definition).length])
  .sort((left, right) => right[1] - left[1]);
console.log("Largest tools");
for (const [name, size] of sizes.slice(0, 8)) {
  console.log(`  ${name.padEnd(14)} ${pad(size, 6)} chars  ~${pad(tokens(size), 5)} tokens`);
}

// ---- WHERE THE SYSTEM PROMPT'S TOKENS ACTUALLY GO ---------------------------
//
// The prompt is ~4,400 tokens and about seventy-five directives, every one added
// after a specific observed defect and NOT ONE ever measured for whether it
// still earns its place. `docs/state-of-the-world.md` has listed that as an open
// item since 3 Sep 2026 under "the system prompt has never been ablated".
//
// An ablation needs a model and a task suite. This does not: it prints the
// standing cost of each SECTION, per step and over a run, which is the half of
// the question that can be answered for nothing and is where an ablation would
// have to start. A section costing 40 tokens a step is not worth an experiment;
// one costing 900 is.
//
// The rule this serves is already in CLAUDE.md — prose in the prompt and in tool
// descriptions is re-sent on every step — and nothing was measuring the prompt
// side of it.
console.log("");
console.log("System prompt, by section");

// Sections are the ALL-CAPS headings the prompt is written in.
const lines = systemPrompt.split("\n");
const sections = [];
let current = { name: "(preamble)", chars: 0, directives: 0 };
for (const line of lines) {
  // A heading is a whole line of capitals — no leading dash, no sentence case.
  if (/^[A-Z][A-Z ,'’\-()/]{6,}$/.test(line.trim()) && !line.trim().startsWith("-")) {
    sections.push(current);
    current = { name: line.trim(), chars: 0, directives: 0 };
    continue;
  }
  current.chars += line.length + 1;
  if (line.trim().startsWith("- ")) current.directives += 1;
}
sections.push(current);

const ranked = sections.filter((section) => section.chars > 0)
  .sort((left, right) => right.chars - left.chars);
let totalDirectives = 0;
for (const section of ranked) {
  totalDirectives += section.directives;
  const perStep = tokens(section.chars);
  console.log(`  ${section.name.slice(0, 46).padEnd(46)} ${pad(perStep, 5)} tok  ${pad(section.directives, 3)} rules  `
    + `${pad(perStep * 25, 7)} over 25 steps`);
}
console.log(`  ${"".padEnd(46)} ${pad(tokens(systemPrompt.length), 5)} tok  ${pad(totalDirectives, 3)} rules  total`);
console.log("");
console.log("  A section's cost is paid on EVERY step, cached or not: the endpoint");
console.log("  serves a cached prefix at roughly a tenth of the price, so read these");
console.log("  as a tenth of the money and all of the context window.");
