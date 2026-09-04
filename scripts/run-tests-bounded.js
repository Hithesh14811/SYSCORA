import { spawn } from "node:child_process";

// THE CEILING CATCHES A HANG. IT IS NOT A PERFORMANCE BUDGET.
//
// It exists because a suite that never returns cannot gate anything — the same
// defect as `npm run eval` sitting at 0% CPU for ninety minutes behind an undead
// PowerShell host (W1, docs/state-of-the-world.md). Ten minutes was set when the
// whole suite took about nine, and that margin quietly disappeared as the suite
// grew.
//
// 4 Sep 2026: 1,693 tests, all passing, measured at **630.9 seconds** — thirty
// seconds OVER the bound. So `npm test` reported failure on a suite with zero
// failing tests, which is the worst kind of red: the one people learn to ignore.
// The tests run at `--test-concurrency=1` on purpose (they share one machine,
// one mouse and one automation host), so this number only goes up.
//
// Raised to twenty minutes, which is still comfortably below "this has hung" and
// leaves room for the suite to keep growing without anyone having to think about
// it again. If it ever approaches this, the answer is to look at what got slow,
// not to raise it a third time.
const MAX_SUITE_MS = 20 * 60 * 1000;
const PER_TEST_MS = 240 * 1000;
const requested = Number(process.env.SYSCORA_TEST_CEILING_MS);
const ceilingMs = Number.isFinite(requested) && requested > 0
  ? Math.min(requested, MAX_SUITE_MS)
  : MAX_SUITE_MS;

const child = spawn(process.execPath, [
  "--test",
  `--test-timeout=${PER_TEST_MS}`,
  "--test-concurrency=1",
  "--test-force-exit",
  "tests/**/*.test.js"
], {
  stdio: "inherit",
  windowsHide: true,
  detached: process.platform !== "win32"
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`\nSYSCORA test ceiling exceeded after ${ceilingMs}ms.`);
  console.error("The runner is terminating the test process tree; inspect the last reported test and open resources.");
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "inherit",
      windowsHide: true
    });
    killer.once("error", () => child.kill("SIGKILL"));
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}, ceilingMs);
timer.unref();

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`Unable to start the bounded test runner: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    process.exitCode = 124;
    return;
  }
  if (signal) console.error(`Test runner exited from signal ${signal}.`);
  process.exitCode = code ?? 1;
});
