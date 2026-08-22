// PUT A NEW KEY IN FRONT OF THE OLD ONE FOR ONE ENDPOINT.
//
//   SYSCORA_CANDIDATE_KEY=... node scripts/rotate-model-key.mjs --base-url <url>
//
// The entry matching that base URL keeps its provider, model and URL and takes
// the new key; a copy of it carrying the OLD key is inserted directly behind it,
// so the previous key becomes the backup for the same endpoint rather than being
// thrown away. Nothing else in the config is touched and the ordering of every
// other entry is preserved — which endpoint serves the next request must not
// change as a side effect of rotating a key, or the next measurement is against
// a different endpoint than the last one and nobody will know.
//
// NO KEY IS PRINTED, EVER — length and a short hash only. A previous session
// leaked the live key into a transcript by dumping this file to inspect it.
//
// The old config is copied to config.json.bak-<timestamp> BEFORE anything is
// written, and the write is atomic: a half-written config.json is a product that
// silently falls back to the offline Mock provider.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";

const index = process.argv.indexOf("--base-url");
const wantedBaseUrl = index >= 0 ? process.argv[index + 1] : null;
const candidate = process.env.SYSCORA_CANDIDATE_KEY;
if (!wantedBaseUrl || !candidate) {
  console.log("usage: SYSCORA_CANDIDATE_KEY=... node scripts/rotate-model-key.mjs --base-url <url>");
  process.exit(2);
}

const configPath = path.join(resolveStateDir(process.cwd()), "config.json");
const fingerprint = (key) => key
  ? `${String(key).length} chars, #${crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 8)}`
  : "—";
const same = (left, right) => String(left ?? "").replace(/\/+$/, "") === String(right ?? "").replace(/\/+$/, "");

const original = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(original);
const model = config.model ?? config;
const fallbacks = Array.isArray(model.fallbackProviderConfigs) ? model.fallbackProviderConfigs : [];

const describe = (label, entry) =>
  `  ${label.padEnd(12)} ${String(entry.provider ?? "?").padEnd(10)} ${String(entry.baseUrl ?? "?").padEnd(34)} ${fingerprint(entry.apiKey)}`;

console.log(`\nconfig: ${configPath}\n\nbefore`);
console.log(describe("primary", { provider: model.provider, baseUrl: model.baseUrl, apiKey: model.primaryApiKey || model.apiKey }));
fallbacks.forEach((entry, position) => console.log(describe(`fallback ${position + 1}`, entry)));

const target = fallbacks.findIndex((entry) => same(entry.baseUrl, wantedBaseUrl));
const primaryMatches = same(model.baseUrl, wantedBaseUrl);
if (target < 0 && !primaryMatches) {
  console.log(`\nNo configured endpoint has base URL ${wantedBaseUrl} — nothing changed.\n`);
  process.exit(1);
}

let updated;
if (target >= 0) {
  const entry = fallbacks[target];
  const previousKey = entry.apiKeyFromExistingConfig ? (model.primaryApiKey || model.apiKey) : entry.apiKey;
  if (previousKey === candidate) {
    console.log("\nThat key is already the one in use for this endpoint — nothing changed.\n");
    process.exit(0);
  }
  // The demoted copy carries an explicit key even if the original inherited one,
  // because "inherit from the primary" would follow the primary if IT is ever
  // rotated, and this entry exists to be the specific old key.
  const demoted = { ...entry, apiKey: previousKey };
  delete demoted.apiKeyFromExistingConfig;
  const promoted = { ...entry, apiKey: candidate };
  delete promoted.apiKeyFromExistingConfig;
  updated = [...fallbacks.slice(0, target), promoted, demoted, ...fallbacks.slice(target + 1)];
} else {
  // The endpoint being rotated is the primary: demote its key into a fallback
  // entry describing the same endpoint, and put the new key on the primary.
  const previousKey = model.primaryApiKey || model.apiKey;
  if (previousKey === candidate) {
    console.log("\nThat key is already the one in use for this endpoint — nothing changed.\n");
    process.exit(0);
  }
  updated = [{ provider: model.provider, model: model.model, baseUrl: model.baseUrl, apiKey: previousKey }, ...fallbacks];
  if (model.primaryApiKey) model.primaryApiKey = candidate; else model.apiKey = candidate;
}
model.fallbackProviderConfigs = updated;

const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(configPath, backupPath);
const temporaryPath = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, configPath);

// READ IT BACK FROM DISK, not from the object we just wrote. The claim is about
// what the next process will load, and only the file can support that.
const reloaded = JSON.parse(fs.readFileSync(configPath, "utf8"));
const reloadedModel = reloaded.model ?? reloaded;
console.log("\nafter (re-read from disk)");
console.log(describe("primary", {
  provider: reloadedModel.provider, baseUrl: reloadedModel.baseUrl,
  apiKey: reloadedModel.primaryApiKey || reloadedModel.apiKey
}));
(reloadedModel.fallbackProviderConfigs ?? []).forEach((entry, position) =>
  console.log(describe(`fallback ${position + 1}`, entry)));
console.log(`\nprevious config saved as ${path.basename(backupPath)}\n`);
