// Live generalization probe.
//
// The question this answers is NOT "does Notepad work". It is: given a goal in
// an application nobody tuned the agent for, can SYSCORA perceive the screen,
// decide what to do next, act, and know when it is finished — and is the answer
// it gives actually TRUE?
//
// Every task here is scored against ground truth computed independently, by a
// route the agent did not use (PowerShell, the filesystem, arithmetic). A task
// passes only when the agent's answer matches reality. How it got there —
// internal API, UI Automation, pointer, vision — is recorded but never scored,
// because a person does not care which limb was used.
//
// Deliberately NOT tuned: no strategy compiler, capability, or prompt in this
// repository mentions Task Manager, Settings, or File Explorer. That is the
// point. If these only pass after per-app work, the capability is not general.
//
//   node scripts/live-generalization-probe.js
//   node scripts/live-generalization-probe.js --only calc-arithmetic

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function powershell(script) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

const TASKS = [
  {
    id: "calc-reported",
    request: "open calculator and do 99 x 1124",
    truth: async () => "111276",
    matches: (answer, truth) => answer.replace(/[,\s]/g, "").includes(truth)
  },
  {
    id: "calc-arithmetic",
    // Requires real interaction: locate controls, click a sequence, read the
    // display, decide it is finished. Arithmetic makes the answer unambiguous.
    request: "open the calculator, work out 17 multiplied by 23, and tell me the result",
    truth: async () => "391",
    matches: (answer, truth) => answer.replace(/[,\s]/g, "").includes(truth)
  },
  {
    id: "top-memory-process",
    // An unfamiliar surface (Task Manager) or an internal route — either is fine
    // as long as the name is right.
    request: "which process is using the most memory on this computer right now",
    truth: async () => powershell("(Get-Process | Sort-Object -Property WS -Descending | Select-Object -First 1).ProcessName"),
    matches: (answer, truth) => truth && answer.toLowerCase().includes(truth.toLowerCase())
  },
  {
    id: "windows-version",
    request: "what version of Windows is this computer running",
    // "25H2" and "build 26200" are the same fact in different vocabulary, and a
    // person asking this question is answered correctly by either. An earlier
    // version of this check demanded the marketing string and scored a correct
    // answer as wrong — the test was wrong, not the agent. Accept either.
    truth: async () => {
      const display = await powershell("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion");
      const build = await powershell("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuildNumber");
      return [display, build].filter(Boolean).join(" or build ");
    },
    matches: (answer, truth) => truth.split(" or build ").some((form) =>
      form && answer.toUpperCase().includes(form.toUpperCase()))
  },
  {
    id: "downloads-count",
    request: "how many files are in my Downloads folder",
    truth: async () => powershell("(Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('UserProfile') + '\\Downloads') -File -ErrorAction SilentlyContinue | Measure-Object).Count"),
    matches: (answer, truth) => truth && new RegExp(`\\b${truth}\\b`).test(answer.replace(/,/g, ""))
  },
  {
    id: "screen-reading",
    // Pure perception: no prior knowledge of what is on screen is possible.
    request: "open notepad, type the word PERCEPTION, then read the window back to me and tell me exactly what text it contains",
    truth: async () => "PERCEPTION",
    matches: (answer, truth) => answer.toUpperCase().includes(truth)
  }
];

// Which limbs the session actually used, for information only.
function routeOf(session) {
  const caps = new Set();
  for (const e of session?.events ?? []) {
    const c = e.details?.capability ?? e.details?.action?.capability;
    if (c) caps.add(String(c).split(".")[0]);
  }
  return [...caps].join("+") || "none";
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-gen-"));
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
  await fs.mkdir(path.join(tempRoot, ".syscora"), { recursive: true });
  await fs.copyFile(path.join(repoRoot, ".syscora", "config.json"), path.join(tempRoot, ".syscora", "config.json"));

  const runtime = createRuntime(tempRoot);
  const adapter = new WindowsAdapter();
  if (/"providers":\[\{"name":"mock"/.test(JSON.stringify(runtime.reasoningEngine?.modelProvider?.capabilities?.() ?? {}))) {
    console.error("ABORT: mock provider.");
    process.exit(1);
  }
  console.log("model provider: REAL\n");

  const preexisting = new Set((await adapter.listWindows().catch(() => []))
    .map((w) => w.Id ?? w.processId).filter(Boolean));

  const results = [];
  for (const task of tasks) {
    const truth = await task.truth();
    const startedAt = Date.now();
    let answer = "";
    let claimed = "THREW";
    let route = "none";
    try {
      const session = await Promise.race([
        runtime.submitIntent(task.request, { autoApprove: true, workspacePath: tempRoot }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 180000))
      ]);
      answer = String(session?.finalResponse?.message ?? "");
      // Read-oriented goals put the payload in the outcome rather than the headline.
      const outcome = session?.finalResponse?.outcome;
      if (outcome) answer += " " + JSON.stringify(outcome);
      const summary = session?.finalResponse?.result?.summary;
      if (summary) answer += " " + summary;
      claimed = session?.finalResponse?.status ?? "UNKNOWN";
      route = routeOf(session);
    } catch (e) {
      answer = `__ERROR__ ${e.message}`;
    }
    const elapsedMs = Date.now() - startedAt;
    // A failure message often repeats the expected value ("did not show
    // 111276"). Matching that text is not success. The observed answer and the
    // runtime's own terminal claim must agree.
    const correct = ["COMPLETED", "COMPLETED_WITH_WARNINGS", "VERIFIED", "ANSWERED"].includes(claimed)
      && Boolean(truth) && task.matches(answer, String(truth));

    results.push({ id: task.id, correct, truth, claimed, route, elapsedMs });
    console.log(
      `${correct ? "TRUE " : "WRONG"}  ${task.id.padEnd(20)} ${String(elapsedMs).padStart(6)}ms  ` +
      `via=${route.padEnd(24)} claimed=${claimed}`
    );
    console.log(`      expected: ${String(truth).slice(0, 70)}`);
    console.log(`      answered: ${answer.replace(/\s+/g, " ").slice(0, 190)}\n`);

    // Close only what this run started.
    for (const w of await adapter.listWindows().catch(() => [])) {
      const pid = w.Id ?? w.processId;
      if (!pid || preexisting.has(pid)) continue;
      if (!/notepad|calc|taskmgr|explorer|systemsettings|applicationframehost/i.test(String(w.ProcessName ?? ""))) continue;
      await new Promise((res) => {
        const c = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: false });
        c.on("close", res); c.on("error", res);
      });
    }
    await sleep(800);
  }

  const right = results.filter((r) => r.correct).length;
  console.log(`SUMMARY ${right}/${results.length} answers were actually true`);
  await fs.rm(tempRoot, { recursive: true, force: true });
  process.exit(0);
}

main();
