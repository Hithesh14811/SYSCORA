import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadModelConfig } from "../../apps/daemon/src/model-config.js";
import { migrateModelCredentials, resetModelCredentials } from "../../apps/daemon/src/model-settings.js";

const KEY_ENV = [
  "SYSCORA_MODEL_API_KEY", "LLM_API_KEY", "AGENTROUTER_API_KEY", "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "SYSCORA_MODEL_API_KEYS", "SYSCORA_EXTERNAL_AI_CONSENT_SCOPES"
];

async function isolatedConfig(t, model) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-model-settings-"));
  const state = path.join(base, ".syscora");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify({ model }));
  const saved = new Map(KEY_ENV.map((name) => [name, process.env[name]]));
  for (const name of KEY_ENV) delete process.env[name];
  t.after(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, state };
}

test("plaintext legacy credentials are reported as requiring migration", async (t) => {
  const { base } = await isolatedConfig(t, { provider: "openai", apiKey: "legacy-plaintext-key" });
  const config = loadModelConfig(base);
  assert.equal(config.apiKey, "legacy-plaintext-key");
  assert.equal(config.credentialStatus, "plaintext");
});

test("credential migration protects the value and round-trips it", { skip: process.platform !== "win32" }, async (t) => {
  const { base, state } = await isolatedConfig(t, { provider: "openai", apiKey: "migration-test-key" });
  const migrated = await migrateModelCredentials(base);
  assert.equal(migrated.migrated, 1);

  const stored = JSON.parse(await fs.readFile(path.join(state, "config.json"), "utf8"));
  assert.equal(stored.model.apiKey, undefined);
  assert.equal(stored.model.primaryApiKey, "dpapi:model-primary.bin");
  const loaded = loadModelConfig(base);
  assert.equal(loaded.apiKey, "migration-test-key");
  assert.equal(loaded.credentialStatus, "protected");
});

test("reset removes protected files and returns the provider to offline mode", async (t) => {
  const { base, state } = await isolatedConfig(t, { provider: "openai", primaryApiKey: "dpapi:model-primary.bin" });
  await fs.mkdir(path.join(state, "secrets"), { recursive: true });
  await fs.writeFile(path.join(state, "secrets", "model-primary.bin"), "not-a-real-secret");

  const result = await resetModelCredentials(base);
  assert.equal(result.removedProtectedFiles, 1);
  await assert.rejects(fs.stat(path.join(state, "secrets", "model-primary.bin")), { code: "ENOENT" });
  const stored = JSON.parse(await fs.readFile(path.join(state, "config.json"), "utf8"));
  assert.deepEqual(stored.model, { provider: "mock" });
  assert.deepEqual(stored.externalAIConsent.scopes, ["EXTERNAL_AI_DISABLED"]);
});
