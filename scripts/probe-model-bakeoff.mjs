// WHICH MODEL, AND SHOULD IT THINK? MEASURED ON THIS HARNESS, NOT ON A LEADERBOARD.
//
//   node scripts/probe-model-bakeoff.mjs                     every candidate, 3 repeats
//   node scripts/probe-model-bakeoff.mjs --repeat 5
//   node scripts/probe-model-bakeoff.mjs --models a,b,c
//   node scripts/probe-model-bakeoff.mjs --only-current      just the configured model
//
// The project has spent months making the HARNESS good and has never once asked
// whether the engine bolted to it is the right one. The configured endpoint
// serves fourteen models to the same key at the same base URL, so switching is a
// string — and nothing in the repository could say what that string is worth.
//
// WHY A PUBLIC LEADERBOARD CANNOT ANSWER THIS. OSWorld and friends score a whole
// agent system: model plus scaffold plus perception plus retry policy. SYSCORA
// IS a scaffold, and an unusually opinionated one — 36 tools, a system prompt
// that forbids specific mistakes by name, and a house rule that a tool result is
// the only evidence there is. What matters here is not "which model is best" but
// "which model follows THIS prompt and picks correctly from THESE tools", and
// the only way to know that is to send it this prompt and these tools.
//
// WHAT IS GRADED. Every case below is a decision the loop really makes, and each
// one is drawn from a defect this project actually paid for:
//
//   installed-question   the prompt says `software`, never `run`. Live, this
//                        opened a terminal and cost 41s.
//   make-a-pdf           the prompt says `create_document` is ONE call. Live,
//                        the other way cost 13 tool calls and 227,584 tokens.
//   relayed-instruction  "tell them X and do Y" — Y belongs to the reader, not
//                        the agent. Live, this went hunting for a Jira install
//                        and ended "Partly done" at 84,662 tokens.
//   arithmetic           the prompt forbids reaching for a tool to think. Live,
//                        "17 times 23" cost three PowerShell calls.
//   click-by-label       click the LABEL, never an index or a coordinate.
//   open-an-app          `launch`, never `run`.
//   read-a-file          `read_file`, never a shell `Get-Content`.
//
// So the grade is not "did it answer" — it is "did it make the choice this
// prompt spent a paragraph asking for". A model that scores badly here is not a
// bad model; it is a model this harness would have to be rewritten around.
//
// THE SECOND QUESTION IS THINKING, AND IT IS THE ONE THE USER ASKED. The endpoint
// honours four different ways of turning reasoning off (measured: `reasoning_effort:
// low` still emits reasoning tokens, `none` does not), and reasoning is billed as
// completion tokens against the same ceiling the tool call has to fit inside —
// which is the documented cause of turns that deliberate past the limit and emit
// no call at all. Turning it off is therefore both a latency change and a
// correctness change, in opposite directions, and neither can be argued: this
// runs both ways and prints both.
//
// NOTHING HERE TOUCHES THE MACHINE. It is HTTP to the configured endpoint and
// nothing else — no window is read, no key is pressed, no file is written.

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

// The candidates worth the wall-clock. Every one is served by the configured
// endpoint to the configured key; `--models` overrides.
const DEFAULT_CANDIDATES = [
  "deepseek-ai/DeepSeek-V4-Flash-0731",
  "deepseek-ai/DeepSeek-V4-Pro-0813",
  "zai-org/GLM-5.3-Flash",
  "zai-org/GLM-5.2-Fast",
  "moonshotai/Kimi-K3",
  "openai/gpt-oss-120b"
];

// HOW THINKING IS TURNED OFF, AND WHY THERE ARE TWO SPELLINGS.
//
// Measured against this endpoint on 28 Aug 2026, all four of `thinking:false`,
// `enable_thinking:false`, `reasoning_effort:"none"` and `thinking:{type:
// "disabled"}` produced zero reasoning tokens on a trivial decision, while
// `reasoning_effort:"low"` did not. The endpoint fronts several serving stacks
// and they do not all read the same field, so BOTH spellings are sent: an
// unknown key is ignored by the stack that does not know it, and the one that
// does acts on it. Sending only the one this month's deployment happens to read
// is how this silently stops working after somebody else's upgrade.
const THINKING_OFF = {
  chat_template_kwargs: { thinking: false, enable_thinking: false },
  reasoning_effort: "none"
};

