// Live human-facing GUI probe.
//
// Drives real applications through the real runtime and then judges the result
// the way a person sitting at the machine would: by looking at what is actually
// on screen. It deliberately IGNORES what the runtime says happened. A session
// that reports COMPLETED while the window never opened is a FAIL here, because
// that is the failure mode that matters and the one internal status codes hide.
//
// Every check is an independent observation through the adapter — window
// enumeration, UI Automation reads, screenshots — taken after the agent claims
// to be finished.
//
//   node scripts/live-gui-probe.js
//   node scripts/live-gui-probe.js --only notepad-type
//   node scripts/live-gui-probe.js --keep     (skip cleanup, leave windows open)
//
// SAFETY: this opens real windows on the real desktop. It only ever closes
// processes it started itself — process ids present before the run are recorded
// and never touched, so a Notepad you already had open with unsaved work is
// left alone.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const MARKER = "SYSCORA live GUI probe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function windowsOf(adapter, processName) {
  const all = await adapter.listWindows().catch(() => []);
  return all.filter((w) =>
    String(w.ProcessName ?? w.processName ?? "").toLowerCase() === processName.toLowerCase() &&
    String(w.MainWindowTitle ?? w.title ?? "").trim() &&
    (w.Bounds?.width ?? 0) > 50 && (w.Bounds?.height ?? 0) > 50)
    // Modern apps may publish tooltip/pop-up HWNDs under the same process.
    // The main human-visible surface is the largest candidate, not whichever
    // handle happened to be enumerated first.
    .sort((left, right) =>
      ((right.Bounds?.width ?? 0) * (right.Bounds?.height ?? 0)) -
      ((left.Bounds?.width ?? 0) * (left.Bounds?.height ?? 0))
    );
}

async function largestDisplayWidth(adapter) {
  const all = await adapter.listWindows().catch(() => []);
  // A window's x-offset is its position in the virtual multi-monitor desktop,
  // not part of that monitor's width. Adding x produced fictitious 2893px
  // displays and could fail a correctly maximized window on the right monitor.
  return Math.max(1920, ...all.map((w) => w.Bounds?.width ?? 0));
}

// Read the text a person would see inside the window, through UI Automation.
async function visibleTextOf(adapter, application, windowId) {
  try {
    const ui = await adapter.inspectUi({ application, windowId: String(windowId), maxElements: 120 });
    const elements = ui?.elements ?? ui?.targets ?? [];
    return elements
      .map((e) => [e.name, e.value, e.text, e.helpText].filter(Boolean).join(" "))
      .join(" \n");
  } catch (error) {
    return `__INSPECT_FAILED__ ${error.message}`;
  }
}

const TASKS = [
  {
    id: "notepad-launch",
    app: "notepad",
    request: "open notepad",
    // A person's standard: is there a Notepad window on screen now?
    verify: async (adapter) => {
      const windows = await windowsOf(adapter, "notepad");
      return windows.length > 0
        ? { pass: true, detail: `notepad window ${windows[0].WindowHandle} at ${windows[0].Bounds.width}x${windows[0].Bounds.height}` }
        : { pass: false, detail: "no visible notepad window" };
    }
  },
  {
    id: "notepad-type",
    app: "notepad",
    request: `open notepad and type exactly: ${MARKER}`,
    // Not "was a type action invoked" — is the text actually in the document?
    verify: async (adapter) => {
      const windows = await windowsOf(adapter, "notepad");
      if (!windows.length) return { pass: false, detail: "no visible notepad window" };
      const text = await visibleTextOf(adapter, "notepad", windows[0].WindowHandle);
      return text.includes(MARKER)
        ? { pass: true, detail: `document contains the typed text` }
        : { pass: false, detail: `typed text absent. visible text: ${text.slice(0, 160).replace(/\s+/g, " ")}` };
    }
  },
  {
    id: "notepad-maximize",
    app: "notepad",
    request: "open notepad and maximize the window",
    // The capability that was registered but unreachable until now.
    verify: async (adapter) => {
      const windows = await windowsOf(adapter, "notepad");
      if (!windows.length) return { pass: false, detail: "no visible notepad window" };
      const screenWidth = await largestDisplayWidth(adapter);
      const w = windows[0];
      const covers = (w.Bounds.width / screenWidth);
      return covers > 0.8
        ? { pass: true, detail: `window ${w.Bounds.width}px wide covers ${(covers * 100).toFixed(0)}% of the ${screenWidth}px display` }
        : { pass: false, detail: `window only ${w.Bounds.width}px of ${screenWidth}px (${(covers * 100).toFixed(0)}%) — not maximized` };
    }
  },
  {
    id: "calc-launch",
    app: "CalculatorApp",
    request: "open the calculator app",
    verify: async (adapter) => {
      for (const name of ["CalculatorApp", "Calculator", "ApplicationFrameHost"]) {
        const windows = await windowsOf(adapter, name);
        const calc = windows.find((w) => /calc/i.test(String(w.MainWindowTitle ?? "")) || /calc/i.test(name));
        if (calc) return { pass: true, detail: `${name} window "${calc.MainWindowTitle}"` };
      }
      return { pass: false, detail: "no visible calculator window" };
    }
  }
];

