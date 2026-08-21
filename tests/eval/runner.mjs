// The eval runner.
//
// Starts a real daemon in-process, sends each task through the same route the
// chat surface uses, and then checks the MACHINE — never the agent's own account
// of what it did. Writes a JSON record per run and regenerates the scoreboard.
//
//   node tests/eval/runner.mjs [--only id] [--category files] [--repeat 3] [--mock]
//                             [--manual] [--write-budgets] [--slack 1.4]
//
// See README.md in this directory for the rules a task has to follow.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { startServer } from "../../apps/daemon/src/server.js";
import { resolveStateDir } from "../../packages/shared-types/src/state-path.js";
import { closeWindowsAutomationHost } from "../../os-adapters/windows-host/src/client.js";
import {
  median, spread, summarise, budgetsFrom, checkBudgets, noiseBand, detectability,
  DETECTS, MATTERS_ABOVE_SENT
} from "./budgets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const TOKEN = `eval-${crypto.randomBytes(12).toString("hex")}`;

// What a million tokens costs, so the scoreboard can talk in money. Override
// with SYSCORA_EVAL_COST_IN / _OUT when the provider or model changes.
const COST_PER_MTOK_IN = Number(process.env.SYSCORA_EVAL_COST_IN ?? 0.3);
const COST_PER_MTOK_OUT = Number(process.env.SYSCORA_EVAL_COST_OUT ?? 1.2);

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? true);
};
const options = {
  only: flag("only"),
  category: flag("category"),
  repeat: Number(flag("repeat") ?? 1),
  mock: argv.includes("--mock"),
  manual: argv.includes("--manual"),
  // Record what this run measured as the budget every later run is held to.
  // Deliberately a separate, explicit act: a budget that silently redefines
  // itself on every run cannot detect a regression, it can only ratify one.
  writeBudgets: argv.includes("--write-budgets"),
  // HOW MUCH WORSE THAN THE BASELINE IS STILL NOISE.
  //
  // "read last 2 messages" measured 29,759 and 122,000 fresh tokens on the same
  // code the same day — a 4x spread, decided by which chat WhatsApp happened to
  // open on. A budget set tight against a single run would fail on that alone
  // and teach everyone to ignore the eval. So budgets are set from the median of
  // a repeated baseline, checked against the median of a repeated run, with
  // headroom on top. Override per run when a change is expected to cost more.
  slack: Number(flag("slack") ?? 1.4),
  // Re-aggregate a run that already happened, from its saved results file, and
  // touch nothing on the machine. Every run's raw records are kept under
  // tests/eval/results/, so changing how a budget is DERIVED need not mean
  // driving Notepad and WhatsApp around for another half hour to find out what
  // the change would have said. It also makes the derivation auditable: same
  // input, different formula, comparable output.
  from: flag("from")
};

// ---- Running PowerShell for setup, verification and teardown -----------------
//
// Deliberately NOT through the agent's own adapter: a verification that shares
// a code path with the thing it is verifying can be fooled by the same bug.
function powershell(script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1 });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(error?.message ?? error), exitCode: -1 });
    });
  });
}

// A WINDOWS PATH IN JSON IS A TRAP, AND IT BLAMES THE AGENT.
//
// `"{workspace}\typed.txt"` is not a path: JSON reads `\t` as a TAB, so the
// prompt asked the agent to save to `…eval-workspace<TAB>yped.txt` and the
// verify then looked for that same impossible file. `\report.docx` became a
// carriage return, so the .docx fixture was written somewhere unopenable and the
// agent was marked WRONG for correctly reporting the document did not exist.
//
// Three of fourteen tasks were failing this way, one of them the headline GUI
// task at 213,000 tokens — a scoreboard that says the agent is broken when the
// ruler is. Cheap to prevent, and it must be loud: a silently mis-specified task
// is worse than no task, because it is believed.
function assertNoControlCharacters(task, fileName) {
  const strings = [
    task.prompt,
    ...[task.assertFinalMessage].flat().filter(Boolean),
    ...(task.verify ?? []).flatMap((check) => [check.run, check.expect, check.expectNot]),
    ...(task.setup ?? []).map((step) => step.run),
    ...(task.teardown ?? []).map((step) => step.run)
  ].filter((value) => typeof value === "string");
  for (const value of strings) {
    const found = value.match(/[\t\r\n\f\v\b]/);
    if (!found) continue;
    const escaped = JSON.stringify(found[0]);
    throw new Error(
      `${fileName}: a control character (${escaped}) reached a task string, which almost always means a ` +
      `single-escaped Windows path — write "{workspace}\\\\file.txt", not "{workspace}\\file.txt".\n` +
      `  in: ${JSON.stringify(value.slice(0, 120))}`
    );
  }
}

