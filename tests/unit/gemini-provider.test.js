import test from "node:test";
import assert from "node:assert/strict";
import { GeminiModelProvider, createModelProviderChain } from "../../packages/model-providers/src/index.js";

const withFetch = async (implementation, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { await run(); } finally { globalThis.fetch = original; }
};

test("Gemini structured generation uses native endpoint, API key header, and JSON schema", async () => {
  let call;
  await withFetch(async (url, init) => {
    call = { url, init };
    return {
      ok: true,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: '{"reply":"OK"}' }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
        };
      }
    };
  }, async () => {
    const provider = new GeminiModelProvider({ apiKey: "google-key", model: "gemini-3.6-flash" });
    const schema = { type: "object", required: ["reply"], properties: { reply: { type: "string" } } };
    assert.deepEqual(await provider.generateStructured("say OK", schema), { reply: "OK" });
    assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    assert.equal(call.init.headers["x-goog-api-key"], "google-key");
    assert.deepEqual(JSON.parse(call.init.body).generationConfig.responseJsonSchema, schema);
  });
});

test("configured Gemini primary is followed by two credential-specific Mistral fallbacks", () => {
  const chain = createModelProviderChain({
    provider: "gemini",
    apiKey: "google-key",
    model: "gemini-3.6-flash",
    fallbackProviderConfigs: [
      { provider: "mistral", apiKey: "mistral-one", model: "mistral-medium-3.5" },
      { provider: "mistral", apiKey: "mistral-two", model: "mistral-medium-3.5" }
    ]
  });
  assert.deepEqual(chain.providers.map((provider) => provider.name), ["gemini", "mistral", "mistral"]);
  assert.deepEqual(chain.providers.map((provider) => provider.model), ["gemini-3.6-flash", "mistral-medium-3.5", "mistral-medium-3.5"]);
});
