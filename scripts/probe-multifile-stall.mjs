// WHY DOES IT WRITE THE FIRST FILE AND THEN NARRATE THE SECOND ONE FOREVER?
//
//   node scripts/probe-multifile-stall.mjs
//   node scripts/probe-multifile-stall.mjs --repeat 5
//   node scripts/probe-multifile-stall.mjs --arms full,no-prompt
//
// THE DEFECT, OBSERVED LIVE 3 SEP 2026. Asked to create a folder and build an
// e-commerce site in HTML/CSS/JS, the agent created the folder, wrote a complete
// 8,079-byte index.html, and then said "Now the CSS:" and called nothing. It was
// nudged, said "Let me create the CSS and JS files now", called nothing again,
// and settled PARTIALLY_COMPLETED. Asked twice more why it had stopped, it
// apologised, re-read the HTML it had already written, said "Let me write both
// files now" — and called nothing. Three runs, ~215 seconds, ~218,000 tokens,
// and style.css and app.js never existed.
//
// The loop's handling of this is CORRECT and is not what is being measured here:
// a turn with no tool call that narrates a next step is nudged once, asked to
// wrap up once, then settled PARTIALLY_COMPLETED. That machinery did exactly
// what it says. The question is upstream of it — why does the model emit prose
// and no call on a step where the next action is completely unambiguous?
//
// WHAT THE TOKEN COUNTS ALREADY RULE OUT. The three live runs reported 2,704,
// 652 and 710 completion tokens. `MODEL_OUTPUT_CEILING` is 4,096 and the loop
// accumulates usage BEFORE it checks `wasTruncated`, so a truncated turn would
// show up as ~4,096 out and a TURN_TRUNCATED event. Neither happened. The model
// is not being cut off. It is choosing not to call the tool, and no amount of
// reading the loop will say why.
//
// SO THIS REPLAYS THE DECISION AND ABLATES THE PROMPT. The conversation below is
// the real one at the moment it stalls: the request, the folder, the successful
// index.html write, and its tool result. The only thing that varies between arms
// is which paragraphs of the system prompt are present. If the stall follows a
// paragraph, that paragraph is the bug; if it survives every ablation, the
// prompt is not the cause and the next suspect is the schema.
//
// WHAT IT FOUND, 3 SEP 2026 — READ THIS BEFORE RE-RUNNING IT.
//
// The stall DID NOT reproduce here: every arm called `write_file` when it was
// given room. The prompt was never the cause, and neither was the conversation
// shape — an assistant message carrying prose beside its tool call, which the
// loop really does send, was ruled out at 5/5.
//
// The cause was the OUTPUT CEILING, and this probe found it by NOT reproducing.
// A non-streaming request at `max_tokens: 4096` answers HTTP 500 on this
// decision, 4/4; at 16,384 it returns a `write_file` carrying 14 KB of CSS,
// which is ~5,000 output tokens — above the ceiling the loop was sending.
// Streaming, the same ceiling is worse than an error: the endpoint streams for
// 21-31 seconds and then sends `[DONE]` with `finish_reason: null` and
// `completion_tokens: 1`, so `wasTruncated` cannot see it and the loop settles
// the run as though the model had finished.
//
// Fixed by raising MODEL_OUTPUT_CEILING to 8,192 — see
// scripts/probe-output-ceiling.mjs for the band that number sits in — and by
// `wasDiscarded` in the loop, which detects the lie from what ARRIVED rather
// than from what the endpoint says about itself.
//
// This file is kept because the arms below are the hypotheses that were WRONG,
// and re-testing them is the expensive way to learn that twice.
//
// NOTHING HERE TOUCHES THE MACHINE. HTTP to the configured endpoint, nothing
// else — no file is written, no window is read, no key is pressed.

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
const REPEATS = Math.max(1, Number(flag("repeat", 4)) || 4);

// Same two spellings the loop sends. See THINKING_OFF in fast-agent/src/index.js.
const THINKING_OFF = {
  chat_template_kwargs: { thinking: false, enable_thinking: false },
  reasoning_effort: "none"
};

const FOLDER = "C:\\Users\\hithe\\OneDrive\\Documents\\syscora_projects\\ecom site";

const ASK =
  'create a folder inside this folder "C:\\Users\\hithe\\OneDrive\\Documents\\syscora_projects" named ecom site, ' +
  "and then create an internactive, responsive, functional html, css, js based ecom application, once done open it. " +
  "make it look beautiful";

