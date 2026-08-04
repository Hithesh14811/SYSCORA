// GAP 3 — async intent submission, live progress, and bounded sessions.
//
// The original failure was a fully synchronous POST /api/intents that blocked
// 20+ seconds on a cold PowerShell-host start with no UI feedback. These tests
// pin the three properties that fix it:
//   - submission returns almost immediately with a sessionId,
//   - progress is observable (polling and SSE) and reaches a terminal state,
//   - the legacy blocking response shape is still available on explicit opt-in.
//
// The HTTP/streaming contract is tested against an INJECTED runtime so it is
// fast and deterministic and does not compete for the machine when the whole
// suite runs concurrently. One test drives the REAL pipeline to prove the
// sync-opt-in contract still holds end to end; it is hard-bounded so a loaded
// machine can never hang the suite. The full real-pipeline behaviour is
// additionally covered by tests/live/gap3-async-live.mjs.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { startServer } from "../../apps/daemon/src/server.js";
import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";

const TOKEN = "async-intent-token-0123456789";
// A read-only request that produces a non-empty task graph and reaches
// COMPLETED through the real pipeline, without touching the GUI.
const REAL_INTENT_TEXT = "give me a summary of this computer";

async function api(port, method, pathname, { body, headers = {}, timeoutMs = 30000 } = {}) {
  const requestHeaders = { "x-syscora-token": TOKEN, ...headers };
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    // No request may block indefinitely: an unbounded fetch would defeat the
    // very deadline these tests exist to prove.
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (SSE) */ }
  return { status: response.status, text, json };
}

// A runtime that behaves like the real one at the seams the daemon depends on:
// it announces its sessionId synchronously, emits trace events while running,
// and settles into a valid ExecutionSession.
function createFakeRuntime({ stepDelayMs = 15 } = {}) {
  let counter = 0;
  return {
    onSessionEvent: null,
    sessionStore: { list: async () => [] },
    async submitIntent(rawText, options = {}) {
      counter += 1;
      const sessionId = `session_fake_${counter}`;
      const awaitingApproval = rawText === "needs approval";
      const session = {
        sessionId,
        createdAt: new Date().toISOString(),
        currentState: awaitingApproval ? "REQUEST_CONFIRMATION_IF_REQUIRED" : "COMPLETED",
        intent: null,
        plan: null,
        taskResults: [],
        observations: [],
        verifications: [],
        events: [],
        finalResponse: awaitingApproval
          ? { status: "AWAITING_APPROVAL", reason: "Approval required" }
          : { status: "COMPLETED", message: `handled: ${rawText}` }
      };
      options.onSessionStarted?.(sessionId);
      for (const eventType of ["INTENT_RECEIVED", "PLAN_GENERATED", "TASK_EXECUTED", "FINAL_VERIFICATION_COMPLETED"]) {
        await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
        const event = { eventId: `event_${eventType}`, eventType, timestamp: new Date().toISOString(), details: {} };
        session.events.push(event);
        this.onSessionEvent?.(sessionId, event);
      }
      return session;
    }
  };
}

