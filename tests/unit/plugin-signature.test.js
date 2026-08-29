import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  CapabilityRegistry,
  CapabilityPluginLoader,
  createPluginSignatureVerifier
} from "../../packages/capability-registry/src/index.js";

// Build the digest the loader signs: sha256 of canonical JSON with signature
// removed. Mirrors CapabilityPluginLoader._verifySignature.
function digestForManifest(manifest) {
  const canonical = JSON.stringify({ ...manifest, signature: undefined });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const PLUGIN_ENTRY = `
  export const capabilities = [{
    name: "plugin.signed.echo", version: "1.0.0", category: "test", description: "Echo", owner: "test",
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    requirements: { permissions: [], elevation: "NONE", operatingSystems: ["win32"], software: [], capabilities: [], optionalCapabilities: [], alternativeCapabilities: [], conflicts: [], executionModes: ["runtime"] },
    risk: { level: "LOW", policyRequirements: [] },
    security: { filesystem: "NONE", registry: "NONE", network: "NONE", browser: "NONE", clipboard: "NONE", windowAutomation: "NONE", externalProcesses: "NONE" },
    stateMutations: [], preconditions: () => true, execute: async (input) => input,
    observe: async (result) => ({ structuredState: result }), verify: async () => ({ status: "VERIFIED" }),
    failureClassifications: [], recoveryHints: [], semanticUpdates: [], memoryUpdates: [], auditEvents: [],
    performance: { timeoutMs: 1000, cancellation: true, resourceLimits: {}, temporaryWorkspace: true },
    retryPolicy: { maxAttempts: 1, backoffMs: 0 }, health: { status: "HEALTHY" },
    documentation: { summary: "Signed echo test capability", examples: [] },
    packaging: { runtimeVersion: ">=0.1.0", manifestVersion: "1", tests: ["test/echo.test.js"] }
  }];
`;

async function writePlugin(root, { signature }) {
  const dir = path.join(root, "signed-plugin");
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    manifestVersion: "1",
    pluginId: "test.signed-plugin",
    version: "1.0.0",
    runtimeVersion: ">=0.1.0",
    entry: "index.js",
    capabilities: ["plugin.signed.echo"],
    dependencies: [],
    signature
  };
  await fs.writeFile(path.join(dir, "syscora-capability.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, "index.js"), PLUGIN_ENTRY);
  return { dir, manifest };
}

test("a plugin signed by a trusted Ed25519 key loads end-to-end", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-signed-"));
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    // First write with a placeholder signature to compute the exact manifest the
    // loader will hash, then sign that digest.
    const staged = await writePlugin(root, { signature: "PLACEHOLDER" });
    const digest = digestForManifest(staged.manifest);
    const signature = crypto.sign(null, Buffer.from(digest, "utf8"), privateKey).toString("base64");
    // Rewrite the manifest carrying the real signature (the loader strips the
    // signature field before hashing, so the digest is unchanged).
    await fs.writeFile(
      path.join(staged.dir, "syscora-capability.json"),
      JSON.stringify({ ...staged.manifest, signature })
    );

    const registry = new CapabilityRegistry();
    const verifier = createPluginSignatureVerifier({ trustedKeys: [publicKey] });
    const loader = new CapabilityPluginLoader({ registry, verifySignature: verifier });

    const loaded = await loader.loadAll(root);
    assert.equal(loaded.length, 1);
    assert.equal(registry.has("plugin.signed.echo"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a plugin signed by an untrusted key is rejected (fail-closed)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-untrusted-"));
  try {
    const attacker = crypto.generateKeyPairSync("ed25519");
    const trusted = crypto.generateKeyPairSync("ed25519");

    const staged = await writePlugin(root, { signature: "PLACEHOLDER" });
    const digest = digestForManifest(staged.manifest);
    const signature = crypto.sign(null, Buffer.from(digest, "utf8"), attacker.privateKey).toString("base64");
    await fs.writeFile(
      path.join(staged.dir, "syscora-capability.json"),
      JSON.stringify({ ...staged.manifest, signature })
    );

    const registry = new CapabilityRegistry();
    // Only the trusted key is configured; the attacker's signature must not verify.
    const verifier = createPluginSignatureVerifier({ trustedKeys: [trusted.publicKey] });
    const loader = new CapabilityPluginLoader({ registry, verifySignature: verifier });

    await assert.rejects(loader.loadAll(root), /signature verification failed/);
    assert.equal(registry.has("plugin.signed.echo"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("no trusted keys configured means no plugin can verify", async () => {
  const verifier = createPluginSignatureVerifier({ trustedKeys: [] });
  const ok = await verifier({ digest: "abc", signature: Buffer.from("x").toString("base64") });
  assert.equal(ok, false);
});

test("a signed manifest cannot load an entry through a junction outside its plugin directory", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-plugin-boundary-"));
  try {
    const pluginDirectory = path.join(root, "plugin");
    const outside = path.join(root, "outside");
    await fs.mkdir(pluginDirectory, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "index.js"), PLUGIN_ENTRY);
    await fs.symlink(outside, path.join(pluginDirectory, "linked"), "junction");

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const manifest = {
      manifestVersion: "1",
      pluginId: "test.boundary",
      version: "1.0.0",
      runtimeVersion: ">=0.1.0",
      entry: "linked/index.js",
      capabilities: ["plugin.signed.echo"],
      dependencies: [],
      signature: "PLACEHOLDER"
    };
    const signature = crypto.sign(null, Buffer.from(digestForManifest(manifest), "utf8"), privateKey).toString("base64");
    const manifestPath = path.join(pluginDirectory, "syscora-capability.json");
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, signature }));

    const loader = new CapabilityPluginLoader({
      registry: new CapabilityRegistry(),
      verifySignature: createPluginSignatureVerifier({ trustedKeys: [publicKey] })
    });
    await assert.rejects(loader.load(manifestPath), /canonical plugin directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