function parseArgs(argv) {
  return {
    only: argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null,
    keep: argv.includes("--keep"),
    timeoutMs: argv.includes("--timeout") ? Number(argv[argv.indexOf("--timeout") + 1]) : 180000
  };
}

// Close only what this run started. Process ids observed before the run are
// recorded and never touched.
async function closeOurs(adapter, preexistingPids, appNames) {
  for (const app of appNames) {
    const windows = await windowsOf(adapter, app);
    for (const w of windows) {
      const pid = w.Id ?? w.processId;
      if (!pid || preexistingPids.has(pid)) continue;
      await new Promise((resolve) => {
        const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: false });
        child.on("close", resolve);
        child.on("error", resolve);
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const tasks = args.only ? TASKS.filter((t) => t.id === args.only) : TASKS;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-gui-"));
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
  await fs.mkdir(path.join(tempRoot, ".syscora"), { recursive: true });
  await fs.copyFile(path.join(repoRoot, ".syscora", "config.json"), path.join(tempRoot, ".syscora", "config.json"));

  const runtime = createRuntime(tempRoot);
  const adapter = new WindowsAdapter();
  const providerCaps = JSON.stringify(runtime.reasoningEngine?.modelProvider?.capabilities?.() ?? {});
  if (/"providers":\[\{"name":"mock"/.test(providerCaps)) {
    console.error("ABORT: mock provider — this probe would measure nothing.");
    process.exit(1);
  }
  console.log("model provider: REAL\n");

  // Anything already running belongs to the user, not to this test.
  const preexisting = await adapter.listWindows().catch(() => []);
  const preexistingPids = new Set(preexisting.map((w) => w.Id ?? w.processId).filter(Boolean));
  const appNames = [...new Set(TASKS.map((t) => t.app))];

  const results = [];
  for (const task of tasks) {
    const startedAt = Date.now();
    let claimed = "THREW";
    let error = null;
    try {
      const session = await Promise.race([
        // GUI actions are policy-gated; an unattended probe has to grant them.
        runtime.submitIntent(task.request, { autoApprove: true, workspacePath: tempRoot }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${args.timeoutMs}ms`)), args.timeoutMs))
      ]);
      claimed = session?.finalResponse?.status ?? session?.currentState ?? "UNKNOWN";
    } catch (e) {
      error = e.message;
    }

    // Let the UI settle before looking, the way a person would.
    await sleep(1200);
    const observed = await task.verify(adapter).catch((e) => ({ pass: false, detail: `verification threw: ${e.message}` }));
    const elapsedMs = Date.now() - startedAt;

    // Screenshot as evidence, whether it passed or not.
    let shot = null;
    try {
      shot = path.join(tempRoot, `${task.id}.png`);
      await adapter.captureScreen({ path: shot });
    } catch { shot = null; }

    // The headline verdict is the independent observation, never the claim.
    const verdict = observed.pass ? "PASS" : "FAIL";
    const honest = observed.pass === (["COMPLETED", "ANSWERED"].includes(claimed));
    results.push({ id: task.id, verdict, claimed, observed: observed.detail, elapsedMs, honest, error, shot });

    console.log(
      `${verdict}  ${task.id.padEnd(18)} ${String(elapsedMs).padStart(6)}ms  claimed=${String(claimed).padEnd(12)}` +
      `${honest ? "" : "  <-- CLAIM DISAGREES WITH SCREEN"}`
    );
    console.log(`      ${observed.detail}${error ? `  [${error}]` : ""}\n`);

    if (!args.keep) {
      await closeOurs(adapter, preexistingPids, appNames);
      await sleep(600);
    }
  }

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const dishonest = results.filter((r) => !r.honest).length;
  console.log(`SUMMARY ${passed}/${results.length} visibly succeeded` +
    (dishonest ? `; ${dishonest} session(s) reported a status the screen contradicts` : "; every claim matched the screen"));
  console.log(`screenshots: ${tempRoot}`);
  process.exit(0);
}

main();