// A REALISTIC PRIOR TURN, so the click case is graded on a real reading rather
// than on an empty conversation. Shortened from a genuine WhatsApp reading.
const SCREEN_READING = `Window: WhatsApp — Amma (windowId w-4821)
  edit "Type a message" @1120,1284 [under "Footer"]
  button "Send" @1876,1284 [under "Footer"]
  text "are you coming home today" @980,1102 [under "Messages"]
  button "Attach" @1042,1284 [under "Footer"]`;

// tool: the call the prompt asks for. null means "answer without calling one".
const CASES = [
  {
    id: "open-an-app",
    ask: "open notepad",
    tool: "launch",
    why: "`launch` resolves a name to whatever the machine has; `run` cannot"
  },
  {
    id: "installed-question",
    ask: "is python installed?",
    tool: "software",
    why: "the prompt forbids opening a terminal to answer an installed/version question"
  },
  {
    id: "read-a-file",
    ask: "what does C:\\Users\\hithe\\Documents\\notes.txt say?",
    tool: "read_file",
    why: "a typed read, not a shell Get-Content"
  },
  {
    id: "click-by-label",
    // "send it" was the first wording and it graded the wrong thing: models
    // re-read the screen instead, which is defensible behaviour on a vague
    // pronoun. The case is about HOW a control is addressed, not about whether
    // the model can resolve "it", so the ask names the control and the grade is
    // entirely in argCheck.
    ask: "click the Send button",
    tool: "click",
    priorTool: SCREEN_READING,
    why: "click the LABEL from the reading, never an index or a made-up coordinate",
    // The label matters as much as the tool: `element: 3` is the defect.
    argCheck: (args) => typeof args.text === "string" && /send/i.test(args.text)
      && args.element === undefined && args.x === undefined
  },
  {
    id: "make-a-pdf",
    ask: "make me a pdf explaining photosynthesis, about 300 words",
    tool: "create_document",
    why: "ONE call; the toolchain route cost 227,584 tokens live"
  },
  {
    id: "relayed-instruction",
    ask: "email yob@example.com that the servers are down and raise the issue in jira, i'll fix it by next week",
    tool: "email_draft",
    why: "the Jira clause is the MESSAGE, not a second task — the injection boundary pointed inward"
  },
  {
    id: "arithmetic",
    ask: "what is 17 times 23",
    tool: null,
    why: "the prompt forbids reaching for a tool to do arithmetic"
  }
];

function buildRealToolset() {
  const adapter = new WindowsAdapter();
  // No host, no machine. Every case is graded on the CALL, never on its result,
  // so nothing below ever has to succeed — but a tool whose execute throws on
  // construction would not appear in the schema, which would change the question.
  adapter.hostRequest = async () => ({ performed: true });
  return buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
}

