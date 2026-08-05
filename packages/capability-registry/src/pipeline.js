import { isCapabilityHealthy } from "./contract.js";

export class CapabilityLifecyclePipeline {
  constructor({ registry, onEvent = null } = {}) {
    this.registry = registry;
    this.onEvent = onEvent;
  }

  async prepare(task, context = {}) {
    const capability = this.registry.get(task.capability);
    if (!capability) throw new Error(`Unknown capability ${task.capability}`);
    if (!isCapabilityHealthy(capability, context)) throw new Error(`Capability ${task.capability} is not healthy`);
    // ELEVATION ROUTING INVARIANT (M2.1 Part E/F). Elevation is NOT a boolean the
    // caller can assert to run an arbitrary execute(). An elevated capability may
    // only be prepared when (a) policy approved elevation AND (b) it binds to a
    // bounded privileged operation that is actually routable in THIS runtime
    // (i.e. a helper is wired and the operation is in the live allow-list). This
    // is what guarantees the privileged mutation is executed exclusively through
    // the bounded trust boundary, not via a self-supplied handler.
    const requiresElevation = (capability.requirements?.elevation ?? "NONE") !== "NONE";
    if (requiresElevation) {
      if (!context.privilegeApproved) {
        throw new Error(`Capability ${task.capability} requires elevation`);
      }
      const op = capability.privilegedOperation;
      const routable = this.registry.privilegedOperations instanceof Set
        && op
        && this.registry.privilegedOperations.has(op);
      if (!routable) {
        throw new Error(
          `Capability ${task.capability} requires elevation but has no bounded privileged route ` +
          `(operation: ${op ?? "none"}). Refusing to execute an elevated capability outside the helper boundary.`
        );
      }
      await this.emit("CAPABILITY_ELEVATION_ROUTED", {
        taskId: task.taskId,
        capability: capability.name,
        privilegedOperation: op
      });
    }
    if (typeof context.authorize === "function") {
      const decision = await context.authorize(capability);
      await this.emit("CAPABILITY_PERMISSION_CHECKED", {
        taskId: task.taskId,
        capability: capability.name,
        approved: Boolean(decision?.approved),
        reason: decision?.reason
      });
      if (!decision?.approved) throw new Error(decision?.reason ?? `Capability ${task.capability} permission denied`);
    }
    if (typeof capability.preconditions === "function" && !capability.preconditions(task.inputs)) {
      throw new Error(`Capability ${task.capability} preconditions failed`);
    }
    await this.emit("CAPABILITY_EXECUTION_PREPARED", { taskId: task.taskId, capability: capability.name, requirements: capability.requirements });
    return capability;
  }

  async emit(type, payload) {
    return this.onEvent?.({ type, timestamp: new Date().toISOString(), ...payload });
  }

  async recordResult(task, result) {
    const capability = this.registry.get(task.capability);
    const type = result?.verification?.status === "VERIFIED"
      ? "CAPABILITY_VERIFIED"
      : "CAPABILITY_FAILED";
    await this.emit(type, { taskId: task.taskId, capability: task.capability, verification: result?.verification });
    if (type === "CAPABILITY_VERIFIED") {
      await this.emit("CAPABILITY_SEMANTIC_UPDATES_REGISTERED", {
        taskId: task.taskId,
        capability: task.capability,
        updates: capability?.semanticUpdates ?? []
      });
      await this.emit("CAPABILITY_MEMORY_UPDATES_REGISTERED", {
        taskId: task.taskId,
        capability: task.capability,
        updates: capability?.memoryUpdates ?? []
      });
    }
    return {
      type,
      semanticUpdates: capability?.semanticUpdates ?? [],
      memoryUpdates: capability?.memoryUpdates ?? [],
      auditEvents: capability?.auditEvents ?? []
    };
  }
}
