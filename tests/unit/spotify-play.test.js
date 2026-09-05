// Unit tests for the deterministic Spotify playback path: intent extraction,
// LLM-free routing, LOW/ALLOW risk+policy, track-query matching, and window-title
// playback interpretation. No real Windows side effects — pure logic + a mock
// adapter injected into the real registry/planner.

import test from "node:test";
import assert from "node:assert/strict";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { MockModelProvider } from "../../packages/model-providers/src/index.js";
import { GeneralPlanner, PlanValidator } from "../../packages/planner/src/index.js";
import {
  createDefaultCapabilityRegistry,
  matchesTrackQuery
} from "../../packages/capability-registry/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { WindowsAdapter, spotifyNameMatchesQuery } from "../../os-adapters/windows/src/windows-adapter.js";

// ---- Intent extraction (deterministic, model-free) --------------------------

test('intent: `open spotify and play "Cry For Me"` → play operation', async () => {
  const intent = await new IntentEngine(null).classify('open spotify and play "Cry For Me"');
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "Cry For Me");
  assert.equal(intent.confidence, 1);
});

test("intent: `play Cry For Me by The Weeknd on Spotify` → play, track without artist", async () => {
  const intent = await new IntentEngine(null).classify("play Cry For Me by The Weeknd on Spotify");
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "Cry For Me");
});

test("intent: `listen to Blinding Lights on spotify` → play", async () => {
  const intent = await new IntentEngine(null).classify("listen to Blinding Lights on spotify");
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "Blinding Lights");
});

test("intent: `search spotify for lofi beats` → open (not play)", async () => {
  const intent = await new IntentEngine(null).classify("search spotify for lofi beats");
  assert.equal(intent.operation, "spotify.track.open");
  assert.equal(intent.entities.query, "lofi beats");
});

test("intent: a request without Spotify is not treated as a track request", async () => {
  const intent = await new IntentEngine(null).classify("play my project");
  assert.notEqual(intent.operation, "spotify.track.play");
});

test("intent: compound play and queue request preserves both track names", async () => {
  const intent = await new IntentEngine(null).classify("play jagave neenu gelatiye on spotify and then put cry for me on queue");
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "jagave neenu gelatiye");
  assert.equal(intent.entities.queueQuery, "cry for me");
  assert.deepEqual(intent.requiredCapabilities, ["spotify.track.play", "spotify.track.queue"]);
});

test("intent: the built-in mock provider cannot replace a Spotify request with a canned fixture", async () => {
  const reasoning = new ReasoningEngine({ modelProvider: new MockModelProvider() });
  const intent = await new IntentEngine(reasoning).classify(
    "play jagave neenu gelatiye on spotify and then put cry for me on queue"
  );
  assert.equal(intent.operation, "spotify.track.play");
  assert.equal(intent.entities.query, "jagave neenu gelatiye");
  assert.equal(intent.entities.queueQuery, "cry for me");
});

test("LLM-selected Spotify operation is enriched when the model omits track entities", async () => {
  const reasoning = {
    understandIntent: async () => ({ ok: true, data: {
      operation: "spotify.track.play",
      normalizedGoal: "Play Jagave Neenu Gelatiye and queue Cry For Me",
      entities: {},
      successCriteria: ["Both requested Spotify actions complete"],
      confidence: 0.95
    } })
  };
  const intent = await new IntentEngine(reasoning).classify("play jagave neenu gelatiye on spotify and then put cry for me on queue");
  assert.equal(intent.entities.query, "jagave neenu gelatiye");
  assert.equal(intent.entities.queueQuery, "cry for me");
});

// ---- Routing skips LLM planning (DIRECT_OPERATION) --------------------------

