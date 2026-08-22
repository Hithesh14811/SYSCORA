// Why does the controlled browser refuse to start?
//
// Live, every `web_open` came back "Browser navigation failed: CDP connection
// failed", and the agent fell back to scraping search engines through CAPTCHAs —
// 46 steps and 803,000 tokens for a question worth about six. The error message
// says which line threw, and nothing about why.
//
// This walks the same path the adapter walks, printing what it finds at each
// stage, so the failure is a fact rather than a guess.
//
//   node scripts/probe-cdp-browser.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const say = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

// ---- 1. Is there a browser to drive? -----------------------------------------

const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
const relative = [
  ["Microsoft", "Edge", "Application", "msedge.exe"],
  ["Google", "Chrome", "Application", "chrome.exe"]
];
const candidates = roots.flatMap((root) => relative.map((parts) => path.join(root, ...parts)));

console.log("Looking for a browser the adapter knows about:");
let executable = null;
for (const candidate of candidates) {
  const found = fs.existsSync(candidate);
  console.log(`  ${found ? "FOUND  " : "  --   "} ${candidate}`);
  if (found && !executable) executable = candidate;
}
if (!executable) {
  console.log("\nNo browser found in any candidate path. That alone would break web_open.");
  process.exit(1);
}
console.log("");
say("using", executable);

// ---- 2. Does it start and announce a debug endpoint? -------------------------

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "syscora-cdp-probe-"));
const args = [
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  "--remote-allow-origins=*",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  ...(process.env.PROBE_HEADED === "1" ? [] : ["--headless=new", "--disable-gpu"]),
  "about:blank"
];

const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: process.env.PROBE_HEADED !== "1" });
let stderr = "";
let endpoint = "";

const endpointPromise = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 15000);
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match && !endpoint) {
      endpoint = match[1];
      clearTimeout(timer);
      resolve(endpoint);
    }
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(null);
    say("browser exited early", `code ${code}`);
  });
});

const found = await endpointPromise;
say("debug endpoint", found ?? "NONE — the browser never announced one");
if (stderr.trim()) console.log(`\nbrowser stderr:\n${stderr.trim().slice(0, 1200)}\n`);
if (!found) {
  child.kill();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(1);
}

// ---- 3. Can the HTTP side be reached? ----------------------------------------

const httpBase = found.replace(/^ws:\/\//, "http://").replace(/\/devtools\/browser\/.*$/, "");
try {
  const version = await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(3000) });
  const body = await version.json();
  say("GET /json/version", `${version.status} — ${body.Browser ?? "?"}`);
  say("webSocketDebuggerUrl", body.webSocketDebuggerUrl ?? "(absent)");
} catch (error) {
  say("GET /json/version", `FAILED — ${error?.message ?? error}`);
}

// ---- 4. The actual question: does the WebSocket open? ------------------------
//
// This is the line that has been throwing. The adapter's `error` listener
// discards the event, so the real reason has never been visible.

const tryOpen = (url, label) => new Promise((resolve) => {
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    resolve(`threw on construction — ${error?.message ?? error}`);
    return;
  }
  const timer = setTimeout(() => { try { socket.close(); } catch {} resolve("timed out after 8s"); }, 8000);
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    socket.close();
    resolve("OPEN");
  }, { once: true });
  socket.addEventListener("error", (event) => {
    clearTimeout(timer);
    // Undici puts the reason on the event, which the adapter throws away.
    const reason = event?.message ?? event?.error?.message ?? event?.error?.cause?.message ?? "(no detail on the event)";
    resolve(`ERROR — ${reason}`);
  }, { once: true });
});

console.log("");
say("WebSocket(endpoint)", await tryOpen(found, "endpoint"));

child.kill();
// Chrome holds its profile files open for a moment after being killed.
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* left in temp */ }
