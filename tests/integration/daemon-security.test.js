// Daemon HTTP security surface tests.
//
// Starts the real daemon on an ephemeral port and validates the security
// guarantees of the HTTP boundary:
//   - /api/health is open (liveness), all other /api/* require the token,
//   - a wrong token is rejected with 401 (constant-time compare underneath),
//   - request bodies over the cap are rejected with 413 (memory-exhaustion guard),
//   - directory traversal on static paths is forbidden.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { startServer } from "../../apps/daemon/src/server.js";

async function request(port, method, pathname, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h["x-syscora-token"] = token;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

describe("Daemon HTTP security surface", () => {
  let server;
  let port;
  let basePath;
  const token = "test-token-abcdef0123456789";

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-daemon-"));
    process.env.SYSCORA_API_TOKEN = token;
    server = startServer({ port: 0, basePath, warmHost: false });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    delete process.env.SYSCORA_API_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("serves /api/health without a token", async () => {
    const res = await request(port, "GET", "/api/health");
    assert.equal(res.status, 200);
    assert.match(res.text, /SYSCORA/);
  });

  it("rejects /api/sessions without a token (401)", async () => {
    const res = await request(port, "GET", "/api/sessions");
    assert.equal(res.status, 401);
  });

  it("rejects a wrong token (401)", async () => {
    const res = await request(port, "GET", "/api/sessions", { token: "wrong-token" });
    assert.equal(res.status, 401);
  });

  it("accepts the correct token", async () => {
    const res = await request(port, "GET", "/api/sessions", { token });
    assert.equal(res.status, 200);
  });

  it("protects the provider-settings surface and never returns a key", async () => {
    const unauthorized = await request(port, "GET", "/api/settings/model");
    assert.equal(unauthorized.status, 401);

    const authorized = await request(port, "GET", "/api/settings/model", { token });
    assert.equal(authorized.status, 200);
    const body = JSON.parse(authorized.text);
    assert.equal(Object.hasOwn(body, "apiKey"), false);
    assert.equal(Object.hasOwn(body, "primaryApiKey"), false);
    assert.match(authorized.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.equal(authorized.headers.get("x-content-type-options"), "nosniff");
  });

  it("rejects an oversized request body (413)", async () => {
    const huge = "x".repeat(1024 * 1024 + 1024); // just over 1 MiB
    const res = await request(port, "POST", "/api/intents", {
      token,
      body: JSON.stringify({ text: huge })
    });
    assert.equal(res.status, 413);
  });

  it("forbids directory traversal on static paths", async () => {
    const res = await request(port, "GET", "/../../package.json");
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  });
});
