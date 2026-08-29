// THREE DEFECTS FROM ONE LIVE SESSION, 28 AUG 2026.
//
// Four real requests — play a track, add it to a playlist, send the link, find a
// flight — produced 1,062,676 tokens and one task that never finished. None of
// the three causes was the model being weak.
//
//   1. `web_read` was scored as a repeated ACTION by the no-progress guard, so
//      the type-then-read-back cycle that IS driving a form tripped "you have
//      run exactly this 3 times, STOP and ask the user" on three separate sites.
//      The flight search ended at 392,537 tokens having found nothing.
//   2. `play_music` drove Spotify's window and never recorded it as the working
//      window, then told the model "the window is open — read the screen". The
//      next `screen` returned WhatsApp. Two wasted steps per failed play, twice
//      in one session.
//   3. `type` accepted an empty string. The model, deciding it needed to ask the
//      user a question, reached for a tool to do it and called `type {text:""}`.
//
// Proven able to fail: each test below was run against the code before its fix.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import { FastAgent } from "../../packages/fast-agent/src/index.js";

function kit({ spotify = null } = {}) {
  const adapter = new WindowsAdapter();
  adapter.hostRequest = async () => ({ performed: true });
  if (spotify) {
    adapter.playSpotifyTrack = async (query) => ({ query, available: true, ...spotify });
    adapter.readSpotifyPlayback = async () => spotify.playback ?? {};
  }
  return buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter });
}

// ---- 1. reading a page is an observation ------------------------------------

// A provider that calls the same tool over and over, the way the agent does when
// it is typing into a form and reading the result back.
function repeatingProvider(tool, args, times) {
  let sent = 0;
  return {
    supportsChat: () => true,
    async chat() {
      sent += 1;
      if (sent > times) return { text: "Here is what I found.", toolCalls: [], finishReason: "stop", usage: {} };
      return {
        text: "",
        toolCalls: [{ id: `c${sent}`, name: tool, arguments: JSON.stringify(args) }],
        finishReason: "tool_calls",
        usage: {}
      };
    }
  };
}

function countingToolset(name) {
  let calls = 0;
  return {
    calls: () => calls,
    definitions: [{ type: "function", function: { name, description: "", parameters: {} } }],
    has: (candidate) => candidate === name,
    previewOf: () => "",
    async execute() {
      calls += 1;
      return { ok: true, text: "page text", raw: { evidence: { verdict: "CONFIRMED" } } };
    }
  };
}

test("reading the same page repeatedly is not treated as going in circles", async () => {
  // Five reads of the same page. Before the fix the loop refused after three and
  // settled PARTIALLY_COMPLETED telling the user it was stuck.
  const toolset = countingToolset("web_read");
  const outcome = await new FastAgent({
    provider: repeatingProvider("web_read", { saw: "typed into the field", say: "reading it back" }, 5),
    toolset,
    maxSteps: 12
  }).run("find me a flight");

  assert.equal(toolset.calls(), 5, "every read must be allowed to run");
  assert.equal(outcome.status, "COMPLETED", `a run that only READ must not be failed for repeating: ${outcome.message}`);
  assert.doesNotMatch(String(outcome.message), /going in circles|STOP and ask/i);
});

test("a repeated ACTION is still caught", async () => {
  // The guard must still do its job — this is what stops the forty-seven
  // identical clicks that provoked it. web_click is an action, not a look.
  const toolset = countingToolset("web_click");
  await new FastAgent({
    provider: repeatingProvider("web_click", { text: "Search", saw: "the button", say: "clicking" }, 8),
    toolset,
    maxSteps: 12
  }).run("click search over and over");

  assert.ok(
    toolset.calls() < 8,
    `a repeated action must still be stopped; it ran ${toolset.calls()} times`
  );
});

// ---- 2. play_music leaves the working window on Spotify ---------------------

test("a failed play still points the screen at Spotify", async () => {
  // The exact shape from the live run: the URI hand-off was accepted, nothing
  // started, and the tool tells the model to go and read the screen.
  const toolset = kit({
    spotify: {
      launched: true,
      playback: { playing: false, nowPlaying: "", window: { WindowHandle: 7605080 } }
    }
  });
  toolset.beginTurn("play tum hi ho on spotify");
  await toolset.execute("play_music", { query: "Tum Hi Ho", saw: "asked for a track", say: "playing it" });

  const working = toolset.workingWindowForTest();
  assert.equal(
    String(working?.windowId), "7605080",
    "after play_music the working window must be Spotify, or its own advice to read the screen is wrong"
  );
  assert.equal(working?.application, "spotify");
});

test("a successful play also leaves the window set, for the follow-up", async () => {
  const toolset = kit({
    spotify: {
      launched: true,
      title: "Tum Hi Ho",
      playback: { playing: true, nowPlaying: "Arijit Singh - Tum Hi Ho", window: { WindowHandle: 4242 } }
    }
  });
  toolset.beginTurn("play tum hi ho on spotify");
  await toolset.execute("play_music", { query: "Tum Hi Ho", saw: "asked for a track", say: "playing it" });
  assert.equal(String(toolset.workingWindowForTest()?.windowId), "4242");
});

// ---- 3. typing nothing ------------------------------------------------------

test("typing an empty string is refused, and the refusal says what to do instead", async () => {
  const toolset = kit();
  toolset.beginTurn("add it to a playlist");
  const result = await toolset.execute("type", { text: "", saw: "two playlists", say: "asking which" });

  assert.equal(result.ok, false, "an empty type must not report success");
  assert.match(
    String(result.text),
    /not a tool call|write the question as your reply/i,
    "the refusal must redirect to replying, because that is what the model was actually trying to do"
  );
  // And it must not be the document gate answering, which is what happened live
  // and told the model something true about Spotify instead of about its call.
  assert.doesNotMatch(String(result.text), /already work in this document/i);
});
