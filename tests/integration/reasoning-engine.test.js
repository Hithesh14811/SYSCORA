// ReasoningEngine + model-provider integration tests.
//
// These prove the reasoning layer is the single, hardened boundary to any
// language model:
//   - provider interface (generateStructured/generateText/health/usage/capabilities)
//   - configuration-driven provider switching + fallback to Mock
//   - failure / timeout / rate-limit handling -> { ok: false } (never throws)
//   - schema validation with bounded repair
//   - hallucinated-capability rejection
//   - deterministic fallback when the model is absent or invalid
//   - secrets never reaching prompts, and execution summarization from facts.
//
// All model behaviour is driven by an in-test scripted provider, so the suite
// is fully deterministic and performs no network or Windows side effects.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LanguageModelProvider,
  MockModelProvider,
  OpenAIModelProvider,
  AnthropicModelProvider,
  createModelProvider,
  extractJson
} from "../../packages/model-providers/src/index.js";
import {
  ReasoningEngine,
  INTENT_SCHEMA,
  TASKGRAPH_SCHEMA
} from "../../packages/reasoning-engine/src/index.js";

// A scripted provider: each call to generateStructured shifts the next queued
// behaviour. A behaviour is either a value to return, or { throw } / { delay }.
class ScriptedProvider extends LanguageModelProvider {
  constructor(script = []) {
    super();
    this.name = "scripted";
    this.script = [...script];
    this.prompts = [];
  }
  async generateStructured(prompt, schema, options = {}) {
    this._usage.calls += 1;
    this.prompts.push(prompt);
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    if (step.throw) throw new Error(step.throw);
    if (typeof step.value === "function") return step.value(prompt);
    return step.value;
  }
  async generateText(prompt) {
    this.prompts.push(prompt);
    return "text-response";
  }
}

// Minimal capability registry stub sufficient for the reasoning engine.
function registryWith(names) {
  const set = new Set(names);
  return {
    getCatalog: () => names.map((n) => ({ name: n, description: n })),
    has: (n) => set.has(n)
  };
}

const VALID_INTENT = {
  normalizedGoal: "Set an environment variable",
  category: "ENVIRONMENT",
  entities: { key: "FOO" },
  successCriteria: ["variable is set"]
};

