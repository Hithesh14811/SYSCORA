import crypto from "crypto";
const createId = () => crypto.randomBytes(16).toString("hex");
import { validateSchema } from "../../model-providers/src/index.js";

export const TASK_LIMITS = Object.freeze({
  minTimeoutMs: 1000,
  maxTimeoutMs: 600000,
  maxRetryBudget: 10
});

// Build a canonical scheduler task. Centralizes the task shape so every planner
// path (operation-driven and keyword-driven) produces identical structure.
export function buildTask(capability, inputs = {}, overrides = {}) {
  return {
    taskId: createId(),
    goal: overrides.goal ?? capability,
    description: overrides.description ?? capability,
    dependencies: overrides.dependencies ?? [],
    capability,
    inputs,
    expectedStateChanges: overrides.expectedStateChanges ?? [],
    affectedEntities: overrides.affectedEntities ?? [],
    riskHints: overrides.riskHints ?? "LOW",
    verificationCriteria: overrides.verificationCriteria ?? [`${capability} verified`],
    completionCriteria: overrides.completionCriteria ?? [`${capability} completed`],
    timeout: Math.min(Math.max(overrides.timeout ?? 15000, TASK_LIMITS.minTimeoutMs), TASK_LIMITS.maxTimeoutMs),
    retryBudget: overrides.retryBudget ?? 1,
    idempotency: overrides.idempotency ?? true,
    rollbackRequired: overrides.rollbackRequired ?? false
  };
}

