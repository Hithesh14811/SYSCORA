import fs from "node:fs/promises";
import { execFile } from "node:child_process";

// Node 22 on Windows does not execute .cmd shims through execFile directly.
// During an npm script npm_execpath points at npm-cli.js, which can be invoked
// with the current Node binary without involving a command shell.
const npmExecPath = String(process.env.npm_execpath ?? "").trim();
const command = process.platform === "win32" && npmExecPath ? process.execPath : "npm";
const commandArgs = process.platform === "win32" && npmExecPath
  ? [npmExecPath, "audit", "--json"]
  : ["audit", "--json"];
const result = await new Promise((resolve) => {
  execFile(command, commandArgs, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/npm-audit.json", result.stdout || result.stderr || "{}\n");
let report = {};
try { report = JSON.parse(result.stdout); } catch {}
const vulnerabilities = report.metadata?.vulnerabilities ?? {};
if ((vulnerabilities.high ?? 0) > 0 || (vulnerabilities.critical ?? 0) > 0) {
  console.error(`Dependency audit found ${vulnerabilities.high ?? 0} high and ${vulnerabilities.critical ?? 0} critical vulnerabilities.`);
  process.exit(1);
}
if (result.error && !report.metadata) {
  console.error("Dependency audit could not obtain a valid advisory report.");
  process.exit(1);
}
console.log("Dependency advisory gate passed; report: artifacts/npm-audit.json");
