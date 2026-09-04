// WHAT DOES THE OUTPUT CEILING ACTUALLY COST, NOW THAT THINKING IS OFF?
//
//   node scripts/probe-output-ceiling.mjs
//   node scripts/probe-output-ceiling.mjs --repeat 3 --ceilings 4096,8192,16384
//
// WHY THIS EXISTS. `MODEL_OUTPUT_CEILING` is 4,096 and carries the loudest
// comment in the loop: "A CEILING IS A BEHAVIOURAL DIAL, NOT A SAFETY LIMIT. DO
// NOT RAISE THIS ONE." That instruction is correct about what was measured and
// it was measured under a condition that no longer holds.
//
// THE ORIGINAL MEASUREMENT, 21 Aug 2026. Raising the ceiling to 16,384 for every
// turn dropped the eval from 100% to 91%: `draw-shape-in-paint` went 3/3 to 1/3
// at 3x the tokens, because "given more room a reasoning model does not think the
// same thoughts with slack: it thinks longer and then ATTEMPTS MORE". The
// mechanism named there is REASONING expanding to fill the room.
//
// WHAT CHANGED. Thinking has been off by default since 28 Aug 2026 —
// `reasoning_effort: "none"` plus both `chat_template_kwargs` spellings — and
// measured against this endpoint it really does produce
// `completion_tokens_details.reasoning_tokens: 0`. If reasoning is the mechanism
// and reasoning is zero, the mechanism cannot operate. That is an argument, and
// arguments are what this project replaces with measurements, so this measures
// it: the same decisions at several ceilings, thinking off, and it reports
// whether output tokens grow with the room they are given.
//
// AND THE OTHER HALF, WHICH IS WHY THE CEILING HAS TO MOVE AT ALL. A turn that
// writes a real file needs about 5,000 output tokens for a 14 KB stylesheet. At
// 4,096 this endpoint does not report `length` — it discards the whole turn and
// answers `finish_reason: null` with `completion_tokens: 1`, which `wasTruncated`
// cannot see. So the ceiling is not merely tight, it is silently destructive, and
// the `needs-room` case below is that decision exactly.
//
// NOTHING HERE TOUCHES THE MACHINE. HTTP to the configured endpoint only.

import fs from "node:fs";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";
import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { FastAgent } from "../packages/fast-agent/src/index.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const REPEATS = Math.max(1, Number(flag("repeat", 3)) || 3);
const CEILINGS = (flag("ceilings", "4096,8192,16384") ?? "").split(",").map(Number).filter(Boolean);

const THINKING_OFF = {
  chat_template_kwargs: { thinking: false, enable_thinking: false },
  reasoning_effort: "none"
};

const SCREEN_READING = `Window: WhatsApp — Amma (windowId w-4821)
  edit "Type a message" @1120,1284 [under "Footer"]
  button "Send" @1876,1284 [under "Footer"]
  text "are you coming home today" @980,1102 [under "Messages"]
  button "Attach" @1042,1284 [under "Footer"]`;

const PAINT_READING = `Window: Paint — Untitled (windowId w-99)
  button "Oval" @412,96 [under "Shapes"]
  button "Pencil" @244,96 [under "Tools"]
  button "Save" @96,40 [under "Quick access"]
  pane "Canvas" @300,220 1200x760 [under "Document"]`;

// A REAL FIRST FILE, because the size of what is already in the conversation is
// part of the decision. Written by the agent itself during the live reproduction
// on 3 Sep 2026; falls back to a stub if the scratch folder has been cleaned.
const REPRO_HTML_PATH = "C:/Users/hithe/SYSCORA/scratch/ecom-repro/index.html";
const REPRO_HTML = fs.existsSync(REPRO_HTML_PATH)
  ? fs.readFileSync(REPRO_HTML_PATH, "utf8")
  : `<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body>${"<div class=\"card\"></div>".repeat(300)}<script src="app.js"></script></body></html>`;

const DIR = "C:\\Users\\hithe\\SYSCORA\\scratch\\ecom-repro";

