// The chat surface follows a run by READING ITS EVENT STREAM.
//
// The daemon has published /api/intents/:id/stream since it was written, and
// this client polled /status four times a second and kept only the single most
// recent event. Every reason the agent gave for what it was doing was computed,
// serialized, sent, and dropped in the browser — which is the whole reason a
// multi-step run looked like one opaque pause.
//
// These tests pin three things: the stream is consumed when it is available,
// polling still resolves a run when it is not, and the synchronous contract is
// untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readIntentSession } from "../../apps/desktop/intent-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// An SSE response shaped exactly as the daemon writes it: one `data:` line per
// frame, frames separated by a blank line.
function eventStreamResponse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("desktop intent client streams every runtime event and resolves the session", async () => {
  const session = { sessionId: "session_stream", finalResponse: { status: "COMPLETED", message: "Done" } };
  const events = [
    { eventType: "INTENT_RECEIVED", details: { rawText: "hi" } },
    { type: "AGENT_SAYS", text: "Reading the current volume first." },
    { eventType: "ADAPTIVE_ACTION_STARTING", details: { step: 1, action: { capability: "command.run" } } },
    { eventType: "ADAPTIVE_ACTION_VERIFIED", details: { step: 1, capability: "command.run" } },
    { type: "SESSION_SETTLED", sessionId: session.sessionId, status: "COMPLETED", terminal: true, error: null },
    { type: "STREAM_END", sessionId: session.sessionId, status: "COMPLETED" }
  ];
  const seen = [];

  const result = await readIntentSession(jsonResponse(202, {
    status: "RUNNING",
    sessionId: session.sessionId,
    statusUrl: `/api/intents/${session.sessionId}/status`,
    streamUrl: `/api/intents/${session.sessionId}/stream`
  }), {
    pollIntervalMs: 0,
    onEvent: (event) => seen.push(event.eventType ?? event.type),
    fetchImpl: async (url) => url.endsWith("/stream")
      ? eventStreamResponse(events)
      : jsonResponse(200, { sessionId: session.sessionId, status: "COMPLETED", terminal: true, session })
  });

  assert.deepEqual(result, session);
  // The settle/end control frames are the client's business, not the UI's.
  assert.deepEqual(seen, [
    "INTENT_RECEIVED",
    "AGENT_SAYS",
    "ADAPTIVE_ACTION_STARTING",
    "ADAPTIVE_ACTION_VERIFIED"
  ]);
});

test("desktop intent client falls back to polling when no stream can be opened", async () => {
  const session = { sessionId: "session_async", finalResponse: { status: "ANSWERED", message: "Hi" } };
  const statuses = [
    { sessionId: session.sessionId, status: "RUNNING", terminal: false, session: null },
    { sessionId: session.sessionId, status: "COMPLETED", terminal: true, session }
  ];
  const requestedUrls = [];

  const result = await readIntentSession(jsonResponse(202, {
    status: "RUNNING",
    sessionId: session.sessionId,
    statusUrl: `/api/intents/${session.sessionId}/status`,
    streamUrl: `/api/intents/${session.sessionId}/stream`
  }), {
    pollIntervalMs: 0,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.endsWith("/stream")) throw new Error("streaming unavailable");
      return jsonResponse(200, statuses.shift());
    }
  });

  assert.deepEqual(result, session);
  assert.deepEqual(requestedUrls, [
    `/api/intents/${session.sessionId}/stream`,
    `/api/intents/${session.sessionId}/status`,
    `/api/intents/${session.sessionId}/status`
  ]);
});

test("desktop intent client preserves synchronous compatibility", async () => {
  const session = { sessionId: "session_sync", finalResponse: { status: "COMPLETED" } };
  const result = await readIntentSession(jsonResponse(200, { envelope: { payload: { session } } }), {
    fetchImpl: async () => { throw new Error("must not poll a synchronous response"); }
  });
  assert.deepEqual(result, session);
});

test("desktop intent client returns a resumable approval session without waiting for terminal", async () => {
  const session = { sessionId: "session_approval", finalResponse: { status: "AWAITING_APPROVAL" } };
  const result = await readIntentSession(jsonResponse(202, {
    status: "RUNNING",
    sessionId: session.sessionId,
    statusUrl: `/api/intents/${session.sessionId}/status`
  }), {
    pollIntervalMs: 0,
    fetchImpl: async () => jsonResponse(200, {
      sessionId: session.sessionId,
      status: "AWAITING_APPROVAL",
      settled: true,
      terminal: false,
      session
    })
  });
  assert.deepEqual(result, session);
});

test("both desktop intent forms consume the shared async response handler", () => {
  const demoHtml = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.html"), "utf8");
  const demoJs = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.js"), "utf8");
  const consoleJs = fs.readFileSync(path.join(repoRoot, "apps/desktop/app.js"), "utf8");

  assert.match(demoHtml, /<script src="\/demo\.js" type="module"><\/script>/);
  assert.match(demoJs, /readIntentSession\(res,\s*\{/);
  assert.match(consoleJs, /readIntentSession\(response\)/);
  assert.doesNotMatch(demoJs, /No response from the runtime\./);
});

// The chat renders the agent's reasoning and each tool call as it happens; that
// is the difference this whole surface exists for, so it is asserted rather than
// left to be re-broken by the next refactor.
test("the chat surface renders narration and live tool calls", () => {
  const demoJs = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.js"), "utf8");
  assert.match(demoJs, /AGENT_SAYS/);
  assert.match(demoJs, /ADAPTIVE_ACTION_STARTING/);
  assert.match(demoJs, /ADAPTIVE_ACTION_VERIFIED/);
  assert.match(demoJs, /onEvent:/);
});
