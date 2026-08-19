import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent } from "../../packages/fast-agent/src/index.js";

// THE COST CEILING. There was none: `maxSteps` bounds decisions and
// `maxElapsedMs` bounds the clock, and neither bounds money. A drawing task
// spent 894,000 tokens over 54 steps and finished inside six minutes; nothing
// stopped it and nobody knew until it was over.

// A provider that never finishes and reports what each turn cost, so the loop
// has something to count. `cached` is separate on purpose — the ceiling is on
// what is BILLED, and the two are not the same number here by an order of
// magnitude.
function meteredProvider({ promptTokens, cachedTokens = 0 }) {
  let calls = 0;
  return {
    calls: () => calls,
    supportsChat: () => true,
    async chat() {
      calls += 1;
      return {
        text: "Still working on it.",
        toolCalls: [{ id: `call_${calls}`, name: "run", arguments: JSON.stringify({ command: "echo hi" }) }],
        finishReason: "tool_calls",
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: cachedTokens }
        }
      };
    }
  };
}

const busyToolset = () => ({
  definitions: [{ type: "function", function: { name: "run", description: "", parameters: {} } }],
  has: (name) => name === "run",
  previewOf: () => "",
  async execute() { return { ok: true, text: "done", durationMs: 1, raw: {} }; }
});

test("a run that will not stop is cut off at the fresh-token ceiling", async () => {
  const provider = meteredProvider({ promptTokens: 20000 });
  const agent = new FastAgent({
    provider,
    toolset: busyToolset(),
    maxFreshTokens: 50000,
    // Both of the existing budgets set well clear, so a pass here can only be
    // the new one: this run would otherwise go to eighty steps.
    maxSteps: 80,
    maxElapsedMs: 60000
  });

  const outcome = await agent.run("draw a train in paint");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.ok(outcome.steps < 80, `it must stop well before maxSteps, stopped at ${outcome.steps}`);
  assert.equal(outcome.tokensFresh >= 50000, true, "it should stop at the ceiling, not before reaching it");
  // NAMING THE NUMBER IS THE POINT. "I stopped" without it leaves the user
  // unable to tell whether to raise the ceiling or rephrase the request.
  assert.match(outcome.message, /60,000/, "the message must say what the run actually cost");
  assert.match(outcome.message, /50,000/, "the message must say what the ceiling was");
  // And it must say plainly that it stopped short, and what became of what it
  // had already done — a budget breach that reads like a finished answer is the
  // same lie as any other, arriving by a new route.
  assert.match(outcome.message, /I stopped/i);
  assert.match(outcome.message, /still in place/i);
  assert.doesNotMatch(outcome.message, /\b(I (?:have )?finished|completed the|all done)\b/i);
});

test("the ceiling counts billed tokens, not sent ones", async () => {
  // 40,000 sent per step of which 39,500 comes back from the provider's prefix
  // cache — the ordinary case on this endpoint, which serves ~96.6% of the fixed
  // prefix at roughly a tenth of the price. A ceiling on `tokensIn` would stop
  // this run on step four; it costs 500 a step and must be allowed to finish.
  const provider = meteredProvider({ promptTokens: 40000, cachedTokens: 39500 });
  const agent = new FastAgent({
    provider,
    toolset: busyToolset(),
    maxFreshTokens: 50000,
    maxSteps: 10,
    maxElapsedMs: 60000
  });

  const outcome = await agent.run("read my messages");

  assert.equal(outcome.steps, 10, "a run that is nearly all cache must reach its step limit, not the cost one");
  assert.ok(outcome.tokensIn >= 400000, "it really did send that much");
  assert.ok(outcome.tokensFresh < 50000, `only ${outcome.tokensFresh} of it was billable`);
  assert.doesNotMatch(outcome.message, /ceiling/i);
});

test("an ordinary request is untouched by the ceiling", async () => {
  let calls = 0;
  const provider = {
    supportsChat: () => true,
    async chat() {
      calls += 1;
      return calls === 1
        ? {
          text: "Checking.",
          toolCalls: [{ id: "c1", name: "run", arguments: JSON.stringify({ command: "python --version" }) }],
          finishReason: "tool_calls",
          usage: { prompt_tokens: 9000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8300 } }
        }
        : {
          text: "Python 3.12.1 is installed.",
          toolCalls: [],
          finishReason: "stop",
          usage: { prompt_tokens: 9400, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 8300 } }
        };
    }
  };
  // The shipped default, not a test-sized one: the point of this test is that
  // 150,000 does not fire on real work.
  const agent = new FastAgent({ provider, toolset: busyToolset() });

  const outcome = await agent.run("is python installed");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "Python 3.12.1 is installed.");
  assert.equal(agent.maxFreshTokens, 150000);
});