// Each case is a decision the loop really makes. `tool` is what the prompt asks
// for; null means "answer without calling one".
const CASES = [
  {
    id: "needs-room",
    why: "write the second file of three — the decision that is silently discarded at 4,096",
    tool: "write_file",
    messages: [
      { role: "user", content: `in the folder ${DIR} create an interactive, responsive, functional html, css, js based ecom application. make it look beautiful` },
      {
        role: "assistant",
        content: "The folder is empty. I will create index.html, styles.css and app.js.",
        tool_calls: [{
          id: "c1", type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              saw: "Target folder is empty", say: "Writing the HTML.",
              path: `${DIR}\\index.html`, contents: REPRO_HTML
            })
          }
        }]
      },
      { role: "tool", tool_call_id: "c1", content: `Wrote ${DIR}\\index.html.` }
    ]
  },
  {
    id: "click-by-label",
    why: "the cheap GUI step — more room must not turn one click into a re-read",
    tool: "click",
    messages: [
      { role: "user", content: "read the screen" },
      { role: "assistant", content: null, tool_calls: [{ id: "s1", type: "function", function: { name: "screen", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "s1", content: SCREEN_READING },
      { role: "user", content: "click the Send button" }
    ]
  },
  {
    id: "draw-a-shape",
    why: "THE ROW THAT REGRESSED when the ceiling was raised with thinking ON",
    tool: "draw",
    messages: [
      { role: "user", content: "draw a big circle in paint" },
      { role: "assistant", content: null, tool_calls: [{ id: "s2", type: "function", function: { name: "screen", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "s2", content: PAINT_READING }
    ]
  },
  {
    id: "installed-question",
    why: "the cheapest real decision there is",
    tool: "software",
    messages: [{ role: "user", content: "is python installed?" }]
  },
  {
    id: "arithmetic",
    why: "must answer with NO tool at any ceiling",
    tool: null,
    messages: [{ role: "user", content: "what is 17 times 23" }]
  }
];

function buildRealToolset() {
  const adapter = new WindowsAdapter();
  adapter.hostRequest = async () => ({ performed: true });
  return buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
}

// Streaming, because that is what the loop uses and it is the shape that lies.
// A non-streaming request at the same ceiling answers HTTP 500 instead, which is
// a different failure with the same cause.
async function askStreaming({ baseUrl, apiKey, model, systemPrompt, tools, testCase, maxTokens }) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...testCase.messages],
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...THINKING_OFF
    })
  });
  if (!response.ok) {
    return { ok: false, elapsedMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason = null;
  let usage = null;
  let callName = null;
  let argBytes = 0;
  let doneSeen = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { doneSeen = true; continue; }
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") text += delta.content;
      for (const call of delta.tool_calls ?? []) {
        if (call.function?.name) callName = call.function.name;
        if (call.function?.arguments) argBytes += call.function.arguments.length;
      }
    }
  }
  const outTokens = Number(usage?.completion_tokens ?? 0);
  // THE SHAPE OF A DISCARDED TURN, as measured on this endpoint 3 Sep 2026: the
  // stream completes cleanly, no finish_reason is ever sent, usage reports one
  // token, and neither a tool call nor any usable text arrives. It is not
  // truncation — `length` is never said — and it is not a dropped socket.
  const discarded = doneSeen && finishReason === null && !callName && !text.trim();
  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    finishReason,
    outTokens,
    reasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    callName,
    argBytes,
    discarded,
    rightTool: testCase.tool === null ? callName === null : callName === testCase.tool
  };
}

async function main() {
  const config = loadModelConfig(process.cwd());
  if (!config.apiKey) {
    console.error("No API key resolved from the configuration.");
    process.exit(2);
  }
  const toolset = buildRealToolset();
  const tools = toolset.definitions;
  const systemPrompt = new FastAgent({ provider: null, toolset }).systemPrompt;

  console.log("THE OUTPUT CEILING — measured, thinking off, streaming");
  console.log(`  endpoint  ${config.baseUrl}`);
  console.log(`  model     ${config.model}`);
  console.log(`  ceilings  ${CEILINGS.join(", ")}`);
  console.log(`  ${REPEATS} repeat(s) per cell\n`);
  console.log("A DISCARDED turn is the defect: the stream completes, no finish_reason is sent,");
  console.log("usage says 1 token, and the tool call the model spent 20-30s writing never arrives.\n");

  const header = ["case".padEnd(20), ...CEILINGS.map((c) => String(c).padStart(22))].join("");
  console.log(header);
  console.log("-".repeat(header.length));

  const growth = new Map();
  for (const testCase of CASES) {
    const cells = [];
    for (const ceiling of CEILINGS) {
      const runs = [];
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        let outcome;
        try {
          outcome = await askStreaming({
            baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
            systemPrompt, tools, testCase, maxTokens: ceiling
          });
        } catch (error) {
          outcome = { ok: false, error: error?.message ?? String(error) };
        }
        runs.push(outcome);
      }
      const usable = runs.filter((run) => run.ok);
      const discarded = usable.filter((run) => run.discarded).length;
      const right = usable.filter((run) => run.rightTool).length;
      const medianOut = usable.length
        ? [...usable].map((r) => r.outTokens).sort((a, b) => a - b)[Math.floor(usable.length / 2)]
        : 0;
      growth.set(`${testCase.id}@${ceiling}`, medianOut);
      cells.push(
        `${right}/${runs.length} ok ${discarded ? `${discarded} DROP` : "      "} ${String(medianOut).padStart(5)}t`
          .padStart(22)
      );
    }
    console.log(testCase.id.padEnd(20) + cells.join(""));
  }

  console.log("\nDOES MORE ROOM MAKE IT DO MORE? (median output tokens, per case)");
  console.log("If a case's output is flat across ceilings, the room costs nothing on that case.");
  for (const testCase of CASES) {
    const series = CEILINGS.map((c) => growth.get(`${testCase.id}@${c}`) ?? 0);
    const base = series[0] || 1;
    const worst = Math.max(...series);
    const ratio = (worst / base).toFixed(2);
    console.log(`  ${testCase.id.padEnd(20)} ${series.map((v) => String(v).padStart(6)).join("")}   worst/first ${ratio}x`);
    console.log(`      ${testCase.why}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
