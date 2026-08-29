import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { satisfiesVersion } from "./contract.js";
import { validateCapabilityPackage, validatePluginCapabilityDefinition, validatePluginManifest } from "./quality.js";
import { canonicalizePath, isCanonicalPathInside } from "../../shared-types/src/canonical-path.js";

const MANIFEST_FILE = "syscora-capability.json";

export class CapabilityPluginLoader {
  constructor({ registry, runtimeVersion = "0.1.0", verifySignature = null, onEvent = null } = {}) {
    if (!registry) throw new Error("CapabilityPluginLoader requires a capability registry");
    this.registry = registry;
    this.runtimeVersion = runtimeVersion;
    this.verifySignature = verifySignature;
    this.onEvent = onEvent;
    this.plugins = new Map();
  }

  async discover(rootDirectory) {
    const manifests = [];
    const visit = async (directory) => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) await visit(candidate);
        if (entry.isFile() && entry.name === MANIFEST_FILE) manifests.push(await this._readManifest(candidate));
      }
    };
    await visit(rootDirectory);
    return manifests;
  }

  async loadAll(rootDirectory) {
    const manifests = await this.discover(rootDirectory);
    const byId = new Map(manifests.map((item) => [item.manifest.pluginId, item]));
    const loaded = [];
    const visiting = new Set();
    const load = async (pluginId) => {
      if (this.plugins.has(pluginId)) return this.plugins.get(pluginId);
      if (visiting.has(pluginId)) throw new Error(`Plugin dependency cycle: ${pluginId}`);
      const item = byId.get(pluginId);
      if (!item) throw new Error(`Missing plugin dependency: ${pluginId}`);
      visiting.add(pluginId);
      for (const dependency of item.manifest.dependencies ?? []) {
        const id = typeof dependency === "string" ? dependency : dependency.pluginId;
        const target = byId.get(id)?.manifest;
        if (!target) throw new Error(`Missing plugin dependency: ${id}`);
        if (!satisfiesVersion(target.version, typeof dependency === "string" ? "*" : dependency.version ?? "*")) {
          throw new Error(`Plugin dependency ${id} does not satisfy required version`);
        }
        await load(id);
      }
      visiting.delete(pluginId);
      const result = await this.load(item.path);
      loaded.push(result);
      return result;
    };
    for (const item of manifests) await load(item.manifest.pluginId);
    return loaded;
  }

  async load(manifestPath) {
    const item = await this._readManifest(manifestPath);
    const { manifest, directory } = item;
    if (this.plugins.has(manifest.pluginId)) return this.plugins.get(manifest.pluginId);
    const validation = validatePluginManifest(manifest);
    if (!validation.valid) throw new Error(`Invalid capability plugin manifest: ${validation.errors.join("; ")}`);
    if (!satisfiesVersion(this.runtimeVersion, manifest.runtimeVersion)) {
      throw new Error(`Plugin ${manifest.pluginId} requires runtime ${manifest.runtimeVersion}`);
    }
    await this._verifySignature(manifest, directory);
    const entryPath = path.resolve(directory, manifest.entry);
    if (!isCanonicalPathInside(entryPath, directory)) {
      throw new Error("Plugin entry must remain inside the canonical plugin directory");
    }
    const entryStat = await fs.stat(canonicalizePath(entryPath));
    if (!entryStat.isFile()) throw new Error("Plugin entry must be a regular file");
    const module = await import(`${pathToFileURL(entryPath).href}?plugin=${encodeURIComponent(manifest.version)}-${Date.now()}`);
    const capabilities = module.capabilities ?? [];
    if (!Array.isArray(capabilities)) throw new Error("Plugin capabilities export must be an array");
    const selfRegisters = typeof module.registerCapabilities === "function";
    if (!selfRegisters) {
      const packageValidation = validateCapabilityPackage({ manifest, capabilities });
      if (!packageValidation.valid) throw new Error(`Invalid capability plugin ${manifest.pluginId}: ${packageValidation.errors.join("; ")}`);
    }

    const registered = [];
    const scopedRegistry = {
      register: (capability) => {
        const definitionValidation = validatePluginCapabilityDefinition(capability);
        if (!definitionValidation.valid) throw new Error(`Invalid plugin capability ${capability?.name ?? "unknown"}: ${definitionValidation.errors.join("; ")}`);
        if (!manifest.capabilities.includes(capability.name)) {
          throw new Error(`Plugin capability ${capability.name} is not declared in manifest.capabilities`);
        }
        const result = this.registry.register(capability, { source: manifest.pluginId, strict: true });
        registered.push(result.name);
        return result;
      }
    };
    try {
      if (typeof module.registerCapabilities === "function") await module.registerCapabilities(scopedRegistry, { manifest });
      else for (const capability of capabilities) scopedRegistry.register(capability);
    } catch (error) {
      for (const capabilityId of registered) this.registry.unregister(capabilityId, { source: manifest.pluginId });
      throw error;
    }
    const missing = manifest.capabilities.filter((capabilityId) => !registered.includes(capabilityId));
    if (missing.length > 0) {
      for (const capabilityId of registered) this.registry.unregister(capabilityId, { source: manifest.pluginId });
      throw new Error(`Plugin ${manifest.pluginId} did not register declared capabilities: ${missing.join(", ")}`);
    }
    const result = { pluginId: manifest.pluginId, version: manifest.version, capabilities: registered, manifestPath };
    this.plugins.set(manifest.pluginId, result);
    this._emit("CAPABILITY_PLUGIN_LOADED", result);
    return result;
  }

  unload(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    for (const capabilityId of plugin.capabilities) this.registry.unregister(capabilityId, { source: pluginId });
    this.plugins.delete(pluginId);
    this._emit("CAPABILITY_PLUGIN_UNLOADED", { pluginId, capabilities: plugin.capabilities });
    return true;
  }

  async _readManifest(manifestPath) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return { manifest, path: manifestPath, directory: path.dirname(manifestPath) };
  }

  async _verifySignature(manifest, directory) {
    if (!manifest.signature) throw new Error(`Plugin ${manifest.pluginId} is unsigned`);
    if (typeof this.verifySignature !== "function") throw new Error(`No signature verifier configured for plugin ${manifest.pluginId}`);
    const canonical = JSON.stringify({ ...manifest, signature: undefined });
    const digest = crypto.createHash("sha256").update(canonical).digest("hex");
    const trusted = await this.verifySignature({ manifest, directory, digest, signature: manifest.signature });
    if (!trusted) throw new Error(`Plugin ${manifest.pluginId} signature verification failed`);
  }

  _emit(type, payload) {
    const event = { type, timestamp: new Date().toISOString(), ...payload };
    this.registry.emit(type, event);
    this.onEvent?.(event);
  }
}

export { MANIFEST_FILE };
