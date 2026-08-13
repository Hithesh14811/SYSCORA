import test from "node:test";
import assert from "node:assert/strict";
import {
  ConsentAwareModelProvider,
  FailoverModelProvider
} from "../../packages/model-providers/src/index.js";
import {
  ExternalAIConsentScope as Scope,
  ExternalAIDataCategory as Category
} from "../../packages/shared-types/src/external-context.js";

const schema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
};

function remoteProvider(name, model, { fail = false, capture = null } = {}) {
  return {
    name,
    model,
    baseUrl: `https://api.${name}.example/v1`,
    apiKey: `${name}-secret-must-not-appear`,
    capabilities: () => ({ name, model, remote: true, structured: true }),
    async generateStructured(prompt) {
      capture?.(prompt);
      if (fail) throw new Error("provider unavailable");
      return { ok: true };
    }
  };
}

const reasoningScopes = [
  Scope.SANITIZED_REASONING,
  Scope.STRUCTURED_UI_CONTEXT
];

test("sanitized reasoning consent survives an intentional provider switch", async () => {
  for (const provider of [
    remoteProvider("provider-a", "model-a"),
    remoteProvider("provider-b", "model-b")
  ]) {
    const guarded = new ConsentAwareModelProvider({ provider, consentScopes: reasoningScopes });
    assert.deepEqual(
      await guarded.generateStructured("safe task", schema, {
        externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
      }),
      { ok: true }
    );
  }
});

test("DeepSeek uses scope consent without an AgentRouter/model-specific authorization", async () => {
  const guarded = new ConsentAwareModelProvider({
    provider: remoteProvider("deepseek", "deepseek-v4-flash"),
    consentScopes: reasoningScopes
  });
  await guarded.generateStructured("task", schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
  });
  assert.equal(guarded.getExternalRequestProvenance()[0].provider, "deepseek");
});

test("OpenAI, Anthropic, and future compatible providers share the same mechanism", async () => {
  for (const [name, model] of [["openai", "gpt-x"], ["anthropic", "claude-x"], ["future-compatible", "model-x"]]) {
    const guarded = new ConsentAwareModelProvider({
      provider: remoteProvider(name, model),
      consentScopes: reasoningScopes
    });
    const result = await guarded.generateStructured("task", schema, {
      externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
    });
    assert.equal(result.ok, true);
  }
});

test("provider switching and failover cannot bypass sanitization", async () => {
  const received = [];
  const chain = new FailoverModelProvider([
    remoteProvider("primary", "one", { fail: true, capture: (prompt) => received.push(prompt) }),
    remoteProvider("fallback", "two", { capture: (prompt) => received.push(prompt) })
  ]);
  const guarded = new ConsentAwareModelProvider({ provider: chain, consentScopes: reasoningScopes });
  await guarded.generateStructured(
    "apiKey=gsk_SUPERSECRET123456 C:\\Users\\private-user\\notes.txt",
    schema,
    { externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] } }
  );
  assert.equal(received.length, 2);
  // The credential must not reach either provider — that is what this guards.
  assert.ok(received.every((prompt) => !/SUPERSECRET/.test(prompt)),
    "a key must not survive a failover to a second provider");
  // The PATH deliberately does survive. Rewriting the home directory to the
  // literal "%USERPROFILE%" meant the agent was handed a string PowerShell
  // cannot expand, so it echoed it back and every file operation resolved
  // against the wrong directory. A home directory is not a credential.
  assert.ok(received.every((prompt) => /C:\\Users\\private-user\\notes\.txt/.test(prompt)),
    "the agent has to receive a usable path or it cannot open the file");
  assert.deepEqual(
    guarded.getExternalRequestProvenance().map((record) => record.provider),
    ["primary", "fallback"]
  );
});

test("failover cannot transmit an unauthorized new data category", async () => {
  let calls = 0;
  const chain = new FailoverModelProvider([
    remoteProvider("primary", "one", { capture: () => { calls += 1; } }),
    remoteProvider("fallback", "two", { capture: () => { calls += 1; } })
  ]);
  const guarded = new ConsentAwareModelProvider({
    provider: chain,
    consentScopes: [Scope.SANITIZED_REASONING, Scope.STRUCTURED_UI_CONTEXT]
  });
  await assert.rejects(
    guarded.generateStructured("image", schema, {
      externalAI: { dataCategories: [Category.SCREENSHOT_OR_VISION] }
    }),
    /EXTERNAL_AI_SCREENSHOT_OR_VISION/
  );
  assert.equal(calls, 0);
});

test("structured UIA metadata is allowed by its explicit scope", async () => {
  const guarded = new ConsentAwareModelProvider({
    provider: remoteProvider("deepseek", "model"),
    consentScopes: reasoningScopes
  });
  const result = await guarded.generateStructured('{"controlType":"Button","name":"Bluetooth"}', schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT, Category.STRUCTURED_UIA_METADATA] }
  });
  assert.equal(result.ok, true);
});

test("screenshots remain blocked without separate vision consent", async () => {
  const guarded = new ConsentAwareModelProvider({
    provider: remoteProvider("deepseek", "model"),
    consentScopes: reasoningScopes
  });
  await assert.rejects(
    guarded.generateStructured("screenshot bytes", schema, {
      externalAI: { dataCategories: [Category.SCREENSHOT_OR_VISION] }
    }),
    /consent-denied/
  );
});

test("secrets and API keys never enter provider context", async () => {
  let received = "";
  const guarded = new ConsentAwareModelProvider({
    provider: remoteProvider("deepseek", "model", { capture: (prompt) => { received = prompt; } }),
    consentScopes: reasoningScopes
  });
  await guarded.generateStructured("password=hunter2 access_token=token123456789 apiKey=gsk_ABCDEF123456789", schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
  });
  assert.doesNotMatch(received, /hunter2|token123456789|ABCDEF123456789/);
});

test("provenance records actual provider/model/endpoint without credentials", async () => {
  const provider = remoteProvider("deepseek", "deepseek-v4-flash");
  const guarded = new ConsentAwareModelProvider({ provider, consentScopes: reasoningScopes });
  await guarded.generateStructured("task", schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
  });
  const [record] = guarded.getExternalRequestProvenance();
  assert.equal(record.provider, "deepseek");
  assert.equal(record.model, "deepseek-v4-flash");
  assert.equal(record.endpoint, "https://api.deepseek.example/v1");
  assert.equal(record.credentialsRecorded, false);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(provider.apiKey));
});

test("adding or changing provider/model is configuration data, not consent logic", async () => {
  const provider = remoteProvider("custom-openai-compatible", "user-selected-model");
  const guarded = new ConsentAwareModelProvider({ provider, consentScopes: reasoningScopes });
  await guarded.generateStructured("task", schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
  });
  assert.equal(guarded.getExternalRequestProvenance()[0].model, "user-selected-model");
});

test("sanitization preserves the bounded prompt tail containing goal and grounded state", async () => {
  let received = "";
  const guarded = new ConsentAwareModelProvider({
    provider: remoteProvider("deepseek", "model", { capture: (prompt) => { received = prompt; } }),
    consentScopes: reasoningScopes
  });
  const prompt = `${"instruction ".repeat(180)}\nGOAL_MARKER: inspect Character Map\nSTATE_MARKER: grounded controls`;
  await guarded.generateStructured(prompt, schema, {
    externalAI: { dataCategories: [Category.SANITIZED_TASK_TEXT] }
  });
  assert.match(received, /GOAL_MARKER: inspect Character Map/);
  assert.match(received, /STATE_MARKER: grounded controls/);
});
