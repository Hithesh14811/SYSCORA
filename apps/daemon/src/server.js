import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntime, loadCapabilityPlugins, reloadRuntimeModelProvider } from "./runtime-factory.js";
import { PROTOCOL_VERSION, ValidationError } from "../../../packages/shared-types/src/domain.js";
import { AgentRuntime } from "../../../packages/agent-runtime/src/index.js";
import { buildEnvelope, parseRequestBodyWithEnvelope } from "../../../packages/protocol/src/envelope.js";
import { buildSessionResponse } from "../../../packages/protocol/src/session-protocol.js";
import { projectSessionLifecycle } from "../../../packages/shared-types/src/session-lifecycle.js";
import { closeWindowsAutomationHost } from "../../../os-adapters/windows-host/src/client.js";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { normalizeAccessPolicy } from "../../../packages/shared-types/src/access-policy.js";
import { isProtectedReference, protectToFile } from "../../../packages/secrets/src/protected-value.js";
import { installCrashGuards, reportInterruptedRun } from "./crash-guard.js";
import { reportPreflight } from "./preflight.js";
// The same extractor the agent uses on files it finds on disk. See documents.js:
// a .docx is a ZIP of XML and a .pdf is a set of FlateDecode streams, both of
// which Node can take apart without a dependency.
import { extractDocumentText, isDocumentPath } from "../../../packages/fast-agent/src/documents.js";
// Mail. Reachable only from the compose card, never from the agent loop — the
// reason is the long note at the top of this module.
import { connectGmail, disconnectGmail, gmailStatus, sendGmail, setDefaultGmailAddress } from "./gmail.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDirectory = path.resolve(__dirname, "../../desktop");

const BASE_SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY"
});
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  // The renderer has legacy style attributes and runtime-set CSS variables.
  // This is narrower than allowing inline scripts and preserves the current UI.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join("; ");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

// Cap request bodies so a large or endless POST cannot exhaust daemon memory.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB is ample for intents.
// An attached document is the one thing a user legitimately sends that is bigger
// than an intent. base64 costs a third on top of the file, so this holds the
// 20 MB the composer accepts with room over.
const MAX_ATTACHMENT_BODY_BYTES = 30 * 1024 * 1024;

async function readJsonBody(request, limit = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error("Request body exceeds maximum allowed size.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseStaticPath(urlPathname) {
  if (urlPathname === "/") {
    // The demo chat is the default face of the MVP. The developer console
    // remains available at /console.html for debugging.
    return path.join(desktopDirectory, "demo.html");
  }
  // Chromium asks for /favicon.ico regardless of the <link rel="icon"> in the
  // markup, so every single page load logged a 404 in the console. Nothing was
  // broken by it and it made the console useless for spotting things that are.
  if (urlPathname === "/favicon.ico") return path.join(desktopDirectory, "icon.ico");
  const safePath = path.normalize(urlPathname).replace(/^(\.\.[/\\])+/, "");
  return path.join(desktopDirectory, safePath);
}

function inferContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  // The brand mark is served from here too. Without this it goes out as
  // octet-stream, which Chromium refuses to paint into an <img> — the top bar
  // showed a broken-image box and nothing in the console said why.
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}