describe("model provider interface", () => {
  it("base class exposes generateText, health, usage, and capabilities", async () => {
    const mock = new MockModelProvider();
    assert.equal(typeof mock.generateText, "function");
    assert.equal(typeof mock.health, "function");
    assert.equal(typeof mock.usage, "function");
    assert.equal(typeof mock.capabilities, "function");

    const health = await mock.health();
    assert.equal(health.ok, true);
    const caps = mock.capabilities();
    assert.equal(caps.name, "mock");
    assert.deepEqual(mock.usage(), { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it("usage() reflects calls and getUsage() stays backward compatible", async () => {
    const mock = new MockModelProvider();
    await mock.generateStructured("set env FOO", INTENT_SCHEMA);
    assert.equal(mock.usage().calls, 1);
    assert.equal((await mock.getUsage()).calls, 1);
  });

  it("generateText falls back to structured text field on the base class", async () => {
    class TextViaStructured extends LanguageModelProvider {
      async generateStructured() { return { text: "hello world" }; }
    }
    const p = new TextViaStructured();
    assert.equal(await p.generateText("hi"), "hello world");
  });

  it("Anthropic/OpenAI providers advertise remote capabilities", () => {
    assert.equal(new OpenAIModelProvider({ apiKey: "x" }).capabilities().remote, true);
    assert.equal(new AnthropicModelProvider({ apiKey: "x" }).capabilities().remote, true);
  });

  it("Anthropic health reports missing key without throwing", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const a = new AnthropicModelProvider({ apiKey: null });
      const h = await a.health();
      assert.equal(h.ok, false);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("extractJson", () => {
  it("isolates a JSON object from surrounding prose and fences", () => {
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('{"nested":{"b":2}} trailing'), { nested: { b: 2 } });
  });
  it("throws on non-JSON so the caller can fall back", () => {
    assert.throws(() => extractJson("no json here"));
  });
});

describe("createModelProvider switching", () => {
  it("defaults to Mock when no provider given", () => {
    assert.ok(createModelProvider() instanceof MockModelProvider);
    assert.ok(createModelProvider({ provider: "mock" }) instanceof MockModelProvider);
  });

  it("selects OpenAI/Anthropic when credentials are supplied", () => {
    assert.ok(createModelProvider({ provider: "openai", apiKey: "k" }) instanceof OpenAIModelProvider);
    assert.ok(createModelProvider({ provider: "anthropic", apiKey: "k" }) instanceof AnthropicModelProvider);
  });

  it("falls back to Mock when a remote provider lacks credentials", () => {
    const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.ok(createModelProvider({ provider: "openai" }) instanceof MockModelProvider);
      assert.ok(createModelProvider({ provider: "anthropic" }) instanceof MockModelProvider);
    } finally {
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
    }
  });
});

describe("ReasoningEngine hardened boundary", () => {
  it("returns ok:false (never throws) when there is no model", async () => {
    const re = new ReasoningEngine({ modelProvider: null });
    assert.equal(re.hasModel(), false);
    const r = await re.understandIntent("do a thing");
    assert.equal(r.ok, false);
  });

  it("returns valid data on a clean structured response", async () => {
    const re = new ReasoningEngine({ modelProvider: new ScriptedProvider([{ value: VALID_INTENT }]) });
    const r = await re.understandIntent("set env FOO");
    assert.equal(r.ok, true);
    assert.equal(r.data.category, "ENVIRONMENT");
  });

  it("treats a thrown provider error (failure/timeout/rate-limit) as ok:false", async () => {
    for (const msg of ["network down", "AbortError timeout", "HTTP 429 rate limited"]) {
      const re = new ReasoningEngine({ modelProvider: new ScriptedProvider([{ throw: msg }]) });
      const r = await re.understandIntent("x");
      assert.equal(r.ok, false, `expected ok:false for ${msg}`);
    }
  });

  it("performs bounded repair: invalid then valid within repairAttempts", async () => {
    const provider = new ScriptedProvider([
      { value: { normalizedGoal: "missing fields" } }, // invalid (no category/entities/successCriteria)
      { value: VALID_INTENT }                            // repaired
    ]);
    const re = new ReasoningEngine({ modelProvider: provider, repairAttempts: 1 });
    const r = await re.understandIntent("set env FOO");
    assert.equal(r.ok, true);
    assert.equal(provider.prompts.length, 2, "should have re-asked once");
    assert.match(provider.prompts[1], /previous response was invalid/i);
  });

  it("gives up after exhausting bounded repair and returns ok:false", async () => {
    const provider = new ScriptedProvider([
      { value: { bad: 1 } },
      { value: { bad: 2 } } // still invalid after one repair
    ]);
    const re = new ReasoningEngine({ modelProvider: provider, repairAttempts: 1 });
    const r = await re.understandIntent("x");
    assert.equal(r.ok, false);
    assert.equal(provider.prompts.length, 2);
  });

  it("rejects hallucinated capabilities in a composed task graph", async () => {
    const halluc = {
      goal: "g",
      finalSuccessCriteria: ["done"],
      taskGraph: { graphId: "g1", tasks: [{ taskId: "t1", capability: "does.not.exist", inputs: {} }] }
    };
    const provider = new ScriptedProvider([{ value: halluc }, { value: halluc }]);
    const re = new ReasoningEngine({
      modelProvider: provider,
      capabilityRegistry: registryWith(["env.set"]),
      repairAttempts: 1
    });
    const r = await re.composeTaskGraph(VALID_INTENT, {});
    assert.equal(r.ok, false);
    assert.match(String(r.error), /unknown_capability/i);
  });

  it("accepts a task graph that uses only registered capabilities", async () => {
    const good = {
      goal: "g",
      finalSuccessCriteria: ["done"],
      taskGraph: { graphId: "g1", tasks: [{ taskId: "t1", capability: "env.set", inputs: {} }] }
    };
    const re = new ReasoningEngine({
      modelProvider: new ScriptedProvider([{ value: good }]),
      capabilityRegistry: registryWith(["env.set"])
    });
    const r = await re.composeTaskGraph(VALID_INTENT, {});
    assert.equal(r.ok, true);
    assert.equal(r.data.taskGraph.tasks[0].capability, "env.set");
  });

  it("rejects an empty task graph", async () => {
    const empty = { goal: "g", finalSuccessCriteria: ["x"], taskGraph: { graphId: "g", tasks: [] } };
    const re = new ReasoningEngine({
      modelProvider: new ScriptedProvider([{ value: empty }, { value: empty }]),
      capabilityRegistry: registryWith(["env.set"]),
      repairAttempts: 1
    });
    const r = await re.composeTaskGraph(VALID_INTENT, {});
    assert.equal(r.ok, false);
  });

  it("restricts recovery proposals to the allowed action set", async () => {
    const re = new ReasoningEngine({
      modelProvider: new ScriptedProvider([
        { value: { action: "nuke_everything" } },
        { value: { action: "nuke_everything" } }
      ]),
      capabilityRegistry: registryWith(["env.set"]),
      repairAttempts: 1
    });
    const r = await re.reasonAboutRecovery({ diagnosis: { category: "X" } });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /disallowed action/i);
  });

  it("accepts an allowed recovery action", async () => {
    const re = new ReasoningEngine({
      modelProvider: new ScriptedProvider([{ value: { action: "retry", reason: "transient" } }]),
      capabilityRegistry: registryWith(["env.set"])
    });
    const r = await re.reasonAboutRecovery({ diagnosis: { category: "X" } });
    assert.equal(r.ok, true);
    assert.equal(r.data.action, "retry");
  });
});

describe("secrets never reach prompts", () => {
  it("redacts secret-shaped fields from intent before prompting", async () => {
    const provider = new ScriptedProvider([{ value: VALID_INTENT }]);
    const re = new ReasoningEngine({
      modelProvider: provider,
      capabilityRegistry: registryWith(["env.set"])
    });
    const intentWithSecret = {
      ...VALID_INTENT,
      entities: { key: "API", apiKey: "sk-live-SECRET-VALUE", token: "tok-SECRET" }
    };
    const good = {
      goal: "g",
      finalSuccessCriteria: ["done"],
      taskGraph: { graphId: "g", tasks: [{ taskId: "t1", capability: "env.set", inputs: {} }] }
    };
    provider.script.push({ value: good });
    await re.composeTaskGraph(intentWithSecret, {});
    const joined = provider.prompts.join("\n");
    assert.ok(!joined.includes("sk-live-SECRET-VALUE"), "secret apiKey must not appear in prompt");
    assert.ok(!joined.includes("tok-SECRET"), "secret token must not appear in prompt");
    assert.ok(joined.includes("***REDACTED***"), "secret should be redacted");
  });
});

describe("execution summarization", () => {
  it("returns a deterministic template summary when no model is present", async () => {
    const re = new ReasoningEngine({ modelProvider: null });
    const r = await re.summarizeExecution({ status: "COMPLETED", taskCount: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.source, "deterministic");
    assert.match(r.data.summary, /completed/i);
  });

  it("uses the model when available but only phrases the given facts", async () => {
    const provider = new ScriptedProvider([{
      value: { summary: "All done.", changesMade: ["set FOO"], recoveriesPerformed: [], remainingProblems: [], nextRecommendations: [] }
    }]);
    const re = new ReasoningEngine({ modelProvider: provider });
    const r = await re.summarizeExecution({ status: "COMPLETED", taskCount: 1, changesMade: ["set FOO"] });
    assert.equal(r.ok, true);
    assert.equal(r.source, "model");
    assert.equal(r.data.summary, "All done.");
  });

  it("falls back to the template when the model returns invalid summary output", async () => {
    const provider = new ScriptedProvider([{ value: { not: "a summary" } }, { value: { still: "bad" } }]);
    const re = new ReasoningEngine({ modelProvider: provider, repairAttempts: 1 });
    const r = await re.summarizeExecution({ status: "FAILED", taskCount: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.source, "deterministic");
  });
});
