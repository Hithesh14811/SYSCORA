// Adversarial test: the API token must never be reachable through the
// unauthenticated HTTP surface.
//
// The prior implementation substituted the real token into static HTML at the
// unauthenticated GET / route, so any local process or reachable browser
// context could scrape it and then drive the mutating API. These tests assert
// the token is absent from every statically served asset and from every
// response available without authentication, and that the mutating API still
// rejects unauthenticated callers.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { startServer } from "../../apps/daemon/src/server.js";

async function get(port, pathname, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

describe("Daemon token is not exposed over the unauthenticated surface", () => {
  let server;
  let port;
  let basePath;
  const token = "secret-token-must-not-leak-0123456789";

  before(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tokexp-"));
    process.env.SYSCORA_API_TOKEN = token;
    server = startServer({ port: 0, basePath });
    await new Promise((resolve) => server.on("listening", resolve));
    port = server.address().port;
  });

  after(async () => {
    delete process.env.SYSCORA_API_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it("does not embed the token in the served desktop HTML", async () => {
    const res = await get(port, "/");
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(token), "desktop HTML must not contain the API token");
    // The old placeholder must be gone too — its presence would mean a build
    // step is still expected to inject the token into served HTML.
    assert.ok(!res.text.includes("__SYSCORA_API_TOKEN__"), "token placeholder must not survive in served HTML");
  });

  it("does not embed the token in served demo.js", async () => {
    const res = await get(port, "/demo.js");
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(token), "demo.js must not contain the API token");
  });

  it("does not leak the token in any response header on the open routes", async () => {
    for (const route of ["/", "/demo.js", "/api/health"]) {
      const res = await get(port, route);
      for (const [, value] of res.headers) {
        assert.ok(!String(value).includes(token), `token leaked in a header on ${route}`);
      }
    }
  });

  it("still rejects the mutating API without a token (401)", async () => {
    const res = await get(port, "/api/sessions");
    assert.equal(res.status, 401);
  });

  it("accepts the mutating API with the correct token", async () => {
    const res = await get(port, "/api/sessions", { "x-syscora-token": token });
    assert.equal(res.status, 200);
  });
});