async function askOnce({ baseUrl, apiKey, model, systemPrompt, tools, testCase, thinkingOff }) {
  const messages = [{ role: "system", content: systemPrompt }];
  if (testCase.priorTool) {
    messages.push({ role: "user", content: "read the screen" });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "screen", arguments: "{}" } }]
    });
    messages.push({ role: "tool", tool_call_id: "c1", content: testCase.priorTool });
  }
  messages.push({ role: "user", content: testCase.ask });

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 4096,
      ...(thinkingOff ? THINKING_OFF : {})
    })
  });
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    return { ok: false, elapsedMs, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}` };
  }
  const body = await response.json();
  const message = body.choices?.[0]?.message ?? {};
  const usage = body.usage ?? {};
  const call = message.tool_calls?.[0];
  let args = {};
  let argsParsed = true;
  if (call?.function?.arguments) {
    try { args = JSON.parse(call.function.arguments); } catch { argsParsed = false; }
  }

  // THE GRADE. Expected tool, or expected NO tool. Plus the argument shape where
  // the argument is the whole point of the case.
  const called = call?.function?.name ?? null;
  const rightTool = testCase.tool === null ? called === null : called === testCase.tool;
  const rightArgs = !testCase.argCheck || (rightTool && argsParsed && testCase.argCheck(args) === true);
  // How many calls it wanted to make at once. More than one on these cases is
  // the model doing the Jira thing — a second, uninstructed action.
  const callCount = message.tool_calls?.length ?? 0;

  return {
    ok: true,
    elapsedMs,
    called,
    callCount,
    pass: rightTool && rightArgs && argsParsed,
    rightTool,
    rightArgs,
    argsParsed,
    finishReason: body.choices?.[0]?.finish_reason ?? null,
    outTokens: Number(usage.completion_tokens ?? 0),
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0),
    inTokens: Number(usage.prompt_tokens ?? 0),
    cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0)
  };
}

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

async function main() {
  const config = loadModelConfig(process.cwd());
  if (!config.apiKey) {
    console.error("No API key resolved from the configuration. Nothing to measure.");
    process.exit(2);
  }
  const toolset = buildRealToolset();
  const tools = toolset.definitions;
  const systemPrompt = new FastAgent({ provider: null, toolset }).systemPrompt;

  const candidates = flag("models")
    ? flag("models").split(",").map((name) => name.trim()).filter(Boolean)
    : argv.includes("--only-current") ? [config.model] : DEFAULT_CANDIDATES;

  console.log("MODEL BAKE-OFF — real system prompt, real tool schema, graded on real decisions");
  console.log(`  endpoint   ${config.baseUrl}`);
  console.log(`  tools      ${tools.length} in the schema`);
  console.log(`  prompt     ~${Math.round(systemPrompt.length / 4)} tokens`);
  console.log(`  cases      ${CASES.length}, ${REPEATS} repeat(s) each`);
  console.log(`  configured ${config.model}`);
  console.log("");

  const rows = [];
  for (const model of candidates) {
    for (const thinkingOff of [false, true]) {
      const results = [];
      let unreachable = null;
      for (const testCase of CASES) {
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
          let outcome;
          try {
            outcome = await askOnce({
              baseUrl: config.baseUrl, apiKey: config.apiKey, model,
              systemPrompt, tools, testCase, thinkingOff
            });
          } catch (error) {
            outcome = { ok: false, elapsedMs: 0, error: error?.message ?? String(error) };
          }
          if (!outcome.ok) {
            unreachable = outcome.error;
            // A model this key cannot serve is not a model that scored zero.
            break;
          }
          results.push({ case: testCase.id, ...outcome });
        }
        if (unreachable) break;
      }
      if (unreachable) {
        console.log(`${model}  thinking ${thinkingOff ? "OFF" : "ON "}   UNREACHABLE — ${unreachable}`);
        rows.push({ model, thinkingOff, unreachable });
        continue;
      }

      // A case counts as passed only when EVERY repeat passed. Same rule as the
      // eval: a flake is a defect nobody has diagnosed yet.
      const byCase = new Map();
      for (const record of results) {
        const bucket = byCase.get(record.case) ?? [];
        bucket.push(record);
        byCase.set(record.case, bucket);
      }
      const passedCases = [...byCase.entries()].filter(([, list]) => list.every((r) => r.pass));
      const row = {
        model,
        thinkingOff,
        passed: passedCases.length,
        total: byCase.size,
        failures: [...byCase.entries()].filter(([, list]) => !list.every((r) => r.pass))
          .map(([id, list]) => `${id}→${list.map((r) => r.called ?? "none").join("/")}`),
        medianMs: median(results.map((r) => r.elapsedMs)),
        medianOut: median(results.map((r) => r.outTokens)),
        medianReasoning: median(results.map((r) => r.reasoningTokens)),
        maxReasoning: Math.max(...results.map((r) => r.reasoningTokens)),
        truncated: results.filter((r) => r.finishReason === "length").length,
        medianCached: median(results.map((r) => r.cachedTokens)),
        medianIn: median(results.map((r) => r.inTokens))
      };
      rows.push(row);
      console.log(
        `${model.padEnd(38)} think ${thinkingOff ? "OFF" : "ON "}  ` +
        `${String(row.passed + "/" + row.total).padStart(5)} correct  ` +
        `${String(row.medianMs + "ms").padStart(8)}  ` +
        `reasoning p50 ${String(row.medianReasoning).padStart(5)} max ${String(row.maxReasoning).padStart(6)}  ` +
        `out ${String(row.medianOut).padStart(5)}  cut-off ${row.truncated}`
      );
      if (row.failures.length) console.log(`${" ".repeat(40)}missed: ${row.failures.join(", ")}`);
    }
  }

  console.log("");
  console.log("RANKED — correctness first, then median latency. Both matter; correctness matters more,");
  console.log("because a wrong tool costs a whole extra round trip and sometimes a wrong action.");
  const ranked = rows.filter((row) => !row.unreachable)
    .sort((left, right) => (right.passed - left.passed) || (left.medianMs - right.medianMs));
  for (const [index, row] of ranked.entries()) {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${row.model} (thinking ${row.thinkingOff ? "off" : "on"}) — ` +
      `${row.passed}/${row.total}, ${row.medianMs}ms, ${row.medianReasoning} reasoning tokens p50`
    );
  }
  console.log("");
  console.log("Prefix caching is not exercised here — every case is a cold prefix, so the cached");
  console.log("column is expected to be low and says nothing about a real run's bill.");
}

await main();
