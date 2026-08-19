import test from "node:test";
import assert from "node:assert/strict";

// WHICH WAY ROUND THE HISTORY COLLAPSE DEFAULTS, AND THAT BOTH PATHS STILL WORK.
//
// The loop used to rewrite an earlier screen reading down to one line the moment
// the same window was read again. That was measured as the largest single token
// saving in the product — and the measurement counted every input token at the
// same price. It is not the same price: this endpoint serves the longest
// identical PREFIX from cache at roughly a tenth of the cost, and editing a
// message in the MIDDLE of the conversation moves the prefix from that point on,
// so everything after it goes back to full price on every later step.
//
// Three paired live runs at six steps: 24,725 fresh with the collapse on against
// 16,623 and 16,196 with it off. So the default is now OFF, and the collapse is
// kept behind SYSCORA_COLLAPSE_HISTORY=1 — n=3 is enough to move a default and
// not enough to delete a code path.
//
// The flag is read when the module is evaluated, so each case imports its own
// copy. The query string is what makes them separate copies; without it Node
// hands back the first one and the second case silently tests the first case's
// behaviour, which would pass for the wrong reason.
async function loadAgent({ collapse }) {
  if (collapse) process.env.SYSCORA_COLLAPSE_HISTORY = "1";
  else delete process.env.SYSCORA_COLLAPSE_HISTORY;
  const module = await import(`../../packages/fast-agent/src/index.js?collapse=${collapse ? 1 : 0}`);
  return module.FastAgent;
}

// Two readings of the SAME window, then a plain answer. The window id is what
// the collapse keys on: a reading of Notepad never supersedes a reading of
// WhatsApp.
function twoReadingsThenAnswer() {
  const seen = [];
  let calls = 0;
  return {
    seen,
    supportsChat: () => true,
    async chat({ messages }) {
      seen.push(structuredClone(messages));
      calls += 1;
      if (calls <= 2) {
        return {
          text: "Looking.",
          toolCalls: [{ id: `c${calls}`, name: "screen", arguments: "{}" }],
          finishReason: "tool_calls",
          usage: { prompt_tokens: 100, completion_tokens: 5 }
        };
      }
      return { text: "The window says hello.", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 5 } };
    }
  };
}

const screenToolset = () => ({
  definitions: [{ type: "function", function: { name: "screen", description: "", parameters: {} } }],
  has: (name) => name === "screen",
  previewOf: () => "",
  async execute() {
    return {
      ok: true,
      // Long enough to be worth collapsing, and tagged the way the loop's walk
      // looks for it.
      text: `Notepad (windowId win-1)\n${"a line of the window\n".repeat(60)}`,
      durationMs: 5,
      raw: { windowId: "win-1" }
    };
  }
});

const firstReadingOf = (messages) =>
  messages.filter((message) => message.role === "tool" && String(message.content ?? "").includes("windowId win-1"))[0];

test("by default the earlier reading of a window is left intact", async () => {
  const FastAgent = await loadAgent({ collapse: false });
  const provider = twoReadingsThenAnswer();
  const agent = new FastAgent({ provider, toolset: screenToolset() });

  const outcome = await agent.run("what does the notepad window say");

  assert.equal(outcome.status, "COMPLETED");
  // The conversation as it stood on the LAST model call, which is the one that
  // shows whether the first reading survived being read a second time.
  const lastConversation = provider.seen.at(-1);
  const first = firstReadingOf(lastConversation);
  assert.ok(first, "the first reading must still be in the conversation");
  assert.ok(
    first.content.length > 500,
    `the first reading must still be whole; it is ${first.content.length} characters`
  );
  assert.doesNotMatch(first.content, /superseded/i);
});

test("with SYSCORA_COLLAPSE_HISTORY=1 the earlier reading is collapsed", async () => {
  const FastAgent = await loadAgent({ collapse: true });
  const provider = twoReadingsThenAnswer();
  const agent = new FastAgent({ provider, toolset: screenToolset() });

  const outcome = await agent.run("what does the notepad window say");

  assert.equal(outcome.status, "COMPLETED");
  const first = firstReadingOf(provider.seen.at(-1));
  assert.ok(first, "the collapsed stub keeps the window tag, so it is still findable");
  assert.ok(
    first.content.length < 500,
    `the first reading should have been collapsed; it is ${first.content.length} characters`
  );
  delete process.env.SYSCORA_COLLAPSE_HISTORY;
});