describe("Daemon async intent HTTP contract", () => {
  let server;
  let port;
  let basePath;

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-async-"));
    process.env.SYSCORA_API_TOKEN = TOKEN;
    // HTTP surface only: no GUI automation, so do not spawn the PowerShell host.
    server = startServer({ port: 0, basePath, warmHost: false, runtime: createFakeRuntime() });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    delete process.env.SYSCORA_API_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("returns a sessionId almost immediately instead of blocking on the work", async () => {
    const startedAt = Date.now();
    const response = await api(port, "POST", "/api/intents", {
      body: { text: "anything", autoApprove: true }
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 202);
    assert.equal(response.json.status, "RUNNING");
    assert.ok(response.json.sessionId, "a sessionId must be returned to poll against");
    assert.ok(response.json.statusUrl && response.json.streamUrl);
    assert.ok(
      elapsedMs < 300,
      `submission should return in well under 300ms, took ${elapsedMs}ms`
    );
  });

  it("reaches a terminal state through /status polling", async () => {
    const submitted = await api(port, "POST", "/api/intents", {
      body: { text: "anything", autoApprove: true }
    });
    const { sessionId } = submitted.json;

    const deadline = Date.now() + 20000;
    let status = null;
    while (Date.now() < deadline) {
      const polled = await api(port, "GET", `/api/intents/${sessionId}/status`);
      assert.equal(polled.status, 200);
      assert.equal(polled.json.sessionId, sessionId);
      if (polled.json.terminal) { status = polled.json; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(status, "polling must reach a terminal state within the deadline");
    assert.equal(status.status, "COMPLETED");
    assert.ok(status.eventCount > 0, "a finished run must expose its trace events");
    assert.ok(status.session, "a terminal run must expose the full session");
  });

  it("streams live progress events over SSE and closes on completion", async () => {
    const submitted = await api(port, "POST", "/api/intents", {
      body: { text: "anything", autoApprove: true }
    });
    const { sessionId } = submitted.json;

    const stream = await fetch(`http://127.0.0.1:${port}/api/intents/${sessionId}/stream`, {
      headers: { "x-syscora-token": TOKEN },
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const received = [];
    let buffer = "";
    let ended = false;
    while (!ended) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        received.push(event);
        if (event.type === "STREAM_END") ended = true;
      }
    }

    assert.ok(ended, "the stream must terminate rather than hang open");
    // The opening event is emitted before the HTTP response is even sent, so
    // this also proves the replay buffer works for a late subscriber.
    assert.ok(
      received.some((event) => event.eventType === "INTENT_RECEIVED"),
      "the live stream must carry real session trace events"
    );
    assert.ok(received.some((event) => event.eventType === "FINAL_VERIFICATION_COMPLETED"));
    assert.ok(received.some((event) => event.type === "SESSION_SETTLED"));
  });

  it("settles and exposes a resumable approval session without marking it terminal", async () => {
    const submitted = await api(port, "POST", "/api/intents", { body: { text: "needs approval" } });
    const deadline = Date.now() + 20000;
    let status = null;
    while (Date.now() < deadline) {
      const polled = await api(port, "GET", submitted.json.statusUrl);
      if (polled.json.settled) { status = polled.json; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(status, "approval session must settle within the deadline");
    assert.equal(status.status, "AWAITING_APPROVAL");
    assert.equal(status.terminal, false);
    assert.equal(status.session.finalResponse.status, "AWAITING_APPROVAL");
  });

  it("returns 404 for an unknown session on both progress channels", async () => {
    const status = await api(port, "GET", "/api/intents/session_missing/status");
    const stream = await api(port, "GET", "/api/intents/session_missing/stream");
    assert.equal(status.status, 404);
    assert.equal(stream.status, 404);
  });

  it("still rejects an oversized body before dispatching any work (413)", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/intents`, {
      method: "POST",
      headers: { "x-syscora-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1024 * 1024 + 1024) }),
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(response.status, 413);
  });
});

describe("Legacy synchronous intent shape (real pipeline)", () => {
  let server;
  let port;
  let basePath;

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-sync-"));
    process.env.SYSCORA_API_TOKEN = TOKEN;
    server = startServer({ port: 0, basePath, warmHost: false });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    delete process.env.SYSCORA_API_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("still serves the blocking single-response shape on explicit opt-in", async () => {
    const response = await api(port, "POST", "/api/intents?sync=true", {
      body: { text: REAL_INTENT_TEXT, autoApprove: true },
      timeoutMs: 240000
    });
    assert.equal(response.status, 200);
    // The pre-change contract: ONE response carrying the whole finished
    // session, with no polling required.
    assert.ok(response.json.session, "sync callers must still receive the full session");
    assert.ok(response.json.session.sessionId);
    assert.equal(response.json.session.finalResponse.status, "COMPLETED");
    assert.ok(response.json.envelope, "sync callers must still receive the protocol envelope");
    assert.equal(response.json.envelope.type, "intent_response");
  });
});

describe("Session wall-clock timeout", () => {
  it("resolves to a clean timeout status rather than running past its deadline", async () => {
    // A runtime whose intent classification never settles. Without a top-level
    // deadline this hangs forever; the test's own wall-clock assertion below is
    // what proves the deadline is real (a status check alone would hang too).
    const runtime = new AgentRuntime({
      sessionStore: { save: async () => {}, list: async () => [], load: async () => null },
      auditRepository: { append: async () => {} },
      intentEngine: { classify: () => new Promise(() => {}) },
      capabilityRegistry: { get: () => null, getCatalog: () => [] }
    });

    const timeoutMs = 1200;
    const startedAt = Date.now();
    const session = await runtime.submitIntent("a request that never classifies", {
      maxElapsedTime: timeoutMs
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(session.finalResponse.status, "TIMED_OUT");
    assert.equal(session.finalResponse.timeoutMs, timeoutMs);
    assert.equal(session.deadlineExceeded, true);
    assert.ok(
      elapsedMs < timeoutMs + 2000,
      `submitIntent must return at its deadline; took ${elapsedMs}ms for a ${timeoutMs}ms budget`
    );
  });
});
