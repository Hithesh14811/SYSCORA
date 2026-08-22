#!/usr/bin/env node
// IS THIS INSTALLATION HEALTHY, AND IF NOT, WHAT EXACTLY IS WRONG?
//
//   npm run doctor            check everything, print a verdict
//   npm run doctor -- --quick skip the checks that cost a network round trip
//
// A product people are asked to trust with their computer needs one command
// that answers "is it working". Without it, every support conversation starts
// from nothing and every failure looks the same: it just did not do the thing.
//
// EVERY CHECK HERE EXERCISES THE THING RATHER THAN INSPECTING IT. That is the
// rule this project keeps relearning: a version number is not a working
// database, a configured endpoint is not a paid one, a file that exists is not
// a directory you can write to. Each check below does the actual operation and
// reports what came back.
//
// NO SECRET IS EVER PRINTED. Keys are shown as a length and a short hash, which
// is enough to tell two apart and useless to anyone reading over a shoulder.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";
import { checkPersistenceSupport, MINIMUM_NODE } from "../apps/daemon/src/preflight.js";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";
import { isProtectedReference } from "../packages/secrets/src/protected-value.js";
import { CRASH_RECORD, describeInterruptedRun } from "../apps/daemon/src/crash-guard.js";

const quick = process.argv.includes("--quick");
const results = [];
const record = (status, name, detail) => {
  results.push({ status, name, detail });
  const badge = status === "PASS" ? "  ok  " : status === "WARN" ? " warn " : " FAIL ";
  console.log(`[${badge}] ${name}`);
  for (const line of String(detail).split("\n")) console.log(`         ${line}`);
};
const fingerprint = (value) => value
  ? `${String(value).length} chars, #${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`
  : "not set";

console.log("\nSYSCORA doctor\n");

// ---- 1. the runtime ---------------------------------------------------------
const persistence = checkPersistenceSupport();
record(
  persistence.ok ? "PASS" : "FAIL",
  "Node and the database layer",
  persistence.ok
    ? `Node ${process.versions.node}; node:sqlite opened, wrote and read back a row`
    : `${persistence.reason}\nSYSCORA needs Node ${MINIMUM_NODE} or later.`
);

// ---- 2. where working state lives -------------------------------------------
//
// Two specific disasters are checked for by name, because both happened:
// the state directory inside OneDrive (2 GB re-uploaded on every agent turn),
// and inside a packaged application's container (735 MB of the user's
// conversations in another app's private storage, erased when it resets).
const stateDir = resolveStateDir(process.cwd());
let stateDetail = `${stateDir}`;
let stateStatus = "PASS";
try {
  fs.mkdirSync(stateDir, { recursive: true });
  const probe = path.join(stateDir, ".doctor-write-probe");
  fs.writeFileSync(probe, "ok");
  if (fs.readFileSync(probe, "utf8") !== "ok") throw new Error("wrote a file that read back differently");
  fs.unlinkSync(probe);
  stateDetail += "\nwritten to and read back";
} catch (error) {
  stateStatus = "FAIL";
  stateDetail += `\nNOT WRITABLE: ${error?.message ?? error}`;
}
if (/onedrive|dropbox|google ?drive|icloud/i.test(stateDir)) {
  stateStatus = "FAIL";
  stateDetail += "\nThis is inside a SYNC FOLDER. Databases rewritten on every turn will be" +
    "\nre-uploaded continuously — this cost 2.5 cores for five days once already.";
}
if (/\\Packages\\/i.test(stateDir)) {
  stateStatus = "FAIL";
  stateDetail += "\nThis is inside a packaged application's container. Whatever is here is" +
    "\nerased when that application is reset or uninstalled.";
}
record(stateStatus, "Working state directory", stateDetail);

// ---- 3. how big it has become ----------------------------------------------
const databases = [];
const collect = (directory) => {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith(".sqlite")) {
      try { databases.push({ name: path.relative(stateDir, full), bytes: fs.statSync(full).size }); } catch { /* gone */ }
    }
  }
};
collect(stateDir);
const totalBytes = databases.reduce((sum, database) => sum + database.bytes, 0);
const asMb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const largest = [...databases].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
record(
  totalBytes > 1_500_000_000 ? "WARN" : "PASS",
  "Stored data",
  `${databases.length} databases, ${asMb(totalBytes)} total\n` +
  largest.map((database) => `${asMb(database.bytes).padStart(10)}  ${database.name}`).join("\n") +
  (totalBytes > 1_500_000_000 ? "\nOver 1.5 GB. Only the session store has a per-row cap." : "")
);

// ---- 4. did the last run end properly? --------------------------------------
const crashPath = path.join(stateDir, CRASH_RECORD);
if (fs.existsSync(crashPath)) {
  let summary = "a crash record is present but could not be read";
  try { summary = describeInterruptedRun(JSON.parse(fs.readFileSync(crashPath, "utf8"))) ?? summary; } catch { /* keep the fallback */ }
  record("WARN", "Previous run", summary);
} else {
  record("PASS", "Previous run", "no interrupted run recorded");
}

