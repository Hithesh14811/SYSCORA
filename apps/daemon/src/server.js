import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, loadCapabilityPlugins } from "./runtime-factory.js";
import { ValidationError } from "../../../packages/shared-types/src/domain.js";
import { buildEnvelope, parseRequestBodyWithEnvelope } from "../../../packages/protocol/src/envelope.js";
import { buildSessionResponse } from "../../../packages/protocol/src/session-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDirectory = path.resolve(__dirname, "../../desktop");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

// Cap request bodies so a large or endless POST cannot exhaust daemon memory.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB is ample for intents.

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
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
  const safePath = path.normalize(urlPathname).replace(/^(\.\.[/\\])+/, "");
  return path.join(desktopDirectory, safePath);
}

function inferContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}


export function startServer({ port = 4317, basePath = process.cwd(), runtime: injectedRuntime = null, warmHost = true } = {}) {
  const runtime = injectedRuntime ?? createRuntime(basePath);
  const intentRuns = new Map();
  const terminalStates = new Set(["COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED", "TIMED_OUT", "CANCELLED", "ROLLED_BACK", "DENIED", "PLAN_REJECTED"]);

  const writeSse = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const publish = (sessionId, event) => {
    const run = intentRuns.get(sessionId);
    if (!run) return;
    run.events.push(event);
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
  };
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

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok", product: "SYSCORA" });
        return;
      }

      if (requestUrl.pathname.startsWith("/api/") && !isAuthorized(request) && requestUrl.pathname !== "/api/health") {
        sendJson(response, 401, { error: "Unauthorized: missing or invalid x-syscora-token header." });
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
        if (channel === "status") {
          sendJson(response, 200, {
            sessionId,
            status: run.status,
            settled: run.settled,
            terminal: run.terminal,
            eventCount: run.events.length,
            latestEvent: run.events.at(-1) ?? null,
            session: run.session
          });
          return;
        }
        response.writeHead(200, {
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
        const runOptions = {
          workspacePath: basePath,
          autoApprove: payload.autoApprove === true
        };
        if (requestUrl.searchParams.get("sync") === "true") {
          const session = await runtime.submitIntent(payload.text, runOptions);
          const legacy = buildSessionResponse(session);
          sendJson(response, 200, {
            envelope: buildEnvelope("intent_response", legacy, parsed.requestId),
            ...legacy
          });
          return;
        }

        let resolveStarted;
        let rejectStarted;
        let submittedSessionId = null;
        const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
        const runPromise = Promise.resolve(runtime.submitIntent(payload.text, {
          ...runOptions,
          onSessionStarted: (sessionId) => {
            submittedSessionId = sessionId;
            ensureRun(sessionId);
            resolveStarted(sessionId);
          }
        }));
        runPromise.then((session) => settleRun(session.sessionId, session)).catch((error) => {
          if (submittedSessionId) settleRun(submittedSessionId, null, error);
          rejectStarted(error);
        });
        const sessionId = await started;
        sendJson(response, 202, {
          status: "RUNNING",
          sessionId,
          statusUrl: `/api/intents/${sessionId}/status`,
          streamUrl: `/api/intents/${sessionId}/stream`
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/intents/acknowledge") {
        const acknowledgementStartedAt = performance.now();
        const body = await readJsonBody(request);
        const parsed = parseRequestBodyWithEnvelope(body, "intent_acknowledgement_request");
        const payload = parsed.payload;
        if (!payload.text) {
          sendJson(response, 400, { error: "text is required." });
          return;
        }
        const acknowledgement = await runtime.acknowledgeIntent(payload.text);
        acknowledgement.latencyMs = Math.round(performance.now() - acknowledgementStartedAt);
        sendJson(response, 200, {
          envelope: buildEnvelope("intent_acknowledgement_response", acknowledgement, parsed.requestId),
          acknowledgement
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const sessions = await runtime.sessionStore.list();
        const legacy = buildSessionResponse({ sessions });
        sendJson(response, 200, {
          envelope: buildEnvelope("sessions_response", legacy),
          ...legacy
        });
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
      const file = await fs.readFile(staticPath, "utf8");
      response.writeHead(200, { "content-type": inferContentType(staticPath) });
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

  return server;
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.SYSCORA_PORT ?? "4317");
  startServer({ port });
}