// A REALISTIC index.html, because its SIZE is part of the question.
//
// The live run put 8,079 characters of markup into the conversation as the
// arguments of a tool call, and the very next decision is whether to emit
// another payload of about that size. A probe that replays this step with a
// three-line stub is asking an easier question than the one that failed, so the
// filler below brings it to the length the real one had.
const INDEX_HTML = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  '  <meta charset="UTF-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
  "  <title>Lumina — Modern Essentials</title>",
  '  <link rel="stylesheet" href="style.css">',
  "</head>",
  "<body>",
  '  <nav class="navbar">',
  '    <div class="nav-brand">Lumina</div>',
  '    <ul class="nav-links" id="navLinks">',
  '      <li><a href="#" onclick="showView(\'home\')">Home</a></li>',
  '      <li><a href="#" onclick="showView(\'shop\')">Shop</a></li>',
  '      <li><a href="#" onclick="showView(\'about\')">About</a></li>',
  '      <li><a href="#" onclick="showView(\'contact\')">Contact</a></li>',
  "    </ul>",
  '    <button class="cart-btn" onclick="toggleCart()">Cart <span id="cartCount">0</span></button>',
  '    <button class="hamburger" onclick="toggleMenu()">&#9776;</button>',
  "  </nav>",
  '  <aside class="cart-drawer" id="cartDrawer">',
  '    <h3>Your Cart</h3>',
  '    <div id="cartItems"></div>',
  '    <div class="cart-total">Total: $<span id="cartTotal">0.00</span></div>',
  '    <button class="checkout-btn" onclick="checkout()">Checkout</button>',
  "  </aside>",
  '  <div class="overlay" id="overlay" onclick="toggleCart()"></div>',
  '  <main id="home" class="view active">',
  '    <section class="hero"><h1>Design that lasts.</h1><p>Considered essentials for every day.</p></section>',
  '    <section class="featured"><h2>Featured</h2><div class="product-grid" id="featuredGrid"></div></section>',
  "  </main>",
  '  <main id="shop" class="view">',
  '    <div class="filters" id="categoryFilters"></div>',
  '    <select id="sortSelect" onchange="sortProducts(this.value)">',
  '      <option value="default">Sort</option><option value="low">Price: Low</option>',
  "    </select>",
  '    <div class="product-grid" id="shopGrid"></div>',
  "  </main>",
  '  <main id="about" class="view"><h2>About</h2><div class="about-cards"></div></main>',
  '  <main id="contact" class="view">',
  '    <form onsubmit="submitContact(event)"><input id="name" required><button>Send</button></form>',
  "  </main>",
  '  <div class="toast" id="toast"></div>',
  '  <footer class="footer">&copy; 2026 Lumina</footer>',
  '  <script src="app.js"></script>',
  "</body>",
  "</html>"
].join("\n");
// Bring it to the length the real one had, without pretending the filler is
// meaningful markup.
const INDEX_HTML_PADDED = INDEX_HTML +
  "\n<!-- " + "section placeholder ".repeat(Math.ceil((8079 - INDEX_HTML.length) / 20)) + " -->";

// THE CONVERSATION AT THE MOMENT IT STALLS.
//
// Two tool calls that both succeeded, and their results exactly as the toolset
// renders them. The next assistant turn is the one that went wrong live.
//
// `prose` IS NOT COSMETIC AND IS THE REASON THIS FUNCTION TAKES A SHAPE.
//
// The loop pushes `content: turn.text || null` ALONGSIDE the tool calls
// (fast-agent/src/index.js), so every assistant message in a real run carries
// the model's own prose as well as its call. The first version of this probe
// sent `content: null` and the stall did not reproduce — 4/4 wrote the file. A
// replay that leaves out what the loop actually sends is asking an easier
// question than the one that failed, so the prose is a variable here rather
// than an omission.
const REAL_PROSE = {
  first: "I'll create the folder and build an e-commerce application. Let me start.",
  second: "Folder created. Now let me build the e-commerce application. I'll create a beautiful, " +
    "responsive, functional HTML/CSS/JS app."
};

