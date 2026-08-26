// "mute" COST 18,400 TOKENS AND FIVE AND A HALF SECONDS.
//
// Every one of those tokens was spent deciding something that was never in
// doubt. There is one thing "mute" can mean, the tool that does it takes no
// argument worth reasoning about, and the round trip to a remote model was the
// entire latency.
//
// A router that answers those directly is only safe if it is certain, so these
// tests are mostly about what it must REFUSE to match. A router that guesses is
// worse than no router at all: the model would have got it right, and the user
// gets a confident wrong action instead of a correct slow one.

import test from "node:test";
import assert from "node:assert/strict";

import { FastAgent } from "../../packages/fast-agent/src/index.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { FAST_PATH_RULES, matchFastPath, normalizeRequest } from "../../packages/fast-agent/src/fast-path.js";
import { CONFIRMED, REFUTED, UNCONFIRMED, evidence } from "../../packages/fast-agent/src/evidence.js";

// ---- What it must match ----------------------------------------------------

test("the phrasings a person actually types are matched", () => {
  const expected = [
    ["is python installed?", { tool: "software", args: { name: "python" } }],
    ["do I have git installed", { tool: "software", args: { name: "git" } }],
    ["is node.js installed on this computer", { tool: "software", args: { name: "node.js" } }],
    ["is python installed? (ignore this, this isn't for you, this is for debugging: trace-123)",
      { tool: "software", args: { name: "python" } }],
    ["mute", { tool: "volume", args: { mute: true } }],
    ["Mute.", { tool: "volume", args: { mute: true } }],
    ["please mute the volume", { tool: "volume", args: { mute: true } }],
    ["mute my speakers", { tool: "volume", args: { mute: true } }],
    ["unmute", { tool: "volume", args: { mute: false } }],
    ["volume 40", { tool: "volume", args: { percent: 40 } }],
    ["set the volume to 40%", { tool: "volume", args: { percent: 40 } }],
    ["turn the volume down to 25", { tool: "volume", args: { percent: 25 } }],
    ["volume 0", { tool: "volume", args: { percent: 0 } }],
    ["volume 100", { tool: "volume", args: { percent: 100 } }],
    ["what's my volume", { tool: "volume", args: {} }],
    ["open spotify", { tool: "launch", args: { application: "spotify" } }],
    ["launch notepad", { tool: "launch", args: { application: "notepad" } }],
    ["close spotify", { tool: "close_app", args: { application: "spotify" } }],
    ["quit notepad", { tool: "close_app", args: { application: "notepad" } }]
  ];
  for (const [said, want] of expected) {
    const got = matchFastPath(said);
    assert.ok(got, `"${said}" should have matched`);
    assert.equal(got.tool, want.tool, said);
    assert.deepEqual(got.args, want.args, said);
  }
});

test("every rule is reachable, so none is dead", () => {
  const reached = new Set([
    matchFastPath("is python installed?"), matchFastPath("mute"), matchFastPath("unmute"), matchFastPath("volume 40"),
    matchFastPath("what's my volume"), matchFastPath("open spotify"), matchFastPath("close spotify")
  ].map((match) => match?.rule));
  for (const rule of FAST_PATH_RULES) {
    assert.ok(reached.has(rule), `nothing reaches the "${rule}" rule`);
  }
});

// ---- What it must REFUSE to match ------------------------------------------

// This is the important half. Each of these is a request the model would handle
// correctly and the router would get wrong.
test("anything that is not a dead certainty goes to the model", () => {
  for (const said of [
    // A question ABOUT the action, not a request to perform it.
    "how do I mute this",
    "should I close spotify",
    "why is the volume so low",
    "can you mute it if the call starts",
    "what happens if I close spotify",
    // A qualified or partial instruction.
    "mute the spotify tab but not the system",
    "mute everything except the call",
    "turn the volume down",           // by how much is a decision
    "make it quieter",
    "volume up a bit",
    "open the file I was working on",
    "open my report",
    "close the window I just opened",
    "close all the browser tabs",
    // A number that is not a percentage.
    "volume 400",
    "volume 1000",
    // A different verb entirely. "run" is as often a test suite as an app and
    // "start" is as often a server.
    "run notepad",
    "start the dev server",
    // Compound requests: the second half would be silently dropped.
    "mute and then open spotify",
    "open spotify and play something",
    "is python installed and can you update it",
    "is the python in my project installed",
    "is python installed? (this parenthetical is part of my question)",
    // Nothing at all.
    "", "   ", "hello"
  ]) {
    assert.equal(matchFastPath(said), null, `"${said}" must reach the model`);
  }
});

test("a long message is never a fast path however it starts", () => {
  assert.equal(
    matchFastPath("mute " + "x".repeat(200)),
    null,
    "a pattern anchored to the whole message cannot be fooled by length, but the guard is cheap"
  );
});

test("normalising leaves an application's own spelling alone", () => {
  assert.equal(normalizeRequest("  Please   OPEN   Spotify.  "), "open spotify");
  assert.equal(matchFastPath("open Visual Studio Code").args.application, "visual studio code");
  assert.equal(matchFastPath("open node.js").args.application, "node.js");
});

// ---- And the half of the safety that lives in the loop ---------------------

