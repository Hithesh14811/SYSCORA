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
import { SemanticState } from "../../../packages/semantic-state/src/index.js";
import { Memory } from "../../../packages/memory/src/index.js";
import { WindowsSecretBroker } from "../../../packages/secrets/src/index.js";
import { ReasoningEngine } from "../../../packages/reasoning-engine/src/index.js";
import { ConsentAwareModelProvider, createModelProviderChain } from "../../../packages/model-providers/src/index.js";
import { PrivilegedOperationHelper } from "../../../packages/privileged-helpers/src/index.js";
import { InstallationKeyStore } from "../../../packages/permission-broker/src/installation-key.js";
import { loadModelConfig } from "./model-config.js";

export function createRuntime(basePath = process.cwd()) {
  const stateDirectory = path.join(basePath, ".syscora");
  const auditRepository = new AuditRepository(path.join(stateDirectory, "audit"));
  const sessionStore = new SessionStore(path.join(stateDirectory, "sessions"));
  const approvalTokenStore = new ApprovalTokenStore(path.join(stateDirectory, "permission-broker"));
  const capabilityGrantStore = new CapabilityGrantStore(path.join(stateDirectory, "permission-broker"));
  const semanticState = new SemanticState(path.join(stateDirectory, "semantic-state"));
  const memory = new Memory(path.join(stateDirectory, "memory"));
  const adapter = new WindowsAdapter();
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
  const privilegedHelper = new PrivilegedOperationHelper({ permissionBroker, adapter });
  const capabilityRegistry = createDefaultCapabilityRegistry(adapter, { privilegedHelper });
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
  const reasoningEngine = new ReasoningEngine({ modelProvider, capabilityRegistry });

  const runtime = new AgentRuntime({
    sessionStore,
    auditRepository,
    capabilityRegistry,
    // The RiskEngine reads the authoritative per-capability risk floor from the
    // registry; runtime context may only raise those dimensions.
    riskEngine: new RiskEngine({ capabilityRegistry }),
    // ELEVATE is a wired control here because the privileged helper + approval
    // token flow exists. Without a helper it would stay unavailable and any
    // privileged operation would fail closed (never silently downgraded).
    policyEngine: new PolicyEngine({
      controlAvailability: { ELEVATE: Boolean(privilegedHelper) }
    }),
    permissionBroker,
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
