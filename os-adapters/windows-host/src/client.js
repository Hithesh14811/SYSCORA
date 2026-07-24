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
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta",
      "-ExecutionPolicy", "Bypass", "-File", hostScript
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8000); });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
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
      this.child = null;
    });
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
    this.child.stdin.end();
    this.child = null;
  }
}

let sharedHost = null;
export function getWindowsAutomationHost() {
  sharedHost ??= new WindowsAutomationHostClient();
  return sharedHost;
}