// Operation-driven deterministic plans. Each entry maps a named operation to a
// task graph built directly from structured entities. Compatibility wrappers
// set intent.operation to one of these keys, giving a reliable 1:1 mapping from
// a concrete request to a capability with no natural-language re-parsing.
export const OPERATION_PLANS = {
  "system.inspect": () => [
    buildTask("system.inspect", {}, {
      goal: "Inspect system",
      description: "Retrieve system summary",
      completionCriteria: ["Got system info"],
      timeout: 10000
    })
  ],
  // Aggregate read-only snapshot: system info + top processes + services. The
  // three tasks are independent (no dependencies) so the scheduler can run them
  // together; the wrapper reassembles the classic summary shape from results.
  "system.summary": () => [
    buildTask("system.inspect", {}, {
      goal: "Inspect system",
      description: "Retrieve system summary",
      completionCriteria: ["Got system info"],
      timeout: 10000
    }),
    buildTask("processes.list", {}, {
      goal: "List processes",
      description: "List running processes",
      completionCriteria: ["Got process list"],
      timeout: 15000
    }),
    buildTask("system.services.list", {}, {
      goal: "List services",
      description: "List Windows services",
      completionCriteria: ["Got service list"],
      timeout: 15000
    })
  ],
  "processes.list": () => [
    buildTask("processes.list", {}, {
      goal: "List processes",
      description: "List running processes",
      completionCriteria: ["Got process list"],
      timeout: 15000
    })
  ],
  "process.port.inspect": (e) => [
    buildTask("process.port.inspect", { port: Number(e.port) }, {
      goal: "Inspect port",
      description: "Find process on port",
      completionCriteria: ["Got port info"],
      timeout: 10000
    })
  ],
  "environment.user.inspect": (e) => [
    buildTask("environment.user.inspect", e.key ? { key: e.key } : {}, {
      goal: "Inspect user environment",
      description: "Get user environment / PATH",
      completionCriteria: ["Got env info"],
      timeout: 10000
    })
  ],
  "environment.project.set": (e, ws) => [
    buildTask("environment.project.set", {
      workspacePath: e.workspacePath ?? ws,
      key: e.key,
      value: e.value
    }, {
      goal: "Set project env var",
      description: "Set project environment variable",
      riskHints: "MEDIUM",
      expectedStateChanges: ["env.file"],
      completionCriteria: ["Env var is set and verified"],
      timeout: 10000
    })
  ],
  "environment.user.set": (e) => [
    buildTask("environment.user.set", { key: e.key, value: e.value }, {
      goal: "Set user env var",
      description: "Set Windows user environment variable",
      riskHints: "MEDIUM",
      expectedStateChanges: ["user.environment"],
      completionCriteria: ["User env var is set and verified"],
      timeout: 15000
    })
  ],
  "environment.user.path.add": (e) => [
    buildTask("environment.user.path.add", { entry: e.entry ?? e.value }, {
      goal: "Add PATH entry",
      description: "Add entry to user PATH",
      riskHints: "MEDIUM",
      expectedStateChanges: ["user.path"],
      completionCriteria: ["PATH contains entry"],
      timeout: 15000
    })
  ],
  "package.winget.search": (e) => [
    buildTask("package.winget.search", { query: e.query }, {
      goal: "Search WinGet",
      description: "Search for packages via WinGet",
      completionCriteria: ["WinGet search complete"],
      timeout: 30000
    })
  ],
  "package.winget.install": (e) => [
    buildTask("package.winget.install", { id: e.id ?? e.key }, {
      goal: "Install package",
      description: "Install a package via WinGet",
      riskHints: "MEDIUM",
      expectedStateChanges: ["system.packages"],
      completionCriteria: ["Package installed and verified"],
      timeout: 600000
    })
  ],
  "system.performance.analyze": () => [
    buildTask("system.performance.analyze", {}, {
      goal: "Analyze performance",
      description: "Analyze system performance snapshot",
      completionCriteria: ["Performance analysis complete"],
      timeout: 20000
    })
  ],
  // Privileged operations. The scope (service name / package id), the single-use
  // approval token, and the execution mode are threaded from structured entities
  // into the capability inputs. The capability's execute() consumes the token
  // through the bounded helper; VALIDATE (read-only) is the default so an approved
  // token alone never mutates unless mode COMMIT is explicitly requested.
  "service.restart": (e) => [
    buildTask("service.restart", {
      scope: e.scope,
      token: e.token,
      mode: e.mode === "COMMIT" ? "COMMIT" : "VALIDATE",
      sessionId: e.sessionId
    }, {
      goal: "Restart service",
      description: "Restart a Windows service through the bounded privileged helper",
      riskHints: "MEDIUM",
      expectedStateChanges: ["system.service"],
      completionCriteria: ["Privileged service.restart completed"],
      timeout: 30000
    })
  ],
  "package.install": (e) => [
    buildTask("package.install", {
      scope: e.scope,
      token: e.token,
      mode: e.mode === "COMMIT" ? "COMMIT" : "VALIDATE",
      sessionId: e.sessionId
    }, {
      goal: "Install package",
      description: "Install a package through the bounded privileged helper",
      riskHints: "MEDIUM",
      expectedStateChanges: ["system.packages"],
      completionCriteria: ["Privileged package.install completed"],
      timeout: 600000
    })
  ],
  // Rollback (canonical convergence). A rollback request maps 1:1 to the
  // session.rollback capability, which delegates to the shared RollbackManager.
  // The concrete records to revert travel on the intent entities; risk is MEDIUM
  // because restoring env/PATH/files is the same mutation class it undoes.
  "session.rollback": (e) => [
    buildTask("session.rollback", {
      sessionId: e.sessionId,
      records: Array.isArray(e.records) ? e.records : [],
      targetRecordIds: Array.isArray(e.targetRecordIds) ? e.targetRecordIds : [],
      reason: e.reason ?? null
    }, {
      goal: "Roll back session",
      description: "Revert recorded checkpoints for a session",
      riskHints: "MEDIUM",
      expectedStateChanges: ["rollback"],
      completionCriteria: ["Recorded changes reverted and verified"],
      timeout: 120000,
      idempotency: false
    })
  ],
  "application.notepad.launch": (e) => [
    buildTask("application.notepad.launch", { content: e.content, filename: e.filename }, {
      goal: "Notepad task",
      description: "Open Notepad, type text, and save",
      riskHints: "MEDIUM",
      expectedStateChanges: ["user.documents"],
      completionCriteria: ["File saved"],
      timeout: 45000,
      idempotency: false
    })
  ],
  "browser.search": (e) => [
    buildTask("browser.search", { query: e.query }, {
      goal: "Browser search",
      description: "Open the default browser to a search results page",
      completionCriteria: ["Browser launched"],
      timeout: 15000
    })
  ],
  // Developer workflow. The caller resolves ordered steps from the project
  // profile (install, run) into entities.steps; the planner turns them into a
  // linear dependency chain of developer.command.run tasks.
  "developer.project.run": (e, ws) => {
    const steps = Array.isArray(e.steps) ? e.steps : [];
    const tasks = [];
    let previousId = null;
    for (const step of steps) {
      const task = buildTask("developer.command.run", {
        workspacePath: e.workspacePath ?? ws,
        command: step.command,
        args: step.args ?? []
      }, {
        goal: step.goal ?? "Run developer command",
        description: step.description ?? `${step.command} ${(step.args ?? []).join(" ")}`.trim(),
        riskHints: "MEDIUM",
        dependencies: previousId ? [previousId] : [],
        completionCriteria: [step.goal ?? "Command completed"],
        timeout: step.timeout ?? 90000
      });
      tasks.push(task);
      previousId = task.taskId;
    }
    return tasks;
  }
};

