import { RiskLevel } from "../../shared-types/src/domain.js";
import { redactSensitiveData } from "../../shared-types/src/redaction.js";
import crypto from "crypto";
import {
  CAPABILITY_CONTRACT_VERSION,
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

export const LifecycleStatus = {
  IMPLEMENTED: "IMPLEMENTED",
  VERIFIED: "VERIFIED",
  EXPERIMENTAL: "EXPERIMENTAL",
  UNAVAILABLE: "UNAVAILABLE"
};

export class CapabilityRegistry {
  constructor(capabilities = [], { runtimeVersion, onEvent } = {}) {
    this.capabilities = new Map();
    this.runtimeVersion = runtimeVersion ?? "0.1.0";
    this.listeners = new Set();
    if (onEvent) this.listeners.add(onEvent);
    this.pipeline = new CapabilityLifecyclePipeline({ registry: this, onEvent: (event) => this.emit(event.type, event) });
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
    const validation = validateCapabilityContract(normalized, { strict: options.strict === true });
    if (!validation.valid) throw new Error(`Invalid capability ${normalized.name ?? "unknown"}: ${validation.errors.join("; ")}`);
    if (!satisfiesVersion(this.runtimeVersion, normalized.packaging.runtimeVersion)) {
      throw new Error(`Capability ${normalized.name} requires runtime ${normalized.packaging.runtimeVersion}`);
    }
    if (this.capabilities.has(normalized.name)) throw new Error(`Duplicate capability registration: ${normalized.name}`);
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

  isAvailable(name, context = {}, visited = new Set()) {
    const capability = this.get(name);
    if (!capability || visited.has(name) || !isCapabilityHealthy(capability, context)) return false;
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
      capabilityId: cap.capabilityId,
      contractVersion: cap.contractVersion,
      version: cap.version,
      category: cap.category,
      description: cap.description,
      owner: cap.owner,
      inputSchema: cap.inputSchema,
      outputSchema: cap.outputSchema,
      risk: cap.risk,
      requirements: cap.requirements,
      security: cap.security,
      reversibility: cap.reversibility,
      rollbackSupport: cap.rollbackSupport,
      lifecycle: cap.lifecycle,
      lifecycleStatus: cap.lifecycleStatus,
      health: cap.health,
      documentation: cap.documentation,
      deprecation: cap.deprecation,
      packaging: cap.packaging
    }));
  }
}

export { CAPABILITY_CONTRACT_VERSION, CapabilityHealth, CapabilityLifecyclePipeline, validateCapabilityContract };

export function createDefaultCapabilityRegistry(adapter, options = {}) {
  const registry = new CapabilityRegistry();
  // Optional privileged-operation boundary. When provided (production wiring),
  // the privileged capabilities below become executable through the canonical
  // runtime: each consumes a single-use approval token and dispatches to the
  // bounded, allow-listed helper — never a shell. When absent (lightweight/test
  // wiring), the privileged capabilities are still registered but marked
  // UNAVAILABLE so the planner/validator will not select them.
  const privilegedHelper = options.privilegedHelper ?? null;

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
    preconditions: (args) => typeof args.port === "number",
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
      return { 
        status: "VERIFIED", 
        message: "Port inspection complete",
        evidence: observation.structuredState,
        confidence: 1
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
    riskMetadata: { level: RiskLevel.MEDIUM },
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
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "Git repository inspection complete",
      evidence: observation.structuredState,
      confidence: 1
    }),
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
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "Docker environment inspection complete",
      evidence: observation.structuredState,
      confidence: 1
    }),
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
    verify: async (observation) => ({
      status: "VERIFIED",
      message: "Package manager inspection complete",
      evidence: observation.structuredState,
      confidence: 1
    }),
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
    permissions: ["browser:launch"],
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
