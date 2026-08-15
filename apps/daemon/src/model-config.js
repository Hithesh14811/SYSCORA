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

  const fallbackProviderConfigs = Array.isArray(fileConfig.fallbackProviderConfigs)
    ? fileConfig.fallbackProviderConfigs.map((fallback) => (
      fallback?.apiKeyFromExistingConfig
        ? { ...fallback, apiKey: fileConfig.apiKey }
        : fallback
    ))
    : [];

  // LLM_* is the vendor-neutral spelling used by most local .env files and by
  // the provider dashboards themselves, so it is accepted alongside the
  // SYSCORA_* names rather than requiring the key to be renamed on the way in.
  // SYSCORA_* still wins, because it is the more specific of the two.
  const provider = process.env.SYSCORA_MODEL_PROVIDER || process.env.LLM_PROVIDER || fileConfig.provider || "mock";
  // Anything that is not the deterministic offline Mock reaches the network.
  const remoteProvider = String(provider).toLowerCase() !== "mock";

  return {
    provider,
    apiKey:
      process.env.SYSCORA_MODEL_API_KEY ||
      process.env.LLM_API_KEY ||
      process.env.AGENTROUTER_API_KEY ||
      fileConfig.primaryApiKey ||
      fileConfig.apiKey ||
      null,
    apiKeys: (() => {
      const configured = process.env.SYSCORA_MODEL_API_KEYS || fileConfig.apiKeys || [];
      return (Array.isArray(configured) ? configured : String(configured).split(","))
        .map((key) => String(key).trim())
        .filter(Boolean);
    })(),
    model: process.env.SYSCORA_MODEL_NAME || process.env.LLM_MODEL || fileConfig.model || undefined,
    baseUrl: process.env.SYSCORA_MODEL_BASE_URL || process.env.LLM_BASE_URL || fileConfig.baseUrl || undefined,
    // Ceiling on a single completion. Only large enough to matter for the
    // interactive decision call, whose localSteps array is the biggest thing
    // the model ever emits; a truncated response is unparseable JSON and the
    // repair loop cannot fix it, because the model was not wrong.
    maxTokens: Number(process.env.SYSCORA_MODEL_MAX_TOKENS || fileConfig.maxTokens || 4096),
    // Floor under every reasoning call. Generous by design: a timeout is a
    // CEILING, so raising it costs a fast model nothing — it returns in two
    // seconds either way — while a reasoning model that thinks before emitting
    // tokens was being aborted mid-call and reported as "all model providers
    // failed". The session's own elapsed-time budget still bounds the request,
    // so this cannot produce an unbounded run.
    requestTimeoutMs: Number(
      process.env.SYSCORA_MODEL_TIMEOUT_MS || fileConfig.requestTimeoutMs || 30000
    ),
    fallbackProviders:
      process.env.SYSCORA_MODEL_FALLBACK_PROVIDERS || fileConfig.fallbackProviders || "",
    fallbackProviderConfigs,
    externalAIConsent: {
      // CONFIGURING A REMOTE MODEL IS THE CONSENT DECISION.
      //
      // The default here was EXTERNAL_AI_DISABLED whether or not a remote model
      // had been set up — which was harmless only for as long as nothing checked
      // it. Now that the kill switch is actually wired to the agent loop (see
      // ConsentAwareModelProvider.supportsChat), that default would silently
      // demote anyone who configured a provider through environment variables to
      // the offline pipeline, for a switch they never set.
      //
      // Pointing SYSCORA at a hosted model IS choosing to send it what it needs
      // to work; there is no version of this product that talks to a remote model
      // without doing so. So the default follows the provider: a real one implies
      // the scopes it cannot run without, and Mock — no network — implies none.
      // Setting the scopes explicitly always wins, including setting them to
      // EXTERNAL_AI_DISABLED, which now genuinely disables it.
      scopes: String(
        process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES ||
        (Array.isArray(consentConfig.scopes) ? consentConfig.scopes.join(",") : consentConfig.scopes) ||
        (remoteProvider ? "EXTERNAL_AI_SANITIZED_REASONING,EXTERNAL_AI_STRUCTURED_UI_CONTEXT" : "EXTERNAL_AI_DISABLED")
      ).split(",").map((scope) => scope.trim()).filter(Boolean)
    }
  };
}