/**
 * Press stop on a running request and wait for it to actually settle.
 *
 * Returns the settled session if it got there, otherwise null. Best-effort
 * throughout: this runs on the failure path, and a runner that throws while
 * cleaning up after a failure loses the whole suite rather than one task.
 */
async function stopSession(port, sessionId, { graceMs = 45000 } = {}) {
  const headers = { "x-syscora-token": TOKEN };
  await fetch(`http://127.0.0.1:${port}/api/intents/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST", headers
  }).catch(() => {});
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await fetch(
      `http://127.0.0.1:${port}/api/intents/${encodeURIComponent(sessionId)}/status`,
      { headers }
    ).catch(() => null);
    if (!status?.ok) continue;
    const body = await status.json().catch(() => null);
    if (body?.settled || body?.session?.finalResponse) return body.session ?? body;
  }
  return null;
}

/**
 * Run the same request again, this time with the route saved.
 *
 * `docs/skills.md` §12: the second run must pass the SAME independent check,
 * make zero model calls, and cost under a thousand tokens against the first
 * run's hundred-odd thousand. All four are checked here rather than eyeballed,
 * because "it felt faster" is exactly the claim this harness exists to replace.
 */
async function runSecondTime(task, first, { port, workspace }) {
  const second = { ...task, id: `${task.id}-replay`, isReplay: true };
  if (!first.offeredSkill) {
    return {
      ...first, id: second.id, pass: false, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensFresh: 0, steps: 0, elapsedMs: 0,
      reason: "the first run offered no route to save, so there is nothing to replay"
    };
  }
  const saved = await fetch(`http://127.0.0.1:${port}/api/skills`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-syscora-token": TOKEN },
    body: JSON.stringify({ skill: first.offeredSkill })
  }).then((response) => response.json()).catch((error) => ({ saved: false, problems: [String(error)] }));
  if (!saved.saved) {
    return {
      ...first, id: second.id, pass: false, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensFresh: 0, steps: 0, elapsedMs: 0,
      reason: `the offered route was refused: ${(saved.problems ?? []).join("; ")}`
    };
  }

  const record = await runTask(second, { port, workspace });
  const spent = record.tokensIn + record.tokensOut;
  const budget = Number(task.replayTokenBudget ?? 1000);
  if (record.pass && spent > budget) {
    record.pass = false;
    record.reason = `the replay cost ${spent.toLocaleString()} tokens against a budget of ${budget.toLocaleString()} — ` +
      "it went to the model, which is the one thing a replay must not do";
  }
  if (record.pass && record.replayed !== true) {
    record.pass = false;
    record.reason = "the request was answered, but not by the saved route";
  }
  return record;
}

async function loadTasks() {
  const dir = path.join(here, "tasks");
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const tasks = [];
  for (const name of names) {
    const task = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    assertNoControlCharacters(task, name);
    tasks.push(task);
  }
  const selected = tasks.filter((task) => {
    if (options.only && task.id !== options.only) return false;
    if (options.category && task.category !== options.category) return false;
    if (task.manual && !options.manual && !options.only) return false;
    return true;
  });
  // THE HEADLINE NUMBER GETS QUOTED TO PEOPLE WHO CANNOT CHECK IT, SO ITS
  // DENOMINATOR HAS TO BE UNAMBIGUOUS.
  //
  // The header used to read "19 tasks × 3 = 60 runs", which is not arithmetic —
  // 19 × 3 is 57 — and the pass rate underneath it was out of 20. Three
  // different populations were being called "tasks": the 19 files on disk, the
  // 15 that run without --manual, and the 20 ROWS that appear on the scoreboard,
  // because `skill-replay-file-write` runs twice and reports the derive and the
  // replay separately. Nothing was wrong with the measurement; the label was
  // wrong, which is worse, because a wrong label is quoted with confidence.
  return {
    tasks: selected,
    census: {
      files: tasks.length,
      selected: selected.length,
      manualTotal: tasks.filter((task) => task.manual).length,
      manualIncluded: selected.filter((task) => task.manual).length,
      // Each of these contributes a SECOND row: the same request again with the
      // route it just derived, which is the whole claim of skills.
      extraRows: selected.filter((task) => task.replayTwice).length
    }
  };
}

// ---- One task ----------------------------------------------------------------

