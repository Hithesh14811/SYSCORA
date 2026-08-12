import { RiskLevel } from "../../shared-types/src/domain.js";
import { ExecutionModality, modalityProfile, validateInteractionTarget } from "../../shared-types/src/execution.js";
import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import { PRIVILEGED_OPERATIONS } from "../../privileged-helpers/src/index.js";
import { captureScreenSnapshotViaAdapter } from "../../perception/src/vision-provider.js";
import { classifyShellCommand, ShellVerdict } from "../../policy-engine/src/shell-rules.js";
import crypto from "crypto";
import {
  CAPABILITY_CONTRACT_VERSION,
  ConfirmationPolicy,
  CapabilityHealth,
  isCapabilityHealthy,
  normalizeCapability,
  satisfiesVersion,
  validateCapabilityContract
} from "./contract.js";
import {
  MediaProviderRegistry,
  createSpotifyMediaProvider,
  registerMediaCapabilities
} from "./media-providers.js";
export { MEDIA_CAPABILITIES, MediaProviderRegistry, createSpotifyMediaProvider, registerMediaCapabilities } from "./media-providers.js";
export {
  PermissionScope,
  PermissionType,
  ApprovalReusePolicy,
  DEFAULT_WRITE_GRANT_TTL_MS,
  DEFAULT_READ_GRANT_TTL_MS
} from "./contract.js";
import { CapabilityLifecyclePipeline } from "./pipeline.js";
export { CapabilityPluginLoader, MANIFEST_FILE } from "./plugin-loader.js";
export { createPluginSignatureVerifier, loadTrustedKeys } from "./signature.js";
export { createCapabilityTemplate } from "./template.js";
export { validateCapabilityPackage, validatePluginCapabilityDefinition, validatePluginManifest } from "./quality.js";
const createId = () => crypto.randomBytes(16).toString("hex");

// Loose match between a requested track query and the live "now playing" title.
// Tokenizes both, drops short/common filler words, and returns true when a
// meaningful share of the query's significant tokens appear in the title. This is
// what lets spotify.track.play confirm it played the REQUESTED track (not merely
// "something is playing"). Deterministic and side-effect free.
const TRACK_STOPWORDS = new Set([
  "the", "a", "an", "by", "for", "on", "in", "of", "and", "to", "feat", "ft", "with",
  "song", "track", "play", "spotify", "version", "remaster", "remastered"
]);
function trackTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !TRACK_STOPWORDS.has(t));
}
function tokenDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const prior = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[b.length];
}
export function matchesTrackQuery(title, query) {
  const q = trackTokens(query);
  if (q.length === 0) return false;
  const titleTokens = new Set(trackTokens(title));
  if (titleTokens.size === 0) return false;
  const hits = q.filter((tok) => [...titleTokens].some((candidate) =>
    candidate === tok || (tok.length >= 2 && candidate.length >= 2 && tokenDistance(candidate, tok) <= 1)
  )).length;
  // Playback verification is deliberately stricter than search ranking: every
  // meaningful requested track token must appear in the live title. A partial
  // match could otherwise claim the wrong song was playing.
  return hits === q.length;
}

export function matchesMediaQuery(title, query) {
  const q = trackTokens(query);
  if (q.length === 0) return false;
  const titleTokens = new Set(trackTokens(title));
  const hits = q.filter((token) => titleTokens.has(token)).length;
  return hits >= Math.max(1, Math.ceil(q.length / 2));
}

// Text as it appears on screen, reduced to what a person would consider "the
// same label". OCR routinely returns doubled spaces from letter-spaced UI fonts,
// smart quotes and ellipses from the app's own typography, and a trailing "…"
// on any truncated menu item; none of those are differences a user would name.
export function normalizeVisualText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[…]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// How well an on-screen label answers a request for a target, 0 (no) to 1
// (exactly). Ordered so a genuine exact match always outranks a prefix, and a
// prefix always outranks a scattered token overlap — "Save" prefers "Save" over
// "Save As", and prefers "Save As" over "Autosave settings".
export function scoreVisualMatch(query, candidate) {
  if (!query || !candidate) return 0;
  if (candidate === query) return 1;
  if (candidate.startsWith(query) || candidate.endsWith(query)) return 0.9;
  if (candidate.includes(query)) return 0.8;
  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (!queryTokens.length || !candidateTokens.size) return 0;
  const hits = queryTokens.filter((token) =>
    candidateTokens.has(token) ||
    // One-character tolerance absorbs the OCR confusions that make an otherwise
    // perfect label unreachable: O/0, l/1/I, rn/m.
    [...candidateTokens].some((other) =>
      token.length >= 3 && Math.abs(other.length - token.length) <= 1 && tokenDistance(other, token) <= 1
    )
  ).length;
  const coverage = hits / queryTokens.length;
  // Below half the requested words matched, this is a different label that
  // happens to share a word. Refusing to guess is the correct answer.
  return coverage >= 0.5 ? 0.4 + coverage * 0.3 : 0;
}

export const LifecycleStatus = {
  IMPLEMENTED: "IMPLEMENTED",
  VERIFIED: "VERIFIED",
  EXPERIMENTAL: "EXPERIMENTAL",
  UNAVAILABLE: "UNAVAILABLE"
};

export class CapabilityRegistry {
  constructor(capabilities = [], { runtimeVersion, onEvent, privilegedOperations = [] } = {}) {
    this.capabilities = new Map();
    this.runtimeVersion = runtimeVersion ?? "0.1.0";
    this.listeners = new Set();
    if (onEvent) this.listeners.add(onEvent);
    this.pipeline = new CapabilityLifecyclePipeline({ registry: this, onEvent: (event) => this.emit(event.type, event) });
    // The set of privileged-operation ids that a bounded helper can actually
    // route+execute. An elevated capability MUST bind to one of these (see
    // register()); this is what makes ELEVATE an execution-routing guarantee
    // rather than a self-declared boolean. Empty when no helper is wired.
    this.privilegedOperations = new Set(privilegedOperations);
    // Late-bound rollback manager. The session.rollback capability's execute()
    // invokes it, but the manager needs a reference back to this registry to
    // look up per-capability rollback handlers — a construction cycle. It is
    // injected after construction via setRollbackManager (mirrors how the
    // privileged helper is injected into the privileged capabilities), so no
    // import cycle exists. Null until wired (the AgentRuntime wires it).
    this.rollbackManager = null;
    for (const capability of capabilities) this.register(capability);
  }

  // Inject the RollbackManager the session.rollback capability delegates to.
  // Called by the AgentRuntime so the capability and the runtime share exactly
  // one manager instance (and therefore one rollback journal semantics).
  setRollbackManager(manager) {
    this.rollbackManager = manager;
    return this;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, payload = {}) {
    const event = { type, timestamp: new Date().toISOString(), ...payload };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observability listeners must not affect execution */ }
    }
    return event;
  }

  register(capability, options = {}) {
    const normalized = normalizeCapability(capability, options);
    if (this.capabilities.has(normalized.name)) throw new Error(`Duplicate capability registration: ${normalized.name}`);

    const structuralAliasKey = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/[\s._-]+/g, "");
    const proposedKeys = new Map([[structuralAliasKey(normalized.name), normalized.name]]);
    for (const alias of normalized.aliases) {
      const key = structuralAliasKey(alias);
      if (!key || proposedKeys.has(key)) throw new Error(`Invalid or duplicate alias for ${normalized.name}: ${alias}`);
      proposedKeys.set(key, alias);
    }
    for (const existing of this.capabilities.values()) {
      for (const value of [existing.name, ...(existing.aliases ?? [])]) {
        if (proposedKeys.has(structuralAliasKey(value))) {
          throw new Error(`Capability alias collision: ${proposedKeys.get(structuralAliasKey(value))} conflicts with ${value}`);
        }
      }
    }

    // ELEVATION ROUTING INVARIANT (M2.1 Part E/F), enforced FIRST — before the
    // contract validator — so a capability attempting to self-grant privilege is
    // rejected for THAT reason, not a generic contract gap. A capability that
    // requires elevation must be a TRUSTED, built-in capability bound to a
    // registered bounded privileged operation. This structurally prevents:
    //   - a signed PLUGIN from declaring elevation + an arbitrary execute() and
    //     thereby gaining administrator authority (provenance != privilege), and
    //   - any elevated capability whose privilegedOperation is not a real,
    //     helper-routable operation.
    // Signature/provenance is checked elsewhere; this gate ensures elevation can
    // only ever route through the bounded helper allow-list.
    const requiresElevation = (normalized.requirements?.elevation ?? "NONE") !== "NONE";
    if (requiresElevation) {
      const source = normalized.packaging?.source ?? "builtin";
      if (source !== "builtin") {
        throw new Error(
          `Capability ${normalized.name} requires elevation but is sourced from '${source}'. ` +
          `Plugins cannot self-grant privileged execution; map to a registered bounded operation instead.`
        );
      }
      // The capability MUST declare a privilegedOperation that names a real,
      // bounded operation in the STATIC helper catalog. This is a registration-
      // time correctness check on the binding itself (independent of whether a
      // helper is wired in THIS runtime). Whether the operation can actually run
      // — i.e. a helper is live — is a runtime AVAILABILITY concern enforced at
      // pipeline.prepare time via this.privilegedOperations. Separating the two
      // preserves the "registers as UNAVAILABLE when no helper" contract while
      // still rejecting a bogus/absent binding outright.
      const op = normalized.privilegedOperation;
      if (!op || !PRIVILEGED_OPERATIONS[op]) {
        throw new Error(
          `Elevated capability ${normalized.name} must bind privilegedOperation to a known bounded ` +
          `operation (declared: ${op ?? "none"}; known: ${Object.keys(PRIVILEGED_OPERATIONS).join(", ") || "none"}).`
        );
      }
    }

    const validation = validateCapabilityContract(normalized, { strict: options.strict === true });
    if (!validation.valid) throw new Error(`Invalid capability ${normalized.name ?? "unknown"}: ${validation.errors.join("; ")}`);
    if (!satisfiesVersion(this.runtimeVersion, normalized.packaging.runtimeVersion)) {
      throw new Error(`Capability ${normalized.name} requires runtime ${normalized.packaging.runtimeVersion}`);
    }
    this.capabilities.set(normalized.name, normalized);
    this.emit("CAPABILITY_REGISTERED", { capability: normalized.name, source: normalized.packaging.source, version: normalized.version });
    return normalized;
  }

  get(name) {
    return this.capabilities.get(name);
  }

  has(name) {
    return this.capabilities.has(name);
  }

  list() {
    return [...this.capabilities.values()];
  }

  unregister(name, { source } = {}) {
    const capability = this.get(name);
    if (!capability) return false;
    if (source && capability.packaging.source !== source) throw new Error(`Capability ${name} is not owned by ${source}`);
    this.capabilities.delete(name);
    this.emit("CAPABILITY_REMOVED", { capability: name, source: capability.packaging.source });
    return true;
  }

  setHealth(name, status) {
    const capability = this.get(name);
    if (!capability) throw new Error(`Unknown capability ${name}`);
    capability.health.status = status;
    this.emit(status === CapabilityHealth.DISABLED ? "CAPABILITY_DISABLED" : "CAPABILITY_HEALTH_CHANGED", { capability: name, status });
    return capability;
  }

  getAvailable(context = {}) {
    return this.list().filter((capability) => this.isAvailable(capability.name, context));
  }

  async checkAvailability(name, context = {}) {
    const capability = this.get(name);
    if (!capability) return { name, available: false, reason: "UNKNOWN_CAPABILITY" };
    if ([CapabilityHealth.DISABLED, CapabilityHealth.DEPRECATED, CapabilityHealth.UNSUPPORTED].includes(capability.health.status)) {
      return { name, available: false, reason: capability.health.status };
    }
    let available = false;
    let reason = null;
    try {
      const result = await capability.availability.check(context);
      available = typeof result === "object" ? result.available === true : result !== false;
      reason = typeof result === "object" ? result.reason ?? null : null;
    } catch (error) {
      reason = error.message;
    }
    const lastCheckedAt = new Date().toISOString();
    capability.availability = { ...capability.availability, available, reason, lastCheckedAt };
    capability.health.status = available ? CapabilityHealth.HEALTHY : CapabilityHealth.UNAVAILABLE;
    this.emit("CAPABILITY_AVAILABILITY_CHECKED", { capability: name, available, reason, checkedAt: lastCheckedAt });
    return { name, available, reason, checkedAt: lastCheckedAt };
  }

  async refreshAvailability(context = {}) {
    const results = [];
    await Promise.all(this.list().map(async (capability) => {
      if ([CapabilityHealth.DISABLED, CapabilityHealth.DEPRECATED, CapabilityHealth.UNSUPPORTED].includes(capability.health.status)) {
        results.push({ name: capability.name, available: false, reason: capability.health.status });
        return;
      }
      const result = await this.checkAvailability(capability.name, context);
      results.push(result);
    }));
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  isAvailable(name, context = {}, visited = new Set()) {
    const capability = this.get(name);
    if (!capability || visited.has(name) || !isCapabilityHealthy(capability, context)) return false;
    if (capability.availability?.available === false) return false;
    if (context.platform && !capability.requirements.operatingSystems.includes(context.platform)) return false;
    const stack = new Set(visited).add(name);
    return capability.requirements.capabilities.every((requirement) => {
      const dependency = typeof requirement === "string" ? { capability: requirement } : requirement;
      const found = this.get(dependency.capability);
      return Boolean(found) && satisfiesVersion(found.version, dependency.version ?? "*") && this.isAvailable(found.name, context, stack);
    });
  }

  resolveDependencies(name, context = {}) {
    const ordered = [];
    const visiting = new Set();
    const visit = (capabilityName) => {
      if (visiting.has(capabilityName)) throw new Error(`Capability dependency cycle: ${capabilityName}`);
      const capability = this.get(capabilityName);
      if (!capability || !this.isAvailable(capabilityName, context)) throw new Error(`Unavailable capability dependency: ${capabilityName}`);
      visiting.add(capabilityName);
      for (const requirement of capability.requirements.capabilities) visit(typeof requirement === "string" ? requirement : requirement.capability);
      visiting.delete(capabilityName);
      if (!ordered.includes(capabilityName)) ordered.push(capabilityName);
    };
    visit(name);
    return ordered;
  }

  getCatalog(context = {}) {
    return this.getAvailable(context).map(cap => ({
      name: cap.name,
      aliases: cap.aliases ?? cap.canonicalAliases ?? cap.metadata?.aliases ?? [],
      capabilityId: cap.capabilityId,
      contractVersion: cap.contractVersion,
      version: cap.version,
      category: cap.category,
      description: cap.description,
      execution: cap.execution,
      owner: cap.owner,
      inputSchema: cap.inputSchema,
      outputSchema: cap.outputSchema,
      postconditionSchema: cap.postconditionSchema,
      risk: cap.risk,
      requirements: cap.requirements,
      security: cap.security,
      permissionModel: cap.permissionModel,
      confirmationPolicy: cap.confirmationPolicy,
      idempotency: cap.idempotency,
      dataSensitivity: cap.dataSensitivity,
      networkConstraints: cap.networkConstraints,
      identities: cap.identities,
      trustedExecutionModality: cap.trustedExecutionModality,
      reversibility: cap.reversibility,
      rollbackSupport: cap.rollbackSupport,
      lifecycle: cap.lifecycle,
      lifecycleStatus: cap.lifecycleStatus,
      health: { status: cap.health.status },
      availability: { available: cap.availability.available, reason: cap.availability.reason, lastCheckedAt: cap.availability.lastCheckedAt },
      documentation: cap.documentation,
      deprecation: cap.deprecation,
      packaging: cap.packaging
    }));
  }
}

export { CAPABILITY_CONTRACT_VERSION, CapabilityHealth, ConfirmationPolicy, CapabilityLifecyclePipeline, validateCapabilityContract };

