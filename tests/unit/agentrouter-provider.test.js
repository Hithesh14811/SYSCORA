// AgentRouter provider — offline unit tests (fetch is stubbed). These prove the
// gateway contract SYSCORA depends on without touching the network:
//   - the WAF-clearing User-Agent is always sent (a plain Bearer call 401s),
//   - the OpenAI /v1/chat/completions shape is used and JSON is extracted,
//   - model selection is per-call/config (one gateway, many models),
//   - loadModelConfig wires provider/key/model from a local config file.
// The single live smoke against the real gateway lives separately and is opt-in.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  AgentRouterModelProvider,
  AGENTROUTER_MODELS,
  createModelProvider
} from "../../packages/model-providers/src/index.js";
import { loadModelConfig } from "../../apps/daemon/src/model-config.js";

const withStubbedFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const okChatResponse = (content) => ({
  ok: true,
  status: 200,
  async json() {
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  }
});

test("catalog exposes the three MVP models through one gateway", () => {
  assert.deepEqual(AGENTROUTER_MODELS, ["claude-opus-4-8", "gpt-5.5", "glm-5.2"]);
});

test("sends the WAF-clearing User-Agent and Bearer auth on every request", async () => {
  const provider = new AgentRouterModelProvider({ apiKey: "sk-test", model: "claude-opus-4-8" });
  await withStubbedFetch(
    () => okChatResponse('{"normalizedGoal":"x","category":"SYSTEM"}'),
    async (calls) => {
      await provider.generateStructured("classify", { type: "object", required: [], properties: {} });
      const { url, init } = calls[0];
      assert.equal(url, "https://agentrouter.org/v1/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer sk-test");
      assert.match(init.headers["User-Agent"], /claude-cli/);
    }
  );
});

test("extracts JSON even when the model wraps it in prose/fences", async () => {
  const provider = new AgentRouterModelProvider({ apiKey: "sk-test" });
  await withStubbedFetch(
    () => okChatResponse('Sure! ```json\n{"normalizedGoal":"list processes","category":"SYSTEM"}\n``` done'),
    async () => {
      const out = await provider.generateStructured("x", { type: "object", required: [], properties: {} });
      assert.equal(out.normalizedGoal, "list processes");
      assert.equal(out.category, "SYSTEM");
    }
  );
});

test("per-call model option overrides the default (one gateway, many models)", async () => {
  const provider = new AgentRouterModelProvider({ apiKey: "sk-test", model: "claude-opus-4-8" });
  await withStubbedFetch(
    () => okChatResponse('{"ok":true}'),
    async (calls) => {
      await provider.generateStructured("x", { type: "object", required: [], properties: {} }, { model: "glm-5.2" });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, "glm-5.2");
    }
  );
});

test("normalizes a base URL without /v1", () => {
  const p = new AgentRouterModelProvider({ apiKey: "k", baseUrl: "https://agentrouter.org" });
  assert.equal(p.baseUrl, "https://agentrouter.org/v1");
});

test("createModelProvider returns AgentRouter when a key is present, Mock otherwise", () => {
  const withKey = createModelProvider({ provider: "agentrouter", apiKey: "sk-test" });
  assert.equal(withKey.name, "agentrouter");
  const noKey = createModelProvider({ provider: "agentrouter" });
  assert.equal(noKey.name, "mock");
});

test("loadModelConfig reads provider/key/model but does not infer external-AI consent", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-cfg-"));
  const prev = { p: process.env.SYSCORA_MODEL_PROVIDER, k: process.env.SYSCORA_MODEL_API_KEY, a: process.env.AGENTROUTER_API_KEY, c: process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES };
  delete process.env.SYSCORA_MODEL_PROVIDER;
  delete process.env.SYSCORA_MODEL_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
  delete process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES;
  try {
    await fs.mkdir(path.join(base, ".syscora"), { recursive: true });
    await fs.writeFile(
      path.join(base, ".syscora", "config.json"),
      JSON.stringify({ model: { provider: "agentrouter", apiKey: "sk-file", model: "gpt-5.5" } })
    );
    const cfg = loadModelConfig(base);
    assert.equal(cfg.provider, "agentrouter");
    assert.equal(cfg.apiKey, "sk-file");
    assert.equal(cfg.model, "gpt-5.5");
    assert.deepEqual(cfg.externalAIConsent.scopes, ["EXTERNAL_AI_DISABLED"]);
  } finally {
    if (prev.p !== undefined) process.env.SYSCORA_MODEL_PROVIDER = prev.p;
    if (prev.k !== undefined) process.env.SYSCORA_MODEL_API_KEY = prev.k;
    if (prev.a !== undefined) process.env.AGENTROUTER_API_KEY = prev.a;
    if (prev.c !== undefined) process.env.SYSCORA_EXTERNAL_AI_CONSENT_SCOPES = prev.c;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("env vars override the local config file", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-cfg-"));
  const prev = process.env.SYSCORA_MODEL_PROVIDER;
  process.env.SYSCORA_MODEL_PROVIDER = "mock";
  try {
    await fs.mkdir(path.join(base, ".syscora"), { recursive: true });
    await fs.writeFile(path.join(base, ".syscora", "config.json"), JSON.stringify({ model: { provider: "agentrouter" } }));
    const cfg = loadModelConfig(base);
    assert.equal(cfg.provider, "mock");
  } finally {
    if (prev === undefined) delete process.env.SYSCORA_MODEL_PROVIDER;
    else process.env.SYSCORA_MODEL_PROVIDER = prev;
    await fs.rm(base, { recursive: true, force: true });
  }
});