async function runTask(task, { port, workspace }) {
  // `{fixtures}` expands with FORWARD slashes on purpose. PowerShell takes them
  // happily, and it keeps the token from ever introducing the backslash that
  // `assertNoControlCharacters` exists to catch — a verify script path is exactly
  // the kind of long string where `\t` would be pasted in and not noticed.
  const expand = (text) => String(text ?? "")
    .replaceAll("{workspace}", workspace)
    .replaceAll("{fixtures}", path.join(here, "fixtures").replaceAll("\\", "/"));
  const record = {
    id: task.id,
    category: task.category ?? "uncategorised",
    prompt: expand(task.prompt),
    pass: false,
    reason: null,
    steps: 0,
    toolCalls: 0,
    elapsedMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    // WHAT WAS SENT IS NOT WHAT WAS BILLED, AND ONLY ONE OF THEM IS MONEY.
    //
    // The endpoint serves the longest identical prefix of a request from cache
    // at roughly a tenth of the price — measured, 8,320 of the 8,222-token fixed
    // prefix on every step after the first (scripts/probe-prompt-cache.mjs). The
    // scoreboard quoted `tokensIn + tokensOut`, which counts a cached token and
    // a fresh one the same, and so overstated a long GUI run by close to an
    // order of magnitude and pointed the optimisation work at the wrong thing.
    // `tokensFresh` is the number a budget is set on.
    tokensCached: 0,
    tokensFresh: 0,
    finalMessage: "",
    // WHICH TOOLS, IN WHAT ORDER.
    //
    // A number on its own is a symptom. The very first real run said "what is 17
    // times 23" cost 37,206 tokens over 4 steps — true, and useless, until you
    // can see it called three tools to multiply two numbers. The sequence is
    // what turns a measurement into a diagnosis.
    tools: [],
    verifications: []
  };

  // A SETUP STEP THAT UNDOES WHAT THE REPLAY IS ABOUT TO TEST.
  //
  // `runSecondTime` re-enters here with the same task, so the same setup runs
  // again — and the skills task's setup deletes the saved route. It was deleting
  // the very route that had just been accepted, so the replay found nothing to
  // replay, went to the model, and was recorded as "the replay cost 39,823
  // tokens", which reads as the skills feature being broken. `onlyOnFirstRun`
  // marks a step that prepares the FIRST run and would sabotage the second.
  for (const step of task.setup ?? []) {
    if (step.onlyOnFirstRun && task.isReplay) continue;
    await powershell(expand(step.run));
  }

  const startedAt = Date.now();
  try {
    // ONE TASK MUST NOT BE ABLE TO KILL THE REST OF THE SUITE.
    //
    // Observed 19 Aug 2026 on the first full baseline: the WhatsApp task hit its
    // 240s timeout, the runner moved on — and the agent was still working. The
    // daemon enforces one request at a time (there is one pointer and one
    // screen), so it answered 409 to every task after it. Rounds 2 and 3, all
    // thirty-odd runs, recorded `0 fresh · 0.0s · daemon returned 409`. A
    // scoreboard of zeros that looks like a catastrophic regression and is
    // actually one unstopped session.
    //
    // Two halves, because either alone leaves a hole: below, a timeout STOPS the
    // session it started; here, a 409 is treated as somebody else's leftover,
    // stopped, and the request retried once. The second half is what makes the
    // suite recoverable rather than merely well-behaved.
    const submit = () => fetch(`http://127.0.0.1:${port}/api/intents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-syscora-token": TOKEN },
      body: JSON.stringify({ text: expand(task.prompt), history: [], autoApprove: true })
    });
    let response = await submit();
    if (response.status === 409) {
      const conflict = await response.json().catch(() => ({}));
      if (conflict.sessionId) {
        await stopSession(port, conflict.sessionId);
        response = await submit();
      }
    }
    if (!response.ok) throw new Error(`daemon returned ${response.status}`);
    const { sessionId } = await response.json();

    // Watch the events as they stream, so the tool sequence is captured even
    // when the run ends badly.
    const watcher = fetch(
      `http://127.0.0.1:${port}/api/intents/${encodeURIComponent(sessionId)}/stream`,
      { headers: { "x-syscora-token": TOKEN } }
    ).then(async (stream) => {
      if (!stream.ok || !stream.body) return;
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n");
        while (cut !== -1) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            const type = event.type ?? event.eventType;
            if (type === "TOOL_FINISHED") {
              record.tools.push(`${event.details?.tool}${event.details?.ok === false ? "✗" : ""}`);
            }
            // The route this run would offer to keep. Captured so a task can
            // measure what replaying it costs; accepting it is a separate,
            // explicit step, because in the product a person does that.
            if (type === "SKILL_OFFERED") record.offeredSkill = event.details?.skill ?? null;
            if (type === "SKILL_REPLAYED") record.replayed = true;
          } catch { /* a half-line is not an error */ }
        }
      }
    }).catch(() => {});
    void watcher;

    // Poll rather than stream: the runner only wants the settled outcome, and
    // polling cannot lose events to a dropped connection.
    const deadline = Date.now() + (task.timeoutMs ?? 180000);
    let session = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const status = await fetch(
        `http://127.0.0.1:${port}/api/intents/${encodeURIComponent(sessionId)}/status`,
        { headers: { "x-syscora-token": TOKEN } }
      );
      if (!status.ok) continue;
      const body = await status.json();
      if (body?.settled || body?.session?.finalResponse) {
        session = body.session ?? body;
        break;
      }
    }
    record.elapsedMs = Date.now() - startedAt;
    if (!session) {
      record.reason = "timed out waiting for the agent to settle";
      // The other half of the fix above: give up on the ANSWER, never on the
      // SESSION. Press stop the way the user would and wait for it to actually
      // settle — an abort is a request to a loop that is mid-tool-call, not an
      // instant. Whatever it did on the machine stays done; that is what the
      // task's own teardown is for.
      //
      // Its metrics are still read below when it settles. A run that timed out
      // having spent 400,000 tokens and a run that timed out on step one are
      // different diagnoses, and recording both as zero throws that away — which
      // is exactly what the WhatsApp row said before this.
      session = await stopSession(port, sessionId);
    }
    if (session) {
      const metrics = session.finalResponse?.metrics ?? {};
      record.steps = metrics.steps ?? 0;
      record.toolCalls = metrics.toolCalls ?? 0;
      record.tokensIn = metrics.tokensIn ?? 0;
      record.tokensOut = metrics.tokensOut ?? 0;
      record.tokensCached = metrics.tokensCached ?? 0;
      // Derived rather than trusted, for the case where a provider reports no
      // cache detail at all: with nothing cached, every input token was fresh.
      record.tokensFresh = metrics.tokensFresh ?? Math.max(0, record.tokensIn - record.tokensCached);
      record.finalMessage = String(
        session.finalResponse?.summary?.summary
        ?? session.finalResponse?.message
        ?? ""
      ).slice(0, 400);
    }
  } catch (error) {
    record.elapsedMs = Date.now() - startedAt;
    record.reason = `request failed: ${error?.message ?? error}`;
  }

  // THE MACHINE'S ANSWER, NOT THE AGENT'S.
  const checks = task.verify ?? [];
  const answers = [task.assertFinalMessage].flat().filter(Boolean);
  if (checks.length === 0 && answers.length === 0) {
    record.reason = "task has neither a verify nor an assertFinalMessage — it can never fail, so it proves nothing";
    return record;
  }

  let passed = true;
  for (const check of checks) {
    const result = await powershell(expand(check.run));
    const output = result.stdout;
    const wanted = expand(check.expect ?? check.expectNot ?? "");
    const found = output.toLowerCase().includes(String(wanted).toLowerCase());
    const ok = check.expectNot ? !found : found;
    record.verifications.push({ run: expand(check.run), expected: wanted, got: output.slice(0, 200), ok });
    if (!ok) passed = false;
  }

  // Some answers live in the transcript rather than on disk — who wrote a book,
  // which package id, what a document says. Checking the agent's sentence
  // against a value WE supply is not self-grading: the ground truth comes from
  // the task, not from the agent. What is forbidden is asking the agent whether
  // it succeeded.
  for (const expected of answers) {
    const ok = record.finalMessage.toLowerCase().includes(String(expected).toLowerCase());
    record.verifications.push({
      run: "final answer",
      expected,
      got: record.finalMessage.slice(0, 200),
      ok
    });
    if (!ok) passed = false;
  }

  record.pass = passed && !record.reason;
  if (!record.pass && !record.reason) {
    const failed = record.verifications.filter((check) => !check.ok);
    record.reason = failed.length
      ? `expected ${JSON.stringify(failed[0].expected)}, got ${JSON.stringify(failed[0].got.slice(0, 60))}`
      : "verification failed";
  }

  for (const step of task.teardown ?? []) await powershell(expand(step.run));
  return record;
}

