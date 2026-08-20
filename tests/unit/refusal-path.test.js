// THE SYSTEM SAYING NO, IN THE THREE PLACES IT WAS GETTING IT WRONG.
//
// Saying no correctly is the enterprise safety property and the first thing a
// buyer probes. All three of these were live on 20 Aug 2026:
//
//   1. a correct refusal was graded as a lie
//   2. FAILED-with-no-tool-calls was read as "the model is unreachable", and the
//      request was handed to ~20,000 lines of offline pipeline for ~90 seconds
//   3. a declined irreversible action settled COMPLETED
//
// Measured before any of this was touched, on the real machine, one run of
// `Delete everything in C:/Windows`:
//
//    11366ms  AGENT_SAYS               correct refusal, quoting the path
//    14408ms  AGENT_SAYS               "that was conversation, not a claim"
//    14409ms  AGENT_DONE               settles FAILED
//    14410ms  FAST_AGENT_UNAVAILABLE   the offline pipeline starts
//   107658ms  INTERACTIVE_REASONING_FAILED
//
// Ninety-three seconds re-deriving an answer that was correct at eleven.

import test from "node:test";
import assert from "node:assert/strict";
import { FailureReason, FastAgent, claimsWithoutEvidence } from "../../packages/fast-agent/src/index.js";

// ---- 1. The lie detector must be UNCHANGED in what it detects ---------------
//
// The fix for the refusal path deliberately does NOT touch this. Every one of
// these shipped to the user as a confident sentence with no tool call behind it,
// and each one is why a pattern exists. If a later change to the refusal
// handling loosens the detector, this is the test that fails.
//
// What it would FAIL on: any edit that stops one of these five being caught.
test("all five historical lies still trip the evidence backstop", () => {
  const lies = [
    // 16 Aug, two turns apart, both false while the endpoint sat at 20%.
    ["Muted.", "the cheapest lie there is: one word, no tool call"],
    ["Volume is now at 60%.", "a reading of the machine, asserted with nothing having read it"],
    // 17 Aug. The guard written for this did not fire, because the model wrote
    // the number in bold and the pattern wanted a digit straight after "now".
    ["Done — volume is now **20%**.", "the same lie wearing markdown"],
    // Asked "what about node?" — the real answer was v22.23.1.
    ["Node.js v22.14.0", "a version number invented rather than read"],
    ["Paused the song.", "an action claimed by a run that called nothing"]
  ];
  for (const [said, why] of lies) {
    assert.equal(claimsWithoutEvidence(said), true, `this must still be caught — ${why}: ${JSON.stringify(said)}`);
  }
});

// The exemptions that were already there, kept honest in the same breath: a
// question is not a claim, and ordinary conversation is not a claim.
test("asking a question is still not a claim", () => {
  assert.equal(claimsWithoutEvidence("What would you like me to set it to?"), false);
  assert.equal(claimsWithoutEvidence("Which folder did you mean?"), false);
});

// ---- 2. A typed reason, so nobody has to guess from the prose ---------------

function provider(turns) {
  let index = 0;
  return {
    supportsChat: () => true,
    async chat() {
      const turn = turns[Math.min(index++, turns.length - 1)];
      if (turn.throws) throw new Error(turn.throws);
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, position) => ({
          id: `c${index}_${position}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.toolCalls?.length ? "tool_calls" : "stop",
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      };
    }
  };
}

const toolset = (handlers = {}) => ({
  definitions: [{ type: "function", function: { name: "run", description: "", parameters: {} } }],
  has: (name) => name in handlers || name === "run",
  previewOf: () => "",
  async execute(name, args) {
    const handler = handlers[name];
    if (handler) return handler(args);
    return { ok: true, text: "ok", durationMs: 1, raw: {} };
  }
});

test("a dropped connection is reported as MODEL_UNREACHABLE", async () => {
  const agent = new FastAgent({ provider: provider([{ throws: "fetch failed" }]), toolset: toolset() });
  const outcome = await agent.run("what is my disk space");
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.failureReason, FailureReason.MODEL_UNREACHABLE);
});

test("a throttled account is NOT reported as unreachable", async () => {
  const agent = new FastAgent({ provider: provider([{ throws: "HTTP 429: Rate limit exceeded" }]), toolset: toolset() });
  const outcome = await agent.run("what is my disk space");
  assert.equal(outcome.failureReason, FailureReason.MODEL_RATE_LIMITED);
  assert.notEqual(outcome.failureReason, FailureReason.MODEL_UNREACHABLE,
    "re-planning offline cannot help with a billing problem, and it answers a different question");
});

// THE ONE THAT COST NINETY SECONDS.
//
// A model that answers twice is reachable by definition. This run has zero tool
// calls and settles FAILED — the exact shape the runtime used to read as "the
// model is unreachable" — and it must now carry a reason that says otherwise.
test("an unevidenced answer is FAILED but never UNREACHABLE", async () => {
  const agent = new FastAgent({
    provider: provider([{ text: "Muted." }, { text: "Muted." }]),
    toolset: toolset()
  });
  const outcome = await agent.run("mute");
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.toolCalls, 0, "this is the tool count the old heuristic keyed on");
  assert.equal(outcome.failureReason, FailureReason.NO_EVIDENCE);
  assert.notEqual(outcome.failureReason, FailureReason.MODEL_UNREACHABLE,
    "the model answered twice, so it was plainly reachable");
});

test("a successful run carries no failure reason at all", async () => {
  const agent = new FastAgent({
    provider: provider([
      { text: "Checking.", toolCalls: [{ name: "run", args: { command: "echo hi" } }] },
      { text: "Your disk has 40 GB free." }
    ]),
    toolset: toolset()
  });
  const outcome = await agent.run("what is my disk space");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.failureReason, null, "there is no reason to give for a run that worked");
});

// ---- 3. Saying no is a third outcome, not a completion ----------------------

// Keyed on the RECEIPT the gate wrote (`refusedByUser`), never on the model's
// summary. What this would FAIL on: a declined send settling COMPLETED again.
test("a declined irreversible action settles DECLINED, not COMPLETED", async () => {
  const agent = new FastAgent({
    provider: provider([
      { text: "Sending it.", toolCalls: [{ name: "run", args: { command: "send" } }] },
      { text: "I did not send it — you declined, so the draft is still in the box." }
    ]),
    toolset: toolset({
      run: async () => ({
        ok: false,
        text: "The user said NO to this. Do not try it again by another route.",
        durationMs: 1,
        raw: { refusedByUser: true }
      })
    })
  });

  const outcome = await agent.run("send amma a message saying hello");

  assert.equal(outcome.status, "DECLINED",
    "a green tick over the sentence 'it was not sent' teaches people to stop reading the sentence");
  assert.notEqual(outcome.status, "COMPLETED");
  assert.notEqual(outcome.status, "FAILED", "nothing went wrong — the safety feature worked");
  assert.equal(outcome.failureReason, FailureReason.DECLINED);
  assert.match(outcome.message, /did not send/i, "and the sentence still says what happened");
});

test("a run where nothing was declined is unaffected", async () => {
  const agent = new FastAgent({
    provider: provider([
      { text: "Doing it.", toolCalls: [{ name: "run", args: { command: "echo hi" } }] },
      { text: "Done." }
    ]),
    toolset: toolset()
  });
  const outcome = await agent.run("say hi");
  assert.equal(outcome.status, "COMPLETED");
});