export function startServer({ port = 4317, basePath = process.cwd(), runtime: injectedRuntime = null, warmHost = true } = {}) {
  const runtime = injectedRuntime ?? createRuntime(basePath);
  const intentRuns = new Map();
  // THE ONE PHYSICAL MOUSE, CLAIMED.
  //
  // Not derived from `intentRuns`: that map is filled by a callback the runtime
  // chooses when to invoke, and one whole route never filled it at all. See the
  // claim taken in POST /api/intents. Null means nothing is running.
  let activeIntent = null;
  const releaseIntentClaim = (held) => {
    // Identity, not truthiness. Releasing "whatever is active" would let a
    // finishing run unlock a DIFFERENT run that had since taken the claim —
    // which is the classic way a mutex stops being one.
    if (activeIntent === held) activeIntent = null;
  };
  // "ANSWERED" belongs here: a conversational reply is a settled result the
  // client should stop polling on, even though nothing was executed.
  const terminalStates = new Set(["COMPLETED", "COMPLETED_WITH_WARNINGS", "ANSWERED", "FAILED", "TIMED_OUT", "CANCELLED", "ROLLED_BACK", "DENIED", "PLAN_REJECTED"]);

  const writeSse = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  // FILES THIS DAEMON ITSELF PRODUCED, AND NOTHING ELSE.
  //
  // The file card has Open and Show in folder buttons, and they need a route.
  // A route that opens "the path in the request" is a route that opens any file
  // on the machine — and the page it is called from renders text the agent read
  // out of web pages, documents and messages, which is precisely the shape of
  // thing this codebase refuses to let become an action.
  //
  // So the same boundary the Send button has: the daemon records the path of
  // every file a tool reported creating, and the route can open one of those or
  // nothing. A path the user never asked for was never in a card, so it is not
  // in this set, whatever a request says.
  const openableFiles = new Set();
  const noteOpenableFile = (event) => {
    const card = (event?.details ?? event)?.card;
    if (card?.kind === "file" && typeof card.path === "string" && card.path) {
      openableFiles.add(path.resolve(card.path).toLowerCase());
    }
  };

  const publish = (sessionId, event) => {
    noteOpenableFile(event);
    const run = intentRuns.get(sessionId);
    if (!run) return;
    // `run.events` is the replay buffer a reconnecting client is caught up
    // from, so it must hold the RECORD of the run and not its ticks.
    // TOOL_STREAMING is emitted twice a second for as long as the model is
    // composing a tool call — a single large `write_file` is a couple of
    // hundred of them, each superseded by the next and all of them superseded
    // by the TOOL_STARTED that follows. Sent to whoever is watching now,
    // exactly like the runtime treats it (see the note there).
    if ((event.eventType ?? event.type) !== "TOOL_STREAMING") run.events.push(event);
    for (const subscriber of run.subscribers) writeSse(subscriber, event);
  };
  const priorOnSessionEvent = runtime.onSessionEvent;
  runtime.onSessionEvent = (sessionId, event) => {
    priorOnSessionEvent?.(sessionId, event);
    publish(sessionId, event);
  };

  const ensureRun = (sessionId) => {
    if (!intentRuns.has(sessionId)) {
      intentRuns.set(sessionId, { sessionId, status: "RUNNING", settled: false, terminal: false, session: null, events: [], subscribers: new Set() });
    }
    return intentRuns.get(sessionId);
  };

  // A SETTLED RUN IS NOT NEEDED FOREVER.
  //
  // Every request ever submitted stayed in this map, holding its whole event
  // list, for as long as the daemon ran — which for the desktop application is
  // as long as the machine is on. The client reads /status once more after the
  // stream settles (a second or two), and nothing reads it after that.
  const SETTLED_RUN_TTL_MS = 10 * 60 * 1000;
  const MAX_RETAINED_RUNS = 200;

  const forgetSettledRuns = () => {
    if (intentRuns.size <= MAX_RETAINED_RUNS) return;
    for (const [sessionId, run] of intentRuns) {
      if (intentRuns.size <= MAX_RETAINED_RUNS) break;
      if (run.settled) intentRuns.delete(sessionId);
    }
  };

  const settleRun = (sessionId, session, error = null) => {
    const run = ensureRun(sessionId);
    run.session = session ?? null;
    run.settled = true;
    run.status = error ? "FAILED" : (session?.finalResponse?.status ?? session?.currentState ?? "FAILED");
    run.terminal = error ? true : terminalStates.has(run.status) || terminalStates.has(session?.currentState);
    const settled = { type: "SESSION_SETTLED", sessionId, status: run.status, terminal: run.terminal, error: error?.message ?? null };
    publish(sessionId, settled);
    publish(sessionId, { type: "STREAM_END", sessionId, status: run.status });
    for (const subscriber of run.subscribers) subscriber.end();
    run.subscribers.clear();
    // Long enough that a reconnecting client still finds it; short enough that a
    // daemon left running for a week is not holding a week of transcripts. The
    // session store is the durable record either way.
    const expiry = setTimeout(() => intentRuns.delete(sessionId), SETTLED_RUN_TTL_MS);
    expiry.unref?.();
    forgetSettledRuns();
  };

  // The session store is the durable source of truth. Reconcile polling with
  // it so a dropped/delayed promise callback or renderer reconnect cannot leave
  // the UI displaying an obsolete "Working" event after the runtime has
  // already persisted a terminal result.
  const reconcilePersistedRun = async (sessionId, run) => {
    const getPersisted = runtime.sessionStore?.get ?? runtime.sessionStore?.load;
    if (typeof getPersisted !== "function") return null;
    let persisted = null;
    try {
      persisted = await getPersisted.call(runtime.sessionStore, sessionId);
    } catch {
      return null;
    }
    if (!persisted) return null;
    const status = persisted.finalResponse?.status ?? persisted.currentState;
    const terminal = terminalStates.has(status) || terminalStates.has(persisted.currentState);
    if (terminal && (!run.terminal || !run.session)) settleRun(sessionId, persisted);
    return persisted;
  };
  // Bring the Windows automation host up now rather than on the user's first
  // request. `warmHost` has been a parameter of this function all along and was
  // never read, so every session paid the host's several-second cold start
  // inside its own first action — where it looks like the action being slow.
  if (warmHost !== false && typeof runtime.adapter?.automationHost?.warm === "function") {
    runtime.adapter.automationHost.warm()
      .then((ready) => {
        if (!ready) console.log("SYSCORA desktop automation host is unavailable; GUI actions will be degraded.");
      })
      .catch(() => {});
  }
  // And what machine this is, for the same reason: read here it is free, read
  // inside the first request it is several seconds before the user sees a word.
  if (warmHost !== false && typeof runtime.warmMachineFacts === "function") {
    runtime.warmMachineFacts(basePath).catch(() => {});
  }
  // Opt-in signed capability plugins (SYSCORA_PLUGIN_DIR + trusted keys). Loading
  // is best-effort at startup and never blocks the server; a failure to load a
  // plugin leaves the built-in capabilities intact.
  loadCapabilityPlugins(runtime)
    .then((result) => {
      if (!result.skipped) console.log(`SYSCORA loaded ${result.loaded.length} capability plugin(s).`);
      else if (process.env.SYSCORA_PLUGIN_DIR) console.log(`SYSCORA plugin loading skipped: ${result.reason}`);
    })
    .catch((error) => console.error(`SYSCORA plugin loading failed: ${error.message}`));
  const apiToken = process.env.SYSCORA_API_TOKEN ?? crypto.randomBytes(24).toString("hex");

  const apiTokenBuffer = Buffer.from(apiToken, "utf8");
  function isAuthorized(request) {
    const token = request.headers["x-syscora-token"];
    if (typeof token !== "string") return false;
    // Constant-time comparison to avoid leaking the token via response timing.
    // Length must match first because timingSafeEqual requires equal-length
    // buffers; the length of a random 24-byte hex token is not secret.
    const provided = Buffer.from(token, "utf8");
    if (provided.length !== apiTokenBuffer.length) return false;
    return crypto.timingSafeEqual(provided, apiTokenBuffer);
  }

  // The last Google sign-in failure, if there was one. See /api/email/connect.
  let signInError = null;

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          product: "SYSCORA",
          // HOW OFTEN THE OFFLINE PIPELINE WAS ACTUALLY NEEDED, this process.
          //
          // `docs/production-plan.md` W4.2 wants those ~20,000 lines deleted or
          // quarantined. They are quarantined now — reachable only on a typed
          // MODEL_UNREACHABLE, never on a guess about tool counts — and this is
          // the number that should decide whether they are deleted. Deleting
          // them on the strength of an argument is not a "don't break anything"
          // move; deleting them because they fired zero times across sixty eval
          // runs is.
          stagedPipelineReaches: AgentRuntime.stagedPipelineReaches
        });
        return;
      }

      if (requestUrl.pathname.startsWith("/api/") && !isAuthorized(request) && requestUrl.pathname !== "/api/health") {
        sendJson(response, 401, { error: "Unauthorized: missing or invalid x-syscora-token header." });
        return;
      }

      // ---- Provider settings ------------------------------------------------
      // Never return a credential. A newly supplied key is protected with the
      // current Windows user's DPAPI key before config.json is changed, and the
      // provider is swapped in-process so saving does not add a restart delay.
      if (requestUrl.pathname === "/api/settings/model" && request.method === "GET") {
        const stateDirectory = resolveStateDir(basePath);
        let parsed = {};
        try { parsed = JSON.parse(await fs.readFile(path.join(stateDirectory, "config.json"), "utf8")); } catch {}
        const model = parsed?.model ?? parsed ?? {};
        sendJson(response, 200, {
          provider: model.provider ?? process.env.SYSCORA_MODEL_PROVIDER ?? null,
          model: model.model ?? process.env.SYSCORA_MODEL_NAME ?? null,
          configured: Boolean(
            process.env.SYSCORA_MODEL_API_KEY || model.primaryApiKey || model.apiKey ||
            (Array.isArray(model.apiKeys) && model.apiKeys.length > 0)
          ),
          protected: isProtectedReference(model.primaryApiKey) || isProtectedReference(model.apiKey)
        });
        return;
      }

      if (requestUrl.pathname === "/api/settings/model" && request.method === "POST") {
        try {
          const payload = await readJsonBody(request);
          const allowedProviders = new Set(["openai", "anthropic", "mistral", "gemini", "google", "agentrouter", "deepseek"]);
          const provider = payload.provider == null ? null : String(payload.provider).trim().toLowerCase();
          if (provider && !allowedProviders.has(provider)) throw new Error("That model provider is not supported.");
          const modelName = payload.model == null ? null : String(payload.model).trim().slice(0, 160);
          const baseUrl = payload.baseUrl == null ? null : String(payload.baseUrl).trim();
          if (baseUrl) {
            const endpoint = new URL(baseUrl);
            if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
              throw new Error("A provider URL must use HTTPS (localhost is allowed for local models). ");
            }
          }
          const apiKey = payload.apiKey == null ? "" : String(payload.apiKey).trim();
          if (apiKey && (apiKey.length < 8 || apiKey.length > 4096)) throw new Error("The API key length is invalid.");

          const stateDirectory = resolveStateDir(basePath);
          const configPath = path.join(stateDirectory, "config.json");
          let config = {};
          try { config = JSON.parse(await fs.readFile(configPath, "utf8")); } catch {}
          if (!config || Array.isArray(config) || typeof config !== "object") config = {};
          const existingModel = config.model && typeof config.model === "object" ? config.model : {};
          const nextModel = { ...existingModel };
          if (provider) nextModel.provider = provider;
          if (modelName) nextModel.model = modelName;
          if (baseUrl) nextModel.baseUrl = baseUrl.replace(/\/$/, "");
          if (apiKey) {
            const secretName = "model-primary.bin";
            await protectToFile(path.join(stateDirectory, "secrets", secretName), apiKey);
            nextModel.primaryApiKey = `dpapi:${secretName}`;
            delete nextModel.apiKey;
            delete nextModel.apiKeys;
          }
          const next = {
            ...config,
            model: nextModel,
            externalAIConsent: {
              ...(config.externalAIConsent ?? {}),
              scopes: ["EXTERNAL_AI_SANITIZED_REASONING", "EXTERNAL_AI_STRUCTURED_UI_CONTEXT"]
            }
          };
          await fs.mkdir(stateDirectory, { recursive: true });
          const temporary = `${configPath}.${process.pid}.tmp`;
          await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await fs.rename(temporary, configPath);
          const status = reloadRuntimeModelProvider(runtime, basePath);
          sendJson(response, 200, { ...status, protected: Boolean(apiKey) || isProtectedReference(nextModel.primaryApiKey) });
        } catch (error) {
          sendJson(response, 400, { error: error?.message ?? String(error) });
        }
        return;
      }

      // ---- Mail -------------------------------------------------------------
      //
      // THESE ROUTES ARE FOR THE COMPOSE CARD, NOT FOR THE AGENT. Nothing in
      // the agent loop can reach them: they are POSTs behind the API token, and
      // the token is injected into the CLIENT by the desktop shell, never given
      // to a tool. `email_draft` produces a card; a person presses Send. See the
      // long note at the top of gmail.js for why that boundary is where it is.
      if (requestUrl.pathname === "/api/email/status" && request.method === "GET") {
        // `signInError` is how a sign-in that failed after its response had
        // already been sent gets back to the card. It clears when a new one
        // starts, and when one succeeds.
        sendJson(response, 200, { ...gmailStatus(basePath), signInError });
        return;
      }

      if (requestUrl.pathname === "/api/email/connect" && request.method === "POST") {
        // TWO EVENTS, ONE REQUEST. The consent URL is ready in milliseconds;
        // the sign-in it starts finishes minutes later, in a browser window
        // this process does not own. So the response carries the URL and the
        // OUTCOME is collected by polling /api/email/status — which is also
        // why a failure has to be remembered rather than thrown into a
        // response that was sent long ago.
        //
        // The page is opened by the CLIENT. A daemon that can open browser
        // windows by itself is a daemon that can be made to.
        try {
          const url = await new Promise((resolve, reject) => {
            connectGmail(basePath, { onUrl: resolve })
              .then(() => { signInError = null; })
              .catch((error) => {
                signInError = error?.message ?? String(error);
                reject(error);
              });
          });
          signInError = null;
          sendJson(response, 200, { url });
        } catch (error) {
          sendJson(response, 400, { error: error?.message ?? String(error) });
        }
        return;
      }

      if (requestUrl.pathname === "/api/email/disconnect" && request.method === "POST") {
        // An address disconnects one account; no address disconnects them all.
        const payload = await readJsonBody(request).catch(() => ({}));
        sendJson(response, 200, disconnectGmail(basePath, payload?.address ?? null));
        return;
      }

      if (requestUrl.pathname === "/api/email/default" && request.method === "POST") {
        try {
          const payload = await readJsonBody(request);
          sendJson(response, 200, setDefaultGmailAddress(basePath, payload?.address));
        } catch (error) {
          sendJson(response, 400, { error: error?.message ?? String(error) });
        }
        return;
      }

      // The file card's two buttons. `open` hands the file to whatever Windows
      // has registered for it; `reveal` selects it in Explorer.
      //
      // Explorer rather than `start`: `start` is a cmd.exe builtin, so it needs
      // a shell, and a shell needs the path quoted — which is how a path with a
      // space or an ampersand in it becomes a command. `explorer.exe` takes the
      // path as one argument with no shell anywhere near it. See the note on
      // `openableFiles` for why an arbitrary path cannot reach here at all.
      if (requestUrl.pathname === "/api/files/open" && request.method === "POST") {
        try {
          const payload = await readJsonBody(request);
          const wanted = path.resolve(String(payload?.path ?? ""));
          if (!openableFiles.has(wanted.toLowerCase())) {
            sendJson(response, 403, { ok: false, error: "That file was not created here, so it cannot be opened from here." });
            return;
          }
          // It has to still BE there. A card is a record of a moment, and the
          // user may have moved or deleted the file since.
          await fs.access(wanted);
          const reveal = payload?.reveal === true;
          const child = spawn("explorer.exe", reveal ? [`/select,${wanted}`] : [wanted], {
            detached: true, stdio: "ignore", windowsVerbatimArguments: false
          });
          child.unref();
          sendJson(response, 200, { ok: true, path: wanted, revealed: reveal });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.code === "ENOENT" ? "That file is no longer there." : (error?.message ?? String(error)) });
        }
        return;
      }

      if (requestUrl.pathname === "/api/email/send" && request.method === "POST") {
        try {
          const draft = await readJsonBody(request);
          const sent = await sendGmail(basePath, draft);
          // Gmail's own id for the message it created. Reported back so the
          // card can say "sent" on the strength of the server's answer rather
          // than on the strength of the request having returned.
          sendJson(response, 200, { ok: true, ...sent });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) });
        }
        return;
      }

      // Stop a running request. Deliberately its own route rather than the
      // session pause/cancel machinery: this is the user pressing stop on a
      // thing they can see running, and it must take effect now — abort the
      // in-flight model call and let the loop settle on what it already did.
      const stopMatch = requestUrl.pathname.match(/^\/api\/intents\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const [, sessionId] = stopMatch;
        const run = intentRuns.get(sessionId);
        if (!run) {
          sendJson(response, 404, { error: "Unknown intent session." });
          return;
        }
        run.canceller?.abort(new Error("STOPPED_BY_USER"));
        sendJson(response, 202, { sessionId, stopping: true, settled: run.settled });
        return;
      }

      // The answer to a question the agent asked mid-run, before doing something
      // that cannot be undone. Deliberately its own route, like stop: it has to
      // reach a loop that is already running and waiting, not a session being
      // resumed. An unknown or already-answered id is reported as such rather
      // than silently accepted — a late click must not authorize anything.
      const approveMatch = requestUrl.pathname.match(/^\/api\/intents\/([^/]+)\/approve$/);
      if (request.method === "POST" && approveMatch) {
        const [, sessionId] = approveMatch;
        const body = await readJsonBody(request);
        const approvalId = String(body?.approvalId ?? "");
        if (!approvalId) {
          sendJson(response, 400, { error: "approvalId is required." });
          return;
        }
        const delivered = runtime.resolveApproval?.(approvalId, body?.approved === true) === true;
        sendJson(response, delivered ? 200 : 409, {
          sessionId,
          approvalId,
          approved: body?.approved === true,
          delivered,
          ...(delivered ? {} : { error: "That question is no longer waiting for an answer." })
        });
        return;
      }

      const progressMatch = requestUrl.pathname.match(/^\/api\/intents\/([^/]+)\/(status|stream)$/);
      if (request.method === "GET" && progressMatch) {
        const [, sessionId, channel] = progressMatch;
        const run = intentRuns.get(sessionId);
        if (!run) {
          sendJson(response, 404, { error: "Unknown intent session." });
          return;
        }
        const persisted = await reconcilePersistedRun(sessionId, run);
        if (channel === "status") {
          const latestPersistedEvent = persisted?.events?.at?.(-1) ?? null;
          // One authoritative, user-readable view of where the request stands.
          // Clients render this rather than re-deriving "is it done?" from raw
          // events, which is what previously let a stale "Working" survive a
          // finished session and let an executed action read as a completed goal.
          // A settled run is authoritative over the last state the session
          // persisted mid-flight: without this a request that has already
          // finished can still be shown as "Inspecting" or "Working".
          const currentSession = run.session ?? persisted ?? null;
          const lifecycle = currentSession
            ? projectSessionLifecycle(
                run.terminal && !terminalStates.has(currentSession.currentState)
                  ? {
                      ...currentSession,
                      currentState: run.status === "COMPLETED" || run.status === "ANSWERED"
                        ? "COMPLETED"
                        : "FAILED"
                    }
                  : currentSession,
                { developerMode: requestUrl.searchParams.get("developer") === "1" }
              )
            : null;
          sendJson(response, 200, {
            sessionId,
            status: run.status,
            settled: run.settled,
            terminal: run.terminal,
            lifecycle,
            eventCount: run.events.length,
            latestEvent: latestPersistedEvent ?? run.events.at(-1) ?? null,
            session: run.session
          });
          return;
        }
        response.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        for (const event of run.events) writeSse(response, event);
        if (run.settled) {
          response.end();
        } else {
          run.subscribers.add(response);
          request.on("close", () => run.subscribers.delete(response));
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "intent_request");
        const payload = parsed.payload;
        if (!payload.text) {
          sendJson(response, 400, { error: "text is required." });
          return;
        }
        // ONE MACHINE, ONE TASK AT A TIME.
        //
        // Two requests running together share one pointer, one focused window
        // and one agent state — which window is being worked in, what the last
        // reading found, where the terminal is. They would interleave clicks and
        // keystrokes into each other's windows, and the transcripts would each
        // describe half of what happened. The chat surface already turns its
        // send button into a stop button while a request runs; this is the same
        // rule at the API, where nothing else was enforcing it.
        // THE CLAIM IS TAKEN HERE, NOT WHERE THE RUN ANNOUNCES ITSELF.
        //
        // This used to look for an unsettled entry in `intentRuns`, and there
        // were two ways past it. `?sync=true` called `runtime.submitIntent`
        // directly and never registered at all, so any number of synchronous
        // requests ran at once, each driving the same physical mouse. And even
        // on the asynchronous route the entry is created by `onSessionStarted`,
        // a callback the runtime invokes when it gets round to it — so two
        // requests arriving close together could both read an empty map before
        // either had registered.
        //
        // Both are the same bug: the lock was derived from the runtime's own
        // bookkeeping instead of being taken by the thing doing the accepting.
        // `activeIntent` is set HERE, before any await, which is what makes it
        // a lock rather than a description.
        const active = activeIntent ?? [...intentRuns.values()].find((run) => !run.settled);
        if (active) {
          sendJson(response, 409, {
            error: "SYSCORA is already working on something.",
            message: "There is one screen and one pointer, so requests run one at a time. " +
              "Stop the running request first, or wait for it to finish.",
            sessionId: active.sessionId ?? null,
            // Only when there is one to point at: a run that has not announced
            // its session yet has no status page, and "/api/intents/null/status"
            // is a worse answer than none.
            ...(active.sessionId ? { statusUrl: `/api/intents/${active.sessionId}/status` } : {})
          });
          return;
        }
        const held = { at: Date.now(), sessionId: null };
        activeIntent = held;
        const accessPolicy = normalizeAccessPolicy(payload);
        const runOptions = {
          workspacePath: basePath,
          ...accessPolicy,
          // Kept for the staged/legacy pipeline while the explicit mode owns
          // the fast path. Older API clients still receive their old semantics.
          autoApprove: accessPolicy.approvalMode === "full",
          // The prior turns of this conversation, oldest first. The client owns
          // the transcript; the daemon stays stateless about it and simply
          // forwards what was sent, bounded here so a client cannot grow the
          // reasoning prompt without limit. It is context for resolving what the
          // new message refers to — never authorization, which is why
          // autoApprove above is read from THIS request only.
          history: Array.isArray(payload.history)
            ? payload.history.slice(-12).map((turn) => ({
                role: String(turn?.role ?? "user"),
                text: String(turn?.text ?? "").slice(0, 2000)
              }))
            : []
        };
        if (requestUrl.searchParams.get("sync") === "true") {
          // `finally`, not a release after the send: a run that throws must not
          // leave the claim held, or one failed tool turns "one at a time" into
          // "one ever" and every later request is answered 409 by a daemon that
          // is doing nothing at all. That exact shape has already happened here
          // once — an eval task that hit its timeout did not stop its session,
          // and two whole rounds recorded as zeros behind a 409.
          try {
            const session = await runtime.submitIntent(payload.text, {
              ...runOptions,
              onSessionStarted: (sessionId) => { held.sessionId = sessionId; }
            });
            const legacy = buildSessionResponse(session);
            sendJson(response, 200, {
              envelope: buildEnvelope("intent_response", legacy, parsed.requestId),
              ...legacy
            });
          } finally {
            releaseIntentClaim(held);
          }
          return;
        }

        let resolveStarted;
        let rejectStarted;
        let submittedSessionId = null;
        const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
        // The user's stop button. Held against the run so POST .../stop can
        // reach the agent loop mid-step; the loop checks it between steps and
        // the in-flight model request is aborted with it.
        const canceller = new AbortController();
        // An async wrapper rather than Promise.resolve: a runtime that throws
        // SYNCHRONOUSLY would escape before `.finally` below was ever attached,
        // and the claim taken above would be held by a run that never started.
        const runPromise = (async () => runtime.submitIntent(payload.text, {
          ...runOptions,
          signal: canceller.signal,
          onSessionStarted: (sessionId) => {
            submittedSessionId = sessionId;
            held.sessionId = sessionId;
            ensureRun(sessionId).canceller = canceller;
            resolveStarted(sessionId);
          }
        }))();
        runPromise.then((session) => settleRun(session.sessionId, session)).catch((error) => {
          if (submittedSessionId) settleRun(submittedSessionId, null, error);
          rejectStarted(error);
        // Released when the RUN ends, not when this handler returns — the
        // asynchronous route answers 202 immediately and the machine is still
        // being driven long after that.
        }).finally(() => releaseIntentClaim(held));
        const sessionId = await started;
        sendJson(response, 202, {
          status: "RUNNING",
          sessionId,
          statusUrl: `/api/intents/${sessionId}/status`,
          streamUrl: `/api/intents/${sessionId}/stream`
        });
        return;
      }

      // POST /api/intents/acknowledge is gone. It existed so the chat surface
      // could fire a second, parallel model request purely to get "sure, playing
      // that now" on screen while the real work started. No client ever called
      // it, and the agent loop now gets the same line for free: every tool call
      // carries a `say`, which reaches the user about a second in, before the
      // tool it describes has finished. One request, not two.

      // READING A LIST SHOULD NOT DESERIALISE EVERY SESSION.
      //
      // This called `sessionStore.list()`, which parses every stored session in
      // full, and then `buildSessionResponse` VALIDATED every one of them.
      // Measured on the real installation, 22 Aug 2026, 2,234 sessions:
      // `list()` 1,238ms against `listSummaries()` 390ms, and a response body
      // of **73.0 MB** — to draw a menu.
      //
      // `listSummaries` was written for exactly this, in the workstream that
      // found the problem, and then nothing called it: the only callers in the
      // tree were its own tests. That is the ninth time this codebase has
      // produced correct machinery nothing reaches.
      //
      // The default is now the summary, bounded. `?full=true` still returns
      // whole sessions because an API consumer may genuinely want them — but it
      // is bounded too, because the unbounded version is what 73 MB looks like.
      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const limit = Math.min(1000, Math.max(1, Number(requestUrl.searchParams.get("limit") ?? 200) || 200));
        if (requestUrl.searchParams.get("full") === "true") {
          const sessions = (await runtime.sessionStore.list()).slice(0, limit);
          const legacy = buildSessionResponse({ sessions });
          sendJson(response, 200, {
            envelope: buildEnvelope("sessions_response", legacy),
            ...legacy
          });
          return;
        }
        const sessions = await runtime.sessionStore.listSummaries({ limit });
        sendJson(response, 200, {
          envelope: buildEnvelope("sessions_response", { sessions }),
          // Not through buildSessionResponse: that validates each entry as a
          // full ExecutionSession, and a summary deliberately is not one.
          // Saying so in the payload is cheaper than a consumer discovering it.
          protocolVersion: PROTOCOL_VERSION,
          summary: true,
          limit,
          sessions
        });
        return;
      }

      // A DOCUMENT THE USER ATTACHED, TURNED INTO SOMETHING A MODEL CAN READ.
      //
      // WHY THIS IS SERVER-SIDE AT ALL, when the composer already reads plain
      // text files itself: a .docx, .xlsx and .pptx are ZIP archives of XML, and
      // a real .pdf keeps its text in FlateDecode streams. None of that comes
      // apart in a browser without shipping a parser to it — the page's own PDF
      // reader could only handle uncompressed content streams, and every Word
      // document was refused with "cannot be read in the browser". Meanwhile
      // documents.js, which the agent already uses on files it finds on disk,
      // reads all four properly. One extractor, used from both ends.
      //
      // NOTHING IS WRITTEN. The bytes are extracted from memory and dropped;
      // there is no upload directory, no temp file and no cleanup story for a
      // document that may be somebody's payslip. The daemon is bound to
      // 127.0.0.1 and this route needs the API token like every other one, so
      // the file never leaves the machine — only the text the user is asking
      // about is sent anywhere, and only to the model they chose.
      if (request.method === "POST" && requestUrl.pathname === "/api/attachments/extract") {
        const body = await readJsonBody(request, MAX_ATTACHMENT_BODY_BYTES);
        const name = String(body?.name ?? "").trim();
        const base64 = String(body?.base64 ?? "");
        if (!name || !base64) {
          sendJson(response, 400, { ok: false, reason: "Both a file name and its contents are required." });
          return;
        }
        // The extension decides the parser, so a name without one cannot be
        // read — and saying that is better than guessing a format and returning
        // whatever mojibake falls out.
        if (!isDocumentPath(name)) {
          sendJson(response, 400, {
            ok: false,
            reason: `${name} is not a document format this can read (.pdf, .docx, .xlsx and .pptx are).`
          });
          return;
        }
        const buffer = Buffer.from(base64, "base64");
        const extracted = extractDocumentText(name, buffer);
        // An empty extraction is not a failure of the reader — a scanned PDF is
        // a photograph of a page and there is no text in it to find. The reason
        // travels so the composer can say which of the two happened.
        sendJson(response, 200, {
          ok: Boolean(extracted.text),
          name,
          format: extracted.format,
          text: extracted.text,
          reason: extracted.reason ?? null
        });
        return;
      }

      // THE ROUTES THE AGENT HAS LEARNED, AND THE ONE PLACE THEY ARE CREATED.
      //
      // A run that worked is OFFERED (SKILL_OFFERED on the event stream) and
      // never saved by itself. This is where the user's yes turns into a file:
      // nothing that drives their machine gets written because a task happened
      // to succeed. Deleting is one call and needs no ceremony — a skill they
      // cannot remove is one they cannot correct.
      if (request.method === "GET" && requestUrl.pathname === "/api/skills") {
        const skills = await runtime.listSkills();
        sendJson(response, 200, { envelope: buildEnvelope("skills_response", { skills }), skills });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/skills") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "skill_save_request");
        const saved = await runtime.saveSkill(parsed.payload?.skill);
        sendJson(response, saved.saved ? 200 : 400, {
          envelope: buildEnvelope("skill_save_response", saved, parsed.requestId),
          ...saved
        });
        return;
      }

      if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/skills/")) {
        const id = decodeURIComponent(requestUrl.pathname.slice("/api/skills/".length));
        const removed = await runtime.deleteSkill(id);
        sendJson(response, 200, { envelope: buildEnvelope("skill_delete_response", removed), ...removed });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/system/summary") {
        const summary = await runtime.inspectWindowsSystem();
        sendJson(response, 200, {
          envelope: buildEnvelope("system_summary_response", summary),
          summary
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/sessions/latest/rollback") {
        const session = await runtime.rollbackLatestSession();
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("rollback_response", legacy),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname.startsWith("/api/sessions/")) {
        const match = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/(pause|resume|cancel)$/);
        if (match) {
          const [, sessionId, command] = match;
          const body = await readJsonBody(request);
          const expectedType = `session_${command}_request`;
          const parsed = parseRequestBodyWithEnvelope(body, expectedType);
          const reason = parsed.payload?.reason;
          let session;
          if (command === "pause") {
            session = await runtime.pauseSessionById(sessionId, reason);
          } else if (command === "resume") {
            session = await runtime.resumeSessionById(sessionId, {
              autoApprove: parsed.payload?.autoApprove === true
            });
          } else {
            session = await runtime.cancelSessionById(sessionId, reason);
          }
          const legacy = buildSessionResponse(session);
          sendJson(response, 200, {
            envelope: buildEnvelope(`session_${command}_response`, legacy, parsed.requestId),
            ...legacy
          });
          return;
        }
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/set-env") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "set_env_intent_request");
        const payload = parsed.payload;
        if (!payload.workspacePath || !payload.key || !payload.value) {
          sendJson(response, 400, {
            error: "workspacePath, key, and value are required."
          });
          return;
        }

        const session = await runtime.runSetProjectEnvVariable(
          {
            rawText: `Set ${payload.key} for the current project`,
            entities: {
              workspacePath: path.resolve(payload.workspacePath),
              key: payload.key,
              value: payload.value
            }
          },
          { autoApprove: payload.autoApprove === true }
        );

        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("set_env_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/run-project") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "run_project_intent_request");
        const payload = parsed.payload;
        if (!payload.workspacePath) {
          sendJson(response, 400, {
            error: "workspacePath is required."
          });
          return;
        }
        const session = await runtime.runProjectWorkflow(
          {
            rawText: "Run this project",
            entities: {
              workspacePath: path.resolve(payload.workspacePath),
              key: "PROJECT_RUN",
              value: "true"
            }
          },
          { autoApprove: payload.autoApprove === true }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("run_project_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/set-user-env") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "set_user_env_intent_request");
        const payload = parsed.payload;
        if (!payload.key || !payload.value) {
          sendJson(response, 400, {
            error: "key and value are required."
          });
          return;
        }
        const session = await runtime.setWindowsUserEnvironmentVariable(
          {
            rawText: `Set Windows user environment variable ${payload.key}`,
            entities: {
              workspacePath: basePath,
              key: payload.key,
              value: payload.value
            }
          },
          { autoApprove: payload.autoApprove === true }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("set_user_env_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/add-user-path") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "add_user_path_intent_request");
        const payload = parsed.payload;
        if (!payload.entry) {
          sendJson(response, 400, { error: "entry is required." });
          return;
        }
        const session = await runtime.addWindowsUserPathEntry(
          {
            rawText: `Add ${payload.entry} to my PATH`,
            entities: {
              workspacePath: basePath,
              key: "USER_PATH",
              value: payload.entry
            }
          },
          { autoApprove: payload.autoApprove === true }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("add_user_path_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/winget-install") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "winget_install_intent_request");
        const payload = parsed.payload;
        if (!payload.id) {
          sendJson(response, 400, { error: "id is required." });
          return;
        }
        const session = await runtime.wingetInstallIntent(
          {
            rawText: `Install ${payload.id}`,
            entities: {
              workspacePath: basePath,
              key: payload.id,
              value: "install"
            }
          },
          { autoApprove: payload.autoApprove === true }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("winget_install_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/inspect-port") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "inspect_port_intent_request");
        const payload = parsed.payload;
        if (typeof payload.port !== "number") {
          sendJson(response, 400, { error: "port (number) is required." });
          return;
        }
        const summary = await runtime.inspectPortIntent(
          {
            rawText: `What is using port ${payload.port}?`,
            entities: {
              workspacePath: basePath,
              key: "PORT",
              value: payload.port
            }
          }
        );
        sendJson(response, 200, {
          envelope: buildEnvelope("inspect_port_intent_response", summary, parsed.requestId),
          summary
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/analyze-performance") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "analyze_performance_intent_request");
        const analysis = await runtime.analyzeSystemPerformanceIntent(
          {
            rawText: "Why is my computer slow?",
            entities: {
              workspacePath: basePath
            }
          }
        );
        sendJson(response, 200, {
          envelope: buildEnvelope("analyze_performance_intent_response", analysis, parsed.requestId),
          analysis
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/notepad-type-and-save") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "notepad_type_and_save_intent_request");
        const payload = parsed.payload;
        if (!payload.content || !payload.filename) {
          sendJson(response, 400, { error: "content and filename are required." });
          return;
        }
        const session = await runtime.notepadTypeAndSaveIntent(
          {
            rawText: `Open Notepad, type "${payload.content}", save as ${payload.filename}`,
            entities: {
              workspacePath: basePath,
              content: payload.content,
              filename: payload.filename
            }
          },
          { autoApprove: payload.autoApprove === true }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("notepad_type_and_save_intent_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/browser-search") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "browser_search_intent_request");
        const payload = parsed.payload;
        if (!payload.query) {
          sendJson(response, 400, { error: "query is required." });
          return;
        }
        const result = await runtime.browserSearchIntent(
          {
            rawText: `Search for ${payload.query}`,
            entities: {
              workspacePath: basePath,
              query: payload.query
            }
          }
        );
        sendJson(response, 200, {
          envelope: buildEnvelope("browser_search_intent_response", result, parsed.requestId),
          result
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/privileged/approve") {
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "privileged_approve_request");
        const payload = parsed.payload;
        if (!payload.operation || !payload.scope) {
          sendJson(response, 400, { error: "operation and scope are required." });
          return;
        }
        const approval = await runtime.permissionBroker.issuePrivilegeToken({
          sessionId: payload.sessionId ?? "privileged",
          operation: payload.operation,
          scope: payload.scope,
          approved: payload.approved === true
        });
        sendJson(response, 200, {
          envelope: buildEnvelope("privileged_approve_response", approval, parsed.requestId),
          approval
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/privileged/execute") {
        // Transport adapter only: validate + authenticate (done above), then
        // construct an intent and delegate to the canonical runtime. All
        // planning, policy, permissions, scheduling, privileged execution,
        // observation, verification, rollback, semantic/memory updates, and
        // auditing happen inside submitIntent — this handler contains no
        // business logic and never invokes the privileged helper directly.
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "privileged_execute_request");
        const payload = parsed.payload;
        if (!payload.operation || !payload.scope || !payload.token) {
          sendJson(response, 400, { error: "operation, scope, and token are required." });
          return;
        }
        const mode = payload.mode === "COMMIT" ? "COMMIT" : "VALIDATE";
        const privilegedSessionId = payload.sessionId ?? "privileged";
        // The explicit approval already happened in POST /api/privileged/approve
        // (the single-use token is proof of it), so the policy CONFIRM gate is
        // satisfied here. The mandatory, single-use, operation+scope-bound token
        // — consumed inside the privileged capability — remains the authoritative
        // enforcement: without it the capability refuses to mutate regardless of
        // the policy decision.
        const session = await runtime.submitIntent(
          `Privileged operation ${payload.operation} on ${payload.scope}`,
          {
            workspacePath: basePath,
            operation: payload.operation,
            category: "SYSTEM",
            normalizedGoal: `Privileged ${payload.operation}`,
            entities: {
              scope: payload.scope,
              token: payload.token,
              mode,
              sessionId: privilegedSessionId
            },
            autoApprove: true
          }
        );
        const legacy = buildSessionResponse(session);
        sendJson(response, 200, {
          envelope: buildEnvelope("privileged_execute_response", legacy, parsed.requestId),
          ...legacy
        });
        return;
      }

      if (request.method !== "GET") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const staticPath = parseStaticPath(requestUrl.pathname);
      const desktopRoot = `${desktopDirectory}${path.sep}`;
      if (!staticPath.startsWith(desktopRoot) && staticPath !== path.join(desktopDirectory, "index.html")) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }

      // Static assets are served WITHOUT the API token. The token is never
      // embedded in served HTML/JS because GET / is unauthenticated — any local
      // process or reachable browser context could otherwise scrape it and then
      // drive the mutating API. Clients obtain the token out-of-band: the Electron
      // shell injects it in-process via a contextBridge preload; a plain browser
      // reads it from the daemon stdout banner and enters it in the Connect panel.
      // A BUFFER, NOT A STRING. This read "utf8" for every asset, which is
      // lossless for HTML/CSS/JS and destroys anything else: every byte that is
      // not valid UTF-8 comes back as U+FFFD and goes out re-encoded, so a PNG
      // arrives corrupt with a 200 and a correct content-type. Text is decoded
      // where it is decided that the file IS text.
      const contentType = inferContentType(staticPath);
      const binary = !contentType.startsWith("text/") && !contentType.startsWith("application/javascript");
      const file = await fs.readFile(staticPath, binary ? null : "utf8");
      response.writeHead(200, {
        ...BASE_SECURITY_HEADERS,
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "content-type": contentType
      });
      response.end(file);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(response, 400, {
          error: "Protocol validation error",
          message: error.message
        });
        return;
      }
      if (error?.statusCode === 413) {
        sendJson(response, 413, { error: "Payload too large", message: error.message });
        return;
      }
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      sendJson(response, 500, {
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`SYSCORA daemon listening at http://127.0.0.1:${port}`);
    console.log(`SYSCORA API token: ${apiToken}`);
  });

  // The crash handler needs to ask the runtime what it had already done to the
  // machine. Hung off the server rather than returned beside it, because the
  // one caller treats the return value as an http.Server and calling
  // `.close()` on a wrapper object would be a silent no-op — which is exactly
  // the kind of shutdown that leaked fifteen PowerShell hosts.
  server.syscoraRuntime = runtime;
  return server;
}

if (process.argv[1] === __filename) {
  // SYSCORA_PORT first: the Electron shell sets it explicitly and expects the
  // daemon to bind exactly there. PORT next, which is how a supervising tool
  // (the dev-preview harness) assigns a free port when 4317 is already taken —
  // nothing external depends on 4317, so there is no callback or CORS origin to
  // keep stable. 4317 remains the standalone default.
  // Before anything is constructed: every store this is about to build sits on
  // an experimental Node API, and "it broke because you upgraded Node" is not a
  // conclusion anyone reaches from a stack trace about a database handle.
  reportPreflight();

  const port = Number(process.env.SYSCORA_PORT ?? process.env.PORT ?? "4317");
  const server = startServer({ port });

  // A CRASH IS THE ONE EXIT THAT WAS NOT HANDLED AT ALL.
  //
  // Every path below covers a deliberate stop — a signal, the shell closing
  // stdin, the event loop draining. None of them covers the daemon falling over
  // mid-action, which is the only exit where the user's machine has been
  // changed and nobody has been told. See crash-guard.js; the record it leaves
  // is read and reported here on the next start.
  const stateDirectory = resolveStateDir(process.cwd());
  reportInterruptedRun({ stateDir: stateDirectory });
  installCrashGuards({
    runtime: server.syscoraRuntime ?? null,
    stateDir: stateDirectory,
    closeHost: closeWindowsAutomationHost
  });

  // THE DAEMON HAD NO SHUTDOWN PATH AT ALL, AND THAT IS WHERE THE ORPHANS CAME
  // FROM.
  //
  // `closeWindowsAutomationHost()` was written, correct, and called by exactly
  // one thing: the eval runner. Nothing on a real path called it. So every time
  // the Electron shell quit — which does `daemonProcess.kill()` — the daemon
  // died without ever telling its long-lived PowerShell host to stop, and the
  // host survived its parent. 15 orphans, 801 MB, the oldest seven days old, on
  // the machine whose owner had just asked why it felt slow.
  //
  // Found by `scripts/audit-reachability.mjs`, which exists because this is the
  // eighth defect of exactly this shape: machinery that is correct and that
  // nothing reaches.
  //
  // Killing something is only half an action. A handler that stops the host and
  // then leaves the process running is the same defect wearing a hat, so this
  // closes the host, closes the server, and exits.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return; // a second Ctrl-C must not re-enter this
    closing = true;
    try {
      const stopped = closeWindowsAutomationHost();
      console.log(`SYSCORA daemon shutting down on ${signal}; automation host ${stopped ? "stopped" : "was not running"}`);
    } catch (error) {
      console.error(`SYSCORA daemon: automation host did not stop cleanly: ${error?.message ?? error}`);
    }
    server.close(() => process.exit(0));
    // A client holding a keep-alive socket can stall server.close() forever,
    // and a shutdown that hangs is indistinguishable from one that never ran.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => shutdown(signal));
  }

  // AND ON WINDOWS THE SIGNAL HANDLERS ABOVE DO NOT RUN WHEN THE SHELL QUITS.
  //
  // Node's `child.kill("SIGTERM")` is TerminateProcess on Windows — the child
  // gets no catchable signal and no chance to clean up. Measured with
  // `scripts/probe-daemon-shutdown.mjs`: the daemon exits with code `null` and
  // never prints its shutdown line. The handlers still earn their place for a
  // console Ctrl-C, but the path that actually matters, the Electron shell
  // quitting, would have sailed straight past them. A fix that is unreachable
  // on the platform it was written for is this project's most expensive
  // recurring defect, and this one nearly shipped as another.
  //
  // So the shell closes the daemon's stdin instead, which Windows delivers
  // reliably and which needs no HTTP endpoint and no new attack surface.
  if (!process.stdin.isTTY) {
    process.stdin.on("end", () => shutdown("stdin closed"));
    process.stdin.on("close", () => shutdown("stdin closed"));
    process.stdin.resume();
  }
  // `beforeExit` covers the ordinary case where the event loop drains on its
  // own — no signal is delivered then, and the host would keep it alive anyway.
  process.on("beforeExit", () => {
    try { closeWindowsAutomationHost(); } catch { /* exiting regardless */ }
  });
}
