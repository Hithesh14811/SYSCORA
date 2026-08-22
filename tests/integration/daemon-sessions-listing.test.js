// READING A LIST MUST NOT DESERIALISE EVERY SESSION.
//
// GET /api/sessions called `sessionStore.list()`, which parses every stored
// session in full, and then `buildSessionResponse` VALIDATED each one.
// Measured on the real installation, 22 Aug 2026, 2,234 sessions: `list()`
// 1,238ms against `listSummaries()` 390ms, and a response body of 73.0 MB — to
// draw a menu.
//
// `listSummaries` had been written for exactly this and nothing called it: the
// only callers in the tree were its own unit tests.
//
// These are about SIZE and SHAPE, which is what regressed. The number of
// sessions here is small on purpose — the assertion is that the response does
// not carry a session's contents, and that holds at any scale.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../apps/daemon/src/server.js";

const TOKEN = "sessions-listing-token-0123456789";

async function api(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { "x-syscora-token": TOKEN },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  return { status: response.status, bytes: text.length, json: JSON.parse(text) };
}

// A session with a large transcript, which is the thing that made the real
// response 73 MB. Everything else about it is the minimum the protocol needs.
function bulkySession(index) {
  return {
    sessionId: `session_bulk_${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    currentState: "COMPLETED",
    intent: null,
    plan: null,
    taskResults: [],
    observations: [],
    verifications: [],
    events: [{ eventId: "e1", eventType: "INTENT_RECEIVED", timestamp: new Date().toISOString(), details: { padding: "x".repeat(20000) } }],
    finalResponse: { status: "COMPLETED", message: "done" }
  };
}

describe("GET /api/sessions", () => {
  let server;
  let port;
  let basePath;
  const stored = [];

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-sessions-"));
    process.env.SYSCORA_API_TOKEN = TOKEN;
    for (let index = 0; index < 8; index += 1) stored.push(bulkySession(index));
    const runtime = {
      onSessionEvent: null,
      sessionStore: {
        list: async () => stored,
        listSummaries: async ({ limit = 200 } = {}) => stored.slice(0, limit).map((session) => ({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          state: session.currentState,
          bytes: JSON.stringify(session).length
        }))
      },
      async submitIntent() { throw new Error("not used"); }
    };
    server = startServer({ port: 0, basePath, warmHost: false, runtime });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  test("the default response carries identities, not transcripts", async () => {
    const result = await api(port, "/api/sessions");
    assert.equal(result.status, 200);
    assert.equal(result.json.summary, true);
    assert.equal(result.json.sessions.length, 8);
    assert.ok(result.json.sessions[0].sessionId, "a summary still has to identify the session");
    assert.ok(result.json.sessions[0].state, "and say how it ended, or the menu is useless");
    assert.ok(
      !result.json.text?.includes?.("xxxx") && !JSON.stringify(result.json).includes("x".repeat(1000)),
      "the response contains a session's padding — this is the 73 MB body coming back"
    );
    // 8 sessions × 20 KB of padding is ~160 KB. A summary of them is a few
    // hundred bytes each, so anything near the padding size means the contents
    // travelled.
    assert.ok(result.bytes < 8000, `the summary response was ${result.bytes} bytes; it should be a few hundred per session`);
  });

  test("asking for everything is still possible, and still bounded", async () => {
    const full = await api(port, "/api/sessions?full=true&limit=2");
    assert.equal(full.status, 200);
    assert.equal(full.json.session.sessions.length, 2, "?limit must bound the full form too");
    assert.ok(full.bytes > 20000, "the full form really does carry the transcripts");
  });

  test("a limit is applied to the summary form", async () => {
    const limited = await api(port, "/api/sessions?limit=3");
    assert.equal(limited.json.sessions.length, 3);
  });

  test("a nonsense limit does not remove the bound", async () => {
    for (const query of ["?limit=0", "?limit=-5", "?limit=abc", "?limit=99999999"]) {
      const result = await api(port, `/api/sessions${query}`);
      assert.equal(result.status, 200, `${query} should not error`);
      assert.ok(result.json.limit >= 1 && result.json.limit <= 1000,
        `${query} produced limit ${result.json.limit} — an unbounded list is what this endpoint is being fixed for`);
    }
  });
});
