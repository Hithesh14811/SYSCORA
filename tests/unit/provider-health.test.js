import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicModelProvider } from "../../packages/model-providers/src/index.js";

test("Anthropic health performs an authenticated side-effect-free request instead of trusting key shape", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };
  const provider = new AnthropicModelProvider({ apiKey: "fake-test-key", baseUrl: "https://api.anthropic.test/v1" });
  const health = await provider.healthCheck({ timeoutMs: 100 });
  assert.equal(health.ok, true);
  assert.equal(request.url, "https://api.anthropic.test/v1/models");
  assert.equal(request.options.headers["x-api-key"], "fake-test-key");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
});

test("Anthropic health reports definite authentication failure", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const health = await new AnthropicModelProvider({ apiKey: "fake-test-key" }).healthCheck({ timeoutMs: 100 });
  assert.deepEqual(health, { ok: false, status: 401, model: "claude-sonnet-5" });
});
