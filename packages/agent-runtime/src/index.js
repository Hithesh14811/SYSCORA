import path from "node:path";
import {
  PolicyEffect,
  RuntimeState,
  RiskDimension,
  ConfirmationLevel,
  createId,
  validateExecutionSession,
  validateIntent
} from "../../shared-types/src/domain.js";
import { IntentEngine } from "../../intent-engine/src/index.js";
import { ContextEngine, SystemContextProvider, ProcessContextProvider, PortContextProvider, EnvironmentContextProvider, WorkspaceContextProvider } from "../../context-engine/src/index.js";
import { GeneralPlanner, OPERATION_PLANS, PlanValidator, assessPlanGoalCoverage } from "../../planner/src/index.js";
import { MockModelProvider, validateSchema } from "../../model-providers/src/index.js";
import { TaskGraphScheduler } from "../../task-graph-scheduler/src/index.js";
import { PerceptionEngine } from "../../perception/src/index.js";
import { ReasoningEngine } from "../../reasoning-engine/src/index.js";
import { GoalVerifier } from "./goal-verifier.js";
import { RollbackManager } from "./rollback-manager.js";
import { createRecoveryBudget } from "../../recovery-engine/src/index.js";
import { resolveTaskInputs } from "./input-bindings.js";
import {
  InteractiveAgentController,
  buildBrowserCompositionStrategy,
  buildSupportedUiOperationStrategy,
  buildSupportedTextEntryStrategy,
  buildSupportedReadOnlyNavigationStrategy,
  buildSupportedBrowserReadStrategy,
  buildSupportedRankedProcessReadStrategy,
  InteractiveConvergenceState,
  enumerateGroundedActionCandidates,
  supportedUiActions,
  measureUiProgress,
  buildCrossModalTransferStrategy,
  buildInternalToGuiTransferStrategy,
  buildExplicitApplicationLaunchStrategy
} from "./interactive-agent-controller.js";
import { createGoalContract } from "../../shared-types/src/goal-contract.js";
import { summarizeReadOnlyResults } from "./read-result-summary.js";

export {
  InteractiveAgentController,
  InteractiveConvergenceState,
  enumerateGroundedActionCandidates,
  supportedUiActions,
  measureUiProgress,
  buildSupportedUiOperationStrategy,
  buildSupportedTextEntryStrategy,
  buildSupportedReadOnlyNavigationStrategy,
  buildSupportedBrowserReadStrategy,
  buildSupportedRankedProcessReadStrategy,
  sanitizeInteractiveState,
  classifyInteractiveContext,
  INTERACTIVE_AGENT_DEFAULT_BUDGETS
} from "./interactive-agent-controller.js";

const RECOVERY_VOLATILE_KEYS = new Set([
  "at", "timestamp", "observedAt", "capturedAt", "createdAt", "updatedAt", "elapsedMs"
]);

function stableRecoveryFingerprint(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort()
      .filter((key) => !RECOVERY_VOLATILE_KEYS.has(key))
      .map((key) => [key, normalize(item[key])]));
  };
  try { return JSON.stringify(normalize(value)); } catch { return String(value); }
}

export class AgentRuntime {
  constructor({
    sessionStore,
    auditRepository,
    capabilityRegistry,
    riskEngine,
    policyEngine,
    permissionBroker,
    recoveryEngine,
    troubleshootingEngine,
    adapter,
    modelProvider,
    reasoningEngine,
    secretBroker,
    intentEngine,
    contextEngine,
    semanticState,
    memory
  }) {
    this.sessionStore = sessionStore;
    this.auditRepository = auditRepository;
    this.capabilityRegistry = capabilityRegistry;
    this.riskEngine = riskEngine;
    this.policyEngine = policyEngine;
    this.permissionBroker = permissionBroker;
    this.recoveryEngine = recoveryEngine;
    this.troubleshootingEngine = troubleshootingEngine;
    this.adapter = adapter;
    this.developerIntelligence = null;
    const provider = modelProvider || new MockModelProvider();
    // The ReasoningEngine is the single boundary to any language model. The
    // runtime and its sub-engines never call a provider directly; they ask the
    // ReasoningEngine to reason and always keep their deterministic fallback.
    this.reasoningEngine = reasoningEngine || new ReasoningEngine({
      modelProvider: provider,
      capabilityRegistry: this.capabilityRegistry
    });
    // The secret broker (DPAPI) supplies secrets to capability execution only.
    // It is NEVER passed to the reasoning engine or included in prompts/audit.
    this.secretBroker = secretBroker || null;
    this.intentEngine = intentEngine || new IntentEngine(this.reasoningEngine);
    this.contextEngine = contextEngine || new ContextEngine([
      new SystemContextProvider(adapter),
      new ProcessContextProvider(adapter),
      new PortContextProvider(adapter),
      new EnvironmentContextProvider(adapter)
    ]);
    this.generalPlanner = new GeneralPlanner(this.reasoningEngine, this.capabilityRegistry);
    this.planValidator = new PlanValidator(this.capabilityRegistry);
    this.goalVerifier = new GoalVerifier(this.capabilityRegistry);
    this.semanticState = semanticState;
    this.memory = memory;
    // Perception is the ONLY subsystem that writes to SemanticState. The runtime
    // never touches SemanticState directly; it goes through this engine, whose
    // events are forwarded to the audit trail.
    this.perception = semanticState
      ? PerceptionEngine.withDefaultProviders({
          semanticState,
          adapter,
          developerIntelligence: null,
          onEvent: (event) => {
            // Best-effort audit of perception events (fire-and-forget).
            this.auditRepository?.append?.("perception", event.type, event).catch?.(() => {});
          }
        })
      : null;
    this.taskGraphScheduler = new TaskGraphScheduler({
      capabilityRegistry,
      recoveryEngine,
      troubleshootingEngine,
      adapter
    });
    this.rollbackManager = new RollbackManager(capabilityRegistry);
    // The session.rollback capability performs the actual restore through the
    // SAME RollbackManager instance the runtime uses, so manual and automatic
    // rollback share one journal/execution path. Wired here (not at registry
    // construction) because the manager needs the registry, and the capability
    // needs the manager — a late DI setter breaks the cycle without a new module.
    if (typeof this.capabilityRegistry?.setRollbackManager === "function") {
      this.capabilityRegistry.setRollbackManager(this.rollbackManager);
    }
  }

  setDeveloperIntelligence(engine) {
    this.developerIntelligence = engine;
    if (this.developerIntelligence) {
      const workspaceProvider = new WorkspaceContextProvider(this.adapter, this.developerIntelligence);
      this.contextEngine.providers = this.contextEngine.providers.filter((provider) => provider.name !== "workspace");
      this.contextEngine.providers.push(workspaceProvider);
      // Rebuild perception providers so the DeveloperProvider has the engine.
      if (this.perception && this.semanticState) {
        this.perception = PerceptionEngine.withDefaultProviders({
          semanticState: this.semanticState,
          adapter: this.adapter,
          developerIntelligence: this.developerIntelligence,
          onEvent: (event) => {
            this.auditRepository?.append?.("perception", event.type, event).catch?.(() => {});
          }
        });
      }
    }
  }

  _createSession(options = {}) {
    return {
      sessionId: createId("session"),
      createdAt: new Date().toISOString(),
      receivedAtMs: Date.now(),
      currentState: RuntimeState.RECEIVE_INTENT,
      intent: null,
      goalContract: null,
      context: null,
      plan: null,
      riskAssessment: null,
      policyDecision: null,
      rollback: { records: [], completed: false, result: null },
      taskResults: [],
      observations: [],
      verifications: [],
      diagnoses: [],
      recoveryBudget: createRecoveryBudget(),
      replanAttempts: 0,
      finalResponse: null,
      events: [],
      autoApprove: options.autoApprove === true
    };
  }

  async submitIntent(rawText, options = {}) {
    const timeoutMs = Number(options.maxElapsedTime);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return this._submitIntent(rawText, options);
    }

