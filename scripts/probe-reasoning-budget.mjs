#!/usr/bin/env node
// HOW OFTEN DOES THINKING ALONE OVERRUN THE OUTPUT CEILING?
//
// `maxTokens` bounds OUTPUT, and on this endpoint reasoning_content IS output —
// it is billed as completion tokens and reported under
// completion_tokens_details.reasoning_tokens. So the ceiling is shared between
// the model's deliberation and the tool call it is deliberating towards, and
// the deliberation goes first.
//
// Two samples of the SAME drawing decision spent 1,780 and 5,155 reasoning
// tokens. That spread is the whole story, and an average of the two (3,467)
// would have said "comfortably under 4,096" while one of the two samples was
// already over it. So this prints the DISTRIBUTION, never a mean.
//
// Measured at the SHIPPED ceiling on purpose. finishReason "length" here is not
// a proxy for the defect, it IS the defect: the loop discards a truncated turn
// whole, tool calls included, retries once, and settles PARTIALLY_COMPLETED if
// the retry lands long too. Two independent overruns and the user gets an open
// Paint window and no car.
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";
import { buildToolset, FastAgent, wasTruncated } from "../packages/fast-agent/src/index.js";

const SAMPLES = Number(process.env.SAMPLES ?? 8);
const CEILING = Number(process.env.CEILING ?? 4096);

const PAINT_READING = `Window: mspaint — Untitled - Paint (windowId 329390)

Drawing surface (the large unlabelled area — this is what you draw on): x 527 to 2353, y 558 to 1414, centre 1440,986. Every point of a shape must be inside that rectangle.

Active tool: Brush — it follows the pointer, so the path IS the mark. Any shape or freehand path draws exactly as given.

Elements (index| role "text" @x,y):
0| window "Untitled - Paint" @1440,852
6| button "Undo" @547,85 (disabled)
20| button "Pencil" @523,175
21| button "Fill" @603,175
27| group "Shapes" @1165,235
30| listitem "Oval" @1012,167
31| listitem "Rectangle" @1056,167
32| listitem "Rounded rectangle" @1100,167
33| listitem "Polygon" @1144,167
51| button "Shape outline" @1298,175 (disabled)
52| button "Shape fill" @1298,255 (disabled)
55| radiobutton "Colour 1: Black" @1510,177
59| listitem "Dark red" @1678,167
61| listitem "Orange" @1774,167
63| listitem "Green" @1870,167
69| listitem "Brown" @1678,215
71| listitem "Gold" @1774,215
81| group "Using Brush tool on Canvas" @1440,986
84| text "1826 x 856px" @684,1667`;

// Two requests, because the eval's green drawing row and the user's failing one
// differ in exactly one way: how much there is to work out before acting.
const CASES = {
  detailed: "draw a car in paint, it should be beautiful and detailed, and after you draw fill it with appropriate colours as well",
  simple: "draw a circle in paint"
};
const which = process.argv[2] ?? "detailed";
const REQUEST = CASES[which] ?? which;

const runtime = createRuntime(process.cwd());
const provider = runtime.reasoningEngine.modelProvider;
const toolset = buildToolset({});
const definitions = toolset.definitions;
const systemPrompt = new FastAgent({ provider, toolset }).systemPrompt;

const messages = [
  { role: "system", content: systemPrompt },
  { role: "user", content: REQUEST },
  { role: "assistant", content: "Opening Paint to draw the car." },
  { role: "user", content: `[tool launch] Paint opened a new window (windowId 329390, "Untitled - Paint").` },
  { role: "assistant", content: "Starting a fresh canvas so I draw somewhere clean." },
  { role: "user", content: `[tool new_document] Used Ctrl+N, and the surface is now empty with nothing to undo — this is a fresh document.` },
  { role: "assistant", content: "Reading the Paint window to find the canvas and tools." },
  { role: "user", content: `[tool screen]\n${PAINT_READING}` }
];

// RETRY=1 appends the exact pair of messages the loop sends after a truncated
// turn, so the retry can be measured rather than assumed to work. It is worth
// measuring separately because the message talks about ARGUMENT size, and what
// actually overran the ceiling was reasoning — an instruction aimed at the
// wrong half of the budget is a fix that cannot work, and this codebase has
// shipped several of those.
if (process.env.RETRY === "1") {
  messages.push({ role: "assistant", content: "(cut off)" });
  messages.push({
    role: "user",
    content: "[SYSTEM] Your last turn hit the output token limit and was cut off partway, so " +
      "nothing in it was used — no tool ran and the text was discarded. Do that step again and " +
      "keep it SHORT: if you were answering, give the whole answer in a few sentences; if you were " +
      "calling a tool, make the call with the smallest arguments that do the job."
  });
  console.log("mode      RETRY — the loop's post-truncation messages are appended\n");
}

console.log(`case      ${which}`);
console.log(`request   ${JSON.stringify(REQUEST).slice(0, 100)}`);
console.log(`ceiling   ${CEILING} output tokens (the shipped value)`);
console.log(`samples   ${SAMPLES}\n`);

const runs = [];
for (let n = 1; n <= SAMPLES; n += 1) {
  const startedAt = Date.now();
  let turn;
  try {
    turn = await provider.chat({
      messages, tools: definitions, temperature: 0.2,
      maxTokens: CEILING, timeoutMs: 180000
    });
  } catch (error) {
    console.log(`  ${String(n).padStart(2)}  ERROR ${error.message.slice(0, 90)}`);
    continue;
  }
  const u = turn.usage ?? {};
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? null;
  const completion = u.completion_tokens ?? null;
  const truncated = wasTruncated(turn);
  runs.push({ reasoning, completion, truncated, finishReason: turn.finishReason, toolCalls: turn.toolCalls?.length ?? 0 });
  console.log(
    `  ${String(n).padStart(2)}  reasoning ${String(reasoning).padStart(5)}  ` +
    `completion ${String(completion).padStart(5)}  ` +
    `finish ${String(turn.finishReason).padEnd(11)}  ` +
    `tools ${turn.toolCalls?.length ?? 0}  ` +
    `${truncated ? "*** TRUNCATED — WHOLE TURN DISCARDED ***" : ""}  ` +
    `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

console.log(`\n=== distribution of reasoning tokens (n=${runs.length}) ===`);
const reasoningValues = runs.map((r) => r.reasoning).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
if (reasoningValues.length === 0) {
  console.log("  the endpoint reported no reasoning_tokens — this measurement does not apply to it");
} else {
  const at = (p) => reasoningValues[Math.min(reasoningValues.length - 1, Math.floor((p / 100) * reasoningValues.length))];
  console.log(`  min ${reasoningValues[0]}  p50 ${at(50)}  p90 ${at(90)}  max ${reasoningValues[reasoningValues.length - 1]}`);
  console.log(`  all: ${reasoningValues.join(", ")}`);
  const over = reasoningValues.filter((v) => v >= CEILING - 64).length;
  console.log(`  at or near the ${CEILING} ceiling: ${over} of ${reasoningValues.length}`);
}
const truncatedCount = runs.filter((r) => r.truncated).length;
console.log(`\n=== the product-level number ===`);
console.log(`  turns discarded by truncation: ${truncatedCount} of ${runs.length} (${((truncatedCount / Math.max(1, runs.length)) * 100).toFixed(0)}%)`);
console.log(`  a run needs TWO of these in a row to fail outright, so the run-level failure rate`);
console.log(`  is roughly the square of that if the overruns are independent.`);
process.exit(0);