// ---- Aggregating repeats ------------------------------------------------------
//
// A SINGLE RUN OF A GUI TASK IS NOT A MEASUREMENT.
//
// Every number this project has quoted was an n=1 hand-run, and "read the last
// two messages" measured 29,759 and 122,000 fresh tokens on the same code the
// same day — decided by which chat WhatsApp happened to be showing. At that
// spread a single run cannot distinguish a 30% improvement from luck, which is
// how a regression gets merged with a graph attached. So every task is run N
// times and reported as a median AND a spread; a median with no spread beside it
// hides exactly the variance that makes the median unreliable.


const costOf = (record) =>
  (record.tokensIn / 1e6) * COST_PER_MTOK_IN + (record.tokensOut / 1e6) * COST_PER_MTOK_OUT;



// ---- Budgets ------------------------------------------------------------------
//
// WHAT THE EVAL IS FOR. Without this it is a report; with it, it is a gate.
//
// A change that makes a task pass while doubling what it costs is a regression,
// and the scoreboard as it stood would have shown that as two green ticks. The
// budgets are recorded from a measured baseline (`--write-budgets`), never
// hand-guessed, and they are checked against the MEDIAN of a repeated run so
// that one unlucky run cannot fail the build on its own.

const BUDGETS_FILE = path.join(here, "budgets.json");