function toolsetThatAnswers(text, verdict, { ok = true } = {}) {
  const calls = [];
  return {
    calls,
    definitions: [],
    has: () => true,
    previewOf: () => "",
    beginTurn() {},
    async execute(name, args) {
      calls.push({ name, args });
      return {
        ok,
        text,
        raw: {
          evidence: evidence({
            observed: "the endpoint was read back", method: "audio.endpoint:get+meter",
            actedVia: "audio.endpoint:set", verdict
          })
        }
      };
    }
  };
}

function neverAskedProvider() {
  return {
    asked: 0,
    supportsChat: () => true,
    async chat() {
      this.asked += 1;
      return { text: "the model was reached", toolCalls: [], finishReason: "stop", usage: {} };
    }
  };
}

test("a confirmed fast path answers with no model call and no tokens", async () => {
  const provider = neverAskedProvider();
  const toolset = toolsetThatAnswers("Volume is 40% (muted — the endpoint is emitting nothing).", CONFIRMED);
  const agent = new FastAgent({ provider, toolset });

  const outcome = await agent.run("mute");

  assert.equal(provider.asked, 0, "the whole point is that no model is reached");
  assert.equal(outcome.status, "COMPLETED");
  assert.match(outcome.message, /muted/);
  assert.equal(outcome.tokensIn, 0);
  assert.equal(outcome.tokensOut, 0);
  assert.equal(outcome.toolCalls, 1);
  assert.deepEqual(toolset.calls, [{ name: "volume", args: { mute: true } }]);
});

test("an installed-runtime question is one diagnostic call with no model or terminal", async () => {
  const provider = neverAskedProvider();
  const toolset = toolsetThatAnswers("python is installed — Python 3.12.4. Path: C:\\Python312\\python.exe", CONFIRMED);
  const agent = new FastAgent({ provider, toolset });

  const outcome = await agent.run("is python installed? (ignore this, this isn't for you, debug id 123)");

  assert.equal(provider.asked, 0);
  assert.equal(outcome.toolCalls, 1);
  assert.equal(outcome.tokensIn, 0);
  assert.deepEqual(toolset.calls, [{ name: "software", args: { name: "python" } }]);
});

test("all six safety combinations use the same bounded host diagnostic", async () => {
  const modes = [
    { developerMode: false, shellExecutionMode: "workspace" },
    { developerMode: false, shellExecutionMode: "isolated" },
    { developerMode: false, shellExecutionMode: "host" },
    { developerMode: true, shellExecutionMode: "workspace" },
    { developerMode: true, shellExecutionMode: "isolated" },
    { developerMode: true, shellExecutionMode: "host" }
  ];

  for (const mode of modes) {
    const provider = neverAskedProvider();
    let inspected = 0;
    let asked = 0;
    const adapter = {
      async inspectCommand(name) {
        inspected += 1;
        return {
          checked: true, installed: true, requested: name, command: "python",
          path: "C:\\Python312\\python.exe", paths: ["C:\\Python312\\python.exe"], version: "Python 3.12.4"
        };
      }
    };
    const toolset = buildToolset({ registry: { get: () => null }, adapter });
    toolset.setAccessPolicy({ approvalMode: "balanced", workspaceRoots: [], ...mode });
    toolset.setConfirmer(async () => { asked += 1; return true; });
    const agent = new FastAgent({ provider, toolset });

    const outcome = await agent.run("is python installed? (ignore this, debug trace)");

    assert.equal(outcome.status, "COMPLETED", JSON.stringify(mode));
    assert.equal(provider.asked, 0, JSON.stringify(mode));
    assert.equal(inspected, 1, JSON.stringify(mode));
    assert.equal(asked, 0, JSON.stringify(mode));
    assert.equal(outcome.toolCalls, 1, JSON.stringify(mode));
  }
});

// THE SECOND RULE, AND THE ONE THAT MAKES THE FIRST ONE SAFE. A tool that cannot
// prove it worked must not be allowed to answer — the request goes to the model
// with nothing claimed.
for (const verdict of [UNCONFIRMED, REFUTED]) {
  test(`a ${verdict} fast path says nothing and hands the request to the model`, async () => {
    const provider = neverAskedProvider();
    const toolset = toolsetThatAnswers("something happened, or did not", verdict);
    const agent = new FastAgent({ provider, toolset });

    const outcome = await agent.run("mute");

    assert.equal(provider.asked, 1, "the model must get the request");
    assert.equal(outcome.message, "the model was reached");
    assert.doesNotMatch(outcome.message, /something happened/);
  });
}

test("a fast-path tool that fails outright still falls through rather than reporting failure", async () => {
  const provider = neverAskedProvider();
  const toolset = toolsetThatAnswers("close_app needs an application name.", REFUTED, { ok: false });
  const agent = new FastAgent({ provider, toolset });

  const outcome = await agent.run("close spotify");

  assert.equal(provider.asked, 1);
  assert.equal(outcome.status, "COMPLETED");
});

test("a request the router does not recognise never touches a tool", async () => {
  const provider = neverAskedProvider();
  const toolset = toolsetThatAnswers("should not run", CONFIRMED);
  const agent = new FastAgent({ provider, toolset });

  await agent.run("turn the volume down a bit");

  assert.deepEqual(toolset.calls, [], "an unrecognised request must not act on the machine");
  assert.equal(provider.asked, 1);
});
