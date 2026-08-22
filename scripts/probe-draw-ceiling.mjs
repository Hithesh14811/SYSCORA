#!/usr/bin/env node
// WHAT EATS THE OUTPUT CEILING WHEN THE REQUEST IS "DRAW A DETAILED CAR"?
//
// Live, that request opened Paint, made a fresh document, read the screen — and
// then died with "I hit the output length limit twice", having drawn nothing.
// Three explanations fit that from the outside and each needs a different fix:
//
//   A. the model wrote an enormous `points` array by hand;
//   B. the model's REASONING consumed the ceiling before it wrote any tool call
//      at all. This endpoint is a reasoning model, reasoning_content is output,
//      and output is what `maxTokens` bounds;
//   C. too many `strokes`, each individually cheap.
//
// Re-running the whole request would cost money, drive the user's Paint, and
// might not even reproduce. So this replays ONLY the decisive step: the real
// system prompt, the real tool schema, and the real Paint screen reading that
// the live run had in front of it, up to the moment it had to answer.
//
// It calls the model twice — once at the shipped ceiling, once far above it.
// The second call is the measurement that separates the hypotheses, because it
// shows what the model WOULD have produced given room, and how much of that was
// reasoning rather than tool call. Reporting only the failure at 4,096 would
// show that the ceiling was hit and never show what hit it.
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";
import { buildToolset } from "../packages/fast-agent/src/index.js";

// The reading the live run actually had, copied from the recorded transcript.
// Trimmed to the parts a drawing decision uses — the canvas rectangle, the
// active tool, the shape and colour controls — because the point is to
// reproduce the DECISION, not the byte count of the reading.
const PAINT_READING = `Window: mspaint — Untitled - Paint (windowId 329390)

Drawing surface (the large unlabelled area — this is what you draw on): x 527 to 2353, y 558 to 1414, centre 1440,986. Every point of a shape must be inside that rectangle.

Active tool: Brush — it follows the pointer, so the path IS the mark. Any shape or freehand path draws exactly as given.

Elements (index| role "text" @x,y):
0| window "Untitled - Paint" @1440,852
1| menuitem "File" @49,85
6| button "Undo" @547,85 (disabled)
19| group "Tools" @604,235
20| button "Pencil" @523,175
21| button "Fill" @603,175
23| button "Eraser" @523,255
26| group "Brushes" @809,235
27| group "Shapes" @1165,235
30| listitem "Oval" @1012,167
31| listitem "Rectangle" @1056,167
32| listitem "Rounded rectangle" @1100,167
33| listitem "Polygon" @1144,167
35| listitem "Right triangle" @924,211
51| button "Shape outline" @1298,175 (disabled)
52| button "Shape fill" @1298,255 (disabled)
55| radiobutton "Colour 1: Black" @1510,177
56| radiobutton "Colour 2: White" @1510,253
59| listitem "Dark red" @1678,167
61| listitem "Orange" @1774,167
63| listitem "Green" @1870,167
65| listitem "Indigo" @1966,167
68| listitem "Light grey" @1630,215
69| listitem "Brown" @1678,215
71| listitem "Gold" @1774,215
73| listitem "Lime" @1870,215
77| button "Edit colours" @2094,215
81| group "Using Brush tool on Canvas" @1440,986
84| text "1826 x 856px" @684,1667`;

const REQUEST = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ")
  || "draw a car in paint, it should be beautiful and detailed, and after you draw fill it with appropriate colours as well";

const runtime = createRuntime(process.cwd());
const provider = runtime.reasoningEngine.modelProvider;
const toolset = buildToolset({});
const definitions = toolset.definitions;
if (!Array.isArray(definitions) || definitions.length === 0) {
  throw new Error("No tool definitions built — the probe would be measuring a call with no tools, which is not the call that failed.");
}

// Read the shipped system prompt off a real agent rather than pasting a copy,
// so this cannot silently drift from what the loop actually sends.
const { FastAgent } = await import("../packages/fast-agent/src/index.js");
const systemPrompt = new FastAgent({ provider, toolset }).systemPrompt;