test("planner: play request maps 1:1 to spotify.track.play and skips the model", async () => {
  // A model provider that THROWS if consulted — proving the deterministic path
  // never calls it for this request.
  const explodingReasoning = {
    hasModel: () => true,
    isModelHealthy: async () => { throw new Error("model must not be consulted"); },
    composeTaskGraph: async () => { throw new Error("model must not be consulted"); }
  };
  const intent = await new IntentEngine(null).classify("play Cry For Me on Spotify");
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(explodingReasoning, registry).generatePlan(intent, []);
  assert.equal(plan.plannerSource, "DIRECT_OPERATION");
  assert.deepEqual(plan.taskGraph.tasks.map((t) => t.capability), ["spotify.track.play"]);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("planner: the play task carries a bounded timeout and no retry budget", async () => {
  const intent = await new IntentEngine(null).classify("play Cry For Me on Spotify");
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  const task = plan.taskGraph.tasks[0];
  assert.ok(task.timeout <= 30000, "task timeout stays within the capability bound");
  assert.equal(task.retryBudget, 0, "no runtime replan retry for the UI task");
});

test("planner: compound request becomes ordered play then queue tasks", async () => {
  const intent = await new IntentEngine(null).classify("play jagave neenu gelatiye on spotify and then put cry for me on queue");
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  const [play, queue] = plan.taskGraph.tasks;
  assert.deepEqual([play.capability, queue.capability], ["spotify.track.play", "spotify.track.queue"]);
  assert.equal(play.inputs.query, "jagave neenu gelatiye");
  assert.equal(queue.inputs.query, "cry for me");
  assert.deepEqual(queue.dependencies, [play.taskId]);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("planner: model-provided track alias becomes the Spotify query", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan({
    operation: "spotify.track.play", normalizedGoal: "Play Tum Hi Ho", entities: { track: "Tum Hi Ho" }, successCriteria: []
  }, []);
  assert.equal(plan.taskGraph.tasks[0].inputs.query, "Tum Hi Ho");
});

test("planner: model trackTitle and artist become a playable query", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan({
    operation: "spotify.track.play", normalizedGoal: "Play Good For You", entities: { trackTitle: "Good For You", artist: "Selena Gomez" }, successCriteria: []
  }, []);
  assert.equal(plan.taskGraph.tasks[0].inputs.query, "Good For You Selena Gomez");
});

test("planner: model trackQuery becomes a playable query", async () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan({
    operation: "spotify.track.play", normalizedGoal: "Play Taki Taki", entities: { trackQuery: "Taki Taki" }, successCriteria: []
  }, []);
  assert.equal(plan.taskGraph.tasks[0].inputs.query, "Taki Taki");
});

// ---- Risk + policy: standard playback is LOW / ALLOW ------------------------

test("risk+policy: spotify.track.play is LOW risk and ALLOW (no confirmation)", () => {
  const registry = createDefaultCapabilityRegistry({});
  const plan = { taskGraph: { tasks: [{ capability: "spotify.track.play", inputs: { query: "Cry For Me" } }] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [registry.get("spotify.track.play")] });
  assert.equal(assessment.overallRisk, "LOW");
  assert.equal(decision.effect, "ALLOW");
});

// ---- matchesTrackQuery ------------------------------------------------------

test("matchesTrackQuery: confirms the requested track in a now-playing title", () => {
  assert.equal(matchesTrackQuery("The Weeknd - Cry For Me", "Cry For Me by The Weeknd"), true);
  assert.equal(matchesTrackQuery("Cry For Me • The Weeknd", "Cry For Me"), true);
  assert.equal(matchesTrackQuery("Taylor Swift - Cardigan", "Cry For Me"), false);
  assert.equal(matchesTrackQuery("Spotify Premium", "Cry For Me"), false);
  assert.equal(matchesTrackQuery("anything", ""), false);
  assert.equal(matchesTrackQuery("Cry Tonight", "Cry For Me"), false, "a partial title match must not verify the wrong track");
  assert.equal(matchesTrackQuery("The Weeknd - Cry For Me", "Cry For My"), true, "a one-letter typo should match the intended title");
});

// ---- Window-title playback interpretation (pure) ----------------------------

test("interpretSpotifyPlayback: idle titles are not playing", () => {
  const a = new WindowsAdapter();
  for (const idle of ["Spotify", "Spotify Free", "Spotify Premium", "", "Advertisement"]) {
    assert.equal(a.interpretSpotifyPlayback(idle).playing, false, `"${idle}" must read as idle`);
  }
});

test("interpretSpotifyPlayback: a track title reads as playing", () => {
  const a = new WindowsAdapter();
  const state = a.interpretSpotifyPlayback("The Weeknd - Cry For Me");
  assert.equal(state.playing, true);
  assert.equal(state.nowPlaying, "The Weeknd - Cry For Me");
});

test("Spotify selector binds a generic Play button to the matching result bounds", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  let script = "";
  adapter.runPowerShell = async (value) => {
    script = value;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        found: true,
        invoked: true,
        name: "Play",
        matchedLabel: "Cry For Me",
        matchedBounds: { X: 733, Y: 258, Width: 1418, Height: 208 }
      }),
      stderr: ""
    };
  };

  const result = await adapter._invokeSpotifyPlayButton("cry for me", 1000, 1234);
  assert.equal(result.invoked, true);
  assert.equal(result.matchedLabel, "Cry For Me");
  assert.match(script, /ControlViewWalker\.GetParent/);
  assert.match(script, /NameProperty,'Play'/);
  assert.match(script, /StartsWith\('Play '/, "descriptive action buttons must be matched by action plus object");
  assert.match(script, /\$actionButtons/, "fallback scans only actionable button controls");
  assert.match(script, /\$rr\.Height -gt 260/);
  assert.match(script, /\$depth-lt 5/, "ancestor search must remain bounded");
});