async function loadBudgets() {
  try {
    return JSON.parse(await fs.readFile(BUDGETS_FILE, "utf8"));
  } catch {
    return null;
  }
}


// ---- Scoreboard ---------------------------------------------------------------

function scoreboard(records, summaries, meta) {
  const passed = summaries.filter((summary) => summary.pass);
  const rate = summaries.length ? Math.round((passed.length / summaries.length) * 100) : 0;
  const lines = [];
  lines.push("# SYSCORA scoreboard");
  lines.push("");
  // WHICH CODE THIS MEASURED. A scoreboard with no commit on it cannot be
  // compared to anything later, and this file is the thing a merge is gated on.
  lines.push(`Generated ${meta.at} · ${meta.model}`);
  lines.push("");
  lines.push(`Code under test: \`${meta.commit}\``);
  lines.push("");
  // Spelled out rather than multiplied, because three different numbers here can
  // all honestly be called "tasks" and only one of them is the denominator.
  const census = meta.census;
  if (census) {
    lines.push("**What was measured**");
    lines.push("");
    lines.push(`- **${census.files} task files** on disk, of which **${census.selected} ran**` +
      (census.manualTotal
        ? ` — including ${census.manualIncluded} of the ${census.manualTotal} opt-in \`manual\` tasks, ` +
          "which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed"
        : ""));
    const s = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    lines.push(`- **${s(summaries.length, "scoreboard row")}**` +
      (census.extraRows
        ? `, because ${s(census.extraRows, "task")} runs twice: once to derive a route and once to replay ` +
          "it, and those are reported separately"
        : ""));
    lines.push(`- **${s(meta.repeat, "repeat")}** of each row = **${s(records.length, "run")}**`);
    lines.push(`- The pass rate below is out of the **${s(summaries.length, "row")}**, and a row counts as ` +
      "passing only when EVERY repeat passed");
    lines.push("");
  }
  if (meta.label) lines.push(`**${meta.label}**\n`);
  lines.push("Costs are quoted as **fresh** input tokens — what is billed at full rate. The");
  lines.push("endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a");
  lines.push("tenth of the price, so `tokensIn` is bandwidth, not money.");
  lines.push("");
  const freshBand = noiseBand(summaries, (summary) => summary.freshRuns ?? []);
  const timeBand = noiseBand(summaries, (summary) => summary.elapsedRuns ?? []);
  const band = (value, measured, format = (v) => v.toLocaleString()) =>
    (measured ? `${format(value)} · moved ${format(measured.low)}–${format(measured.high)} (${measured.swingPercent}%) across this run's own ${measured.sweeps} sweeps` : format(value));
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| **Pass rate** | **${rate}%** (${passed.length} of ${summaries.length} rows passing every repeat) |`);
  lines.push(`| Median fresh tokens | ${band(median(summaries.map((s) => s.medianFresh)), freshBand)} |`);
  lines.push(`| Median time | ${band(median(summaries.map((s) => s.medianElapsedMs)), timeBand, (v) => `${(v / 1000).toFixed(1)}s`)} |`);
  lines.push(`| Median steps | ${median(summaries.map((s) => s.medianSteps))} |`);
  lines.push(`| Total cost of this run | $${records.reduce((sum, r) => sum + costOf(r), 0).toFixed(3)} |`);
  if (meta.stagedPipelineReaches !== null && meta.stagedPipelineReaches !== undefined) {
    // The number that decides whether ~20,000 lines of offline pipeline get
    // deleted. Zero across a full suite is the evidence for deleting them;
    // anything else is the list of cases that still need it.
    lines.push(`| Offline pipeline reached | ${meta.stagedPipelineReaches} times |`);
  }
  lines.push("");

  // WHAT THIS SCOREBOARD CAN AND CANNOT SEE.
  //
  // The headline median used to be quoted as though a merge could be gated on
  // it. It cannot: it is a median-of-medians over a suite where most rows cost
  // a few hundred tokens, so the middle of the list drifts for free, and the
  // same commit scored 212 and 186 on consecutive runs. The per-row budgets are
  // the instrument. This says so on the page rather than in a document nobody
  // reads next to the number they are about to trust.
  // AGAINST THE CEILINGS ACTUALLY IN FORCE, not the ones this run would record
  // for itself. Those are different numbers and only one of them is the gate:
  // budgets recorded on a noisier day are looser, and a scoreboard that quoted
  // its own freshly-derived sensitivity would claim the gate could see things
  // the gate cannot. Measured 21 Aug 2026 — derived-from-this-run said 2 rows of
  // 4, the recorded budgets caught 1.
  const inForce = meta.budgets?.tasks ?? budgetsFrom(summaries, meta).tasks;
  const recorded = Boolean(meta.budgets?.tasks);
  const costly = summaries.filter((summary) => summary.medianTokensIn >= MATTERS_ABOVE_SENT);
  const canSeeFresh = costly.filter((summary) => {
    const ceiling = inForce[summary.id]?.tokensIn;
    return ceiling !== undefined && summary.medianTokensIn * DETECTS > ceiling;
  });
  const ungated = costly.filter((summary) => inForce[summary.id]?.tokensIn === undefined);
  const cacheRate = median(summaries.map((summary) => summary.medianCacheRate ?? 0));
  lines.push("**How much of this is signal**");
  lines.push("");
  if (freshBand) {
    lines.push(`- The headline median moved **${freshBand.swingPercent}%** (${freshBand.low.toLocaleString()}–` +
      `${freshBand.high.toLocaleString()}) across this run's own ${freshBand.sweeps} identical sweeps. ` +
      `**It is not the gate**, and a change smaller than that band cannot be read off it.`);
  }
  lines.push(`- **The endpoint served ${cacheRate}% of the input from its cache on this run.** ` +
    "Fresh tokens are the money and that share decides them: the drawing row measured 7,912 fresh at " +
    "98% and 103,455 fresh at 68% on identical code twenty minutes apart, while tokens SENT moved 8%. " +
    "**Read any cost difference against this number before looking for a bug**, and compare fresh " +
    "tokens only between runs whose cache rates are close.");
  lines.push(`- **The gate is the per-row budgets** in \`budgets.json\`, on tokens SENT rather than fresh, ` +
    `checked against each row's median` +
    (recorded ? `, as recorded ${meta.budgets.recordedAt}` : " — none recorded yet, so the figures below are what this run WOULD record") + ".");
  lines.push(`- Of the **${costly.length} rows sending over ${MATTERS_ABOVE_SENT.toLocaleString()} tokens** — ` +
    "the ones doing enough work for 20% to mean something — " +
    `**${canSeeFresh.length} would catch one**` +
    (canSeeFresh.length ? `: ${canSeeFresh.map((s) => `\`${s.id}\``).join(", ")}` : "") + ". " +
    (canSeeFresh.length < costly.length - ungated.length
      ? `The others vary by more than 20% run to run, so raising \`--repeat\` is what would sharpen them — not a tighter ceiling, which would only produce false breaches.`
      : ""));
  if (ungated.length) {
    lines.push(`- **${ungated.length} of those rows is not gated at all** — ` +
      `${ungated.map((s) => `\`${s.id}\``).join(", ")} has no recorded budget. ` +
      "A row nobody has recorded a baseline for cannot regress, which is the most comfortable kind of green there is. " +
      "Re-record with `--write-budgets`.");
  }
  lines.push("");

  if (meta.breaches?.length) {
    lines.push("## Budget breaches");
    lines.push("");
    for (const breach of meta.breaches) lines.push(`- ${breach}`);
    lines.push("");
  }
  lines.push("## By task");
  lines.push("");
  lines.push("Median of the repeats, with the full spread beside it where the runs disagreed.");
  lines.push("");
  lines.push("| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const summary of summaries) {
    lines.push([
      summary.id,
      summary.category,
      `${summary.pass ? "✅" : "❌"} ${summary.passes}/${summary.runs}`,
      summary.medianSteps + (summary.stepSpread ? ` (${summary.stepSpread})` : ""),
      summary.medianFresh.toLocaleString(),
      summary.freshSpread,
      `${(summary.medianElapsedMs / 1000).toFixed(1)}s`,
      summary.timeSpread,
      summary.pass ? "" : (summary.reason ?? "").slice(0, 80)
    ].join(" | ").replace(/^/, "| ").concat(" |"));
  }
  lines.push("");
  lines.push("## The most expensive tasks");
  lines.push("");
  const dearest = [...summaries].sort((a, b) => b.medianFresh - a.medianFresh).slice(0, 5);
  for (const summary of dearest) {
    lines.push(
      `- **${summary.id}** — ${summary.medianFresh.toLocaleString()} fresh tokens over ` +
      `${summary.medianSteps} steps. ${summary.pass ? "Passed, which is why nobody noticed." : "Failed."}` +
      (summary.tools.length ? `\n  \`${summary.tools.join(" → ")}\`` : "")
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---- Go -----------------------------------------------------------------------

