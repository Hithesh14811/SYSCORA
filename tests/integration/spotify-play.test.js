// Mocked integration tests for spotify.track.play through the REAL runtime
// (real IntentEngine → planner → risk → policy → permission → scheduler →
// observe → verify), with only the OS adapter faked. No real Windows side
// effects. Proves: a successful play is reported COMPLETED, and each failure mode
// (not installed / result not found / UI timeout / playback-verification failure)
// is reported honestly as FAILED — never a false success — and never loops
// forever.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { RecoveryEngine } from "../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ContextEngine } from "../../packages/context-engine/src/index.js";

let counter = 0;

async function buildRuntime(adapter, { reasoningEngine = null } = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `syscora-spot-${counter++}-`));
  const registry = createDefaultCapabilityRegistry(adapter);
  const runtime = new AgentRuntime({
    sessionStore: new SessionStore(path.join(tempRoot, "sessions")),
    auditRepository: new AuditRepository(path.join(tempRoot, "audit")),
    capabilityRegistry: registry,
    riskEngine: new RiskEngine({ capabilityRegistry: registry }),
    policyEngine: new PolicyEngine(),
    permissionBroker: new PermissionBroker(),
    recoveryEngine: new RecoveryEngine(),
    troubleshootingEngine: new TroubleshootingEngine(),
    adapter,
    ...(reasoningEngine ? { reasoningEngine } : {}),
    // Deterministic intent classification; no semanticState/memory so no
    // perception sweep runs (mirrors the runtime fast path for this operation).
    intentEngine: new IntentEngine(reasoningEngine),
    contextEngine: new ContextEngine([])
  });
  return { runtime, tempRoot };
}

const PLAY_PROMPT = "play Cry For Me by The Weeknd on Spotify";

