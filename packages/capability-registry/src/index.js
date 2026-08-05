import { RiskLevel } from "../../shared-types/src/domain.js";
import { ExecutionModality, modalityProfile, validateInteractionTarget } from "../../shared-types/src/execution.js";
import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import { PRIVILEGED_OPERATIONS } from "../../privileged-helpers/src/index.js";
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
      return {
        status: started ? "VERIFIED" : "FAILED",
        message: started ? `Launched and grounded ${result.application}` : `Could not ground a window for ${result.application}`,
        evidence: { window: result.window ?? null, windowIdentity: result.windowIdentity ?? null, grounding: result.grounding ?? null },
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

  const registerM4Primitive = ({
    name, description, inputSchema, execute, modality = ExecutionModality.OS_API, modalities = null,
    risk = RiskLevel.LOW, permissionType = "READ", verify = null,
    resources = [], detectedChanges = []
  }) => registry.register({
    name,
    version: "1.0.0",
    description,
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
      detectedChanges: result?.performed === false ? [] : detectedChanges,
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
    execute: async (args) => adapter.locateVisualTarget(args),
    modality: ExecutionModality.VISION_GUI, resources: ["desktop"]
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
  registerM4Primitive({
    name: "pointer.wheel",
    description: "Scroll the wheel in an identified application window",
    inputSchema: { type: "object", properties: { delta: { type: "number" }, windowId: { type: "string" }, application: { type: "string" } }, required: ["delta"] },
    execute: async (args) => adapter.pointerAction("wheel", args),
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
  registerM4Primitive({
    name: "keyboard.type",
    description: "Type bounded text into the current focused control",
    inputSchema: { type: "object", properties: { text: { type: "string" }, windowId: { type: "string" }, application: { type: "string" } }, required: ["text"] },
    execute: async (args) => adapter.keyboardAction("type", args),
    modality: ExecutionModality.UI_AUTOMATION, permissionType: "WRITE", resources: ["desktop"], detectedChanges: ["application.ui"]
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
      network: ["launch", "navigate", "playMedia", "research"].includes(operation) ? "OUTBOUND" : "NONE",
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
    operation: "playMedia", permissionType: "WRITE", risk: RiskLevel.MEDIUM,
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
    permissionModel: { scope: ["SESSION"], type: "WRITE" },
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
    description: "Inspect git repository state",
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
      return {
        status: valid ? "VERIFIED" : "FAILED",
        message: valid
          ? (result.isRepository ? "Git repository state inspected." : "Workspace is not a Git repository.")
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

  return registry;
}