async function main() {
  if (options.from) {
    const saved = JSON.parse(await fs.readFile(path.resolve(options.from), "utf8"));
    await report(saved.records, {
      at: saved.at,
      model: saved.model,
      repeat: saved.repeat ?? 1,
      census: saved.census ?? null,
      stagedPipelineReaches: saved.stagedPipelineReaches ?? null,
      commit: `${saved.commit ?? "unknown"} (re-aggregated from ${path.basename(options.from)})`,
      label: null
    }, { write: false });
    return;
  }

  const { tasks, census } = await loadTasks();
  if (tasks.length === 0) {
    console.log("No tasks matched.");
    return;
  }

  // Must resolve the same way the daemon does. A workspace still pinned to
  // <repo>/.syscora after the state directory moved would put the eval's files
  // in one place and the agent's config, notes and skills in another — and the
  // rows that read a file back would fail for a reason that has nothing to do
  // with the agent.
  const workspace = path.join(resolveStateDir(repoRoot), "eval-workspace");
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });

  process.env.SYSCORA_API_TOKEN = TOKEN;
  if (options.mock) process.env.SYSCORA_MODEL_PROVIDER = "mock";

  const server = startServer({ port: 0, basePath: repoRoot, warmHost: !options.mock });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const model = options.mock ? "mock" : (process.env.SYSCORA_MODEL_NAME ?? "configured provider");

  console.log(
    `Running ${tasks.length} of ${census.files} task files × ${options.repeat} repeats against ${model}\n` +
    `  ${census.manualIncluded} of ${census.manualTotal} opt-in tasks included` +
    `${census.extraRows ? ` · ${census.extraRows} task reports a second row for its replay` : ""}\n`
  );
  const records = [];
  for (let round = 1; round <= options.repeat; round += 1) {
    for (const task of tasks) {
      process.stdout.write(`  ${task.id}${options.repeat > 1 ? ` (${round})` : ""} … `);
      const record = await runTask(task, { port, workspace });
      records.push(record);
      console.log(
        `${record.pass ? "PASS" : "FAIL"}  ${record.steps} steps · ` +
        `${record.tokensFresh.toLocaleString()} fresh (${(record.tokensIn + record.tokensOut).toLocaleString()} sent) · ` +
        `${(record.elapsedMs / 1000).toFixed(1)}s${record.pass ? "" : `  — ${record.reason}`}`
      );
      if (record.tools.length) console.log(`        ${record.tools.join(" → ")}`);

      // THE SAME REQUEST, A SECOND TIME. The entire claim of skills is that the
      // hundredth run is not as expensive as the first, and that is not a thing
      // you can assert — it is a thing you measure twice and subtract.
      //
      // Accepting the offered route is done here, explicitly, standing in for
      // the person who would click yes. The product still never saves one by
      // itself; the harness is allowed to, because it is the one measuring.
      if (task.replayTwice) {
        const second = await runSecondTime(task, record, { port, workspace });
        records.push(second);
        const secondTokens = (second.tokensIn + second.tokensOut).toLocaleString();
        console.log(
          `  ${task.id} (replay) … ${second.pass ? "PASS" : "FAIL"}  ${second.steps} steps · ` +
          `${secondTokens} tokens · ${(second.elapsedMs / 1000).toFixed(1)}s` +
          `${second.pass ? "" : `  — ${second.reason}`}`
        );
      }
    }
  }

  // HOW OFTEN THE OFFLINE PIPELINE WAS REACHED ACROSS THE WHOLE SUITE.
  //
  // Read before the server closes, because the counter lives in the daemon's
  // process. `docs/production-plan.md` W4.2 wants ~20,000 lines of staged
  // pipeline deleted or quarantined; it is quarantined now, behind a typed
  // MODEL_UNREACHABLE, and this is the number that decides whether it is
  // deleted. On 20 Aug 2026 it was being reached by any FAILED run with no tool
  // calls — including a correct safety refusal — and cost ~90 seconds each time.
  const stagedPipelineReaches = await fetch(`http://127.0.0.1:${port}/api/health`)
    .then((response) => response.json())
    .then((body) => Number(body?.stagedPipelineReaches ?? 0))
    .catch(() => null);

  await new Promise((resolve) => server.close(resolve));

  // Closing the HTTP server is only half of stopping. The daemon also spawned
  // the long-lived PowerShell automation host, and nothing stopped it: 15 of
  // them were found alive on this machine on 21 Aug 2026, 801 MB resident, the
  // oldest 170.9 hours old. Worse, the undead child's stdio pipe keeps Node's
  // event loop referenced — so this runner set `process.exitCode` below, printed
  // the whole scoreboard, and then never exited. A gate that never returns
  // cannot gate anything, which is why `npm run eval` had never run in CI.
  closeWindowsAutomationHost();

  const at = new Date().toISOString();
  const head = await new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(out.trim() || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
  const dirty = await new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => resolve(out.trim().length > 0));
    child.on("error", () => resolve(false));
  });
  await report(records, {
    at,
    model,
    commit: `${head}${dirty ? " + uncommitted changes" : ""}`,
    stagedPipelineReaches,
    repeat: options.repeat,
    census,
    label: options.only || options.category
      ? `Partial run — ${options.only ? `only ${options.only}` : `category ${options.category}`}. ` +
        "Not a baseline; the budgets file is only written by a full run."
      : (options.manual ? null : "Automatic tasks only. Run with --manual to include the four that touch " +
        "the volume, WhatsApp and the webview.")
  }, { write: true, records });
}

