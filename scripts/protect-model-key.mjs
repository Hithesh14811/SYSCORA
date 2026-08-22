// MOVE THE MODEL KEYS OUT OF PLAINTEXT config.json AND INTO DPAPI.
//
//   node scripts/protect-model-key.mjs --dry-run    say what would change
//   node scripts/protect-model-key.mjs              do it
//   node scripts/protect-model-key.mjs --revert <backup>   put a backup back
//
// The keys sat in plaintext in the state directory next to a DPAPI store that
// was already being constructed and used for other things. The demonstrated
// cost was not theft: a session dumped that config into a transcript to check a
// setting, and the live key went with it. After this, the file holds
// "dpapi:model-primary.bin" and a dump leaks nothing.
//
// NOTHING IS DELETED UNTIL IT HAS BEEN READ BACK. Each key is encrypted,
// decrypted again through the exact path the daemon will use, and compared with
// the original — and only then does the plaintext leave config.json. The whole
// original file is copied to config.json.bak-<timestamp> first, and `--revert`
// puts one back.
//
// NO KEY IS EVER PRINTED. Length and a short hash, so a before and after can be
// compared without publishing anything.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../packages/shared-types/src/state-path.js";
import { PROTECTED_PREFIX, isProtectedReference, protectToFile, readProtectedFileSync } from "../packages/secrets/src/protected-value.js";

const dryRun = process.argv.includes("--dry-run");
const revertIndex = process.argv.indexOf("--revert");
const stateDir = resolveStateDir(process.cwd());
const configPath = path.join(stateDir, "config.json");
const secretsDir = path.join(stateDir, "secrets");

const fingerprint = (value) => value
  ? `${String(value).length} chars, #${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`
  : "—";

if (revertIndex >= 0) {
  const backup = process.argv[revertIndex + 1];
  if (!backup) {
    console.log("usage: node scripts/protect-model-key.mjs --revert <config.json.bak-...>");
    process.exit(2);
  }
  const source = path.isAbsolute(backup) ? backup : path.join(stateDir, backup);
  fs.copyFileSync(source, configPath);
  console.log(`\nRestored ${path.basename(source)} over config.json.\n`);
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const model = config.model ?? config;

// EVERY PLACE A KEY CAN LIVE, NOT THE FIRST ONE THAT ANSWERS.
//
// This was `primaryApiKey` else `apiKey`, because `loadModelConfig` reads them
// in that order and the first one wins. But the config on this machine had
// BOTH, so protecting the winner left the loser sitting in plaintext three
// lines below it — and every fingerprint printed afterwards was right, because
// they were read through the same preference order. The check at the end of
// this script is what caught it. A migration that moves the value the loader
// happens to prefer has not moved the secret out of the file.
const slots = [];
if (model.primaryApiKey) {
  slots.push({ label: "primaryApiKey", read: () => model.primaryApiKey, write: (v) => { model.primaryApiKey = v; }, file: "model-primary.bin" });
}
if (model.apiKey) {
  slots.push({ label: "apiKey", read: () => model.apiKey, write: (v) => { model.apiKey = v; }, file: "model-apikey.bin" });
}
if (Array.isArray(model.apiKeys)) {
  model.apiKeys.forEach((_, index) => slots.push({
    label: `apiKeys[${index}]`,
    read: () => model.apiKeys[index],
    write: (v) => { model.apiKeys[index] = v; },
    file: `model-apikeys-${index}.bin`
  }));
}
(model.fallbackProviderConfigs ?? []).forEach((entry, index) => {
  // An entry that inherits the primary's key holds no key of its own, so there
  // is nothing here to protect.
  if (entry.apiKeyFromExistingConfig || !entry.apiKey) return;
  slots.push({
    label: `fallback ${index + 1}`,
    read: () => entry.apiKey,
    write: (v) => { entry.apiKey = v; },
    file: `model-fallback-${index + 1}.bin`
  });
});

console.log(`\nconfig: ${configPath}\nsecrets: ${secretsDir}\n`);
const pending = slots.filter((slot) => !isProtectedReference(slot.read()));
for (const slot of slots) {
  const current = slot.read();
  console.log(`  ${slot.label.padEnd(16)} ${isProtectedReference(current) ? `already protected -> ${current}` : `PLAINTEXT (${fingerprint(current)}) -> ${PROTECTED_PREFIX}${slot.file}`}`);
}

if (pending.length === 0) {
  console.log("\nNothing to do — every key is already a reference.\n");
  process.exit(0);
}
if (dryRun) {
  console.log(`\n--dry-run: ${pending.length} key(s) would be encrypted. Nothing was written.\n`);
  process.exit(0);
}

const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(configPath, backupPath);
console.log(`\nbacked up to ${path.basename(backupPath)}`);

// Kept so the finished file can be checked for them by hand below. This array
// holds live keys and is never printed.
const originals = [];
// The same key often appears in more than one slot — `apiKey` and
// `primaryApiKey` are usually the same string. Encrypt each distinct VALUE
// once and point every slot holding it at that one file, rather than writing
// the same secret to disk twice under different names.
const fileForValue = new Map();
for (const slot of pending) {
  const plaintext = slot.read();
  originals.push(plaintext);
  if (fileForValue.has(plaintext)) {
    const shared = fileForValue.get(plaintext);
    slot.write(`${PROTECTED_PREFIX}${shared}`);
    console.log(`  ${slot.label.padEnd(16)} same value as an earlier slot -> ${shared}`);
    continue;
  }
  const target = path.join(secretsDir, slot.file);
  // protectToFile round-trips through the read path before returning, so a
  // failure here happens with the plaintext still in config.json.
  await protectToFile(target, plaintext);
  const readBack = readProtectedFileSync(target);
  if (readBack !== plaintext) {
    console.log(`\n${slot.label}: the encrypted file did not decrypt back to the same value. NOTHING WAS CHANGED.\n`);
    process.exit(1);
  }
  fileForValue.set(plaintext, slot.file);
  slot.write(`${PROTECTED_PREFIX}${slot.file}`);
  console.log(`  ${slot.label.padEnd(16)} encrypted and verified -> ${slot.file}`);
}

const temporaryPath = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, configPath);

// PROVE IT FROM DISK, THROUGH THE LOADER THE DAEMON USES. Re-reading the object
// we just wrote would prove only that this script can remember what it did.
const { loadModelConfig } = await import("../apps/daemon/src/model-config.js");
const loaded = loadModelConfig(process.cwd());
console.log("\nafter, as the daemon will load it:");
console.log(`  primary      ${fingerprint(loaded.apiKey)}`);
(loaded.fallbackProviderConfigs ?? []).forEach((entry, index) =>
  console.log(`  fallback ${index + 1}   ${fingerprint(entry.apiKey)}`));

// THE POINT OF THE EXERCISE, CHECKED RATHER THAN ASSUMED: is any of the
// plaintext still in the file? Read from disk, searched for the actual values.
const configText = fs.readFileSync(configPath, "utf8");
const stillPresent = originals.filter((plaintext) => configText.includes(plaintext));
console.log(`\nconfig.json holds ${(configText.match(/dpapi:/g) ?? []).length} reference(s).`);
if (stillPresent.length > 0) {
  console.log(`${stillPresent.length} key(s) ARE STILL IN PLAINTEXT in config.json — the migration did not do its job.`);
  console.log(`Restore with: node scripts/protect-model-key.mjs --revert ${path.basename(backupPath)}\n`);
  process.exit(1);
}
console.log("No plaintext key remains in it.");
console.log(`If anything is wrong: node scripts/protect-model-key.mjs --revert ${path.basename(backupPath)}\n`);
