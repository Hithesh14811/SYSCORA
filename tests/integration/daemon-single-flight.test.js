// ONE MACHINE, ONE TASK AT A TIME — ON EVERY ROUTE, NOT MOST OF THEM.
//
// `/api/intents` already refuses a second request with 409 while one is
// running, and the comment above it explains exactly why: two runs share one
// pointer, one focused window and one agent state, so they interleave clicks
// and keystrokes into each other's windows and each transcript describes half
// of what happened.
//
// The guard looked for an unsettled entry in `intentRuns`. The asynchronous
// route puts itself there through `onSessionStarted`. The `?sync=true` route
// called `runtime.submitIntent` directly and never registered at all — so it
// was invisible to the check, and any number of synchronous requests ran at
// once, each driving the same physical mouse. That is the shape this project
// keeps producing: a correct guard with a route that walks past it.
//
// These run against the real HTTP surface with a fake runtime, so there is no
// model, no cost and no GUI — the thing under test is the daemon's own
// bookkeeping.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../apps/daemon/src/server.js";

const TOKEN = "single-flight-token-0123456789";

async function api(port, method, pathname, { body, timeoutMs = 15000 } = {}) {
  const headers = { "x-syscora-token": TOKEN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

// A runtime whose run does not finish until the test says so. That is the whole
// point: "is a second request refused WHILE the first is still going" cannot be
// asked of a runtime that returns immediately.
function createBlockingRuntime() {
  let counter = 0;
  const started = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return {
    onSessionEvent: null,
    sessionStore: { list: async () => [] },
    started,
    release: () => release(),
    async submitIntent(rawText, options = {}) {
      counter += 1;
      const sessionId = `session_blocking_${counter}`;
      started.push({ sessionId, rawText });
      options.onSessionStarted?.(sessionId);
      await held;
      return {
        sessionId,
        createdAt: new Date().toISOString(),
        currentState: "COMPLETED",
        intent: null, plan: null, taskResults: [], observations: [], verifications: [], events: [],
        finalResponse: { status: "COMPLETED", message: `handled: ${rawText}` }
      };
    }
  };
}

describe("the daemon runs one request at a time on every route", () => {
  let server;
  let port;
  let basePath;
  let runtime;

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-single-flight-"));
    process.env.SYSCORA_API_TOKEN = TOKEN;
    runtime = createBlockingRuntime();
    server = startServer({ port: 0, basePath, warmHost: false, runtime });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    runtime.release();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  test("a second synchronous request is refused while the first is still running", async () => {
    // Deliberately not awaited: this one is meant to be in flight.
    const first = api(port, "POST", "/api/intents?sync=true", { body: { text: "open notepad and type" } });
    // Wait for the runtime to actually be inside the run, rather than sleeping
    // and hoping — a timing-based test here would pass on a fast machine and
    // flake on a loaded one, which is how a guard gets deleted as "flaky".
    while (runtime.started.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await api(port, "POST", "/api/intents?sync=true", { body: { text: "click something else" } });
    assert.equal(second.status, 409,
      "two synchronous requests both drove the one physical mouse — the guard only saw the async route");
    assert.match(second.json?.error ?? "", /already working/);
    assert.equal(runtime.started.length, 1, "the refused request must not have reached the runtime at all");

    runtime.release();
    const settled = await first;
    assert.equal(settled.status, 200);
  });

  test("the lock is released when the run finishes, not held forever", async () => {
    // The previous test released the gate, so this one runs straight through.
    const after = await api(port, "POST", "/api/intents?sync=true", { body: { text: "a later request" } });
    assert.equal(after.status, 200,
      "a lock that is never released turns a one-at-a-time rule into a one-ever rule");
  });

  test("an asynchronous request is refused while a synchronous one is running", async () => {
    const blocking = createBlockingRuntime();
    const localServer = startServer({ port: 0, basePath, warmHost: false, runtime: blocking });
    await new Promise((resolve) => localServer.on("listening", resolve));
    const localPort = localServer.address().port;
    try {
      const first = api(localPort, "POST", "/api/intents?sync=true", { body: { text: "the sync one" } });
      while (blocking.started.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await api(localPort, "POST", "/api/intents", { body: { text: "the async one" } });
      assert.equal(second.status, 409, "a synchronous run must block the asynchronous route too — same mouse");
      assert.equal(blocking.started.length, 1);

      blocking.release();
      await first;
    } finally {
      blocking.release();
      await new Promise((resolve) => localServer.close(resolve));
    }
  });

  test("a synchronous request that throws still releases the lock", async () => {
    const failing = {
      onSessionEvent: null,
      sessionStore: { list: async () => [] },
      calls: 0,
      async submitIntent(rawText, options) {
        this.calls += 1;
        options.onSessionStarted?.(`session_failing_${this.calls}`);
        throw new Error("the tool exploded");
      }
    };
    const localServer = startServer({ port: 0, basePath, warmHost: false, runtime: failing });
    await new Promise((resolve) => localServer.on("listening", resolve));
    const localPort = localServer.address().port;
    try {
      const first = await api(localPort, "POST", "/api/intents?sync=true", { body: { text: "this will throw" } });
      assert.ok(first.status >= 400, "a failing run should report the failure");

      const second = await api(localPort, "POST", "/api/intents?sync=true", { body: { text: "the next one" } });
      assert.notEqual(second.status, 409,
        "a run that threw left the lock held, so SYSCORA was 'already working' forever after one error");
      assert.equal(failing.calls, 2, "the second request must actually have reached the runtime");
    } finally {
      await new Promise((resolve) => localServer.close(resolve));
    }
  });

  test("Stop waits for cooperative cancellation and releases the next request", async () => {
    let calls = 0;
    const cancellable = {
      onSessionEvent: null,
      sessionStore: { list: async () => [] },
      async submitIntent(rawText, options = {}) {
        calls += 1;
        const sessionId = `session_stop_${calls}`;
        options.onSessionStarted?.(sessionId);
        if (calls === 1) {
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        }
        return {
          sessionId,
          createdAt: new Date().toISOString(),
          currentState: calls === 1 ? "CANCELLED" : "COMPLETED",
          intent: null, plan: null, taskResults: [], observations: [], verifications: [], events: [],
          finalResponse: {
            status: calls === 1 ? "CANCELLED" : "COMPLETED",
            message: calls === 1 ? "Stopped." : `handled: ${rawText}`
          }
        };
      }
    };
    const localServer = startServer({ port: 0, basePath, warmHost: false, runtime: cancellable });
    await new Promise((resolve) => localServer.on("listening", resolve));
    const localPort = localServer.address().port;
    try {
      const first = await api(localPort, "POST", "/api/intents", { body: { text: "wait for a phone" } });
      assert.equal(first.status, 202);
      const stopped = await api(localPort, "POST", `/api/intents/${first.json.sessionId}/stop`, {});
      assert.equal(stopped.status, 200);
      assert.equal(stopped.json.settled, true);

      const next = await api(localPort, "POST", "/api/intents?sync=true", { body: { text: "new task" } });
      assert.equal(next.status, 200, "a cancelled request left the global single-flight claim held");
      assert.equal(calls, 2);
    } finally {
      await new Promise((resolve) => localServer.close(resolve));
    }
  });
});