/**
 * Aggregate, gate and publish. Split out from the running so that `--from` can
 * re-derive a past run's verdict without touching the machine.
 */
async function report(records, meta, { write = true } = {}) {
  const summaries = summarise(records, costOf);
  meta.slack = options.slack;

  // A PARTIAL RUN MUST NOT BE ABLE TO REWRITE THE BUDGETS.
  //
  // `--only one-task --write-budgets` would otherwise drop every other task's
  // ceiling from the file, and the next full run would sail through with nothing
  // held to anything. Recording a baseline is a whole-suite act.
  const budgets = await loadBudgets();
  const partial = Boolean(options.only || options.category);
  if (options.writeBudgets && partial) {
    console.log("\nRefusing --write-budgets on a partial run: a baseline is the whole suite or it is not a baseline.");
  } else if (options.writeBudgets) {
    await fs.writeFile(BUDGETS_FILE, `${JSON.stringify(budgetsFrom(summaries, meta), null, 2)}\n`);
    console.log(`\nRecorded ${summaries.length} budgets from this run into tests/eval/budgets.json`);
  }
  meta.breaches = options.writeBudgets ? [] : checkBudgets(summaries, budgets);
  // The ceilings actually in force, so the scoreboard reports the sensitivity of
  // the gate rather than of a gate it could hypothetically record for itself.
  meta.budgets = options.writeBudgets ? null : budgets;

  const board = scoreboard(records, summaries, meta);
  if (write) {
    const resultsDir = path.join(here, "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(
      path.join(resultsDir, `${meta.at.replace(/[:.]/g, "-")}.json`),
      JSON.stringify({ at: meta.at, model: meta.model, commit: meta.commit, repeat: meta.repeat, census: meta.census, stagedPipelineReaches: meta.stagedPipelineReaches, summaries, records }, null, 2)
    );
    await fs.writeFile(path.join(here, "scoreboard.md"), board);
  }

  console.log(`\n${board.split("## By task")[0].trim()}`);
  if (meta.breaches.length) {
    console.log(`\nBUDGET BREACHES (${meta.breaches.length}):`);
    for (const breach of meta.breaches) console.log(`  - ${breach}`);
  } else if (options.writeBudgets) {
    // Nothing to say: this run just BECAME the baseline, so there was nothing to
    // hold it to. Saying "no budgets recorded yet" here, as it did, reads as the
    // gate having silently failed to write.
  } else if (budgets) {
    console.log(`\nNo budget breached against the baseline recorded ${budgets.recordedAt}.`);
  } else {
    console.log("\nNo budgets recorded yet — run once with --write-budgets to make this a gate.");
  }
  console.log(write ? "\nFull scoreboard: tests/eval/scoreboard.md" : "\n(re-aggregated only — nothing was written)");
  // A non-zero exit when anything failed OR got quietly more expensive. The
  // second half is the point: a change that keeps every task passing while
  // doubling what it costs used to show up here as a page of green ticks.
  process.exitCode = summaries.every((summary) => summary.pass) && meta.breaches.length === 0 ? 0 : 1;
}

// THE RUNNER NEVER EXITED, AND IT HAS BEEN LEAKING A PROCESS PER RUN SINCE
// 19 AUG 2026.
//
// `server.close()` above stops the listener, but the daemon behind it holds a
// long-lived PowerShell automation host whose open pipes keep this process's
// event loop alive forever. Nothing said so: the scoreboard printed, the shell
// prompt came back, and the runner sat there.
//
// Found 21 Aug 2026 by listing node processes while diagnosing a slow test
// suite: TWENTY-FIVE of them, one for every eval run over three days, each
// holding a daemon and a warm PowerShell host. The user had asked this very
// product why their machine felt slow, and it had answered OneDrive — which was
// true, and was not the whole truth, because the answer was partly us.
//
// Flush before exiting: on Windows stdout to a pipe is asynchronous, and calling
// process.exit() with output still buffered truncates the summary — which is the
// one thing anyone runs this for.
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => new Promise((resolve) => process.stdout.write("", resolve))
    .then(() => process.exit(process.exitCode ?? 0)));
