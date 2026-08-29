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
  assert.deepEqual(requests.map((request) => request.operation), ["ui.find", "ui.action"]);
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
