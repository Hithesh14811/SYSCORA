import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import {
  MEDIA_CAPABILITIES,
  MediaProviderRegistry,
  createSpotifyMediaProvider,
  registerMediaCapabilities
} from "../../packages/capability-registry/src/media-providers.js";

// A second, entirely fictional player. It exists to prove the contract is not
// Spotify-shaped: the same plan must work against it with no new branches.
function fakePlayer(id, applicationName, state = {}) {
  const live = { playing: false, nowPlaying: null, queue: [], ...state };
  return {
    id,
    applicationName,
    installed: state.installed !== false,
    async resolve() {
      return { available: this.installed, running: live.playing, reason: this.installed ? null : "NO_INSTALLED_IDENTITY" };
    },
    async search(query) { return { opened: true, query }; },
    async play(query) { live.playing = true; live.nowPlaying = query; return { requested: query }; },
    async pause() { live.playing = false; return { paused: true }; },
    async queueAdd(query) { live.queue.push(query); return { requested: query }; },
    async nowPlaying() { return { playing: live.playing, nowPlaying: live.nowPlaying, title: live.nowPlaying }; },
    async queueInspect(query) { return { queued: live.queue.includes(query), queue: [...live.queue] }; },
    _live: live
  };
}

function buildRegistry(providers) {
  const registry = new CapabilityRegistry();
  const providerRegistry = new MediaProviderRegistry();
  for (const provider of providers) providerRegistry.register(provider);
  registerMediaCapabilities(registry, providerRegistry);
  return { registry, providerRegistry };
}

async function run(registry, name, inputs) {
  const capability = registry.get(name);
  const executionResult = await capability.execute(inputs);
  const observation = await capability.observe(executionResult, inputs);
  const verification = await capability.verify(observation, inputs);
  return { executionResult, observation, verification };
}

test("the media contract registers one provider-neutral capability set", () => {
  const { registry } = buildRegistry([fakePlayer("aurora", "Aurora")]);
  for (const name of MEDIA_CAPABILITIES) {
    assert.ok(registry.has(name), `${name} must be registered`);
    assert.ok(registry.get(name).description, `${name} needs a description`);
  }
});

test("the same play-then-queue plan works against two unrelated players", async () => {
  for (const [id, applicationName] of [["aurora", "Aurora"], ["cascade", "Cascade Player"]]) {
    const { registry } = buildRegistry([fakePlayer(id, applicationName)]);

    const played = await run(registry, "media.play", { application: applicationName, query: "Good For You" });
    assert.equal(played.verification.status, "VERIFIED", applicationName);

    const queued = await run(registry, "media.queue.add", { application: applicationName, query: "Billie Jean" });
    assert.equal(queued.verification.status, "VERIFIED", applicationName);

    const inspected = await run(registry, "media.nowPlaying.inspect", { application: applicationName });
    assert.equal(inspected.observation.structuredState.nowPlaying, "Good For You", applicationName);
  }
});

test("playback is verified from the player's live state, not from the play call's return value", async () => {
  // A player that accepts the request but never actually starts.
  const stubborn = fakePlayer("stuck", "Stuck Player");
  stubborn.play = async (query) => ({ requested: query });
  const { registry } = buildRegistry([stubborn]);
  const result = await run(registry, "media.play", { application: "Stuck Player", query: "Good For You" });
  assert.equal(result.verification.status, "FAILED");
  assert.match(result.verification.message, /could not confirm|not playing/i);
});

test("playing the wrong track is a failure, not a success", async () => {
  const wrong = fakePlayer("wrong", "Wrong Player");
  wrong.play = async () => { wrong._live.playing = true; wrong._live.nowPlaying = "Some Other Song"; return {}; };
  const { registry } = buildRegistry([wrong]);
  const result = await run(registry, "media.play", { application: "Wrong Player", query: "Good For You" });
  assert.equal(result.verification.status, "FAILED");
  assert.match(result.verification.message, /Some Other Song/);
});

test("an uninstalled player resolves as a missing prerequisite rather than a playback failure", async () => {
  const { registry } = buildRegistry([fakePlayer("ghost", "Ghost Player", { installed: false })]);
  const result = await run(registry, "media.application.resolve", { application: "Ghost Player" });
  assert.equal(result.observation.structuredState.available, false);
  assert.equal(result.verification.status, "FAILED");
  assert.equal(result.verification.failureCategory, "APPLICATION_NOT_INSTALLED");
});

test("an unknown application is rejected instead of silently using another player", async () => {
  const { registry } = buildRegistry([fakePlayer("aurora", "Aurora")]);
  const result = await run(registry, "media.play", { application: "Nonexistent Player", query: "x" });
  assert.equal(result.verification.status, "FAILED");
  assert.equal(result.verification.failureCategory, "MEDIA_PROVIDER_NOT_FOUND");
});

test("with exactly one registered provider the application may be omitted", async () => {
  const { registry } = buildRegistry([fakePlayer("aurora", "Aurora")]);
  const result = await run(registry, "media.play", { query: "Good For You" });
  assert.equal(result.verification.status, "VERIFIED");
});

test("with several providers and no named application the request is ambiguous, not guessed", async () => {
  const { registry } = buildRegistry([fakePlayer("aurora", "Aurora"), fakePlayer("cascade", "Cascade Player")]);
  const result = await run(registry, "media.play", { query: "Good For You" });
  assert.equal(result.verification.status, "FAILED");
  assert.equal(result.verification.failureCategory, "MEDIA_PROVIDER_AMBIGUOUS");
});

test("pausing is verified from live state", async () => {
  const player = fakePlayer("aurora", "Aurora");
  const { registry } = buildRegistry([player]);
  await run(registry, "media.play", { query: "Good For You" });
  const paused = await run(registry, "media.pause", {});
  assert.equal(paused.verification.status, "VERIFIED");
  assert.equal(player._live.playing, false);
});

test("the Spotify provider implements the same contract over the existing adapter", async () => {
  const adapter = {
    resolveApplicationTarget: async () => ({ resolved: true, kind: "start-menu", target: "Spotify" }),
    playSpotifyTrack: async (query) => ({ query, playback: { playing: true } }),
    queueSpotifyTrack: async (query) => ({ query, queued: true }),
    openSpotifySearch: async (query) => ({ query, opened: true }),
    readSpotifyPlayback: async () => ({ running: true, playing: true, nowPlaying: "Good For You", title: "Good For You" }),
    readSpotifyQueue: async () => ({ queued: true })
  };
  const provider = createSpotifyMediaProvider(adapter);
  const { registry } = buildRegistry([provider]);
  const result = await run(registry, "media.play", { application: "Spotify", query: "Good For You" });
  assert.equal(result.verification.status, "VERIFIED");
  assert.match(result.verification.message, /Good For You/);
});