function stalledConversation(systemPrompt, { prose = false } = {}) {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: ASK },
    {
      role: "assistant",
      content: prose ? REAL_PROSE.first : null,
      tool_calls: [{
        id: "c1",
        type: "function",
        function: {
          name: "run",
          arguments: JSON.stringify({
            saw: "The request names a parent folder that already exists and a new folder to make inside it.",
            say: "Creating the folder first.",
            command: `New-Item -ItemType Directory -Path "${FOLDER}" -Force | Select-Object FullName`
          })
        }
      }]
    },
    { role: "tool", tool_call_id: "c1", content: `FullName\n--------\n${FOLDER}\n` },
    {
      role: "assistant",
      content: prose ? REAL_PROSE.second : null,
      tool_calls: [{
        id: "c2",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({
            saw: `The folder ${FOLDER} now exists and is empty.`,
            say: "Writing the HTML structure with navbar, cart drawer and all views.",
            path: `${FOLDER}\\index.html`,
            contents: INDEX_HTML_PADDED
          })
        }
      }]
    },
    { role: "tool", tool_call_id: "c2", content: `Wrote ${FOLDER}\\index.html.` }
  ];
}

// THE ARMS. Each removes exactly one paragraph of the real prompt, chosen
// because it is a plausible reason a model would answer instead of acting. The
// text must match the prompt EXACTLY or the ablation silently does nothing —
// which is why each arm reports whether its cut actually landed.
const ABLATIONS = {
  // The two control arms differ ONLY in whether the assistant messages carry the
  // prose the loop really sends. See stalledConversation.
  "full": null,
  "full+prose": null,
  "no-prompt": "ALL",
  "no-prose-rule": "THAT IS YOUR NARRATION — DO NOT ALSO WRITE IT AS PROSE.",
  "no-stuck-ask": "WHEN YOU ARE STUCK, ASK.",
  "no-private-deliberation": "Keep private deliberation private.",
  "no-waits-on-person": "A STEP THAT WAITS ON A PERSON ENDS YOUR TURN.",
  "no-create-document": "MAKING A DOCUMENT IS \\`create_document\\`, NOT THE TERMINAL.",
  "no-answer-when-done": "When the job is done, say what is now true in one or two sentences."
};

// Remove the whole bullet a phrase sits in, not just the phrase: the prompt is
// one bullet per line, and half a bullet is a different instruction rather than
// an absent one.
function ablate(systemPrompt, marker) {
  if (marker == null) return { prompt: systemPrompt, cut: true, removed: 0 };
  if (marker === "ALL") return { prompt: "You are a helpful assistant with tools.", cut: true, removed: systemPrompt.length };
  const lines = systemPrompt.split("\n");
  const kept = lines.filter((line) => !line.includes(marker));
  return {
    prompt: kept.join("\n"),
    cut: kept.length < lines.length,
    removed: lines.length - kept.length
  };
}

function buildRealToolset() {
  const adapter = new WindowsAdapter();
  // Graded on the CALL, never on its result. Nothing below ever executes.
  adapter.hostRequest = async () => ({ performed: true });
  return buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
}

async function askOnce({ baseUrl, apiKey, model, systemPrompt, tools, prose }) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: stalledConversation(systemPrompt, { prose }),
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      // The loop's ordinary ceiling. Raising it here would measure a different
      // product than the one that failed.
      max_tokens: 4096,
      ...THINKING_OFF
    })
  });
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    return { ok: false, elapsedMs, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
  }
  const body = await response.json();
  const message = body.choices?.[0]?.message ?? {};
  const usage = body.usage ?? {};
  const calls = message.tool_calls ?? [];
  const first = calls[0];
  let contentsLength = null;
  if (first?.function?.name === "write_file") {
    try { contentsLength = String(JSON.parse(first.function.arguments).contents ?? "").length; } catch { contentsLength = -1; }
  }
  return {
    ok: true,
    elapsedMs,
    called: first?.function?.name ?? null,
    callCount: calls.length,
    // THE GRADE. The next action is unambiguous: write style.css or app.js.
    // Anything that calls a tool is progress; prose alone is the defect.
    acted: calls.length > 0,
    wroteFile: first?.function?.name === "write_file",
    contentsLength,
    finishReason: body.choices?.[0]?.finish_reason ?? null,
    outTokens: Number(usage.completion_tokens ?? 0),
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0),
    text: String(message.content ?? "").replace(/\s+/g, " ").slice(0, 110)
  };
}

