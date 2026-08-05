import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CAPABILITY_CONTRACT_VERSION,
  CapabilityHealth,
  CapabilityPluginLoader,
  CapabilityRegistry,
  CapabilityLifecyclePipeline,
  createCapabilityTemplate,
  createDefaultCapabilityRegistry,
  validatePluginCapabilityDefinition,
  validateCapabilityContract
} from "../../packages/capability-registry/src/index.js";

function capability(overrides = {}) {
  return {
    name: "test.capability",
    version: "1.0.0",
    description: "A deterministic test capability",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    riskMetadata: { level: "LOW" },
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({}),
    observe: async () => ({}),
    verify: async () => ({ status: "VERIFIED" }),
    lifecycleStatus: "VERIFIED",
    ...overrides
  };
}

test("registry normalizes legacy capabilities to the V2 contract", () => {
  const registry = new CapabilityRegistry([capability()]);
  const registered = registry.get("test.capability");
  assert.equal(registered.contractVersion, CAPABILITY_CONTRACT_VERSION);
  assert.equal(registered.capabilityId, "test.capability");
  assert.equal(registered.health.status, CapabilityHealth.HEALTHY);
  assert.deepEqual(registered.requirements.permissions, []);
  for (const field of [
    "postconditionSchema", "confirmationPolicy", "idempotency", "dataSensitivity",
    "networkConstraints", "identities", "trustedExecutionModality", "availability"
  ]) assert.ok(field in registered, `missing canonical field ${field}`);
  assert.equal(validateCapabilityContract(registered).valid, true);
});

test("catalog contains only serializable live contract metadata", async () => {
  const registry = new CapabilityRegistry([
    capability({ name: "live", availabilityCheck: async () => ({ available: true }) }),
    capability({ name: "missing", availabilityCheck: async () => ({ available: false, reason: "not installed" }) })
  ]);
  const refreshed = await registry.refreshAvailability({ platform: process.platform });
  assert.equal(refreshed.find((entry) => entry.name === "missing").available, false);
  const catalog = registry.getCatalog();
  assert.deepEqual(catalog.map((entry) => entry.name), ["live"]);
  assert.doesNotThrow(() => JSON.stringify(catalog));
  assert.equal(catalog[0].health.status, CapabilityHealth.HEALTHY);
  assert.equal("check" in catalog[0].health, false);
  assert.equal("check" in catalog[0].availability, false);
});

test("registry rejects ambiguous alias declarations", () => {
  const registry = new CapabilityRegistry([
    capability({ name: "keyboard.type", aliases: ["ui.type_text"] })
  ]);
  assert.throws(
    () => registry.register(capability({ name: "legacy.type", aliases: ["ui-type-text"] })),
    /alias collision/i
  );
});

test("execution preparation rechecks live availability and fails typed", async () => {
  const registry = new CapabilityRegistry([
    capability({ name: "temporarily.missing", availabilityCheck: async () => ({ available: false, reason: "dependency missing" }) })
  ]);
  const pipeline = new CapabilityLifecyclePipeline({ registry });
  await assert.rejects(
    pipeline.prepare({ taskId: "t1", capability: "temporarily.missing", inputs: {} }),
    (error) => error.code === "CAPABILITY_UNAVAILABLE" && /dependency missing/.test(error.message)
  );
});

test("catalog ignores disabled and unresolved dependency capabilities", () => {
  const registry = new CapabilityRegistry([
    capability({ name: "dependency", health: { status: CapabilityHealth.DISABLED } }),
    capability({ name: "dependent", requirements: { capabilities: ["dependency"] } }),
    capability({ name: "healthy" })
  ]);
  assert.deepEqual(registry.getCatalog().map((item) => item.name), ["healthy"]);
});

