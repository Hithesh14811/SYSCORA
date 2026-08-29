import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { isProtectedReference, resolveProtectedValue } from "../../../packages/secrets/src/protected-value.js";

// Model configuration loader. Resolves the model gateway settings from, in
// priority order:
//   1. Environment variables (SYSCORA_MODEL_PROVIDER / _API_KEY / _NAME / base).
//   2. A local, GITIGNORED config file at <stateDir>/config.json.
//   3. Built-in defaults (Mock provider — deterministic, no network).
//
// The API key is NEVER committed to source. It lives only in .syscora/ (already
// in .gitignore) or the environment. This keeps SYSCORA vendor-neutral: point
// `provider: "agentrouter"` at the AgentRouter gateway and switch models
// (claude-opus-4-8 / gpt-5.5 / glm-5.2) by changing `model` alone.
export function loadModelConfig(basePath = process.cwd()) {
  let fileConfig = {};
  let consentConfig = {};
  const diagnostics = [];
  const configPath = path.join(resolveStateDir(basePath), "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      fileConfig = parsed?.model ?? parsed ?? {};
      consentConfig = parsed?.externalAIConsent ?? fileConfig?.externalAIConsent ?? {};
    }
  } catch (error) {
    // A malformed local config must never crash startup; fall back to env/mock.
    //
    // BUT IT MUST NOT DO IT QUIETLY, AND FOR MONTHS IT DID.
    //
    // Swallowed whole, this catch means: the file has a typo, so the provider
    // silently becomes Mock and the agent stops using any real model. Observed
    // 19 Aug 2026 — a key pasted into config.json as a sentence rather than JSON
    // left the whole product running on the deterministic offline stub, and the
    // only symptom was that answers went strange. Nothing in any log said the
    // config had not been read.
    //
    // Still not a throw: refusing to start because one file has a comma in the
    // wrong place is worse than starting degraded. The fix is that degraded is
    // now VISIBLE. This is the one thing in this file that writes to stderr.
    process.emitWarning(
      `SYSCORA: ${configPath} could not be parsed, so NONE of it was used — ` +
      `${error?.message ?? error}. Falling back to environment variables, then to the offline Mock ` +
      "provider. If answers look wrong or nothing reaches your model, this is why.",
      "SyscoraConfigWarning"
    );
    diagnostics.push({ code: "CONFIG_PARSE_FAILED", message: "The local model configuration could not be parsed." });
    fileConfig = {};
  }

  // A KEY IN THIS FILE IS A KEY IN EVERY TRANSCRIPT THAT EVER QUOTES THIS FILE.
  //
  // The keys used to be plaintext here, next to a DPAPI store that was already
  // constructed and used for other things. It cost something real: a session
  // dumped this config to check a setting and the live key went into the
  // transcript with it. A value written as "dpapi:model-primary.bin" is a
  // reference to an encrypted file beside it and leaks nothing when that
  // happens again — see packages/secrets/src/protected-value.js, and
  // scripts/protect-model-key.mjs, which does the migration.
  //
  // MIGRATION IS OPT-IN AND PLAINTEXT STILL WORKS. A config nobody has migrated
  // must behave exactly as it did; this product breaking because it could not
  // find a key would be a far worse outcome than the leak it is guarding.
  //
  // A reference that will not decrypt is LOUD, and does not fall through to the
  // offline Mock provider. That silent fall-through is the exact defect the
  // parse-error branch above exists to have fixed once already: the whole
  // product quietly stopped using its real model and the only symptom was that
  // answers went strange.
  const secretsDirectory = path.join(resolveStateDir(basePath), "secrets");
  // Each decrypt is a PowerShell spawn, and the same reference is asked for more
  // than once — the primary key, and again by any fallback that inherits it.
  // Memoised per load, not across loads: this is a decrypt, not a cache of
  // secrets, and it dies with the call.
  const decrypted = new Map();
  let protectedValueFailed = false;
  const unprotect = (value, what) => {
    if (!isProtectedReference(value)) return value;
    if (decrypted.has(value)) return decrypted.get(value);
    try {
      const plaintext = resolveProtectedValue(value, { baseDirectory: secretsDirectory });
      decrypted.set(value, plaintext);
      return plaintext;
    } catch (error) {
      protectedValueFailed = true;
      diagnostics.push({
        code: "PROTECTED_VALUE_UNREADABLE",
        message: `The ${what} cannot be decrypted by this Windows account.`
      });
      process.emitWarning(
        `SYSCORA: the ${what} is stored encrypted and could not be read — ${error?.message ?? error}. ` +
        "No model will be reachable until this is fixed.",
        "SyscoraConfigWarning"
      );
      decrypted.set(value, null);
      return null;
    }
  };

  const fallbackProviderConfigs = Array.isArray(fileConfig.fallbackProviderConfigs)
    ? fileConfig.fallbackProviderConfigs.map((fallback) => (
      fallback?.apiKeyFromExistingConfig
        ? { ...fallback, apiKey: unprotect(fileConfig.primaryApiKey ?? fileConfig.apiKey, "primary model key") }
        : { ...fallback, apiKey: unprotect(fallback?.apiKey, `fallback model key for ${fallback?.baseUrl ?? "an endpoint"}`) }
    ))
    : [];

  // LLM_* is the vendor-neutral spelling used by most local .env files and by
  // the provider dashboards themselves, so it is accepted alongside the
  // SYSCORA_* names rather than requiring the key to be renamed on the way in.
  // SYSCORA_* still wins, because it is the more specific of the two.
  const provider = process.env.SYSCORA_MODEL_PROVIDER || process.env.LLM_PROVIDER || fileConfig.provider || "mock";
  const providerEnvironmentApiKey = ({
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    agentrouter: process.env.AGENTROUTER_API_KEY
  })[String(provider).toLowerCase()];
  const environmentApiKey =
    process.env.SYSCORA_MODEL_API_KEY ||
    process.env.LLM_API_KEY ||
    providerEnvironmentApiKey ||
    null;
  const storedPrimaryValue = fileConfig.primaryApiKey ?? fileConfig.apiKey ?? null;
  const resolvedPrimaryApiKey = environmentApiKey || unprotect(storedPrimaryValue, "primary model key") || null;
  const configuredApiKeys = (() => {
    const configured = process.env.SYSCORA_MODEL_API_KEYS || fileConfig.apiKeys || [];
    return (Array.isArray(configured) ? configured : String(configured).split(","))
      .map((key, index) => unprotect(String(key).trim(), `model key pool entry ${index + 1}`))
      .filter(Boolean);
  })();
  const fileContainsPlaintextCredential = Boolean(
    (storedPrimaryValue && !isProtectedReference(storedPrimaryValue)) ||
    (Array.isArray(fileConfig.apiKeys) && fileConfig.apiKeys.some((key) => key && !isProtectedReference(key))) ||
    (Array.isArray(fileConfig.fallbackProviderConfigs) &&
      fileConfig.fallbackProviderConfigs.some((fallback) => fallback?.apiKey && !isProtectedReference(fallback.apiKey)))
  );
  const credentialStatus = environmentApiKey
    ? "environment"
    : protectedValueFailed
      ? "unreadable"
      : fileContainsPlaintextCredential
        ? "plaintext"
        : (resolvedPrimaryApiKey || configuredApiKeys.length > 0)
          ? "protected"
          : "missing";

  return {
    provider,
    apiKey: resolvedPrimaryApiKey,
    apiKeys: configuredApiKeys,
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
      // A configured endpoint is not consent. Desktop setup writes these scopes
      // only after the disclosure checkbox is submitted. Headless developers
      // must set SYSCORA_EXTERNAL_AI_CONSENT_SCOPES explicitly; otherwise the
      // provider remains configured but model content cannot leave the machine.
      scopes: String(
        process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES ||
        (Array.isArray(consentConfig.scopes) ? consentConfig.scopes.join(",") : consentConfig.scopes) ||
        "EXTERNAL_AI_DISABLED"
      ).split(",").map((scope) => scope.trim()).filter(Boolean)
    },
    credentialStatus,
    diagnostics
  };
}
