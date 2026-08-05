import { spawn } from "node:child_process";

const MAX_SUITE_MS = 10 * 60 * 1000;
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
