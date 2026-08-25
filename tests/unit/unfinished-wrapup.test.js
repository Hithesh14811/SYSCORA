// THE WORK WAS DONE AND THE WRITE-UP WAS NOT.
//
// Live, 24 Aug 2026. Asked to audit a project folder, the agent read ten files —
// package.json, every module of the bot, the API route, the frontend — and then
// said "I have a clear picture now. Let me check the git remote and the probe
// file to round out the audit." It called no tool, which ends a run. The
// looksUnfinished guard nudged it, it narrated again, and the user was handed a
// "Partly done" card containing that sentence and NOT ONE WORD of the audit.
//
// Everything needed to answer was already in the conversation. The only thing
// missing was anybody asking for it. So the last thing the loop does before
// giving up is ask for the ANSWER instead of another step.

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, looksUnfinished } from "../../packages/fast-agent/src/index.js";

const toolset = () => ({
  definitions: [{
    type: "function",
    function: { name: "read_file", description: "", parameters: { type: "object", properties: {} } }
  }],
  has: (name) => name === "read_file",
  previewOf: () => "",
  execute: async () => ({ contents: "the file said something" }),
  render: () => "the file said something",
  setConfirmer() {},
  forgetObservedInstructions() {}
});

/** A provider that reads a file, then narrates its next step forever. */
function alwaysNarrating({ relentOnWrapUp }) {
  const seen = [];
  let turn = 0;
  return {
    seen,
    supportsChat: () => true,
    async chat({ messages }) {
      seen.push(messages[messages.length - 1]?.content ?? "");
      turn += 1;
      if (turn === 1) {
        return {
          text: "Reading the file.",
          toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }],
          finishReason: "tool_calls",
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        };
      }
      // The wrap-up ask is the last message; a model that takes it writes the
      // answer, and one that does not keeps narrating.
      const askedToWrapUp = /Write the answer from what you have ALREADY read/.test(
        messages[messages.length - 1]?.content ?? ""
      );
      const text = askedToWrapUp && relentOnWrapUp
        ? "The file contains one line of configuration, and that is the whole audit."
        : "I have a clear picture now. Let me check the git remote to round out the audit.";
      return { text, toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 2 } };
    }
  };
}

test("the sentence that started this is recognised as unfinished", () => {
  assert.equal(looksUnfinished("I have a clear picture now. Let me check the git remote to round out the audit."), true);
  assert.equal(looksUnfinished("The file contains one line of configuration, and that is the whole audit."), false);
});

test("a run about to end with nothing is asked for the answer, not for another step", async () => {
  const provider = alwaysNarrating({ relentOnWrapUp: true });
  const agent = new FastAgent({ provider, toolset: toolset() });
  const outcome = await agent.run("audit that folder");

  const asks = provider.seen.filter((content) => /Write the answer from what you have ALREADY read/.test(String(content)));
  assert.equal(asks.length, 1, "the wrap-up must be asked exactly once, not on a loop");
  assert.equal(outcome.status, "COMPLETED");
  assert.match(outcome.message, /one line of configuration/,
    "the answer the model finally wrote is what the user must be given");
  assert.ok(!/I stopped before finishing/.test(outcome.message),
    "a run that produced an answer must not be reported as stopped");
});

// The guard must still catch a model that genuinely will not finish: the point
// is to stop losing good work, not to start accepting narration as an answer.
test("a model that keeps narrating is still reported as partly done", async () => {
  const provider = alwaysNarrating({ relentOnWrapUp: false });
  const agent = new FastAgent({ provider, toolset: toolset() });
  const outcome = await agent.run("audit that folder");

  assert.equal(outcome.status, "PARTIALLY_COMPLETED");
  assert.match(outcome.message, /I stopped before finishing/);
  // And it must not have gone round for ever asking the same thing.
  const asks = provider.seen.filter((content) => /Write the answer from what you have ALREADY read/.test(String(content)));
  assert.equal(asks.length, 1);
});
