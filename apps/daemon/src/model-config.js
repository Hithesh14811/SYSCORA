import fs from "node:fs";
import path from "node:path";

// Model configuration loader. Resolves the model gateway settings from, in
// priority order:
//   1. Environment variables (SYSCORA_MODEL_PROVIDER / _API_KEY / _NAME / base).
//   2. A local, GITIGNORED config file at <basePath>/.syscora/config.json.
//   3. Built-in defaults (Mock provider — deterministic, no network).
//
// The API key is NEVER committed to source. It lives only in .syscora/ (already
// in .gitignore) or the environment. This keeps SYSCORA vendor-neutral: point
// `provider: "agentrouter"` at the AgentRouter gateway and switch models
// (claude-opus-4-8 / gpt-5.5 / glm-5.2) by changing `model` alone.
export function loadModelConfig(basePath = process.cwd()) {
  let fileConfig = {};
  let consentConfig = {};
  const configPath = path.join(basePath, ".syscora", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      fileConfig = parsed?.model ?? parsed ?? {};
      consentConfig = parsed?.externalAIConsent ?? fileConfig?.externalAIConsent ?? {};
    }
  } catch {
    // A malformed local config must never crash startup; fall back to env/mock.
    fileConfig = {};
  }

  return {
    provider: process.env.SYSCORA_MODEL_PROVIDER || fileConfig.provider || "mock",
    apiKey:
      process.env.SYSCORA_MODEL_API_KEY ||
      process.env.AGENTROUTER_API_KEY ||
      fileConfig.apiKey ||
      null,
    model: process.env.SYSCORA_MODEL_NAME || fileConfig.model || undefined,
    baseUrl: process.env.SYSCORA_MODEL_BASE_URL || fileConfig.baseUrl || undefined,
    fallbackProviders:
      process.env.SYSCORA_MODEL_FALLBACK_PROVIDERS || fileConfig.fallbackProviders || "",
    externalAIConsent: {
      scopes: String(
        process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES ||
        (Array.isArray(consentConfig.scopes) ? consentConfig.scopes.join(",") : consentConfig.scopes) ||
        "EXTERNAL_AI_DISABLED"
      ).split(",").map((scope) => scope.trim()).filter(Boolean)
    }
  };
}
