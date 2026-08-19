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
  return tasks.filter((task) => {
    if (options.only && task.id !== options.only) return false;
    if (options.category && task.category !== options.category) return false;
    if (task.manual && !options.manual && !options.only) return false;
    return true;
  });
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

const median = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const costOf = (record) =>
  (record.tokensIn / 1e6) * COST_PER_MTOK_IN + (record.tokensOut / 1e6) * COST_PER_MTOK_OUT;

const spread = (numbers, format = (value) => value.toLocaleString()) => {
  if (numbers.length <= 1) return "";
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return low === high ? "" : `${format(low)}–${format(high)}`;
};

// One row per task, whatever the repeat count. Runs stay in the JSON record for
// anyone who wants to look at an individual one.
function summarise(records) {
  const byTask = new Map();
  for (const record of records) {
    if (!byTask.has(record.id)) byTask.set(record.id, []);
    byTask.get(record.id).push(record);
  }
  return [...byTask.entries()].map(([id, runs]) => {
    const fresh = runs.map((run) => run.tokensFresh);
    const times = runs.map((run) => run.elapsedMs);
    const steps = runs.map((run) => run.steps);
    const passes = runs.filter((run) => run.pass).length;
    return {
      id,
      category: runs[0].category,
      runs: runs.length,
      passes,
      // A task that passes twice out of three is not a passing task. Anything
      // less than every run is a flake, and a flake is a defect that has not
      // been diagnosed yet — grading it as a pass is how it stays undiagnosed.
      pass: passes === runs.length,
      medianFresh: median(fresh),
      medianElapsedMs: median(times),
      medianSteps: median(steps),
      medianTokensSent: median(runs.map((run) => run.tokensIn + run.tokensOut)),
      minFresh: Math.min(...fresh),
      maxFresh: Math.max(...fresh),
      minElapsedMs: Math.min(...times),
      maxElapsedMs: Math.max(...times),
      maxSteps: Math.max(...steps),
      freshSpread: spread(fresh),
      timeSpread: spread(times, (value) => `${(value / 1000).toFixed(1)}s`),
      stepSpread: spread(steps),
      cost: runs.reduce((sum, run) => sum + costOf(run), 0) / runs.length,
      tools: runs.find((run) => run.tools.length)?.tools ?? [],
      reason: runs.find((run) => !run.pass)?.reason ?? null
    };
  });
}

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

function budgetsFrom(summaries, meta) {
  return {
    recordedAt: meta.at,
    model: meta.model,
    repeat: meta.repeat,
    slack: meta.slack,
    note:
      "Recorded from a measured baseline with --write-budgets, not chosen by hand. " +
      "Each ceiling is that task's baseline MEDIAN times the slack above. A later run " +
      "breaches a budget when ITS median exceeds the ceiling — one unlucky run cannot " +
      "fail the gate, and a task that got quietly twice as expensive cannot pass it.",
    tasks: Object.fromEntries(summaries.map((summary) => [summary.id, {
      // A CEILING BELOW THE BASELINE'S OWN WORST RUN IS NOT A GATE, IT IS AN
      // ALARM CLOCK.
      //
      // First version was median × slack. On the first change it was used to
      // judge, it reported six breaches, and every one of them was the task's
      // own variance: `chat-arithmetic` — one model call, twenty tokens, no
      // machine — ranged 1.5s to 21.5s across three consecutive runs of
      // identical code, and `app-type-into-notepad-and-save` ranged 32s to 157s.
      // A ceiling at 1.4× the median sits inside that, so the baseline itself
      // would have breached, and a gate that cries wolf gets switched off.
      //
      // So the ceiling is whichever is larger: the median times the slack, or a
      // little above the worst run actually observed. On a task whose spread is
      // already 3× that means a 1.4× regression is NOT detectable at n=3 — which
      // is true, and better said out loud than hidden behind a red row. The
      // observed spread is recorded below so a reader can see which rows are
      // sharp instruments and which are not.
      //
      // Floors on top, because a task that costs almost nothing has a median
      // near zero and multiplying that gives a ceiling nothing can stay under.
      freshTokens: Math.max(2000, Math.round(summary.medianFresh * meta.slack), Math.round(summary.maxFresh * 1.1)),
      elapsedMs: Math.max(3000, Math.round(summary.medianElapsedMs * meta.slack), Math.round(summary.maxElapsedMs * 1.1)),
      steps: Math.max(2, Math.ceil(summary.medianSteps * meta.slack), Math.ceil(summary.maxSteps * 1.1)),
      baseline: {
        pass: summary.pass,
        passes: `${summary.passes}/${summary.runs}`,
        medianFresh: summary.medianFresh,
        medianElapsedMs: summary.medianElapsedMs,
        medianSteps: summary.medianSteps,
        // How wide this row is. A task whose worst run is three times its median
        // cannot detect a small regression, and knowing that is the difference
        // between reading the scoreboard and believing it.
        spread: `${summary.minFresh}–${summary.maxFresh} fresh · ` +
          `${(summary.minElapsedMs / 1000).toFixed(1)}–${(summary.maxElapsedMs / 1000).toFixed(1)}s`
      }
    }]))
  };
}

