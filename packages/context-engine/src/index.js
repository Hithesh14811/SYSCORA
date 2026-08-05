import crypto from "crypto";
const createId = () => crypto.randomBytes(16).toString("hex");

export const TRUST_LEVELS = {
  SYSTEM_TRUSTED: "SYSTEM_TRUSTED",
  LOCAL_USER_DATA: "LOCAL_USER_DATA",
  EXTERNAL_UNTRUSTED: "EXTERNAL_UNTRUSTED",
  MODEL_GENERATED: "MODEL_GENERATED"
};

export class ContextProvider {
  constructor(name, supportedContextTypes, cost = 1, sensitivity = 0) {
    this.name = name;
    this.supportedContextTypes = supportedContextTypes;
    this.cost = cost;
    this.sensitivity = sensitivity;
  }

  async collect(request) {
    throw new Error("Not implemented");
  }
}

export class SystemContextProvider extends ContextProvider {
  constructor(adapter) {
    super("system", ["system"], 1, 1);
    this.adapter = adapter;
  }

  async collect(request) {
    const system = await this.adapter.getSystemInformation?.();
    return {
      contextId: createId(),
      type: "system",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.SYSTEM_TRUSTED,
      freshness: "current",
      data: system
    };
  }
}

export class ProcessContextProvider extends ContextProvider {
  constructor(adapter) {
    super("process", ["processes"], 2, 1);
    this.adapter = adapter;
  }

  async collect(request) {
    const processes = await this.adapter.listProcesses?.();
    return {
      contextId: createId(),
      type: "processes",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.SYSTEM_TRUSTED,
      freshness: "current",
      data: processes
    };
  }
}

export class PortContextProvider extends ContextProvider {
  constructor(adapter) {
    super("port", ["port"], 1, 1);
    this.adapter = adapter;
  }

  async collect(request) {
    const port = request.port ?? 3000;
    const inspect = await this.adapter.inspectPort?.(port);
    return {
      contextId: createId(),
      type: "port",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.SYSTEM_TRUSTED,
      freshness: "current",
      data: { port, inspect }
    };
  }
}

export class EnvironmentContextProvider extends ContextProvider {
  constructor(adapter) {
    super("environment", ["environment"], 1, 2);
    this.adapter = adapter;
  }

  async collect(request) {
    const env = await this.adapter.getUserPath();
    const envVars = [];
    return {
      contextId: createId(),
      type: "environment",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.SYSTEM_TRUSTED,
      freshness: "current",
      data: {
        userPath: env,
        envVars
      }
    };
  }
}

export class ServiceContextProvider extends ContextProvider {
  constructor(adapter) {
    super("service", ["services"], 1, 1);
    this.adapter = adapter;
  }

  async collect(request) {
    const services = await this.adapter.listServices();
    return {
      contextId: createId(),
      type: "services",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.SYSTEM_TRUSTED,
      freshness: "current",
      data: services
    };
  }
}

export class WorkspaceContextProvider extends ContextProvider {
  constructor(adapter, developerIntelligence) {
    super("workspace", ["workspace"], 3, 1);
    this.adapter = adapter;
    this.developerIntelligence = developerIntelligence;
  }

  async collect(request) {
    const workspacePath = request.workspacePath ?? process.cwd();
    const inspection = this.developerIntelligence
      ? await this.developerIntelligence.inspectProject(workspacePath)
      : null;
    return {
      contextId: createId(),
      type: "workspace",
      source: this.name,
      timestamp: new Date().toISOString(),
      sensitivity: this.sensitivity,
      trustLevel: TRUST_LEVELS.LOCAL_USER_DATA,
      freshness: "current",
      data: { workspacePath, inspection }
    };
  }
}

export class ContextEngine {
  constructor(providers) {
    this.providers = providers;
  }

  async collectContext(requiredContextTypes, request = {}) {
    const contextItems = [];
    for (const type of requiredContextTypes) {
      const provider = this.providers.find(p => p.supportedContextTypes.includes(type));
      if (provider) {
        try {
          const item = await provider.collect(request);
          contextItems.push(item);
        } catch (e) {
          console.warn(`Failed to collect context for type ${type} via ${provider.name}:`, e);
        }
      }
    }
    return contextItems;
  }

  // Create the bounded, deduplicated context handed to reasoning. Ranking is
  // deterministic so equivalent runtime state always yields equivalent input.
  buildPlanningContext({
    intent = {}, baseContext = [], semanticSubgraph = {}, memory = [],
    capabilityRegistry = null, policyConstraints = [], recoveryBudget = null,
    tokenBudget = 12000
  } = {}) {
    const limit = Math.max(1000, Number(tokenBudget) || 12000);
    const items = [];
    const push = (kind, value, rank) => {
      const serialized = JSON.stringify(value);
      if (!serialized || serialized === "{}" || serialized === "[]") return;
      items.push({ kind, value, rank, key: `${kind}:${serialized}`, cost: Math.ceil(serialized.length / 4) });
    };
    for (const item of baseContext) push(`context:${item.type}`, item.data, 100);
    for (const entity of semanticSubgraph.entities ?? []) push("entity", entity, 80 + Number(entity.confidence ?? 0));
    for (const relationship of semanticSubgraph.relationships ?? []) push("relationship", relationship, 60);
    for (const record of memory) {
      const rank = record.type === "PROCEDURAL" ? 70 : record.type === "FAILURE_PATTERN" ? 65 : 50;
      push(`memory:${record.type}`, record, rank + Number(record.relevanceScore ?? 0) / 1000);
    }
    if (capabilityRegistry) push("capabilities", capabilityRegistry.getCatalog(), 90);
    push("policy", policyConstraints, 95);
    push("recovery", recoveryBudget, 95);
    items.sort((left, right) => right.rank - left.rank || left.key.localeCompare(right.key));
    const seen = new Set();
    let usedTokens = 0;
    const selected = [];
    for (const item of items) {
      if (seen.has(item.key) || usedTokens + item.cost > limit) continue;
      seen.add(item.key);
      usedTokens += item.cost;
      selected.push({ kind: item.kind, value: item.value });
    }
    return { intent, items: selected, tokenBudget: limit, estimatedTokens: usedTokens };
  }
}

export { EnvironmentModel, Freshness, Sensitivity } from "./environment-model.js";
