// A TOOL CALL THAT ARRIVED AS PROSE IS NOT AN ANSWER.
//
// Measured on the type-and-save eval task, 15 Aug 2026: the provider wrote its
// own tool-call sentinels into the content stream, so the loop saw a turn with
// no tool calls and text that read like a reply, and carried on. Nineteen steps
// and 238,643 tokens later the file had never been written.
//
// This matters more once skills exist: a recorder that saves a run containing
// that markup bakes it into a skill, and the skill replays it forever.

import test from "node:test";
import assert from "node:assert/strict";

import { looksLikeMalformedToolCall } from "../../packages/fast-agent/src/index.js";

test("the markup that actually cost 238,643 tokens is recognised", () => {
  const real = '<｜DSML｜｜DSML｜parameter name="text" string="true">violet parade</｜DSML｜parameter>\n' +
    '<｜DSML｜parameter name="saw" string="true">A fresh blank Notepad document is open.</｜DSML｜parameter>';
  assert.equal(looksLikeMalformedToolCall(real), true);
});

test("the other shapes providers leak", () => {
  for (const sample of [
    "<|tool_call|>{\"name\":\"screen\"}",
    "<function_calls><invoke name=\"run\">",
    "<|im_start|>assistant",
    "functions.screen {\"application\": \"notepad\"}"
  ]) {
    assert.equal(looksLikeMalformedToolCall(sample), true, sample);
  }
});

// The guard must be narrower than "text that mentions tools", or it fires on
// ordinary answers and costs a step on every run that talks about its own work.
test("an ordinary answer is never mistaken for markup", () => {
  for (const sample of [
    "Done. The file was saved to C:\\Users\\hithe\\typed.txt and contains \"violet parade\".",
    "I called the screen tool and it showed 14 elements.",
    "There is no report.docx in that folder.",
    "The function invoke_payment in billing.js looks wrong.",
    "Use <div> and <span> tags for the layout.",
    ""
  ]) {
    assert.equal(looksLikeMalformedToolCall(sample), false, sample);
  }
});

// ---- And it must never reach the user, however many times it happens -------
//
// The retry was guarded on "have I already retried once", so a SECOND malformed
// turn fell straight through to `lastText` — which is what the run is settled
// with. `<｜DSML｜invoke name="key">` reached a live transcript as visible text
// exactly that way: detected, retried, and then published.
//
// This is the fuzz test docs/production-plan.md W4 asks for. Every sentinel this
// project has seen, in every position a turn can put it, and one assertion: none
// of it is ever in the message handed back.

import { FastAgent } from "../../packages/fast-agent/src/index.js";

const SENTINELS = [
  '<｜DSML｜parameter name="text" string="true">violet parade</｜DSML｜parameter>',
  "<|tool_call|>{\"name\":\"screen\",\"arguments\":{}}",
  "<function_calls><invoke name=\"run\">",
  "<|im_start|>assistant",
  "functions.volume {\"mute\": true}",
  "<tool_call>",
  "<|channel|>commentary"
];

function providerEmitting(turns) {
  return {
    supportsChat: () => true,
    async chat() {
      const turn = turns.shift() ?? { text: "Done." };
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.finishReason ?? (turn.toolCalls?.length ? "tool_calls" : "stop"),
        usage: {}
      };
    }
  };
}

const emptyToolset = () => ({
  definitions: [],
  has: () => true,
  previewOf: () => "",
  beginTurn() {},
  async execute() { return { ok: true, text: "ok", raw: {} }; }
});

test("no sentinel ever reaches the user, at any position or repetition", async () => {
  for (const sentinel of SENTINELS) {
    // Every shape a broken turn takes: alone, wrapped in prose, and twice
    // running — the last being the case that actually shipped.
    const shapes = [
      [{ text: sentinel }, { text: "Recovered properly." }],
      [{ text: `Sure, doing that now. ${sentinel}` }, { text: "Recovered properly." }],
      [{ text: sentinel }, { text: sentinel }],
      [{ text: sentinel }, { text: sentinel }, { text: "never reached" }]
    ];
    for (const [index, turns] of shapes.entries()) {
      const agent = new FastAgent({
        provider: providerEmitting([...turns]),
        toolset: emptyToolset(),
        maxSteps: 10
      });
      const outcome = await agent.run("do the thing");
      assert.equal(
        looksLikeMalformedToolCall(outcome.message), false,
        `shape ${index} of ${JSON.stringify(sentinel.slice(0, 40))} put markup in the answer:\n${outcome.message}`
      );
      assert.ok(outcome.message.trim().length > 0, "and it must still say something");
    }
  }
});

test("two malformed turns running is reported as the endpoint misbehaving, not as done", async () => {
  const agent = new FastAgent({
    provider: providerEmitting([{ text: SENTINELS[0] }, { text: SENTINELS[0] }]),
    toolset: emptyToolset(),
    maxSteps: 10
  });
  const outcome = await agent.run("press enter");

  assert.equal(outcome.status, "FAILED");
  assert.match(outcome.message, /malformed tool calls/);
  assert.match(outcome.message, /not the machine or the request/);
});

// A run that had already done real work keeps what it said before the markup.
test("the last clean sentence survives the markup that follows it", async () => {
  const agent = new FastAgent({
    provider: providerEmitting([
      { text: "Volume is 40%.", toolCalls: [{ name: "volume", args: {} }] },
      { text: SENTINELS[1] },
      { text: SENTINELS[1] }
    ]),
    toolset: emptyToolset(),
    maxSteps: 10
  });
  const outcome = await agent.run("what is the volume");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /Volume is 40%/);
  assert.equal(looksLikeMalformedToolCall(outcome.message), false);
});
