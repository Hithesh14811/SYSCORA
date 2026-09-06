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
  // the ceiling does not fire on real work.
  const agent = new FastAgent({ provider, toolset: busyToolset() });

  const outcome = await agent.run("is python installed");

  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.message, "Python 3.12.1 is installed.");
  // 150,000, THEN 400,000, THEN OFF — AND THE SEQUENCE IS THE ARGUMENT.
  //
  // It was first derived from the eval suite ("the most expensive passing eval
  // task is ~35,000") rather than from what people ask for, and fired on 8% of
  // 143 real sessions — including a run that had made no repeated call and seen
  // no unchanged screen, and including this product's most expensive PASSING run
  // at 152,064. Raised to 400,000, which is the same mistake with a bigger
  // number: an hour of real coding passes it and the run is cut off mid-task.
  //
  // A budget that has to be raised every time somebody does real work is not
  // protecting anything. What replaced it is BUDGET_CHECKPOINTS — the cost is
  // announced and the run continues — plus the two behavioural guards that
  // actually catch a runaway. Still settable by caller or environment.
  assert.equal(agent.maxFreshTokens, Number.POSITIVE_INFINITY);
  assert.equal(agent.maxSteps, Number.POSITIVE_INFINITY);
  assert.equal(agent.maxElapsedMs, Number.POSITIVE_INFINITY);
});

// A CEILING THAT IS OFF MUST STILL BE SETTABLE, or a run nobody wants unbounded
// cannot be bounded. Both routes, because the environment one is what an
// operator reaches for and the caller one is what the eval harness uses.
test("the budgets are still settable by the caller and by the environment", async () => {
  const agent = new FastAgent({
    provider: { supportsChat: () => true, async chat() { return { text: "", toolCalls: [] }; } },
    toolset: busyToolset(),
    maxSteps: 12,
    maxElapsedMs: 34_000,
    maxFreshTokens: 56_000
  });
  assert.equal(agent.maxSteps, 12);
  assert.equal(agent.maxElapsedMs, 34_000);
  assert.equal(agent.maxFreshTokens, 56_000);

  const { budgetFromEnv } = await import("../../packages/fast-agent/src/index.js");
  process.env.SYSCORA_TEST_BUDGET = "250";
  assert.equal(budgetFromEnv("SYSCORA_TEST_BUDGET"), 250);
  // "off", "none" and zero all mean unbounded — three spellings because an
  // operator turning a limit off should not have to guess which word this file
  // happens to accept.
  for (const spelling of ["off", "none", "0"]) {
    process.env.SYSCORA_TEST_BUDGET = spelling;
    assert.equal(budgetFromEnv("SYSCORA_TEST_BUDGET"), Number.POSITIVE_INFINITY, spelling);
  }
  // And nonsense falls back rather than silently becoming NaN, which compares
  // false against everything and would disable the budget by accident.
  process.env.SYSCORA_TEST_BUDGET = "banana";
  assert.equal(budgetFromEnv("SYSCORA_TEST_BUDGET", 99), 99);
  delete process.env.SYSCORA_TEST_BUDGET;
});

// ---- The backstop, and the silence it replaced -------------------------------
//
// THE CEILINGS CAME OFF AND NOTHING TOOK THEIR PLACE PAST THE FOURTH CHECKPOINT.
//
// `maxSteps`, `maxElapsedMs` and `maxFreshTokens` all default to Infinity, on
// purpose: every one of them was measured cutting off work that was about to
// finish. What replaced them is BUDGET_CHECKPOINTS — four thresholds that say
// what the run has spent and let it continue.
//
// The table has four entries and the loop condition was
// `checkpointsPassed < BUDGET_CHECKPOINTS.length`. So after 700 steps / 90
// minutes / 4M billed tokens a run emitted NOTHING further — no event for the
// surface, no line for the model — and carried on forever.
//
// The two behavioural guards cannot cover this. The repeat guard keys on a call
// and its arguments; `unchangedReadings` keys on a screen that did not move.
// Neither can see a loop that issues DIFFERENT calls — alternating two searches,
// or walking a tree that keeps producing new paths.

