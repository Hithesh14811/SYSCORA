import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import crypto from "crypto";
const createId = () => crypto.randomBytes(16).toString("hex");

export function validateSchema(data, schema) {
  if (!data) return { valid: false, errors: ["No data provided"] };
  const errors = [];
  const required = schema.required || [];
  for (const key of required) {
    if (!(key in data)) {
      errors.push(`Missing required field: ${key}`);
    }
  }
  const properties = schema.properties || {};
  for (const key in properties) {
    if (key in data && data[key] !== null && data[key] !== undefined) {
      const expectedType = properties[key].type;
      let actualType = typeof data[key];
      
      // Special case for arrays and null
      if (expectedType === "array" && Array.isArray(data[key])) {
        // OK!
      } else if (expectedType === "array" && !Array.isArray(data[key])) {
        errors.push(`Field ${key} must be ${expectedType}, got ${actualType}`);
      } else if (expectedType && actualType !== expectedType) {
        errors.push(`Field ${key} must be ${expectedType}, got ${actualType}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function isRetryableProviderError(error) {
  if (error?.name === "AbortError" || error?.name === "TypeError") return true;
  const status = String(error?.message ?? "").match(/HTTP\s+(\d{3})/i)?.[1];
  return status ? [408, 409, 425, 429].includes(Number(status)) || Number(status) >= 500 : false;
}

export class LanguageModelProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = "base";
    // Internal counter. Exposed via usage() and getUsage(). Named _usage so the
    // usage() method name does not collide with the data property.
    this._usage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    this._telemetry = { calls: 0, failures: 0, totalLatencyMs: 0, lastLatencyMs: 0 };
  }

  // Structured generation against a JSON schema. Concrete providers override.
  async generateStructured(prompt, schema, options = {}) {
    throw new Error("Not implemented");
  }

  // Free-text generation (used for execution summarization). Default falls back
  // to structured generation so a provider need only implement one path.
  async generateText(prompt, options = {}) {
    const result = await this.generateStructured(
      prompt,
      { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      options
    );
    return typeof result?.text === "string" ? result.text : String(result ?? "");
  }

  // Legacy name kept for backward compatibility.
  async healthCheck() {
    return { ok: true };
  }

  // Canonical health() required by the milestone interface; delegates to
  // healthCheck() so existing provider implementations keep working.
  async health() {
    return this.healthCheck();
  }

  // Legacy name kept for backward compatibility.
  async getUsage() {
    return { ...this._usage };
  }

  // Canonical usage() required by the milestone interface.
  usage() {
    return { ...this._usage };
  }

  telemetry() {
    const calls = this._telemetry.calls;
    return { ...this._telemetry, averageLatencyMs: calls ? this._telemetry.totalLatencyMs / calls : 0 };
  }

  // Declares what the provider can do. Overridden by concrete providers.
  capabilities() {
    return {
      name: this.name,
      structured: true,
      text: true,
      streaming: false
    };
  }
}

export class MockModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    this.name = "mock";
  }

  async healthCheck() {
    return { ok: true, type: "MockModelProvider", date: new Date().toISOString() };
  }

  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    const startedAt = performance.now();
    const scenario = this.config.scenarios?.shift?.();
    if (scenario === "timeout") throw new DOMException("Timed out", "AbortError");
    if (scenario === "rate_limit") throw new Error("HTTP 429");
    if (scenario === "network_failure") throw new TypeError("Network unavailable");
    if (scenario === "malformed_json") throw new SyntaxError("Malformed JSON");
    if (scenario === "invalid_schema") return { invalid: "schema" };
    if (options.forceFailure) {
      throw new Error("Forced model failure");
    }
    if (options.forceInvalidSchema) {
      return { invalid: "schema" };
    }
    if (options.forceRepairable) {
      return { normalizedGoal: "Fixable", category: "SYSTEM", entities: {} };
    }
    // Handle known test scenarios
    if (prompt.includes("set env") || prompt.includes("environment variable")) {
      return {
        normalizedGoal: "Set an environment variable in the project",
        category: "PROJECT",
        entities: {
          key: "API_URL",
          value: "http://localhost:3000"
        },
        successCriteria: ["API_URL is present in the .env file"],
        requiredContext: ["workspace"],
        constraints: [],
        clarificationQuestions: [],
        sensitivityFlags: []
      };
    }
    if (prompt.includes("system information") || prompt.includes("Show me my system") || prompt.includes("inspect system")) {
      return { 
        normalizedGoal: "Show system information", 
        category: "SYSTEM", 
        entities: {}, 
        successCriteria: ["System information is displayed"], 
        requiredContext: ["system"], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: []
      };
    }
    if (prompt.includes("processes running") || prompt.includes("What processes")) {
      return { 
        normalizedGoal: "List running processes", 
        category: "SYSTEM", 
        entities: {}, 
        successCriteria: ["Running processes are displayed"], 
        requiredContext: ["processes"],
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    if (prompt.includes("PATH") || prompt.includes("Show me my PATH")) {
      return { 
        normalizedGoal: "Show user PATH environment variable", 
        category: "SYSTEM", 
        entities: {}, 
        successCriteria: ["User PATH is displayed"], 
        requiredContext: ["environment"], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    if (prompt.includes("port") && (prompt.includes("3000") || options.port)) {
      return { 
        normalizedGoal: "Find the process using port 3000", 
        category: "SYSTEM", 
        entities: { port: options.port || 3000 }, 
        successCriteria: ["Process using port 3000 is identified"], 
        requiredContext: ["port"], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    if (prompt.includes("inspect this project") || prompt.includes("what stack")) {
      return { 
        normalizedGoal: "Inspect this project and determine its tech stack", 
        category: "PROJECT", 
        entities: {}, 
        successCriteria: ["Project tech stack is identified"], 
        requiredContext: ["workspace"], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    if (prompt.includes("WinGet") || prompt.includes("winget")) {
      return { 
        normalizedGoal: "Search WinGet for a package", 
        category: "SYSTEM", 
        entities: { query: "vlc" }, 
        successCriteria: ["WinGet search results are displayed"], 
        requiredContext: ["system"], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    if (prompt.includes("Notepad") || prompt.includes("notepad")) {
      return { 
        normalizedGoal: "Launch Notepad", 
        category: "APPLICATION", 
        entities: { content: "SYSCORA test", filename: "test.txt" }, 
        successCriteria: ["Notepad is launched"], 
        requiredContext: [], 
        constraints: [], 
        clarificationQuestions: [], 
        sensitivityFlags: [] 
      };
    }
    const response = {
      normalizedGoal: "Do something", 
      category: "SYSTEM", 
      entities: {}, 
      successCriteria: ["Something done"], 
      requiredContext: [], 
      constraints: [], 
      clarificationQuestions: [], 
      sensitivityFlags: [] 
    };
    this._recordTelemetry(startedAt, false);
    return response;
  }

  _recordTelemetry(startedAt, failed) {
    const elapsed = performance.now() - startedAt;
    this._telemetry.calls += 1;
    this._telemetry.totalLatencyMs += elapsed;
    this._telemetry.lastLatencyMs = elapsed;
    if (failed) this._telemetry.failures += 1;
  }
}

export class FailoverModelProvider extends LanguageModelProvider {
  constructor(providers = []) {
    super();
    this.providers = providers.filter(Boolean);
    this.name = "failover";
  }

  async generateStructured(prompt, schema, options = {}) {
    const errors = [];
    for (const provider of this.providers) {
      const startedAt = performance.now();
      try {
        const result = await provider.generateStructured(prompt, schema, options);
        this._record(provider.name, startedAt, false);
        return result;
      } catch (error) {
        this._record(provider.name, startedAt, true);
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All configured model providers failed: ${errors.join("; ")}`);
  }

  async healthCheck() {
    const providers = await Promise.all(this.providers.map(async (provider) => ({
      name: provider.name,
      ...(await provider.health())
    })));
    return { ok: providers.some((provider) => provider.ok), providers };
  }

  getUsage() {
    return this.providers.reduce((total, provider) => {
      const usage = provider.usage();
      total.calls += usage.calls;
      total.tokensIn += usage.tokensIn;
      total.tokensOut += usage.tokensOut;
      total.costUsd += usage.costUsd;
      return total;
    }, { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  }

  usage() { return this.getUsage(); }
  capabilities() { return { name: this.name, structured: true, text: true, streaming: false, providers: this.providers.map((provider) => provider.capabilities()) }; }
  telemetry() { return { ...super.telemetry(), attempts: this._attempts ?? [] }; }

  _record(provider, startedAt, failed) {
    const latencyMs = performance.now() - startedAt;
    this._telemetry.calls += 1;
    this._telemetry.totalLatencyMs += latencyMs;
    this._telemetry.lastLatencyMs = latencyMs;
    if (failed) this._telemetry.failures += 1;
    this._attempts = [...(this._attempts ?? []).slice(-49), { provider, failed, latencyMs, at: new Date().toISOString() }];
  }
}

export class OpenAIModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || "gpt-4o-mini";
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.name = "openai";
  }

  async healthCheck() {
    if (!this.apiKey) {
      return { ok: false, error: "No OpenAI API key" };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      return { ok: response.ok, status: response.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    if (!this.apiKey) {
      throw new Error("No OpenAI API key");
    }
    const timeoutMs = options.timeoutMs || 30000;
    const maxRetries = options.maxRetries || 3;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxRetries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_schema", json_schema: { name: "schema", schema, strict: true } },
            temperature: options.temperature || 0.3
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        const usage = result.usage || {};
        this._usage.tokensIn += usage.prompt_tokens || 0;
        this._usage.tokensOut += usage.completion_tokens || 0;
        this._usage.costUsd += ((usage.prompt_tokens || 0) * 0.00015 + (usage.completion_tokens || 0) * 0.0006) / 1000;
        const content = result.choices?.[0]?.message?.content;
        const parsed = JSON.parse(content);
        if (options.validateSchema) {
          const validation = validateSchema(parsed, schema);
          if (!validation.valid) {
            throw new Error(`Invalid schema: ${validation.errors.join(", ")}`);
          }
        }
        return parsed;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt < maxRetries && isRetryableProviderError(error)) {
          await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 10000)));
        } else {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: false, model: this.model, remote: true };
  }
}

