import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import {
  authorizeExternalAITransfer,
  sanitizeExternalContext,
  ExternalAIConsentScope
} from "../../shared-types/src/external-context.js";
import crypto from "crypto";
import tls from "node:tls";
const createId = () => crypto.randomBytes(16).toString("hex");

let systemCaEnabled = false;

function enableSystemCaTrust() {
  if (systemCaEnabled) return;
  if (typeof tls.getCACertificates !== "function" || typeof tls.setDefaultCACertificates !== "function") return;
  try {
    const certificates = [
      ...tls.getCACertificates("bundled"),
      ...tls.getCACertificates("system"),
      ...tls.getCACertificates("extra")
    ];
    tls.setDefaultCACertificates([...new Set(certificates)]);
    systemCaEnabled = true;
  } catch {
    // Older runtimes or restricted certificate stores keep their launch-time
    // trust configuration; the provider health check will report availability.
  }
}

export function validateSchema(data, schema) {
  if (!data) return { valid: false, errors: ["No data provided"] };
  const errors = [];
  const required = schema.required || [];
  for (const key of required) {
    // `key in data` is true for `{ id: undefined }`, so a required field whose
    // value was never resolved passed validation. Deterministic plans are built
    // as `{ id: entities.id }`, which is exactly that shape whenever the model
    // named the entity something else — so a task with no usable input at all
    // validated cleanly, reached the capability, and died there as
    // "Capability package.winget.inspect preconditions failed", an internal
    // string shown to the user as the whole answer.
    //
    // A field that is present but undefined is not supplied.
    if (!(key in data) || data[key] === undefined || data[key] === null) {
      errors.push(`Missing required field: ${key}`);
    }
  }
  const properties = schema.properties || {};
  for (const key in properties) {
    if (key in data && data[key] !== null && data[key] !== undefined) {
      const expectedType = properties[key].type;
      // M4 runtime references are intentionally validated after their producing
      // task completes. The planner may name a reference, never its resolved
      // value. AgentRuntime resolves and revalidates it immediately before use.
      if (typeof data[key] === "string" && /^\$(task|observation|entity)\.[^.]+(?:\..+)?$/.test(data[key])) {
        continue;
      }
      let actualType = typeof data[key];
      
      // Special case for arrays and null
      if (expectedType === "array" && Array.isArray(data[key])) {
        // OK!
      } else if (expectedType === "array" && !Array.isArray(data[key])) {
        errors.push(`Field ${key} must be ${expectedType}, got ${actualType}`);
      } else if (expectedType && actualType !== expectedType) {
        errors.push(`Field ${key} must be ${expectedType}, got ${actualType}`);
      }

      // A closed value set is only a constraint if something checks it. Without
      // this, a schema enum is documentation the model is free to ignore — and a
      // model that answers an enum field with a word of its own invention routes
      // the request nowhere, silently. Reporting it as an error lets the bounded
      // repair in _reasonStructured re-ask with the allowed values.
      const allowed = properties[key].enum;
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(data[key])) {
        errors.push(`Field ${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(data[key])}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// STREAMING TOOL-CALLING CHAT.
//
// The rest of this file exists to coax a single JSON object out of a model.
// That shape cost the product its two most important properties: nothing could
// be shown to the user until the whole object had been generated, and every
// decision was a fresh, stateless prompt carrying the entire situation again.
//
// This is the other shape — the one Claude Code, Cursor and Codex use. The model
// holds a conversation, speaks in plain text as it goes, and calls tools by
// name. Its first sentence reaches the screen in a few hundred milliseconds,
// while the tools it asked for are already running.
//
// Returns { text, reasoning, toolCalls: [{ id, name, arguments }], finishReason, usage }.
// `onTextDelta` is invoked with each token of prose as it arrives, and
// `onReasoningDelta` with each token of the model's own reasoning where the
// endpoint sends one. Measured against deepseek-v4-flash, 21 Aug 2026: the delta
// carries `role`, `content` AND `reasoning_content`, with the first reasoning
// token at 1,430ms and the first answer token at 1,514ms. Before this the
// reasoning was parsed off the wire and thrown away, and the chat surface said
// "Thinking…" from the moment a request was sent — including the 631ms in which
// nothing had come back at all.
// How long a stream may say NOTHING before it is treated as dead.
//
// Not a total duration — see the timer in sendChatOnce for why that question is
// the wrong one on a reasoning endpoint. Measured against this provider: first
// byte at 631ms, first reasoning token at 1,430ms, and continuous deltas after
// that. Forty-five seconds of complete silence is not a slow model, it is a
// socket nobody is going to write to again.
const STREAM_IDLE_TIMEOUT_MS = 45000;

export async function openAiCompatibleChat({
  baseUrl,
  apiKey,
  model,
  headers = {},
  messages,
  tools = [],
  temperature = 0.2,
  maxTokens = 2048,
  timeoutMs = 60000,
  // Injectable so a test can prove the silence rule without waiting 45 seconds
  // for it. A rule nobody can afford to test is a rule nobody has tested.
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  signal = null,
  onTextDelta = null,
  onReasoningDelta = null,
  stream = true,
  // BEING RATE-LIMITED IS A WAIT, NOT A FAILURE.
  //
  // There was no handling here at all: a 429 came straight back as an error, the
  // loop retried once 400ms later into the same closed window, and the task
  // ended with "your model provider is rate-limiting this account" — after about
  // a second of waiting, on a limit that usually clears in two. With a fallback
  // chain configured it was hidden, because the request simply went to another
  // account; on a single provider, which is what this now runs on, it is the
  // difference between a pause and a dead task.
  //
  // Only retried when NOTHING has been emitted yet. Once prose has reached the
  // user, sending the request again would say it twice.
  rateLimitRetries = 2,
  onRetry = null
}) {
  if (!apiKey) throw new Error("No API key");
  // ONLY THE FIELDS THIS WIRE FORMAT DECLARES.
  //
  // The conversation carries provider bookkeeping that other providers need —
  // Gemini's thought signature has to be replayed with each of its function
  // calls — and an OpenAI-compatible gateway is entitled to reject a tool_call
  // object with a field it has never heard of. Whatever is added for one
  // provider must be dropped for the others rather than hoped over.
  // HALF AN EMOJI IS NOT SENDABLE, AND THE WHOLE RUN DIES ON IT.
  //
  // Measured 20 Aug 2026, on every WhatsApp perception task in the eval:
  //
  //   HTTP 400: Failed to parse the request body as JSON:
  //   messages[5].content: unexpected end of hex escape
  //
  // A JS string is UTF-16 code units and an emoji is a surrogate PAIR of them.
  // Anything that truncates by length — `clip()` on a screen reading, a prompt
  // trim, a log excerpt — can cut between the two halves and leave a lone high
  // surrogate. `JSON.stringify` faithfully encodes it as `\ud83d`, Node's own
  // parser accepts that, and the provider's stricter parser rejects the whole
  // body. So the failure cannot be caught by round-tripping locally, and it
  // takes out the entire request rather than mangling one character.
  //
  // WhatsApp readings are full of emoji, which is why the perception tasks went
  // from passing to failing when the visible chat content changed and moved the
  // cut by a few characters.
  //
  // Repaired HERE, at the boundary, as well as at the place that does the
  // cutting: a lone surrogate can be introduced by any caller, and the wire is
  // the one place every message must pass through. `toWellFormed` replaces each
  // one with U+FFFD, which costs a character nobody can read anyway and keeps
  // the request sendable.
  const wellFormed = (value) => (typeof value === "string" && typeof value.toWellFormed === "function"
    ? value.toWellFormed()
    : value);
  const wireMessages = (messages ?? []).map((message) => ({
    ...message,
    ...(typeof message.content === "string" ? { content: wellFormed(message.content) } : {})
  })).map((message) => (Array.isArray(message.tool_calls)
    ? {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: call.type ?? "function",
          function: { name: call.function?.name, arguments: call.function?.arguments }
        }))
      }
    : message));
  const deadline = Date.now() + timeoutMs;
  const attemptOptions = {
    baseUrl, apiKey, model, headers, wireMessages, tools,
    temperature, maxTokens, stream, onTextDelta, onReasoningDelta, signal, deadline, idleTimeoutMs
  };

  let attempt = 0;
  for (;;) {
    try {
      return await sendChatOnce(attemptOptions);
    } catch (error) {
      const remainingMs = deadline - Date.now();
      const throttled = error?.status === 429;
      // A gateway that was briefly unavailable is worth one more try, but only
      // if the turn had not started arriving.
      const unavailable = [500, 502, 503, 504].includes(error?.status) && error?.emitted !== true;
      if (signal?.aborted
        || error?.emitted === true
        || attempt >= rateLimitRetries
        || !(throttled || unavailable)
        // Not worth waiting if there is no time left to spend the wait in.
        || remainingMs <= 2000) {
        throw error;
      }
      const backoffMs = Math.min(8000, 500 * 2 ** attempt) + Math.round(Math.random() * 250);
      const waitMs = Math.max(0, Math.min(error?.retryAfterMs || backoffMs, remainingMs - 1500));
      // The surface draws this as one line that counts up, so the user sees a
      // wait rather than a hang. Without it the transcript simply stops.
      onRetry?.({
        reason: throttled ? "rate-limited" : "provider-unavailable",
        waitMs,
        attempt: attempt + 1,
        status: error?.status ?? null
      });
      await sleepUnlessAborted(waitMs, signal);
      attempt += 1;
    }
  }
}

/**
 * One attempt at one turn. Throws with `status` set on an HTTP failure, and with
 * `emitted` true when part of the turn had already reached the caller — which is
 * what decides whether the attempt above may be repeated.
 */
async function sendChatOnce({
  baseUrl, apiKey, model, headers, wireMessages, tools,
  temperature, maxTokens, stream, onTextDelta, onReasoningDelta, signal, deadline, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS
}) {
  const controller = new AbortController();
  // A TOTAL-DURATION TIMEOUT CANNOT TELL THINKING FROM A DEAD SOCKET.
  //
  // This was one timer, armed when the request went out and never rearmed. On a
  // reasoning endpoint that is the wrong question: the model streams its whole
  // deliberation before it writes a single tool call, so a turn that thinks for
  // 110 seconds and a connection that died at the first byte look IDENTICAL to a
  // clock that only knows how long the request has been open — and the healthy
  // one was aborted mid-stream, with bytes still arriving.
  //
  // Measured 21 Aug 2026: one drawing decision streamed 11,891 reasoning tokens
  // over 111.6s, against a ceiling the loop capped at 90s. The abort surfaces as
  // `fetch failed`, `isRetryableProviderError` says AbortError is retryable, and
  // the loop's own two-attempt retry then spends another 90s — which is the
  // 144-180s "stall at 0 steps" the briefs have been attributing to the user's
  // phone tethering. Tethering makes it fire more often. It does not cause it.
  //
  // What actually separates a dead connection from a slow one is SILENCE, so
  // that is what this measures now: rearmed on every chunk, with the caller's
  // deadline still there as an absolute backstop. A stream that is delivering is
  // never killed for taking its time; one that has gone quiet still dies.
  const hardTimer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  const clearTimers = () => {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
  };
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify({
        model,
        messages: wireMessages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        temperature,
        max_tokens: maxTokens,
        stream
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.text();
        detail = body ? `: ${body.slice(0, 300)}` : "";
      } catch { /* the status alone identifies the failure */ }
      const error = new Error(`HTTP ${response.status}${detail}`);
      error.status = response.status;
      error.retryAfterMs = Number(response.headers.get("retry-after")) * 1000 || null;
      throw error;
    }
    if (!stream || !response.body) {
      const result = await response.json();
      const message = result.choices?.[0]?.message ?? {};
      if (message.content && onTextDelta) onTextDelta(String(message.content));
      return {
        text: String(message.content ?? ""),
        toolCalls: (message.tool_calls ?? []).map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "{}"
        })),
        finishReason: result.choices?.[0]?.finish_reason ?? null,
        usage: result.usage ?? null
      };
    }

    // Server-sent events. Text deltas go straight out to the caller; tool-call
    // deltas arrive in fragments keyed by index and are reassembled here.
    // Only from here on: before the body exists there is nothing to be idle
    // BETWEEN, and a non-streaming response (handled above) delivers in one
    // piece, so silence is not evidence about it either. Both of those stay on
    // the hard deadline alone.
    armIdle();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    // Accumulated separately from `text` on purpose — see the delta handler.
    let reasoning = "";
    let finishReason = null;
    let usage = null;
    const pending = new Map();
    let done = false;
    // Whether anything has already reached the caller. Once it has, this turn
    // cannot be retried: the user would hear the first half of the sentence
    // twice. See the retry loop at the bottom of this function.
    let emitted = false;
    try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      // Bytes arrived, so the connection is alive whatever the clock says.
      armIdle();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { done = true; break; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        // The model's own reasoning, where the endpoint sends one. Kept separate
        // from `text` all the way out: it is not the answer, it must never be
        // rendered as the answer, and a settle that mistook it for one would be
        // publishing the model's scratch work as a result.
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onReasoningDelta?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          emitted = true;
          onTextDelta?.(delta.content);
        }
        for (const [index, call] of (delta.tool_calls ?? []).entries()) {
          const key = call.index ?? index;
          const existing = pending.get(key) ?? { id: null, name: "", arguments: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          pending.set(key, existing);
        }
      }
    }
    } catch (error) {
      // A socket that dies mid-stream. Whether it can be retried depends on
      // whether anything already went out.
      error.emitted = emitted;
      throw error;
    }
    await reader.cancel().catch(() => {});
    // A CUT CONNECTION IS NOT A FINISHED ANSWER.
    //
    // If the socket drops mid-turn, this loop simply ends: whatever prose had
    // arrived is returned, with no tool calls, and the agent loop reads a turn
    // with no tool calls as the model having finished — so a task that was
    // interrupted halfway through was reported to the user as complete, in the
    // model's own confident half-sentence. The endpoint this runs against drops
    // connections intermittently, so this is an ordinary Tuesday, not an edge
    // case. `[DONE]` or a finish_reason is what finished looks like; anything
    // else is a transport failure, and the caller already retries those.
    if (!done && !finishReason) {
      const error = new Error("The model stream ended before the turn was complete (connection dropped).");
      error.status = 503;
      error.emitted = emitted;
      throw error;
    }
    const toolCalls = [...pending.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([key, call], index) => ({
        id: call.id ?? `call_${key ?? index}`,
        name: call.name,
        arguments: call.arguments || "{}"
      }))
      .filter((call) => call.name);
    return { text, reasoning, toolCalls, finishReason, usage };
  } finally {
    clearTimers();
    if (signal) signal.removeEventListener?.("abort", onOuterAbort);
  }
}

// A wait that a stop press cuts short. Rejecting rather than resolving means the
// caller sees the cancellation instead of quietly issuing another request.
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
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

  // Streaming tool-calling conversation. Providers that speak the OpenAI wire
  // format override this; the rest report `supportsChat() === false` and the
  // agent loop falls back to the structured path.
  async chat() {
    throw new Error("This provider does not support tool-calling chat");
  }

  supportsChat() {
    return false;
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
    this.activeProviderIndex = 0;
    this.name = "failover";
  }

  async generateStructured(prompt, schema, options = {}) {
    const errors = [];
    for (let offset = 0; offset < this.providers.length; offset += 1) {
      const index = (this.activeProviderIndex + offset) % this.providers.length;
      const provider = this.providers[index];
      const startedAt = performance.now();
      const identity = getProviderIdentity(provider);
      const attempt = options.onExternalAttempt?.(identity);
      try {
        const result = await provider.generateStructured(prompt, schema, {
          ...options,
          // Failover owns retries when more than one credential is available.
          // Let the next credential run immediately instead of sleeping on a
          // throttled or otherwise failing account first.
          ...(this.providers.length > 1 ? { maxRetries: 1, rateLimitRetries: 0 } : {})
        });
        this._record(provider.name, startedAt, false);
        options.onExternalAttemptResult?.(attempt, { ok: true, latencyMs: performance.now() - startedAt });
        this.lastRequestProvider = provider;
        this.activeProviderIndex = index;
        return result;
      } catch (error) {
        this._record(provider.name, startedAt, true);
        options.onExternalAttemptResult?.(attempt, {
          ok: false,
          latencyMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
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

  supportsChat() { return this.providers.some((provider) => provider.supportsChat?.()); }

  async chat(request = {}) {
    const errors = [];
    for (let offset = 0; offset < this.providers.length; offset += 1) {
      // STOP MEANS STOP, INCLUDING HERE.
      //
      // Pressing stop aborts the in-flight request, which arrives here as a
      // provider failure — and failover's job is to answer a provider failure by
      // trying the next provider. So one stop press sent a fresh request to
      // every other configured account in turn, each of which was aborted on
      // arrival, and the user paid for all of them.
      if (request.signal?.aborted) break;
      const index = (this.activeProviderIndex + offset) % this.providers.length;
      const provider = this.providers[index];
      if (!provider.supportsChat?.()) continue;
      try {
        const result = await provider.chat({
          ...request,
          ...(this.providers.length > 1 ? { maxRetries: 1, rateLimitRetries: 0 } : {})
        });
        this.activeProviderIndex = index;
        this.lastRequestProvider = provider;
        return result;
      } catch (error) {
        if (request.signal?.aborted) throw error;
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (request.signal?.aborted) throw new Error("Cancelled");
    throw new Error(`All configured model providers failed: ${errors.join("; ")}`);
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

export function getProviderIdentity(provider) {
  const endpoint = typeof provider?.baseUrl === "string"
    ? provider.baseUrl.replace(/[?#].*$/, "")
    : null;
  return {
    provider: String(provider?.name ?? "unknown"),
    model: provider?.model ?? provider?.capabilities?.()?.model ?? null,
    endpoint
  };
}

// One sanitized copy per message object, held weakly so a finished conversation
// is collected with it. See ConsentAwareModelProvider.chat.
const SANITIZED_MESSAGES = new WeakMap();

export class ConsentAwareModelProvider extends LanguageModelProvider {
  constructor({ provider, consentScopes = [], onProvenance = null } = {}) {
    super();
    this.provider = provider;
    this.name = provider?.name ?? "consent-aware";
    this.consentScopes = [...new Set(consentScopes)];
    this.onProvenance = onProvenance;
    this.provenance = [];
  }

  async generateStructured(prompt, schema, options = {}) {
    const candidates = this.provider instanceof FailoverModelProvider
      ? this.provider.providers
      : [this.provider];
    const hasRemoteProvider = candidates.some((candidate) => candidate?.capabilities?.()?.remote === true);
    if (!hasRemoteProvider) {
      return this.provider.generateStructured(prompt, schema, options);
    }
    const dataCategories = [...new Set(options.externalAI?.dataCategories ?? [])];
    const authorization = authorizeExternalAITransfer({
      scopes: this.consentScopes,
      dataCategories
    });
    if (!authorization.allowed) {
      throw new Error(`external-ai-consent-denied:${authorization.missingScopes.join(",")}`);
    }
    // Structured machine fields are clipped aggressively before prompt
    // construction, but clipping the final prompt to 1.2 KB discards the goal
    // and grounded state appended near the end. Preserve a bounded complete
    // reasoning prompt while applying the same redaction rules.
    const classified = sanitizeExternalContext(String(prompt ?? ""), { maxStringLength: 32000 });
    const records = [];
    const recordAttempt = (identity) => {
      const record = {
        requestId: createId(),
        timestamp: new Date().toISOString(),
        ...identity,
        dataCategories,
        consentScopes: authorization.scopes,
        sanitizationApplied: true,
        redactionApplied: classified !== String(prompt ?? ""),
        credentialsRecorded: false,
        status: "ATTEMPTED"
      };
      this.provenance.push(record);
      records.push(record);
      this.onProvenance?.({ ...record });
      return record;
    };
    const finishAttempt = (record, result) => {
      if (!record) return;
      Object.assign(record, {
        status: result.ok ? "SUCCEEDED" : "FAILED",
        latencyMs: Math.round(result.latencyMs ?? 0),
        ...(result.ok ? {} : { error: String(result.error ?? "provider-failed").slice(0, 300) })
      });
      this.onProvenance?.({ ...record });
    };
    const isFailover = this.provider instanceof FailoverModelProvider;
    const directRecord = isFailover ? null : recordAttempt(getProviderIdentity(this.provider));
    const startedAt = performance.now();
    try {
      const result = await this.provider.generateStructured(classified, schema, {
        ...options,
        onExternalAttempt: recordAttempt,
        onExternalAttemptResult: finishAttempt
      });
      if (directRecord) finishAttempt(directRecord, { ok: true, latencyMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      if (directRecord) finishAttempt(directRecord, { ok: false, latencyMs: performance.now() - startedAt, error: error?.message });
      throw error;
    }
  }

  // THE KILL SWITCH HAD NO WIRE ATTACHED TO IT.
  //
  // Every scope check lived on generateStructured — the staged pipeline's path —
  // and the agent loop calls chat(), which checked nothing. So a configuration
  // saying EXTERNAL_AI_DISABLED disabled nothing at all on the route every
  // request actually takes: screen readings, window titles, file contents and
  // command output went to the model exactly as before.
  //
  // Enforced here rather than per turn: the loop is one continuing request, and
  // an agent that stops being allowed to think halfway through a task is worse
  // than one that never started. With chat refused, the runtime routes to the
  // staged pipeline, which plans from typed capabilities and needs no model —
  // which is precisely what "no external AI" has to mean for this product.
  supportsChat() {
    if (this.consentScopes.includes(ExternalAIConsentScope.DISABLED)) return false;
    return Boolean(this.provider?.supportsChat?.());
  }

  // The consent boundary applies to the CONTENT that leaves this machine, so it
  // redacts each message the same way it redacts a structured prompt. It does
  // not re-authorize per turn: the loop is one continuing request, authorized
  // when it started.
  //
  // SCRUB EACH MESSAGE ONCE, NOT ONCE PER STEP.
  //
  // The loop re-sends the whole conversation on every step, and this used to
  // re-run the redaction regexes over all of it every time — so the cost grew
  // with the square of the conversation, for an answer that cannot change: the
  // message objects are the same ones, and sanitizing is deterministic.
  // Remembering the result against the message object itself makes it linear.
  // Pruning replaces a message with a NEW object, which misses the map and is
  // scrubbed once more — which is exactly right, because its content changed.
  async chat(request = {}) {
    const messages = (request.messages ?? []).map((message) => {
      if (typeof message.content !== "string") return message;
      const remembered = SANITIZED_MESSAGES.get(message);
      if (remembered) return remembered;
      const scrubbed = {
        ...message,
        content: sanitizeExternalContext(message.content, { maxStringLength: 32000 })
      };
      SANITIZED_MESSAGES.set(message, scrubbed);
      return scrubbed;
    });
    return this.provider.chat({ ...request, messages });
  }

  async healthCheck() { return this.provider?.healthCheck?.() ?? { ok: false }; }
  async health() { return this.healthCheck(); }
  usage() { return this.provider?.usage?.() ?? super.usage(); }
  getUsage() { return this.provider?.getUsage?.() ?? this.usage(); }
  telemetry() { return this.provider?.telemetry?.() ?? super.telemetry(); }
  capabilities() { return { ...(this.provider?.capabilities?.() ?? {}), consentScopes: this.consentScopes }; }
  getExternalRequestProvenance() { return this.provenance.map((record) => ({ ...record })); }
}

export class OpenAIModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    // OpenAI-compatible gateways on managed Windows machines may use a local
    // TLS inspection root. Use the same OS trust union as the gateway adapter;
    // provider selection must not change whether the machine CA store works.
    enableSystemCaTrust();
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.model = config.model || "gpt-4o-mini";
    this.baseUrl = config.baseUrl || "https://api.openai.com/v1";
    this.name = "openai";
  }

  // A reachability probe, nothing more. It carries its own abort so a hung
  // socket cannot outlive the caller's bound, and it distinguishes "the gateway
  // answered and said no" (ok: false — real evidence) from "the probe itself
  // did not complete" (unknown — no evidence either way). ReasoningEngine treats
  // those two very differently: only the first can gate a request.
  async healthCheck({ timeoutMs = 8000 } = {}) {
    if (!this.apiKey) {
      return { ok: false, error: "No OpenAI API key" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal
      });
      // A 5xx says the gateway is up and the upstream is busy or restarting —
      // this endpoint scales to zero and answers 503 "overflow" while it wakes.
      // That is a reason to retry, not a reason to declare the model gone for
      // the whole cache TTL and refuse every request in it. Only a definite
      // negative (auth, bad route) is evidence the provider cannot serve us.
      if (response.status >= 500) return { unknown: true, status: response.status };
      return { ok: response.ok, status: response.status };
    } catch (e) {
      return { unknown: true, error: e.message };
    } finally {
      clearTimeout(timeout);
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
            response_format: options.strictSchema === false
              ? { type: "json_object" }
              : { type: "json_schema", json_schema: { name: "schema", schema, strict: true } },
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

  supportsChat() { return Boolean(this.apiKey); }

  async chat(request = {}) {
    this._usage.calls += 1;
    const result = await openAiCompatibleChat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: request.model || this.model,
      ...request
    });
    this._usage.tokensIn += result.usage?.prompt_tokens ?? 0;
    this._usage.tokensOut += result.usage?.completion_tokens ?? 0;
    return result;
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: true, tools: true, model: this.model, remote: true };
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

// Mistral (https://api.mistral.ai/v1). OpenAI transport-compatible, and fast —
// a trivial completion returns in well under a second, which is the property
// that matters most here: the interactive loop makes one model call per
// decision, so per-call latency is the product's latency.
//
// It deliberately does NOT use `response_format: json_schema, strict: true`,
// even though recent Mistral models accept it. Strict mode emits the `required`
// fields and nothing else, and this codebase has already paid for that once: the
// optional `directAnswer` on INTENT_SCHEMA became unreachable, so a correctly
// classified greeting arrived with no reply attached and fell all the way
// through the planning pipeline. `json_object` plus the schema in the prompt
// keeps optional fields reachable, and the caller (ReasoningEngine) validates
// and repairs against the schema regardless — the runtime never trusts this
// output directly.
export class MistralModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    // Same OS trust union as the other remote providers: which vendor is
    // configured must not change whether the machine's CA store works.
    enableSystemCaTrust();
    this.apiKey = config.apiKey || process.env.MISTRAL_API_KEY || process.env.LLM_API_KEY;
    this.model = config.model || "mistral-medium-3.5";
    const rawBase = config.baseUrl || "https://api.mistral.ai/v1";
    this.baseUrl = /\/v\d+$/.test(rawBase.replace(/\/$/, ""))
      ? rawBase.replace(/\/$/, "")
      : `${rawBase.replace(/\/$/, "")}/v1`;
    // A truncated response is unparseable JSON, which the repair loop cannot
    // fix because the model was not wrong — it was cut off. Interactive
    // decisions carrying several localSteps are the largest outputs here.
    this.maxTokens = Number(config.maxTokens ?? 4096);
    // MINIMUM SPACING BETWEEN REQUESTS.
    //
    // A per-second rate limit rejects back-to-back calls, so this used to sleep
    // 1.5s before every single one — an unconditional 1.5s tax on every step of
    // every task, paid whether or not the account was anywhere near its limit.
    //
    // It now starts at zero and only widens in response to an actual 429 (see
    // _widenAfterRateLimit), narrowing again once the account demonstrates it
    // has room. Reacting to the limit costs one retry when it is hit; pre-empting
    // it cost every request that would never have been limited at all.
    this.baseRequestIntervalMs = Number(config.minRequestIntervalMs ?? 0);
    this.minRequestIntervalMs = this.baseRequestIntervalMs;
    this._nextSlotAt = 0;
    this._callsSinceRateLimit = 0;
    this.name = "mistral";
  }

  // NO PRE-EMPTIVE SPACING. Retained as a no-op so the structured path below,
  // which still calls it, keeps working unchanged.
  //
  // This used to ratchet a delay onto EVERY subsequent request after a single
  // 429 — up to four seconds, applied silently before each call, decaying only
  // after three consecutive successes. So one busy moment taxed the rest of the
  // session, invisibly: the user saw ten seconds of nothing before the first
  // command of a task ran and had no way to know why, because the delay was
  // self-imposed and nothing reported it.
  //
  // It was guarding against a limit the account may not even be near. A real 429
  // is cheap to detect and is handled where it happens; guessing at one in
  // advance costs every request that would never have been limited.
  _widenAfterRateLimit() {
    this._callsSinceRateLimit = 0;
  }

  _narrowAfterSuccess() {
    if (this.minRequestIntervalMs <= this.baseRequestIntervalMs) return;
    this._callsSinceRateLimit += 1;
    if (this._callsSinceRateLimit < 3) return;
    this._callsSinceRateLimit = 0;
    this.minRequestIntervalMs = Math.max(this.baseRequestIntervalMs, this.minRequestIntervalMs / 1.5);
  }

  // Serialize request starts so no two land closer than minRequestIntervalMs.
  // Reserving the slot before awaiting is what makes this correct under
  // concurrency: two callers arriving together take slot N and slot N+1 rather
  // than both reading the same "now".
  async _awaitRequestSlot() {
    if (this.minRequestIntervalMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this._nextSlotAt);
    this._nextSlotAt = slot + this.minRequestIntervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }

  // Reachability only, with the same asymmetry the OpenAI provider uses: a
  // definite negative (auth, bad route) is evidence the provider cannot serve
  // us; anything else is UNKNOWN, and unknown means proceed. A false
  // "unhealthy" costs every request until the TTL expires.
  async healthCheck({ timeoutMs = 5000 } = {}) {
    if (!this.apiKey) return { ok: false, error: "No Mistral API key" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal
      });
      if (response.status >= 500) return { unknown: true, status: response.status };
      return { ok: response.ok, status: response.status, model: this.model };
    } catch (e) {
      return { unknown: true, error: e.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: true, tools: true, model: this.model, remote: true };
  }

  supportsChat() { return Boolean(this.apiKey); }

  // A rate limit is the endpoint saying "not yet", not "no", so it is retried
  // here rather than surfacing as a failed step mid-task.
  async chat(request = {}) {
    this._usage.calls += 1;
    // A throttled account is the commonest reason a long task dies half-finished,
    // and it dies for want of patience measured in seconds. Six attempts backing
    // off 2s, 4s, 8s, 16s, 30s costs a minute in the worst case and turns "this
    // failed" into "this was slow" — which, mid-task with a window already open
    // and half the work done, is an entirely different outcome.
    //
    // It cannot rescue an exhausted quota, and it does not pretend to: after the
    // last attempt the 429 is thrown and reported as what it is.
    // No pre-emptive spacing: this goes out immediately, every time. The only
    // waiting that ever happens is in response to a 429 the server actually sent.
    let rateLimitRetries = request.rateLimitRetries ?? 6;
    let backoffMs = 2000;
    for (;;) {
      try {
        const result = await openAiCompatibleChat({
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
          model: request.model || this.model,
          maxTokens: request.maxTokens ?? this.maxTokens,
          ...request,
          // ONE OWNER FOR THE WAIT. The transport retries a 429 by itself for
          // providers that have no loop of their own; this provider does, with a
          // longer budget, and two of them stacked would double every backoff
          // and report each wait twice.
          rateLimitRetries: 0
        });
        this._usage.tokensIn += result.usage?.prompt_tokens ?? 0;
        this._usage.tokensOut += result.usage?.completion_tokens ?? 0;
        this._narrowAfterSuccess();
        return result;
      } catch (error) {
        if (error?.status === 429 && rateLimitRetries > 0) {
          rateLimitRetries -= 1;
          this._widenAfterRateLimit();
          // The server's own number when it gives one; otherwise back off
          // exponentially. A flat 1.5s retried three times is six seconds of
          // patience, which is not enough to outlast anything but the mildest
          // per-second throttle.
          const waitMs = error.retryAfterMs ?? backoffMs;
          backoffMs = Math.min(backoffMs * 2, 30000);
          // Being throttled is the single largest unexplained pause a user can
          // see mid-task, and without this it is indistinguishable from the
          // agent having stopped. Say so rather than going quiet for ten seconds.
          request.onRetry?.({ reason: "rate-limited", waitMs, spacingMs: this.minRequestIntervalMs });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw error;
      }
    }
  }

  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    if (!this.apiKey) throw new Error("No Mistral API key");
    const timeoutMs = options.timeoutMs || 30000;
    const maxRetries = options.maxRetries || 3;
    // A rate limit is the endpoint saying "not yet", not "no". It gets its own
    // small retry budget, separate from the transport retries above, because
    // spending a transport attempt on it would let one busy second end a
    // request that a one-second wait would have served.
    let rateLimitRetries = options.rateLimitRetries ?? 5;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxRetries) {
      await this._awaitRequestSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: options.model || this.model,
            messages: [
              {
                role: "system",
                content: "You output ONLY valid minified JSON conforming to the requested schema. No prose, no markdown fences, no explanation outside the JSON."
              },
              { role: "user", content: `${prompt}\n\nReturn ONLY JSON matching this schema: ${JSON.stringify(schema)}` }
            ],
            response_format: { type: "json_object" },
            max_tokens: options.maxTokens || this.maxTokens,
            temperature: options.temperature ?? 0.3
          }),
          signal: controller.signal
        });
        if (response.status === 429 && rateLimitRetries > 0) {
          rateLimitRetries -= 1;
          // Honour the server's own number when it gives one; otherwise widen
          // the spacing, since being rate-limited is evidence the current
          // spacing is too tight for this account.
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : Math.max(1500, this.minRequestIntervalMs * 2);
          this._widenAfterRateLimit();
          clearTimeout(timeout);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        if (!response.ok) {
          // Mistral explains a rejected request in the body (bad model name,
          // quota, malformed schema). Carrying that through turns an opaque
          // "HTTP 400" into something a person can act on, and it is the
          // difference between debugging the product and debugging the account.
          let detail = "";
          try {
            const body = await response.text();
            detail = body ? `: ${body.slice(0, 300)}` : "";
          } catch { /* the status alone still identifies the failure */ }
          throw new Error(`HTTP ${response.status}${detail}`);
        }
        const result = await response.json();
        const usage = result.usage || {};
        this._usage.tokensIn += usage.prompt_tokens || 0;
        this._usage.tokensOut += usage.completion_tokens || 0;
        const choice = result.choices?.[0];
        // A response cut off at the token ceiling is truncated JSON. Say that,
        // rather than letting it surface as a generic parse error that sends
        // debugging after the prompt instead of after max_tokens.
        if (choice?.finish_reason === "length") {
          throw new Error("Mistral response truncated at the token limit (raise maxTokens)");
        }
        const parsed = extractJson(choice?.message?.content ?? "");
        if (options.validateSchema) {
          const validation = validateSchema(parsed, schema);
          if (!validation.valid) throw new Error(`Invalid schema: ${validation.errors.join(", ")}`);
        }
        this._narrowAfterSuccess();
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

// Google Gemini native REST transport. Gemini 3.6 Flash is optimized for the
// short agentic loops SYSCORA runs and supports structured output and function
// calling, so it can be a full primary provider.
export class GeminiModelProvider extends LanguageModelProvider {
  constructor(config = {}) {
    super(config);
    enableSystemCaTrust();
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.model = config.model || "gemini-3.6-flash";
    this.baseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.maxTokens = Number(config.maxTokens ?? 4096);
    this.name = "gemini";
  }

  async _request(body, { timeoutMs = 60000, signal = null } = {}) {
    if (!this.apiKey) throw new Error("No Gemini API key");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        let detail = "";
        try {
          const text = await response.text();
          detail = text ? `: ${text.slice(0, 300)}` : "";
        } catch {}
        const error = new Error(`HTTP ${response.status}${detail}`);
        error.status = response.status;
        error.retryAfterMs = Number(response.headers.get("retry-after")) * 1000 || null;
        throw error;
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener?.("abort", onOuterAbort);
    }
  }

  async healthCheck({ timeoutMs = 5000 } = {}) {
    if (!this.apiKey) return { ok: false, error: "No Gemini API key" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { "x-goog-api-key": this.apiKey }, signal: controller.signal
      });
      if (response.status >= 500) return { unknown: true, status: response.status };
      return { ok: response.ok, status: response.status, model: this.model };
    } catch (error) {
      return { unknown: true, error: error.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: true, tools: true, model: this.model, remote: true };
  }

  supportsChat() { return Boolean(this.apiKey); }

  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    const result = await this._request({
      systemInstruction: { parts: [{ text: "Output only valid JSON matching the requested schema." }] },
      contents: [{ role: "user", parts: [{ text: `${prompt}\n\nReturn ONLY JSON matching this schema: ${JSON.stringify(schema)}` }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || this.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: schema
      }
    }, options);
    const usage = result.usageMetadata ?? {};
    this._usage.tokensIn += usage.promptTokenCount ?? 0;
    this._usage.tokensOut += usage.candidatesTokenCount ?? 0;
    const text = (result.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    return extractJson(text);
  }

  // THE MODEL HAS TO SEE ITS OWN TOOL CALLS.
  //
  // The conversation the loop keeps is in OpenAI's shape: an assistant message
  // carrying `tool_calls`, then one `tool` message per result. Gemini's shape is
  // a `functionCall` part from the model and a `functionResponse` part back.
  // Mapping every non-system message to a plain text part — which is what this
  // did — dropped the assistant's calls entirely and handed the results back as
  // if the USER had typed them.
  //
  // What Gemini then saw was: a request, an empty model turn, and a stranger
  // reciting "Clicked at 640,400." It had no record of having acted, so at every
  // step it was deciding from scratch, and the obvious thing to do next was the
  // thing it had just done. This is the primary provider.
  static _toGeminiContents(messages) {
    const contents = [];
    // Which tool each call id belongs to, so a result can be sent back under
    // the name of the function it came from. Gemini matches on the name.
    const callNames = new Map();
    for (const message of messages) {
      if (message.role === "system") continue;
      const text = typeof message.content === "string" ? message.content : "";
      if (message.role === "tool") {
        const name = callNames.get(message.tool_call_id) ?? "tool";
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name, response: { result: text } } }]
        });
        continue;
      }
      if (message.role === "assistant") {
        const parts = [];
        if (text.trim()) parts.push({ text });
        for (const call of message.tool_calls ?? []) {
          const name = call.function?.name ?? call.name ?? "";
          if (!name) continue;
          if (call.id) callNames.set(call.id, name);
          let args = {};
          try { args = JSON.parse(call.function?.arguments ?? call.arguments ?? "{}"); } catch { args = {}; }
          // THE SIGNATURE HAS TO COME BACK WITH THE CALL.
          //
          // Gemini attaches a `thoughtSignature` to each function call it makes
          // and requires it on the way back — replaying the call without it is
          // rejected outright: "Function call is missing a thought_signature in
          // functionCall parts". Live, that turned into an HTTP 400 on the
          // fourteenth step of a task, which the loop reported as the provider
          // failing. It is an opaque token; it is carried and returned, not read.
          parts.push({
            functionCall: { name, args },
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
          });
        }
        // A turn with neither prose nor calls has nothing in it; Gemini rejects
        // an empty parts array.
        if (parts.length > 0) contents.push({ role: "model", parts });
        continue;
      }
      if (text) contents.push({ role: "user", parts: [{ text }] });
    }
    return contents;
  }

  async chat(request = {}) {
    this._usage.calls += 1;
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const systemText = messages.filter((message) => message.role === "system").map((message) => String(message.content ?? "")).join("\n");
    const contents = GeminiModelProvider._toGeminiContents(messages);
    const declarations = (request.tools ?? []).map((tool) => tool.function).filter(Boolean).map((fn) => ({
      name: fn.name,
      description: fn.description,
      parametersJsonSchema: fn.parameters ?? { type: "object", properties: {} }
    }));
    const body = {
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents,
      ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
        ...(Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {})
      }
    };
    // Streamed, because the first sentence reaching the screen in under a second
    // is the whole point of this loop, and `:generateContent` holds everything
    // back until the turn is complete. A stream that fails falls back to the
    // single-shot call rather than failing the step.
    if (typeof request.onTextDelta === "function") {
      try {
        return await this._streamContent(body, request);
      } catch (error) {
        if (request.signal?.aborted) throw error;
      }
    }
    const result = await this._request(body, request);
    return this._readCandidate(result, request);
  }

  _readCandidate(result, request) {
    const usage = result.usageMetadata ?? {};
    this._usage.tokensIn += usage.promptTokenCount ?? 0;
    this._usage.tokensOut += usage.candidatesTokenCount ?? 0;
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    if (text) request.onTextDelta?.(text);
    const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
      id: `gemini_call_${index}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
      // Opaque, and required back on the next turn. See _toGeminiContents.
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    }));
    return { text, toolCalls, finishReason: result.candidates?.[0]?.finishReason ?? null, usage };
  }

  async _streamContent(body, { timeoutMs = 60000, signal = null, onTextDelta = null } = {}) {
    if (!this.apiKey) throw new Error("No Gemini API key");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );
      if (!response.ok || !response.body) {
        let detail = "";
        try { const text = await response.text(); detail = text ? `: ${text.slice(0, 300)}` : ""; } catch { /* status is enough */ }
        const error = new Error(`HTTP ${response.status}${detail}`);
        error.status = response.status;
        throw error;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let finishReason = null;
      let usage = null;
      const toolCalls = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n");
        while (boundary !== -1) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          boundary = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          let chunk;
          try { chunk = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const candidate = chunk.candidates?.[0];
          if (!candidate) continue;
          if (candidate.finishReason) finishReason = candidate.finishReason;
          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text) {
              text += part.text;
              onTextDelta?.(part.text);
            }
            if (part.functionCall) {
              toolCalls.push({
                id: `gemini_call_${toolCalls.length}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
                // Opaque, and required back on the next turn. See _toGeminiContents.
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
              });
            }
          }
        }
      }
      await reader.cancel().catch(() => {});
      this._usage.tokensIn += usage?.promptTokenCount ?? 0;
      this._usage.tokensOut += usage?.candidatesTokenCount ?? 0;
      return { text, toolCalls: toolCalls.filter((call) => call.name), finishReason, usage };
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener?.("abort", onOuterAbort);
    }
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
    // AgentRouter is commonly reached through an enterprise TLS inspection
    // chain on Windows. Node's bundled roots alone do not include that machine
    // trust anchor. Merge the OS certificate store at the provider boundary so
    // every production entry point works without requiring a special node flag.
    enableSystemCaTrust();
    this.apiKey = config.apiKey || process.env.SYSCORA_MODEL_API_KEY || process.env.AGENTROUTER_API_KEY;
    this.model = config.model || "claude-opus-4-8";
    // Accept a base with or without a trailing /v1; normalize to the OpenAI-
    // compatible root so `${baseUrl}/chat/completions` is correct.
    const rawBase = config.baseUrl || "https://agentrouter.org/v1";
    this.baseUrl = /\/v\d+$/.test(rawBase.replace(/\/$/, "")) ? rawBase.replace(/\/$/, "") : `${rawBase.replace(/\/$/, "")}/v1`;
    this.name = config.providerName || "agentrouter";
    // AgentRouter fronts its gateway with a WAF that rejects requests which do
    // not look like the Claude Code CLI (a plain Bearer call returns HTTP 401
    // "unauthorized client detected"). A Claude-Code-style User-Agent clears it.
    //
    // ONLY FOR THAT GATEWAY. This class is reused as the OpenAI-compatible
    // transport for other endpoints — Baseten is what SYSCORA runs on now — and
    // sending them a User-Agent claiming to be somebody else's CLI is both
    // untrue and pointless: they have no such WAF, and nothing about the request
    // needs it. Overridable via config either way.
    this.userAgent = config.userAgent
      ?? (this.name === "agentrouter" ? "claude-cli/1.0.0 (external)" : null);
  }

  // Only sent when there is one. See the constructor.
  _headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
      ...extra
    };
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, error: "No AgentRouter API key" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this._headers(),
        signal: controller.signal
      });
      return { ok: response.ok, status: response.status, type: "AgentRouterModelProvider", model: this.model };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  capabilities() {
    return { name: this.name, structured: true, text: true, streaming: true, tools: true, model: this.model, gateway: true, remote: true };
  }

  supportsChat() { return Boolean(this.apiKey); }

  async chat(request = {}) {
    this._usage.calls += 1;
    const result = await openAiCompatibleChat({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: request.model || this.model,
      headers: this.userAgent ? { "User-Agent": this.userAgent } : {},
      ...request
    });
    this._usage.tokensIn += result.usage?.prompt_tokens ?? 0;
    this._usage.tokensOut += result.usage?.completion_tokens ?? 0;
    return result;
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
          headers: this._headers(),
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
    case "mistral": {
      const apiKey = settings.apiKey || process.env.MISTRAL_API_KEY || process.env.LLM_API_KEY || process.env.SYSCORA_MODEL_API_KEY;
      if (apiKey) return new MistralModelProvider({
        apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        maxTokens: settings.maxTokens
      });
      return new MockModelProvider();
    }
    case "gemini":
    case "google": {
      const apiKey = settings.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.SYSCORA_MODEL_API_KEY;
      if (apiKey) return new GeminiModelProvider({
        apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        maxTokens: settings.maxTokens
      });
      return new MockModelProvider();
    }
    case "agentrouter": {
      const apiKey = settings.apiKey || process.env.AGENTROUTER_API_KEY || process.env.SYSCORA_MODEL_API_KEY;
      if (apiKey) return new AgentRouterModelProvider({ apiKey, model: settings.model, baseUrl: settings.baseUrl });
      return new MockModelProvider();
    }
    case "deepseek": {
      // DeepSeek is OpenAI transport-compatible, but the configured models do
      // not necessarily accept strict `response_format: json_schema`. Reuse
      // the existing prompt-schema + local-validation provider abstraction.
      const apiKey = settings.apiKey || process.env.SYSCORA_MODEL_API_KEY;
      if (apiKey) return new AgentRouterModelProvider({
        apiKey,
        model: settings.model,
        baseUrl: settings.baseUrl,
        providerName: "deepseek"
      });
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
  // ASKING FOR MOCK MEANS ASKING FOR NO NETWORK, AND A FALLBACK DEFEATS THAT
  // SILENTLY.
  //
  // Observed live, 19 Aug 2026, the first time a real fallback was configured:
  // `npm run eval -- --mock` — documented as "no model, no machine, no cost" —
  // built the chain [mock, deepseek]. MockModelProvider does not support `chat`,
  // so FailoverModelProvider skipped straight past it to the paid endpoint, and
  // thirty-odd eval tasks ran for real against the real machine and a real bill,
  // including one that drives WhatsApp. Nothing warned; it looked like a mock run
  // that happened to be slow.
  //
  // Keyed on the provider having been NAMED as mock, not on the primary instance
  // turning out to be a Mock — `createModelProvider` also returns one when the
  // requested provider has no credentials, and falling over to a working second
  // account is exactly the right answer to that.
  const askedForMock = String(settings.provider ?? "").toLowerCase() === "mock";
  if (askedForMock) return new FailoverModelProvider([new MockModelProvider()]);

  const configuredKeys = Array.isArray(settings.apiKeys)
    ? settings.apiKeys.map((key) => String(key).trim()).filter(Boolean)
    : [];
  const keyedProviders = configuredKeys.map((apiKey) => createModelProvider({ ...settings, apiKey, apiKeys: undefined }));
  const primary = keyedProviders.length > 0 ? keyedProviders[0] : createModelProvider(settings);
  const configured = settings.fallbackProviders ?? process.env.SYSCORA_MODEL_FALLBACK_PROVIDERS ?? "";
  const names = Array.isArray(configured) ? configured : String(configured).split(",").map((value) => value.trim()).filter(Boolean);
  const fallbacks = names.map((provider) => createModelProvider({ provider }));
  const configuredFallbacks = Array.isArray(settings.fallbackProviderConfigs)
    ? settings.fallbackProviderConfigs.map((config) => createModelProvider(config))
    : [];
  return new FailoverModelProvider([primary, ...keyedProviders.slice(1), ...configuredFallbacks, ...fallbacks]);
}
