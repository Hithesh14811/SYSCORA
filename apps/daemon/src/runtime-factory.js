import path from "node:path";
import {
  CapabilityRegistry,
  createDefaultCapabilityRegistry,
  CapabilityPluginLoader,
  createPluginSignatureVerifier,
  loadTrustedKeys
} from "../../../packages/capability-registry/src/index.js";
import { PolicyEngine } from "../../../packages/policy-engine/src/index.js";
import { RiskEngine } from "../../../packages/risk-engine/src/index.js";
import { AuditRepository } from "../../../packages/audit/src/index.js";
import { RecoveryEngine } from "../../../packages/recovery-engine/src/index.js";
import { TroubleshootingEngine } from "../../../packages/troubleshooting-engine/src/index.js";
import { AgentRuntime } from "../../../packages/agent-runtime/src/index.js";
import { SessionStore } from "../../../packages/agent-runtime/src/session-store.js";
import { PermissionBroker } from "../../../packages/permission-broker/src/index.js";
import { ApprovalTokenStore } from "../../../packages/permission-broker/src/approval-token-store.js";
import { CapabilityGrantStore } from "../../../packages/permission-broker/src/capability-grant-store.js";
import { DeveloperIntelligenceEngine } from "../../../packages/developer-intelligence/src/index.js";
import { WindowsAdapter } from "../../../os-adapters/windows/src/windows-adapter.js";
import { AndroidAdapter } from "../../../os-adapters/android/src/android-adapter.js";
import { SemanticState } from "../../../packages/semantic-state/src/index.js";
import { Memory } from "../../../packages/memory/src/index.js";
import { WindowsSecretBroker } from "../../../packages/secrets/src/index.js";
import { ReasoningEngine } from "../../../packages/reasoning-engine/src/index.js";
import { ConsentAwareModelProvider, createModelProviderChain } from "../../../packages/model-providers/src/index.js";
import { PrivilegedOperationHelper } from "../../../packages/privileged-helpers/src/index.js";
import { ElevationGrantStore, DEFAULT_ELEVATION_LIFETIME_MS, ELEVATION_SCOPE_ALL } from "../../../packages/permission-broker/src/elevation-grant-store.js";
import { ElevationService } from "../../../packages/permission-broker/src/elevation-service.js";
import { ElevatedHostClient } from "../../../os-adapters/windows-host/src/elevated-client.js";
import fsSync from "node:fs";
import { InstallationKeyStore } from "../../../packages/permission-broker/src/installation-key.js";
import { loadModelConfig } from "./model-config.js";
import { resolveStateDir, cloudSyncedRoot, assertNotContainerRedirected } from "../../../packages/shared-types/src/state-path.js";

/**
 * Elevation configuration, from .syscora/config.json (`elevation` block) with
 * environment overrides. Every switch defaults to the safe value: elevation
 * disabled, unattended elevation off.
 *
 *   "elevation": {
 *     "enabled": true,          // allow elevated operations at all
 *     "unattended": false,      // skip SYSCORA's own approval for admin work
 *     "lifetimeMinutes": 15,    // how long one elevated session lasts
 *     "operations": ["*"]       // which elevated operations the grant covers
 *   }
 */
export function loadElevationConfig(basePath = process.cwd()) {
  let file = {};
  try {
    const raw = fsSync.readFileSync(path.join(resolveStateDir(basePath), "config.json"), "utf8");
    file = JSON.parse(raw)?.elevation ?? {};
  } catch { /* absent or unreadable config means defaults */ }

  const enabled = process.env.SYSCORA_ELEVATION_ENABLED === "1"
    || (process.env.SYSCORA_ELEVATION_ENABLED !== "0" && file.enabled === true);
  const unattended = process.env.SYSCORA_ELEVATION_UNATTENDED === "1"
    || (process.env.SYSCORA_ELEVATION_UNATTENDED !== "0" && file.unattended === true);
  const minutes = Number(process.env.SYSCORA_ELEVATION_MINUTES ?? file.lifetimeMinutes);
  const lifetimeMs = Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_ELEVATION_LIFETIME_MS;
  const operations = Array.isArray(file.operations) && file.operations.length > 0
    ? file.operations
    : [ELEVATION_SCOPE_ALL];

  // Unattended elevation without elevation enabled is meaningless; treat it as
  // off rather than as an implicit enable.
  return { enabled, unattended: enabled && unattended, lifetimeMs, operations };
}

