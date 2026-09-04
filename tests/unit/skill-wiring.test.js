// A REPLAY THAT STILL CALLS THE MODEL HAS SAVED NOTHING.
//
// The whole claim is "twelve steps and a minute becomes three seconds and no
// model call", so the test that matters is that the provider is never asked.
// The rest of these hold up the promise that this cannot break an ordinary
// request: with no store wired, or a store that throws, the loop must behave
// exactly as it did before skills existed.

import test from "node:test";
import assert from "node:assert/strict";

import { FastAgent } from "../../packages/fast-agent/src/index.js";

// Counts every time the model is reached for. A replay must leave this at zero.
// Same shape as the scripted provider in fast-agent.test.js — the loop's real
// contract, not a guess at it.
function fakeProvider(turns = []) {
  const provider = {
    calls: 0,
    supportsChat: () => true,
    async chat({ onTextDelta }) {
      provider.calls += 1;
      const turn = turns.shift() ?? { text: "Done." };
      onTextDelta?.(turn.text ?? "");
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.toolCalls?.length ? "tool_calls" : "stop"
      };
    }
  };
  return provider;
}

function fakeToolset({ results = {}, focused = null } = {}) {
  const executed = [];
  return {
    executed,
    definitions: [{ type: "function", function: { name: "run", description: "", parameters: {} } }],
    has: () => true,
    previewOf: () => "",
    beginTurn() {},
    async machineFacts() { return ""; },
    async notes() { return ""; },
    focusedValue: async () => focused,
    async execute(name, args) {
      executed.push({ name, args });
      return results[name] ?? { ok: true, text: "done" };
    }
  };
}

const sendSkill = {
  id: "whatsapp-send-message",
  title: "Send a WhatsApp message",
  match: { examples: ["send {contact} a message on whatsapp saying {text}"] },
  preconditions: [{ ensure: "app-running", application: "WhatsApp" }],
  steps: [
    { tool: "click", args: { text: "{contact}", section: "Chats" }, verify: { kind: "window-title-contains", value: "{contact}" } },
    // A send is proved in the conversation. `input-empty` was here, and it
    // cannot prove one: an empty box is equally consistent with never having
    // held the message.
    { tool: "type", args: { text: "{text}", submit: true }, irreversible: true, verify: { kind: "message-in-conversation", value: "{text}" } }
  ],
  stats: { runs: 3, cleanReplays: 3, retired: false }
};

const screenSaying = (title, extra = "") =>
  ({ ok: true, text: `Window: ${title}\n0| button "Chintu" @1,1${extra}` });

test("a saved route answers without the model being called at all", async () => {
  const provider = fakeProvider();
  // The conversation shows the sent message, which is what proves the send.
  const toolset = fakeToolset({
    results: { screen: screenSaying("Chintu — WhatsApp", '\n1| text "av byavarsi" @1500,900\n2| text "9:52 pm" @1761,930') },
    focused: ""
  });
  const runs = [];
  const agent = new FastAgent({
    provider,
    toolset,
    skills: { list: async () => [sendSkill], recordRun: async (id, r) => runs.push({ id, ...r }) }
  });

  const settled = await agent.run("send Chintu a message on whatsapp saying av byavarsi");

  assert.equal(settled.status, "COMPLETED");
  assert.equal(provider.calls, 0, "the model must not be reached at all");
  assert.equal(settled.tokensIn + settled.tokensOut, 0);
  assert.deepEqual(runs, [{ id: "whatsapp-send-message", clean: true }]);
  const typed = toolset.executed.find((call) => call.name === "type");
  assert.equal(typed.args.text, "av byavarsi", "the user's words, not the placeholder");
});

// THE SAFETY PROPERTY. A replay may only continue while it can prove it is on
// track; when it cannot, the model takes over WITH what already happened.
test("a replay that cannot prove a step hands the model the situation", async () => {
  const provider = fakeProvider([{ text: "Carried on.", toolCalls: [] }]);
  // The window never becomes Chintu's, so step 1 cannot be proved.
  const toolset = fakeToolset({ results: { screen: screenSaying("WhatsApp") } });
  const agent = new FastAgent({
    provider, toolset,
    skills: { list: async () => [sendSkill], recordRun: async () => {} }
  });

  const settled = await agent.run("send Chintu a message on whatsapp saying hi");

  assert.equal(provider.calls, 1, "the model finishes the job");
  assert.equal(settled.status, "COMPLETED");
  assert.equal(toolset.executed.some((call) => call.name === "type"), false,
    "it must not send after failing to prove it opened the right chat");
});

test("with no skills wired, nothing about a run changes", async () => {
  const provider = fakeProvider([{ text: "Hello.", toolCalls: [] }]);
  const toolset = fakeToolset();
  // NOT "hello" ANY MORE. A bare greeting is now answered by the conversational
  // fast path with no model call at all, which would make `provider.calls` zero
  // and this test pass for a reason that has nothing to do with skills. What is
  // being checked here is that an ORDINARY request is unaffected by there being
  // no skill store, so it needs an ordinary request.
  const settled = await new FastAgent({ provider, toolset }).run("summarise what is on my desktop");
  assert.equal(provider.calls, 1);
  assert.equal(settled.status, "COMPLETED");
});

// A skill is a speed optimisation. If anything about it misbehaves the request
// must still be answered the ordinary way, or one corrupt file on disk takes
// the whole product down.
test("a skill store that throws does not break the request", async () => {
  const provider = fakeProvider([{ text: "Answered anyway.", toolCalls: [] }]);
  const toolset = fakeToolset();
  const agent = new FastAgent({
    provider, toolset,
    skills: { list: async () => { throw new Error("disk on fire"); } }
  });
  const settled = await agent.run("send Chintu a message on whatsapp saying hi");
  assert.equal(settled.status, "COMPLETED");
  assert.equal(settled.message, "Answered anyway.");
  assert.equal(provider.calls, 1);
});

test("a request nothing matches goes to the model as usual", async () => {
  const provider = fakeProvider([{ text: "The weather is fine.", toolCalls: [] }]);
  const toolset = fakeToolset();
  const agent = new FastAgent({
    provider, toolset,
    skills: { list: async () => [sendSkill], recordRun: async () => {} }
  });
  await agent.run("what is the weather");
  assert.equal(provider.calls, 1);
  assert.equal(toolset.executed.length, 0);
});

// OFFERED, NOT SAVED. Writing something that drives the user's machine to their
// disk without them agreeing, and then replaying it, is not a decision this gets
// to make on its own.
test("a run that worked is offered as a route rather than saved behind their back", async () => {
  const events = [];
  const provider = fakeProvider([
    { text: "", toolCalls: [{ name: "click", args: { text: "Chintu", saw: "s", say: "s" } }] },
    { text: "Opened it." }
  ]);
  const toolset = fakeToolset();
  const saved = [];
  const agent = new FastAgent({
    provider, toolset,
    onEvent: (event) => events.push(event),
    skills: { list: async () => [], recordRun: async () => {}, write: async (skill) => saved.push(skill) }
  });

  await agent.run("open the chat with Chintu");

  const offer = events.find((event) => event.type === "SKILL_OFFERED");
  assert.ok(offer, "the run should be offered");
  assert.equal(saved.length, 0, "nothing is written until the user accepts");
  assert.equal(offer.details.skill.steps[0].tool, "click");
});
