// Perception providers.
//
// A provider turns one slice of raw Windows information into a normalized set of
// semantic entities and relationships. Providers are strictly read-only — they
// observe, never modify. Each implements the same interface so the
// PerceptionEngine can treat them uniformly:
//
//   collect()          -> raw data from the adapter (async)
//   normalize(raw)     -> { entities, relationships } (pure, deterministic)
//   confidence()       -> 0..1 trust in this provider's output
//   freshness()        -> "current" | "cached" | "stale"
//   cost()             -> relative collection cost (for scheduling/budgeting)
//   supportedEntities()-> entity types this provider can produce
//
// normalize() is deterministic and pure so it can be unit-tested with fixtures
// (no live system access required).

import {
  EntityType,
  RelationshipType,
  makeEntity,
  makeRelationship,
  entityId,
  normalizePath
} from "./entities.js";
import { VisionProvider } from "./vision-provider.js";

class PerceptionProvider {
  constructor(name, adapter, { cost = 1, confidence = 1.0 } = {}) {
    this.name = name;
    this.adapter = adapter;
    this._cost = cost;
    this._confidence = confidence;
  }
  async collect() { throw new Error("not implemented"); }
  normalize() { throw new Error("not implemented"); }
  confidence() { return this._confidence; }
  freshness() { return "current"; }
  cost() { return this._cost; }
  supportedEntities() { return []; }

  // Convenience: collect + normalize in one call.
  async perceive(request = {}, now = new Date().toISOString()) {
    const raw = await this.collect(request);
    return this.normalize(raw, { now, request });
  }
}

export class SystemProvider extends PerceptionProvider {
  constructor(adapter) { super("system", adapter, { cost: 1 }); }
  supportedEntities() {
    return [EntityType.Computer, EntityType.OperatingSystem, EntityType.CPU, EntityType.Memory, EntityType.User];
  }
  async collect() { return this.adapter.getSystemInformation?.() ?? null; }
  normalize(data, { now } = {}) {
    if (!data) return { entities: [], relationships: [] };
    const host = data.hostname || "unknown-host";
    const entities = [];
    const relationships = [];

    const computer = makeEntity(EntityType.Computer, [host], {
      hostname: data.hostname,
      platform: data.platform,
      release: data.release,
      architecture: data.architecture
    }, { now, provenance: "perception:system" });
    entities.push(computer);

    const os = makeEntity(EntityType.OperatingSystem, [host], {
      caption: data.windowsDetails?.caption,
      version: data.windowsDetails?.version,
      build: data.windowsDetails?.build,
      release: data.release
    }, { now, provenance: "perception:system" });
    entities.push(os);
    relationships.push(makeRelationship(computer.id, RelationshipType.RUNS, os.id, {}, { now }));

    const cpu = makeEntity(EntityType.CPU, [host, data.windowsDetails?.cpuName || "cpu"], {
      name: data.windowsDetails?.cpuName,
      cores: data.windowsDetails?.cpuCores,
      logical: data.windowsDetails?.cpuLogical ?? data.cpus
    }, { now, provenance: "perception:system" });
    entities.push(cpu);
    relationships.push(makeRelationship(computer.id, RelationshipType.CONTAINS, cpu.id, {}, { now }));

    const memory = makeEntity(EntityType.Memory, [host], {
      totalMemory: data.totalMemory ?? data.windowsDetails?.totalMemory,
      freeMemory: data.freeMemory
    }, { now, provenance: "perception:system" });
    entities.push(memory);
    relationships.push(makeRelationship(computer.id, RelationshipType.CONTAINS, memory.id, {}, { now }));

    if (data.username) {
      const user = makeEntity(EntityType.User, [data.username], { username: data.username }, { now, provenance: "perception:system" });
      entities.push(user);
      relationships.push(makeRelationship(user.id, RelationshipType.BELONGS_TO, computer.id, {}, { now }));
    }

    return { entities, relationships };
  }
}

