// The eval runner.
//
// Starts a real daemon in-process, sends each task through the same route the
// chat surface uses, and then checks the MACHINE — never the agent's own account
// of what it did. Writes a JSON record per run and regenerates the scoreboard.
//
//   node tests/eval/runner.mjs [--only id] [--category files] [--repeat 3] [--mock]
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
  manual: argv.includes("--manual")
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
 * Run the same request again, this time with the route saved.
 *
 * `docs/skills.md` §12: the second run must pass the SAME independent check,
 * make zero model calls, and cost under a thousand tokens against the first
 * run's hundred-odd thousand. All four are checked here rather than eyeballed,
 * because "it felt faster" is exactly the claim this harness exists to replace.
 */
async function runSecondTime(task, first, { port, workspace }) {
  const second = { ...task, id: `${task.id}-replay` };
  if (!first.offeredSkill) {
    return {
      ...first, id: second.id, pass: false, tokensIn: 0, tokensOut: 0, steps: 0, elapsedMs: 0,
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
      ...first, id: second.id, pass: false, tokensIn: 0, tokensOut: 0, steps: 0, elapsedMs: 0,
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
  const expand = (text) => String(text ?? "").replaceAll("{workspace}", workspace);
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

  for (const step of task.setup ?? []) await powershell(expand(step.run));

  const startedAt = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/intents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-syscora-token": TOKEN },
      body: JSON.stringify({ text: expand(task.prompt), history: [], autoApprove: true })
    });
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
    } else {
      const metrics = session.finalResponse?.metrics ?? {};
      record.steps = metrics.steps ?? 0;
      record.toolCalls = metrics.toolCalls ?? 0;
      record.tokensIn = metrics.tokensIn ?? 0;
      record.tokensOut = metrics.tokensOut ?? 0;
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

// ---- Scoreboard ---------------------------------------------------------------

const median = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const costOf = (record) =>
  (record.tokensIn / 1e6) * COST_PER_MTOK_IN + (record.tokensOut / 1e6) * COST_PER_MTOK_OUT;

function scoreboard(records, meta) {
  const passed = records.filter((record) => record.pass);
  const rate = records.length ? Math.round((passed.length / records.length) * 100) : 0;
  const lines = [];
  lines.push("# SYSCORA scoreboard");
  lines.push("");
  lines.push(`Generated ${meta.at} · ${meta.model} · ${records.length} runs`);
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| **Pass rate** | **${rate}%** (${passed.length}/${records.length}) |`);
  lines.push(`| Median tokens | ${median(records.map((r) => r.tokensIn + r.tokensOut)).toLocaleString()} |`);
  lines.push(`| Median time | ${(median(records.map((r) => r.elapsedMs)) / 1000).toFixed(1)}s |`);
  lines.push(`| Median steps | ${median(records.map((r) => r.steps))} |`);
  lines.push(`| Median cost | $${median(records.map((r) => Math.round(costOf(r) * 1e6))) / 1e6} |`);
  lines.push(`| Total cost | $${records.reduce((sum, r) => sum + costOf(r), 0).toFixed(3)} |`);
  lines.push("");
  lines.push("## By task");
  lines.push("");
  lines.push("| task | category | pass | steps | tokens | time | why it failed |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const record of records) {
    lines.push([
      record.id,
      record.category,
      record.pass ? "✅" : "❌",
      record.steps,
      (record.tokensIn + record.tokensOut).toLocaleString(),
      `${(record.elapsedMs / 1000).toFixed(1)}s`,
      record.pass ? "" : (record.reason ?? "").slice(0, 80)
    ].join(" | ").replace(/^/, "| ").concat(" |"));
  }
  lines.push("");
  lines.push("## The most expensive runs");
  lines.push("");
  const dearest = [...records].sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut)).slice(0, 5);
  for (const record of dearest) {
    lines.push(
      `- **${record.id}** — ${(record.tokensIn + record.tokensOut).toLocaleString()} tokens over ` +
      `${record.steps} steps. ${record.pass ? "Passed, which is why nobody noticed." : "Failed."}` +
      (record.tools.length ? `\n  \`${record.tools.join(" → ")}\`` : "")
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---- Go -----------------------------------------------------------------------

async function main() {
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
      const tokens = (record.tokensIn + record.tokensOut).toLocaleString();
      console.log(
        `${record.pass ? "PASS" : "FAIL"}  ${record.steps} steps · ${tokens} tokens · ` +
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
  const resultsDir = path.join(here, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(
    path.join(resultsDir, `${at.replace(/[:.]/g, "-")}.json`),
    JSON.stringify({ at, model, records }, null, 2)
  );
  const board = scoreboard(records, { at, model });
  await fs.writeFile(path.join(here, "scoreboard.md"), board);

  console.log(`\n${board.split("## By task")[0].trim()}`);
  console.log(`\nFull scoreboard: tests/eval/scoreboard.md`);
  // A non-zero exit when anything failed, so this can gate a commit later.
  process.exitCode = records.every((record) => record.pass) ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
