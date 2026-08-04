import crypto from "crypto";
import os from "node:os";
import path from "node:path";
const createId = () => crypto.randomBytes(16).toString("hex");
import { validateSchema } from "../../model-providers/src/index.js";
import {
  assessGoalContractPlanCoverage
} from "../../shared-types/src/goal-contract.js";
import {
  CapabilityResolutionKind,
  resolveCapabilityId
} from "../../shared-types/src/capability-resolution.js";

export const TASK_LIMITS = Object.freeze({
  minTimeoutMs: 1000,
  maxTimeoutMs: 600000,
  maxRetryBudget: 10
});

const SEMANTIC_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "can", "could", "current",
  "do", "for", "from", "get", "give", "i", "in", "into", "is", "it", "leave",
  "its", "me", "my", "of", "on", "only", "or", "out", "please", "put", "read", "show", "something", "tell",
  "that", "the", "then", "this", "to", "use", "using", "via", "what", "with",
  "quick", "request", "processed", "success", "successful", "successfully", "whats",
  "task", "complete", "completed", "completion", "done", "verify", "verified"
]);

const SEMANTIC_ALIASES = new Map([
  ["box", "system"], ["computer", "system"], ["machine", "system"], ["pc", "system"],
  ["developer", "environment"], ["development", "environment"],
  ["tool", "environment"], ["tools", "environment"], ["tooling", "environment"],
  ["installed", "environment"],
  ["application", "app"], ["applications", "app"],
  ["directories", "directory"], ["folder", "directory"], ["folders", "directory"],
  ["repository", "repo"], ["repositories", "repo"],
  ["processes", "process"], ["running", "process"], ["packages", "package"],
  ["browsing", "browser"], ["webpage", "browser"], ["website", "browser"]
]);

function semanticTokens(value) {
  const raw = String(value ?? "").toLowerCase().match(/[a-z0-9]+(?:[+-][a-z0-9]+)*/g) ?? [];
  return new Set(raw
    .map((token) => SEMANTIC_ALIASES.get(token) ?? token)
    .map((token) => token.length > 5 && token.endsWith("ing") ? token.slice(0, -3) : token)
    .map((token) => token.length > 4 && token.endsWith("ed") ? token.slice(0, -2) : token)
    .filter((token) => token.length > 1 && !SEMANTIC_STOP_WORDS.has(token)));
}

/**
 * Fail-closed semantic coverage check for an untyped deterministic fallback.
 * Plan goal/summary are deliberately excluded because they merely echo the
 * request. Coverage must come from concrete tasks, capability contracts, and
 * bounded inputs that would actually execute.
 */
export function assessPlanGoalCoverage(intent = {}, taskGraph = {}, capabilityRegistry = null) {
  const goalContract = intent.goalContract ?? null;
  if (goalContract?.enforceable && goalContract?.criteria?.length > 0) {
    const contractCoverage = assessGoalContractPlanCoverage(goalContract, taskGraph, capabilityRegistry);
    return {
      covered: contractCoverage.covered,
      score: contractCoverage.totalCriteria > 0
        ? contractCoverage.coveredCount / contractCoverage.totalCriteria
        : 0,
      matchedTerms: contractCoverage.criteria
        .filter((criterion) => criterion.covered)
        .map((criterion) => criterion.description),
      missingTerms: contractCoverage.missingCriteria,
      reason: contractCoverage.covered
        ? "all-goal-contract-criteria-covered"
        : "goal-contract-criteria-missing",
      goalContractCoverage: contractCoverage
    };
  }
  // rawText is the original authority. Model-produced normalizedGoal and
  // successCriteria are useful only when no original text exists; a malformed
  // interpretation must not make an otherwise correct deterministic route fail
  // (or make an irrelevant one pass).
  const requestSource = String(intent.rawText ?? "").trim() || [
    intent.normalizedGoal,
    ...(intent.successCriteria ?? [])
  ].filter(Boolean).join(" ");
  const requestTokens = semanticTokens(requestSource);
  const tasks = Array.isArray(taskGraph?.tasks) ? taskGraph.tasks : [];
  if (requestTokens.size === 0) {
    return { covered: true, score: 1, matchedTerms: [], missingTerms: [], reason: "no-informative-goal-terms" };
  }
  if (tasks.length === 0) {
    return { covered: false, score: 0, matchedTerms: [], missingTerms: [...requestTokens], reason: "empty-task-graph" };
  }

  const evidenceParts = [];
  for (const task of tasks) {
    const contract = capabilityRegistry?.get?.(task.capability);
    evidenceParts.push(
      task.capability,
      task.goal,
      task.description,
      JSON.stringify(task.inputs ?? {}),
      ...(task.completionCriteria ?? []),
      ...(task.verificationCriteria ?? []),
      contract?.description
    );
  }
  const evidenceTokens = semanticTokens(evidenceParts.filter(Boolean).join(" "));
  const matchedTerms = [...requestTokens].filter((token) => evidenceTokens.has(token));
  const missingTerms = [...requestTokens].filter((token) => !evidenceTokens.has(token));
  const denominator = Math.min(requestTokens.size, 6);
  const score = denominator > 0 ? matchedTerms.length / denominator : 1;
  const covered = matchedTerms.length >= Math.min(2, requestTokens.size) && score >= 0.34;
  return {
    covered,
    score,
    matchedTerms,
    missingTerms,
    reason: covered ? "task-evidence-covers-goal" : "task-evidence-does-not-cover-goal"
  };
}

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

