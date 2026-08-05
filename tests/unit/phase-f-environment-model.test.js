import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentModel, Freshness } from "../../packages/context-engine/src/environment-model.js";

// A fake Windows adapter. Every answer the model gives must be traceable to one
// of these calls — the model itself never guesses.
function fakeAdapter(overrides = {}) {
  return {
    resolveApplicationTarget: async (application) => (
      application.toLowerCase() === "spotify"
        ? { application, resolved: true, kind: "start-menu", target: "Spotify.AppID", reason: null }
        : { application, resolved: false, kind: null, target: null, reason: "NO_INSTALLED_IDENTITY" }
    ),
    listProcesses: async () => [
      { Id: 4242, ProcessName: "Spotify", Path: "C:\\Users\\x\\Spotify\\Spotify.exe" },
      { Id: 900, ProcessName: "node", Path: "C:\\node\\node.exe" }
    ],
    listWindows: async () => [
      { WindowHandle: "0x11", Id: 4242, ProcessName: "Spotify", MainWindowTitle: "Spotify Premium" },
      { WindowHandle: "0x22", Id: 900, ProcessName: "node", MainWindowTitle: "" }
    ],
    inspectPort: async (port) => (
      port === 3000
        ? { port, listening: true, status: "LISTENING", connections: [{ OwningProcess: 900 }], probe: { ok: true } }
        : { port, listening: false, status: "NOT_LISTENING", connections: [], probe: { ok: true } }
    ),
    ...overrides
  };
}

test("the model answers whether an application is installed, running and which window is its own", async () => {
  const model = new EnvironmentModel({ adapter: fakeAdapter() });
  const spotify = await model.resolveApplication("Spotify");

  assert.equal(spotify.installed, true);
  assert.equal(spotify.installedIdentity.kind, "start-menu");
  assert.equal(spotify.running, true);
  assert.deepEqual(spotify.processes.map((p) => p.processId), [4242]);
  assert.deepEqual(spotify.windows.map((w) => w.windowId), ["0x11"]);
  // application -> executable -> process -> window is a resolved chain, not a guess.
  assert.equal(spotify.windows[0].processId, 4242);
  assert.ok(spotify.observedAt);
  assert.equal(spotify.freshness, Freshness.FRESH);
  assert.ok(spotify.source);
});

test("a name that is not installed is reported as absent rather than as a grounding failure", async () => {
  const model = new EnvironmentModel({ adapter: fakeAdapter() });
  const missing = await model.resolveApplication("youtube");
  assert.equal(missing.installed, false);
  assert.equal(missing.running, false);
  assert.equal(missing.reason, "NO_INSTALLED_IDENTITY");
  assert.deepEqual(missing.windows, []);
});

test("an installed application with no live process is running:false, not installed:false", async () => {
  const model = new EnvironmentModel({
    adapter: fakeAdapter({ listProcesses: async () => [], listWindows: async () => [] })
  });
  const spotify = await model.resolveApplication("Spotify");
  assert.equal(spotify.installed, true);
  assert.equal(spotify.running, false);
  assert.deepEqual(spotify.windows, []);
});

test("the model names the application that owns a port", async () => {
  const model = new EnvironmentModel({ adapter: fakeAdapter() });
  const owned = await model.resolvePort(3000);
  assert.equal(owned.listening, true);
  assert.equal(owned.owners[0].processId, 900);
  assert.equal(owned.owners[0].processName, "node");
  assert.equal(owned.freshness, Freshness.FRESH);

  const free = await model.resolvePort(4001);
  assert.equal(free.listening, false);
  assert.deepEqual(free.owners, []);
  assert.equal(free.status, "NOT_LISTENING");
});

test("an indeterminate probe never becomes a confident 'nothing is listening'", async () => {
  const model = new EnvironmentModel({
    adapter: fakeAdapter({
      inspectPort: async (port) => ({ port, listening: null, status: "INDETERMINATE", connections: [], probe: { ok: false } })
    })
  });
  const answer = await model.resolvePort(3000);
  assert.equal(answer.listening, null);
  assert.equal(answer.status, "INDETERMINATE");
  assert.equal(answer.freshness, Freshness.UNKNOWN);
});

test("the model finds the browser tab holding an expected site", async () => {
  const browserAdapter = {
    listTargets: async () => [
      { targetId: "t1", url: "https://mail.example.com/inbox", title: "Inbox" },
      { targetId: "t2", url: "https://www.youtube.com/watch?v=abc", title: "A video - YouTube" }
    ]
  };
  const model = new EnvironmentModel({ adapter: fakeAdapter(), browserAdapter });
  const tab = await model.resolveBrowserTab({ urlContains: "youtube.com" });
  assert.equal(tab.found, true);
  assert.equal(tab.tab.targetId, "t2");
  assert.equal(tab.source, "DOM");

  const absent = await model.resolveBrowserTab({ urlContains: "example.org" });
  assert.equal(absent.found, false);
  assert.equal(absent.tab, null);
});

test("freshness is decided from the observation age, not from whether an answer exists", async () => {
  const model = new EnvironmentModel({ adapter: fakeAdapter(), ttlMs: { application: 50 } });
  const spotify = await model.resolveApplication("Spotify");
  assert.equal(model.isFresh(spotify), true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(model.isFresh(spotify), false);
  assert.equal(model.classify(spotify), Freshness.STALE);
  // An explicit maximum age overrides the entity-class default.
  assert.equal(model.isFresh(spotify, 10_000), true);
});

test("every answer carries provenance and a sensitivity classification", async () => {
  const model = new EnvironmentModel({ adapter: fakeAdapter() });
  for (const answer of [
    await model.resolveApplication("Spotify"),
    await model.resolvePort(3000)
  ]) {
    assert.ok(answer.source, "source");
    assert.ok(answer.observedAt, "observedAt");
    assert.ok(Number.isFinite(answer.ttlMs), "ttlMs");
    assert.ok(Number.isFinite(answer.confidence), "confidence");
    assert.ok(["PUBLIC", "INTERNAL", "SENSITIVE"].includes(answer.sensitivity), "sensitivity");
  }
});

test("a probe that throws degrades to an unknown answer instead of an exception", async () => {
  const model = new EnvironmentModel({
    adapter: fakeAdapter({ listWindows: async () => { throw new Error("host unavailable"); } })
  });
  const spotify = await model.resolveApplication("Spotify");
  assert.equal(spotify.installed, true);
  assert.deepEqual(spotify.windows, []);
  assert.ok(spotify.degraded.includes("windows"));
});