export class ProcessProvider extends PerceptionProvider {
  constructor(adapter) { super("process", adapter, { cost: 2 }); }
  supportedEntities() { return [EntityType.Process, EntityType.Executable]; }
  async collect() { return this.adapter.listProcesses?.() ?? []; }
  normalize(list, { now } = {}) {
    if (!Array.isArray(list)) return { entities: [], relationships: [] };
    const entities = [];
    const relationships = [];
    for (const proc of list) {
      if (!proc) continue;
      const exePath = proc.Path ? normalizePath(proc.Path) : null;
      // Executable is keyed by path (stable); process is keyed by executable+pid.
      // When a process restarts with a new PID, the Executable entity is reused
      // and only a new Process entity + RUNS/EXECUTES relationship appear.
      let exeId = null;
      if (exePath) {
        const exe = makeEntity(EntityType.Executable, [exePath], {
          path: proc.Path,
          name: proc.ProcessName
        }, { now, provenance: "perception:process" });
        entities.push(exe);
        exeId = exe.id;
      }
      const key = exePath ? [proc.ProcessName, proc.Id] : [proc.ProcessName, proc.Id ?? "unknown"];
      const process = makeEntity(EntityType.Process, key, {
        pid: proc.Id,
        name: proc.ProcessName,
        cpu: proc.CPU,
        workingSet: proc.WorkingSet64,
        path: proc.Path ?? null
      }, { now, provenance: "perception:process" });
      entities.push(process);
      if (exeId) {
        relationships.push(makeRelationship(process.id, RelationshipType.EXECUTES, exeId, {}, { now }));
      }
    }
    return { entities, relationships };
  }
}

export class ServiceProvider extends PerceptionProvider {
  constructor(adapter) { super("service", adapter, { cost: 1 }); }
  supportedEntities() { return [EntityType.Service]; }
  async collect() { return this.adapter.listServices?.() ?? []; }
  normalize(list, { now } = {}) {
    if (!Array.isArray(list)) return { entities: [], relationships: [] };
    const entities = [];
    for (const svc of list) {
      if (!svc || !svc.Name) continue;
      entities.push(makeEntity(EntityType.Service, [svc.Name], {
        name: svc.Name,
        displayName: svc.DisplayName,
        status: svc.Status,
        startType: svc.StartType
      }, { now, provenance: "perception:service" }));
    }
    return { entities, relationships: [] };
  }
}

export class EnvironmentProvider extends PerceptionProvider {
  constructor(adapter) { super("environment", adapter, { cost: 1 }); }
  supportedEntities() { return [EntityType.EnvironmentVariable, EntityType.PathEntry]; }
  async collect() {
    const userPath = await this.adapter.getUserPath?.();
    return { userPath };
  }
  // splitPath mirrors the adapter's normalization so PATH entities line up with
  // what the PATH capabilities actually write.
  _split(value) {
    if (!value) return [];
    return String(value).split(";").map((s) => s.trim().replace(/[\\/]+$/g, "")).filter(Boolean);
  }
  normalize(data, { now } = {}) {
    const entities = [];
    const relationships = [];
    const value = data?.userPath?.value;
    const scope = data?.userPath?.scope || "User";
    if (value) {
      // The PATH variable itself is one EnvironmentVariable entity.
      const pathVar = makeEntity(EntityType.EnvironmentVariable, [scope, "Path"], {
        key: "Path", value, scope
      }, { now, provenance: "perception:environment" });
      entities.push(pathVar);

      const entries = this._split(value);
      let index = 0;
      for (const entry of entries) {
        // PathEntry keyed by scope + normalized path -> stable across re-scans,
        // so re-perceiving the same PATH never creates duplicates.
        const pe = makeEntity(EntityType.PathEntry, [scope, normalizePath(entry)], {
          path: entry, scope, index
        }, { now, provenance: "perception:environment" });
        entities.push(pe);
        relationships.push(makeRelationship(pathVar.id, RelationshipType.CONTAINS, pe.id, { index }, { now }));
        index += 1;
      }
    }
    return { entities, relationships };
  }
}

