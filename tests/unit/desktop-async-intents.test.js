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

test("desktop intent client follows a 202 status URL to its terminal session", async () => {
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
      return jsonResponse(200, statuses.shift());
    }
  });

  assert.deepEqual(result, session);
  assert.deepEqual(requestedUrls, [
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

test("both desktop intent forms consume the shared async response handler", () => {
  const demoHtml = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.html"), "utf8");
  const demoJs = fs.readFileSync(path.join(repoRoot, "apps/desktop/demo.js"), "utf8");
  const consoleJs = fs.readFileSync(path.join(repoRoot, "apps/desktop/app.js"), "utf8");

  assert.match(demoHtml, /<script src="\/demo\.js" type="module"><\/script>/);
  assert.match(demoJs, /readIntentSession\(res\)/);
  assert.match(consoleJs, /readIntentSession\(response\)/);
  assert.doesNotMatch(demoJs, /No response from the runtime\./);
});