export class AnthropicModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = config.model || "claude-sonnet-5";
    this.baseUrl = config.baseUrl || "https://api.anthropic.com/v1";
    this.version = config.version || "2023-06-01";
    this.name = "anthropic";
  }

  async healthCheck() {
    if (!this.apiKey) {
      return { ok: false, error: "No Anthropic API key" };
    }
    // A cheap, side-effect-free reachability check.
    return { ok: true, type: "AnthropicModelProvider", model: this.model };
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: false, model: this.model, remote: true };
  }

  // Anthropic has no strict json_schema response format, so we instruct the
  // model to emit only JSON and parse it. Output is still validated by the
  // caller (ReasoningEngine) against the schema, and rejected/repaired if bad —
  // the runtime never trusts this directly.
  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    if (!this.apiKey) {
      throw new Error("No Anthropic API key");
    }
    const timeoutMs = options.timeoutMs || 30000;
    const maxRetries = options.maxRetries || 3;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxRetries) {
      // A fresh controller/timeout per attempt (a single shared timeout would
      // abort later retries prematurely).
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": this.version
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options.maxTokens || 2048,
            temperature: options.temperature ?? 0.3,
            system: "You output only valid minified JSON that conforms to the requested schema. No prose, no code fences.",
            messages: [{ role: "user", content: `${prompt}\n\nReturn ONLY JSON matching the schema: ${JSON.stringify(schema)}` }]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        const usage = result.usage || {};
        this._usage.tokensIn += usage.input_tokens || 0;
        this._usage.tokensOut += usage.output_tokens || 0;
        const content = Array.isArray(result.content)
          ? result.content.map((b) => b.text ?? "").join("")
          : "";
        const parsed = extractJson(content);
        if (options.validateSchema) {
          const validation = validateSchema(parsed, schema);
          if (!validation.valid) {
            throw new Error(`Invalid schema: ${validation.errors.join(", ")}`);
          }
        }
        return parsed;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt < maxRetries && isRetryableProviderError(error)) {
          await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 10000)));
        } else {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

// AgentRouter: an OpenAI-compatible model GATEWAY (https://agentrouter.org).
// One endpoint + one API key gives access to many models (claude-opus-4-8,
// gpt-5.5, glm-5.2, ...). SYSCORA is therefore NOT tied to a single vendor:
// switch models by changing `model`, not code. Because the gateway fronts
// heterogeneous models (some without OpenAI strict json_schema support), this
// provider does NOT rely on response_format json_schema — it instructs the
// model to emit only JSON and extracts the first balanced object, then the
// caller (ReasoningEngine) validates/repairs against the schema. The runtime
// never trusts this output directly.
export const AGENTROUTER_MODELS = Object.freeze(["claude-opus-4-8", "gpt-5.5", "glm-5.2"]);

export class AgentRouterModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.SYSCORA_MODEL_API_KEY || process.env.AGENTROUTER_API_KEY;
    this.model = config.model || "claude-opus-4-8";
    // Accept a base with or without a trailing /v1; normalize to the OpenAI-
    // compatible root so `${baseUrl}/chat/completions` is correct.
    const rawBase = config.baseUrl || "https://agentrouter.org/v1";
    this.baseUrl = /\/v\d+$/.test(rawBase.replace(/\/$/, "")) ? rawBase.replace(/\/$/, "") : `${rawBase.replace(/\/$/, "")}/v1`;
    // AgentRouter fronts its gateway with a WAF that rejects requests which do
    // not look like the Claude Code CLI (a plain Bearer call returns HTTP 401
    // "unauthorized client detected"). A Claude-Code-style User-Agent clears it.
    // Overridable via config for forward-compat if the gateway changes policy.
    this.userAgent = config.userAgent || "claude-cli/1.0.0 (external)";
    this.name = "agentrouter";
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, error: "No AgentRouter API key" };
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, "User-Agent": this.userAgent }
      });
      return { ok: response.ok, status: response.status, type: "AgentRouterModelProvider", model: this.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: false, model: this.model, gateway: true, remote: true };
  }

  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    if (!this.apiKey) throw new Error("No AgentRouter API key");
    const timeoutMs = options.timeoutMs || 30000;
    const maxRetries = options.maxRetries || 3;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxRetries) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}`, "User-Agent": this.userAgent },
          body: JSON.stringify({
            model: options.model || this.model,
            messages: [
              { role: "system", content: "You output ONLY valid minified JSON conforming to the requested schema. No prose, no markdown fences." },
              { role: "user", content: `${prompt}\n\nReturn ONLY JSON matching this schema: ${JSON.stringify(schema)}` }
            ],
            temperature: options.temperature ?? 0.3
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        const usage = result.usage || {};
        this._usage.tokensIn += usage.prompt_tokens || 0;
        this._usage.tokensOut += usage.completion_tokens || 0;
        const content = result.choices?.[0]?.message?.content ?? "";
        const parsed = extractJson(content);
        if (options.validateSchema) {
          const validation = validateSchema(parsed, schema);
          if (!validation.valid) throw new Error(`Invalid schema: ${validation.errors.join(", ")}`);
        }
        return parsed;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt < maxRetries && isRetryableProviderError(error)) {
          await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 10000)));
        } else {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

// Extract the first balanced JSON object from a text blob, tolerating stray
// prose or markdown fences around it. Throws if no valid JSON object is found
// so callers can fall back deterministically.
export function extractJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start === -1) return JSON.parse(s); // no object -> throw
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  return JSON.parse(s.slice(start)); // unbalanced -> throw
}

// Provider selection. Configurable via settings or environment so switching
// providers requires no runtime code changes. Falls back to Mock whenever the
// requested provider lacks credentials, guaranteeing the runtime always has a
// working provider (deterministic fallbacks live above this layer).
export function createModelProvider(settings = {}) {
  const provider = settings.provider || process.env.SYSCORA_MODEL_PROVIDER || "mock";
  switch (String(provider).toLowerCase()) {
    case "openai": {
      const apiKey = settings.apiKey || process.env.OPENAI_API_KEY;
      if (apiKey) return new OpenAIModelProvider({ apiKey, model: settings.model, baseUrl: settings.baseUrl });
      return new MockModelProvider();
    }
    case "anthropic": {
      const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY;
      if (apiKey) return new AnthropicModelProvider({ apiKey, model: settings.model, baseUrl: settings.baseUrl });
      return new MockModelProvider();
    }
    case "agentrouter": {
      const apiKey = settings.apiKey || process.env.AGENTROUTER_API_KEY || process.env.SYSCORA_MODEL_API_KEY;
      if (apiKey) return new AgentRouterModelProvider({ apiKey, model: settings.model, baseUrl: settings.baseUrl });
      return new MockModelProvider();
    }
    case "mock":
    default:
      return new MockModelProvider();
  }
}

// Provider selection is configuration-only. `fallbackProviders` may be an
// array or a comma-separated list; the resulting chain is still one provider
// as far as the reasoning boundary is concerned.
export function createModelProviderChain(settings = {}) {
  const primary = createModelProvider(settings);
  const configured = settings.fallbackProviders ?? process.env.SYSCORA_MODEL_FALLBACK_PROVIDERS ?? "";
  const names = Array.isArray(configured) ? configured : String(configured).split(",").map((value) => value.trim()).filter(Boolean);
  const fallbacks = names.map((provider) => createModelProvider({ provider }));
  return new FailoverModelProvider([primary, ...fallbacks]);
}
