#!/usr/bin/env node
// Does stopping the daemon actually stop its PowerShell host?
//
// `closeWindowsAutomationHost()` was correct and unreachable: only the eval
// runner called it, so every daemon that died took no host with it. 15 orphans,
// 801 MB, oldest seven days, on the machine whose owner had asked why it felt
// slow. The wiring is now in the daemon's signal handlers — and wiring that is
// only checked by reading the code is how it got here in the first place.
//
// So this starts a REAL daemon, makes it do REAL automation work so a host
// exists, signals it the way the Electron shell does, and then reads the
// process table back. The process table is a different capability from the one
// that spawned the host, which is the point.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const PORT = 4399;

function powershellHosts() {
  const out = execFileSync("powershell", [
    "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" "
    + "| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
  ], { encoding: "utf8", timeout: 30_000 });
  const rows = JSON.parse(out || "[]");
  const list = Array.isArray(rows) ? rows : [rows];
  return list.filter((p) => /restore-host/i.test(String(p?.CommandLine ?? "")));
}

const before = powershellHosts().map((p) => p.ProcessId);
console.log(`automation hosts before: ${before.length} ${before.join(", ")}`);

console.log(`\nstarting a daemon on ${PORT} ...`);
const daemon = spawn(process.execPath, [path.join(repoRoot, "apps/daemon/src/server.js")], {
  cwd: repoRoot,
  env: { ...process.env, SYSCORA_PORT: String(PORT), SYSCORA_API_TOKEN: "probe-token" },
  stdio: ["pipe", "pipe", "pipe"]
});
let daemonSaid = "";
daemon.stdout.on("data", (b) => { daemonSaid += b.toString(); });
daemon.stderr.on("data", (b) => { daemonSaid += b.toString(); });

await sleep(6_000);

// Make it do something that needs the host, so one actually exists to leak.
console.log("asking it to read the window list, which starts the host ...");
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/intents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer probe-token" },
    body: JSON.stringify({ text: "list my open windows", autoApprove: true })
  });
  console.log(`  daemon answered HTTP ${res.status}`);
} catch (error) {
  console.log(`  request failed (${error.message}) — continuing; the host may still have started`);
}
await sleep(8_000);

const during = powershellHosts().map((p) => p.ProcessId);
const spawned = during.filter((p) => !before.includes(p));
console.log(`automation hosts while running: ${during.length} (new: ${spawned.join(", ") || "none"})`);

if (spawned.length === 0) {
  console.log("\nINCONCLUSIVE: no host started, so there was nothing to leak and nothing to prove.");
  daemon.kill("SIGTERM");
  process.exit(2);
}

console.log("\nclosing stdin, exactly as the Electron shell now does ...");
daemon.stdin.end();
const exitCode = await new Promise((resolve) => {
  daemon.once("exit", (code) => resolve(code));
  setTimeout(() => resolve("did not exit"), 10_000);
});
console.log(`  daemon exit: ${exitCode}`);
console.log(`  daemon said: ${daemonSaid.split("\n").filter((l) => /shutting down/i.test(l)).join(" | ") || "(nothing about shutdown)"}`);

await sleep(3_000);
const after = powershellHosts().map((p) => p.ProcessId);
const survivors = spawned.filter((p) => after.includes(p));
console.log(`\nautomation hosts after: ${after.length}`);
// A HOST CAN DISAPPEAR WITHOUT THE FIX HAVING RUN, and the first version of
// this probe reported CONFIRMED when exactly that happened: killed with
// SIGTERM, the daemon died instantly, its stdio pipes closed, and PowerShell
// exited on EOF all by itself. No orphan, no shutdown handler, nothing proved.
// So the outcome AND the mechanism both have to hold.
const ranCleanly = /shutting down/i.test(daemonSaid);
console.log(survivors.length === 0
  ? `hosts: all ${spawned.length} the daemon started are gone from the process table.`
  : `hosts: LEAKED ${survivors.join(", ")} outlived the daemon.`);
console.log(ranCleanly
  ? "mechanism: the daemon's own shutdown path ran and said so."
  : "mechanism: NOT PROVEN - the daemon never reported shutting down, so anything "
    + "that cleaned up did so by accident, not by this wiring.");
const ok = survivors.length === 0 && ranCleanly;
console.log(ok ? "\nCONFIRMED" : "\nNOT CONFIRMED");
process.exit(ok ? 0 : 1);