// Model providers legitimately use different entity names for a song. Normalize
// them at the capability boundary so a valid model intent can never become an
// empty Spotify precondition. Add the artist when supplied to disambiguate the
// search without making it a separate Spotify-specific LLM prompt.
function spotifyQuery(entities = {}) {
  const title = entities.query ?? entities.trackQuery ?? entities.track ?? entities.trackTitle ?? entities.song ?? entities.songTitle ?? entities.title;
  const artist = typeof entities.artist === "string" ? entities.artist.trim() : "";
  if (typeof title !== "string" || !title.trim()) return undefined;
  return artist && !title.toLowerCase().includes(artist.toLowerCase()) ? `${title.trim()} ${artist}` : title.trim();
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
      description: "Retrieve Windows version, CPU details, and installed memory",
      completionCriteria: ["Windows version, CPU details, and installed memory retrieved"],
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
  "package.winget.inspect": (e) => [
    buildTask("package.winget.inspect", { id: e.id }, {
      goal: `Check whether ${e.id} is installed`,
      description: "Check installed-package status via WinGet",
      completionCriteria: [`Reported whether ${e.id} is installed`],
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
  "application.launch": (e) => [
    buildTask("application.launch", { application: e.application }, {
      goal: `Open ${e.application}`,
      description: "Launch the requested allow-listed desktop application",
      completionCriteria: [`${e.application} launched`], timeout: 15000, retryBudget: 0
    })
  ],
  "window.enumerate": () => [
    buildTask("window.enumerate", {}, { goal: "Enumerate windows", completionCriteria: ["Visible windows observed"], timeout: 8000, retryBudget: 0 })
  ],
  "window.wait": (e) => [
    buildTask("window.wait", { windowId: e.windowId, application: e.application, timeoutMs: e.timeoutMs }, { goal: "Wait for application window", completionCriteria: ["Expected window appeared"], timeout: 20000, retryBudget: 0 })
  ],
  "process.launch": (e, ws) => [
    buildTask("process.launch", { executable: e.executable, args: e.args ?? [], workingDirectory: e.workingDirectory ?? ws }, { goal: "Launch process", riskHints: "MEDIUM", completionCriteria: ["Process started"], timeout: 15000, retryBudget: 0 })
  ],
  "window.activate": (e) => [
    buildTask("window.activate", { windowId: e.windowId, application: e.application }, { goal: "Activate window", completionCriteria: ["Window is foreground"], timeout: 8000, retryBudget: 0 })
  ],
  "ui.find": (e) => [
    buildTask("ui.find", { application: e.application, windowId: e.windowId, selector: e.selector ?? { nameContains: e.targetName ?? e.query } }, { goal: "Find UI target", completionCriteria: ["Live UI target resolved"], timeout: 10000, retryBudget: 0 })
  ],
  "ui.resolveTarget": (e) => [
    buildTask("ui.resolveTarget", { application: e.application, windowId: e.windowId, selector: e.selector ?? { nameContains: e.targetName ?? e.query }, visualQuery: e.visualQuery ?? e.targetName ?? e.query }, { goal: "Resolve live interaction target", completionCriteria: ["Target resolved from current state"], timeout: 20000, retryBudget: 0 })
  ],
  "ui.action": (e) => [
    buildTask("ui.action", { application: e.application, windowId: e.windowId, target: e.target, action: e.action, text: e.text, expectedAfter: e.expectedAfter }, { goal: "Interact with UI target", riskHints: "MEDIUM", completionCriteria: ["UI effect observed"], timeout: 15000, retryBudget: 0 })
  ],
  "screen.capture": (e) => [
    buildTask("screen.capture", { application: e.application, windowId: e.windowId, region: e.region }, { goal: "Capture relevant screen state", completionCriteria: ["Screenshot captured locally"], timeout: 12000, retryBudget: 0 })
  ],
  "vision.locate": (e) => [
    buildTask("vision.locate", { application: e.application, windowId: e.windowId, query: e.query }, { goal: "Locate visible target", completionCriteria: ["Visual target grounded"], timeout: 20000, retryBudget: 0 })
  ],
  "system.volume.adjust": (e) => [
    buildTask("system.volume.adjust", { direction: e.direction, steps: e.steps }, {
      goal: `${e.direction === "down" ? "Decrease" : "Increase"} system volume`,
      description: "Send bounded Windows media-volume key commands",
      completionCriteria: [`Volume ${e.direction} command sent`], timeout: 5000, retryBudget: 0
    })
  ],
  "spotify.track.open": (e) => [
    buildTask("spotify.track.open", { query: spotifyQuery(e) }, {
      goal: `Open Spotify results for ${spotifyQuery(e)}`,
      description: "Hand the requested track search directly to Spotify",
      completionCriteria: [`Spotify results opened for ${spotifyQuery(e)}`],
      timeout: 5000
    })
  ],
  // Direct desktop playback. A single typed task drives launch -> wait -> search
  // -> select -> activate play -> verify inside the capability (which shares one
  // live UI-automation session and verifies playback from the window title). No
  // WinGet check or process-list scan is composed — Spotify is launched through
  // the known route inside the capability itself. Bounded timeout + retryBudget 0
  // (plus the capability's ABORT_ON_FAILURE) prevent any replan loop.
  "spotify.track.play": (e) => {
    const playTask = buildTask("spotify.track.play", { query: spotifyQuery(e) }, {
      goal: `Play ${spotifyQuery(e)} in Spotify`,
      description: "Launch/focus Spotify, search, select the track, and start playback",
      riskHints: "LOW",
      completionCriteria: [`${spotifyQuery(e)} is playing in Spotify`],
      verificationCriteria: [`Spotify is playing ${spotifyQuery(e)}`],
      timeout: 28000,
      retryBudget: 0
    });
    if (typeof e.queueQuery !== "string" || !e.queueQuery.trim()) return [playTask];
    const queueQuery = e.queueQuery.trim();
    return [
      playTask,
      buildTask("spotify.track.queue", { query: queueQuery }, {
        goal: `Queue ${queueQuery} in Spotify`,
        description: "Search for the requested follow-up track and add it to the Spotify queue",
        dependencies: [playTask.taskId],
        riskHints: "LOW",
        completionCriteria: [`${queueQuery} is in the Spotify queue`],
        verificationCriteria: [`Spotify queue contains ${queueQuery}`],
        timeout: 30000,
        retryBudget: 0
      })
    ];
  },
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
    // Planner source marker (Phase 6): the runtime/audit distinguishes a plan the
    // MODEL produced from one the DETERMINISTIC fallback produced. Never claim
    // model reasoning occurred when it did not.
    let plannerSource = "DETERMINISTIC_FALLBACK";

    // LLM planning goes through the ReasoningEngine, which validates output,
    // performs bounded repair, and rejects hallucinated capabilities. It returns
    // { ok, data } and NEVER throws — so any failure (no model, bad JSON,
    // timeout, hallucination) falls through to the deterministic planner below.
    // A fast, cached health gate means an UNAVAILABLE provider is skipped in
    // ~1s instead of burning 30-45s of retries before the fallback (Phase 6).
    // Explicit operations are already typed, bounded requests. Calling a model
    // to rediscover their one-to-one plan adds latency without adding judgment.
    if (userIntent.operation && OPERATION_PLANS[userIntent.operation]) {
      plan = this.fallbackPlan(userIntent, resolvedContext);
      plannerSource = "DIRECT_OPERATION";
    } else if (this.reasoningEngine && this.reasoningEngine.hasModel()) {
      const healthy = await this.reasoningEngine.isModelHealthy();
      if (healthy) {
        const result = await this.reasoningEngine.composeTaskGraph(userIntent, {
          context: resolvedContext,
          semanticState: relevantSemanticState,
          memory: relevantMemory,
          previousExecutionState
        });
        if (result.ok && this._isStructurallyPlan(result.data)) {
          plan = result.data;
          plannerSource = "MODEL_REASONING";
        }
      }
    }

    // Deterministic fallback: the production planner when no model is configured
    // or the model output was rejected. The runtime always has a valid plan.
    if (!this._isStructurallyPlan(plan)) {
      plan = this.fallbackPlan(userIntent, resolvedContext);
      plannerSource = "DETERMINISTIC_FALLBACK";
    }

    // An LLM plan is a proposal only. Normalize it against the capability
    // contract and fall back deterministically if it still cannot validate.
    plan = this._mergeCompletedTasks(plan, previousExecutionState);
    plan = this._normalizePlan(plan);
    if (!new PlanValidator(this.capabilityRegistry).validatePlan(plan.taskGraph).valid) {
      plan = this._normalizePlan(this.fallbackPlan(userIntent, resolvedContext));
      plannerSource = "DETERMINISTIC_FALLBACK";
    }

    // Ensure all required fields exist
    plan.planId = plan.planId ?? createId();
    plan.planVersion = plan.planVersion ?? 1;
    plan.parentPlanId = plan.parentPlanId ?? null;
    plan.finalSuccessCriteria = plan.finalSuccessCriteria ?? ["Task completed"];
    plan.taskGraph.graphId = plan.taskGraph.graphId ?? createId();
    // Record which planner produced this plan so the runtime can audit it.
    plan.plannerSource = plannerSource;
    return plan;
  }

  _normalizePlan(plan) {
    if (!this._isStructurallyPlan(plan)) return plan;
    const catalog = this.capabilityRegistry?.getCatalog?.() ?? [];
    for (const task of plan.taskGraph.tasks) {
      const resolution = resolveCapabilityId(task.capability, catalog);
      if ([CapabilityResolutionKind.EXACT_MATCH, CapabilityResolutionKind.CANONICAL_ALIAS].includes(resolution.kind)) {
        task.capability = resolution.canonicalId;
      }
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

  // Deterministic fallback matcher for the supported MVP demo workflows. This is
  // the safety net when no model is configured / the model failed — it is NOT a
  // second LLM. It recognizes the FIVE controlled workflow families by robust
  // keyword/entity signals (not one exact sentence) and composes REAL registered
  // capabilities into REAL TaskGraphs that pass through the same canonical
  // runtime (validate -> risk -> policy -> scheduler -> observe -> verify). It
  // never fabricates capabilities, never bypasses the runtime, and only builds
  // BOUNDED-safe filesystem targets. Order matters: the most specific families
  // (port, filesystem, winget) are matched before the broad system/dev family.
  _keywordTasks(userIntent) {
    const lower = String(userIntent.rawText ?? "").toLowerCase();
    const entities = userIntent.entities || {};
    const workspacePath = entities.workspacePath ?? process.cwd();

    const explicitFilesystemTasks = this._explicitFilesystemTasks(userIntent, workspacePath);
    if (explicitFilesystemTasks.length > 0) return explicitFilesystemTasks;

    // --- WORKFLOW B: port troubleshooting (read-only inspection) --------------
    // A port number in the text/entities is a strong, unambiguous signal.
    const port = entities.port ?? this._extractPort(lower);
    if (port && /\bport\b/.test(lower)) {
      return [buildTask("process.port.inspect", { port: Number(port) }, {
        goal: `Inspect port ${port}`,
        description: `Find which process is using port ${port}`,
        riskHints: "LOW",
        completionCriteria: [`Identified what is using port ${port}`],
        timeout: 10000
      })];
    }

    // --- WORKFLOW D: WinGet software discovery (search only) ------------------
    const wantsSearch = /\b(winget|package manager)\b/.test(lower)
      || (/\b(find|search|look up|discover)\b/.test(lower) && /\b(package|app|application|software|install)\b/.test(lower));
    if (wantsSearch) {
      const query = entities.query ?? this._extractSearchTerm(lower);
      if (query) {
        return [buildTask("package.winget.search", { query }, {
          goal: `Search WinGet for ${query}`,
          description: `Search Windows Package Manager for "${query}"`,
          riskHints: "LOW",
          completionCriteria: [`WinGet search for ${query} complete`],
          timeout: 30000
        })];
      }
    }

    // --- WORKFLOW C: file/folder creation (bounded, multi-step) ---------------
    // Only compose filesystem mutations when the request clearly asks to create
    // a folder/file. The target is a BOUNDED demo directory under the system temp
    // dir — never an arbitrary caller-supplied path through this fallback.
    const wantsFolder = /\b(folder|directory|workspace)\b/.test(lower) && /\b(create|make|new|set up|setup)\b/.test(lower);
    const wantsFile = /\b(file|config|readme|\.txt|\.json)\b/.test(lower) && /\b(create|make|new|write|add|put)\b/.test(lower);
    if (wantsFolder || wantsFile) {
      const dir = this._safeDemoDir(entities);
      const fileName = this._safeFileName(entities) ?? "config.json";
      const filePath = path.join(dir, fileName);
      const content = typeof entities.content === "string" ? entities.content : "{\n  \"createdBy\": \"SYSCORA\"\n}\n";
      const mkdir = buildTask("filesystem.createDirectory", { directoryPath: dir }, {
        goal: "Create folder",
        description: `Create the folder ${dir}`,
        riskHints: "MEDIUM",
        expectedStateChanges: ["directory"],
        completionCriteria: ["Directory exists"],
        rollbackRequired: false,
        timeout: 10000
      });
      const write = buildTask("filesystem.write", { filePath, content }, {
        goal: "Create config file",
        description: `Write ${filePath}`,
        riskHints: "MEDIUM",
        dependencies: [mkdir.taskId],
        expectedStateChanges: ["file"],
        completionCriteria: ["File written and verified"],
        rollbackRequired: true,
        timeout: 10000
      });
      const read = buildTask("filesystem.read", { filePath }, {
        goal: "Verify config file",
        description: `Read back ${filePath} to confirm it exists`,
        riskHints: "LOW",
        dependencies: [write.taskId],
        completionCriteria: ["File contents confirmed"],
        timeout: 10000
      });
      return [mkdir, write, read];
    }

    // --- WORKFLOW E: project inspection (read-only) ---------------------------
    const wantsProject = /\b(project|repo|repository|codebase|this code)\b/.test(lower)
      && /\b(inspect|analyz|run|start|set up|setup|need|require|depend|stack|how do i)\b/.test(lower);
    if (wantsProject) {
      const tasks = [buildTask("environment.project.inspect", { workspacePath }, {
        goal: "Inspect project",
        description: "Inspect the project workspace for type, tooling, and setup",
        riskHints: "LOW",
        completionCriteria: ["Project inspected"],
        timeout: 15000
      })];
      // Enrich read-only signals: git + package manager, independent tasks.
      tasks.push(buildTask("git.repository.inspect", { workspacePath }, {
        goal: "Inspect git repository",
        description: "Inspect the git repository state",
        riskHints: "LOW",
        completionCriteria: ["Git repository inspected"],
        timeout: 10000
      }));
      tasks.push(buildTask("package.manager.inspect", { workspacePath }, {
        goal: "Inspect package manager",
        description: "Detect the project's package manager",
        riskHints: "LOW",
        completionCriteria: ["Package manager detected"],
        timeout: 15000
      }));
      return tasks;
    }

    // --- WORKFLOW A: system + developer intelligence (read-only) --------------
    // Broadest family: "tell me about this computer", "what dev tools are
    // installed", "inspect my PC", "what's installed for development". Composes a
    // read-only snapshot: system info + developer tooling (git/docker/pkg-mgr).
    const wantsSystem = /\b(system|computer|machine|pc|this box|hardware|spec)\b/.test(lower);
    const wantsDevTools = /\b(dev|develop|development|tool|tooling|git|node|docker|python|installed|environment)\b/.test(lower);
    if (wantsSystem || wantsDevTools) {
      const tasks = [buildTask("system.inspect", {}, {
        goal: "Inspect system",
        description: "Retrieve system summary (OS, hardware, environment)",
        riskHints: "LOW",
        completionCriteria: ["Got system info"],
        timeout: 10000
      })];
      if (wantsDevTools) {
        tasks.push(buildTask("git.repository.inspect", { workspacePath }, {
          goal: "Check Git",
          description: "Inspect Git availability / repository",
          riskHints: "LOW",
          completionCriteria: ["Git checked"],
          timeout: 10000
        }));
        tasks.push(buildTask("docker.environment.inspect", { workspacePath }, {
          goal: "Check Docker",
          description: "Inspect Docker environment availability",
          riskHints: "LOW",
          completionCriteria: ["Docker checked"],
          timeout: 15000
        }));
        tasks.push(buildTask("package.manager.inspect", { workspacePath }, {
          goal: "Check package managers",
          description: "Detect available package managers",
          riskHints: "LOW",
          completionCriteria: ["Package managers checked"],
          timeout: 15000
        }));
      } else if (/\bprocess\b/.test(lower)) {
        tasks.push(buildTask("processes.list", {}, {
          goal: "List processes",
          description: "List running processes",
          riskHints: "LOW",
          completionCriteria: ["Got process list"],
          timeout: 15000
        }));
      }
      return tasks;
    }

    // --- Legacy narrow matches preserved for explicit env/notepad requests ----
    if (userIntent.category === "ENVIRONMENT" && lower.includes("path")) {
      return [buildTask("environment.user.inspect", {}, {
        goal: "Inspect environment",
        description: "Get user environment",
        riskHints: "LOW",
        completionCriteria: ["Got env info"],
        timeout: 5000
      })];
    }
    if (userIntent.category === "PROJECT" && entities.key && entities.value) {
      return [buildTask("environment.project.set", {
        workspacePath, key: entities.key, value: entities.value
      }, {
        goal: "Set env var",
        description: "Set project environment variable",
        riskHints: "MEDIUM",
        expectedStateChanges: ["env.file"],
        completionCriteria: ["Env var is set and verified"],
        rollbackRequired: true,
        timeout: 10000
      })];
    }
    if (userIntent.category === "APPLICATION" && entities.content && entities.filename) {
      return [buildTask("application.notepad.launch", {
        content: entities.content, filename: entities.filename
      }, {
        goal: "Notepad task",
        description: "Open Notepad and save",
        riskHints: "MEDIUM",
        expectedStateChanges: ["user.documents"],
        completionCriteria: ["File saved"],
        timeout: 45000,
        idempotency: false
      })];
    }
    return [];
  }

  _extractPort(lower) {
    const m = lower.match(/\bport\s+(\d{2,5})\b/) || lower.match(/\b(\d{2,5})\b/);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : null;
  }

  // Pull a package/app search term out of common phrasings. Falls back to null
  // (the caller then declines to build a search task) rather than guessing.
  _extractSearchTerm(lower) {
    const patterns = [
      /(?:search|find|look up|discover)(?:\s+winget\s+for|\s+for)?\s+([a-z0-9.+\- ]{2,40}?)(?:\s+(?:using|with|via|on|in)\b|[.?!]|$)/,
      /winget\s+(?:for\s+)?([a-z0-9.+\- ]{2,40})/,
      /package\s+(?:for\s+)?([a-z0-9.+\- ]{2,40})/
    ];
    for (const re of patterns) {
      const m = lower.match(re);
      if (m && m[1]) {
        const term = m[1].trim().replace(/\b(package|app|application|software)\b/g, "").trim();
        if (term) return term;
      }
    }
    return null;
  }

  // A bounded, safe demo directory. The deterministic fallback NEVER writes to an
  // arbitrary caller path — it uses a fixed folder under the OS temp dir so a
  // broad NL request can't target sensitive locations. A model-driven plan can
  // still request other (policy-gated) paths; this constraint is fallback-only.
  _safeDemoDir(entities) {
    const raw = typeof entities.folderName === "string" ? entities.folderName : "SYSCORA Demo";
    const safe = raw.replace(/[^a-z0-9 _.-]/gi, "").trim().slice(0, 64) || "SYSCORA Demo";
    return path.join(os.tmpdir(), "syscora-demo", safe);
  }

  _safeFileName(entities) {
    const raw = typeof entities.filename === "string" ? entities.filename : null;
    if (!raw) return null;
    const safe = raw.replace(/[^a-z0-9 _.-]/gi, "").trim().slice(0, 64);
    return safe || null;
  }

  // Compile explicit, bounded file-state requests into ordinary filesystem
  // capabilities. This is deliberately grammar-based rather than prompt-based:
  // every named file operation is retained in order, including successive
  // writes to the same file, and final reads independently verify each output.
  _explicitFilesystemTasks(userIntent, workspacePath) {
    const raw = String(userIntent.rawText ?? "");
    if (!/\b(?:create|write|modify|update)\b/i.test(raw) || !/\.[a-z0-9]{1,8}\b/i.test(raw)) return [];

    const requestedDirectory = raw.match(/\b(?:directory|folder)\s+(?:named|called)\s+["'`]?([^"',.;]+?)["'`]?(?=\s*[,.;]|\s+(?:containing|with)\b|$)/i)?.[1]?.trim();
    const safeDirectory = requestedDirectory
      ? requestedDirectory.replace(/[^a-z0-9 _.-]/gi, "").trim().slice(0, 64)
      : "";
    const root = path.resolve(workspacePath);
    const directoryPath = safeDirectory ? path.resolve(root, safeDirectory) : root;
    if (directoryPath !== root && !directoryPath.startsWith(`${root}${path.sep}`)) return [];

    const operations = [];
    const operationPattern = /\b(create|write|modify|update|change|rewrite)\s+(?:the\s+)?(?:file\s+)?["'`]?([a-z0-9][a-z0-9 _-]*\.[a-z0-9]{1,8})["'`]?\s+(?:with\s+(?:exact\s+)?(?:final\s+)?content(?:\s+(?:of|equal\s+to))?\s+|so\s+(?:that\s+)?its?\s+(?:exact\s+)?(?:final\s+)?content\s+is\s+|to\s+(?:(?:contain(?:s)?(?:\s+exactly)?|read|be)\s+)?)["'`]?([^,"'`;]+?)["'`]?(?=\s*,|\s+then\b|[.;]|$)/gi;
    for (const match of raw.matchAll(operationPattern)) {
      const fileName = match[2].replace(/[^a-z0-9 _.-]/gi, "").trim().slice(0, 64);
      const content = match[3].trim();
      if (!fileName || !content || path.basename(fileName) !== fileName) return [];
      operations.push({ operation: match[1].toLowerCase(), fileName, content });
    }
    if (operations.length === 0) return [];

    const tasks = [];
    let dependency = null;
    if (safeDirectory) {
      const mkdir = buildTask("filesystem.createDirectory", { directoryPath }, {
        goal: `Create directory ${safeDirectory}`,
        description: `Create requested directory ${directoryPath}`,
        riskHints: "MEDIUM",
        expectedStateChanges: ["directory"],
        completionCriteria: [`Directory ${safeDirectory} exists`],
        timeout: 10000
      });
      tasks.push(mkdir);
      dependency = mkdir.taskId;
    }

    const lastWriteByFile = new Map();
    for (const operation of operations) {
      const filePath = path.join(directoryPath, operation.fileName);
      const write = buildTask("filesystem.write", { filePath, content: operation.content }, {
        goal: `${operation.operation} ${operation.fileName} with exact content ${operation.content}`,
        description: `${operation.operation} ${filePath} with exact content ${operation.content}`,
        dependencies: dependency ? [dependency] : [],
        riskHints: "MEDIUM",
        expectedStateChanges: ["file"],
        completionCriteria: [`${operation.fileName} contains exactly ${operation.content}`],
        rollbackRequired: true,
        timeout: 10000
      });
      tasks.push(write);
      dependency = write.taskId;
      lastWriteByFile.set(operation.fileName.toLowerCase(), write);
    }

    for (const write of lastWriteByFile.values()) {
      tasks.push(buildTask("filesystem.read", { filePath: write.inputs.filePath }, {
        goal: `Verify exact final content of ${path.basename(write.inputs.filePath)}`,
        description: `Read ${write.inputs.filePath} and verify exact final content ${write.inputs.content}`,
        dependencies: [write.taskId],
        completionCriteria: [`Exact final content is ${write.inputs.content}`],
        verificationCriteria: [`Read-back equals ${write.inputs.content}`],
        timeout: 10000
      }));
    }
    return tasks;
  }
}