async function main() {
  const config = loadModelConfig(process.cwd());
  if (!config.apiKey) {
    console.error("No API key resolved from the configuration. Nothing to measure.");
    process.exit(2);
  }
  const toolset = buildRealToolset();
  const tools = toolset.definitions;
  const systemPrompt = new FastAgent({ provider: null, toolset }).systemPrompt;

  const armNames = flag("arms")
    ? flag("arms").split(",").map((name) => name.trim()).filter(Boolean)
    : Object.keys(ABLATIONS);

  console.log("THE MULTI-FILE STALL — one real decision, replayed");
  console.log(`  endpoint   ${config.baseUrl}`);
  console.log(`  model      ${config.model}`);
  console.log(`  tools      ${tools.length} in the schema`);
  console.log(`  prompt     ~${Math.round(systemPrompt.length / 4)} tokens`);
  console.log(`  conversation ends on: Wrote ...\\index.html.  (${INDEX_HTML_PADDED.length} chars of markup above it)`);
  console.log(`  the next action is unambiguous: write style.css or app.js`);
  console.log(`  ${REPEATS} repeat(s) per arm\n`);

  const summary = [];
  for (const arm of armNames) {
    if (!(arm in ABLATIONS)) {
      console.log(`${arm.padEnd(26)} UNKNOWN ARM — skipped`);
      continue;
    }
    const { prompt, cut, removed } = ablate(systemPrompt, ABLATIONS[arm]);
    if (!cut) {
      // AN ABLATION THAT DID NOT LAND MEASURES THE CONTROL ARM AND CALLS IT A
      // RESULT. Say so instead.
      console.log(`${arm.padEnd(26)} MARKER NOT FOUND IN PROMPT — arm invalid, not run`);
      summary.push({ arm, invalid: true });
      continue;
    }
    // Every arm except the bare control replays the conversation the way the
    // loop really builds it, prose and all.
    const prose = arm !== "full";
    const runs = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      let outcome;
      try {
        outcome = await askOnce({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, systemPrompt: prompt, tools, prose });
      } catch (error) {
        outcome = { ok: false, elapsedMs: 0, error: error?.message ?? String(error) };
      }
      if (!outcome.ok) {
        console.log(`${arm.padEnd(26)} UNREACHABLE — ${outcome.error}`);
        runs.length = 0;
        break;
      }
      runs.push(outcome);
    }
    if (!runs.length) continue;

    const acted = runs.filter((run) => run.acted).length;
    const wrote = runs.filter((run) => run.wroteFile).length;
    const medianOut = [...runs].map((r) => r.outTokens).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    const truncated = runs.filter((run) => /^(length|max_tokens)$/i.test(String(run.finishReason))).length;
    const sizes = runs.filter((r) => r.contentsLength > 0).map((r) => r.contentsLength);
    console.log(
      `${arm.padEnd(26)} acted ${acted}/${runs.length}   write_file ${wrote}/${runs.length}   ` +
      `median out ${String(medianOut).padStart(5)}   truncated ${truncated}/${runs.length}` +
      (removed ? `   (-${removed} line${removed === 1 ? "" : "s"})` : "")
    );
    for (const run of runs) {
      console.log(
        `    ${(run.called ?? "NO TOOL CALL").padEnd(16)} out ${String(run.outTokens).padStart(5)} ` +
        `finish ${String(run.finishReason).padEnd(10)}` +
        (run.contentsLength > 0 ? ` contents ${run.contentsLength}` : "") +
        (run.acted ? "" : `  "${run.text}"`)
      );
    }
    console.log("");
    summary.push({ arm, acted, total: runs.length, wrote, medianOut, sizes });
  }

  console.log("READ IT LIKE THIS");
  console.log("  `acted` is the whole grade: the next action is unambiguous, so any tool call is progress");
  console.log("  and prose alone is the defect that shipped. An arm that restores `acted` names the cause.");
  const full = summary.find((row) => row.arm === "full");
  if (full && full.total) {
    console.log(`\n  full prompt acted ${full.acted}/${full.total}.`);
    if (full.acted === full.total) {
      console.log("  THE STALL DID NOT REPRODUCE on this decision. The prompt is not the whole story:");
      console.log("  re-check with a larger first file, or the defect is in the loop's own conversation");
      console.log("  reconstruction rather than in what the model is asked.");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
