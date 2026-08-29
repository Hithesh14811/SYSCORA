import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { isProtectedReference, protectToFile } from "../../../packages/secrets/src/protected-value.js";

async function readConfig(basePath) {
  const configPath = path.join(resolveStateDir(basePath), "config.json");
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`The model configuration cannot be changed until config.json is valid: ${error?.message ?? error}`);
  }
}

async function writeConfig(basePath, config) {
  const stateDirectory = resolveStateDir(basePath);
  const configPath = path.join(stateDirectory, "config.json");
  await fs.mkdir(stateDirectory, { recursive: true });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, configPath);
}

const protectedFilename = (value) => {
  if (!isProtectedReference(value)) return null;
  const name = value.slice("dpapi:".length);
  return name && !name.includes("..") && !path.isAbsolute(name) && path.basename(name) === name ? name : null;
};

export async function migrateModelCredentials(basePath = process.cwd()) {
  const config = await readConfig(basePath);
  const model = config.model && typeof config.model === "object" ? { ...config.model } : { ...config };
  const secretsDirectory = path.join(resolveStateDir(basePath), "secrets");
  let migrated = 0;

  const protect = async (value, name) => {
    if (!value || isProtectedReference(value)) return value;
    await protectToFile(path.join(secretsDirectory, name), String(value));
    migrated += 1;
    return `dpapi:${name}`;
  };

  const primary = model.primaryApiKey ?? model.apiKey;
  if (primary) {
    model.primaryApiKey = await protect(primary, "model-primary.bin");
    delete model.apiKey;
  }
  if (Array.isArray(model.apiKeys)) {
    model.apiKeys = await Promise.all(model.apiKeys.map((key, index) => protect(key, `model-pool-${index + 1}.bin`)));
  }
  if (Array.isArray(model.fallbackProviderConfigs)) {
    model.fallbackProviderConfigs = await Promise.all(model.fallbackProviderConfigs.map(async (fallback, index) => {
      if (!fallback || typeof fallback !== "object" || fallback.apiKeyFromExistingConfig) return fallback;
      return { ...fallback, apiKey: await protect(fallback.apiKey, `model-fallback-${index + 1}.bin`) };
    }));
  }

  if (migrated > 0) {
    await writeConfig(basePath, { ...config, model });
  }
  return { migrated, protected: migrated > 0 };
}

export async function resetModelCredentials(basePath = process.cwd()) {
  const config = await readConfig(basePath);
  const model = config.model && typeof config.model === "object" ? { ...config.model } : {};
  const references = new Set([
    model.primaryApiKey,
    model.apiKey,
    ...(Array.isArray(model.apiKeys) ? model.apiKeys : []),
    ...(Array.isArray(model.fallbackProviderConfigs)
      ? model.fallbackProviderConfigs.map((fallback) => fallback?.apiKey)
      : [])
  ].map(protectedFilename).filter(Boolean));

  const nextModel = { provider: "mock" };
  const next = {
    ...config,
    model: nextModel,
    externalAIConsent: { ...(config.externalAIConsent ?? {}), scopes: ["EXTERNAL_AI_DISABLED"] }
  };
  await writeConfig(basePath, next);

  const secretsDirectory = path.join(resolveStateDir(basePath), "secrets");
  for (const name of references) {
    await fs.rm(path.join(secretsDirectory, name), { force: true }).catch(() => {});
  }
  return { removedProtectedFiles: references.size, provider: "mock" };
}