export function createRuntime(basePath = process.cwd()) {
  const stateDirectory = resolveStateDir(basePath);
  // Working state inside a cloud-synced folder is not a style problem. Measured
  // 21 Aug 2026: 2.07 GB of databases under a OneDrive-synced path, rewritten
  // every turn, holding OneDrive at ~24% of a core on an IDLE machine and far
  // more during turns — and the plaintext API keys were being uploaded with it.
  // The user asked this product twice why their machine felt slow; it answered
  // "OneDrive is syncing" both times and never asked what OneDrive was syncing.
  // Warn rather than relocate: moving someone's state uninvited is the same
  // shape as losing it. `scripts/migrate-state-dir.mjs` does the move on request.
  // A state directory that is secretly a link into another application's
  // container looks healthy from inside it and is unreachable from outside —
  // which is how 735 MB of the user's conversations ended up somewhere Notepad
  // could not write and an app reset would erase. Checked here, at the one
  // place the state directory is decided for the whole product.
  assertNotContainerRedirected(stateDirectory);
  const syncedRoot = cloudSyncedRoot(stateDirectory);
  if (syncedRoot) {
    process.emitWarning(
      `SYSCORA state lives at ${stateDirectory}, inside the synced folder ${syncedRoot}. `
      + "Every turn rewrites databases there and the sync client re-uploads them, continuously. "
      + "It also holds API keys in plaintext. Run `node scripts/migrate-state-dir.mjs` to move it."
    );
  }
  const auditRepository = new AuditRepository(path.join(stateDirectory, "audit"));
  const sessionStore = new SessionStore(path.join(stateDirectory, "sessions"));
  const approvalTokenStore = new ApprovalTokenStore(path.join(stateDirectory, "permission-broker"));
  const capabilityGrantStore = new CapabilityGrantStore(path.join(stateDirectory, "permission-broker"));
  const semanticState = new SemanticState(path.join(stateDirectory, "semantic-state"));
  const memory = new Memory(path.join(stateDirectory, "memory"));
  const adapter = new WindowsAdapter();
  // A separate, bounded ADB transport. It is only reached by `android.*`
  // capabilities; constructing it starts no process and changes no desktop
  // behavior. SYSCORA_ADB_PATH can point at a bundled Platform Tools binary.
  const androidAdapter = new AndroidAdapter();
  // The PermissionBroker is shared between the runtime (grant enforcement,
  // approval-token issuance) and the privileged helper (single-use token
  // consumption), so a token issued via /api/privileged/approve is the exact
  // token the privileged capability consumes during execution.
  // Per-installation key for cryptographic approval commitments (HMAC over
  // secret input values). Created once, 0600; enables commitment stability
  // across restart without persisting any plaintext secret.
  const installationKey = new InstallationKeyStore(path.join(stateDirectory, "permission-broker")).loadSync();
  // resolveCapabilityVersion binds the EXACT approved capability version into the
  // approval manifest, so a capability upgraded under the same name invalidates
  // a prior approval. Constructed after the registry below via a late setter.
  const permissionBroker = new PermissionBroker({
    approvalTokenStore,
    auditRepository,
    capabilityGrantStore,
    installationKey,
    resolveCapabilityVersion: (name) => capabilityRegistry?.get?.(name)?.version ?? null
  });
  // The privileged helper is the bounded, allow-listed execution boundary used by
  // the privileged capabilities. It shares the runtime's broker and adapter so
  // privileged operations run through the single canonical path — never a
  // separate route.
  //
  // Elevation is session-scoped: one UAC prompt per elevated session, a grant
  // with a hard expiry, and a high-integrity host that exits on its own
  // deadline. Unattended elevation (skipping SYSCORA's own approval question
  // for admin work) is OFF unless explicitly enabled in .syscora/config.json,
  // because it removes the last human checkpoint in front of irreversible
  // administrator actions.
  const elevationConfig = loadElevationConfig(basePath);
  const elevationGrantStore = new ElevationGrantStore(path.join(stateDirectory, "permission-broker"));
  const elevatedHost = elevationConfig.enabled
    ? new ElevatedHostClient({ lifetimeMs: elevationConfig.lifetimeMs })
    : null;
  const elevationService = new ElevationService({
    elevationGrantStore,
    elevatedHost,
    auditRepository,
    unattendedElevation: elevationConfig.unattended,
    defaultLifetimeMs: elevationConfig.lifetimeMs,
    allowedOperations: elevationConfig.operations
  });
  const privilegedHelper = new PrivilegedOperationHelper({
    permissionBroker,
    adapter,
    elevatedHost,
    elevationGrantStore,
    // Elevated execution is fail-closed on auditability: an elevated action
    // that cannot be recorded does not run.
    auditRepository
  });
  const capabilityRegistry = createDefaultCapabilityRegistry(adapter, { privilegedHelper, androidAdapter });
  const recoveryEngine = new RecoveryEngine();
  const troubleshootingEngine = new TroubleshootingEngine();
  const secretBroker = new WindowsSecretBroker(path.join(stateDirectory, "secrets"));

  // Provider selection is configuration-driven via loadModelConfig: env vars,
  // then a gitignored .syscora/config.json, then Mock. Default MVP setup points
  // `provider: "agentrouter"` at the AgentRouter gateway (one key, many models:
  // claude-opus-4-8 / gpt-5.5 / glm-5.2) — SYSCORA is not tied to any vendor.
  // Falls back to the deterministic Mock provider when no credentials are
  // present. The ReasoningEngine wraps it as
  // the single model boundary; every subsystem keeps a deterministic fallback.
  const modelConfig = loadModelConfig(basePath);
  const modelProvider = new ConsentAwareModelProvider({
    provider: createModelProviderChain(modelConfig),
    consentScopes: modelConfig.externalAIConsent.scopes,
    onProvenance: (record) => {
      auditRepository.append("external-ai", "EXTERNAL_AI_REQUEST", record).catch(() => {});
    }
  });
  const reasoningEngine = new ReasoningEngine({
    modelProvider,
    capabilityRegistry,
    minTimeoutMs: modelConfig.requestTimeoutMs
  });

  const runtime = new AgentRuntime({
    // So the skills store lands beside the audit log and the sessions, rather
    // than wherever node was started from. See the constructor.
    basePath,
    sessionStore,
    auditRepository,
    capabilityRegistry,
    // The RiskEngine reads the authoritative per-capability risk floor from the
    // registry; runtime context may only raise those dimensions.
    riskEngine: new RiskEngine({ capabilityRegistry }),
    // ELEVATE availability must reflect whether elevation can ACTUALLY happen,
    // not merely that a helper object was constructed. The helper always
    // exists; its elevated host is null whenever elevation is disabled in
    // config (the shipped default). Reporting ELEVATE as available in that
    // state still failed closed at execution, but it misled every upstream
    // policy and UI decision that asks "can this be elevated?" before trying.
    policyEngine: new PolicyEngine({
      controlAvailability: { ELEVATE: Boolean(privilegedHelper?.canElevate?.()) }
    }),
    permissionBroker,
    elevationService,
    recoveryEngine,
    troubleshootingEngine,
    adapter,
    modelProvider,
    reasoningEngine,
    secretBroker,
    semanticState,
    memory
  });
  runtime.setDeveloperIntelligence(new DeveloperIntelligenceEngine());
  return runtime;
}