export function createDefaultCapabilityRegistry(adapter, options = {}) {
  const registry = new CapabilityRegistry();
  let wingetAvailabilityPromise = null;
  let wingetAvailabilityResult = null;
  let wingetAvailabilityCheckedAt = 0;
  const checkWingetAvailability = async () => {
    if (wingetAvailabilityResult && Date.now() - wingetAvailabilityCheckedAt < 30000) return wingetAvailabilityResult;
    if (wingetAvailabilityPromise) return wingetAvailabilityPromise;
    wingetAvailabilityPromise = (async () => {
      if (typeof adapter?.executeCommand !== "function") return { available: false, reason: "WinGet adapter is unavailable" };
      const result = await adapter.executeCommand(process.cwd(), "winget", ["--version"], { timeoutMs: 5000 });
      return result.exitCode === 0
        ? { available: true, reason: null }
        : { available: false, reason: result.stderr || "winget executable not found" };
    })();
    try {
      wingetAvailabilityResult = await wingetAvailabilityPromise;
      wingetAvailabilityCheckedAt = Date.now();
      return wingetAvailabilityResult;
    } finally {
      wingetAvailabilityPromise = null;
    }
  };
  const checkBrowserAvailability = async () => {
    try {
      const executable = adapter?.browserAutomation?._findExecutable?.();
      return executable
        ? { available: true, reason: null }
        : { available: false, reason: "Controlled Chromium browser is unavailable" };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  };
  // Optional privileged-operation boundary. When provided (production wiring),
  // the privileged capabilities below become executable through the canonical
  // runtime: each consumes a single-use approval token and dispatches to the
  // bounded, allow-listed helper — never a shell. When absent (lightweight/test
  // wiring), the privileged capabilities are still registered but marked
  // UNAVAILABLE so the planner/validator will not select them.
  const privilegedHelper = options.privilegedHelper ?? null;
  // Register the bounded privileged-operation ids the helper can actually route
  // and execute. This is the authoritative set an elevated capability must bind
  // to (registry.register enforces it). When no helper is wired the set stays
  // empty, so no elevated capability can register as executable — elevation has
  // no bounded route to run through.
  if (privilegedHelper) {
    const ops = privilegedHelper.supportedOperations?.()
      ?? Object.keys(PRIVILEGED_OPERATIONS);
    registry.privilegedOperations = new Set(ops);
  }

  // system.inspect
  registry.register({
    name: "system.inspect",
    version: "1.0.0",
    description: "Inspect Windows system state summary",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // This is a user-initiated, ephemeral interaction with one installed app;
    // it must not inherit the SYSTEM scope used for process inspection.
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => {
      return adapter.getSystemInformation();
    },
    observe: async (result) => ({
      observationId: createId(),
      source: "system.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return { 
        status: "VERIFIED", 
        message: "System summary retrieved",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // processes.list
  registry.register({
    name: "processes.list",
    version: "1.0.0",
    description: "List running processes",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    outputSchema: { type: "array" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => {
      return adapter.listProcesses();
    },
    observe: async (result) => ({
      observationId: createId(),
      source: "processes.list",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return { 
        status: "VERIFIED", 
        message: "Processes listed",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // application.listInstalled — what software is actually on THIS machine.
  //
  // The nearest thing that existed was `package.winget.search`, which queries the
  // winget repository. That answers "does this software exist in the world", not
  // "do I have it", so every "what's installed", "do I have Docker", "is Spotify
  // on here" question either got a repository answer dressed up as a local one or
  // no route at all. Reading the local install state is a different question and
  // needs its own primitive.
  registry.register({
    name: "application.listInstalled",
    version: "1.0.0",
    description:
      "List the applications installed on this computer, with name, version and publisher, " +
      "from the Windows uninstall registry and the Microsoft Store package list",
    aliases: ["application.installed", "applications.list", "software.list"],
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        // A name fragment to look for. Present so "is Docker installed" is one
        // filtered read rather than pulling several hundred entries into the
        // prompt and asking the model to scan them.
        nameContains: { type: "string" }
      },
      required: []
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // Scope deliberately left to default, exactly like `processes.list` and
    // `system.services.list`, which read the same breadth of machine state.
    // Declaring ["SYSTEM"] set blastRadius to SYSTEM_WIDE, which alone scored
    // the whole capability HIGH and sent a read-only inventory to an approval
    // prompt — for a question ("what's installed?") that changes nothing.
    // Blast radius describes what an action can affect, and a read affects
    // nothing.
    permissionModel: { type: "READ" },
    // Declared explicitly because the derivation is name-driven: anything under
    // `application.` is assumed to start an external process, which would mark
    // this PERSISTENT/SCRIPT_EXECUTION and hand it a POLICY_ENGINE confirmation.
    // It would then be excluded from the always-offered read baseline, so the
    // model would never be shown the one capability that answers "what is
    // installed" — the exact reachability failure this capability exists to end.
    // Reading an inventory launches nothing.
    security: {
      filesystem: "NONE", registry: "READ", network: "NONE", browser: "NONE",
      clipboard: "NONE", windowAutomation: "NONE", externalProcesses: "NONE"
    },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async (args = {}) => {
      const listed = await adapter.listInstalledApplications({ limit: args.limit ?? 400 });
      const needle = String(args.nameContains ?? "").trim().toLowerCase();
      if (!needle) return listed;
      const applications = listed.applications.filter((app) =>
        String(app.name ?? "").toLowerCase().includes(needle)
      );
      return {
        applications,
        count: applications.length,
        truncated: false,
        // Reported so a zero count reads as "searched 812 and found none" rather
        // than an empty result that could equally mean the read failed.
        searched: listed.count,
        nameContains: args.nameContains
      };
    },
    observe: async (result) => ({
      observationId: createId(),
      source: "application.listInstalled",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const state = observation?.structuredState ?? {};
      // A filtered read that matches nothing is a correct, verified answer —
      // "Docker is not installed" is exactly what the user asked for. Only a
      // read that surfaced no installed software AT ALL is suspect, since no
      // Windows machine has zero applications.
      const searchedSomething = Number(state.searched ?? state.count ?? 0) > 0;
      return {
        status: searchedSomething ? "VERIFIED" : "UNCERTAIN",
        message: searchedSomething
          ? `${state.count} installed application(s) matched`
          : "Could not read the installed-application list",
        evidence: state,
        confidence: searchedSomething ? 1 : 0
      };
    },
    rollback: null,
    timeout: 65000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // process.port.inspect
  registry.register({
    name: "process.port.inspect",
    version: "1.0.0",
    description: "Find which process is using a specific port",
    inputSchema: {
      type: "object",
      properties: { port: { type: "number" } },
      required: ["port"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    // `Get-NetTCPConnection` exits nonzero when no socket matches. That is a
    // valid read-only answer, not an execution failure, so the adapter's
    // self-describing probe envelope is authoritative here.
    observationContract: { commandResult: "PROBE" },
    preconditions: (args) => Number.isInteger(args.port) && args.port >= 1 && args.port <= 65535,
    execute: async (args) => {
      return adapter.inspectPort(args.port);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "process.port.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation.structuredState ?? {};
      const valid = Number.isInteger(result.port)
        && Array.isArray(result.connections)
        && ["LISTENING", "NOT_LISTENING"].includes(result.status)
        && result.listening === (result.connections.length > 0);
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? (result.listening
              ? `Port ${result.port} is listening with ${result.connections.length} observed connection(s).`
              : `Port ${result.port} is not listening.`)
          : "Port inspection returned an invalid or ambiguous result.",
        evidence: result,
        confidence: valid ? 1 : 0
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 2, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // environment.user.inspect
  registry.register({
    name: "environment.user.inspect",
    version: "1.0.0",
    description: "Inspect user environment variables and PATH",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: []
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async (args) => {
      const pathData = await adapter.getUserPath();
      const envData = args.key ? await adapter.inspectUserEnvironmentVariable(args.key) : null;
      return {
        path: pathData,
        environment: envData
      };
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.user.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return {
        status: "VERIFIED",
        message: "User environment inspected",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 2, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // environment.project.inspect
  registry.register({
    name: "environment.project.inspect",
    version: "1.0.0",
    description: "Inspect project environment file",
    inputSchema: {
      type: "object",
      properties: { workspacePath: { type: "string" } },
      required: ["workspacePath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.workspacePath,
    execute: async (args) => {
      return adapter.inspectProjectEnvironment(args.workspacePath);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.project.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return {
        status: "VERIFIED",
        message: "Project environment inspected",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 5000,
    retryPolicy: { maxAttempts: 2, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // environment.project.set
  registry.register({
    name: "environment.project.set",
    version: "1.0.0",
    description: "Set project environment variable in .env file",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["workspacePath", "key", "value"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => !!args.workspacePath && !!args.key,
    execute: async (args) => {
      return adapter.setProjectEnvironmentVariable(args.workspacePath, args.key, args.value);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.project.set",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["env.file"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const verify = await adapter.verifyProjectEnvironmentVariable(args.workspacePath, args.key, args.value);
      return {
        status: verify.matches ? "VERIFIED" : "FAILED",
        message: verify.matches ? "Environment variable set correctly" : "Failed to set environment variable",
        evidence: verify,
        expectedState: { key: args.key, value: args.value },
        observedState: verify,
        confidence: verify.matches ? 1 : 0
      };
    },
    rollback: async (args, checkpoint) => {
      if (checkpoint.exists) return adapter.writeTextFile(checkpoint.filePath, checkpoint.rawContents);
      return adapter.removeTextFile(checkpoint.filePath);
    },
    createCheckpoint: async (args) => adapter.inspectProjectEnvironment(args.workspacePath),
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // environment.user.path.add
  registry.register({
    name: "environment.user.path.add",
    version: "1.0.0",
    description: "Add entry to user PATH",
    inputSchema: {
      type: "object",
      properties: { entry: { type: "string" } },
      required: ["entry"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => !!args.entry,
    execute: async (args) => {
      return adapter.addUserPathEntry(args.entry);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.user.path.add",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["user.path"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const verify = await adapter.verifyUserPathEntry(args.entry);
      return {
        status: verify.present ? "VERIFIED" : "FAILED",
        message: verify.present ? "PATH entry added" : "Failed to add PATH entry",
        evidence: verify,
        expectedState: { entry: args.entry },
        observedState: verify,
        confidence: verify.present ? 1 : 0
      };
    },
    rollback: async (args, checkpoint) => {
      return adapter.rollbackUserPath(checkpoint.value ?? "");
    },
    createCheckpoint: async () => adapter.getUserPath(),
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // package.winget.search
  registry.register({
    name: "package.winget.search",
    version: "1.0.0",
    description: "Search for packages via WinGet",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    availabilityCheck: checkWingetAvailability,
    preconditions: (args) => !!args.query,
    execute: async (args) => {
      return adapter.wingetSearch(args.query);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "package.winget.search",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return { 
        status: "VERIFIED", 
        message: "WinGet search complete",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 30000,
    retryPolicy: { maxAttempts: 2, backoffMs: 2000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // package.winget.inspect - read-only installed-package status
  registry.register({
    name: "package.winget.inspect",
    version: "1.0.0",
    description: "Check whether a package is installed via WinGet",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    availabilityCheck: checkWingetAvailability,
    preconditions: (args) => !!args.id,
    execute: async (args) => adapter.wingetList(args.id),
    observe: async (result, args) => ({
      observationId: createId(), source: "package.winget.inspect", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId, detectedChanges: [], confidence: 1, trustLevel: "SYSTEM_TRUSTED"
    }),
    // Both installed and not-installed are successful answers to this query.
    verify: async (observation, args) => {
      const result = observation.structuredState ?? {};
      const installed = result.exitCode === 0 && (result.stdout ?? "").toLowerCase().includes(String(args.id).toLowerCase());
      return {
        status: "VERIFIED",
        message: installed ? `${args.id} is installed.` : `${args.id} is not installed.`,
        evidence: result,
        confidence: result.timedOut ? 0.5 : 1
      };
    },
    rollback: null,
    timeout: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // application.notepad.launch
  registry.register({
    name: "application.notepad.launch",
    version: "1.0.0",
    description: "Open Notepad, type text, and save",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" }, filename: { type: "string" } },
      required: ["content", "filename"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "PARTIAL",
    preconditions: (args) => !!args.content && !!args.filename,
    execute: async (args) => {
      return adapter.notepadTypeAndSave({ content: args.content, filename: args.filename });
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "application.notepad.launch",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["user.documents"],
      confidence: 0.8,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const verify = observation.structuredState?.verification;
      return {
        status: verify?.matches ? "VERIFIED" : "FAILED",
        message: verify?.message,
        evidence: verify,
        confidence: verify?.matches ? 0.8 : 0
      };
    },
    rollback: null,
    timeout: 45000,
    retryPolicy: { maxAttempts: 1, backoffMs: 5000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.read
  registry.register({
    name: "filesystem.read",
    version: "1.0.0",
    description: "Read a text file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.filePath,
    execute: async (args) => {
      return adapter.readTextFile(args.filePath);
    },
    observe: async (result) => ({
      observationId: createId(),
      source: "filesystem.read",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      return { 
        status: "VERIFIED", 
        message: "File read complete",
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.write
  registry.register({
    name: "filesystem.write",
    version: "1.0.0",
    description: "Write text to a file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" }, content: { type: "string" } },
      required: ["filePath", "content"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => !!args.filePath && !!args.content,
    execute: async (args) => {
      return adapter.writeTextFile(args.filePath, args.content);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "filesystem.write",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["file"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const verify = await adapter.verifyFileContains(args.filePath, args.content);
      return {
        status: verify.matches ? "VERIFIED" : "FAILED",
        message: verify.matches ? "File written correctly" : "Failed to write file",
        evidence: verify,
        expectedState: { content: args.content },
        observedState: verify,
        confidence: verify.matches ? 1 : 0
      };
    },
    rollback: async (args, checkpoint) => {
      if (checkpoint?.exists) return adapter.writeTextFile(args.filePath, checkpoint.contents);
      return adapter.removeTextFile(args.filePath);
    },
    createCheckpoint: async (args) => {
      try {
        const file = await adapter.readTextFile(args.filePath);
        return { exists: true, contents: file.contents };
      } catch (error) {
        if (error?.code === "ENOENT") return { exists: false, contents: null };
        throw error;
      }
    },
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.createDirectory (real) - create a directory (recursive). Verified
  // by an independent stat. Rollback removes a directory THIS op created.
  registry.register({
    name: "filesystem.createDirectory",
    version: "1.0.0",
    description: "Create a directory (including parents)",
    inputSchema: {
      type: "object",
      properties: { directoryPath: { type: "string" } },
      required: ["directoryPath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => typeof args?.directoryPath === "string" && args.directoryPath.trim() !== "",
    execute: async (args) => adapter.createDirectory(args.directoryPath),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "filesystem.createDirectory",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["directory"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const target = observation?.structuredState?.directoryPath ?? args.directoryPath;
      const verify = await adapter.verifyDirectoryExists(target);
      return {
        status: verify.exists ? "VERIFIED" : "FAILED",
        message: verify.exists ? "Directory exists" : "Directory was not created",
        evidence: verify,
        confidence: verify.exists ? 1 : 0
      };
    },
    // Only remove the directory if it did not exist before we created it.
    rollback: async (args, checkpoint) => {
      if (checkpoint?.existedBefore) return { skipped: true, reason: "Directory pre-existed; not removed." };
      return adapter.removeDirectory(checkpoint?.directoryPath ?? args.directoryPath);
    },
    createCheckpoint: async (args) => {
      const existing = await adapter.verifyDirectoryExists(args.directoryPath);
      return { existedBefore: existing.exists, directoryPath: args.directoryPath };
    },
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.search (real, read-only) - find files under a root by glob.
  registry.register({
    name: "filesystem.search",
    version: "1.0.0",
    description: "Search for files under a directory by name pattern",
    inputSchema: {
      type: "object",
      properties: {
        rootDirectory: { type: "string" },
        pattern: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["pattern"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.pattern === "string" && args.pattern.trim() !== "",
    execute: async (args) => adapter.searchFiles(args.rootDirectory, args.pattern, args.maxResults ?? 50),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "filesystem.search",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: Array.isArray(result.files) ? "VERIFIED" : "FAILED",
        message: Array.isArray(result.files) ? `Found ${result.files.length} file(s)` : "Search failed",
        evidence: { count: result.files?.length ?? 0 },
        confidence: Array.isArray(result.files) ? 1 : 0
      };
    },
    timeout: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.list (real, read-only) - what is IN a directory.
  //
  // `filesystem.search` answers "where is the file called X". This answers "what
  // is here", which is a different and far more common question, and nothing
  // could answer it: "show me the folder structure of this project" and "what's
  // in my Downloads folder" had no route and were refused.
  registry.register({
    name: "filesystem.list",
    version: "1.0.0",
    description:
      "List the contents of a directory, optionally descending several levels to show a folder tree. " +
      "Use this to see what is in a folder; use filesystem.search to find a file by name.",
    aliases: ["filesystem.tree", "filesystem.listDirectory", "directory.list"],
    inputSchema: {
      type: "object",
      properties: {
        directoryPath: { type: "string" },
        depth: { type: "number", description: "How many levels to descend, 1-6. Default 1." },
        maxEntries: { type: "number" },
        includeHidden: { type: "boolean" }
      },
      required: ["directoryPath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["WORKSPACE"], type: "READ" },
    security: {
      filesystem: "READ", registry: "NONE", network: "NONE", browser: "NONE",
      clipboard: "NONE", windowAutomation: "NONE", externalProcesses: "NONE"
    },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.directoryPath === "string" && args.directoryPath.trim() !== "",
    execute: async (args) => adapter.listDirectory(args.directoryPath, {
      depth: args.depth ?? 1,
      maxEntries: args.maxEntries ?? 500,
      includeHidden: args.includeHidden === true
    }),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "filesystem.list",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      // An empty directory is a real, correct answer. A directory that does not
      // exist is not — saying "it's empty" about a path that isn't there is the
      // kind of confidently wrong answer that is worse than no answer.
      if (result.exists === false) {
        return { status: "FAILED", message: `No such directory: ${result.root}`, evidence: result, confidence: 1 };
      }
      return {
        status: "VERIFIED",
        message: `Listed ${result.count ?? 0} entr${result.count === 1 ? "y" : "ies"} under ${result.root}` +
          (result.truncated ? " (truncated)" : ""),
        evidence: { root: result.root, count: result.count, truncated: result.truncated },
        confidence: 1
      };
    },
    timeout: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // filesystem.delete (real, MUTATING) - delete a file. MEDIUM risk so policy
  // routes it through CONFIRM. Rollback restores the captured contents.
  registry.register({
    name: "filesystem.delete",
    version: "1.0.0",
    description: "Delete a file",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => typeof args?.filePath === "string" && args.filePath.trim() !== "",
    execute: async (args) => adapter.removeTextFile(args.filePath),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "filesystem.delete",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["file"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const target = args.filePath;
      let stillExists = true;
      try {
        await adapter.readTextFile(target);
      } catch (error) {
        if (error?.code === "ENOENT") stillExists = false;
      }
      return {
        status: stillExists ? "FAILED" : "VERIFIED",
        message: stillExists ? "File still exists" : "File deleted",
        confidence: stillExists ? 0 : 1
      };
    },
    rollback: async (args, checkpoint) => {
      if (checkpoint?.exists) return adapter.writeTextFile(args.filePath, checkpoint.contents);
      return { skipped: true, reason: "File did not exist before delete." };
    },
    createCheckpoint: async (args) => {
      try {
        const file = await adapter.readTextFile(args.filePath);
        return { exists: true, contents: file.contents };
      } catch (error) {
        if (error?.code === "ENOENT") return { exists: false, contents: null };
        throw error;
      }
    },
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // application.launch (real) - launch an application/executable and confirm a
  // window/process appeared.
  registry.register({
    name: "application.launch",
    version: "1.0.0",
    description: "Launch an application and confirm it started",
    inputSchema: {
      type: "object",
      properties: { application: { type: "string" } },
      required: ["application"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.application === "string" && args.application.trim() !== "",
    execute: async (args) => adapter.launchApplication(args.application),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "application.launch",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["process"],
      confidence: result?.window ? 1 : 0.5,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      const started = Boolean(result.windowIdentity ?? result.window);
      // "Not installed" and "installed but could not be grounded" are separate
      // states. Reporting them as one would let the prerequisite workflow either
      // reinstall a present application or give up on a transient grounding miss.
      const notInstalled = result.failureCategory === "APPLICATION_NOT_INSTALLED";
      return {
        status: started ? "VERIFIED" : "FAILED",
        message: started
          ? `Launched and grounded ${result.application}`
          : notInstalled
            ? `${result.application} does not resolve to an installed application on this system.`
            : `Could not ground a window for ${result.application}`,
        category: started ? null : (notInstalled ? "MISSING_PREREQUISITE" : "TARGET_NOT_FOUND"),
        failureCategory: started ? null : (result.failureCategory ?? "WINDOW_GROUNDING_FAILED"),
        evidence: {
          window: result.window ?? null,
          windowIdentity: result.windowIdentity ?? null,
          grounding: result.grounding ?? null,
          resolution: result.resolution ?? null
        },
        confidence: started ? (result.windowIdentity?.confidence ?? 0.9) : 0
      };
    },
    timeout: 24000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  registry.register({
    name: "system.volume.adjust",
    version: "1.0.0",
    description: "Adjust Windows master volume by a bounded number of media-key steps",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] }, steps: { type: "number" } },
      required: ["direction"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => ["up", "down"].includes(args?.direction),
    execute: async (args) => adapter.adjustSystemVolume(args.direction, args.steps),
    observe: async (result, args) => ({
      observationId: createId(), source: "system.volume.adjust", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId, detectedChanges: [],
      confidence: result?.dispatched ? 0.8 : 0, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.dispatched ? "VERIFIED" : "FAILED",
        message: result.dispatched
          ? `Sent ${result.steps} volume-${result.direction} command(s).`
          : "Windows did not confirm dispatch of the volume command.",
        evidence: result, confidence: result.dispatched ? 0.8 : 0
      };
    },
    rollback: null,
    timeout: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // system.volume.inspect — what IS the volume right now.
  //
  // There was no way to ask. `system.volume.adjust` can nudge up and down and
  // reports only that it dispatched a keystroke, so "what's the volume of the
  // system?" had no capability behind it at all.
  registry.register({
    name: "system.volume.inspect",
    version: "1.0.0",
    description: "Read the current Windows master volume percentage and mute state",
    aliases: ["system.volume.get", "system.volume.read", "volume.inspect"],
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => adapter.readSystemVolume(),
    observe: async (result, args) => ({
      observationId: createId(), source: "system.volume.inspect", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId, detectedChanges: [],
      confidence: result?.available ? 1 : 0, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.available ? "VERIFIED" : "FAILED",
        message: result.available
          ? `Master volume is ${result.percent}%${result.muted ? " (muted)" : ""}.`
          : "Could not read the audio endpoint volume.",
        evidence: result, confidence: result.available ? 1 : 0
      };
    },
    rollback: null,
    timeout: 25000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // system.volume.set — put the volume AT a level.
  //
  // "Reduce it to 26%" names a destination, not a direction. Expressed as
  // media-key steps it is unrepresentable, which is why the planner produced a
  // call with no inputs at all and the session failed on a precondition check
  // rather than doing the obvious thing.
  registry.register({
    name: "system.volume.set",
    version: "1.0.0",
    description: "Set the Windows master volume to a specific percentage (0-100), and optionally mute or unmute",
    aliases: ["system.volume.setLevel", "volume.set"],
    inputSchema: {
      type: "object",
      properties: {
        percent: { type: "number", description: "Target volume, 0 to 100" },
        mute: { type: "boolean" }
      },
      required: ["percent"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "WRITE" },
    reversibility: "FULLY_REVERSIBLE",
    preconditions: (args) => Number.isFinite(Number(args?.percent)),
    execute: async (args) => adapter.setSystemVolume(args.percent, {
      mute: typeof args.mute === "boolean" ? args.mute : null
    }),
    observe: async (result, args) => ({
      observationId: createId(), source: "system.volume.set", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId, detectedChanges: ["system.volume"],
      confidence: result?.applied ? 1 : 0, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      // The evidence is the endpoint's own read-back after the write, not the
      // fact that a command was sent. Asking for 26% and being told "done"
      // because a keystroke was dispatched is precisely the false success this
      // whole verification layer exists to prevent.
      const result = observation?.structuredState ?? {};
      return {
        status: result.applied ? "VERIFIED" : "FAILED",
        message: result.applied
          ? `Master volume is now ${result.percent}%${result.muted ? " (muted)" : ""}.`
          : `Asked for ${result.requestedPercent}% but the endpoint reports ${result.percent ?? "an unreadable level"}.`,
        evidence: result, confidence: result.applied ? 1 : 0
      };
    },
    rollback: null,
    timeout: 25000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // application.close (real, MUTATING) - stop a process by name. MEDIUM risk.
  registry.register({
    name: "application.close",
    version: "1.0.0",
    description: "Close a running application/process by name",
    inputSchema: {
      type: "object",
      properties: { processName: { type: "string" } },
      required: ["processName"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.processName === "string" && args.processName.trim() !== "",
    execute: async (args) => adapter.closeApplication(args.processName),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "application.close",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["process"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const name = (args.processName ?? "").toLowerCase().replace(".exe", "");
      const processes = await adapter.listProcesses();
      const list = Array.isArray(processes?.processes) ? processes.processes : (Array.isArray(processes) ? processes : []);
      const stillRunning = list.some((p) => String(p?.ProcessName ?? p?.name ?? "").toLowerCase() === name);
      return {
        status: stillRunning ? "FAILED" : "VERIFIED",
        message: stillRunning ? `${name} is still running` : `${name} was closed`,
        confidence: stillRunning ? 0 : 1
      };
    },
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // Names a model actually reaches for, mapped to the name the registry uses.
  //
  // A capability the model cannot NAME is a capability the agent does not have.
  // Live, the loop asked for `ui.getValue` to read back what it had just typed,
  // was told it was an unknown capability, and burned the rest of its budget
  // retrying — with the text sitting correctly in the window the whole time.
  // The registry's own resolver already honours aliases; the ui/keyboard/window
  // family simply never declared any.
  //
  // These are exact synonyms only. An alias that resolves ambiguously would be
  // worse than none, because it would silently run something the model did not
  // ask for. Alias keys are normalised (case and separators are ignored), so
  // `ui.typeText` already covers `ui.type_text` — listing both is a duplicate.
  const M4_ALIASES = {
    "ui.extract": ["ui.getValue", "ui.readValue", "ui.getText", "ui.readText"],
    "ui.inspect": ["ui.describe", "ui.tree", "ui.elements"],
    "ui.find": ["ui.locate", "ui.findElement", "ui.search"],
    "ui.type": ["ui.typeText", "ui.enterText", "ui.input"],
    "ui.setValue": ["ui.setText", "ui.fill"],
    "ui.click": ["ui.tap"],
    "keyboard.type": ["keyboard.typeText", "keyboard.write", "keyboard.input"],
    "keyboard.press": ["keyboard.key", "keyboard.hotkey", "keyboard.sendKeys", "keyboard.shortcut"],
    "window.enumerate": ["window.list", "windows.list"],
    "window.activate": ["window.focus", "window.bringToFront", "window.raise"],
    "clipboard.read": ["clipboard.get"],
    "clipboard.write": ["clipboard.set"],
    "screen.capture": ["screen.screenshot", "screenshot.take", "screen.grab"],
    "command.run": ["cli.exec", "cli.execute", "shell.run", "shell.exec", "powershell.run", "terminal.run"]
  };

  const registerM4Primitive = ({
    name, description, inputSchema, execute, modality = ExecutionModality.OS_API, modalities = null,
    risk = RiskLevel.LOW, permissionType = "READ", verify = null,
    resources = [], detectedChanges = []
  }) => registry.register({
    name,
    version: "1.0.0",
    description,
    aliases: M4_ALIASES[name] ?? [],
    inputSchema,
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: risk },
    permissionModel: { scope: ["SESSION"], type: permissionType },
    execution: {
      modalities: (modalities ?? [modality]).map((value) => modalityProfile(value)),
      preferredModality: modality,
      resources
    },
    security: {
      filesystem: name === "screen.capture" ? "WRITE" : "NONE",
      registry: "NONE", network: "NONE", browser: "NONE",
      clipboard: name.startsWith("clipboard.") ? (permissionType === "WRITE" ? "WRITE" : "READ") : "NONE",
      windowAutomation: ["ui.", "window.", "pointer.", "keyboard.", "screen."].some((prefix) => name.startsWith(prefix))
        ? (permissionType === "WRITE" ? "CONTROLLED" : "READ")
        : "NONE",
      externalProcesses: "NONE"
    },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute,
    observe: async (result, args) => ({
      observationId: createId(), source: name, timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId,
      // `detectedChanges` may be a function when what changed depends on the
      // call rather than on the capability. Running a command is the case that
      // needs it: `git --version` changes nothing and `npm install` changes the
      // workspace, and reporting "Changed: workspace" for the first one is the
      // kind of untrue detail that makes every other line less believable.
      detectedChanges: result?.performed === false
        ? []
        : (typeof detectedChanges === "function" ? detectedChanges(result, args) : detectedChanges),
      confidence: result?.performed === false || result?.found === false ? 0.4 : 0.95,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: verify ?? (async (observation) => {
      const result = observation?.structuredState ?? {};
      const failed = result.performed === false || result.found === false || result.captured === false;
      return {
        status: failed ? "FAILED" : "VERIFIED",
        message: failed ? (result.reason ?? `${name} did not complete`) : `${name} completed`,
        evidence: result,
        confidence: failed ? 1 : 0.9
      };
    }),
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["REFRESH_STATE", "ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // One fused look at a window: pixels (OCR) + accessibility tree (UIA),
  // normalized through the same VisionProvider shape the perception layer
  // persists, so what a capability returns and what the world model stores are
  // the same object.
  const readScreen = async (args = {}) => {
    const snapshot = await captureScreenSnapshotViaAdapter(adapter, {
      windowId: args.windowId,
      application: args.application,
      maxElements: args.maxElements ?? 240,
      includeVision: true,
      // The accessibility tree alone, when the caller says that is enough. The
      // capture and the OCR over it are the slow half of every look and, for an
      // application with a real UIA tree, they return the same words a second
      // time and misread.
      ...(args.includeOcr === false ? { includeOcr: false } : {}),
      force: true
    });
    if (!snapshot) {
      return { read: false, reason: "The screen could not be captured (no window resolved, or capture unavailable).", elements: [] };
    }
    const elements = (snapshot.elements ?? [])
      .filter((element) => element.bbox ?? element.boundingRect)
      .slice(0, Math.max(1, Number(args.maxElements ?? 240)))
      .map((element) => {
        const bounds = element.bbox ?? element.boundingRect;
        return {
          targetId: element.targetId ?? element.id,
          source: element.source,
          role: element.role,
          text: String(element.text ?? element.name ?? "").slice(0, 200),
          bounds,
          // The point a click would land on. Stated explicitly so the agent
          // never has to compute geometry — or invent it.
          center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
          clickable: element.clickable === true,
          enabled: element.enabled !== false,
          focused: element.focused === true,
          value: element.value ?? null,
          automationId: element.automationId ?? null
        };
      });
    return {
      read: true,
      snapshotId: snapshot.snapshotId,
      windowId: snapshot.windowId,
      application: snapshot.application,
      title: snapshot.title,
      capturedAt: snapshot.capturedAt,
      capturePath: snapshot.capturePath,
      visibleText: args.includeText === false ? null : String(snapshot.ocrText ?? "").slice(0, 8000),
      elements
    };
  };

  // Ground a raw coordinate in a window that exists RIGHT NOW. This is what
  // replaces "the model must quote an observation back to us" as the defence
  // against invented coordinates: an invented point does not lie inside any live
  // window, and the call fails before anything is clicked.
  const resolveWindowContaining = async ({ x, y, windowId = null, application = null }) => {
    const windows = await adapter.listWindows();
    const identify = (window) => ({
      windowId: String(window.WindowHandle ?? window.windowId),
      processName: window.ProcessName ?? window.processName ?? null,
      title: window.MainWindowTitle ?? window.title ?? null,
      bounds: window.Bounds ?? window.bounds ?? null
    });
    const contains = (bounds) => bounds
      && x >= bounds.x && x <= bounds.x + bounds.width
      && y >= bounds.y && y <= bounds.y + bounds.height;

    if (windowId || application) {
      // A SPECIFIC IDENTIFIER MUST BEAT A VAGUE ONE.
      //
      // This was one `find` over an OR of windowId, process name and title, so it
      // returned whichever window came first in z-order and matched ANY clause —
      // and a process name matches every window that application has open. With
      // an Avast "Restore pages?" dialog sitting in front of the Google Flights
      // window, every click on the flights page was validated against the dialog,
      // 720x372 in the corner, and refused as "outside the window". The exact
      // windowId naming the right window was in the same call, and lost to the
      // process name because the process name was tested on an earlier window.
      //
      // So: the handle decides when there is one. Only when there is not does the
      // application name get consulted, and then the window actually under the
      // point wins over the first one that happens to share the name.
      const identified = windows.map(identify);
      const appMatches = application
        ? identified.filter((window) =>
            String(window.processName ?? "").toLowerCase() === String(application).toLowerCase() ||
            String(window.title ?? "").toLowerCase().includes(String(application).toLowerCase()))
        : [];
      const named = (windowId && identified.find((window) => window.windowId === String(windowId)))
        || appMatches.find((window) => contains(window.bounds))
        || appMatches[0];
      if (!named) throw new Error(`No live window matches ${windowId ?? application}`);
      if (!contains(named.bounds)) {
        throw new Error(
          `(${x}, ${y}) is outside ${named.title ?? named.processName} ` +
          `(${named.bounds?.x}, ${named.bounds?.y}) ${named.bounds?.width}x${named.bounds?.height}. ` +
          "Read the screen again and use a coordinate inside the window."
        );
      }
      return named;
    }
    // Topmost live window containing the point. listWindows returns z-order.
    const hit = windows.map(identify).find((window) => contains(window.bounds));
    if (!hit) throw new Error(`(${x}, ${y}) is not inside any visible window. Read the screen again for current coordinates.`);
    return hit;
  };

  // Did the text actually land? Ask UI Automation first (exact, instant, and how
  // every ordinary edit control exposes its value), then fall back to OCR for
  // surfaces UIA cannot describe. Returns `readable:false` only when neither
  // could see anything at all, which is the honest "cannot tell" case.
  const readBackTypedText = async ({ windowId, application, expected }) => {
    const needle = normalizeVisualText(expected);
    const contains = (value) => {
      const haystack = normalizeVisualText(value);
      return Boolean(haystack) && haystack.includes(needle);
    };
    // When the window is known, name ONLY the window. Passing the application
    // alongside it re-opens the ambiguity the handle already resolved: three
    // Notepad windows all match "Notepad", and the read-back landed on a
    // different one than the keystrokes did, reporting a correct typing action
    // as failed against another document's contents.
    const where = windowId ? { windowId } : { application };
    try {
      const ui = await adapter.inspectUi({ ...where, maxElements: 200 });
      const elements = ui?.elements ?? ui?.targets ?? [];
      const hit = elements.find((element) => contains(element.value) || contains(element.name));
      if (hit) {
        return { confirmed: true, readable: true, where: "the accessible control", sample: String(hit.value ?? hit.name ?? "").slice(0, 200) };
      }
      // Not found. Report what the TEXT SURFACE holds — the focused editable
      // control, or failing that the largest body of text in the window. Taking
      // the first element with any value at all reported a URL or a tab label as
      // "what the window currently shows", which is a misleading diagnosis of a
      // real failure.
      const textSurfaces = elements
        .filter((element) => typeof element.value === "string" && element.value.trim())
        .sort((left, right) =>
          (right.focused === true) - (left.focused === true) ||
          String(right.value).length - String(left.value).length
        );
      if (textSurfaces.length) {
        return { confirmed: false, readable: true, where: "the accessible control", sample: String(textSurfaces[0].value).slice(0, 200) };
      }
    } catch { /* UIA unavailable for this surface; try pixels below */ }

    try {
      const screen = await readScreen({ ...where, maxElements: 200 });
      if (screen.read && String(screen.visibleText ?? "").trim()) {
        return contains(screen.visibleText)
          ? { confirmed: true, readable: true, where: "the visible screen text", sample: String(screen.visibleText).slice(0, 200) }
          : { confirmed: false, readable: true, where: "the visible screen text", sample: String(screen.visibleText).slice(0, 200) };
      }
    } catch { /* nothing readable by either route */ }
    return { confirmed: false, readable: false, reason: "neither UI Automation nor OCR could read this control" };
  };

  const SCROLL_SETTLE_MS = { slow: 220, normal: 90, fast: 25 };
  const scrollWindow = async (args = {}) => {
    // A caller may say notches (preferred) or a raw wheel delta (legacy). One
    // notch is WHEEL_DELTA (120), which is what every Windows app treats as
    // "one click of the wheel".
    const requested = Number.isFinite(Number(args.notches))
      ? Number(args.notches)
      : Number(args.delta ?? 0) / 120;
    const notches = Math.max(-120, Math.min(120, Math.trunc(requested) || 0));
    if (notches === 0) return { performed: false, reason: "Nothing to scroll: notches was zero." };

    const window = args.windowId || args.application
      ? await (async () => {
          const windows = await adapter.listWindows();
          const found = windows.find((candidate) =>
            (args.windowId && String(candidate.WindowHandle ?? candidate.windowId) === String(args.windowId)) ||
            (args.application && String(candidate.ProcessName ?? candidate.processName ?? "").toLowerCase() === String(args.application).toLowerCase())
          );
          if (!found) throw new Error(`No live window matches ${args.windowId ?? args.application}`);
          return {
            windowId: String(found.WindowHandle ?? found.windowId),
            processName: found.ProcessName ?? found.processName ?? null,
            title: found.MainWindowTitle ?? found.title ?? null,
            bounds: found.Bounds ?? found.bounds ?? null
          };
        })()
      : null;

    // Put the pointer over the content before turning the wheel. Windows sends
    // wheel input to the window under the CURSOR, not to the focused window, so
    // without this the scroll silently went wherever the mouse was last left.
    const bounds = window?.bounds ?? null;
    const at = {
      x: Math.round(args.x ?? (bounds ? bounds.x + bounds.width / 2 : Number.NaN)),
      y: Math.round(args.y ?? (bounds ? bounds.y + bounds.height / 2 : Number.NaN))
    };
    if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
      await adapter.pointerAction("move", { x: at.x, y: at.y, windowId: window?.windowId });
    }

    const settleMs = SCROLL_SETTLE_MS[String(args.speed ?? "normal")] ?? SCROLL_SETTLE_MS.normal;
    const observe = args.observe === true || Boolean(String(args.untilText ?? "").trim());
    // Reading the screen after every notch gives the closest useful equivalent
    // to continuous perception available to an action/observation agent.  For
    // very long bursts, bound a single result to 30 frames unless the caller
    // explicitly asks for a larger interval; the agent may immediately carry
    // on with another burst using the last fresh frame.
    const observeEvery = Math.max(
      1,
      Math.trunc(Number(args.observeEvery)) || Math.ceil(Math.abs(notches) / 30) || 1
    );
    const untilText = normalizeVisualText(args.untilText);
    const frames = [];
    const observeFrame = async (afterNotch) => {
      const reading = await readScreen({
        ...(window?.windowId ? { windowId: window.windowId } : { application: args.application }),
        maxElements: 120
      });
      const frame = {
        afterNotch,
        timestamp: reading.timestamp ?? new Date().toISOString(),
        visibleText: String(reading.visibleText ?? "").slice(0, 4000),
        elements: (reading.elements ?? []).slice(0, 120),
        title: reading.title ?? window?.title ?? null
      };
      frames.push(frame);
      return untilText && normalizeVisualText(frame.visibleText).includes(untilText);
    };

    let matchedUntilText = false;
    if (observe) matchedUntilText = await observeFrame(0);
    const direction = Math.sign(notches);
    let delivered = 0;
    for (let step = 0; step < Math.abs(notches) && !matchedUntilText; step += 1) {
      await adapter.pointerAction("wheel", {
        delta: direction * 120,
        // Foreground is acquired on the first notch only. Re-acquiring it before
        // every notch turns a smooth scroll into a slideshow, and the window
        // cannot lose focus mid-scroll without the wheel events stopping anyway.
        ...(window && step === 0 ? { windowId: window.windowId } : {})
      });
      delivered += 1;
      if (settleMs > 0 && step < Math.abs(notches) - 1) {
        await new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      if (observe && (delivered % observeEvery === 0 || delivered === Math.abs(notches))) {
        matchedUntilText = await observeFrame(delivered);
      }
    }
    return {
      performed: true,
      notches,
      delivered,
      direction: direction > 0 ? "up" : "down",
      speed: args.speed ?? "normal",
      observing: observe,
      observeEvery: observe ? observeEvery : null,
      frames,
      stoppedOnText: matchedUntilText,
      untilText: args.untilText ?? null,
      at: Number.isFinite(at.x) ? at : null,
      window
    };
  };

  // Matching what a person means by "the Save button" against what OCR actually
  // produced. The host matched with an escaped whole-word regex, which is exact
  // string equality wearing a costume: "Sign in" never matched the OCR line
  // "Sign  in" (double space from letter spacing), "OK" never matched "0K"
  // (a classic OCR confusion), and asking for "Save" could not find "Save As…".
  // A visual target the agent can see and cannot name is a target it does not
  // have, so matching is scored rather than binary.
  const locateVisualTargetFuzzily = async (args = {}) => {
    const exact = await adapter.locateVisualTarget(args);
    if (exact?.found) return exact;

    const query = normalizeVisualText(args.query);
    if (!query) return exact ?? { found: false, reason: "visual-target-not-found", target: null, matches: [] };
    const candidates = exact?.matches?.length ? exact.matches : (exact?.targets ?? []);
    const pool = candidates.length ? candidates : (await readScreen({
      windowId: args.windowId,
      application: args.application,
      maxElements: 300,
      includeText: false
    })).elements ?? [];

    const scored = pool
      .map((candidate) => ({ candidate, score: scoreVisualMatch(query, normalizeVisualText(candidate.name ?? candidate.text)) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    if (!scored.length) {
      return {
        found: false,
        reason: exact?.reason ?? "visual-target-not-found",
        target: null,
        matches: [],
        ocrText: exact?.ocrText ?? null,
        // Say what WAS visible. "Not found" with no alternatives gives the agent
        // nothing to reconsider; a list of what is actually on screen does.
        visibleCandidates: pool.slice(0, 40).map((candidate) => String(candidate.name ?? candidate.text ?? "")).filter(Boolean)
      };
    }
    const best = scored[0].candidate;
    return {
      found: true,
      matchQuality: scored[0].score,
      matchedText: String(best.name ?? best.text ?? ""),
      target: best,
      matches: scored.slice(0, 8).map((entry) => entry.candidate),
      ocrText: exact?.ocrText ?? null,
      capturePath: exact?.capturePath ?? null
    };
  };

  const refreshVisualTarget = async (target) => {
    const validation = validateInteractionTarget(target);
    if (!validation.valid) throw new Error(`Unsafe visual target: ${validation.errors.join(", ")}`);
    const age = Date.now() - Date.parse(target.observedAt);
    const maxAge = Math.max(1, Number(target.maxObservationAgeMs ?? 5000));
    if (!Number.isFinite(age) || age < 0 || age > maxAge) throw new Error("STALE_OBSERVATION: coordinate evidence expired");
    const windows = await adapter.listWindows();
    const window = windows.find((candidate) =>
      String(candidate.WindowHandle ?? candidate.windowId) === String(target.windowId)
    );
    if (!window) throw new Error("STALE_OBSERVATION: source window no longer exists");
    const foreground = windows.find((candidate) => candidate.Foreground ?? candidate.foreground);
    const foregroundId = foreground ? String(foreground.WindowHandle ?? foreground.windowId) : null;
    if (foregroundId !== String(target.expectedForegroundWindowId) || foregroundId !== String(target.windowId)) {
      throw new Error("FOREGROUND_MISMATCH: observed target window is no longer foreground");
    }
    const expected = target.windowIdentity;
    const actual = {
      windowId: String(window.WindowHandle ?? window.windowId),
      processId: Number(window.Id ?? window.processId),
      processName: String(window.ProcessName ?? window.processName ?? ""),
      title: String(window.MainWindowTitle ?? window.title ?? ""),
      className: String(window.ClassName ?? window.className ?? ""),
      bounds: window.Bounds ?? window.bounds ?? null,
      displayId: window.DisplayId ?? window.displayId ?? null,
      dpi: Number(window.Dpi ?? window.dpi)
    };
    const sameBounds = ["x", "y", "width", "height"].every((key) =>
      Number(actual.bounds?.[key]) === Number(expected.bounds?.[key])
    );
    const sameIdentity = actual.windowId === String(expected.windowId ?? target.windowId)
      && (!expected.processId || actual.processId === Number(expected.processId))
      && (!expected.processName || actual.processName.toLowerCase() === String(expected.processName).toLowerCase())
      && (!expected.title || actual.title === String(expected.title))
      && (!expected.className || actual.className === String(expected.className))
      && actual.displayId === expected.displayId
      && actual.dpi === Number(expected.dpi)
      && sameBounds;
    if (!sameIdentity) throw new Error("STALE_OBSERVATION: window identity, bounds, display, or DPI changed");
    const bounds = window.Bounds ?? window.bounds;
    if (!bounds) throw new Error("STALE_OBSERVATION: current window bounds unavailable");
    return target;
  };

  registerM4Primitive({
    name: "window.enumerate",
    description: "Enumerate visible top-level Windows with stable ids and bounds",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ windows: await adapter.listWindows() }),
    resources: ["desktop"]
  });
  registerM4Primitive({
    name: "window.resolve",
    description: "Resolve a top-level window from stable and fallback identity signals",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string" }, processId: { type: "number" }, processName: { type: "string" },
        executable: { type: "string" }, className: { type: "string" }, title: { type: "string" },
        titleContains: { type: "string" }, application: { type: "string" }
      },
      required: []
    },
    execute: async (args) => adapter.manageWindow("resolve", args),
    resources: ["desktop"]
  });
  registerM4Primitive({
    name: "window.wait",
    description: "Wait boundedly for a matching application window to appear",
    inputSchema: { type: "object", properties: { windowId: { type: "string" }, application: { type: "string" }, timeoutMs: { type: "number" } }, required: [] },
    execute: async (args) => adapter.manageWindow("wait", { ...args, timeoutMs: args.timeoutMs ?? 8000 }),
    modality: ExecutionModality.UI_AUTOMATION, resources: ["desktop"]
  });
  registerM4Primitive({
    name: "window.activate",
    description: "Restore and activate a visible Windows application window",
    inputSchema: { type: "object", properties: { windowId: { type: "string" }, application: { type: "string" } }, required: [] },
    execute: async (args) => adapter.manageWindow("activate", args),
    modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["window.foreground"]
  });
  registerM4Primitive({
    name: "window.moveResize",
    description: "Move and resize one identified window",
    inputSchema: { type: "object", properties: { windowId: { type: "string" }, application: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] },
    execute: async (args) => adapter.manageWindow("moveResize", args),
    permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["window.bounds"]
  });
  // Maximising is not the same as resizing to the screen bounds: it is a
  // distinct window state that applications lay out for, and it is one of the
  // ordinary decisions a person makes before working in a window ("this is too
  // small to see the whole list"). The host has implemented minimize/maximize/
  // restore all along; without a registered capability the agent could not ask
  // for it, and would fake it with moveResize or simply fail to see content
  // that was scrolled out of a small window.
  // One capability per verb rather than a single window.state({state}) with a
  // nested enum. Models name these actions directly — asked to maximize a
  // window, the planner reached for "window.maximize" and was rejected as an
  // unknown capability, because the only spelling available required knowing to
  // call a different verb and pass the real one as an argument. Naming the
  // catalog the way the task is spoken removes a whole class of vocabulary drift,
  // and three entries cost nothing.
  for (const [verb, summary] of [
    ["maximize", "Maximize one identified window to fill the screen"],
    ["minimize", "Minimize one identified window to the taskbar"],
    ["restore", "Restore one identified window to its pre-maximized size"]
  ]) {
    registerM4Primitive({
      name: `window.${verb}`,
      description: summary,
      inputSchema: {
        type: "object",
        properties: { windowId: { type: "string" }, application: { type: "string" } },
        required: []
      },
      execute: async (args) => adapter.manageWindow("state", { ...args, state: verb }),
      modality: ExecutionModality.UI_AUTOMATION,
      permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["window.state"]
    });
  }
  // Hovering is how a person opens a submenu, reveals a tooltip, or triggers a
  // hover state before deciding whether to click. Without it the agent can only
  // click, which commits to an action where a human would have looked first.
  registerM4Primitive({
    name: "pointer.move",
    description: "Move the pointer onto a fresh runtime-observed target without clicking",
    inputSchema: {
      type: "object",
      properties: { target: { type: "object" }, windowId: { type: "string" }, application: { type: "string" } },
      required: ["target"]
    },
    execute: async (args) => adapter.pointerAction("move", args),
    modality: ExecutionModality.POINTER,
    permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["pointer.position"]
  });
  registerM4Primitive({
    name: "ui.inspect",
    description: "Inspect one grounded application window and return compact accessible controls",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        windowId: { type: "string" },
        maxElements: { type: "number" }
      },
      required: []
    },
    execute: async (args) => adapter.inspectUi(args),
    modality: ExecutionModality.UI_AUTOMATION,
    resources: ["desktop"]
  });
  registerM4Primitive({
    name: "ui.find",
    description: "Find a live accessible control and return a unified interaction target",
    inputSchema: { type: "object", properties: { application: { type: "string" }, windowId: { type: "string" }, selector: { type: "object" } }, required: ["selector"] },
    execute: async (args) => adapter.findUiTarget(args),
    modality: ExecutionModality.UI_AUTOMATION, resources: ["desktop"]
  });
  registerM4Primitive({
    name: "ui.extract",
    description: "Extract one typed value from a grounded accessible GUI using goal-relevant semantics; fail on unresolved ambiguity",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        windowId: { type: "string" },
        query: { type: "string" },
        selector: { type: "object" },
        maxElements: { type: "number" }
      },
      required: ["query"]
    },
    execute: async (args) => {
      const inspected = await adapter.inspectUi({
        application: args.application,
        windowId: args.windowId,
        maxElements: args.maxElements ?? 240
      });
      const controls = inspected?.targets ?? inspected?.elements ?? [];
      const query = String(args.query ?? "").toLowerCase();
      const ignored = new Set([
        "read", "obtain", "get", "extract", "exact", "current", "currently",
        "visible", "shown", "displayed", "main", "section", "control", "from",
        "application", "window", "the", "and", "its", "one"
      ]);
      const tokens = query.match(/[a-z0-9]{2,}/g)?.filter((token) => !ignored.has(token)) ?? [];
      const wantsLabel = /\b(label|caption|heading|title|text)\b/.test(query);
      const wantsToggle = /\b(toggle|checked|enabled|disabled|on|off|state)\b/.test(query);
      const wantsSelection = /\b(selected|selection|chosen|choice)\b/.test(query);
      const selector = args.selector ?? {};
      const candidates = controls.map((control) => {
        const name = String(control?.name ?? "").trim();
        const explicitValue = control?.value;
        const selectedValue = control?.selected ?? control?.selection;
        const value = explicitValue != null && String(explicitValue).trim() !== ""
          ? explicitValue
          : control?.toggleState != null ? control.toggleState
            : selectedValue != null && String(selectedValue).trim() !== "" ? selectedValue
              : name;
        if (value == null || String(value).trim() === "") return null;
        const semantics = `${name} ${control?.automationId ?? ""} ${control?.controlType ?? ""} ${control?.className ?? ""}`.toLowerCase();
        const matchedTokens = tokens.filter((token) => semantics.includes(token));
        let score = matchedTokens.length * 20;
        if (selector.name && name.toLowerCase() === String(selector.name).toLowerCase()) score += 100;
        if (selector.nameContains && name.toLowerCase().includes(String(selector.nameContains).toLowerCase())) score += 60;
        if (selector.automationId && String(control?.automationId) === String(selector.automationId)) score += 100;
        if (selector.targetId && String(control?.targetId) === String(selector.targetId)) score += 150;
        if (selector.controlType && semantics.includes(String(selector.controlType).toLowerCase())) score += 30;
        const staticText = /(?:static|text|label)/i.test(`${control?.className ?? ""} ${control?.controlType ?? ""}`);
        const interactive = /(?:button|edit|combo|check|radio|listitem|menuitem|tabitem)/i.test(`${control?.className ?? ""} ${control?.controlType ?? ""}`);
        if (wantsLabel && staticText) score += 14;
        if (wantsLabel && !interactive && name.length <= 100) score += 5;
        if (wantsLabel && /[:：]\s*$/.test(name)) score += 4;
        if (wantsLabel && name.length > 160) score -= 12;
        if (wantsToggle && control?.toggleState != null) score += 25;
        if (wantsSelection && selectedValue != null) score += 25;
        if (explicitValue != null && String(explicitValue).trim() !== "") score += 8;
        if (control?.enabled !== false) score += 2;
        if (control?.focused === true) score += 8;
        if (control?.automationId) score += 2;
        if (control?.offscreen === true) score -= 30;
        return {
          control,
          value,
          valueType: typeof value,
          valueSource: explicitValue != null ? "ValuePattern"
            : control?.toggleState != null ? "TogglePattern"
              : selectedValue != null ? "Selection" : "AccessibleName",
          matchedTokens,
          score
        };
      }).filter(Boolean).sort((left, right) => right.score - left.score);
      const top = candidates[0];
      const tied = top && candidates[1] && candidates[1].score === top.score;
      const semanticallyGrounded = top && (
        top.matchedTokens.length > 0
        || (wantsLabel && /(?:static|text|label)/i.test(`${top.control?.className ?? ""} ${top.control?.controlType ?? ""}`))
        || (wantsToggle && top.control?.toggleState != null)
        || (wantsSelection && top.valueSource === "Selection")
        || Object.keys(selector).length > 0
      );
      if (!top || tied || !semanticallyGrounded) {
        return {
          found: false,
          reason: tied ? "ambiguous-value" : "no-semantically-grounded-value",
          query: args.query,
          candidates: candidates.slice(0, 6).map((candidate) => ({
            candidateId: candidate.control?.targetId ?? null,
            value: candidate.value,
            valueSource: candidate.valueSource,
            score: candidate.score,
            control: candidate.control
          }))
        };
      }
      return {
        found: true,
        value: top.value,
        valueType: top.valueType,
        valueSource: top.valueSource,
        query: args.query,
        control: top.control,
        target: top.control,
        window: inspected?.windows?.[0] ?? null,
        matchedTokens: top.matchedTokens,
        candidatesConsidered: candidates.length
      };
    },
    modality: ExecutionModality.UI_AUTOMATION,
    resources: ["desktop"],
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      const valid = result.found === true && result.value != null && String(result.value) !== "";
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? `Extracted a typed GUI value through ${result.valueSource}.`
          : result.reason ?? "GUI value extraction failed",
        evidence: result,
        confidence: valid ? 0.95 : 1
      };
    }
  });
  registerM4Primitive({
    name: "ui.navigateSection",
    description: "Navigate boundedly among generic tab/section views and stop only when accessible UI evidence uniquely matches the requested section",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        windowId: { type: "string" },
        query: { type: "string" },
        maxTransitions: { type: "number" }
      },
      required: ["query"]
    },
    execute: async (args) => {
      const ignored = new Set(["open", "select", "section", "tab", "view", "the", "and"]);
      const tokens = String(args.query).toLowerCase().match(/[a-z0-9]{3,}/g)
        ?.filter((token) => !ignored.has(token)) ?? [];
      if (!tokens.length) return { performed: false, reason: "section-query-has-no-semantic-tokens" };
      const attempts = [];
      const limit = Math.max(1, Math.min(12, Number(args.maxTransitions) || 8));
      for (let index = 0; index <= limit; index += 1) {
        const inspected = await adapter.inspectUi({
          application: args.application,
          windowId: args.windowId,
          maxElements: 240
        });
        const controls = inspected?.targets ?? inspected?.elements ?? [];
        const accessibleTab = controls.find((control) =>
          /TabControl/i.test(String(control?.className ?? ""))
          && Array.isArray(control?.accessibleChildren)
        );
        const accessibleMatches = (accessibleTab?.accessibleChildren ?? []).map((name) => {
          const semantics = String(name).toLowerCase();
          return {
            name,
            score: tokens.reduce((total, token) => total + (semantics.includes(token) ? 1 : 0), 0)
          };
        }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score);
        if (accessibleMatches[0]
          && (!accessibleMatches[1] || accessibleMatches[0].score > accessibleMatches[1].score
            || accessibleMatches[0].score === tokens.length)) {
          const selected = await adapter.performUiAction({
            application: args.application,
            windowId: args.windowId,
            target: accessibleTab,
            action: "selectAccessibleChild",
            text: accessibleMatches[0].name
          });
          if (!selected?.performed) {
            return {
              performed: false,
              reason: selected?.reason ?? "accessible-section-selection-failed",
              accessibleTab,
              attempts
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          const after = await adapter.inspectUi({
            application: args.application,
            windowId: args.windowId,
            maxElements: 240
          });
          const afterControls = after?.targets ?? after?.elements ?? [];
          const postMatches = afterControls.filter((control) => {
            const semantics = `${control?.name ?? ""} ${control?.automationId ?? ""}`.toLowerCase();
            return tokens.some((token) => semantics.includes(token));
          });
          if (!postMatches.length) {
            return {
              performed: false,
              reason: "section-selection-postcondition-not-observed",
              query: args.query,
              accessibleSelection: accessibleMatches[0].name,
              controls: afterControls,
              attempts
            };
          }
          return {
            performed: true,
            query: args.query,
            matched: { name: accessibleMatches[0].name, source: "MSAA", windowId: args.windowId },
            matchedTokens: tokens.filter((token) => accessibleMatches[0].name.toLowerCase().includes(token)),
            controls: afterControls,
            transitions: index,
            method: "MSAA-accSelect",
            attempts
          };
        }
        const matches = controls.map((control) => {
          const semantics = `${control?.name ?? ""} ${control?.automationId ?? ""}`.toLowerCase();
          return {
            control,
            score: tokens.reduce((total, token) => total + (semantics.includes(token) ? 1 : 0), 0)
          };
        }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score);
        attempts.push({
          transition: index,
          topMatch: matches[0]?.control?.name ?? null,
          score: matches[0]?.score ?? 0
        });
        if (matches[0] && (!matches[1] || matches[0].score > matches[1].score || matches[0].score === tokens.length)) {
          return {
            performed: true,
            query: args.query,
            matched: matches[0].control,
            matchedTokens: tokens.filter((token) =>
              `${matches[0].control?.name ?? ""} ${matches[0].control?.automationId ?? ""}`.toLowerCase().includes(token)
            ),
            controls,
            transitions: index,
            attempts
          };
        }
        if (index < limit) {
          const nativeContainer = controls.find((control) =>
            /TabControl/i.test(String(control?.className ?? ""))
          );
          const pressed = nativeContainer
            ? await adapter.performUiAction({
                application: args.application,
                windowId: args.windowId,
                target: nativeContainer,
                action: "nextSection"
              })
            : await adapter.keyboardAction("press", {
                application: args.application,
                windowId: args.windowId,
                keys: "^{TAB}"
              });
          if (!pressed?.performed) {
            return {
              performed: false,
              reason: pressed?.reason ?? "section-navigation-failed",
              nativeContainer: nativeContainer ?? null,
              navigationResult: pressed,
              attempts
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      return { performed: false, reason: "section-not-found-within-bounded-navigation", attempts };
    },
    modality: ExecutionModality.UI_AUTOMATION,
    permissionType: "WRITE",
    resources: ["desktop"],
    detectedChanges: ["application.navigation"],
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.performed && result.matched ? "VERIFIED" : "FAILED",
        message: result.performed
          ? `Section ${result.query} was selected and matched accessible evidence ${result.matched?.name ?? ""}.`
          : result.reason ?? "Section navigation failed",
        evidence: result,
        confidence: result.performed ? 0.95 : 1
      };
    }
  });
  registerM4Primitive({
    name: "ui.verifyValue",
    description: "Re-read one grounded accessible control and verify its exact current value",
    inputSchema: {
      type: "object",
      properties: {
        application: { type: "string" },
        windowId: { type: "string" },
        selector: { type: "object" },
        expected: { type: "string" }
      },
      required: ["selector", "expected"]
    },
    execute: async (args) => {
      const found = await adapter.findUiTarget(args);
      const actual = found?.target?.value ?? found?.target?.name ?? null;
      const normalizeControlValue = (value) => String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n$/, "");
      return {
        ...found,
        expected: args.expected,
        actual,
        normalizedActual: normalizeControlValue(actual),
        normalizedExpected: normalizeControlValue(args.expected),
        matches: found?.found === true && normalizeControlValue(actual) === normalizeControlValue(args.expected)
      };
    },
    modality: ExecutionModality.UI_AUTOMATION,
    resources: ["desktop"],
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.matches ? "VERIFIED" : "FAILED",
        message: result.matches ? "The control value exactly matches the expected value." : "The control value does not match the expected value.",
        evidence: { expected: result.expected, actual: result.actual, target: result.target ?? null },
        confidence: 1
      };
    }
  });
  registerM4Primitive({
    name: "ui.resolveTarget",
    description: "Resolve a UI target progressively through UI Automation then screenshot/OCR",
    inputSchema: { type: "object", properties: { application: { type: "string" }, windowId: { type: "string" }, selector: { type: "object" }, visualQuery: { type: "string" } }, required: ["selector"] },
    execute: async (args) => {
      const structured = await adapter.findUiTarget(args);
      if (structured?.found) {
        return { ...structured, modality: ExecutionModality.UI_AUTOMATION, fallbacks: [] };
      }
      const query = args.visualQuery ?? args.selector?.name ?? args.selector?.nameContains;
      if (!query) return { found: false, reason: structured?.reason ?? "target-not-found", structured, fallbacks: [] };
      const visual = await adapter.locateVisualTarget({
        application: args.application, windowId: args.windowId, query
      });
      return {
        ...visual,
        modality: ExecutionModality.VISION_GUI,
        fallbacks: [{
          from: ExecutionModality.UI_AUTOMATION,
          to: ExecutionModality.VISION_GUI,
          reason: structured?.reason ?? "accessible-target-unavailable"
        }],
        structuredAttempt: structured
      };
    },
    modality: ExecutionModality.UI_AUTOMATION,
    modalities: [ExecutionModality.UI_AUTOMATION, ExecutionModality.VISION_GUI],
    resources: ["desktop"]
  });
  registerM4Primitive({
    name: "ui.action",
    description: "Perform a bounded action against a runtime-observed unified UI target",
    inputSchema: { type: "object", properties: { application: { type: "string" }, windowId: { type: "string" }, target: { type: "object" }, action: { type: "string", enum: ["invoke", "click", "focus", "setValue", "type", "select", "expand", "collapse", "toggle", "scrollIntoView", "nextSection", "selectAccessibleChild"] }, text: { type: "string" }, expectedAfter: { type: "object" } }, required: ["target", "action"] },
    execute: async (args) => {
      // A UIA target whose accessibility implementation exposes no usable
      // pattern is still a real control occupying real pixels. Clicking it the
      // way a person does is the correct fallback, not a failure — without this,
      // any application with thin UIA support was untouchable even though every
      // button on screen was perfectly clickable.
      //
      // Only for an explicit "click", and only using the rectangle the runtime
      // actually observed, so this never becomes a guessed coordinate.
      if (args.target?.source === "UIA" && args.action === "click") {
        const rect = args.target.boundingRect ?? args.target.bounds;
        if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) {
          const click = await adapter.pointerAction("click", {
            windowId: args.target.windowId ?? args.windowId,
            x: Math.round(Number(rect.x) + Number(rect.width) / 2),
            y: Math.round(Number(rect.y) + Number(rect.height) / 2),
            button: "left"
          });
          return { ...click, method: "uia-pointer-fallback", target: args.target };
        }
      }
      if (args.target?.source === "UIA") return adapter.performUiAction(args);
      const target = await refreshVisualTarget(args.target);
      if (!["click", "type"].includes(args.action)) throw new Error(`Visual fallback does not support ${args.action}`);
      const rect = target.boundingRect;
      const click = await adapter.pointerAction("click", {
        windowId: target.windowId,
        x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), button: "left"
      });
      if (args.action === "type" && args.text) {
        const typed = await adapter.keyboardAction("type", { text: args.text, windowId: target.windowId });
        return { performed: click.performed && typed.performed, method: "vision-pointer+keyboard", target, click, typed };
      }
      return { ...click, method: "vision-pointer", target };
    },
    modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"],
    verify: async (observation, args) => {
      const result = observation?.structuredState ?? {};
      if (!result.performed) return { status: "FAILED", message: result.reason ?? "UI action failed", evidence: result, confidence: 1 };
      if (args.expectedAfter) {
        const next = await adapter.findUiTarget({
          application: args.application,
          windowId: args.windowId ?? args.target?.windowId,
          selector: args.expectedAfter
        });
        return {
          status: next.found ? "VERIFIED" : "FAILED",
          message: next.found ? "Expected post-action UI state appeared." : "Action ran but expected UI state was not observed.",
          evidence: { action: result, postcondition: next }, confidence: 0.95
        };
      }
      return { status: "PARTIALLY_VERIFIED", message: "UI action completed; no explicit postcondition was supplied.", evidence: result, confidence: 0.7 };
    }
  });
  // The verbs a request is actually phrased in. `ui.action({action})` is the one
  // general primitive, but models do not reach for it: asked to type into a
  // field the planner emitted `ui.type`, and before that `ui.type_text`, and was
  // rejected as an unknown capability every time. That is the single most
  // frequently observed failure in this system.
  //
  // These are not new abilities — each delegates straight to ui.action with the
  // verb filled in, so the grounding, postcondition and verification rules are
  // exactly the same. They only remove the requirement that the model guess a
  // spelling. Naming the catalog the way tasks are spoken is cheaper than
  // teaching every model the internal spelling.
  for (const [verb, summary] of [
    ["click", "Click a runtime-observed UI control"],
    ["type", "Type text into a runtime-observed UI control"],
    ["setValue", "Set the exact value of a runtime-observed UI control"],
    ["select", "Select a runtime-observed UI option or item"],
    ["toggle", "Toggle a runtime-observed checkbox or switch"]
  ]) {
    registerM4Primitive({
      name: `ui.${verb}`,
      description: summary,
      inputSchema: {
        type: "object",
        properties: {
          application: { type: "string" }, windowId: { type: "string" },
          target: { type: "object" }, text: { type: "string" }, expectedAfter: { type: "object" }
        },
        required: ["target"]
      },
      execute: async (args) => registry.get("ui.action").execute({ ...args, action: verb }),
      modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE",
      resources: ["desktop"], detectedChanges: ["application.ui"],
      verify: async (observation, args) => registry.get("ui.action").verify(observation, { ...args, action: verb })
    });
  }
  // "Run a command" under the name it is reached for. `developer.command.run`
  // exists and does exactly this, but it reads as developer tooling, so the
  // planner kept emitting `cli.exec` / `cli.execute` and being rejected. Same
  // executor — only the name is different, and the name is what the model has
  // to guess.
  //
  // WHY THIS IS DECLARED READ.
  //
  // It was WRITE, which made its floor a PERSISTENT mutation, which made every
  // single command a confirmation prompt — `git --version` and `format C:` were
  // treated identically. A control that fires on everything is not a control:
  // it trains the user to click Approve without reading, which is strictly
  // worse than not asking.
  //
  // The risk of running a command is not a property of this capability. It is a
  // property of the COMMAND LINE, and nothing but the command line can tell you
  // what it is. So the floor is what the capability itself does — spawn a
  // process and return its output — and the actual decision is made per call by
  // classifyShellCommand: a read runs, a mutation goes through approval, a
  // destructive command is refused in WindowsAdapter.executeCommand where no
  // approval can reach past it. RiskEngine.assess applies that classification
  // as raise-only evidence, so this floor can only ever be raised by it.
  registerM4Primitive({
    name: "command.run",
    permissionType: "READ",
    description:
      "Run a Windows shell command (PowerShell) and return its stdout, stderr and exit code. " +
      "Put the whole command line in `command`, exactly as you would type it in a terminal " +
      "(for example \"git --version\" or \"Get-PSDrive C | Select-Object Used,Free\"), and leave " +
      "`args` empty. This is usually the fastest and most reliable way to read or change system " +
      "state — prefer it over driving a GUI. Commands that only read run immediately; commands " +
      "that change something ask the user first; a few destructive commands (disk formatting, " +
      "wiping backups, disabling security, piping a download into a shell) are refused outright.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The full command line to run, e.g. \"Get-Process | Sort-Object WS -Descending\""
        },
        // Kept for the typed callers that already separate executable from
        // arguments. When supplied, `command` must be a bare executable name and
        // nothing is shell-parsed.
        args: { type: "array" },
        workspacePath: { type: "string" }
      },
      required: ["command"]
    },
    execute: async (args) => adapter.executeCommand(
      args.workspacePath ?? process.cwd(),
      args.command,
      args.args ?? [],
      { timeoutMs: 90000 }
    ),
    resources: ["workspace"],
    // Only a command that could change something reports a change.
    detectedChanges: (result, args) =>
      classifyShellCommand(args?.command, args?.args ?? []).verdict === ShellVerdict.ALLOW
        ? []
        : ["workspace"],
    verify: async (observation) => {
      const state = observation?.structuredState ?? {};
      const ok = state.exitCode === 0 && !state.timedOut;
      return {
        status: ok ? "VERIFIED" : "FAILED",
        // A nonzero exit code is the command reporting its own failure. Saying
        // so plainly stops a failed command reading as a completed step.
        // A command the rules refused never ran at all, and saying "exited with
        // code -1" about it would hide the only fact that matters.
        message: state.blocked === true
          ? state.stderr
          : (ok
            ? "Command completed successfully"
            : `Command exited with code ${state.exitCode ?? "unknown"}${state.timedOut ? " (timed out)" : ""}`),
        evidence: state,
        confidence: 1
      };
    }
  });
  registerM4Primitive({
    name: "screen.capture",
    description: "Capture a bounded screen, window, or region to a local PNG",
    inputSchema: { type: "object", properties: { windowId: { type: "string" }, application: { type: "string" }, region: { type: "object" }, path: { type: "string" } }, required: [] },
    execute: async (args) => adapter.captureScreen(args),
    modality: ExecutionModality.VISION_GUI, resources: ["desktop"]
  });
  registerM4Primitive({
    name: "ocr.read",
    description: "Read text and grounded line targets from a local screenshot using Windows OCR",
    inputSchema: { type: "object", properties: { path: { type: "string" }, windowId: { type: "string" }, originX: { type: "number" }, originY: { type: "number" } }, required: ["path"] },
    execute: async (args) => adapter.readOcr(args),
    modality: ExecutionModality.VISION_GUI, resources: ["desktop"]
  });
  registerM4Primitive({
    name: "vision.locate",
    description: "Capture a window and locate visible text as a confidence-scored unified target",
    inputSchema: { type: "object", properties: { application: { type: "string" }, windowId: { type: "string" }, query: { type: "string" }, path: { type: "string" } }, required: ["query"] },
    execute: async (args) => locateVisualTargetFuzzily(args),
    modality: ExecutionModality.VISION_GUI, resources: ["desktop"]
  });
  // LOOKING AT THE SCREEN.
  //
  // screen.capture writes a PNG the agent cannot read, ocr.read needs a path it
  // has to have captured first, and ui.inspect sees only what UI Automation
  // chooses to expose. Each is a fragment; none of them is the verb "look".
  // Nothing in the catalog answered "what is on the screen right now?", so the
  // loop acted, could not check, and reported delivered keystrokes as success.
  //
  // This is that verb. One call captures the window, OCRs it, inspects it, and
  // returns every visible element with its text and the exact screen
  // coordinates of its centre — the UIA tree and the OCR transcript fused into
  // one list, so text that only exists as pixels (custom-drawn canvases, web
  // views, games, remote desktops, screenshots inside a viewer) is reachable by
  // the same means as an accessible button.
  //
  // It is READ-only and LOW risk: looking changes nothing.
  registerM4Primitive({
    name: "screen.read",
    description:
      "Look at the screen and read it. Captures a window (or the whole desktop when no window is named), " +
      "runs OCR, and inspects its accessible controls, returning the visible text plus every element with " +
      "its role, text, and exact screen coordinates (bounds and clickable centre). Use this to find out what " +
      "is actually on screen, to locate something to click, and to CHECK WHAT AN ACTION ACTUALLY DID — " +
      "delivering a keystroke or a click is not evidence that the screen changed.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string" },
        application: { type: "string" },
        maxElements: { type: "number" },
        // Full text can be long; the caller may ask for only the elements.
        includeText: { type: "boolean" },
        // Skip the capture and the OCR over it entirely — the accessibility tree
        // alone. Roughly halves the time a look costs.
        includeOcr: { type: "boolean" }
      },
      required: []
    },
    execute: async (args = {}) => readScreen(args),
    modality: ExecutionModality.VISION_GUI,
    resources: ["desktop"],
    verify: async (observation) => {
      const state = observation?.structuredState ?? {};
      return state.read === true
        ? {
            status: "VERIFIED",
            message: `Read ${state.elements?.length ?? 0} visible elements from ${state.title ?? state.application ?? "the screen"}.`,
            evidence: { visibleText: String(state.visibleText ?? "").slice(0, 500) },
            confidence: 0.9
          }
        : { status: "FAILED", message: state.reason ?? "The screen could not be read.", confidence: 1 };
    }
  });
  registerM4Primitive({
    name: "pointer.click",
    description: "Click the center of a fresh, high-confidence visual target",
    inputSchema: { type: "object", properties: { target: { type: "object" }, button: { type: "string" } }, required: ["target"] },
    execute: async (args) => {
      const target = await refreshVisualTarget(args.target);
      const rect = target.boundingRect;
      return adapter.pointerAction("click", {
        windowId: target.windowId,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        button: args.button ?? "left"
      });
    },
    modality: ExecutionModality.VISION_GUI, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"]
  });
  // CLICKING A PLACE, not only a named control.
  //
  // pointer.click requires a target object minted by a prior perception, which
  // is the right default — it is what stops a model inventing coordinates. But
  // it made whole surfaces unreachable: a canvas in Paint, a point on a map, a
  // cell in a remote-desktop session, a spot in a game, anything drawn rather
  // than declared. A person can click there; the agent could not click there at
  // all.
  //
  // The safety property is preserved without the restriction, by requiring the
  // coordinate to be justified by a FRESH observation rather than by an
  // observation-shaped object: the point must fall inside the bounds of a window
  // that exists right now, and the click is delivered to that window after
  // bringing it to the foreground. A hallucinated coordinate lands nowhere,
  // because no current window contains it.
  registerM4Primitive({
    name: "pointer.clickAt",
    description:
      "Click an exact screen coordinate inside a named window. Use this when the thing to click is not an " +
      "accessible control — a drawing canvas, a map, a video, a game, a remote session — or when screen.read " +
      "gave you an element's centre. The coordinate must lie inside the target window's current bounds.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" }, y: { type: "number" },
        windowId: { type: "string" }, application: { type: "string" },
        button: { type: "string", enum: ["left", "right"] },
        doubleClick: { type: "boolean" }
      },
      required: ["x", "y"]
    },
    // A DOUBLE CLICK IS ONE ACTION, NOT TWO CLICKS.
    //
    // It used to be two separate host requests, and Windows only counts two
    // clicks as a double click when they arrive inside the user's double-click
    // interval — 500ms by default, and configurable down to about 200. Two round
    // trips through the host, each of which may also re-acquire the foreground,
    // is not reliably inside that, and when it is not, the application receives
    // two single clicks: the file gets selected twice instead of opening, and
    // nothing reports a problem. The host now delivers both clicks in one call,
    // spaced by the interval Windows itself reports.
    execute: async (args) => {
      const window = await resolveWindowContaining(args);
      const result = await adapter.pointerAction("click", {
        windowId: window.windowId,
        x: Math.round(args.x),
        y: Math.round(args.y),
        button: args.button ?? "left",
        clicks: args.doubleClick === true ? 2 : 1
      });
      return { ...result, window, x: Math.round(args.x), y: Math.round(args.y) };
    },
    modality: ExecutionModality.VISION_GUI, permissionType: "WRITE",
    resources: ["desktop"], detectedChanges: ["application.ui"]
  });
  // SCROLLING LIKE A PERSON.
  //
  // Three separate things were wrong with one-shot `delta`. The wheel event was
  // posted at wherever the cursor happened to be resting — often another
  // monitor, or the window the agent had just moved away from — so the scroll
  // frequently went somewhere else entirely while reporting performed:true. The
  // delta was clamped to a single +/-1200 burst, roughly ten notches, which is
  // not "scroll to the bottom of a long settings page". And there was no way to
  // scroll gently: a burst jumps, which matters when the agent has to watch
  // content go past to find something.
  //
  // So: park the cursor over the target window first, then deliver `notches` as
  // a sequence of real wheel steps with a settle delay between them. `speed`
  // chooses the pause, because reading while scrolling is exactly the case that
  // needs a slow one.
  registerM4Primitive({
    name: "pointer.wheel",
    description:
      "Scroll inside a window with the mouse wheel. Give `notches` (positive scrolls up, negative scrolls " +
      "down) and optionally `speed` (\"slow\" to let content settle so you can read it while it moves, " +
      "\"fast\" to cover a long page). The cursor is moved over the window first, so the scroll lands there " +
      "and not wherever the pointer was left. Set `observe:true` to capture fresh screen text and element " +
      "coordinates throughout the scroll, or give `untilText` to stop as soon as that visible text appears.",
    inputSchema: {
      type: "object",
      properties: {
        notches: { type: "number" },
        // Retained so existing typed callers and plans keep working.
        delta: { type: "number" },
        speed: { type: "string", enum: ["slow", "normal", "fast"] },
        observe: { type: "boolean" },
        observeEvery: { type: "number" },
        untilText: { type: "string" },
        windowId: { type: "string" }, application: { type: "string" },
        x: { type: "number" }, y: { type: "number" }
      },
      required: []
    },
    execute: async (args = {}) => scrollWindow(args),
    modality: ExecutionModality.VISION_GUI, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.viewport"]
  });
  registerM4Primitive({
    name: "pointer.drag",
    description: "Drag between two fresh runtime-observed targets in one window",
    inputSchema: { type: "object", properties: { fromTarget: { type: "object" }, toTarget: { type: "object" }, windowId: { type: "string" }, application: { type: "string" } }, required: ["fromTarget", "toTarget"] },
    execute: async (args) => {
      const from = await refreshVisualTarget(args.fromTarget);
      const to = await refreshVisualTarget(args.toTarget);
      if (String(from.windowId) !== String(to.windowId)) throw new Error("Drag targets must belong to the same window");
      return adapter.pointerAction("drag", {
        windowId: from.windowId,
        fromX: Math.round(from.boundingRect.x + from.boundingRect.width / 2),
        fromY: Math.round(from.boundingRect.y + from.boundingRect.height / 2),
        toX: Math.round(to.boundingRect.x + to.boundingRect.width / 2),
        toY: Math.round(to.boundingRect.y + to.boundingRect.height / 2)
      });
    },
    modality: ExecutionModality.VISION_GUI, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"]
  });
  // DRAWING, AS OPPOSED TO DRAGGING.
  //
  // pointer.drag can only express a straight line, so every curve had to be
  // spelled as a series of drags — and the button comes up between drags. A
  // circle asked for that way arrives as disconnected chords, each a separate
  // entry in the application's undo stack. This carries the whole figure as one
  // path: the button goes down once, visits every point, and comes up at the
  // end. `paths` draws several such strokes in one call, which is what a figure
  // that lifts the pen needs.
  //
  // The coordinates are checked against a window that exists right now, exactly
  // as pointer.clickAt checks a click, so a path invented out of nothing lands
  // nowhere rather than somewhere.
  registerM4Primitive({
    name: "pointer.stroke",
    description:
      "Draw or drag along a continuous path with the button held down. Give `paths` as arrays of " +
      "interleaved x,y screen coordinates. Use this for anything drawn rather than clicked — a shape on a " +
      "canvas, a signature, a lasso selection, a gesture.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "array", items: { type: "number" } } },
        windowId: { type: "string" }, application: { type: "string" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        pacingMicros: { type: "number" }
      },
      required: ["paths"]
    },
    execute: async (args) => {
      const paths = (args.paths ?? []).map((path) => path.map((value) => Math.round(Number(value))));
      if (paths.length === 0 || paths.some((path) => path.length < 4 || path.some((value) => !Number.isFinite(value)))) {
        throw new Error("Every path needs at least two points, given as finite interleaved x,y coordinates.");
      }
      const window = await resolveWindowContaining({
        x: paths[0][0], y: paths[0][1], windowId: args.windowId ?? null, application: args.application ?? null
      });
      const result = await adapter.pointerStroke({
        paths,
        windowId: window.windowId,
        button: args.button ?? "left",
        ...(Number.isFinite(Number(args.pacingMicros)) ? { pacingMicros: Number(args.pacingMicros) } : {})
      });
      return { ...result, window };
    },
    modality: ExecutionModality.VISION_GUI, permissionType: "WRITE",
    resources: ["desktop"], detectedChanges: ["application.ui"]
  });
  registerM4Primitive({
    name: "keyboard.type",
    description: "Type bounded text into the current focused control",
    inputSchema: { type: "object", properties: { text: { type: "string" }, windowId: { type: "string" }, application: { type: "string" } }, required: ["text"] },
    execute: async (args) => adapter.keyboardAction("type", args),
    modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"],
    // DELIVERING A KEYSTROKE IS NOT EVIDENCE THAT TEXT ARRIVED.
    //
    // The default verifier returned VERIFIED for performed:true, so every typing
    // action succeeded by definition. That is not a theoretical gap: SendKeys
    // silently drops characters on long bursts and mangles punctuation, the
    // clipboard-paste path fails outright if another process holds the
    // clipboard, and a mistargeted window swallows the text entirely — all of
    // them reporting performed:true. The one live check that matters is whether
    // the text is now visible in the window, and that check was available the
    // whole time.
    verify: async (observation, args) => {
      const state = observation?.structuredState ?? {};
      if (state.performed === false) {
        return { status: "FAILED", message: state.reason ?? "keyboard.type did not complete", evidence: state, confidence: 1 };
      }
      const expected = String(args?.text ?? "");
      if (!expected.trim()) {
        return { status: "VERIFIED", message: "keyboard.type completed", evidence: state, confidence: 0.9 };
      }
      const landed = await readBackTypedText({
        windowId: args?.windowId ?? state.windowId,
        application: args?.application,
        expected
      });
      if (landed.confirmed) {
        return {
          status: "VERIFIED",
          message: `Typed text is present in ${landed.where}.`,
          evidence: { method: state.method, matchedIn: landed.where, sample: landed.sample },
          confidence: 0.95
        };
      }
      if (landed.readable) {
        return {
          status: "FAILED",
          message:
            `The text was sent but is not in the window. Expected "${expected.slice(0, 60)}"; ` +
            `the window currently shows "${String(landed.sample ?? "").slice(0, 120)}". ` +
            "Focus the correct control and type again.",
          evidence: { method: state.method, sample: landed.sample },
          confidence: 0.9
        };
      }
      // Password boxes and custom-drawn editors legitimately expose nothing to
      // read back. Say so, rather than claiming a verification that did not
      // happen or failing an action that probably worked.
      return {
        status: "PARTIALLY_VERIFIED",
        message: "Keystrokes were delivered, but this control does not expose its contents, so the text could not be read back.",
        evidence: { method: state.method, reason: landed.reason },
        confidence: 0.5
      };
    }
  });
  registerM4Primitive({
    name: "keyboard.press",
    description: "Send a bounded key or hotkey sequence to the foreground application",
    inputSchema: { type: "object", properties: { keys: { type: "string" }, windowId: { type: "string" }, application: { type: "string" } }, required: ["keys"] },
    execute: async (args) => adapter.keyboardAction("press", args),
    modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"]
  });
  registerM4Primitive({
    name: "clipboard.read",
    description: "Read current text clipboard content locally",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => adapter.clipboardAction("read"),
    resources: ["clipboard"]
  });
  registerM4Primitive({
    name: "clipboard.write",
    description: "Write text to the clipboard and return the previous value",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (args) => adapter.clipboardAction("write", args),
    permissionType: "WRITE", resources: ["clipboard"], detectedChanges: ["clipboard"]
  });
  registerM4Primitive({
    name: "process.launch",
    description: "Launch one executable with a structured argument array and no shell",
    inputSchema: { type: "object", properties: { executable: { type: "string" }, args: { type: "array" }, workingDirectory: { type: "string" } }, required: ["executable"] },
    execute: async (args) => adapter.launchProcess(args.executable, args.args ?? [], args.workingDirectory),
    modality: ExecutionModality.OS_API,
    risk: RiskLevel.MEDIUM,
    permissionType: "EXECUTE",
    resources: ["process"],
    detectedChanges: ["process"]
  });

  const registerBrowserPrimitive = ({
    name, description, inputSchema, operation, permissionType = "READ",
    risk = RiskLevel.LOW, detectedChanges = [], filesystem = "NONE",
    observeOperation = null, verifyResult = null, timeout = 20000
  }) => registry.register({
    name,
    version: "1.0.0",
    description,
    inputSchema,
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: risk },
    permissionModel: { scope: ["SESSION", "NETWORK"], type: permissionType },
    execution: {
      modalities: [modalityProfile(ExecutionModality.BROWSER_DOM)],
      preferredModality: ExecutionModality.BROWSER_DOM,
      resources: ["browser"]
    },
    security: {
      filesystem, registry: "NONE",
      network: ["launch", "navigate", "playMedia", "playYouTubeLatest", "research"].includes(operation) ? "OUTBOUND" : "NONE",
      browser: permissionType === "WRITE" ? "CONTROLLED" : "READ",
      clipboard: "NONE", windowAutomation: "NONE", externalProcesses: operation === "launch" ? "BROWSER" : "NONE"
    },
    reversibility: permissionType === "WRITE" ? "UNSUPPORTED" : "NOT_REQUIRED",
    rollbackSupport: permissionType === "WRITE" ? "UNSUPPORTED" : "NOT_REQUIRED",
    rollback: permissionType === "WRITE"
      ? { supported: false, reason: "Browser mutations have no reliable generic rollback; recovery requires fresh observation." }
      : { supported: false, reason: "Read-only browser operations do not require rollback." },
    availabilityCheck: checkBrowserAvailability,
    preconditions: () => typeof adapter?.browserDomAction === "function",
    execute: async (args, { signal } = {}) => adapter.browserDomAction(operation, args, { signal }),
    observe: async (result, args) => ({
      observationId: createId(), source: name, timestamp: new Date().toISOString(),
      structuredState: observeOperation
        ? { actionResult: result, observedState: await adapter.browserDomAction(observeOperation, args) }
        : result,
      detectedChanges, confidence: result?.performed === false || result?.found === false ? 0.4 : 0.98,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      if (verifyResult) return verifyResult(result, observation);
      const failed = result.performed === false || result.found === false || result.matched === false;
      return {
        status: failed ? "FAILED" : "VERIFIED",
        message: failed ? (result.reason ?? `${name} did not complete`) : `${name} completed`,
        evidence: result,
        confidence: 0.98
      };
    },
    timeout,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  registerBrowserPrimitive({
    name: "browser.launch",
    description: "Launch a Chromium browser with a private structured CDP control channel",
    inputSchema: { type: "object", properties: { url: { type: "string" }, headless: { type: "boolean" } }, required: [] },
    operation: "launch", permissionType: "EXECUTE", risk: RiskLevel.MEDIUM, detectedChanges: ["browser.process"]
  });
  registerBrowserPrimitive({
    name: "browser.connect",
    description: "Connect to an explicitly enabled local Chromium debugging endpoint",
    inputSchema: { type: "object", properties: { endpoint: { type: "string" } }, required: [] },
    operation: "connect"
  });
  registerBrowserPrimitive({
    name: "browser.navigate",
    description: "Navigate the controlled browser to one explicit HTTP(S) URL",
    inputSchema: { type: "object", properties: { url: { type: "string" }, waitUntil: { type: "string" }, timeoutMs: { type: "number" } }, required: ["url"] },
    operation: "navigate", detectedChanges: ["browser.location"]
  });
  registerBrowserPrimitive({
    name: "browser.media.play",
    description: "Open a structured browser media result and independently verify that its media element is playing",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" }, query: { type: "string" }, resultSelector: { type: "string" },
        mediaSelector: { type: "string" }, blockedStateSelector: { type: "string" }, timeoutMs: { type: "number" }
      },
      required: ["url", "query"]
    },
    // Playback changes only ephemeral tab/media state. Treating it as a
    // persistent write escalated an ordinary play request to HIGH risk and
    // forced an unnecessary approval/replan loop.
    operation: "playMedia", permissionType: "READ", risk: RiskLevel.LOW,
    detectedChanges: ["browser.location", "browser.media.playback"],
    observeOperation: "mediaState", timeout: 90000,
    verifyResult: ({ actionResult = {}, observedState = {} }) => {
      const requestedMediaMatches = matchesMediaQuery(actionResult.selectedTitle, actionResult.query);
      const selectedIdentityObserved = matchesMediaQuery(observedState.title, actionResult.selectedTitle);
      const independentlyProgressed = Number(observedState.currentTime) > Number(actionResult.mediaState?.currentTime ?? 0);
      const activeMedia = observedState.playing === true || (
        selectedIdentityObserved && observedState.paused === false && observedState.ended === false && observedState.readyState >= 2
      );
      const verified = actionResult.performed === true && requestedMediaMatches && selectedIdentityObserved
        && observedState.found === true && activeMedia && independentlyProgressed;
      return {
        status: verified ? "VERIFIED" : "FAILED",
        message: verified ? "Requested browser media playback was independently observed" : (actionResult.reason ?? observedState.reason ?? (requestedMediaMatches ? "Browser media is not playing" : "Opened media does not match the request")),
        evidence: { actionResult, observedState, requestedMediaMatches, selectedIdentityObserved, independentlyProgressed },
        confidence: verified ? 0.99 : 0.99
      };
    }
  });
  registerBrowserPrimitive({
    name: "browser.youtube.latest",
    description: "Resolve a YouTube creator channel, open its Videos page, play the newest listed upload, and verify playback",
    inputSchema: {
      type: "object",
      properties: { creator: { type: "string" }, url: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["creator"]
    },
    operation: "playYouTubeLatest",
    // Playback and privacy-preserving cookie rejection are ephemeral navigation
    // state, not an external mutation or account action.
    permissionType: "READ", risk: RiskLevel.LOW,
    detectedChanges: ["browser.location", "browser.media.playback"],
    observeOperation: "mediaState", timeout: 90000,
    verifyResult: ({ actionResult = {}, observedState = {} }) => {
      const selectedIdentityObserved = matchesMediaQuery(observedState.title, actionResult.selectedTitle);
      const independentlyProgressed = Number(observedState.currentTime) > Number(actionResult.mediaState?.currentTime ?? 0);
      const activeMedia = observedState.playing === true || (
        observedState.paused === false && observedState.ended === false && observedState.readyState >= 2
      );
      const verified = actionResult.performed === true && actionResult.channelMatched === true &&
        Boolean(actionResult.videosUrl) && Boolean(actionResult.selectedTitle) && selectedIdentityObserved &&
        observedState.found === true && activeMedia && independentlyProgressed;
      return {
        status: verified ? "VERIFIED" : "FAILED",
        message: verified
          ? `The newest listed video from ${actionResult.channelLabel || actionResult.creator} is playing.`
          : (actionResult.reason ?? observedState.reason ?? "The creator's newest YouTube video was not independently observed playing"),
        evidence: { actionResult, observedState, selectedIdentityObserved, independentlyProgressed },
        confidence: 0.99
      };
    }
  });
  registerBrowserPrimitive({
    name: "browser.research",
    description: "Extract bounded, timestamped, sourced results from a controlled browser without submitting forms or transactions",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, resultSelector: { type: "string" }, limit: { type: "number" } },
      required: ["url"]
    },
    operation: "research", permissionType: "READ", risk: RiskLevel.LOW,
    observeOperation: "researchState",
    verifyResult: ({ actionResult = {}, observedState = {} }) => {
      const samePage = actionResult.sourceUrl && observedState.sourceUrl === actionResult.sourceUrl;
      const sources = Array.isArray(observedState.items) ? observedState.items : [];
      const verified = actionResult.found === true && observedState.found === true && samePage && sources.length > 0
        && sources.every((item) => /^https?:\/\//i.test(item.url ?? "") && item.title && item.snippet);
      return {
        status: verified ? "VERIFIED" : "FAILED",
        message: verified ? "Structured browser research results were independently observed" : (observedState.reason ?? "Structured research evidence is missing or stale"),
        evidence: { actionResult, observedState }, confidence: 0.98
      };
    }
  });
  registerBrowserPrimitive({
    name: "browser.currentState",
    description: "Read the controlled page URL, title, readiness, viewport, and focus",
    inputSchema: { type: "object", properties: {}, required: [] },
    operation: "currentState"
  });
  registerBrowserPrimitive({
    name: "browser.inspect",
    description: "Inspect a bounded set of visible structured DOM controls and content",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
    operation: "inspect"
  });
  registerBrowserPrimitive({
    name: "browser.find",
    description: "Find a DOM element by selector, text, role, or accessible name and return a grounded target",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, role: { type: "string" }, name: { type: "string" } }, required: [] },
    operation: "find"
  });
  for (const operation of ["click", "type", "select"]) {
    registerBrowserPrimitive({
      name: `browser.${operation}`,
      description: `${operation} a runtime-observed DOM target`,
      inputSchema: {
        type: "object",
        properties: { target: { type: "object" }, text: { type: "string" }, value: { type: "string" }, clear: { type: "boolean" } },
        required: ["target"]
      },
      operation, permissionType: "WRITE", risk: RiskLevel.MEDIUM, detectedChanges: ["browser.document"]
    });
  }
  registerBrowserPrimitive({
    name: "browser.scroll",
    description: "Scroll the page or bring a runtime-observed DOM target into view",
    inputSchema: { type: "object", properties: { target: { type: "object" }, x: { type: "number" }, y: { type: "number" } }, required: [] },
    operation: "scroll", permissionType: "WRITE", detectedChanges: ["browser.viewport"]
  });
  registerBrowserPrimitive({
    name: "browser.wait",
    description: "Wait boundedly for a DOM selector or document readiness state",
    inputSchema: { type: "object", properties: { condition: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, timeoutMs: { type: "number" } }, required: [] },
    operation: "wait"
  });
  registerBrowserPrimitive({
    name: "browser.read",
    description: "Read text from a runtime-observed DOM target or explicit selector",
    inputSchema: { type: "object", properties: { target: { type: "object" }, selector: { type: "string" } }, required: [] },
    operation: "read"
  });
  registerBrowserPrimitive({
    name: "browser.extract",
    description: "Extract a typed scalar such as a version or number from structured DOM text",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["version", "number", "text"] }, query: { type: "string" }, selector: { type: "string" } }, required: ["kind"] },
    operation: "extract"
  });
  registerBrowserPrimitive({
    name: "browser.download",
    description: "Download from a runtime-observed DOM target into an explicit existing directory and verify the resulting file",
    inputSchema: { type: "object", properties: { target: { type: "object" }, directory: { type: "string" }, timeoutMs: { type: "number" } }, required: ["target", "directory"] },
    operation: "download", permissionType: "WRITE", risk: RiskLevel.MEDIUM,
    filesystem: "WRITE", detectedChanges: ["filesystem"]
  });

  // gui.inspect is the reusable perception primitive for a desktop agent. It
  // exposes accessible controls as structured evidence; it never clicks/types.
  registry.register({
    name: "gui.inspect",
    version: "1.0.0",
    description: "Inspect accessible controls in a visible desktop application",
    inputSchema: { type: "object", properties: { application: { type: "string" }, maxElements: { type: "number" } }, required: [] },
    outputSchema: { type: "object" }, requiredContext: [], riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" }, reversibility: "NOT_REQUIRED",
    execute: async (args) => adapter.inspectUi(args ?? {}),
    observe: async (result, args) => ({ observationId: createId(), source: "gui.inspect", timestamp: new Date().toISOString(), structuredState: result, relatedActionId: args?.actionId, detectedChanges: [], confidence: 0.9, trustLevel: "SYSTEM_TRUSTED" }),
    verify: async (observation) => ({ status: "VERIFIED", message: `Inspected ${(observation?.structuredState?.elements ?? []).length} accessible controls.`, confidence: 0.9 }),
    timeout: 15000, retryPolicy: { maxAttempts: 1, backoffMs: 0 }, lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // gui.interact is intentionally generic, but never coordinate based. Every
  // action is bound to an app window plus an accessible selector. The runtime
  // asks for approval before it can alter a third-party UI.
  registry.register({
    name: "gui.interact",
    version: "1.0.0",
    description: "Click or type into an accessible control in a visible desktop application",
    inputSchema: { type: "object", properties: { application: { type: "string" }, target: { type: "object" }, action: { type: "string" }, text: { type: "string" } }, required: ["application", "target", "action"] },
    outputSchema: { type: "object" }, requiredContext: ["application"], riskMetadata: { level: RiskLevel.MEDIUM },
    permissionModel: { scope: ["SESSION"], type: "WRITE" }, reversibility: "PARTIALLY_REVERSIBLE",
    execute: async (args) => adapter.interactUi(args),
    observe: async (result, args) => ({ observationId: createId(), source: "gui.interact", timestamp: new Date().toISOString(), structuredState: result, relatedActionId: args?.actionId, detectedChanges: result?.performed ? ["application.ui"] : [], confidence: result?.performed ? 0.8 : 0.4, trustLevel: "SYSTEM_TRUSTED" }),
    verify: async (observation) => observation?.structuredState?.performed
      ? { status: "VERIFIED", message: "Accessible UI action completed.", confidence: 0.8 }
      : { status: "FAILED", message: observation?.structuredState?.reason ?? "UI action did not complete.", confidence: 1 },
    timeout: 20000, retryPolicy: { maxAttempts: 0, backoffMs: 0 }, recoveryHints: ["ABORT_ON_FAILURE"], lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // spotify.track.open (real) - hand a specific song request to the installed
  // Spotify desktop client. This deliberately opens Spotify's result, rather
  // than claiming it can control account playback without OAuth authorization.
  registry.register({
    name: "spotify.track.open",
    version: "1.0.0",
    description: "Open a track search in the Spotify desktop client",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.query === "string" && args.query.trim() !== "",
    execute: async (args) => adapter.openSpotifySearch(args.query),
    observe: async (result, args) => ({
      observationId: createId(), source: "spotify.track.open", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId, detectedChanges: ["application"],
      confidence: result?.launch?.opened ? 1 : 0.5, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      const opened = result?.launch?.opened === true || result?.launchResult?.exitCode === 0;
      return {
        status: opened ? "VERIFIED" : "FAILED",
        message: opened
          ? `Opened Spotify results for ${result.query}.`
          : `Could not open Spotify results for ${result.query ?? "the requested track"}.`,
        evidence: { uri: result.uri ?? null }, confidence: opened ? 0.9 : 0
      };
    },
    timeout: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // spotify.track.play (real) - drive the installed Spotify desktop client to
  // ACTUALLY play a requested track via bounded, window-scoped UI Automation.
  // Unlike spotify.track.open (which only opens results), this attempts real
  // playback and then VERIFIES it independently from the live Spotify window
  // title — so it reports success ONLY when a track is genuinely playing, and
  // honestly reports partial/failed otherwise (never "launched == done").
  //
  // Normal launch/search/focus/play is a LOW-risk, ephemeral interaction with one
  // already-installed app (no account/OAuth/financial mutation), so — like
  // application.launch and spotify.track.open — it is ALLOW without confirmation.
  // ABORT_ON_FAILURE + a single bounded retry keep a failed UI interaction from
  // looping/replanning forever.
  registry.register({
    name: "spotify.track.play",
    version: "1.0.0",
    description: "Play a track in the Spotify desktop client via bounded UI automation",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, options: { type: "object" } },
      required: ["query"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // Scoped to a single interactive session with one app, exactly like
    // spotify.track.open / application.launch. Not a system or account write.
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.query === "string" && args.query.trim() !== "",
    execute: async (args) => adapter.playSpotifyTrack(args.query, args.options ?? {}),
    observe: async (result, args) => ({
      observationId: createId(), source: "spotify.track.play", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId,
      detectedChanges: result?.playback?.playing ? ["application.playback"] : [],
      confidence: result?.playback?.playing ? 1 : 0.5, trustLevel: "SYSTEM_TRUSTED"
    }),
    // INDEPENDENT verification: re-read the LIVE Spotify window title rather than
    // trusting execute()'s own return value. A track is confirmed VERIFIED only
    // when playback is live AND the title matches the requested query.
    verify: async (observation, args) => {
      const result = observation?.structuredState ?? {};
      const query = String(args?.query ?? result.query ?? "").trim();
      if (result.available === false) {
        return {
          status: "FAILED",
          message: "Spotify does not appear to be installed, so the track could not be played.",
          evidence: result, confidence: 1
        };
      }
      const live = typeof adapter.readSpotifyPlayback === "function"
        ? await adapter.readSpotifyPlayback()
        : (result.playback ?? {});
      const matched = matchesTrackQuery(live.title ?? live.nowPlaying, query);
      if (live.playing && matched) {
        return {
          status: "VERIFIED",
          message: `Playing "${live.nowPlaying}" in Spotify.`,
          evidence: { title: live.title }, confidence: 0.9
        };
      }
      // Confirmed playing (live Pause-button evidence) but no reliable track
      // title was available to check — this is NOT the same as confirming the
      // wrong track is playing, and must not be reported as such.
      if (live.playing && !live.nowPlaying) {
        return {
          status: "PARTIALLY_VERIFIED",
          message: `Spotify is playing, but I could not independently confirm the track title; it is likely "${query}".`,
          evidence: { title: live.title ?? null }, confidence: 0.6
        };
      }
      if (live.playing && !matched) {
        return {
          status: "FAILED",
          message: `Spotify is playing "${live.nowPlaying}", not the requested "${query}".`,
          evidence: { title: live.title }, confidence: 1
        };
      }
      return {
        status: "FAILED",
        message: `I opened Spotify and searched for "${query}", but couldn't confirm the track started playing. You may need to press Play.`,
        evidence: { title: live.title ?? null }, confidence: 1
      };
    },
    timeout: 30000,
    retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  registry.register({
    name: "calculator.evaluate",
    version: "1.0.0",
    description: "Enter one bounded arithmetic expression in Windows Calculator and verify the visible result",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" }, expectedResult: { type: "string" } },
      required: ["expression", "expectedResult"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => /^\d+(?:\.\d+)?(?:[+*/-]\d+(?:\.\d+)?)+$/.test(String(args?.expression ?? "")),
    execute: async (args) => adapter.calculateWithUi(args.expression, args.expectedResult),
    observe: async (result, args) => ({
      observationId: createId(), source: "calculator.evaluate", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId,
      detectedChanges: result?.performed ? ["application.ui"] : [],
      confidence: result?.matched ? 1 : 0.6, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const result = observation?.structuredState ?? {};
      const expected = String(args?.expectedResult ?? result.expectedResult ?? "");
      const live = typeof adapter.inspectUi === "function"
        ? await adapter.inspectUi({ application: "calculator", windowId: result.windowId, maxElements: 160 })
        : result.inspected;
      const compactNumber = (value) => String(value ?? "").replace(/[,\s]/g, "");
      const matched = (live?.elements ?? []).some((element) =>
        compactNumber(element?.name ?? element?.value ?? "").includes(compactNumber(expected))
      );
      return matched
        ? { status: "VERIFIED", message: `Calculator visibly shows ${expected}.`, evidence: { expected, windowId: result.windowId }, confidence: 0.99 }
        : { status: "FAILED", message: `Calculator did not visibly show the expected result ${expected}.`, evidence: { expected, visibleResult: result.visibleResult }, confidence: 1 };
    },
    timeout: 20000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  registry.register({
    name: "whatsapp.message.draft",
    version: "1.0.0",
    description: "Open a WhatsApp chat and leave exact text in the composer without sending it",
    inputSchema: {
      type: "object",
      properties: { contact: { type: "string" }, message: { type: "string" }, send: { type: "boolean" } },
      required: ["contact", "message"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // An unsent draft is ephemeral local UI state. It never crosses the
    // communication boundary, so it follows the same no-confirmation policy as
    // local media playback; any future send capability must be separate.
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.contact === "string" && args.contact.trim() &&
      typeof args?.message === "string" && args.message.trim() && args?.send !== true,
    execute: async (args) => adapter.draftWhatsAppMessage(args.contact, args.message),
    observe: async (result, args) => ({
      observationId: createId(), source: "whatsapp.message.draft", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId,
      detectedChanges: result?.drafted ? ["application.ui"] : [],
      confidence: result?.draftVisible && result?.contactVisible ? 0.98 : 0.6, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const result = observation?.structuredState ?? {};
      const live = typeof adapter._readApplicationOcr === "function" && result.windowId
        ? await adapter._readApplicationOcr("whatsapp", result.windowId).catch(() => null)
        : result.screen;
      const compact = (value) => String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const visible = compact(live?.text);
      const contactVisible = visible.includes(compact(args?.contact));
      const message = compact(args?.message);
      const messageTokens = [...new Set(message.split(" ").filter((token) => token.length >= 3))];
      const visibleTokens = new Set(visible.split(" ").filter(Boolean));
      const messageCoverage = messageTokens.length
        ? messageTokens.filter((token) => visibleTokens.has(token)).length / messageTokens.length
        : 0;
      const messageVisible = visible.includes(message) || (contactVisible && messageCoverage >= 0.8);
      const verified = result.sent === false && result.sendInvoked === false && messageVisible && contactVisible;
      return verified
        ? { status: "VERIFIED", message: `The WhatsApp draft to ${args.contact} is visible and remains unsent.`, evidence: { contactVisible, messageVisible, messageCoverage, sendInvoked: false }, confidence: 0.98 }
        : { status: "FAILED", message: "The exact unsent WhatsApp draft could not be independently confirmed on screen.", evidence: { contactVisible, messageVisible, messageCoverage, sendInvoked: result.sendInvoked }, confidence: 1 };
    },
    timeout: 30000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  registry.register({
    name: "spotify.track.queue",
    version: "1.0.0",
    description: "Add a requested track to the Spotify playback queue through grounded accessible controls",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, options: { type: "object" } },
      required: ["query"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // Queueing is temporary playback state and never changes a file, account,
    // purchase, or communication. Treat it like spotify.track.play so a normal
    // follow-up does not get trapped in repeated approval/replan cycles.
    permissionModel: { scope: ["SESSION"], type: "READ" },
    // Queue state is ephemeral playback state rather than a persistent account,
    // filesystem, or system mutation.
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.query === "string" && args.query.trim() !== "",
    execute: async (args) => adapter.queueSpotifyTrack(args.query, args.options ?? {}),
    observe: async (result, args) => ({
      observationId: createId(), source: "spotify.track.queue", timestamp: new Date().toISOString(),
      structuredState: result, relatedActionId: args?.actionId,
      detectedChanges: result?.queued ? ["application.queue"] : [],
      confidence: result?.queued ? 0.9 : 0.5, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const result = observation?.structuredState ?? {};
      const query = String(args?.query ?? result.query ?? "").trim();
      if (result.available === false) {
        return { status: "FAILED", message: "Spotify was not available, so the track could not be queued.", evidence: result, confidence: 1 };
      }
      // "Spotify's search returned no such track" and "the track exists but the
      // queue action didn't take" are different problems with different user
      // fixes (retype the title vs retry the interaction). The execution result
      // already distinguishes them, so say which one happened instead of
      // collapsing both into a vague "couldn't confirm".
      if (result.queued === false && result.reason === "matching-track-not-found") {
        return {
          status: "FAILED",
          message: `Spotify's search returned no track matching "${query}", so there was nothing to queue. Check the spelling, or try just the song title.`,
          evidence: result,
          confidence: 1
        };
      }
      const live = typeof adapter.readSpotifyQueue === "function"
        ? await adapter.readSpotifyQueue(query)
        : { queued: false, reason: "queue-verifier-unavailable" };
      return live.queued
        ? { status: "VERIFIED", message: `Queued "${query}" in Spotify.`, evidence: live, confidence: 0.9 }
        : { status: "FAILED", message: `I could not confirm "${query}" was added to the Spotify queue.`, evidence: live, confidence: 1 };
    },
    timeout: 35000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    recoveryHints: ["ABORT_ON_FAILURE"],
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  /* Removed compatibility registrations. Kept as a non-executable migration
   * record until the next source compaction; they cannot enter discovery.
  registry.register({
    name: "developer.project.detect",
    version: "1.0.0",
    description: "Detect developer project type and runnable scripts",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "developer.project.detect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Detected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "developer.project.run",
    version: "1.0.0",
    description: "Install dependencies and run project",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["workspace:execute"],
    reversibility: "PARTIAL",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "developer.project.run",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Run initiated" }),
    rollback: null,
    timeout: 60000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "environment.project.inspect",
    version: "1.0.0",
    description: "Inspect project environment file",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "environment.project.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Inspected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "environment.user.set",
    version: "1.0.0",
    description: "Set Windows user environment variable",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["environment:user:write"],
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "environment.user.set",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Set" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "package.winget.install",
    version: "1.0.0",
    description: "Install a package via WinGet",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:write"],
    reversibility: "PARTIAL",
    availabilityCheck: checkWingetAvailability,
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "package.winget.install",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Installed" }),
    rollback: null,
    timeout: 600000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "system.service.inspect",
    version: "1.0.0",
    description: "Inspect Windows service state",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "system.service.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Inspected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "package.manager.inspect",
    version: "1.0.0",
    description: "Inspect package manager availability",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "package.manager.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Inspected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "environment.user.path.dedupe",
    version: "1.0.0",
    description: "Deduplicate user PATH entries",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["environment:user:write"],
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "environment.user.path.dedupe",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Deduped" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "git.repository.inspect",
    version: "1.0.0",
    description: "Inspect git repository state",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "git.repository.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Inspected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  registry.register({
    name: "docker.environment.inspect",
    version: "1.0.0",
    description: "Inspect Docker environment",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async (result) => ({
      observationId: createId(),
      source: "docker.environment.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async () => ({ status: "VERIFIED", message: "Inspected" }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.UNAVAILABLE
  });

  */

  // Adapter-backed capabilities with one canonical registration each.

  // environment.user.set (real) - set a Windows user environment variable
  registry.register({
    name: "environment.user.set",
    version: "1.0.0",
    description: "Set a Windows user environment variable",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" }
      },
      required: ["key", "value"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["environment:user:write"],
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: (args) => !!args.key,
    execute: async (args) => {
      return adapter.setUserEnvironmentVariable(args.key, args.value);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.user.set",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["user.environment"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const verify = await adapter.verifyUserEnvironmentVariable(args.key, args.value);
      return {
        status: verify.matches ? "VERIFIED" : "FAILED",
        message: verify.matches ? "User environment variable set correctly" : "Failed to set user environment variable",
        evidence: verify,
        expectedState: { key: args.key, value: args.value },
        observedState: verify,
        confidence: verify.matches ? 1 : 0
      };
    },
    rollback: async (args, checkpoint) => {
      return adapter.restoreUserEnvironmentVariable(args.key, checkpoint?.previousValue ?? null);
    },
    createCheckpoint: async (args) => {
      const existing = await adapter.inspectUserEnvironmentVariable(args.key);
      return { previousValue: existing.value ?? null };
    },
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // environment.user.path.dedupe (real) - deduplicate user PATH entries
  registry.register({
    name: "environment.user.path.dedupe",
    version: "1.0.0",
    description: "Deduplicate user PATH entries",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["environment:user:write"],
    reversibility: "ROLLBACK_SUPPORTED",
    preconditions: () => true,
    execute: async () => {
      return adapter.dedupeUserPath();
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "environment.user.path.dedupe",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["user.path"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const removed = observation.structuredState?.removedCount ?? 0;
      return {
        status: "VERIFIED",
        message: `PATH deduplicated (${removed} duplicate(s) removed)`,
        evidence: observation.structuredState,
        confidence: 1
      };
    },
    rollback: async (args, checkpoint) => {
      return adapter.rollbackUserPath(checkpoint?.previousValue ?? "");
    },
    createCheckpoint: async () => {
      const current = await adapter.getUserPath();
      return { previousValue: current.value ?? "" };
    },
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // package.winget.install (real) - install a package via WinGet
  registry.register({
    name: "package.winget.install",
    version: "1.0.0",
    description: "Install a package via WinGet",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:write"],
    reversibility: "PARTIAL",
    availabilityCheck: checkWingetAvailability,
    preconditions: (args) => !!args.id,
    execute: async (args) => {
      return adapter.wingetInstall(args.id);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "package.winget.install",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["system.packages"],
      confidence: 0.9,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      const listAfter = await adapter.wingetList(args.id);
      const installed = listAfter.exitCode === 0 &&
        (listAfter.stdout ?? "").toLowerCase().includes(String(args.id).toLowerCase());
      return {
        status: installed ? "VERIFIED" : "FAILED",
        message: installed ? "Package installation verified" : "Failed to verify package installation",
        evidence: listAfter,
        confidence: installed ? 0.9 : 0
      };
    },
    rollback: null,
    timeout: 600000,
    retryPolicy: { maxAttempts: 1, backoffMs: 5000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // A bounded reinstall is one atomic user outcome. Keeping both WinGet stages
  // inside one capability prevents a planner/provider failure between removal
  // and restoration from stranding the application in an uninstalled state.
  registry.register({
    name: "package.winget.reinstall",
    version: "1.0.0",
    description: "Uninstall and reinstall an exact Windows package via WinGet, then verify it is installed",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:write"],
    reversibility: "PARTIAL",
    availabilityCheck: checkWingetAvailability,
    preconditions: (args) => typeof args.id === "string" && args.id.trim().length > 0,
    execute: async (args) => adapter.wingetReinstall(args.id),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "package.winget.reinstall",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["system.packages"],
      confidence: 0.95,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (_observation, args) => {
      const listAfter = await adapter.wingetList(args.id);
      const installed = listAfter.exitCode === 0 &&
        (listAfter.stdout ?? "").toLowerCase().includes(String(args.id).toLowerCase());
      return {
        status: installed ? "VERIFIED" : "FAILED",
        message: installed ? "Package reinstallation verified" : "Failed to verify package reinstallation",
        evidence: listAfter,
        confidence: installed ? 0.95 : 0
      };
    },
    rollback: null,
    timeout: 600000,
    retryPolicy: { maxAttempts: 1, backoffMs: 5000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // system.service.inspect (real) - inspect a Windows service
  registry.register({
    name: "system.service.inspect",
    version: "1.0.0",
    description: "Inspect a Windows service state",
    inputSchema: {
      type: "object",
      properties: { serviceName: { type: "string" } },
      required: ["serviceName"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.serviceName,
    execute: async (args) => {
      return adapter.inspectService(args.serviceName);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "system.service.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "Service inspection complete",
      evidence: observation.structuredState,
      confidence: 1
    }),
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // git.repository.inspect (real) - inspect git repository state
  registry.register({
    name: "git.repository.inspect",
    version: "1.0.0",
    // Names both claims this capability can prove — installed/available AND
    // repository state — so goal-contract criterion matching (which reads
    // this static description, not the runtime verify() message) can anchor
    // an "is Git installed" goal to it before execution even runs.
    description: "Check whether Git is installed and available on this system, and inspect the git repository state of the workspace",
    inputSchema: {
      type: "object",
      properties: { workspacePath: { type: "string" } },
      required: ["workspacePath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    // Read-only inspection: no mutation, nothing to roll back. Declaring this
    // is what lets the runtime's evidence ledger recognize this capability's
    // verify() as INDEPENDENT evidence (see verificationIsIndependent in
    // agent-runtime) rather than discarding it as unverified action-trust.
    permissionModel: { scope: ["SESSION"], type: "READ" },
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.workspacePath,
    execute: async (args) => {
      return adapter.inspectGitRepository(args.workspacePath);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "git.repository.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation.structuredState ?? {};
      const valid = typeof result.isRepository === "boolean"
        && ["REPOSITORY", "NOT_A_REPOSITORY"].includes(result.status);
      // Installed/available is its own claim, stated explicitly so a goal that
      // only asks whether Git is installed has literal evidence to anchor to —
      // "is this workspace a repository" alone does not answer that question.
      const installedNote = result.gitInstalled
        ? `Git is installed and available on this system${result.gitVersion ? ` (${result.gitVersion})` : ""}.`
        : "Git is not installed or not available on this system.";
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? `${installedNote} ${result.isRepository ? "Git repository state inspected." : "Workspace is not a Git repository."}`
          : "Git repository probe failed.",
        evidence: result,
        confidence: valid ? 1 : 0
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // docker.environment.inspect (real) - inspect docker availability
  registry.register({
    name: "docker.environment.inspect",
    version: "1.0.0",
    description: "Inspect Docker environment availability",
    inputSchema: {
      type: "object",
      properties: { workspacePath: { type: "string" } },
      required: ["workspacePath"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["workspace:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.workspacePath,
    execute: async (args) => {
      return adapter.inspectDockerEnvironment(args.workspacePath);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "docker.environment.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation.structuredState ?? {};
      const valid = typeof result.available === "boolean"
        && ["AVAILABLE", "NOT_AVAILABLE"].includes(result.status);
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? (result.available ? "Docker is available." : "Docker is not available.")
          : "Docker availability probe failed.",
        evidence: result,
        confidence: valid ? 1 : 0
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // package.manager.inspect (real) - inspect a package manager version
  registry.register({
    name: "package.manager.inspect",
    version: "1.0.0",
    description: "Inspect package manager availability",
    inputSchema: {
      type: "object",
      properties: { packageManager: { type: "string" } },
      required: []
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async (args) => {
      return adapter.inspectPackageManager(args.packageManager ?? "winget");
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "package.manager.inspect",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation.structuredState ?? {};
      const valid = typeof result.available === "boolean"
        && ["AVAILABLE", "NOT_AVAILABLE"].includes(result.status);
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? `${result.packageManager ?? "Package manager"} is ${result.available ? "available" : "not available"}.`
          : "Package manager availability probe failed.",
        evidence: result,
        confidence: valid ? 1 : 0
      };
    },
    rollback: null,
    timeout: 10000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // system.performance.analyze (real) - analyze system performance snapshot
  registry.register({
    name: "system.performance.analyze",
    version: "1.0.0",
    description: "Analyze system performance from a live snapshot",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => {
      return adapter.analyzeSystemPerformance();
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "system.performance.analyze",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "System performance analysis complete",
      evidence: observation.structuredState,
      confidence: 1
    }),
    rollback: null,
    timeout: 20000,
    retryPolicy: { maxAttempts: 1, backoffMs: 500 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // browser.search (real) - open the default search for a query. This wraps the
  // pre-existing adapter.browserSearch operation behind the capability boundary
  // so the legacy browserSearchIntent no longer calls the adapter directly.
  registry.register({
    name: "browser.search",
    version: "1.0.0",
    description: "Open a web search for a query in the browser",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    // Opening a search result is read-only navigation, not an external write.
    permissions: ["browser:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => !!args.query,
    execute: async (args) => {
      return adapter.browserSearch(args.query);
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "browser.search",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 0.8,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const launched = observation.structuredState?.launchResult?.exitCode === 0;
      return {
        status: launched ? "VERIFIED" : "PARTIALLY_VERIFIED",
        message: launched ? "Browser search launched" : "Browser search dispatched (launch unconfirmed)",
        evidence: observation.structuredState,
        confidence: launched ? 0.8 : 0.5
      };
    },
    rollback: null,
    timeout: 20000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // developer.command.run (real) - run a single resolved developer command
  // (e.g. dependency install or a project start check) via the adapter. The
  // planner resolves the concrete command/args from the project profile, so
  // this capability stays generic and typed.
  registry.register({
    name: "developer.command.run",
    version: "1.0.0",
    description: "Run a resolved developer command in a workspace",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        command: { type: "string" },
        args: { type: "array" }
      },
      required: ["workspacePath", "command"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["workspace:execute"],
    reversibility: "PARTIAL",
    preconditions: (args) => !!args.workspacePath && !!args.command,
    execute: async (args) => {
      return adapter.executeCommand(args.workspacePath, args.command, args.args ?? [], { timeoutMs: 90000 });
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "developer.command.run",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["workspace"],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const ok = observation.structuredState?.exitCode === 0 && !observation.structuredState?.timedOut;
      return {
        status: ok ? "VERIFIED" : "FAILED",
        message: ok ? "Command completed successfully" : "Command failed or timed out",
        evidence: observation.structuredState,
        confidence: ok ? 1 : 0
      };
    },
    rollback: null,
    timeout: 95000,
    retryPolicy: { maxAttempts: 1, backoffMs: 2000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // system.services.list (real) - list Windows services
  registry.register({
    name: "system.services.list",
    version: "1.0.0",
    description: "List Windows services",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "array" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.LOW },
    permissions: ["system:read"],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => {
      return adapter.listServices();
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "system.services.list",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: [],
      confidence: 1,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "Services listed",
      evidence: observation.structuredState,
      confidence: 1
    }),
    rollback: null,
    timeout: 15000,
    retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // Privileged capabilities (canonical convergence). These are the ONLY way a
  // bounded privileged operation reaches execution: they flow through the same
  // planner -> risk -> policy -> permission-broker -> scheduler -> pipeline path
  // as every other capability. There is no separate privileged execution route.
  //
  // Each capability:
  //   - declares MEDIUM risk, so policy routes it through CONFIRM (HIGH/CRITICAL
  //     is hard-denied by the PolicyEngine), and the derived permission model is
  //     EXECUTE + SINGLE_USE (elevation), enforced by the capability grant store;
  //   - requires an approval token (task input `token`) which its execute()
  //     consumes through the PrivilegedOperationHelper — the token is validated
  //     and single-use inside the broker, so an approved grant alone is not
  //     sufficient to mutate;
  //   - defaults to the read-only VALIDATE mode; COMMIT must be requested
  //     explicitly (task input `mode: "COMMIT"`), matching the helper contract.
  //
  // When no privilegedHelper is wired (lightweight/test runtime), they register
  // as UNAVAILABLE so the planner/validator will not select them, keeping the
  // default in-memory registry free of an executable privileged surface.
  const privilegedLifecycle = privilegedHelper
    ? LifecycleStatus.VERIFIED
    : LifecycleStatus.UNAVAILABLE;

  const runPrivileged = async (operation, scope, args) => {
    if (!privilegedHelper) {
      return { success: false, operation, scope, reason: "Privileged helper is not configured for this runtime." };
    }
    return privilegedHelper.execute(operation, scope, {
      sessionId: args?.sessionId,
      token: args?.token,
      mode: args?.mode === "COMMIT" ? "COMMIT" : "VALIDATE"
    });
  };

  // service.restart (privileged) - restart a Windows service through the bounded,
  // token-gated helper.
  registry.register({
    name: "service.restart",
    version: "1.0.0",
    description: "Restart a Windows service through the bounded privileged helper",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        token: { type: "string" },
        mode: { type: "string", enum: ["VALIDATE", "COMMIT"] },
        sessionId: { type: "string" }
      },
      required: ["scope", "token"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:service:restart"],
    requirements: { elevation: "ADMIN", permissions: ["system:service:restart"] },
    // Structural binding: an elevated capability MUST name the bounded privileged
    // operation it routes through. The registry rejects any elevated capability
    // whose privilegedOperation is not a real helper operation, and execution is
    // routed through the helper (never an arbitrary execute()). This is what makes
    // ELEVATE an execution-ROUTING guarantee rather than a boolean.
    privilegedOperation: "service.restart",
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.scope === "string" && args.scope.trim() !== "" && typeof args?.token === "string" && args.token !== "",
    execute: async (args) => runPrivileged("service.restart", args.scope, args),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "service.restart",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["system.service"],
      confidence: result?.success ? 0.9 : 0,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.success ? "VERIFIED" : "FAILED",
        message: result.reason ?? (result.success ? "Privileged service.restart completed" : "Privileged service.restart failed"),
        evidence: result,
        confidence: result.success ? 0.9 : 0
      };
    },
    rollback: null,
    timeout: 30000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: privilegedLifecycle
  });

  // package.install (privileged) - install a package through the bounded,
  // token-gated helper.
  registry.register({
    name: "package.install",
    version: "1.0.0",
    description: "Install a package through the bounded privileged helper",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        token: { type: "string" },
        mode: { type: "string", enum: ["VALIDATE", "COMMIT"] },
        sessionId: { type: "string" }
      },
      required: ["scope", "token"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:package:install"],
    requirements: { elevation: "ADMIN", permissions: ["system:package:install"] },
    // Explicit binding to a bounded privileged-helper operation. This is what
    // makes ELEVATE an execution-ROUTING guarantee: the registry only accepts an
    // elevated capability whose privilegedOperation names a real helper op, and
    // the pipeline refuses to run an elevated capability that lacks this binding.
    privilegedOperation: "package.install",
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.scope === "string" && args.scope.trim() !== "" && typeof args?.token === "string" && args.token !== "",
    execute: async (args) => runPrivileged("package.install", args.scope, args),
    observe: async (result, args) => ({
      observationId: createId(),
      source: "package.install",
      timestamp: new Date().toISOString(),
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: ["system.packages"],
      confidence: result?.success ? 0.9 : 0,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => {
      const result = observation?.structuredState ?? {};
      return {
        status: result.success ? "VERIFIED" : "FAILED",
        message: result.reason ?? (result.success ? "Privileged package.install completed" : "Privileged package.install failed"),
        evidence: result,
        confidence: result.success ? 0.9 : 0
      };
    },
    rollback: null,
    timeout: 600000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: privilegedLifecycle
  });

  // session.rollback (canonical convergence). Rolling back is itself a
  // state-mutating action (it restores env vars / PATH / files), so it must not
  // run outside the pipeline. This capability is the ONLY sanctioned way to
  // invoke the RollbackManager: the runtime translates a rollback request into a
  // "session.rollback" intent, and the intent flows through the same planner ->
  // risk -> policy -> permission -> scheduler -> observe -> verify path as any
  // other mutation. execute() does NOT reimplement rollback logic — it delegates
  // to the shared RollbackManager (injected via registry.setRollbackManager),
  // moving only the *invocation* behind the capability boundary.
  //
  // Risk is MEDIUM: it performs the same class of mutation (env/PATH/file
  // restore) as the actions it reverts. Ideally the risk would inherit from the
  // highest-risk original record, but rollback records only carry
  // taskId/capability/inputs/checkpoint (see RollbackManager.capture) — original
  // risk metadata is not on the record — so MEDIUM is the honest floor. If richer
  // risk provenance is added to records later, this should escalate to match.
  registry.register({
    name: "session.rollback",
    version: "1.0.0",
    description: "Revert recorded checkpoints for a session through the shared rollback manager",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        records: { type: "array" },
        targetRecordIds: { type: "array" },
        reason: { type: "string" }
      },
      required: ["sessionId"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: RiskLevel.MEDIUM },
    permissions: ["system:write"],
    // Rolling back a rollback is out of scope for V1: it would just replay the
    // original actions, which the user did not request. This is an HONEST
    // NOT_REQUIRED (unlike capabilities that claim PARTIAL but ship rollback:null)
    // — the contract guard added in Phase 2.4 enforces that distinction.
    reversibility: "NOT_REQUIRED",
    preconditions: (args) => typeof args?.sessionId === "string" && args.sessionId.trim() !== "",
    execute: async (args) => {
      if (!registry.rollbackManager) {
        return { rolledBack: false, reason: "Rollback manager is not configured for this runtime.", entries: [] };
      }
      // Records travel on the intent; the runtime populates them from the target
      // session before dispatch. A targetRecordIds subset narrows what is reverted.
      let records = Array.isArray(args?.records) ? args.records : [];
      if (Array.isArray(args?.targetRecordIds) && args.targetRecordIds.length > 0) {
        const wanted = new Set(args.targetRecordIds.map(String));
        records = records.filter((r) => wanted.has(String(r?.taskId)));
      }
      if (records.length === 0) {
        return { rolledBack: false, reason: "No rollback records available for the session.", entries: [] };
      }
      const result = await registry.rollbackManager.rollback(records);
      return { ...result, sessionId: args.sessionId, reason: args?.reason ?? null };
    },
    observe: async (result, args) => ({
      observationId: createId(),
      source: "session.rollback",
      timestamp: new Date().toISOString(),
      // The rollback result (entries + rolledBack flag) IS the observation — no
      // new observation logic is invented.
      structuredState: result,
      relatedActionId: args?.actionId,
      detectedChanges: (result?.entries ?? [])
        .filter((e) => e?.status === "ROLLED_BACK")
        .map((e) => `rollback:${e.capability}`),
      confidence: result?.rolledBack ? 1 : 0,
      trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation, args) => {
      // A REAL, independent check — not a hardcoded VERIFIED, and not merely
      // trusting the RollbackManager's own entries. Two gates:
      //   1. Every record produced a ROLLED_BACK entry (the restore call
      //      returned without error).
      //   2. INDEPENDENT RE-READ: for each rolled-back record we capture a FRESH
      //      checkpoint of current state (capability.createCheckpoint) and compare
      //      it to the original pre-mutation checkpoint. If the state was truly
      //      restored, the fresh reading must equal the pre-mutation snapshot.
      //      This re-reads live state through the same adapter-backed method the
      //      original capability used to snapshot it, so a rollback that "returned
      //      OK" but left state wrong is still caught here.
      const result = observation?.structuredState ?? {};
      const entries = Array.isArray(result.entries) ? result.entries : [];
      if (entries.length === 0) {
        return { status: "FAILED", message: "No rollback entries were produced.", evidence: result, confidence: 1 };
      }
      const failed = entries.filter((e) => e?.status !== "ROLLED_BACK");
      if (failed.length > 0) {
        return {
          status: "FAILED",
          message: `${failed.length}/${entries.length} record(s) failed to roll back.`,
          evidence: result,
          confidence: 1
        };
      }

      // Independent re-read against the original pre-mutation checkpoints.
      //
      // Records travel on the intent and are persisted through the session store,
      // which redacts secret-shaped fields (value/secret/token/...). A fresh live
      // re-read is UNredacted, so we must compare redaction-normalized snapshots on
      // BOTH sides. This means every non-secret field (file existence, rawContents,
      // PATH entries, etc.) IS verified byte-for-byte, while a redacted secret only
      // has to still be present/absent — the secret's plaintext is unrecoverable
      // once persisted, so demanding a plaintext match here would be a false
      // negative, not stronger verification. Restore correctness for secret VALUES
      // is the capability rollback's own responsibility (it restores from
      // rawContents/filePath, not the redacted `values` map).
      const records = Array.isArray(args?.records) ? args.records : [];
      const mismatches = [];
      let reReads = 0;
      for (const record of records) {
        const capability = registry.get(record?.capability);
        if (!capability || typeof capability.createCheckpoint !== "function") continue;
        try {
          const fresh = await capability.createCheckpoint(record.inputs ?? {});
          reReads += 1;
          const freshNorm = JSON.stringify(redactSensitiveData(fresh));
          const checkpointNorm = JSON.stringify(redactSensitiveData(record.checkpoint));
          if (freshNorm !== checkpointNorm) {
            mismatches.push(record.capability);
          }
        } catch (error) {
          mismatches.push(`${record.capability} (re-read failed: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (mismatches.length > 0) {
        return {
          status: "FAILED",
          message: `Rollback reported success but a re-read shows ${mismatches.length} record(s) did not match the pre-mutation state: ${mismatches.join(", ")}.`,
          evidence: { ...result, mismatches, reReads },
          confidence: 1
        };
      }
      return {
        status: "VERIFIED",
        message: `All ${entries.length} record(s) rolled back; ${reReads} independently re-read and confirmed restored to pre-mutation state.`,
        evidence: { ...result, reReads },
        confidence: 1
      };
    },
    rollback: null,
    timeout: 120000,
    retryPolicy: { maxAttempts: 1 },
    lifecycleStatus: LifecycleStatus.VERIFIED
  });

  // Provider-neutral media contract. Planning targets `media.*`; Spotify is the
  // first provider behind it. The `spotify.*` capabilities above stay registered
  // so existing typed routes keep working while planning migrates.
  const mediaProviders = new MediaProviderRegistry();
  mediaProviders.register(createSpotifyMediaProvider(adapter ?? {}));
  for (const provider of options.mediaProviders ?? []) mediaProviders.register(provider);
  registerMediaCapabilities(registry, mediaProviders);
  registry.mediaProviders = mediaProviders;

  return registry;
}