test("checkpoints keep coming after the table runs out", async () => {
  const { checkpointAt } = await import("../../packages/fast-agent/src/index.js");
  const table = [40, 120, 300, 700];
  for (const [index, steps] of table.entries()) {
    assert.equal(checkpointAt(index).steps, steps, `checkpoint ${index} is the table's`);
  }
  // Past the end it must keep producing thresholds, each larger than the last,
  // for as long as the run lasts. A silent run is the thing being fixed.
  let previous = checkpointAt(table.length - 1).steps;
  for (let index = table.length; index < table.length + 6; index += 1) {
    const next = checkpointAt(index);
    assert.ok(Number.isFinite(next.steps), `checkpoint ${index} must exist`);
    assert.ok(next.steps > previous, `checkpoint ${index} must be above ${previous}, got ${next.steps}`);
    assert.ok(next.elapsedMs > 0 && next.freshTokens > 0);
    previous = next.steps;
  }
});

// The backstop is not a budget — it is a statement that something is wrong. It
// sits about two orders of magnitude above the most expensive run ever recorded
// on this machine (38 steps / 213s / 166,997 billed tokens), so a run that
// reaches it has been looping for hours without either behavioural guard seeing
// anything.
test("a run that loops forever on DIFFERENT calls is still stopped", async () => {
  // Every call is distinct, so the repeat guard never fires; every tool succeeds,
  // so nothing is recorded as failing; nothing reads the screen, so
  // `unchangedReadings` stays at zero. Before the backstop this ran forever.
  let calls = 0;
  const provider = {
    supportsChat: () => true,
    async chat() {
      calls += 1;
      return {
        text: "",
        toolCalls: [{ id: `c${calls}`, name: "run", arguments: JSON.stringify({ command: `echo ${calls}` }) }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
      };
    }
  };
  const agent = new FastAgent({
    provider,
    toolset: busyToolset(),
    // Exactly the shipped default: unbounded. The backstop must hold anyway.
    maxSteps: Number.POSITIVE_INFINITY,
    maxElapsedMs: Number.POSITIVE_INFINITY,
    maxFreshTokens: Number.POSITIVE_INFINITY
  });

  const outcome = await agent.run("keep going");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.ok(outcome.steps > 0);
  // 1,000,000 billed tokens a step reaches the 12M backstop in twelve steps,
  // which is what makes this test finish in a second rather than in an hour.
  assert.ok(outcome.steps < 100, `the backstop must end it, stopped at ${outcome.steps}`);
  assert.match(outcome.message, /looping rather than converging/);
  // The numbers go in the sentence, like every other budget here: a user told
  // "I stopped" and nothing else cannot tell what to do about it.
  assert.match(outcome.message, /billed/);
  assert.equal(outcome.failureReason, "BUDGET");
});

// An ordinary request must not be able to see any of this.
test("a short successful run never reaches a checkpoint or the backstop", async () => {
  const provider = {
    supportsChat: () => true,
    async chat() {
      // NOT "Done." — that is a bare acknowledgement with no tool behind it, and
      // the honesty backstop settles it FAILED, correctly. The first version of
      // this test used it and failed for that reason rather than for anything to
      // do with budgets. An arithmetic answer claims nothing about the machine.
      return {
        text: "2 + 2 = 4",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 12000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 11000 } }
      };
    }
  };
  const events = [];
  const agent = new FastAgent({
    provider,
    toolset: busyToolset(),
    onEvent: (event) => events.push(event.type)
  });
  const outcome = await agent.run("what is 2 + 2");
  assert.equal(outcome.status, "COMPLETED");
  assert.ok(!events.includes("BUDGET_CHECKPOINT"), "an ordinary answer must not be told what it cost");
});