/** Apply provider settings without restarting or rebuilding the runtime. */
export function reloadRuntimeModelProvider(runtime, basePath = process.cwd()) {
  const modelConfig = loadModelConfig(basePath);
  const modelProvider = new ConsentAwareModelProvider({
    provider: createModelProviderChain(modelConfig),
    consentScopes: modelConfig.externalAIConsent.scopes,
    onProvenance: (record) => {
      runtime?.auditRepository?.append?.("external-ai", "EXTERNAL_AI_REQUEST", record).catch?.(() => {});
    }
  });
  if (!runtime?.reasoningEngine) throw new Error("The runtime has no reasoning engine to reconfigure.");
  runtime.reasoningEngine.modelProvider = modelProvider;
  runtime.reasoningEngine.minTimeoutMs = Math.max(0, Number(modelConfig.requestTimeoutMs) || 0);
  runtime.reasoningEngine._liveFailures = 0;
  return {
    provider: modelConfig.provider,
    model: modelConfig.model ?? null,
    configured: Boolean(modelConfig.apiKey),
    remote: String(modelConfig.provider).toLowerCase() !== "mock",
    credentialStatus: modelConfig.credentialStatus,
    diagnostics: modelConfig.diagnostics
  };
}

// Opt-in capability plugin loading. Construction stays synchronous; a caller
// (daemon/CLI) invokes this explicitly after createRuntime(). Loading is fully
// wired end-to-end: discovery -> manifest validation -> runtime-version check ->
// fail-closed Ed25519 signature verification -> per-capability contract
// validation -> dependency resolution -> registration -> lifecycle events. It is
// a no-op unless SYSCORA_PLUGIN_DIR is set, so the default runtime ships with no
// unsigned/partial plugin surface.
//
// Returns { loaded: [...], skipped: boolean, reason?: string }.
export async function loadCapabilityPlugins(runtime, { pluginDir = process.env.SYSCORA_PLUGIN_DIR, env = process.env } = {}) {
  if (!pluginDir) return { loaded: [], skipped: true, reason: "SYSCORA_PLUGIN_DIR not set." };

  const trustedKeys = loadTrustedKeys(env);
  if (trustedKeys.length === 0) {
    // Fail closed: without an established trust anchor no plugin may load, even
    // though a directory was provided.
    return { loaded: [], skipped: true, reason: "No trusted plugin keys configured (SYSCORA_PLUGIN_TRUSTED_KEYS)." };
  }

  const loader = new CapabilityPluginLoader({
    registry: runtime.capabilityRegistry,
    runtimeVersion: runtime.capabilityRegistry.runtimeVersion,
    verifySignature: createPluginSignatureVerifier({ trustedKeys }),
    onEvent: (event) => {
      // Plugin lifecycle events are auditable like any other runtime event.
      runtime.auditRepository?.append?.("plugins", event.type, event).catch?.(() => {});
    }
  });

  const loaded = await loader.loadAll(path.resolve(pluginDir));
  return { loaded, skipped: false };
}