export class FilesystemProvider extends PerceptionProvider {
  constructor(adapter) { super("filesystem", adapter, { cost: 3 }); }
  supportedEntities() { return [EntityType.Directory, EntityType.File]; }
  async collect(request = {}) {
    const dir = request.workspacePath ?? request.directoryPath;
    if (!dir) return { directory: null };
    const exists = await this.adapter.verifyDirectoryExists?.(dir);
    return { directory: dir, exists };
  }
  normalize(data, { now } = {}) {
    const entities = [];
    if (data?.directory && data.exists?.exists) {
      entities.push(makeEntity(EntityType.Directory, [normalizePath(data.directory)], {
        path: data.directory,
        exists: true
      }, { now, provenance: "perception:filesystem" }));
    }
    return { entities, relationships: [] };
  }
}

export class DeveloperProvider extends PerceptionProvider {
  constructor(adapter, developerIntelligence) {
    super("developer", adapter, { cost: 3 });
    this.developerIntelligence = developerIntelligence;
  }
  supportedEntities() {
    return [EntityType.Project, EntityType.Workspace, EntityType.Runtime, EntityType.PackageManager, EntityType.Repository];
  }
  async collect(request = {}) {
    const workspacePath = request.workspacePath;
    if (!workspacePath || !this.developerIntelligence) return { workspacePath: workspacePath ?? null, profile: null };
    const profile = await this.developerIntelligence.detectProject(workspacePath);
    return { workspacePath, profile };
  }
  normalize(data, { now } = {}) {
    const entities = [];
    const relationships = [];
    if (!data?.workspacePath) return { entities, relationships };
    const wsPath = normalizePath(data.workspacePath);
    const workspace = makeEntity(EntityType.Workspace, [wsPath], { path: data.workspacePath }, { now, provenance: "perception:developer" });
    entities.push(workspace);

    const profile = data.profile;
    if (profile && profile.projectType && profile.projectType !== "unknown") {
      const project = makeEntity(EntityType.Project, [wsPath], {
        path: data.workspacePath,
        projectType: profile.projectType,
        startScript: profile.startScript,
        installRequired: profile.installRequired
      }, { now, provenance: "perception:developer" });
      entities.push(project);
      relationships.push(makeRelationship(workspace.id, RelationshipType.CONTAINS, project.id, {}, { now }));

      if (profile.projectType === "node") {
        const runtime = makeEntity(EntityType.Runtime, ["node"], { name: "node" }, { now, provenance: "perception:developer" });
        entities.push(runtime);
        relationships.push(makeRelationship(project.id, RelationshipType.USES, runtime.id, {}, { now }));
      } else if (profile.projectType === "python") {
        const runtime = makeEntity(EntityType.Runtime, ["python"], { name: "python" }, { now, provenance: "perception:developer" });
        entities.push(runtime);
        relationships.push(makeRelationship(project.id, RelationshipType.USES, runtime.id, {}, { now }));
      }

      if (profile.packageManager) {
        const pm = makeEntity(EntityType.PackageManager, [profile.packageManager], { name: profile.packageManager }, { now, provenance: "perception:developer" });
        entities.push(pm);
        relationships.push(makeRelationship(project.id, RelationshipType.USES, pm.id, {}, { now }));
      }
    }
    return { entities, relationships };
  }
}

// The default provider set. VisionProvider is part of it: a perception layer
// that can enumerate processes and services but cannot look at the screen is not
// perceiving the machine a person actually uses. It was written, tested and
// never once constructed outside a test file, which meant
// PerceptionEngine.captureVisionSnapshot returned
// "vision-provider-not-registered" in every real session — the eyes existed and
// were never opened.
//
// It stays inert unless asked: VisionProvider.collect() returns
// "vision-not-requested" for an ordinary perceive() sweep, so adding it here
// costs a routine perception pass nothing. It only captures when a caller
// explicitly requests vision, and only if screen.capture / ocr.read / ui.inspect
// are all available in the registry.
export function createDefaultProviders(adapter, developerIntelligence = null, { capabilityRegistry = null } = {}) {
  return [
    new SystemProvider(adapter),
    new ProcessProvider(adapter),
    new ServiceProvider(adapter),
    new EnvironmentProvider(adapter),
    new FilesystemProvider(adapter),
    new DeveloperProvider(adapter, developerIntelligence),
    new VisionProvider(adapter, { capabilityRegistry })
  ];
}