test("Spotify accessible-name matching tolerates the search correction seen in the live app", () => {
  assert.equal(
    spotifyNameMatchesQuery("Play Jagave Neenu Gelathiye by Arjun Janya, Shashank, Sid Sriram", "Jagave Neenu Gelatiye"),
    true
  );
  assert.equal(spotifyNameMatchesQuery("Play Jagave Neenu Gelathiye", "Cry For Me"), false);
});

test("Spotify play uses a descriptive accessible action before the legacy tree walk", async () => {
  const requests = [];
  const target = {
    targetId: "good-for-you",
    source: "UIA",
    windowId: "1234",
    name: "Play Good For You by Selena Gomez, A$AP Rocky",
    controlType: "ControlType.Button",
    boundingRect: { x: 10, y: 20, width: 200, height: 40 }
  };
  const adapter = new WindowsAdapter({
    automationHost: {
      async request(operation, params) {
        requests.push({ operation, params });
        if (operation === "ui.find") return { found: true, ambiguous: false, matchCount: 1, target };
        return { performed: true, method: "InvokePattern", target };
      }
    },
    browserAutomation: {}
  });
  adapter.runPowerShell = async () => {
    throw new Error("legacy UIA fallback must not run");
  };
  const result = await adapter._invokeSpotifyPlayButton("Good For You", 1000, 1234);
  assert.equal(result.invoked, true);
  assert.equal(result.name, target.name);
  // THE TOP-RESULT CARD IS TRIED FIRST, so `ui.wait` leads.
  //
  // Spotify puts the best match in a card and publishes it as a bare "Play"
  // DataItem beside the title; the list rows below it are named "Play <title>".
  // The card matcher used to run THIRD, and live — asked for "Tum Se Hi" — the
  // card sat on screen while nothing was clicked for 10.8s and the previous
  // track kept playing. See _invokeSpotifyPlayButton.
  // The card look goes first and finds nothing here (this stub only answers
  // `ui.find`), so the descriptive row selector still wins — which is the thing
  // this test is about, and it is unchanged.
  assert.deepEqual(requests.map((request) => request.operation), ["ui.wait", "ui.find", "ui.action"]);
});

test("Spotify queue uses the matching options control and Add to queue menu item", async () => {
  const adapter = new WindowsAdapter();
  adapter.launchApplication = async () => ({ launch: { started: true } });
  adapter.waitForApplicationWindow = async () => ({ ready: true, window: { WindowHandle: 1234 } });
  adapter.openSpotifySearch = async () => ({ launch: { opened: true } });
  let invocation = null;
  adapter._invokeSpotifyQueueButton = async (...args) => {
    invocation = args;
    return { found: true, invoked: true, matchedLabel: "Cry For Me" };
  };

  const result = await adapter.queueSpotifyTrack("Cry For Me", { searchSettleMs: 200 });
  assert.equal(result.queued, true);
  assert.deepEqual(invocation, ["Cry For Me", 8000, 1234]);
  assert.equal(result.matchedTrack, "Cry For Me");
});

test("Spotify queue selector stays localized and has a grounded click fallback", async () => {
  const adapter = new WindowsAdapter();
  let script = "";
  adapter.runPowerShell = async (value) => {
    script = value;
    return { exitCode: 0, stdout: JSON.stringify({ found: true, invoked: true, matchedLabel: "Cry For Me" }), stderr: "" };
  };
  const result = await adapter._invokeSpotifyQueueButton("Cry For Me", 1000, 1234);
  assert.equal(result.invoked, true);
  assert.match(script, /More options for \*/);
  assert.match(script, /NameProperty,'Add to queue'/);
  assert.match(script, /BoundingRectangle/);
  assert.match(script, /SetCursorPos/);
});

test("live Spotify verification uses Player controls Pause plus Now playing label", async () => {
  // This fixture verifies the compatibility scan specifically. Opt out of the
  // production persistent host so it cannot inspect the real desktop and
  // replace the mocked PowerShell observation below.
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  adapter.listWindows = async () => [{
    Id: 7,
    ProcessName: "Spotify",
    MainWindowTitle: "Spotify Free",
    WindowHandle: 1234
  }];
  adapter.runPowerShell = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ playing: true, nowPlaying: "Now playing: Cry For Me by The Weeknd" }),
    stderr: ""
  });

  const state = await adapter.readSpotifyPlayback();
  assert.equal(state.playing, true);
  assert.equal(state.nowPlaying, "Cry For Me by The Weeknd");
});

