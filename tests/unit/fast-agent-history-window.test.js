// WHAT A FOLLOW-UP CAN SEE OF THE ANSWER IT IS A FOLLOW-UP TO.
//
// Live, 23 Aug 2026. The agent researched twenty internships and wrote them out
// with the detail under each — several thousand characters. The next message was
// "give me their direct link", a question entirely about the TAIL of that answer.
// Every turn of history was clipped to 2,000 characters before the model saw it,
// so the model was handed the first third of its own reply, could not see the
// list it was being asked about, searched the web again, and produced a
// different list. The user reasonably read that as the agent ignoring them.
//
// So the last turns keep enough to be answerable and older ones stay short, and
// a clipped turn SAYS it was clipped — a silently truncated message reads as a
// complete one, which is the same defect one layer down.

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent } from "../../packages/fast-agent/src/index.js";

const answeringProvider = () => {
  const seen = [];
  return {
    seen,
    supportsChat: () => true,
    async chat({ messages }) {
      seen.push(structuredClone(messages));
      return {
        text: "Here they are.",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      };
    }
  };
};

const emptyToolset = () => ({
  definitions: [],
  has: () => false,
  previewOf: () => "",
  execute: async () => ({}),
  render: () => "",
  setConfirmer() {},
  forgetObservedInstructions() {}
});

const longAnswer = (marker) => `${"The list begins. ".repeat(300)}${marker}`;

test("the turn a follow-up is about survives into the next request", async () => {
  const provider = answeringProvider();
  const agent = new FastAgent({ provider, toolset: emptyToolset() });

  await agent.run("give me their direct link", {
    history: [
      { role: "user", text: "find me twenty internships" },
      { role: "assistant", text: longAnswer("VISANERD-LINK-AT-THE-END") }
    ]
  });

  const sent = provider.seen[0];
  const assistantTurn = sent.find((message) => message.role === "assistant");
  assert.ok(assistantTurn, "the previous answer did not reach the model at all");
  assert.match(
    assistantTurn.content,
    /VISANERD-LINK-AT-THE-END/,
    "the end of the answer being asked about was cut off before the model saw it — this is the defect"
  );
});

test("an older turn is still kept short, and says so where it was cut", async () => {
  const provider = answeringProvider();
  const agent = new FastAgent({ provider, toolset: emptyToolset() });

  await agent.run("and now?", {
    history: [
      { role: "assistant", text: longAnswer("OLD-TAIL") },
      { role: "user", text: "something since" },
      { role: "assistant", text: "a short recent answer" }
    ]
  });

  const sent = provider.seen[0];
  const old = sent.find((message) => message.content.includes("The list begins."));
  assert.ok(old, "the older turn is missing entirely");
  assert.ok(!old.content.includes("OLD-TAIL"), "an older turn must stay clipped — this is what keeps a long chat affordable");
  assert.match(old.content, /this earlier message was longer/, "a clipped turn that does not say so reads as a complete one");
  assert.ok(old.content.length < 2200, `an older turn grew to ${old.content.length} characters`);
});