console.log(`provider     ${provider.capabilities?.().name ?? "?"}`);
console.log(`tools        ${definitions.length}`);
console.log(`system prompt ${systemPrompt.length} chars`);
console.log(`request      ${JSON.stringify(REQUEST)}\n`);

// The conversation exactly as the live run had it at the fatal step: launch,
// new_document, screen — then the model must decide.
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

async function attempt(label, maxTokens) {
  let reasoning = "";
  let text = "";
  const startedAt = Date.now();
  const turn = await provider.chat({
    messages,
    tools: definitions,
    temperature: 0.2,
    maxTokens,
    timeoutMs: 180000,
    onTextDelta: (d) => { text += d; },
    onReasoningDelta: (d) => { reasoning += d; }
  });
  const ms = Date.now() - startedAt;
  const usage = turn.usage ?? {};
  const calls = turn.toolCalls ?? [];
  const argChars = calls.reduce((n, c) => n + String(typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {})).length, 0);

  console.log(`=== ${label} (maxTokens ${maxTokens}) ===`);
  console.log(`  finishReason      ${turn.finishReason}`);
  console.log(`  wall clock        ${(ms / 1000).toFixed(1)}s`);
  console.log(`  usage             ${JSON.stringify(usage)}`);
  console.log(`  reasoning chars   ${(turn.reasoning ?? reasoning).length}  (~${Math.round((turn.reasoning ?? reasoning).length / 4)} tokens)`);
  console.log(`  visible text      ${text.length} chars`);
  console.log(`  tool calls        ${calls.length}`);
  console.log(`  tool-call args    ${argChars} chars  (~${Math.round(argChars / 4)} tokens)`);
  for (const call of calls) {
    const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    console.log(`    → ${call.name}  ${args.slice(0, 400)}${args.length > 400 ? ` … [+${args.length - 400} chars]` : ""}`);
    // The hypothesis separator: a hand-written points array vs named shapes.
    try {
      const parsed = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
      if (parsed?.strokes) console.log(`      strokes: ${parsed.strokes.length}, shapes used: ${[...new Set(parsed.strokes.map((s) => s.shape))].join(", ")}`);
      if (parsed?.points) console.log(`      HAND-WRITTEN POINTS: ${parsed.points.length}`);
      const handPoints = (parsed?.strokes ?? []).reduce((n, s) => n + (s.points?.length ?? 0), 0);
      if (handPoints) console.log(`      hand-written points inside strokes: ${handPoints}`);
    } catch { console.log("      (arguments are not parseable JSON — truncated mid-write)"); }
  }
  console.log(`  reasoning head    ${JSON.stringify((turn.reasoning ?? reasoning).slice(0, 300))}`);
  console.log();
  return { turn, reasoning: turn.reasoning ?? reasoning, text };
}

// The shipped ceiling first: does the failure reproduce at all?
const shipped = await attempt("SHIPPED CEILING", 4096);
// Then with room, to see what was being written when the ceiling cut it off.
const roomy = await attempt("WITH ROOM", 16000);

console.log("=== verdict ===");
const shippedTruncated = /^(length|max_tokens)$/i.test(String(shipped.turn.finishReason ?? ""));
console.log(`  reproduced at the shipped ceiling: ${shippedTruncated ? "YES — finishReason=" + shipped.turn.finishReason : "no (finishReason=" + shipped.turn.finishReason + ")"}`);
const reasoningTokens = Math.round(roomy.reasoning.length / 4);
console.log(`  with room, reasoning alone was ~${reasoningTokens} tokens (${reasoningTokens > 4096 ? "ON ITS OWN over the shipped 4,096 ceiling" : "under the shipped ceiling"})`);
console.log(`  with room, it produced ${roomy.turn.toolCalls?.length ?? 0} tool call(s)`);
process.exit(0);