    let startedSessionId = null;
    let activeSession = null;
    let timer = null;
    const deadlineController = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const callerStarted = options.onSessionStarted;
    const work = this._submitIntent(rawText, {
      ...options,
      deadlineAt,
      deadlineSignal: deadlineController.signal,
      onSessionCreated: (session) => { activeSession = session; },
      onSessionStarted: (sessionId) => {
        startedSessionId = sessionId;
        callerStarted?.(sessionId);
      }
    });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(async () => {
        deadlineController.abort(new Error("SESSION_DEADLINE_EXCEEDED"));
        const timedOut = activeSession ?? {
          sessionId: startedSessionId ?? createId("session_timeout"),
          createdAt: new Date().toISOString(),
          intent: null,
          plan: null,
          taskResults: [],
          observations: [],
          verifications: [],
          events: []
        };
        timedOut.currentState = RuntimeState.TIMED_OUT;
        timedOut.deadlineExceeded = true;
        timedOut.deadlineAt = new Date(deadlineAt).toISOString();
        timedOut.finalResponse = {
          status: "TIMED_OUT",
          message: `Session exceeded its ${timeoutMs}ms wall-clock deadline.`,
          timeoutMs
        };
        try {
          await this.addSessionEvent(timedOut, "SESSION_TIMED_OUT", { timeoutMs, deadlineAt });
          await this.persistSession(timedOut);
        } catch { /* the terminal result still returns even if persistence is unavailable */ }
        resolve(timedOut);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  _assertSessionActive(session, options = {}) {
    if (session?.deadlineExceeded || options.deadlineSignal?.aborted ||
        (Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt)) {
      const error = new Error("SESSION_DEADLINE_EXCEEDED");
      error.code = "SESSION_DEADLINE_EXCEEDED";
      throw error;
    }
  }

  async _submitIntent(rawText, options = {}) {
    const MAX_REPLAN_ATTEMPTS = 2; // Bounded replanning - max 2 attempts
    let replanAttempts = 0;
    let originalPlan = null;
    
    const session = {
      sessionId: createId("session"),
      createdAt: new Date().toISOString(),
      receivedAtMs: Date.now(),
      currentState: RuntimeState.RECEIVE_INTENT,
      intent: null,
      goalContract: null,
      context: null,
      plan: null,
      riskAssessment: null,
      policyDecision: null,
      rollback: { records: [], completed: false, result: null },
      taskResults: [],
      observations: [],
      verifications: [],
      diagnoses: [],
      recoveryBudget: createRecoveryBudget(),
      // Replan attempts are session state, not request-local state. A session
      // may pause for approval between replans, so this counter must survive
      // resume instead of resetting and reopening the recovery loop.
      replanAttempts: 0,
      finalResponse: null,
      events: [],
      // The caller's standing authorization for this session. Recorded so a
      // replan re-enters the SAME authorization gate with the same standing
      // (an autoApprove caller does not have to re-confirm an equivalent plan,
      // but a materially riskier replan is still re-gated — see _authorizePlan).
      autoApprove: options.autoApprove === true
    };
    session.deadlineAt = Number.isFinite(options.deadlineAt)
      ? new Date(options.deadlineAt).toISOString()
      : null;
    options.onSessionCreated?.(session);
    options.onSessionStarted?.(session.sessionId);

    await this.addSessionEvent(session, "INTENT_RECEIVED", { rawText });
    await this.persistSession(session);

    try {
      const availability = await this.capabilityRegistry?.refreshAvailability?.({ platform: process.platform }) ?? [];
      await this.addSessionEvent(session, "CAPABILITY_CATALOG_REFRESHED", {
        checked: availability.length,
        available: availability.filter((item) => item.available).length,
        unavailable: availability.filter((item) => !item.available).map((item) => ({ name: item.name, reason: item.reason }))
      });
      this._assertSessionActive(session, options);
      // 1. Understand intent
      session.currentState = RuntimeState.BUILD_CONTEXT;
      session.intent = await this.intentEngine.classify(rawText, { workspacePath: process.cwd(), ...options });
      this._assertSessionActive(session, options);
      session.intent.operationProvenance = options.operation
        ? "EXPLICIT_CONTEXT"
        : (session.intent.operation ? "NATURAL_LANGUAGE_ROUTED" : null);
      session.goalContract = session.intent.operationProvenance === "EXPLICIT_CONTEXT"
        ? null
        : createGoalContract(session.intent);
      session.intent.goalContract = session.goalContract;
      await this.addSessionEvent(session, "INTENT_CLASSIFIED", session.intent);
      if (session.goalContract) {
        await this.addSessionEvent(session, "GOAL_CONTRACT_CREATED", session.goalContract);
      }
      await this.persistSession(session);

      // Direct commands do not wait for a model plan, but they do not bypass the
      // LLM. Start a non-authoritative interpretation in parallel with the typed
      // execution lane. Its result is audited for context/diagnostics; it can
      // never replace the already-validated capability or widen its scope.
      if (session.intent.operation) this._startParallelIntentInterpretation(session, rawText);

      // 1b. CONVERSATIONAL FAST PATH (offline fallback only). When a REAL model is
      // healthy, every message goes through the LLM-first classifier + planner and
      // a greeting simply produces an empty plan → the model `converse` path below
      // answers it, so no keyword heuristic pre-empts the model. This regex
      // shortcut therefore runs ONLY when the model is unavailable/unhealthy: it
      // keeps a greeting from triggering a bogus deterministic plan offline while
      // never overriding the model when one is present. It performs NO actions and
      // mutates NO state.
      const modelHealthyForConversational = this.reasoningEngine?.hasModel?.()
        ? await this._isModelHealthy()
        : false;
      if (!modelHealthyForConversational && this._looksConversational(rawText)) {
        let conversational = null;
        try {
          const catalog = (this.capabilityRegistry?.getCatalog?.() ?? []).map((c) => c.name);
          const c = await this.reasoningEngine?.converse?.(rawText, { capabilities: catalog });
          if (c?.ok) conversational = c.text;
        } catch { /* best-effort; fall through to clarification below */ }
        if (conversational) {
          session.currentState = RuntimeState.COMPLETED;
          session.finalResponse = { status: "ANSWERED", message: conversational, rawText, conversational: true };
          await this.addSessionEvent(session, "CONVERSATIONAL_REPLY", { rawText });
          session.plan = null;
          await this.persistSession(session);
          return session;
        }
      }

      // 2. Collect context (including semantic state and memory). A known
      // read-only operation — or a direct, self-contained desktop action like a
      // Spotify play — already has its exact typed scope, so skip the expensive
      // advisory context/perception work; policy and capability verification
      // still run unchanged below.
      const fastReadOnlyOperation = new Set([
        "package.winget.inspect",
        "package.winget.search",
        "system.inspect",
        "system.summary",
        "processes.list",
        "process.port.inspect",
        "environment.user.inspect",
        "application.launch",
        "browser.search",
        "system.volume.adjust",
        "spotify.track.open",
        "spotify.track.play"
      ]).has(session.intent.operation);
      // When the model is unavailable, semantic/memory collection cannot improve
      // the deterministic fallback plan but can add several seconds of Windows
      // inspection. Keep required base context, skip only this advisory layer.
      const skipAdvisoryPlanningState = fastReadOnlyOperation || !modelHealthyForConversational;
      const requiredContext = session.intent.requiredContext || [];
      const baseContext = await this.contextEngine.collectContext(requiredContext, session.intent.entities);
      this._assertSessionActive(session, options);
      let semanticContext = [];
      let relevantMemory = [];
      
      // Perception populates the world model from live Windows state (via its
      // read-only providers), then the planner receives only a relevant, budgeted
      // subgraph — never the whole graph.
      if (this.perception && !skipAdvisoryPlanningState) {
        try {
          await this.perception.perceive({
            workspacePath: session.intent.entities?.workspacePath,
            directoryPath: session.intent.entities?.workspacePath,
            port: session.intent.entities?.port
          });
        } catch { /* perception is best-effort; execution proceeds regardless */ }
        const subgraph = await this.perception.getRelevantSubgraph(session.intent, { budget: 25 });
        semanticContext = subgraph.entities;
        session.semanticSubgraph = subgraph;
      }

      if (this.memory && !skipAdvisoryPlanningState) {
        relevantMemory = await this.memory.retrieveRelevant(session.intent);
      }

      const planningContext = this.contextEngine.buildPlanningContext({
        intent: session.intent,
        baseContext,
        semanticSubgraph: session.semanticSubgraph,
        memory: relevantMemory,
        capabilityRegistry: this.capabilityRegistry,
        policyConstraints: session.intent.constraints,
        recoveryBudget: session.recoveryBudget
      });
      session.context = { baseContext, semanticState: semanticContext, memory: relevantMemory, planningContext };

      await this.addSessionEvent(session, "CONTEXT_COLLECTED", {
        types: requiredContext,
        includesSemantic: !skipAdvisoryPlanningState && !!this.semanticState,
        includesMemory: !skipAdvisoryPlanningState && !!this.memory,
        estimatedTokens: planningContext.estimatedTokens,
        tokenBudget: planningContext.tokenBudget
      });
      await this.persistSession(session);

      // Memory influences planning: surface the ranked, relevant memories that
      // will inform the plan (reusable procedural recipes, prior failure
      // patterns to avoid). The most relevant memories are passed to the planner.
      const priorProcedures = relevantMemory.filter((m) => m.type === "PROCEDURAL");
      const priorFailures = relevantMemory.filter((m) => m.type === "FAILURE_PATTERN");
      if (relevantMemory.length > 0) {
        await this.addSessionEvent(session, "MEMORY_APPLIED", {
          total: relevantMemory.length,
          procedural: priorProcedures.length,
          failurePatterns: priorFailures.length,
          topSummaries: relevantMemory.slice(0, 3).map((m) => m.summary)
        });
      }

      // Clearly interactive free-text goals should enter the closed-loop
      // controller before paying for a one-shot task-graph composition. This is
      // a modality-level routing rule, not an application workflow: typed
      // operations keep their static fast path, while generic open/select/type/
      // navigate goals require live perception and adaptation.
      const hasLocalInteractiveStrategy = Boolean(
        buildBrowserCompositionStrategy(rawText) ??
        buildCrossModalTransferStrategy(rawText) ??
        buildInternalToGuiTransferStrategy(rawText) ??
        buildExplicitApplicationLaunchStrategy(rawText)
      );
      // A known typed operation already has a deterministic capability graph.
      // Preserve that graph ahead of generic UI reasoning for every operation,
      // not just for individual applications. The typed capability remains
      // responsible for its own grounding and postcondition evidence.
      const hasDirectOperationPlan = Boolean(
        session.intent.operation && OPERATION_PLANS[session.intent.operation]
      );
      const earlyInteractiveGoal =
        !hasDirectOperationPlan &&
        (!session.intent.operation || hasLocalInteractiveStrategy) &&
        (
          ["APPLICATION", "BROWSER"].includes(String(session.intent.category ?? "").toUpperCase()) ||
          /\b(open|launch|select|choose|click|type|enter|put|navigate|browser|website)\b/i.test(rawText) ||
          /\bread\b[\s\S]{0,120}\b(?:into|in)\b/i.test(rawText)
        );
      if (
        options.interactive !== false &&
        earlyInteractiveGoal &&
        typeof this.reasoningEngine?.decideInteractiveAction === "function" &&
        (hasLocalInteractiveStrategy || await this._isModelHealthy())
      ) {
        const interactive = await this._runInteractiveController(session, rawText, options);
        if (interactive.status === "COMPLETE" || interactive.status === "NEEDS_USER") return session;
        session.currentState = RuntimeState.FAILED;
        session.finalResponse = {
          status: "FAILED",
          message: `Adaptive reasoning could not complete the request safely: ${interactive.reason ?? "reasoning unavailable"}.`,
          reason: interactive.reason ?? "INTERACTIVE_REASONING_FAILED",
          interactive: true,
          metrics: interactive.metrics
        };
        await this.addSessionEvent(session, "INTERACTIVE_REASONING_FAILED", {
          reason: interactive.reason,
          metrics: interactive.metrics
        });
        session.plan = null;
        await this.persistSession(session);
        return session;
      }

      // 3. Generate plan (memory + semantic state passed as planning inputs)
      session.currentState = RuntimeState.GENERATE_PLAN;
      session.plan = await this.generalPlanner.generatePlan(
        session.intent,
        planningContext,
        semanticContext,
        relevantMemory,
        { priorProcedures, priorFailures }
      );
      this._assertSessionActive(session, options);
      originalPlan = session.plan;

      // Graceful no-plan path (MVP). When neither a model nor the deterministic
      // planner could map the request to any capability, the task graph is empty.
      // Persisting/validating that would throw ("taskGraph.tasks must contain at
      // least one task"), so instead we return a friendly NEEDS_CLARIFICATION
      // response that the UI can show — never a protocol crash on a request the
      // system simply doesn't know how to handle yet.
      const plannedTasks = session.plan?.taskGraph?.tasks ?? [];
      if (plannedTasks.length === 0) {
        const canTryInteractive = options.interactive !== false &&
          !this._looksConversational(rawText) &&
          typeof this.reasoningEngine?.decideInteractiveAction === "function" &&
          await this._isModelHealthy();
        if (canTryInteractive) {
          const interactive = await this._runInteractiveController(session, rawText, options);
          if (interactive.status === "COMPLETE" || interactive.status === "NEEDS_USER") {
            return session;
          }
          session.currentState = RuntimeState.FAILED;
          session.finalResponse = {
            status: "FAILED",
            message: `Adaptive reasoning could not complete the request safely: ${interactive.reason ?? "reasoning unavailable"}.`,
            reason: interactive.reason ?? "INTERACTIVE_REASONING_FAILED",
            interactive: true,
            metrics: interactive.metrics
          };
          await this.addSessionEvent(session, "INTERACTIVE_REASONING_FAILED", {
            reason: interactive.reason,
            metrics: interactive.metrics
          });
          session.plan = null;
          await this.persistSession(session);
          return session;
        }
        // The request did not map to any capability. Before giving up, try a
        // pure conversational answer via the model (greetings, "what model are
        // you", capability questions). This performs NO actions and mutates NO
        // state — it only replies with text. If the model is unavailable or
        // declines, fall back to the honest clarification message.
        let conversational = null;
        try {
          const catalog = (this.capabilityRegistry?.getCatalog?.() ?? []).map((c) => c.name);
          const c = await this.reasoningEngine?.converse?.(rawText, { capabilities: catalog });
          if (c?.ok) conversational = c.text;
        } catch { /* conversational is best-effort; fall through to clarification */ }

        session.currentState = RuntimeState.FAILED;
        session.finalResponse = conversational
          ? { status: "ANSWERED", message: conversational, rawText, conversational: true }
          : {
              status: "NEEDS_CLARIFICATION",
              message:
                "I couldn't map that request to something I know how to do yet. Try rephrasing, " +
                "or ask for one of my supported actions (inspect the system, list processes, " +
                "check a port, read/write files, inspect a project, search or install a package).",
              rawText
            };
        await this.addSessionEvent(session, conversational ? "CONVERSATIONAL_REPLY" : "PLAN_EMPTY_NEEDS_CLARIFICATION", { rawText });
        // Persist WITHOUT the full plan object (empty graph fails validation).
        session.plan = null;
        await this.persistSession(session);
        return session;
      }

      // Untyped application/browser work needs closed-loop perception rather
      // than a one-shot graph. Route it through the adaptive controller whether
      // the candidate came from the model or deterministic planning. Typed
      // operations and non-interactive system/data plans keep the fast path.
      const plannedCapabilities = plannedTasks.map((task) => String(task.capability ?? ""));
      const inferredRouteCoverage = session.intent.operationProvenance !== "EXPLICIT_CONTEXT"
        ? assessPlanGoalCoverage(session.intent, session.plan.taskGraph, this.capabilityRegistry)
        : { covered: true };
      const needsClosedLoopInteraction =
        ["APPLICATION", "BROWSER"].includes(String(session.intent.category ?? "").toUpperCase()) ||
        plannedCapabilities.some((name) => /^(ui|window|pointer|keyboard|browser)\./.test(name));
      if (
        options.interactive !== false &&
        (!session.intent.operation || !inferredRouteCoverage.covered) &&
        needsClosedLoopInteraction &&
        typeof this.reasoningEngine?.decideInteractiveAction === "function" &&
        await this._isModelHealthy()
      ) {
        const candidatePlan = session.plan;
        const interactive = await this._runInteractiveController(session, rawText, options);
        if (interactive.status === "COMPLETE" || interactive.status === "NEEDS_USER") return session;
        session.plan = candidatePlan;
        session.currentState = RuntimeState.GENERATE_PLAN;
        session.finalResponse = null;
        await this.addSessionEvent(session, "INTERACTIVE_CONTROLLER_RESTORED_STATIC_PLAN", {
          reason: interactive.reason ?? "interactive-controller-did-not-complete"
        });
      }

      // An untyped keyword plan is permitted only when its concrete tasks
      // semantically cover the original user goal. This is the fail-closed
      // boundary that prevents a novel cross-modal request from degenerating
      // into an unrelated but internally successful developer/system workflow.
      const inferredNonModelPlan =
        session.intent.operationProvenance !== "EXPLICIT_CONTEXT" &&
        ["DIRECT_OPERATION", "DETERMINISTIC_FALLBACK"].includes(session.plan?.plannerSource);
      if (inferredNonModelPlan) {
        const coverage = assessPlanGoalCoverage(session.intent, session.plan.taskGraph, this.capabilityRegistry);
        await this.addSessionEvent(session, "DETERMINISTIC_PLAN_COVERAGE_CHECKED", coverage);
        if (!coverage.covered) {
          session.currentState = RuntimeState.FAILED;
          session.finalResponse = {
            status: "FAILED",
            message:
              "The language-model route is unavailable or could not produce a safe plan, and the deterministic fallback does not cover the requested goal. No unrelated actions were run.",
            reason: "IRRELEVANT_DETERMINISTIC_FALLBACK",
            coverage
          };
          await this.addSessionEvent(session, "IRRELEVANT_DETERMINISTIC_FALLBACK_REJECTED", coverage);
          session.plan = null;
          await this.persistSession(session);
          return session;
        }
      }

      await this.addSessionEvent(session, "PLAN_GENERATED", session.plan);
      // Distinguish, in the audit, whether the MODEL or the DETERMINISTIC
      // fallback produced this plan — never let a fallback look like reasoning.
      await this.addSessionEvent(session, "PLANNER_SOURCE", { source: session.plan?.plannerSource ?? "DETERMINISTIC_FALLBACK" });
      await this.persistSession(session);

      // 4-7. Validate -> assess risk -> apply policy -> evaluate approval, all
      // through the ONE canonical plan authorization gate. Initial plans and
      // replans call the identical gate, so a plan can never reach execution
      // without a fresh risk assessment, policy decision, and approval bound to
      // its exact cryptographic commitment.
      const gate = await this._authorizePlan(session, session.plan, {
        phase: "INITIAL",
        autoApprove: options.autoApprove === true
      });
      this._assertSessionActive(session, options);
      if (!gate.authorized) {
        // The gate set session.currentState + finalResponse (PLAN_REJECTED /
        // DENIED / AWAITING_APPROVAL) and persisted the session.
        return session;
      }

      // 8. Execute tasks with TaskGraphScheduler (single canonical pipeline).
      session.currentState = RuntimeState.EXECUTING;
      const execResult = await this._executeTaskGraph(session, { replanAttempts, MAX_REPLAN_ATTEMPTS, originalPlan });
      this._assertSessionActive(session, options);

      // 9-11. Update semantic state + memory, then final goal verification.
      // Skip finalization if the loop already reached a terminal state
      // (rollback / hard failure / awaiting approval) so we don't overwrite it.
      if (!execResult?.terminated) {
        await this._finalizeSession(session);
      }
      return session;
    } catch (error) {
      if (session.deadlineExceeded || error?.code === "SESSION_DEADLINE_EXCEEDED") return session;
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = { status: "FAILED", message: error.message };
      await this.addSessionEvent(session, "ERROR_OCCURRED", { error: error.message });
      await this.persistSession(session);
      return session;
    }
  }

  _startParallelIntentInterpretation(session, rawText) {
    if (!this.reasoningEngine?.hasModel?.()) return;
    void this.reasoningEngine.understandIntent(rawText, { parallel: true })
      .then(async (result) => {
        await this.addSessionEvent(session, "LLM_PARALLEL_INTERPRETATION", {
          status: result?.ok ? "COMPLETED" : "UNAVAILABLE",
          normalizedGoal: result?.ok ? result.data?.normalizedGoal ?? null : null,
          confidence: result?.ok ? result.data?.confidence ?? null : null,
          authoritativeOperation: session.intent?.operation ?? null
        });
      })
      .catch(() => {});
  }

  async _runInteractiveController(session, rawText, options = {}) {
    const remainingSessionMs = session.deadlineAt
      ? Math.max(1, Date.parse(session.deadlineAt) - Date.now())
      : null;
    const controller = new InteractiveAgentController({
      reasoningEngine: this.reasoningEngine,
      capabilityRegistry: this.capabilityRegistry,
      budgets: {
        ...(options.interactiveBudgets ?? {}),
        ...(remainingSessionMs != null
          ? { maxElapsedTime: Math.min(
              Number(options.interactiveBudgets?.maxElapsedTime ?? remainingSessionMs),
              remainingSessionMs
            ) }
          : {})
      },
      perceive: async (controllerState = {}) => {
        this._assertSessionActive(session, { deadlineAt: Date.parse(session.deadlineAt) });
        const windows = await this.adapter.listWindows().catch(() => []);
        const rawForeground = windows.find((window) => window.Foreground ?? window.foreground) ?? null;
        const goalTokens = new Set(
          String(controllerState.goal ?? rawText)
            .toLowerCase()
            .match(/[a-z0-9]{3,}/g)
            ?.filter((token) => !["and", "the", "with", "from", "tell", "whether", "open"].includes(token)) ?? []
        );
        const matchesGoal = (window) => {
          const identity = `${window?.ProcessName ?? window?.processName ?? ""} ${window?.MainWindowTitle ?? window?.title ?? ""}`.toLowerCase();
          return [...goalTokens].some((token) => identity.includes(token));
        };
        const visibleWindows = windows.filter((window) => {
          const bounds = window.Bounds ?? window.bounds ?? {};
          const titled = String(window.MainWindowTitle ?? window.title ?? "").trim();
          return titled && Number(bounds.width ?? 0) > 10 && Number(bounds.height ?? 0) > 10;
        });
        const relevantWindows = visibleWindows.filter(matchesGoal).slice(0, 12);
        const foreground = rawForeground && matchesGoal(rawForeground) ? rawForeground : null;
        const groundedWindow = foreground ?? relevantWindows[0] ?? null;
        let ui = null;
        if (groundedWindow) {
          try {
            ui = await this.adapter.inspectUi({
              application: groundedWindow.ProcessName ?? groundedWindow.processName,
              windowId: String(groundedWindow.WindowHandle ?? groundedWindow.windowId),
              maxElements: 100
            });
          } catch { /* UIA is an optional perception source */ }
        }
        let browser = null;
        try {
          if (this.adapter.browserAutomation?.connection) {
            browser = await this.adapter.browserDomAction("currentState", {});
          }
        } catch { /* browser may not be active */ }
        const rawControls = (ui?.elements ?? ui?.targets ?? []);
        const compactControls = rawControls.map((control) => ({
          targetId: control.targetId,
          source: control.source,
          windowId: control.windowId,
          automationId: control.automationId,
          name: control.name,
          controlType: control.controlType,
          boundingRect: control.boundingRect,
          enabled: control.enabled,
          focused: control.focused,
          supportedPatterns: control.supportedPatterns,
          toggleState: control.toggleState,
          expandCollapseState: control.expandCollapseState,
          confidence: control.confidence,
          observedAt: control.observedAt
        }));
        const scoredControls = compactControls
          .map((control, index) => {
            const semantics = `${control.name ?? ""} ${control.automationId ?? ""} ${control.controlType ?? ""}`.toLowerCase();
            const score = [...goalTokens].reduce((total, token) => total + (semantics.includes(token) ? 3 : 0), 0) +
              (control.supportedPatterns?.length ? 1 : 0) +
              (control.focused ? 1 : 0);
            return { control, score, index };
          })
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .slice(0, 24)
          .map(({ control }) => control);
        return {
          foregroundWindow: foreground,
          groundedWindow,
          windows: relevantWindows,
          relevantControls: scoredControls,
          browser
        };
      },
      executeAction: async (action, controllerContext) =>
        (this._assertSessionActive(session, { deadlineAt: Date.parse(session.deadlineAt) }),
        this._executeInteractiveAction(session, action, controllerContext)),
      onEvent: async (event) => this.addSessionEvent(session, event.type, event)
    });
    const result = await controller.run(rawText, {
      normalizedGoal: session.intent?.normalizedGoal,
      successCriteria: session.intent?.successCriteria,
      constraints: session.intent?.constraints,
      entities: session.intent?.entities,
      requiredCapabilities: session.intent?.requiredCapabilities,
      intentCategory: session.intent?.category,
      goalContract: session.goalContract
    });
    session.interactiveController = result;
    if (result.status === "COMPLETE") {
      session.currentState = RuntimeState.COMPLETED;
      session.finalResponse = {
        status: "COMPLETED",
        message: typeof result.result === "string"
          ? result.result
          : (result.result?.summary ?? "The requested goal was completed and verified."),
        interactive: true,
        result: result.result,
        verification: result.completionVerification,
        metrics: result.metrics,
        observability: result.observability
      };
      await this.addSessionEvent(session, "INTERACTIVE_GOAL_VERIFIED", {
        result: result.result,
        verification: result.completionVerification,
        metrics: result.metrics
      });
    } else if (result.status === "NEEDS_USER") {
      if (session.finalResponse?.status !== "AWAITING_APPROVAL") {
        session.finalResponse = { status: "NEEDS_CLARIFICATION", message: result.reason, interactive: true };
      }
    }
    await this.persistSession(session);
    return result;
  }

  async _executeInteractiveAction(session, action, controllerContext = {}) {
    const taskId = createId("interactive_task");
    const capability = this.capabilityRegistry.get(action.capability);
    const plan = {
      planId: createId("interactive_plan"),
      planVersion: 1,
      parentPlanId: session.plan?.planId ?? null,
      goal: session.intent?.normalizedGoal ?? controllerContext.goal,
      summary: `Adaptive step: ${action.subgoal ?? action.capability}`,
      finalSuccessCriteria: session.intent?.successCriteria ?? [],
      taskGraph: {
        graphId: createId("interactive_graph"),
        tasks: [{
          taskId,
          goal: action.subgoal ?? action.capability,
          description: action.expectedEffect ?? `Execute ${action.capability}`,
          dependencies: [],
          capability: action.capability,
          inputs: action.inputs ?? {},
          expectedStateChanges: [],
          affectedEntities: [],
          riskHints: "LOW",
          verificationCriteria: action.verification
            ? [JSON.stringify(action.verification)]
            : [`${action.capability} must return capability-level verified evidence`],
          completionCriteria: [
            action.expectedEffect ?? `${action.capability} completes its declared subgoal`
          ],
          rollbackRequired: capability?.reversibility === "ROLLBACK_SUPPORTED",
          timeout: Math.min(30000, Number(capability?.timeout ?? 30000)),
          retryBudget: 0,
          idempotency: false
        }]
      }
    };
    const validation = this.planValidator.validatePlan(plan.taskGraph);
    if (!validation.valid) throw new Error(`Interactive action plan is invalid: ${validation.errors.join("; ")}`);
    const priorManifest = session.approvalManifest ?? null;
    session.plan = plan;
    const gate = await this._authorizePlan(session, plan, {
      phase: "REPLAN",
      autoApprove: session.autoApprove === true,
      priorManifest
    });
    if (!gate.authorized) {
      return {
        paused: true,
        reason: session.finalResponse?.message ?? "This action requires approval",
        verification: { status: "FAILED", message: "Action was not authorized", confidence: 1 }
      };
    }
    session.currentState = RuntimeState.EXECUTING;
    await this._executeTaskGraph(session, {
      replanAttempts: 0,
      MAX_REPLAN_ATTEMPTS: 0,
      originalPlan: plan
    });
    const taskResult = [...session.taskResults].reverse().find((item) => item.taskId === taskId);
    const observation = [...session.observations].reverse().find((item) => item?.relatedActionId === taskId)
      ?? session.observations.at(-1);
    const verification = session.verifications.at(-1)
      ?? { status: "FAILED", message: "No verification was produced", confidence: 1 };
    return { executionResult: taskResult?.executionResult, observation, verification };
  }

  // Used by the chat surface as a separate, parallel request. The LLM generates
  // its OWN natural, first-person acknowledgement ("Sure, playing 'Cry For Me'
  // now.") — never a hardcoded/templated string — while submitIntent begins the
  // safe typed work concurrently. Falls back to a minimal deterministic line only
  // when no model is available so the user always sees an acknowledgement.
  async acknowledgeIntent(rawText) {
    if (!this.reasoningEngine?.acknowledgeAction) {
      return { message: null, source: "unavailable" };
    }
    try {
      const result = await this.reasoningEngine.acknowledgeAction(rawText);
      const message = result?.ok && typeof result.text === "string" && result.text.trim()
        ? result.text.trim()
        : null;
      return { message, source: message ? (result?.source ?? "model") : "unavailable" };
    } catch {
      return { message: null, source: "unavailable" };
    }
  }

  // Supplementary action classifier for approval explanations and audit.
  // Policy remains authoritative; this classifier cannot relax a policy control.
  // Existence is probed via the adapter (cheap, read-only). If existence cannot be
  // determined for a write, we fail SAFE (require approval) rather than silently
  // editing an existing file. Deterministic and side-effect free.
  async _classifyPlanApproval(plan) {
    const tasks = plan?.taskGraph?.tasks ?? [];
    const reasons = [];

    for (const task of tasks) {
      const name = task?.capability ?? task?.selectedCapability;
      if (!name) continue;
      const inputs = task?.inputs ?? {};
      const capability = this.capabilityRegistry?.get?.(name) ?? null;

      if (/^(?:package\..*\.install|application\.install)$/.test(name)) {
        reasons.push(`${name} installs software and requires approval.`);
        continue;
      }

      // (1) DELETE — file deletion or app uninstall/removal.
      if (name === "filesystem.delete" || name === "application.uninstall" || name === "package.uninstall") {
        reasons.push(`${name} deletes from the system and requires approval.`);
        continue;
      }

      // Generic UI interaction can change a third-party account, submit a form,
      // or purchase something. Inspection is read-only; click/type requires an
      // explicit approval bound to the exact selector and text in the plan.
      if (["gui.interact", "ui.action", "browser.click", "browser.type", "browser.select", "browser.download"].includes(name)) {
        reasons.push(`${name} can alter local or external state and requires approval when policy requires confirmation.`);
        continue;
      }

      // (3) NON-WINGET / BROWSER-SOURCED INSTALL. WinGet installs (signed community
      // source) are explicitly autonomous; a capability flagged as an external /
      // browser-sourced install requires approval. Forward-looking: no such
      // capability ships today, so this is driven by an explicit capability flag
      // rather than by guessing from a name.
      const installSource = capability?.installSource ?? capability?.security?.installSource ?? null;
      const isExternalInstall = (installSource && installSource !== "winget")
        || capability?.requiresBrowserDownload === true;
      if (isExternalInstall) {
        reasons.push(`${name} installs software from a non-WinGet/browser source and requires approval.`);
        continue;
      }

      // (2) EDIT AN EXISTING FILE. Only write-class tasks can edit a file; a new
      // file is autonomous, an existing one is an edit.
      if (name === "filesystem.write" || name === "environment.project.set" || name === "application.notepad.launch") {
        const existing = await this._writeTargetExists(name, inputs);
        if (existing === true) {
          reasons.push(`${name} edits an existing file and requires approval.`);
        } else if (existing === null) {
          // Undetermined — fail safe.
          reasons.push(`${name} may edit an existing file (existence undetermined); requiring approval.`);
        }
        continue;
      }
    }

    return { requiresApproval: reasons.length > 0, reasons };
  }

  // Best-effort existence probe for a write-class task's target file. Returns
  // true (exists → edit), false (absent → new file), or null (undetermined). Uses
  // only read-only adapter methods and never throws.
  async _writeTargetExists(capabilityName, inputs) {
    try {
      if (capabilityName === "filesystem.write") {
        if (!inputs?.filePath) return null;
        try {
          await this.adapter.readTextFile(inputs.filePath);
          return true;
        } catch (error) {
          return error?.code === "ENOENT" ? false : null;
        }
      }
      if (capabilityName === "environment.project.set") {
        if (!inputs?.workspacePath || typeof this.adapter.inspectProjectEnvironment !== "function") return null;
        const info = await this.adapter.inspectProjectEnvironment(inputs.workspacePath);
        return Boolean(info?.exists);
      }
      if (capabilityName === "application.notepad.launch") {
        // Notepad saves under the Documents folder using the provided filename.
        if (!inputs?.filename || typeof this.adapter.getDocumentsPath !== "function") return null;
        const target = path.join(this.adapter.getDocumentsPath(), inputs.filename);
        try {
          await this.adapter.readTextFile(target);
          return true;
        } catch (error) {
          return error?.code === "ENOENT" ? false : null;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  // THE canonical plan authorization gate. Both the initial plan and every
  // replan pass a candidate plan through this ONE function, so a plan can never
  // reach execution without: (4) validation, (5) a FRESH risk assessment at an
  // explicit evaluation time, (6) a FRESH policy decision, and (7) an approval
  // bound to the plan's exact cryptographic commitment. This is the structural
  // fix for the replan-escalation gap: replanning is a NEW security decision,
  // never an inheritance of the original approval.
  //
  // On success it records session.plan/riskAssessment/policyDecision/
  // approvalManifest/approvalCommitment and returns { authorized: true }. On any
  // block it sets session.currentState + finalResponse, persists, and returns
  // { authorized: false, reason }. Grants are NEVER minted here — only after a
  // caller sees authorized:true (see _executeTaskGraph / replan continue path).
  //
  //   phase        - "INITIAL" | "REPLAN" (drives event names + the delta audit).
  //   autoApprove  - the caller's standing authorization for THIS session.
  //   priorManifest- the previously-approved manifest, so a legitimate redacted
  //                  secret round-trips without forcing re-entry of the secret.
  async _authorizePlan(session, plan, { phase = "INITIAL", autoApprove = false, priorManifest = null } = {}) {
    const isReplan = phase === "REPLAN";
    const ev = (initial, replan) => (isReplan ? replan : initial);

    // 4. Validate.
    session.currentState = RuntimeState.VALIDATE_PLAN;
    const planValidation = this.planValidator.validatePlan(plan.taskGraph);
    await this.addSessionEvent(session, ev("PLAN_VALIDATED", "REPLAN_VALIDATED"), planValidation);
    if (!planValidation.valid) {
      session.currentState = RuntimeState.PLAN_REJECTED;
      session.finalResponse = { status: "PLAN_REJECTED", errors: planValidation.errors };
      await this.persistSession(session);
      return { authorized: false, reason: "PLAN_REJECTED" };
    }

    // The candidate plan becomes the session's authoritative plan from here on:
    // risk, policy, commitment, persistence, and (if it parks in
    // AWAITING_APPROVAL) resume all operate on THIS plan. On the initial path
    // session.plan is already this same object, so this is a no-op there.
    session.plan = plan;

    // 5. Fresh risk assessment at an EXPLICIT evaluation time (deterministic,
    // auditable — never a hidden Date.now() inside the engine).
    session.currentState = RuntimeState.ASSESS_RISK;
    const evaluatedAt = new Date().toISOString();
    const riskAssessment = this.riskEngine.assess(plan, session.context, { evaluatedAt });
    session.riskAssessment = riskAssessment;
    await this.addSessionEvent(session, ev("RISK_ASSESSED", "REPLAN_RISK_ASSESSED"), riskAssessment);

    // 6. Fresh policy decision using the plan's authoritative capability
    // profiles (privilege/execution/policy requirements). ELEVATE availability
    // is OPERATION-SPECIFIC: it is true only when EVERY elevated capability in
    // this plan binds to a privileged operation the registry can actually route
    // through the bounded helper. A plan whose elevated capability has no live
    // route fails closed (REQUIRED_CONTROL_UNAVAILABLE) rather than proceeding.
    session.currentState = RuntimeState.APPLY_POLICY;
    const planCapabilities = this._planCapabilities(plan);
    const elevateAvailable = this._elevateAvailableForPlan(planCapabilities);
    const policyDecision = this.policyEngine.decide(riskAssessment, plan, {
      capabilities: planCapabilities,
      controlAvailability: { ELEVATE: elevateAvailable },
      context: session.context
    });
    session.policyDecision = policyDecision;
    await this.addSessionEvent(session, ev("POLICY_DECIDED", "REPLAN_POLICY_DECIDED"), policyDecision);

    if (policyDecision.effect === PolicyEffect.DENY) {
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = { status: "DENIED", reason: policyDecision.reason };
      await this.persistSession(session);
      return { authorized: false, reason: "DENIED" };
    }

    // 7. Bind approval to the plan's EXACT cryptographic commitment (SHA-256 over
    // the canonical ApprovalManifest; secret values committed via keyed HMAC).
    session.currentState = RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED;
    const built = this.permissionBroker.buildApprovalCommitment(plan, { priorManifest });
    session.approvalManifest = built.manifest;
    session.approvalCommitment = built.commitment;

    // A replan whose commitment differs from the previously-approved one is, by
    // definition, a different authorization; record the delta for the audit.
    if (isReplan) {
      await this.addSessionEvent(session, "REPLAN_COMMITMENT_COMPUTED", {
        newCommitment: built.commitment,
        priorCommitment: session.priorApprovalCommitment ?? null,
        changed: built.commitment !== (session.priorApprovalCommitment ?? null)
      });
    }

    // Record supplementary classification, but never manufacture authorization.
    // Only caller-supplied scoped approval may satisfy CONFIRM or ELEVATE.
    const approvalClass = await this._classifyPlanApproval(plan);
    const dims = riskAssessment?.dimensions ?? {};
    const destructiveOrIrreversible =
      dims[RiskDimension.MUTATION_IMPACT] === "DESTRUCTIVE" ||
      dims[RiskDimension.REVERSIBILITY] === "IRREVERSIBLE";
    const needsElevation = policyDecision.confirmationLevel === ConfirmationLevel.ELEVATE;
    // Policy is authoritative. Classification is recorded for audit and
    // explanation, but it cannot mint approval for CONFIRM or ELEVATE.
    const canRelax = false;
    await this.addSessionEvent(session, ev("APPROVAL_SCOPE_CLASSIFIED", "REPLAN_APPROVAL_SCOPE_CLASSIFIED"), {
      requiresApproval: approvalClass.requiresApproval,
      reasons: approvalClass.reasons,
      autonomouslyRelaxed: canRelax,
      destructiveOrIrreversible,
      needsElevation
    });
    const effectiveAutoApprove = autoApprove === true;

    const permissionDecision = this.permissionBroker.evaluate({
      policyDecision,
      autoApprove: effectiveAutoApprove,
      approvalCommitment: built.commitment
    });
    await this.addSessionEvent(session, "APPROVAL_EVALUATED", {
      required: permissionDecision.required,
      approved: permissionDecision.approved,
      confirmationLevel: permissionDecision.confirmationLevel ?? null,
      approvalCommitment: built.commitment,
      autonomousApproval: effectiveAutoApprove && autoApprove !== true,
      reason: permissionDecision.reason
    });

    if (!permissionDecision.approved) {
      session.currentState = RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED;
      session.finalResponse = {
        status: "AWAITING_APPROVAL",
        reason: permissionDecision.reason,
        confirmationLevel: policyDecision.confirmationLevel ?? null,
        informedApproval: policyDecision.informedApproval ?? null,
        approvalCommitment: built.commitment
      };
      if (isReplan) {
        await this.addSessionEvent(session, "REPLAN_APPROVAL_REQUIRED", { approvalCommitment: built.commitment });
      }
      await this.persistSession(session);
      return { authorized: false, reason: "AWAITING_APPROVAL" };
    }

    const commitmentChanged = built.commitment !== (session.priorApprovalCommitment ?? null);
    session.priorApprovalCommitment = built.commitment;
    if (isReplan) {
      await this.addSessionEvent(session, "REPLAN_APPROVED", { approvalCommitment: built.commitment });
    }
    await this.persistSession(session);
    return { authorized: true, commitmentChanged };
  }

  // Issue capability grants for a plan's task graph. One grant is issued per task
  // occurrence, so a plan with N tasks using the same single-use capability gets
  // N single-use grants — each consumed by exactly one task. Session-reusable
  // grants are validated but never consumed, so extra copies are harmless.
  // No-op when the broker has no grant store (lightweight/test wiring).
  async _issuePlanGrants(session, plan) {
    if (typeof this.permissionBroker?.grantPlanCapabilities !== "function") return;
    const tasks = plan?.taskGraph?.tasks ?? [];
    const capabilities = [];
    for (const task of tasks) {
      const name = task.capability ?? task.selectedCapability;
      if (!name) continue;
      const capability = this.capabilityRegistry?.get(name);
      if (capability) capabilities.push(capability);
    }
    if (capabilities.length === 0) return;
    await this.permissionBroker.grantPlanCapabilities({ sessionId: session.sessionId, capabilities });
  }

  // The single canonical execution pipeline. Runs the plan's task graph through
  // Resolve the normalized capabilities named by a plan's tasks. These carry
  // the authoritative structured risk profile and explicit policy requirements
  // the PolicyEngine needs to route confirmation levels. Unknown names are
  // skipped (PlanValidator already rejected them upstream).
  _planCapabilities(plan) {
    const tasks = plan?.taskGraph?.tasks ?? [];
    const out = [];
    for (const task of tasks) {
      const name = task?.capability ?? task?.selectedCapability;
      if (!name || !this.capabilityRegistry?.get) continue;
      try {
        const cap = this.capabilityRegistry.get(name);
        if (cap) out.push(cap);
      } catch {
        // ignore — validator handles unknown capabilities
      }
    }
    return out;
  }

  // ELEVATE is available for a plan ONLY when every capability that requires
  // elevation is backed by a LIVE bounded privileged route (its declared
  // privilegedOperation is in the registry's live privilegedOperations set,
  // which is populated only when a privileged helper is wired). If any elevated
  // capability lacks a live route, ELEVATE is unavailable and the policy gate
  // fails closed (REQUIRED_CONTROL_UNAVAILABLE) rather than pretending the
  // control exists. This makes availability operation-specific, not a global
  // "a helper object exists" boolean.
  _elevateAvailableForPlan(capabilities) {
    const live = this.capabilityRegistry?.privilegedOperations;
    const elevated = capabilities.filter((c) => (c?.requirements?.elevation ?? "NONE") !== "NONE");
    if (elevated.length === 0) return false; // no elevated caps -> ELEVATE not needed
    if (!live || live.size === 0) return false;
    return elevated.every((c) => c?.privilegedOperation && live.has(c.privilegedOperation));
  }

  // the TaskGraphScheduler: checkpoint -> execute -> observe -> verify, with
  // bounded replanning on verification failure. Both fresh intents
  // (submitIntent) and resumed/approved sessions use this exact loop, so there
  // is exactly one execution path in the runtime.
  async _executeTaskGraph(session, options = {}) {
    let replanAttempts = session.replanAttempts ?? options.replanAttempts ?? 0;
    const MAX_REPLAN_ATTEMPTS = options.MAX_REPLAN_ATTEMPTS ?? 2;
    const originalPlan = options.originalPlan ?? session.plan;

    // Issue authoritative capability grants for the approved plan before any
    // task runs. Deny-by-default enforcement in the pipeline's authorize()
    // callback consumes these; without a grant a capability cannot execute even
    // though the session and policy approval exist.
    const deadlineAt = session.deadlineAt ? Date.parse(session.deadlineAt) : null;
    this._assertSessionActive(session, { deadlineAt });
    await this._issuePlanGrants(session, session.plan);

    this.taskGraphScheduler.initialize(session.plan.taskGraph);

    while (!this.taskGraphScheduler.isComplete()) {
      this._assertSessionActive(session, { deadlineAt });
      const readyTasks = this.taskGraphScheduler.getReadyTasks();

      for (const task of readyTasks) {
        this._assertSessionActive(session, { deadlineAt });
        const referencedInputs = task.inputs;
        const resolved = resolveTaskInputs(referencedInputs, {
          taskResults: this.taskGraphScheduler.taskResults,
          observations: this.taskGraphScheduler.observations
        });
        if (resolved.provenance.length > 0) {
          const capability = this.capabilityRegistry.get(task.capability);
          const validation = validateSchema(resolved.inputs, capability?.inputSchema ?? { type: "object" });
          if (!validation.valid) {
            throw new Error(`Resolved inputs for ${task.taskId} are invalid: ${validation.errors.join(", ")}`);
          }
          task.inputs = resolved.inputs;
          await this.addSessionEvent(session, "TASK_INPUTS_RESOLVED", {
            taskId: task.taskId,
            capability: task.capability,
            provenance: resolved.provenance
          });
          // A model approved only the REFERENCE, not the value discovered at
          // runtime. Read-only consumers may proceed after schema validation.
          // Any write/execute consumer is a materially resolved plan and must
          // re-enter the canonical risk/policy/approval gate before use.
          if (capability?.permissionModel?.type !== "READ") {
            const priorManifest = session.approvalManifest ?? null;
            const gate = await this._authorizePlan(session, session.plan, {
              phase: "REPLAN",
              autoApprove: session.autoApprove === true,
              priorManifest
            });
            if (!gate.authorized) return { terminated: true };
            if (typeof this.permissionBroker?.revokeSessionCapabilities === "function") {
              await this.permissionBroker.revokeSessionCapabilities(
                session.sessionId,
                "Runtime binding resolved; grants reissued against the resolved plan."
              );
            }
            const remainingTasks = session.plan.taskGraph.tasks.filter((candidate) =>
              this.taskGraphScheduler.getTaskState(candidate.taskId) !== "VERIFIED"
            );
            await this._issuePlanGrants(session, {
              ...session.plan,
              taskGraph: { ...session.plan.taskGraph, tasks: remainingTasks }
            });
            session.currentState = RuntimeState.EXECUTING;
            await this.addSessionEvent(session, "RUNTIME_BINDING_REAUTHORIZED", {
              taskId: task.taskId,
              capability: task.capability,
              approvalCommitment: session.approvalCommitment
            });
          }
        }
        let cap;
        try {
          cap = await this.capabilityRegistry.pipeline.prepare(task, {
            platform: process.platform,
            privilegeApproved: session.policyDecision?.effect !== PolicyEffect.DENY,
            authorize: async (candidate) => this.permissionBroker.evaluateCapability({
              capability: candidate,
              approved: session.policyDecision?.effect !== PolicyEffect.DENY,
              sessionId: session.sessionId,
              grantedPermissions: session.grantedPermissions ?? null
            })
          });
        } catch (error) {
          await this.addSessionEvent(session, "CAPABILITY_PREFLIGHT_FAILED", {
            taskId: task.taskId,
            capability: task.capability,
            error: error.message
          });
          throw error;
        }

        await this.addSessionEvent(session, "TASK_STARTING", {
          taskId: task.taskId,
          capability: task.capability,
          latencyMs: Date.now() - session.receivedAtMs
        });
        await this.persistSession(session);

        if (cap.preconditions && !cap.preconditions(task.inputs)) {
          await this.addSessionEvent(session, "TASK_PRECONDITIONS_FAILED", { taskId: task.taskId });
          continue;
        }

        if (cap.reversibility === "ROLLBACK_SUPPORTED") {
          await this.addSessionEvent(session, "CREATING_CHECKPOINT", { taskId: task.taskId, capability: task.capability });
          const rollbackRecord = await this.rollbackManager.capture(task);
          session.rollback.records.push(rollbackRecord);
          await this.addSessionEvent(session, "CAPABILITY_ROLLBACK_REGISTERED", { taskId: task.taskId, capability: task.capability });
          await this.persistSession(session);
        }

        // Secret injection (Phase 9): if the capability declares requiredSecrets,
        // resolve the actual values from the DPAPI broker into the task inputs
        // ONLY for the moment of execution. Secrets never reach the planner,
        // reasoning engine, prompts, or audit; the plan/observations carry secret
        // references (names), not values. We restore the reference-only inputs
        // immediately after execution so nothing secret is persisted.
        const injectedSecrets = await this._resolveSecretsForTask(cap, task, session);

        let execution;
        try {
          if (Number.isFinite(deadlineAt)) {
            const remaining = Math.max(1, deadlineAt - Date.now());
            task.timeout = Math.min(Number(task.timeout ?? remaining), remaining);
          }
          execution = await this.taskGraphScheduler.executeTask(task);
          this._assertSessionActive(session, { deadlineAt });
        } finally {
          // Scrub even if execution throws during observation or verification.
          if (injectedSecrets) this._scrubInjectedSecrets(task, injectedSecrets);
        }
        const { verification, observation, executionResult } = execution;

        session.taskResults.push({ taskId: task.taskId, capability: task.capability, executionResult });
        session.observations.push(observation);
        session.verifications.push(verification);

        await this.addSessionEvent(session, "TASK_EXECUTED", { taskId: task.taskId, result: executionResult });
        await this.addSessionEvent(session, "OBSERVATION_COLLECTED", observation);
        await this.addSessionEvent(
          session,
          verification.status === "VERIFIED" ? "VERIFICATION_COMPLETED" : "VERIFICATION_UNCERTAIN",
          verification
        );
        const lifecycleResult = await this.capabilityRegistry.pipeline.recordResult(task, execution);
        for (const auditEvent of lifecycleResult.auditEvents) {
          await this.addSessionEvent(session, "CAPABILITY_AUDIT_EVENT", { taskId: task.taskId, capability: task.capability, auditEvent });
        }
        if (lifecycleResult.semanticUpdates.length > 0) {
          await this.addSessionEvent(session, "CAPABILITY_SEMANTIC_UPDATES_REGISTERED", {
            taskId: task.taskId,
            capability: task.capability,
            updates: lifecycleResult.semanticUpdates
          });
        }
        if (this.memory && lifecycleResult.memoryUpdates.length > 0 &&
            verification.status === "VERIFIED") {
          for (const update of lifecycleResult.memoryUpdates) {
            await this.memory.store({
              id: createId("capability_memory"),
              type: update.type ?? "SYSTEM_HISTORY",
              content: { update, taskId: task.taskId, capability: task.capability, executionResult },
              summary: update.summary ?? `Capability memory update: ${task.capability}`,
              provenance: `capability:${task.capability}`,
              confidence: update.confidence ?? 1,
              sensitivity: update.sensitivity ?? "LOW",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              expiresAt: update.expiresAt ?? null,
              relatedEntities: [],
              relatedSession: session.sessionId,
              relatedIntent: session.intent?.id,
              verifiedSuccess: true
            });
          }
          await this.addSessionEvent(session, "CAPABILITY_MEMORY_UPDATED", { taskId: task.taskId, capability: task.capability });
        }

        // Every observation flows through Perception (the sole writer to the
        // world model). Verified mutating tasks record their action effects —
        // the entities perception wrote — so the planner/recovery see them.
        if (this.perception) {
          const written = await this.perception.ingestObservation(observation);
          if (
            verification.status === "VERIFIED" &&
            Array.isArray(observation?.detectedChanges) && observation.detectedChanges.length > 0
          ) {
            // Semantic action-effect persistence must not fail silently. If it
            // throws, record an observable audit event; the task still verified,
            // so this degrades the semantic record without failing the task, but
            // the failure is never invisible.
            try {
              await this.perception.recordEffects(task.taskId, written.entities ?? [], written.relationships ?? []);
            } catch (effectError) {
              await this.addSessionEvent(session, "SEMANTIC_EFFECT_PERSISTENCE_FAILED", {
                taskId: task.taskId,
                capability: task.capability,
                error: effectError instanceof Error ? effectError.message : String(effectError)
              });
            }
          }
        }

        await this.persistSession(session);

        if (verification.status !== "VERIFIED") {
          await this.addSessionEvent(session, "VERIFICATION_FAILED", verification);
          const handleResult = await this.handleTaskFailure(session, task, verification, {
            replanAttempts,
            MAX_REPLAN_ATTEMPTS,
            originalPlan
          });

          if (!handleResult.shouldContinue) {
            // The failure handler set a terminal response (FAILED / ROLLED_BACK
            // / AWAITING_APPROVAL). Signal the caller not to run goal
            // finalization, which would overwrite that response.
            return { terminated: true };
          }

          if (handleResult.replanAttempts !== undefined) {
            replanAttempts = handleResult.replanAttempts;
            // Preserve completed VERIFIED tasks so a replan never repeats work
            // (critical for non-idempotent tasks).
            const preserveStates = handleResult.preserveStates instanceof Map
              ? handleResult.preserveStates
              : this.taskGraphScheduler.captureCompletedStates();
            // The replan may introduce new capabilities; grant them before the
            // scheduler restarts against the new graph.
            await this._issuePlanGrants(session, session.plan);
            this.taskGraphScheduler.initialize(session.plan.taskGraph, { preserveStates });
            // Restart the scheduling loop against the new plan rather than
            // continuing to iterate ready tasks from the old graph.
            break;
          }
        }
      }
    }
  }

  // Cached model-health probe used to gate keyword fallbacks (conversational
  // shortcut) behind "no real model available". Delegates to the ReasoningEngine's
  // own bounded, cached isModelHealthy so it never adds latency and never throws.
  // A provider with no health check is treated as healthy (Mock/scripted).
  async _isModelHealthy() {
    try {
      if (typeof this.reasoningEngine?.isModelHealthy === "function") {
        return await this.reasoningEngine.isModelHealthy();
      }
    } catch { /* fall through to unhealthy */ }
    return false;
  }

  // Heuristic: is this input conversational (a greeting, a meta-question about
  // SYSCORA, small talk) rather than a concrete Windows automation task? Used to
  // answer directly with text BEFORE planning, so a greeting never triggers
  // system inspection or a slow plan/compose round-trip. Deliberately narrow:
  // anything that names or implies an action (verbs/targets) is NOT treated as
  // conversational and flows to the normal planner.
  _looksConversational(rawText) {
    const text = String(rawText ?? "").trim().toLowerCase();
    if (!text) return false;
    // Any action-shaped word means it's a task, not small talk — let it plan.
    const actionish = /\b(inspect|list|check|find|search|install|create|make|open|launch|close|run|read|write|delete|remove|set|add|kill|stop|start|restart|show|tell me about|what'?s using|port|folder|file|path|package|winget|process|service|project|docker|git|node|python|environment|env)\b/;
    if (actionish.test(text)) return false;
    // Greetings / thanks / meta-questions about the assistant itself.
    const greeting = /^(hi|hii+|hey|hello|yo|sup|howdy|greetings|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|nice)\b/;
    const metaQuestion = /\b(what|which) (model|llm|ai) (are|r) (you|u)\b|\bwho are you\b|\byour name\b|\bwhat can you do\b|\bwhat do you do\b|\bhow do you work\b|\bare you (an? )?(ai|bot|model)\b|\bhelp\b/;
    if (greeting.test(text) || metaQuestion.test(text)) return true;
    // Very short, question-like, no action word → treat as conversational.
    if (text.length <= 40 && /\?$/.test(text)) return true;
    return false;
  }

  async addSessionEvent(session, eventType, details) {
    const event = {
      eventId: createId("event"),
      eventType,
      timestamp: new Date().toISOString(),
      details
    };
    session.events.push(event);
    this.onSessionEvent?.(session.sessionId, event);
    await this.auditRepository.append(session.sessionId, eventType, details);
  }

  // Steps 9-11 of the canonical flow: persist semantic state + memory, then
  // derive the final goal verification from the scheduler's terminal status and
  // set the session's final response. Shared by submitIntent and
  // continueApprovedSession so both end identically.
  async _finalizeSession(session) {
    if (this.perception) {
      session.currentState = RuntimeState.UPDATE_SEMANTIC_STATE;
      await this.perception.snapshot(session.sessionId);
      await this.addSessionEvent(session, "SEMANTIC_STATE_UPDATED", {});
      await this.persistSession(session);
    }

    // GOAL VERIFICATION (before memory): task completion != goal completion. The
    // GoalVerifier evaluates the user's success criteria against scheduler
    // status, per-task verifications and the semantic world state, producing one
    // of COMPLETED / PARTIALLY_COMPLETED / FAILED / INCONCLUSIVE. Memory then
    // records the outcome based on this goal-level result, not raw task status.
    session.currentState = RuntimeState.VERIFY_FINAL_GOAL;
    const finalStatus = this.taskGraphScheduler.getFinalStatus();
    let semanticSnapshot = [];
    if (this.perception) {
      try {
        const sg = await this.perception.getRelevantSubgraph(session.intent, { budget: 25 });
        semanticSnapshot = sg.entities;
      } catch { /* best-effort */ }
    }
    // The GoalVerifier independently corroborates the scheduler's terminal status
    // against per-task verifications. It MUST see the scheduler's RECONCILED
    // current verifications (one per task, post-replan) — not session.verifications,
    // which is an accumulating history that still holds superseded FAILED entries
    // from before a successful replan. Fall back to the history only if the
    // scheduler can't provide the reconciled view.
    const reconciledVerifications = typeof this.taskGraphScheduler.getReconciledVerifications === "function"
      ? this.taskGraphScheduler.getReconciledVerifications()
      : session.verifications;
    const finalVerification = this.goalVerifier.verify({
      intent: session.intent,
      goalContract: session.goalContract,
      taskGraph: session.plan?.taskGraph,
      schedulerStatus: finalStatus,
      verifications: reconciledVerifications,
      observations: session.observations,
      taskResults: session.taskResults,
      semanticState: semanticSnapshot
    });
    // A goal that completed with warnings is still a success for the purpose of
    // recording an episodic (reusable) memory; only PARTIAL/FAILED/INCONCLUSIVE
    // are non-successes.
    const goalVerified = finalVerification.status === "COMPLETED" ||
      finalVerification.status === "COMPLETED_WITH_WARNINGS";

    if (this.memory) {
      session.currentState = RuntimeState.UPDATE_MEMORY;
      const now = new Date().toISOString();

      await this.memory.store({
        id: createId("memory"),
        type: "WORKING",
        content: {
          sessionId: session.sessionId,
          intent: session.intent,
          plan: session.plan,
          taskResults: session.taskResults,
          verifications: session.verifications,
          observations: session.observations
        },
        summary: `Working memory for session: ${session.sessionId}`,
        provenance: "session",
        confidence: 1.0,
        sensitivity: "LOW",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        relatedEntities: [],
        relatedSession: session.sessionId,
        relatedIntent: session.intent?.id
      });

      await this.memory.store({
        id: createId("memory"),
        type: goalVerified ? "EPISODIC" : "FAILURE_PATTERN",
        content: {
          intent: session.intent,
          plan: session.plan,
          taskResults: session.taskResults,
          verifications: session.verifications,
          goalVerification: finalVerification
        },
        summary: goalVerified
          ? `Successfully achieved goal: ${session.intent?.normalizedGoal ?? session.intent?.category}`
          : `Failed to achieve goal: ${session.intent?.normalizedGoal ?? session.intent?.category}`,
        provenance: "agent_workflow",
        confidence: 1.0,
        sensitivity: "LOW",
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        relatedEntities: [],
        relatedSession: session.sessionId,
        relatedIntent: session.intent?.id,
        verifiedSuccess: goalVerified
      });

      // Procedural memory only for reusable, verified workflows: a goal-verified
      // session whose plan used a named operation is a reusable recipe.
      if (goalVerified && session.intent?.operation) {
        await this.memory.store({
          id: createId("memory"),
          type: "PROCEDURAL",
          content: {
            operation: session.intent.operation,
            category: session.intent.category,
            capabilities: (session.plan?.taskGraph?.tasks ?? []).map((t) => t.capability)
          },
          summary: `Reusable verified workflow for operation: ${session.intent.operation}`,
          provenance: "verified_workflow",
          confidence: 1.0,
          sensitivity: "LOW",
          createdAt: now,
          updatedAt: now,
          expiresAt: null,
          relatedEntities: [],
          relatedSession: session.sessionId,
          relatedIntent: session.intent?.id,
          verifiedSuccess: true
        });
      }

      await this.addSessionEvent(session, "MEMORY_UPDATED", {});
      await this.persistSession(session);
    }

    await this.addSessionEvent(session, "FINAL_VERIFICATION_COMPLETED", finalVerification);

    // Map goal-verification outcome to session terminal state. Only a fully
    // COMPLETED goal is a success; everything else is a non-success terminal
    // state so the runtime never assumes success.
    const goalStateMap = {
      COMPLETED: RuntimeState.COMPLETED,
      // A goal completed with warnings still met its success criteria; it is a
      // success terminal state, distinguished only by the warnings in the
      // final response and goal verification evidence.
      COMPLETED_WITH_WARNINGS: RuntimeState.COMPLETED,
      PARTIALLY_COMPLETED: RuntimeState.FAILED,
      INCONCLUSIVE: RuntimeState.FAILED,
      FAILED: RuntimeState.FAILED
    };
    session.currentState = goalStateMap[finalVerification.status] ?? RuntimeState.FAILED;

    // EXECUTION SUMMARIZATION (Phase 7): the runtime produces FACTS; the
    // ReasoningEngine phrases them. It never fabricates outcomes, and always
    // returns a summary (deterministic template when no/failed model), so this
    // never blocks completion.
    let executionSummary = null;
    try {
      const facts = {
        status: finalVerification.status,
        taskCount: session.taskResults.length,
        changesMade: session.observations
          .filter((o) => Array.isArray(o?.detectedChanges) && o.detectedChanges.length > 0)
          .flatMap((o) => o.detectedChanges),
        recoveriesPerformed: (session.recoveryBudget?.attempts ?? []).map((a) => a.action),
        remainingProblems: session.verifications
          .filter((v) => v && v.status !== "VERIFIED")
          .map((v) => v.message)
      };
      const summaryResult = await this.reasoningEngine.summarizeExecution(facts);
      if (summaryResult.ok) {
        executionSummary = { ...summaryResult.data, source: summaryResult.source };
      }
    } catch {
      executionSummary = null;
    }

    // A verified read is useful only when its observed value reaches the user.
    // This also covers aggregate reads (for example a system snapshot made of
    // several independent tasks), without exposing raw command output.
    const directAnswer = summarizeReadOnlyResults(session.taskResults, this.capabilityRegistry)
      ?? (session.taskResults.length === 1 ? session.verifications.at(-1)?.message : null);
    if (directAnswer) {
      executionSummary = { ...(executionSummary ?? {}), summary: directAnswer };
    }

    session.finalResponse = {
      status: finalVerification.status,
      message: finalVerification.message,
      taskResults: session.taskResults,
      verifications: session.verifications,
      finalStatus,
      finalVerification,
      summary: executionSummary,
      rollbackAvailable: (session.rollback?.records?.length ?? 0) > 0
    };
    await this.persistSession(session);
    return session;
  }

  // Closed-loop failure handling: DIAGNOSE -> RECOVER (budget-aware decision)
  // -> act (retry / replan preserving completed work / rollback / abort).
  async handleTaskFailure(session, task, verification, options = {}) {
    const { replanAttempts = 0, MAX_REPLAN_ATTEMPTS = 2, originalPlan } = options;
    session.recoveryBudget = createRecoveryBudget(session.recoveryBudget);

    await this.addSessionEvent(session, "TASK_FAILED", {
      taskId: task.taskId,
      verification,
      replanAttempts
    });

    // 1. DIAGNOSE — classify the failure from execution result, verification
    //    evidence, observation and semantic state.
    const executionResult = session.taskResults.find(r => r.taskId === task.taskId)?.executionResult;
    const observation = session.observations.find(o => o?.taskId === task.taskId);
    const diagnosis = this.troubleshootingEngine
      ? this.troubleshootingEngine.diagnose({
          task,
          verification,
          executionResult,
          observation,
          semanticState: session.context?.semanticState,
          memory: session.context?.memory,
          attempt: session.recoveryBudget.spent,
          recoveryBudgetRemaining: session.recoveryBudget.total - session.recoveryBudget.spent
        })
      : { category: "unexpected", rootCause: "No diagnosis engine", confidence: 0.1, suggestedRecovery: "abort" };
    await this.addSessionEvent(session, "FAILURE_DIAGNOSED", diagnosis);

    // A failed mutation is uncertain: the OS process may have changed state
    // even when execution or verification reports failure. Re-running or
    // replanning it can duplicate installs/writes, so terminate safely and let
    // the user inspect the state before explicitly starting a new request.
    const capability = this.capabilityRegistry.get(task.capability);
    const mutatesState = capability?.reversibility && capability.reversibility !== "NOT_REQUIRED";
    const abortOnFailure = Array.isArray(capability?.recoveryHints) && capability.recoveryHints.includes("ABORT_ON_FAILURE");
    if (mutatesState || abortOnFailure) {
      await this.addSessionEvent(session, "RECOVERY_DECIDED", {
        action: "abort",
        reason: mutatesState
          ? "Mutating task failed with uncertain system state; automatic retry is unsafe."
          : "This capability does not support automatic retry; ending the request with its verification result.",
        budgetSpent: session.recoveryBudget.spent,
        budgetTotal: session.recoveryBudget.total
      });
      return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
    }

    // Model reasoning is advisory and auditable. The deterministic diagnosis
    // and RecoveryEngine still decide what the runtime may execute.
    const failureReasoning = await this.reasoningEngine.reasonAboutFailure({
      diagnosis,
      task,
      verification,
      executionResult,
      observation,
      semanticState: session.context?.semanticState,
      memory: session.context?.memory
    });
    if (failureReasoning.ok) await this.addSessionEvent(session, "FAILURE_REASONING_ADVICE", failureReasoning.data);

    // 2. RECOVER — decide the next recovery action within budget.
    const decision = this.recoveryEngine.recover({
      diagnosis,
      budget: session.recoveryBudget,
      replanAttempts,
      maxReplanAttempts: MAX_REPLAN_ATTEMPTS,
      failureFingerprint: stableRecoveryFingerprint({
        capability: task.capability,
        inputs: task.inputs,
        verification: {
          status: verification?.status,
          category: verification?.category,
          message: verification?.message
        },
        execution: {
          exitCode: executionResult?.exitCode ?? executionResult?.commandResult?.exitCode,
          reason: executionResult?.reason,
          error: executionResult?.error
        }
      }),
      stateFingerprint: stableRecoveryFingerprint({
        observation: observation?.structuredState ?? observation ?? null,
        semanticState: session.context?.semanticState ?? null
      })
    });
    session.recoveryBudget = decision.budget;
    const recoveryReasoning = await this.reasoningEngine.reasonAboutRecovery({
      diagnosis,
      task,
      verification,
      completedTasks: [...this.taskGraphScheduler.captureCompletedStates().keys()],
      recoveryBudgetRemaining: decision.budget.total - decision.budget.spent
    });
    if (recoveryReasoning.ok) await this.addSessionEvent(session, "RECOVERY_REASONING_ADVICE", recoveryReasoning.data);
    await this.addSessionEvent(session, "RECOVERY_DECIDED", {
      action: decision.action,
      reason: decision.reason,
      budgetSpent: decision.budget.spent,
      budgetTotal: decision.budget.total
    });

    // 3. ACT on the decision.
    if (decision.action === "abort") {
      return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
    }

    if (decision.action === "request_permission" || decision.action === "request_clarification") {
      session.currentState = RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED;
      session.finalResponse = {
        status: decision.action === "request_permission" ? "AWAITING_APPROVAL" : "NEEDS_CLARIFICATION",
        reason: diagnosis.rootCause,
        diagnosis
      };
      await this.persistSession(session);
      return { shouldContinue: false };
    }

    if (decision.action === "rollback") {
      return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
    }

    // retry / retry_with_backoff / replan all lead to a replan that preserves
    // completed VERIFIED work. (Execution-level retry already happened inside
    // the scheduler; a runtime-level retry is modelled as a fresh replan cycle.)
    if ((decision.action === "replan" || decision.action === "retry" || decision.action === "retry_with_backoff")
        && replanAttempts < MAX_REPLAN_ATTEMPTS && this.generalPlanner) {
      await this.addSessionEvent(session, "STARTING_REPLANNING", {
        attempt: replanAttempts + 1,
        maxAttempts: MAX_REPLAN_ATTEMPTS,
        driver: decision.action
      });

      // REPLAN input: fresh context + semantic state (before/after) + memory +
      // diagnosis + which tasks are already completed.
      const requiredContext = session.intent.requiredContext || [];
      const baseContext = await this.contextEngine.collectContext(requiredContext, session.intent.entities);
      let semanticContext = [];
      let relevantMemory = [];
      if (this.perception) {
        // Re-perceive so recovery/replanning sees the UPDATED world model
        // (state may have changed since the original plan).
        try { await this.perception.perceive({ workspacePath: session.intent.entities?.workspacePath }); } catch { /* best-effort */ }
        const subgraph = await this.perception.getRelevantSubgraph(session.intent, { budget: 25 });
        semanticContext = subgraph.entities;
      }
      if (this.memory) {
        relevantMemory = await this.memory.retrieveRelevant(session.intent);
      }
      const planningContext = this.contextEngine.buildPlanningContext({
        intent: session.intent,
        baseContext,
        semanticSubgraph: { entities: semanticContext, relationships: [] },
        memory: relevantMemory,
        capabilityRegistry: this.capabilityRegistry,
        policyConstraints: session.intent.constraints,
        recoveryBudget: session.recoveryBudget
      });

      const completedStates = this.taskGraphScheduler.captureCompletedStates();
      const completedTaskIds = [...completedStates.keys()];

      session.currentState = RuntimeState.GENERATE_PLAN;
      const newPlan = await this.generalPlanner.generatePlan(
        session.intent,
        planningContext,
        semanticContext,
        relevantMemory,
        {
          originalGoal: session.intent.normalizedGoal,
          originalPlan,
          completedTaskIds,
          failedTask: task,
          verification,
          diagnosis,
          remainingRecoveryBudget: session.recoveryBudget.total - session.recoveryBudget.spent
        }
      );
      newPlan.planVersion = (session.plan.planVersion || 1) + 1;
      newPlan.parentPlanId = session.plan.planId;
      await this.addSessionEvent(session, "REPLAN_GENERATED", {
        planId: newPlan.planId,
        planVersion: newPlan.planVersion,
        parentPlanId: newPlan.parentPlanId,
        preservedTaskIds: completedTaskIds
      });

      // A replan is a NEW security decision. Route the candidate through the
      // SAME canonical authorization gate the initial plan used: fresh
      // validation, fresh risk assessment, fresh policy decision, and an
      // approval bound to the candidate's exact cryptographic commitment. The
      // original approval NEVER carries over — a replan that escalates
      // privilege/risk or introduces new/changed tasks must be re-authorized
      // (and, if it needs CONFIRM/ELEVATE without standing authorization, the
      // session parks in AWAITING_APPROVAL rather than executing).
      //
      // priorManifest lets a legitimately-unchanged, already-redacted secret
      // round-trip; a changed secret value still changes the commitment.
      const priorManifest = session.approvalManifest ?? null;
      session.priorApprovalCommitment = session.approvalCommitment ?? null;
      // Persist this BEFORE authorization. A high-risk replan normally parks
      // at the approval gate, and putting the increment after that gate would
      // reset the limit every time the user approves the suspended session.
      session.replanAttempts = replanAttempts + 1;
      const gate = await this._authorizePlan(session, newPlan, {
        phase: "REPLAN",
        autoApprove: session.autoApprove === true,
        priorManifest
      });
      if (!gate.authorized) {
        // The gate set a terminal/among-approval state + finalResponse and
        // persisted. Do NOT continue scheduling protected work.
        if (gate.reason === "AWAITING_APPROVAL") {
          return { shouldContinue: false };
        }
        await this.addSessionEvent(session, "REPLAN_FAILED", { reason: gate.reason });
        return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
      }

      // Material replan (commitment changed) => the old plan's grants no longer
      // describe the authorized work. Revoke every pending session grant so the
      // re-mint in _executeTaskGraph issues fresh grants bound to the NEW plan;
      // a session-reusable grant for a capability dropped from the new plan can
      // never be reused. (Completed VERIFIED tasks already consumed their grants,
      // so revoking here only affects not-yet-run work.)
      if (gate.commitmentChanged
          && typeof this.permissionBroker?.revokeSessionCapabilities === "function") {
        await this.permissionBroker.revokeSessionCapabilities(
          session.sessionId,
          "Material replan: prior-plan grants invalidated pending re-authorization."
        );
        await this.addSessionEvent(session, "REPLAN_GRANTS_INVALIDATED", {
          priorCommitment: session.priorApprovalCommitment ?? null,
          newCommitment: session.approvalCommitment
        });
      }

      session.currentState = RuntimeState.EXECUTING;
      // Preserve completed VERIFIED tasks so they never re-run.
      return { shouldContinue: true, replanAttempts: replanAttempts + 1, preserveStates: completedStates };
    }

    // Budget exhausted or replanning unavailable -> rollback or fail.
    return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
  }

  async _handleFailureWithoutReplan(session, task, verification, diagnosis = null) {
    if ((session.rollback?.records?.length ?? 0) > 0) {
      session.currentState = RuntimeState.ROLLING_BACK;
      await this.addSessionEvent(session, "ROLLING_BACK", { taskId: task.taskId });
      const rollbackResult = await this._rollbackSession(session);
      session.currentState = RuntimeState.ROLLED_BACK;
      session.finalResponse = {
        status: "ROLLED_BACK",
        message: `Task ${task.taskId} failed, rolled back`,
        verification,
        diagnosis,
        rollbackResult
      };
    } else {
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = {
        status: "FAILED",
        message: `Task ${task.taskId} failed: ${verification.message}`,
        verification,
        diagnosis
      };
    }
    return { shouldContinue: false };
  }

  // ==========================================================================
  // Compatibility wrappers.
  //
  // These methods preserve the historical AgentRuntime API used by the daemon,
  // CLI and tests, but they no longer contain any execution logic. Each simply
  // translates a concrete request into a canonical intent (an explicit
  // `operation` plus structured `entities`) and delegates to submitIntent(),
  // which runs the single canonical pipeline: planner -> validator -> risk ->
  // policy -> permission -> TaskGraphScheduler -> observe -> verify -> recover.
  //
  // No wrapper calls the adapter, planner or scheduler directly.
  // ==========================================================================

  async runSetProjectEnvVariable(intent, options = {}) {
    validateIntent(intent);
    return this.submitIntent(intent.rawText || `Set ${intent.entities.key} for the current project`, {
      ...options,
      operation: "environment.project.set",
      category: "PROJECT",
      normalizedGoal: `Set ${intent.entities.key} for the current project`,
      workspacePath: intent.entities.workspacePath,
      entities: {
        workspacePath: intent.entities.workspacePath,
        key: intent.entities.key,
        value: intent.entities.value
      },
      successCriteria: [`${intent.entities.key} is set in the project .env and verified`]
    });
  }

  async runProjectWorkflow(intent, options = {}) {
    validateIntent(intent);
    if (!this.developerIntelligence) {
      throw new Error("Developer intelligence engine is not configured.");
    }
    const workspacePath = intent.entities.workspacePath;
    const projectProfile = await this.developerIntelligence.detectProject(workspacePath);

    if (projectProfile.projectType !== "node") {
      // Preserve the historical contract: unsupported project types fail fast
      // without engaging the pipeline.
      return {
        sessionId: createId("session"),
        createdAt: new Date().toISOString(),
        currentState: RuntimeState.FAILED,
        intent,
        plan: null,
        taskResults: [],
        finalResponse: {
          status: "FAILED",
          reason: "Only Node.js project workflow is currently supported."
        }
      };
    }

    // Translate the detected project profile into concrete, verifiable steps and
    // delegate to the canonical pipeline. The planner turns each step into a
    // developer.project.run task; the scheduler executes and verifies them.
    const steps = [];
    if (projectProfile.installRequired) {
      steps.push({
        goal: "Install project dependencies",
        workspacePath,
        command: projectProfile.packageManager ?? "npm",
        args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
      });
    }
    // Deterministic run-check (matches prior behavior: validate the runtime can
    // start without launching a long-lived process).
    steps.push({
      goal: `Run project start check (${projectProfile.startScript ?? "start"})`,
      workspacePath,
      command: "node",
      args: ["-e", "console.log('syscora-project-run-check')"]
    });

    return this.submitIntent(intent.rawText || "Run this project", {
      ...options,
      operation: "developer.project.run",
      category: "DEVELOPER",
      normalizedGoal: "Detect, configure, run, and verify a project",
      workspacePath,
      entities: { workspacePath, steps },
      successCriteria: ["Project dependencies resolved and run check succeeds"]
    });
  }

  async inspectWindowsSystem() {
    // Read-only aggregate snapshot routed through the canonical pipeline. The
    // three sub-tasks (system.inspect, processes.list, system.services.list)
    // run via the scheduler; we reassemble the historical summary shape from
    // their execution results keyed by capability.
    const session = await this.submitIntent("Show me a system summary", {
      autoApprove: true,
      operation: "system.summary",
      category: "SYSTEM",
      normalizedGoal: "Aggregate system, process, and service snapshot",
      entities: {},
      successCriteria: ["System, process, and service information collected"]
    });
    const byCapability = {};
    for (const result of session.taskResults ?? []) {
      const capability = result.task?.capability ?? result.capability;
      if (capability) byCapability[capability] = result.executionResult;
    }
    return {
      system: byCapability["system.inspect"] ?? null,
      topProcesses: byCapability["processes.list"] ?? null,
      services: byCapability["system.services.list"] ?? null
    };
  }

  async setWindowsUserEnvironmentVariable(intent, options = {}) {
    validateIntent(intent);
    return this.submitIntent(intent.rawText || `Set Windows user environment variable ${intent.entities.key}`, {
      ...options,
      operation: "environment.user.set",
      category: "ENVIRONMENT",
      normalizedGoal: `Set Windows user environment variable ${intent.entities.key}`,
      workspacePath: intent.entities.workspacePath,
      entities: {
        workspacePath: intent.entities.workspacePath,
        key: intent.entities.key,
        value: intent.entities.value
      },
      successCriteria: [`${intent.entities.key} is set for the current user and verified`]
    });
  }

  async addWindowsUserPathEntry(intent, options = {}) {
    validateIntent(intent);
    const entry = intent.entities.value ?? intent.entities.entry;
    return this.submitIntent(intent.rawText || `Add ${entry} to my PATH`, {
      ...options,
      operation: "environment.user.path.add",
      category: "ENVIRONMENT",
      normalizedGoal: `Add ${entry} to the Windows user PATH`,
      workspacePath: intent.entities.workspacePath,
      entities: { workspacePath: intent.entities.workspacePath, entry },
      successCriteria: ["User PATH contains the entry and is verified"]
    });
  }

  async wingetInstallIntent(intent, options = {}) {
    validateIntent(intent);
    const id = intent.entities.id ?? intent.entities.key;
    return this.submitIntent(intent.rawText || `Install ${id}`, {
      ...options,
      operation: "package.winget.install",
      category: "SYSTEM",
      normalizedGoal: `Install package ${id} via WinGet`,
      workspacePath: intent.entities.workspacePath,
      entities: { workspacePath: intent.entities.workspacePath, id },
      successCriteria: [`${id} is installed and appears in the WinGet list`]
    });
  }

  async inspectPortIntent(intent) {
    validateIntent(intent);
    const session = await this.submitIntent(intent.rawText || `What is using port ${intent.entities.value}?`, {
      autoApprove: true,
      operation: "process.port.inspect",
      category: "SYSTEM",
      normalizedGoal: `Identify what is listening on port ${intent.entities.value}`,
      workspacePath: intent.entities.workspacePath,
      entities: { workspacePath: intent.entities.workspacePath, port: Number(intent.entities.value) },
      successCriteria: ["Process using the specified port is identified"]
    });
    // Preserve the historical raw-summary return shape for existing callers.
    return this._firstTaskOutput(session);
  }

  async analyzeSystemPerformanceIntent(intent) {
    validateIntent(intent);
    const session = await this.submitIntent(intent.rawText || "Why is my computer slow?", {
      autoApprove: true,
      operation: "system.performance.analyze",
      category: "SYSTEM",
      normalizedGoal: "Analyze system performance contributors",
      workspacePath: intent.entities.workspacePath,
      entities: { workspacePath: intent.entities.workspacePath },
      successCriteria: ["System performance analysis is produced"]
    });
    return this._firstTaskOutput(session);
  }

  async notepadTypeAndSaveIntent(intent, options = {}) {
    validateIntent(intent);
    return this.submitIntent(
      intent.rawText || `Open Notepad, type "${intent.entities.content}", save as ${intent.entities.filename}`,
      {
        ...options,
        operation: "application.notepad.launch",
        category: "APPLICATION",
        normalizedGoal: "Open Notepad, type text, and save",
        workspacePath: intent.entities.workspacePath,
        entities: {
          workspacePath: intent.entities.workspacePath,
          content: intent.entities.content,
          filename: intent.entities.filename
        },
        successCriteria: ["Notepad file is saved and verified"]
      }
    );
  }

  async browserSearchIntent(intent) {
    validateIntent(intent);
    const session = await this.submitIntent(intent.rawText || `Search for ${intent.entities.query}`, {
      autoApprove: true,
      operation: "browser.search",
      category: "BROWSER",
      normalizedGoal: "Open the browser and search",
      workspacePath: intent.entities.workspacePath,
      entities: { workspacePath: intent.entities.workspacePath, query: intent.entities.query },
      successCriteria: ["Browser search results page is opened"]
    });
    return this._firstTaskOutput(session);
  }

  // Extract the first task's raw execution output from a completed session.
  // Compatibility wrappers for read-only workflows historically returned the
  // adapter result directly; this preserves that contract while the real work
  // now runs through the canonical pipeline.
  _firstTaskOutput(session) {
    const first = session?.taskResults?.[0];
    return first?.executionResult ?? session?.finalResponse ?? null;
  }

  // Continue an approved session through the single canonical execution
  // pipeline. Any session carrying a canonical plan (task.capability) resumes
  // here after approval; execution, observation, verification, checkpointing
  // and rollback are all handled by _executeTaskGraph via the scheduler.
  async continueApprovedSession(session) {
    if (!Array.isArray(session.taskResults)) session.taskResults = [];
    if (!Array.isArray(session.observations)) session.observations = [];
    if (!Array.isArray(session.verifications)) session.verifications = [];
    if (!Array.isArray(session.events)) session.events = [];
    if (!session.rollback) session.rollback = { records: [], completed: false, result: null };
    session.recoveryBudget = createRecoveryBudget(session.recoveryBudget);

    try {
      session.currentState = RuntimeState.EXECUTING;
      const result = await this._executeTaskGraph(session, {});
      if (!result?.terminated) {
        await this._finalizeSession(session);
      }
      return session;
    } catch (error) {
      await this.addSessionEvent(session, "ERROR_OCCURRED", { error: error.message });
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = { status: "FAILED", message: error.message };
      await this.persistSession(session);
      return session;
    }
  }

  async resumeSessionById(sessionId, options = {}) {
    const session = await this.sessionStore.get(sessionId);
    validateExecutionSession(session);

    if (session.currentState === RuntimeState.PAUSED) {
      session.currentState = session.suspension?.suspendedFromState ?? RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED;
      await this.auditRepository.append(session.sessionId, "SESSION_RESUMED", {
        resumedToState: session.currentState
      });
      await this.persistSession(session);
    }

    if (session.currentState === RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED) {
      // An approval is bound to the plan's EXACT cryptographic commitment. If the
      // plan changed since the session was suspended (different capability,
      // version, dependencies, ordering, permissions, elevation, rollback, a
      // non-secret input, or a secret VALUE), the recomputed commitment differs
      // and the approval must NOT be reused — the operation is re-gated. This
      // closes the "approve op X, resume into a mutated op Y" downgrade path.
      //
      // The stored manifest is passed as priorManifest so a legitimately
      // unchanged, already-redacted secret round-trips to the same commitment;
      // any tampering that replaces a redacted secret with a different string is
      // hashed fresh and no longer matches.
      const built = this.permissionBroker.buildApprovalCommitment(session.plan, {
        priorManifest: session.approvalManifest ?? null
      });
      const currentCommitment = built.commitment;
      if (session.approvalCommitment && currentCommitment !== session.approvalCommitment) {
        await this.auditRepository.append(session.sessionId, "APPROVAL_INVALIDATED", {
          reason: "Plan changed after approval was requested; prior approval is void.",
          expected: session.approvalCommitment,
          actual: currentCommitment
        });
        session.approvalCommitment = currentCommitment;
        session.approvalManifest = built.manifest;
        session.finalResponse = {
          status: "AWAITING_APPROVAL",
          reason: "The plan changed since approval was requested; re-approval is required.",
          approvalCommitment: currentCommitment
        };
        await this.persistSession(session);
        return session;
      }

      const permissionDecision = this.permissionBroker.evaluate({
        policyDecision: session.policyDecision,
        autoApprove: options.autoApprove === true,
        approvalCommitment: currentCommitment
      });
      await this.auditRepository.append(session.sessionId, "APPROVAL_EVALUATED", {
        required: permissionDecision.required,
        approved: permissionDecision.approved,
        reason: `Resume flow: ${permissionDecision.reason}`
      });
      if (!permissionDecision.approved) {
        session.finalResponse = {
          status: "AWAITING_APPROVAL",
          reason: permissionDecision.reason,
          confirmationLevel: session.policyDecision?.confirmationLevel ?? null,
          informedApproval: session.policyDecision?.informedApproval ?? null
        };
        await this.persistSession(session);
        return session;
      }
      return this.continueApprovedSession(session);
    }

    return session;
  }

  // Canonical control-intent lane for lifecycle halts (pause / cancel). Like the
  // rollback convergence, this stops these transitions bypassing the runtime's
  // guarantees — but a halt does not plan, assess risk, perceive, or schedule, so
  // forcing it through submitIntent()'s reasoning pipeline would be dishonest
  // (fabricating a plan/risk for a no-op) and wasteful. Instead the lane shares
  // the guarantees that DO apply to a control action:
  //   1. Session validation.
  //   2. Deterministic policy AUTHORIZATION (is this transition legal from the
  //      current state?) via policyEngine.decideControl — not risk/planning.
  //   3. A chained, tamper-evident audit record of the authorization decision
  //      (CONTROL_INTENT_EVALUATED) AND the resulting transition.
  //   4. Persisted state transition.
  // Returns the (possibly unchanged) session, preserving the historical no-op
  // contract when the transition is denied.
  async submitControlIntent(command, sessionId, { reason } = {}) {
    const session = await this.sessionStore.get(sessionId);
    validateExecutionSession(session);

    const decision = this.policyEngine.decideControl(command, session);
    await this.auditRepository.append(session.sessionId, "CONTROL_INTENT_EVALUATED", {
      command,
      fromState: session.currentState,
      effect: decision.effect,
      reason: decision.reason
    });

    // Denied transitions (terminal session, illegal command) are a no-op beyond
    // the audit record — mirrors the prior guard that returned the session as-is.
    if (decision.effect === PolicyEffect.DENY) {
      return session;
    }

    if (command === "pause") {
      session.suspension = {
        suspendedFromState: session.currentState,
        reason,
        pausedAt: new Date().toISOString()
      };
      session.currentState = RuntimeState.PAUSED;
      session.finalResponse = { status: "PAUSED", reason };
      await this.auditRepository.append(session.sessionId, "SESSION_PAUSED", { reason });
    } else if (command === "cancel") {
      session.currentState = RuntimeState.CANCELLED;
      session.finalResponse = { status: "CANCELLED", reason };
      await this.auditRepository.append(session.sessionId, "SESSION_CANCELLED", { reason });
    }

    await this.persistSession(session);
    return session;
  }

  async pauseSessionById(sessionId, reason = "Paused by user request.") {
    return this.submitControlIntent("pause", sessionId, { reason });
  }

  async cancelSessionById(sessionId, reason = "Cancelled by user request.") {
    return this.submitControlIntent("cancel", sessionId, { reason });
  }

  async rollbackLatestSession() {
    const sessions = await this.sessionStore.list();
    const latest = sessions.at(-1);
    if (!latest) {
      return {
        status: "FAILED",
        message: "No session available for rollback."
      };
    }
    return this.rollbackSessionById(latest.sessionId);
  }

  // Manual rollback. This no longer calls rollbackManager.rollback() directly —
  // that bypassed validation/risk/policy/permission/scheduler. Instead it
  // translates the request into a canonical "session.rollback" intent and runs it
  // through submitIntent(), exactly like the privileged-execute compatibility
  // wrapper. The session.rollback capability performs the actual restore inside
  // the scheduler, so the rollback is risk-assessed, policy-evaluated,
  // permission-checked, executed, observed and verified like any other mutation.
  //
  // The explicit act of requesting a rollback IS the approval, so autoApprove
  // defaults to true (overridable). The method returns the ORIGINAL session,
  // marked ROLLED_BACK/FAILED per the pipeline outcome, preserving the historical
  // return contract used by the daemon/tests.
  async rollbackSessionById(sessionId, options = {}) {
    const target = await this.sessionStore.get(sessionId);
    validateExecutionSession(target);
    const records = Array.isArray(target.rollback?.records) ? target.rollback.records : [];

    const rollbackSession = await this.submitIntent(`Roll back session ${sessionId}`, {
      ...options,
      operation: "session.rollback",
      category: "ROLLBACK",
      normalizedGoal: `Roll back session ${sessionId}`,
      autoApprove: options.autoApprove ?? true,
      workspacePath: target.intent?.entities?.workspacePath ?? process.cwd(),
      entities: {
        workspacePath: target.intent?.entities?.workspacePath ?? process.cwd(),
        sessionId,
        records,
        targetRecordIds: Array.isArray(options.targetRecordIds) ? options.targetRecordIds : [],
        reason: options.reason ?? "Manual rollback requested."
      }
    });

    // The goal verifier reports COMPLETED_WITH_WARNINGS because the rollback
    // capability's own detected change ("rollback:<cap>") is not in the plan's
    // expected-mutation list — a cosmetic warning, not a failure. All three
    // (COMPLETED, COMPLETED_WITH_WARNINGS, ROLLED_BACK) mean the rollback ran and
    // verified through the pipeline.
    const rolledBack = ["COMPLETED", "COMPLETED_WITH_WARNINGS", "ROLLED_BACK"]
      .includes(rollbackSession.finalResponse?.status);

    // Reflect the pipeline outcome back onto the original session and link the two.
    target.currentState = rolledBack ? RuntimeState.ROLLED_BACK : RuntimeState.FAILED;
    if (target.rollback) target.rollback.completed = rolledBack;
    target.finalResponse = {
      status: rolledBack ? "ROLLED_BACK" : "FAILED",
      message: rolledBack
        ? "Manual rollback completed through the canonical pipeline."
        : (rollbackSession.finalResponse?.message ?? "Rollback did not complete."),
      rollbackSessionId: rollbackSession.sessionId
    };
    await this.auditRepository.append(target.sessionId, "MANUAL_ROLLBACK_REQUESTED", {
      rolledBack,
      rollbackSessionId: rollbackSession.sessionId
    });
    await this.persistSession(target);
    return target;
  }

  async persistSession(session) {
    validateExecutionSession(session);
    await this.sessionStore.save(session);
  }

  // Phase 9 secret injection. A capability may declare `requiredSecrets`: an
  // array of { inputKey, ref } (or the task may carry inputs.secretRefs mapping
  // inputKey -> secretRef). We resolve each ref via the DPAPI broker and place
  // the plaintext into task.inputs[inputKey] transiently, returning the list of
  // keys we set so the caller can scrub them after execution. Returns null when
  // there is nothing to inject or no broker is configured.
  async _resolveSecretsForTask(capability, task, session) {
    if (!this.secretBroker) return null;
    const specs = [];
    if (Array.isArray(capability?.requiredSecrets)) {
      for (const s of capability.requiredSecrets) {
        if (s?.inputKey && s?.ref) specs.push({ inputKey: s.inputKey, ref: s.ref });
      }
    }
    // Task-level references: inputs.secretRefs = { inputKey: secretRef }.
    const refMap = task?.inputs?.secretRefs;
    if (refMap && typeof refMap === "object") {
      for (const [inputKey, ref] of Object.entries(refMap)) {
        if (inputKey && ref) specs.push({ inputKey, ref });
      }
    }
    if (specs.length === 0) return null;

    task.inputs = task.inputs || {};
    const injectedKeys = [];
    for (const { inputKey, ref } of specs) {
      try {
        const value = await this.secretBroker.retrieveSecret(ref);
        task.inputs[inputKey] = value;
        injectedKeys.push(inputKey);
      } catch {
        // A missing/unreadable secret is surfaced to the capability as absence;
        // verification will fail and the closed loop handles it. We never log
        // the ref value itself.
        await this.addSessionEvent(session, "SECRET_RESOLUTION_FAILED", { taskId: task.taskId, inputKey });
      }
    }
    if (injectedKeys.length > 0) {
      await this.addSessionEvent(session, "SECRETS_INJECTED", { taskId: task.taskId, keys: injectedKeys });
    }
    return injectedKeys.length ? injectedKeys : null;
  }

  // Remove injected plaintext secrets from task.inputs after execution so they
  // are never persisted with the session.
  _scrubInjectedSecrets(task, injectedKeys) {
    if (!task?.inputs) return;
    for (const key of injectedKeys) {
      delete task.inputs[key];
    }
  }

  async _rollbackSession(session) {
    const rollback = session.rollback;
    if (!rollback?.records?.length) return { rolledBack: false, reason: "No rollback records available." };
    if (rollback.completed) return rollback.result;

    const result = await this.rollbackManager.rollback(rollback.records);
    rollback.completed = true;
    rollback.result = result;
    for (const entry of result.entries) {
      await this.addSessionEvent(session, entry.status === "ROLLED_BACK" ? "ROLLBACK_COMPLETED" : "ROLLBACK_FAILED", entry);
    }
    if (this.perception) {
      try {
        await this.perception.perceive({ workspacePath: session.intent?.entities?.workspacePath });
        await this.perception.snapshot(`rollback:${session.sessionId}`);
      } catch { /* rollback state is still recorded even when perception is unavailable */ }
    }
    if (this.memory) {
      await this.memory.store({
        id: createId("memory"),
        type: "SYSTEM_HISTORY",
        content: { sessionId: session.sessionId, rollback: result },
        summary: `Rollback ${result.rolledBack ? "completed" : "partially failed"} for session ${session.sessionId}`,
        provenance: "rollback",
        confidence: result.rolledBack ? 1 : 0.5,
        sensitivity: "LOW",
        relatedSession: session.sessionId
      });
    }
    await this.persistSession(session);
    return result;
  }
}
