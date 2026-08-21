import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import crypto from "node:crypto";

const hostScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "restore-host.ps1");

export class WindowsAutomationHostClient {
  constructor({ requestTimeoutMs = 15000 } = {}) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.stderr = "";
    this.reader = null;
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta",
      "-ExecutionPolicy", "Bypass", "-File", hostScript
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8000); });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Windows automation host failed"));
    });
    this.child.on("exit", (code) => {
      const error = new Error(`Windows automation host exited (${code}): ${this.stderr}`.trim());
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.reader?.close();
      this.reader = null;
      this.child = null;
    });
  }

  /**
   * Bring the host up and prove it is answering, before anything needs it.
   *
   * The host is a PowerShell process that loads UI Automation, Windows Forms and
   * the OCR engine on first use, and that startup costs several seconds. Started
   * lazily, the bill always lands on the first real action of a session: the
   * first window enumeration took 1.3s against 0.3s warm, and the first screen
   * reading 11s against 1.2s — long enough that launching an application could
   * exceed its own 24-second timeout and be recorded as a failure, on a machine
   * where nothing was wrong.
   *
   * Warming is best-effort and never throws: a host that cannot start is a
   * degraded desktop surface, not a reason to refuse to start the daemon.
   */
  async warm() {
    try {
      this.start();
      await this.request("host.health", {}, { timeoutMs: 20000 });
      return true;
    } catch {
      return false;
    }
  }

  request(operation, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    this.start();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows automation host request timed out: ${operation}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, operation, params })}\n`, "utf8");
    });
  }

  close() {
    if (!this.child) return;
    const child = this.child;
    const error = Object.assign(new Error("Windows automation host closed"), { code: "CANCELLED" });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.reader?.close();
    this.reader = null;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already exited */ }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref?.();
    this.child = null;
  }
}

let sharedHost = null;
export function getWindowsAutomationHost() {
  sharedHost ??= new WindowsAutomationHostClient();
  return sharedHost;
}

/**
 * Shut the shared host down. THE MACHINERY ABOVE WAS ALWAYS CORRECT AND NOTHING
 * ON A REAL PATH CALLED IT.
 *
 * `close()` kills the child, destroys the pipes and unrefs — exactly right. But
 * measured 21 Aug 2026, the only callers were five probe scripts. Not the
 * daemon, not the eval runner. So every eval and every unattended run left a
 * `powershell.exe` behind: 15 of them on this machine, 801 MB resident, the
 * oldest 170.9 hours old — on the machine whose owner had asked why it felt slow.
 *
 * The second consequence is worse than the memory. An undead child with a live
 * stdio pipe holds a reference in Node's event loop, so `tests/eval/runner.mjs`
 * — which sets `process.exitCode` rather than calling `process.exit()` — printed
 * its entire scoreboard and then HUNG FOREVER. `npm run eval` never returns,
 * which means it can never gate CI, which was the whole point of building it.
 *
 * Idempotent, and safe to call when no host was ever started.
 */
export function closeWindowsAutomationHost() {
  if (!sharedHost) return false;
  sharedHost.close();
  sharedHost = null;
  return true;
}