test("successful play is reported COMPLETED with the now-playing track", async () => {
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({
      query, available: true, launched: true, windowReady: true, searchOpened: true,
      invoked: true, title: "The Weeknd - Cry For Me",
      playback: { playing: true, title: "The Weeknd - Cry For Me", nowPlaying: "The Weeknd - Cry For Me" }
    }),
    readSpotifyPlayback: async () => ({
      running: true, playing: true, title: "The Weeknd - Cry For Me", nowPlaying: "The Weeknd - Cry For Me"
    })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.equal(s.plan.plannerSource, "DIRECT_OPERATION");
    assert.notEqual(s.finalResponse.status, "AWAITING_APPROVAL");
    assert.equal(s.finalResponse.status, "COMPLETED", `expected COMPLETED, got ${s.finalResponse.status}`);
    const lastMessage = s.verifications.at(-1)?.message ?? "";
    assert.match(lastMessage, /Playing "The Weeknd - Cry For Me" in Spotify/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("compound play and queue request completes both ordered capabilities", async () => {
  const calls = [];
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => {
      calls.push(["play", query]);
      return { query, available: true, invoked: true, playback: { playing: true, title: "Jagave Neenu Gelathiye" } };
    },
    readSpotifyPlayback: async () => ({ running: true, playing: true, title: "Jagave Neenu Gelathiye", nowPlaying: "Jagave Neenu Gelathiye" }),
    queueSpotifyTrack: async (query) => {
      calls.push(["queue", query]);
      return { query, available: true, queued: true };
    },
    readSpotifyQueue: async (query) => ({ query, queued: true, evidence: "Cry For Me", source: "queue-panel" })
  });
  try {
    const session = await runtime.submitIntent("play jagave neenu gelatiye on spotify and then put cry for me on queue", { autoApprove: true });
    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.deepEqual(session.plan.taskGraph.tasks.map((task) => task.capability), ["spotify.track.play", "spotify.track.queue"]);
    assert.deepEqual(calls, [["play", "jagave neenu gelatiye"], ["queue", "cry for me"]]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("model-routed Spotify request keeps the typed plan ahead of generic interactive control", async () => {
  let interactiveCalls = 0;
  const reasoningEngine = {
    hasModel: () => true,
    isModelHealthy: async () => true,
    understandIntent: async () => ({ ok: true, data: {
      operation: "spotify.track.play",
      normalizedGoal: "Play Jagave Neenu Gelatiye and queue Cry For Me",
      category: "APPLICATION",
      entities: {},
      successCriteria: ["Jagave Neenu Gelatiye is playing", "Cry For Me is queued"],
      confidence: 0.95
    } }),
    decideInteractiveAction: async () => {
      interactiveCalls += 1;
      throw new Error("generic interactive controller must not run");
    }
  };
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({ query, available: true, invoked: true, playback: { playing: true, title: "Jagave Neenu Gelathiye" } }),
    readSpotifyPlayback: async () => ({ running: true, playing: true, title: "Jagave Neenu Gelathiye", nowPlaying: "Jagave Neenu Gelathiye" }),
    queueSpotifyTrack: async (query) => ({ query, available: true, queued: true }),
    readSpotifyQueue: async (query) => ({ query, queued: true, evidence: "Cry For Me" })
  }, { reasoningEngine });
  try {
    const session = await runtime.submitIntent("play jagave neenu gelatiye on spotify and then put cry for me on queue", { autoApprove: true });
    assert.equal(session.finalResponse.status, "COMPLETED");
    assert.equal(interactiveCalls, 0);
    assert.deepEqual(session.plan.taskGraph.tasks.map((task) => task.capability), ["spotify.track.play", "spotify.track.queue"]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("every known direct operation stays ahead of generic interactive control", async () => {
  let interactiveCalls = 0;
  const reasoningEngine = {
    hasModel: () => true,
    isModelHealthy: async () => true,
    understandIntent: async () => ({ ok: true, data: {
      operation: "application.launch",
      normalizedGoal: "Open Calculator",
      category: "APPLICATION",
      entities: { application: "calculator" },
      successCriteria: ["Calculator is open"],
      confidence: 0.95
    } }),
    decideInteractiveAction: async () => {
      interactiveCalls += 1;
      throw new Error("generic interactive controller must not run");
    }
  };
  const { runtime, tempRoot } = await buildRuntime({
    launchApplication: async (application) => ({
      application,
      launch: { started: true },
      window: { WindowHandle: 99, ProcessName: "Calculator", MainWindowTitle: "Calculator" },
      grounding: { grounded: true, readinessState: "APPLICATION_READY" }
    }),
    listWindows: async () => [{ WindowHandle: 99, ProcessName: "Calculator", MainWindowTitle: "Calculator" }]
  }, { reasoningEngine });
  try {
    const session = await runtime.submitIntent("open calculator", { autoApprove: true });
    assert.equal(interactiveCalls, 0);
    assert.equal(session.plan.plannerSource, "DIRECT_OPERATION");
    assert.deepEqual(session.plan.taskGraph.tasks.map((task) => task.capability), ["application.launch"]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Spotify not installed is reported FAILED, not success", async () => {
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({
      query, available: false, reason: "Spotify does not appear to be installed or could not be launched.",
      playback: { playing: false }
    }),
    readSpotifyPlayback: async () => ({ running: false, playing: false, title: "" })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.notEqual(s.finalResponse.status, "COMPLETED");
    assert.match(JSON.stringify(s.finalResponse), /installed/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("search result not found / nothing playing is reported FAILED", async () => {
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({
      query, available: true, launched: true, windowReady: true, searchOpened: true,
      invoked: false, title: "Spotify Premium", playback: { playing: false, title: "Spotify Premium" }
    }),
    readSpotifyPlayback: async () => ({ running: true, playing: false, title: "Spotify Premium" })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.notEqual(s.finalResponse.status, "COMPLETED");
    assert.match(JSON.stringify(s.finalResponse), /couldn't confirm the track started playing/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("UI window timeout is reported FAILED", async () => {
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({
      query, available: true, launched: true, windowReady: false, timedOut: true,
      reason: "Spotify window did not become ready within the allotted time.",
      playback: { playing: false, title: "Spotify" }
    }),
    readSpotifyPlayback: async () => ({ running: true, playing: false, title: "Spotify" })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.notEqual(s.finalResponse.status, "COMPLETED");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("independent verification catches a false 'invoked' (playback-verification failure)", async () => {
  // execute() claims it invoked play, but the INDEPENDENT live read shows the
  // window is still idle — so the runtime must NOT report success.
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => ({
      query, available: true, launched: true, windowReady: true, searchOpened: true,
      invoked: true, title: "The Weeknd - Cry For Me",
      playback: { playing: true, title: "The Weeknd - Cry For Me" }
    }),
    // The truth: nothing is actually playing.
    readSpotifyPlayback: async () => ({ running: true, playing: false, title: "Spotify Premium" })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.notEqual(s.finalResponse.status, "COMPLETED", "must not trust execute()'s own claim");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("a persistently failing UI interaction stops — no infinite replan loop", async () => {
  let playCalls = 0;
  const { runtime, tempRoot } = await buildRuntime({
    playSpotifyTrack: async (query) => {
      playCalls += 1;
      return { query, available: true, launched: true, windowReady: true, searchOpened: true, invoked: false, playback: { playing: false } };
    },
    readSpotifyPlayback: async () => ({ running: true, playing: false, title: "Spotify" })
  });
  try {
    const s = await runtime.submitIntent(PLAY_PROMPT, { autoApprove: true });
    assert.notEqual(s.finalResponse.status, "COMPLETED");
    const replans = (s.events ?? []).filter((e) => e.eventType === "STARTING_REPLANNING").length;
    assert.equal(replans, 0, "ABORT_ON_FAILURE must prevent any replan");
    assert.ok(playCalls <= 2, `bounded attempts only, got ${playCalls}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
