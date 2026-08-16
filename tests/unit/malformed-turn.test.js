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