test("registry resolves ordered dependencies and rejects duplicate ids", () => {
  const registry = new CapabilityRegistry([
    capability({ name: "base" }),
    capability({ name: "feature", requirements: { capabilities: [{ capability: "base", version: ">=1.0.0" }] } })
  ]);
  assert.deepEqual(registry.resolveDependencies("feature"), ["base", "feature"]);
  assert.throws(() => registry.register(capability({ name: "base" })), /Duplicate capability/);
});

test("all built-in capabilities are contract-compatible reference capabilities", () => {
  const registry = createDefaultCapabilityRegistry({});
  for (const registered of registry.list()) {
    const validation = validateCapabilityContract(registered, { strict: true });
    assert.equal(validation.valid, true, `${registered.name}: ${validation.errors.join(", ")}`);
    assert.equal(registered.packaging.source, "builtin");
  }
});

test("signed plugins are discovered, registered, and safely unloaded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-plugin-"));
  const pluginDirectory = path.join(root, "echo-plugin");
  await fs.mkdir(pluginDirectory);
  await fs.writeFile(path.join(pluginDirectory, "syscora-capability.json"), JSON.stringify({
    manifestVersion: "1",
    pluginId: "test.echo-plugin",
    version: "1.0.0",
    runtimeVersion: ">=0.1.0",
    entry: "index.js",
    capabilities: ["plugin.echo"],
    dependencies: [],
    signature: "trusted-test-signature"
  }));
  await fs.writeFile(path.join(pluginDirectory, "index.js"), `
    export const capabilities = [{
      name: "plugin.echo", version: "1.0.0", category: "test", description: "Echo", owner: "test",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      requirements: { permissions: [], elevation: "NONE", operatingSystems: ["win32"], software: [], capabilities: [], optionalCapabilities: [], alternativeCapabilities: [], conflicts: [], executionModes: ["runtime"] },
      risk: { level: "LOW", policyRequirements: [] },
      security: { filesystem: "NONE", registry: "NONE", network: "NONE", browser: "NONE", clipboard: "NONE", windowAutomation: "NONE", externalProcesses: "NONE" },
      stateMutations: [], preconditions: () => true, execute: async (input) => input,
      observe: async (result) => ({ structuredState: result }), verify: async () => ({ status: "VERIFIED" }),
      failureClassifications: [], recoveryHints: [], semanticUpdates: [], memoryUpdates: [], auditEvents: [],
      performance: { timeoutMs: 1000, cancellation: true, resourceLimits: {}, temporaryWorkspace: true },
      retryPolicy: { maxAttempts: 1, backoffMs: 0 }, health: { status: "HEALTHY" },
      documentation: { summary: "Echo test capability", examples: [] },
      packaging: { runtimeVersion: ">=0.1.0", manifestVersion: "1", tests: ["test/echo.test.js"] }
    }];
  `);
  try {
    const registry = new CapabilityRegistry();
    const loader = new CapabilityPluginLoader({ registry, verifySignature: async () => true });
    const discovered = await loader.discover(root);
    assert.equal(discovered.length, 1);
    const loaded = await loader.loadAll(root);
    assert.equal(loaded[0].capabilities[0], "plugin.echo");
    assert.equal(registry.get("plugin.echo").packaging.source, "test.echo-plugin");
    assert.equal(loader.unload("test.echo-plugin"), true);
    assert.equal(registry.has("plugin.echo"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unsigned plugins are rejected and the template passes plugin quality validation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-unsigned-plugin-"));
  try {
    const manifestPath = path.join(root, "syscora-capability.json");
    await fs.writeFile(manifestPath, JSON.stringify({
      manifestVersion: "1", pluginId: "unsigned", version: "1.0.0", runtimeVersion: ">=0.1.0", entry: "index.js", capabilities: []
    }));
    const loader = new CapabilityPluginLoader({ registry: new CapabilityRegistry(), verifySignature: async () => true });
    await assert.rejects(loader.load(manifestPath), /unsigned/);
    assert.equal(validatePluginCapabilityDefinition(createCapabilityTemplate()).valid, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
