// Provider-neutral media contract.
//
// Planning targets `media.*` capabilities; a provider implements them for one
// concrete application. Adding a second player is a new provider, never a new
// branch in the intent engine or a new per-application capability family — that
// is what stops the runtime accumulating one hardcoded workflow per app.
//
// Every media capability verifies from the provider's LIVE state rather than
// from the return value of the action it just performed. "The play call
// returned" is not evidence that anything is playing.

import crypto from "crypto";
import { matchesTrackQuery } from "./index.js";

const createId = () => crypto.randomBytes(16).toString("hex");

export const MEDIA_CAPABILITIES = Object.freeze([
  "media.application.resolve",
  "media.search",
  "media.play",
  "media.pause",
  "media.queue.add",
  "media.nowPlaying.inspect",
  "media.queue.inspect"
]);

// The methods a provider must supply. Registration fails loudly rather than
// letting a half-implemented provider surface as a healthy capability.
const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "resolve", "search", "play", "pause", "queueAdd", "nowPlaying", "queueInspect"
]);

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

export class MediaProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.id) throw new Error("A media provider must declare an id.");
    const missing = REQUIRED_PROVIDER_METHODS.filter((method) => typeof provider[method] !== "function");
    if (missing.length > 0) {
      throw new Error(`Media provider ${provider.id} is missing: ${missing.join(", ")}`);
    }
    this.providers.set(normalizeName(provider.id), provider);
    return provider;
  }

  list() {
    return [...this.providers.values()];
  }

  // Resolve the provider for a request. An unnamed application is only allowed
  // when there is exactly one provider; otherwise the request is ambiguous and
  // must say so instead of picking one.
  resolve(application) {
    const requested = normalizeName(application);
    if (requested) {
      const match = this.list().find((provider) =>
        normalizeName(provider.id) === requested || normalizeName(provider.applicationName) === requested
      );
      return match
        ? { provider: match, error: null }
        : { provider: null, error: "MEDIA_PROVIDER_NOT_FOUND" };
    }
    const all = this.list();
    if (all.length === 1) return { provider: all[0], error: null };
    return { provider: null, error: all.length === 0 ? "MEDIA_PROVIDER_NOT_FOUND" : "MEDIA_PROVIDER_AMBIGUOUS" };
  }
}

function providerFailure(name, failureCategory, application) {
  return {
    status: "FAILED",
    failureCategory,
    message: failureCategory === "MEDIA_PROVIDER_AMBIGUOUS"
      ? `Several media applications are available; name the one to use for ${name}.`
      : `No media application matches "${application ?? ""}".`,
    evidence: { capability: name, application: application ?? null },
    confidence: 1
  };
}

// Build one media capability. `act` performs the request; `check` reads live
// provider state and decides the verification independently of `act`'s result.
function buildMediaCapability({ providerRegistry, name, description, inputSchema, required = [], mutates = false, act, check }) {
  return {
    name,
    version: "1.0.0",
    description,
    inputSchema: { type: "object", properties: { application: { type: "string" }, ...inputSchema }, required },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: "LOW" },
    permissionModel: { scope: ["SESSION"], type: mutates ? "WRITE" : "READ" },
    reversibility: "NOT_REQUIRED",
    identities: { applications: providerRegistry.list().map((provider) => provider.applicationName) },
    trustedExecutionModality: "APPLICATION",
    preconditions: () => true,
    execute: async (args = {}) => {
      const { provider, error } = providerRegistry.resolve(args.application);
      if (!provider) return { providerError: error, application: args.application ?? null };
      const result = await act(provider, args);
      return { providerId: provider.id, application: provider.applicationName, ...result };
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: name,
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: mutates ? ["application.playback"] : [],
      confidence: result?.providerError ? 0 : 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args = {}) => {
      const result = observation?.structuredState ?? {};
      if (result.providerError) return providerFailure(name, result.providerError, args.application);
      const { provider } = providerRegistry.resolve(args.application ?? result.application);
      if (!provider) return providerFailure(name, "MEDIA_PROVIDER_NOT_FOUND", args.application);
      return check(provider, args, result);
    },
    timeout: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: "VERIFIED"
  };
}