export class PlanValidator {
  constructor(capabilityRegistry) {
    this.capabilityRegistry = capabilityRegistry;
  }

  validatePlan(taskGraph) {
    const errors = [];
    const visited = new Set();
    const taskMap = new Map(taskGraph.tasks.map(t => [t.taskId, t]));
    const taskIds = new Set();

    // Validate each task
    for (const task of taskGraph.tasks) {
      let cap = null;
      if (!task.taskId) {
        errors.push("Task must have an ID");
        continue;
      }
      if (taskIds.has(task.taskId)) {
        errors.push(`Duplicate task ID ${task.taskId}`);
      }
      taskIds.add(task.taskId);

      if (!task.capability) {
        errors.push(`Task ${task.taskId} must specify a capability`);
      } else if (!this.capabilityRegistry.has(task.capability)) {
        errors.push(`Unknown capability ${task.capability} for task ${task.taskId}`);
      } else {
        cap = this.capabilityRegistry.get(task.capability);
        if (!this.capabilityRegistry.isAvailable(task.capability, { platform: process.platform })) {
          errors.push(`Capability ${task.capability} is unavailable or unhealthy for task ${task.taskId}`);
        }
        const inputValidation = validateSchema(task.inputs, cap.inputSchema);
        if (!inputValidation.valid) {
          errors.push(`Invalid inputs for task ${task.taskId}: ${inputValidation.errors.join(", ")}`);
        }

        // Check if mutating, but has verification criteria
        if (cap.reversibility !== "NOT_REQUIRED" && (!task.verificationCriteria || task.verificationCriteria.length === 0)) {
          errors.push(`Task ${task.taskId} has a mutating capability but no verification criteria`);
        }
        if (cap.reversibility === "ROLLBACK_SUPPORTED" && task.rollbackRequired !== true) {
          errors.push(`Task ${task.taskId} must explicitly require rollback support`);
        }
      }

      // Check dependencies
      for (const depId of (task.dependencies || [])) {
        if (!taskMap.has(depId)) errors.push(`Task ${task.taskId} depends on non-existent task ${depId}`);
        if (depId === task.taskId) errors.push(`Task ${task.taskId} cannot depend on itself`);
      }

      // Check retry budget and timeout
      const capabilityRetryBudget = Math.max(0, Number(cap?.retryPolicy?.maxAttempts ?? 1) - 1);
      if (task.retryBudget === undefined || task.retryBudget < 0 || task.retryBudget > Math.min(TASK_LIMITS.maxRetryBudget, capabilityRetryBudget)) {
        errors.push(`Task ${task.taskId} has invalid retry budget`);
      }
      const capabilityTimeout = Number(cap?.timeout ?? TASK_LIMITS.maxTimeoutMs);
      if (task.timeout === undefined || task.timeout < TASK_LIMITS.minTimeoutMs || task.timeout > Math.min(TASK_LIMITS.maxTimeoutMs, capabilityTimeout)) {
        errors.push(`Task ${task.taskId} has invalid timeout`);
      }
    }

    // Check for cycles
    for (const task of taskGraph.tasks) {
      if (this.hasCycle(task.taskId, taskMap, visited, new Set())) {
        errors.push(`Cycle detected involving task ${task.taskId}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  hasCycle(taskId, taskMap, visited, recursionStack) {
    if (recursionStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    recursionStack.add(taskId);
    const task = taskMap.get(taskId);
    for (const dep of (task?.dependencies || [])) {
      if (this.hasCycle(dep, taskMap, visited, recursionStack)) return true;
    }
    recursionStack.delete(taskId);
    return false;
  }
}

export class GeneralPlanner {
  // Accepts either a ReasoningEngine (preferred — the single model boundary) or,
  // for backward compatibility, a raw model provider. When a ReasoningEngine is
  // supplied the planner asks it to compose a task graph; otherwise it uses the
  // deterministic fallback. Either way the output is treated as a proposal and
  // must pass PlanValidator before execution.
  constructor(reasoningOrModel, capabilityRegistry) {
    if (reasoningOrModel && typeof reasoningOrModel.composeTaskGraph === "function") {
      this.reasoningEngine = reasoningOrModel;
      this.modelProvider = null;
    } else {
      this.reasoningEngine = null;
      this.modelProvider = reasoningOrModel || null;
    }
    this.capabilityRegistry = capabilityRegistry;
  }

  async generatePlan(
    userIntent, 
    resolvedContext, 
    relevantSemanticState = [], 
    relevantMemory = [], 
    previousExecutionState = null
  ) {
    let plan = null;

    // LLM planning goes through the ReasoningEngine, which validates output,
    // performs bounded repair, and rejects hallucinated capabilities. It returns
    // { ok, data } and NEVER throws — so any failure (no model, bad JSON,
    // timeout, hallucination) falls through to the deterministic planner below.
    if (this.reasoningEngine && this.reasoningEngine.hasModel()) {
      const result = await this.reasoningEngine.composeTaskGraph(userIntent, {
        context: resolvedContext,
        semanticState: relevantSemanticState,
        memory: relevantMemory,
        previousExecutionState
      });
      if (result.ok && this._isStructurallyPlan(result.data)) {
        plan = result.data;
      }
    }

    // Deterministic fallback: the production planner when no model is configured
    // or the model output was rejected. The runtime always has a valid plan.
    if (!this._isStructurallyPlan(plan)) {
      plan = this.fallbackPlan(userIntent, resolvedContext);
    }

    // An LLM plan is a proposal only. Normalize it against the capability
    // contract and fall back deterministically if it still cannot validate.
    plan = this._mergeCompletedTasks(plan, previousExecutionState);
    plan = this._normalizePlan(plan);
    if (!new PlanValidator(this.capabilityRegistry).validatePlan(plan.taskGraph).valid) {
      plan = this._normalizePlan(this.fallbackPlan(userIntent, resolvedContext));
    }

    // Ensure all required fields exist
    plan.planId = plan.planId ?? createId();
    plan.planVersion = plan.planVersion ?? 1;
    plan.parentPlanId = plan.parentPlanId ?? null;
    plan.finalSuccessCriteria = plan.finalSuccessCriteria ?? ["Task completed"];
    plan.taskGraph.graphId = plan.taskGraph.graphId ?? createId();
    return plan;
  }

  _normalizePlan(plan) {
    if (!this._isStructurallyPlan(plan)) return plan;
    for (const task of plan.taskGraph.tasks) {
      const capability = this.capabilityRegistry?.get(task.capability);
      if (!capability) continue;
      task.dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
      task.inputs = task.inputs && typeof task.inputs === "object" ? task.inputs : {};
      task.verificationCriteria = Array.isArray(task.verificationCriteria) && task.verificationCriteria.length
        ? task.verificationCriteria
        : [`${task.capability} verified`];
      task.completionCriteria = Array.isArray(task.completionCriteria) && task.completionCriteria.length
        ? task.completionCriteria
        : [`${task.capability} completed`];
      task.timeout = Math.min(
        Math.max(Number(task.timeout ?? capability.timeout ?? 15000), TASK_LIMITS.minTimeoutMs),
        TASK_LIMITS.maxTimeoutMs,
        Number(capability.timeout ?? TASK_LIMITS.maxTimeoutMs)
      );
      task.retryBudget = Math.min(
        Math.max(0, Number(task.retryBudget ?? 0)),
        TASK_LIMITS.maxRetryBudget,
        Math.max(0, Number(capability.retryPolicy?.maxAttempts ?? 1) - 1)
      );
      task.rollbackRequired = capability.reversibility === "ROLLBACK_SUPPORTED";
    }
    return plan;
  }

  _mergeCompletedTasks(plan, previousExecutionState) {
    const originalTasks = previousExecutionState?.originalPlan?.taskGraph?.tasks;
    const completedTaskIds = new Set(previousExecutionState?.completedTaskIds ?? []);
    if (!Array.isArray(originalTasks) || completedTaskIds.size === 0 || !this._isStructurallyPlan(plan)) return plan;
    const existing = new Set(plan.taskGraph.tasks.map((task) => task.taskId));
    const preserved = originalTasks.filter((task) => completedTaskIds.has(task.taskId) && !existing.has(task.taskId));
    plan.taskGraph.tasks = [...preserved, ...plan.taskGraph.tasks];
    return plan;
  }

  _isStructurallyPlan(plan) {
    return Boolean(
      plan &&
      typeof plan === "object" &&
      plan.taskGraph &&
      typeof plan.taskGraph === "object" &&
      Array.isArray(plan.taskGraph.tasks)
    );
  }

  // Deterministic planner. This is the production planner when no real language
  // model is configured. It maps an intent to a task graph in two ways:
  //   1. Operation-driven (preferred): intent.operation names the workflow, and
  //      OPERATION_PLANS[operation] produces the task(s) directly from entities.
  //      Compatibility wrappers use this path for a reliable 1:1 mapping.
  //   2. Keyword-driven (fallback): free-text intents are matched heuristically.
  fallbackPlan(userIntent, resolvedContext) {
    const entities = userIntent.entities || {};
    const workspacePath = entities.workspacePath ?? process.cwd();

    let tasks = [];
    const opBuilder = OPERATION_PLANS[userIntent.operation];
    if (opBuilder) {
      tasks = opBuilder(entities, workspacePath);
    } else {
      tasks = this._keywordTasks(userIntent);
    }

    return {
      planId: createId(),
      planVersion: 1,
      parentPlanId: null,
      goal: userIntent.normalizedGoal,
      finalSuccessCriteria: userIntent.successCriteria?.length
        ? userIntent.successCriteria
        : ["Tasks completed"],
      summary: userIntent.normalizedGoal,
      taskGraph: {
        graphId: createId(),
        tasks
      }
    };
  }

  _keywordTasks(userIntent) {
    const tasks = [];
    const category = userIntent.category;
    const lower = userIntent.rawText.toLowerCase();
    const entities = userIntent.entities || {};

    if (category === "SYSTEM" && lower.includes("system")) {
      tasks.push(buildTask("system.inspect", {}, {
        goal: "Inspect system",
        description: "Retrieve system summary",
        riskHints: "LOW",
        completionCriteria: ["Got system info"],
        timeout: 10000
      }));
    }
    if (category === "SYSTEM" && lower.includes("process")) {
      tasks.push(buildTask("processes.list", {}, {
        goal: "List processes",
        description: "List running processes",
        riskHints: "LOW",
        completionCriteria: ["Got process list"],
        timeout: 15000
      }));
    }
    if (category === "SYSTEM" && entities.port) {
      tasks.push(buildTask("process.port.inspect", { port: entities.port }, {
        goal: "Inspect port",
        description: "Find process on port",
        riskHints: "LOW",
        completionCriteria: ["Got port info"],
        timeout: 10000
      }));
    }
    if (category === "ENVIRONMENT" && lower.includes("path")) {
      tasks.push(buildTask("environment.user.inspect", {}, {
        goal: "Inspect environment",
        description: "Get user environment",
        riskHints: "LOW",
        completionCriteria: ["Got env info"],
        timeout: 5000
      }));
    }
    if (category === "PROJECT" && entities.key && entities.value) {
      tasks.push(buildTask("environment.project.set", {
        workspacePath: entities.workspacePath ?? process.cwd(),
        key: entities.key,
        value: entities.value
      }, {
        goal: "Set env var",
        description: "Set project environment variable",
        riskHints: "MEDIUM",
        expectedStateChanges: ["env.file"],
        completionCriteria: ["Env var is set and verified"],
        timeout: 10000
      }));
    }
    if (category === "APPLICATION" && entities.content && entities.filename) {
      tasks.push(buildTask("application.notepad.launch", {
        content: entities.content,
        filename: entities.filename
      }, {
        goal: "Notepad task",
        description: "Open Notepad and save",
        riskHints: "MEDIUM",
        expectedStateChanges: ["user.documents"],
        completionCriteria: ["File saved"],
        timeout: 45000,
        idempotency: false
      }));
    }
    return tasks;
  }
}