test("generic GUI capabilities expose read perception and guarded interaction", () => {
  const registry = createDefaultCapabilityRegistry({});
  const inspect = registry.get("gui.inspect");
  const interact = registry.get("gui.interact");
  assert.equal(inspect.permissionModel.type, "READ");
  assert.equal(interact.permissionModel.type, "WRITE");

  const plan = { taskGraph: { tasks: [{ capability: "gui.interact", inputs: {
    application: "Spotify",
    target: { name: "Play" },
    action: "click"
  } }] } };
  const assessment = new RiskEngine({ capabilityRegistry: registry }).assess(plan, {});
  const decision = new PolicyEngine().decide(assessment, plan, { capabilities: [interact] });
  assert.equal(decision.effect, "CONFIRM");
});

// ---- "not playing", read one beat too early ---------------------------------
//
// Measured live, 29 Aug 2026, "play ankhose batana on spotify": the playback
// read returned playing=false, `play_music` reported REFUTED — "Spotify is not
// playing: no track started" — and the very next `screen`, one step later,
// showed "Spotify — Dikshant - Aankhon Se Batana" with a Pause button. The
// track had started; the read simply beat the transport to it.
//
// A step on this endpoint costs ~5,300 fresh tokens whatever it does, because
// the prompt cache serves whole 8,192-token blocks and the fixed prefix is
// re-bought every time. The two steps the model then spent proving the thing
// had worked cost about 10,000 tokens — half the run — for want of 400ms.
//
// THE SPEED GUARANTEE IS WHAT THESE MOSTLY COVER. The settle is off by default
// and short-circuits the moment a reading says "playing", so no existing caller
// and no successful play can be slowed down by it.

const countingAdapter = (readings) => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  const calls = [];
  adapter._readSpotifyPlaybackOnce = async () => {
    const reading = readings[Math.min(calls.length, readings.length - 1)];
    calls.push(reading);
    return reading;
  };
  return { adapter, calls };
};

const PLAYING = { running: true, playing: true, title: "Aankhon Se Batana", nowPlaying: "Aankhon Se Batana" };
const SILENT = { running: true, playing: false, title: null, nowPlaying: null };

test("an ordinary playback read still costs exactly one look", async () => {
  // Every existing caller — screen, the capability's verify, media-providers —
  // passes no options. If this ever becomes two reads, every one of them pays
  // for a UIA scan of Spotify's Chromium tree that it did not ask for.
  const { adapter, calls } = countingAdapter([SILENT, PLAYING]);
  const state = await adapter.readSpotifyPlayback();
  assert.equal(calls.length, 1, "the default read must not settle");
  assert.equal(state.playing, false);
});

test("a track that is already playing is not waited for", async () => {
  // The happy path, and the one that must not get slower: the first reading
  // says "playing", so there is nothing to settle and nothing to pay for.
  const { adapter, calls } = countingAdapter([PLAYING, PLAYING]);
  const state = await adapter.readSpotifyPlayback({ confirmStart: true, settleMs: 0 });
  assert.equal(calls.length, 1, "a confirmed reading must return immediately");
  assert.equal(state.playing, true);
});

test("a transport that has not caught up yet is read again rather than called a failure", async () => {
  const { adapter, calls } = countingAdapter([SILENT, PLAYING]);
  const state = await adapter.readSpotifyPlayback({ confirmStart: true, settleMs: 0 });
  assert.equal(calls.length, 2);
  assert.equal(state.playing, true);
  assert.equal(state.nowPlaying, "Aankhon Se Batana");
});

test("silence that is really silence is still reported as silence", async () => {
  // The settle re-reads the same authoritative signal — a Pause button inside
  // the Player controls group — so it can only ever turn a premature "no" into
  // a "yes". It must never invent a track, or this becomes the false-success
  // defect it was written to prevent.
  const { adapter, calls } = countingAdapter([SILENT, SILENT]);
  const state = await adapter.readSpotifyPlayback({ confirmStart: true, settleMs: 0 });
  assert.equal(calls.length, 2, "one retry, not an unbounded poll");
  assert.equal(state.playing, false);
  assert.equal(state.nowPlaying, null);
});

test("a Spotify that is not running is not waited for either", async () => {
  // Waiting for a track to start in an application that is not there is waiting
  // for something that cannot happen.
  const { adapter, calls } = countingAdapter([{ running: false, playing: false }, PLAYING]);
  const state = await adapter.readSpotifyPlayback({ confirmStart: true, settleMs: 0 });
  assert.equal(calls.length, 1);
  assert.equal(state.playing, false);
});
