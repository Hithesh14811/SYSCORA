import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const forbiddenPrefixes = [".kiro/", ".claude/", ".agents/", "%USERPROFILE%/", "dist/", "node_modules/", ".syscora/"];
const forbiddenTracked = tracked.filter((file) => {
  try { return forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) && Boolean(requireExists(file)); } catch { return false; }
});
function requireExists(file) {
  return file && path.resolve(file) && fsSync.existsSync(file);
}

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{25,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const secretHits = [];
for (const file of tracked) {
  if (file.startsWith("tests/")) continue;
  if (/\.(?:png|ico|exe|bin|sqlite|pdf|docx|zip)$/i.test(file)) continue;
  let source;
  try { source = await fs.readFile(file, "utf8"); } catch { continue; }
  if (secretPatterns.some((pattern) => pattern.test(source))) secretHits.push(file);
}

const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
const staleProductFiles = [
  "apps/desktop/index.html",
  "apps/desktop/app.js",
  "apps/desktop/styles.css",
  "apps/daemon/src/privileged-helper.js",
  "packages/fast-agent/src/undo-message.js",
  "packages/benchmark/src/index.js"
];
const presentStaleFiles = staleProductFiles.filter((entry) => fsSync.existsSync(entry));
const failures = [];
if (forbiddenTracked.length) failures.push(`Forbidden tracked paths:\n${forbiddenTracked.join("\n")}`);
if (secretHits.length) failures.push(`Secret-shaped values found in:\n${secretHits.join("\n")}`);
if (presentStaleFiles.length) failures.push(`Deleted stale product files have returned:\n${presentStaleFiles.join("\n")}`);
if (packageJson.devDependencies?.electron !== "43.4.1") failures.push("Electron must remain exactly pinned to the reviewed release.");
if (failures.length) {
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`Static release checks passed across ${tracked.length} tracked files.`);