function checkBudgets(summaries, budgets) {
  if (!budgets) return [];
  const breaches = [];
  for (const summary of summaries) {
    const budget = budgets.tasks?.[summary.id];
    if (!budget) continue;
    // A TASK THAT USED TO PASS AND NOW DOES NOT IS THE WORST REGRESSION THERE IS,
    // and it is not a token budget — so it is checked here rather than left to
    // the pass column, where a task that was already failing at baseline would
    // have made the whole gate red forever and got the gate switched off.
    if (budget.baseline?.pass && !summary.pass) {
      breaches.push(`${summary.id}: passed ${budget.baseline.passes} at baseline, now ${summary.passes}/${summary.runs}` +
        (summary.reason ? ` — ${summary.reason}` : ""));
    }
    if (summary.medianFresh > budget.freshTokens) {
      breaches.push(`${summary.id}: ${summary.medianFresh.toLocaleString()} fresh tokens against a ceiling of ` +
        `${budget.freshTokens.toLocaleString()} (baseline median ${budget.baseline?.medianFresh?.toLocaleString() ?? "?"})`);
    }
    if (summary.medianElapsedMs > budget.elapsedMs) {
      breaches.push(`${summary.id}: ${(summary.medianElapsedMs / 1000).toFixed(1)}s against a ceiling of ` +
        `${(budget.elapsedMs / 1000).toFixed(1)}s (baseline median ${((budget.baseline?.medianElapsedMs ?? 0) / 1000).toFixed(1)}s)`);
    }
    if (summary.medianSteps > budget.steps) {
      breaches.push(`${summary.id}: ${summary.medianSteps} steps against a ceiling of ${budget.steps} ` +
        `(baseline median ${budget.baseline?.medianSteps ?? "?"})`);
    }
  }
  return breaches;
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
  lines.push(`Generated ${meta.at} · ${meta.model} · ${summaries.length} tasks × ${meta.repeat} = ${records.length} runs`);
  lines.push("");
  lines.push(`Code under test: \`${meta.commit}\``);
  if (meta.label) lines.push(`\n**${meta.label}**`);
  lines.push("");
  lines.push("Costs are quoted as **fresh** input tokens — what is billed at full rate. The");
  lines.push("endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a");
  lines.push("tenth of the price, so `tokensIn` is bandwidth, not money.");
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| **Pass rate** | **${rate}%** (${passed.length}/${summaries.length} tasks passing every run) |`);
  lines.push(`| Median fresh tokens | ${median(summaries.map((s) => s.medianFresh)).toLocaleString()} |`);
  lines.push(`| Median time | ${(median(summaries.map((s) => s.medianElapsedMs)) / 1000).toFixed(1)}s |`);
  lines.push(`| Median steps | ${median(summaries.map((s) => s.medianSteps))} |`);
  lines.push(`| Total cost of this run | $${records.reduce((sum, r) => sum + costOf(r), 0).toFixed(3)} |`);
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
      commit: `${saved.commit ?? "unknown"} (re-aggregated from ${path.basename(options.from)})`,
      label: null
    }, { write: false });
    return;
  }

  const tasks = await loadTasks();
  if (tasks.length === 0) {
    console.log("No tasks matched.");
    return;
  }

  const workspace = path.join(repoRoot, ".syscora", "eval-workspace");
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });

  process.env.SYSCORA_API_TOKEN = TOKEN;
  if (options.mock) process.env.SYSCORA_MODEL_PROVIDER = "mock";

  const server = startServer({ port: 0, basePath: repoRoot, warmHost: !options.mock });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  const model = options.mock ? "mock" : (process.env.SYSCORA_MODEL_NAME ?? "configured provider");

  console.log(`Running ${tasks.length} task(s) × ${options.repeat} against ${model}\n`);
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

  await new Promise((resolve) => server.close(resolve));

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
    repeat: options.repeat,
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
  const summaries = summarise(records);
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

  const board = scoreboard(records, summaries, meta);
  if (write) {
    const resultsDir = path.join(here, "results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(
      path.join(resultsDir, `${meta.at.replace(/[:.]/g, "-")}.json`),
      JSON.stringify({ at: meta.at, model: meta.model, commit: meta.commit, repeat: meta.repeat, summaries, records }, null, 2)
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