// ---- 5. the model endpoints -------------------------------------------------
const model = loadModelConfig(process.cwd());
const raw = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8")); } catch { return {}; }
})();
const rawModel = raw.model ?? raw;
const plaintextKeys = [rawModel.apiKey, rawModel.primaryApiKey, ...(rawModel.fallbackProviderConfigs ?? []).map((entry) => entry.apiKey)]
  .filter((value) => typeof value === "string" && value.length > 0 && !isProtectedReference(value));
record(
  plaintextKeys.length === 0 ? "PASS" : "WARN",
  "Credentials at rest",
  plaintextKeys.length === 0
    ? "every configured key is an encrypted reference (dpapi:)"
    : `${plaintextKeys.length} key(s) are stored in plaintext in config.json.\nRun: node scripts/protect-model-key.mjs`
);

const endpoints = [
  { label: "primary", baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey },
  ...(model.fallbackProviderConfigs ?? []).map((entry, index) => ({
    label: `fallback ${index + 1}`, baseUrl: entry.baseUrl, model: entry.model, apiKey: entry.apiKey
  }))
];
if (quick) {
  record("PASS", "Model endpoints", `${endpoints.length} configured (not contacted; --quick)\n` +
    endpoints.map((endpoint) => `${endpoint.label.padEnd(12)} ${endpoint.baseUrl} — key ${fingerprint(endpoint.apiKey)}`).join("\n"));
} else {
  // ONE REAL REQUEST. Not /models, not a HEAD: an out-of-credit account answers
  // those perfectly and then returns 402 on the thing you actually want.
  const lines = [];
  let alive = 0;
  for (const endpoint of endpoints) {
    let verdict;
    try {
      const response = await fetch(`${String(endpoint.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({ model: endpoint.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(45000)
      });
      const text = await response.text();
      verdict = response.ok
        ? "answered"
        : `HTTP ${response.status}${/insufficient|balance|quota|payment/i.test(text) ? " — OUT OF CREDIT" : ""}`;
      if (response.ok) alive += 1;
    } catch (error) {
      verdict = `unreachable: ${String(error?.message ?? error).slice(0, 60)}`;
    }
    lines.push(`${endpoint.label.padEnd(12)} ${verdict.padEnd(28)} ${endpoint.baseUrl}`);
  }
  record(
    alive === 0 ? "FAIL" : alive < endpoints.length ? "WARN" : "PASS",
    "Model endpoints",
    `${alive} of ${endpoints.length} answered a real request\n${lines.join("\n")}` +
    (alive === 0 ? "\nNothing can be asked of the model. SYSCORA cannot work in this state." : "") +
    (alive > 0 && alive < endpoints.length ? "\nStill working: requests fail over to an endpoint that answers." : "")
  );
}

// ---- 6. can it actually drive the machine? ----------------------------------
if (!quick) {
  try {
    const { WindowsAdapter } = await import("../os-adapters/windows/src/windows-adapter.js");
    const adapter = new WindowsAdapter();
    const started = Date.now();
    await adapter.automationHost?.warm?.();
    const windows = await adapter.listWindows();
    const elapsed = Date.now() - started;
    adapter.close?.();
    record(
      windows.length > 0 ? "PASS" : "WARN",
      "Windows automation host",
      `started and enumerated ${windows.length} windows in ${elapsed}ms`
    );
  } catch (error) {
    record("FAIL", "Windows automation host", `could not start: ${error?.message ?? error}\nSYSCORA cannot see or drive the screen without it.`);
  }

  // A host whose owner is gone. Age alone is not orphanhood and PIDs are reused,
  // so this only reports the count the dedicated probe would examine properly.
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "(Get-Process powershell -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
    const count = Number(output) || 0;
    record(count > 8 ? "WARN" : "PASS", "PowerShell processes",
      `${count} running\n` + (count > 8
        ? "Higher than expected. Age is not orphanhood — run scripts/probe-leaked-hosts.ps1,\nwhich checks whether each one's OWNER is gone."
        : "within the normal range for a session"));
  } catch {
    record("WARN", "PowerShell processes", "could not be counted");
  }
}

// ---- verdict ----------------------------------------------------------------
const failures = results.filter((result) => result.status === "FAIL");
const warnings = results.filter((result) => result.status === "WARN");
console.log("\n" + "-".repeat(72));
if (failures.length > 0) {
  console.log(`FAIL — ${failures.length} check(s) failed: ${failures.map((result) => result.name).join(", ")}`);
} else if (warnings.length > 0) {
  console.log(`OK with ${warnings.length} warning(s): ${warnings.map((result) => result.name).join(", ")}`);
} else {
  console.log("OK — everything checked answered correctly.");
}
console.log("");
process.exit(failures.length > 0 ? 1 : 0);