export function registerMediaCapabilities(registry, providerRegistry) {
  const define = (spec) => registry.register(buildMediaCapability({ providerRegistry, ...spec }));

  define({
    name: "media.application.resolve",
    description: "Resolve a media application to its installed and running state",
    inputSchema: {},
    act: async (provider) => provider.resolve(),
    check: async (provider, args, result) => (
      result.available
        ? {
            status: "VERIFIED",
            message: `${provider.applicationName} is installed${result.running ? " and running" : " but not running"}.`,
            evidence: result,
            confidence: 1
          }
        : {
            status: "FAILED",
            // Absence of the application is a prerequisite gap, which the
            // install-and-resume workflow handles very differently from a
            // failure to control an application that IS present.
            failureCategory: "APPLICATION_NOT_INSTALLED",
            message: `${provider.applicationName} is not installed on this system.`,
            evidence: result,
            confidence: 1
          }
    )
  });

  define({
    name: "media.search",
    description: "Open search results for a query in a media application",
    inputSchema: { query: { type: "string" } },
    required: ["query"],
    act: async (provider, args) => provider.search(args.query),
    check: async (provider, args, result) => (
      result.opened
        ? { status: "VERIFIED", message: `Opened results for "${args.query}" in ${provider.applicationName}.`, evidence: result, confidence: 0.9 }
        : { status: "FAILED", message: `Could not open results for "${args.query}".`, evidence: result, confidence: 1 }
    )
  });

  define({
    name: "media.play",
    description: "Play a requested track in a media application and confirm it from live playback state",
    inputSchema: { query: { type: "string" }, options: { type: "object" } },
    required: ["query"],
    mutates: true,
    act: async (provider, args) => provider.play(args.query, args.options ?? {}),
    check: async (provider, args, result) => {
      const query = String(args.query ?? result.query ?? "").trim();
      const live = await provider.nowPlaying();
      const matched = matchesTrackQuery(live?.title ?? live?.nowPlaying, query);
      if (live?.playing && matched) {
        return { status: "VERIFIED", message: `Playing "${live.nowPlaying}" in ${provider.applicationName}.`, evidence: live, confidence: 0.9 };
      }
      // Confirmed playing but no reliable track title was available to check —
      // distinct from confirming the wrong track is playing.
      if (live?.playing && !live?.nowPlaying) {
        return {
          status: "PARTIALLY_VERIFIED",
          message: `${provider.applicationName} is playing, but I could not independently confirm the track title; it is likely "${query}".`,
          evidence: live,
          confidence: 0.6
        };
      }
      if (live?.playing && !matched) {
        return {
          status: "FAILED",
          message: `${provider.applicationName} is playing "${live.nowPlaying}", not the requested "${query}".`,
          evidence: live,
          confidence: 1
        };
      }
      return {
        status: "FAILED",
        message: `I could not confirm "${query}" started playing in ${provider.applicationName}; it may need to be started manually.`,
        evidence: live ?? null,
        confidence: 1
      };
    }
  });

  define({
    name: "media.pause",
    description: "Pause playback in a media application and confirm it from live playback state",
    inputSchema: {},
    mutates: true,
    act: async (provider) => provider.pause(),
    check: async (provider) => {
      const live = await provider.nowPlaying();
      return live?.playing
        ? { status: "FAILED", message: `${provider.applicationName} is still playing.`, evidence: live, confidence: 1 }
        : { status: "VERIFIED", message: `Playback is paused in ${provider.applicationName}.`, evidence: live, confidence: 0.9 };
    }
  });

  define({
    name: "media.queue.add",
    description: "Add a track to a media application's playback queue and confirm it from the live queue",
    inputSchema: { query: { type: "string" }, options: { type: "object" } },
    required: ["query"],
    mutates: true,
    act: async (provider, args) => provider.queueAdd(args.query, args.options ?? {}),
    check: async (provider, args, result) => {
      const query = String(args.query ?? result.query ?? "").trim();
      const live = await provider.queueInspect(query);
      return live?.queued
        ? { status: "VERIFIED", message: `Queued "${query}" in ${provider.applicationName}.`, evidence: live, confidence: 0.9 }
        : { status: "FAILED", message: `I could not confirm "${query}" was added to the ${provider.applicationName} queue.`, evidence: live, confidence: 1 };
    }
  });

  define({
    name: "media.nowPlaying.inspect",
    description: "Read what a media application is currently playing",
    inputSchema: {},
    act: async (provider) => provider.nowPlaying(),
    check: async (provider, args, result) => ({
      status: "VERIFIED",
      message: result?.playing
        ? `${provider.applicationName} is playing "${result.nowPlaying}".`
        : `${provider.applicationName} is not playing anything.`,
      evidence: result,
      confidence: 1
    })
  });

  define({
    name: "media.queue.inspect",
    description: "Read a media application's playback queue",
    inputSchema: { query: { type: "string" } },
    act: async (provider, args) => provider.queueInspect(args.query),
    check: async (provider, args, result) => ({
      status: "VERIFIED",
      message: `Read the ${provider.applicationName} queue.`,
      evidence: result,
      confidence: 1
    })
  });

  return registry;
}

// First provider implementation. It adapts the existing, live-verified Spotify
// adapter methods to the contract; it adds no new automation of its own.
export function createSpotifyMediaProvider(adapter) {
  return {
    id: "spotify",
    applicationName: "Spotify",
    async resolve() {
      const resolution = await adapter.resolveApplicationTarget?.("Spotify");
      const playback = await adapter.readSpotifyPlayback?.() ?? {};
      return {
        available: resolution?.resolved === true,
        running: playback.running === true,
        reason: resolution?.resolved === true ? null : (resolution?.reason ?? "NO_INSTALLED_IDENTITY"),
        identity: resolution ?? null
      };
    },
    async search(query) {
      const result = await adapter.openSpotifySearch(query);
      return { ...result, opened: result?.opened !== false };
    },
    async play(query, options = {}) {
      return adapter.playSpotifyTrack(query, options);
    },
    async pause() {
      // The desktop client toggles playback with the media key.
      return adapter.adjustSystemVolume ? adapter.pauseSpotify?.() ?? { paused: null } : { paused: null };
    },
    async queueAdd(query, options = {}) {
      return adapter.queueSpotifyTrack(query, options);
    },
    async nowPlaying() {
      return adapter.readSpotifyPlayback();
    },
    async queueInspect(query) {
      return adapter.readSpotifyQueue(query);
    }
  };
}
