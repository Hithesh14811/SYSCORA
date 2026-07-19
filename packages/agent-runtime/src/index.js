import path from "node:path";
import {
  PolicyEffect,
  RuntimeState,
  createId,
  validateExecutionSession,
  validateIntent
} from "../../shared-types/src/domain.js";
import { IntentEngine } from "../../intent-engine/src/index.js";
import { ContextEngine, SystemContextProvider, ProcessContextProvider, PortContextProvider, EnvironmentContextProvider, WorkspaceContextProvider } from "../../context-engine/src/index.js";
import { GeneralPlanner, PlanValidator } from "../../planner/src/index.js";
import { MockModelProvider } from "../../model-providers/src/index.js";
import { TaskGraphScheduler } from "../../task-graph-scheduler/src/index.js";
import { PerceptionEngine } from "../../perception/src/index.js";
import { ReasoningEngine } from "../../reasoning-engine/src/index.js";
import { GoalVerifier } from "./goal-verifier.js";
import { RollbackManager } from "./rollback-manager.js";
import { createRecoveryBudget } from "../../recovery-engine/src/index.js";

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
    this.goalVerifier = new GoalVerifier();
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

  async submitIntent(rawText, options = {}) {
    const MAX_REPLAN_ATTEMPTS = 2; // Bounded replanning - max 2 attempts
    let replanAttempts = 0;
    let originalPlan = null;
    
    const session = {
      sessionId: createId("session"),
      createdAt: new Date().toISOString(),
      currentState: RuntimeState.RECEIVE_INTENT,
      intent: null,
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
      finalResponse: null,
      events: []
    };

    await this.addSessionEvent(session, "INTENT_RECEIVED", { rawText });
    await this.persistSession(session);

    try {
      // 1. Understand intent
      session.currentState = RuntimeState.BUILD_CONTEXT;
      session.intent = await this.intentEngine.classify(rawText, { workspacePath: process.cwd(), ...options });
      await this.addSessionEvent(session, "INTENT_CLASSIFIED", session.intent);
      await this.persistSession(session);

      if (session.intent.ambiguity) {
        session.currentState = RuntimeState.AMBIGUOUS_INTENT;
        session.finalResponse = { status: "NEEDS_CLARIFICATION", questions: session.intent.clarificationQuestions };
        await this.persistSession(session);
        return session;
      }

      // 2. Collect context (including semantic state and memory)
      const requiredContext = session.intent.requiredContext || [];
      const baseContext = await this.contextEngine.collectContext(requiredContext, session.intent.entities);
      let semanticContext = [];
      let relevantMemory = [];
      
      // Perception populates the world model from live Windows state (via its
      // read-only providers), then the planner receives only a relevant, budgeted
      // subgraph — never the whole graph.
      if (this.perception) {
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

      if (this.memory) {
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
        includesSemantic: !!this.semanticState,
        includesMemory: !!this.memory,
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

      // 3. Generate plan (memory + semantic state passed as planning inputs)
      session.currentState = RuntimeState.GENERATE_PLAN;
      session.plan = await this.generalPlanner.generatePlan(
        session.intent,
        planningContext,
        semanticContext,
        relevantMemory,
        { priorProcedures, priorFailures }
      );
      originalPlan = session.plan;
      await this.addSessionEvent(session, "PLAN_GENERATED", session.plan);
      await this.persistSession(session);

      // 4. Validate plan
      session.currentState = RuntimeState.VALIDATE_PLAN;
      const planValidation = this.planValidator.validatePlan(session.plan.taskGraph);
      await this.addSessionEvent(session, "PLAN_VALIDATED", planValidation);
      if (!planValidation.valid) {
        session.currentState = RuntimeState.PLAN_REJECTED;
        session.finalResponse = { status: "PLAN_REJECTED", errors: planValidation.errors };
        await this.persistSession(session);
        return session;
      }
      await this.persistSession(session);

      // 5. Assess risk
      session.currentState = RuntimeState.ASSESS_RISK;
      session.riskAssessment = this.riskEngine.assess(session.plan, session.context);
      await this.addSessionEvent(session, "RISK_ASSESSED", session.riskAssessment);
      await this.persistSession(session);

      // 6. Apply policy
      session.currentState = RuntimeState.APPLY_POLICY;
      session.policyDecision = this.policyEngine.decide(session.riskAssessment, session.plan);
      await this.addSessionEvent(session, "POLICY_DECIDED", session.policyDecision);
      await this.persistSession(session);

      if (session.policyDecision.effect === PolicyEffect.DENY) {
        session.currentState = RuntimeState.FAILED;
        session.finalResponse = { status: "DENIED", reason: session.policyDecision.reason };
        await this.persistSession(session);
        return session;
      }

      // 7. Check approval
      session.currentState = RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED;
      const permissionDecision = this.permissionBroker.evaluate({
        policyDecision: session.policyDecision,
        autoApprove: options.autoApprove === true
      });
      await this.addSessionEvent(session, "APPROVAL_EVALUATED", permissionDecision);
      if (!permissionDecision.approved) {
        session.finalResponse = { status: "AWAITING_APPROVAL", reason: permissionDecision.reason };
        await this.persistSession(session);
        return session;
      }
      await this.persistSession(session);

      // 8. Execute tasks with TaskGraphScheduler (single canonical pipeline).
      session.currentState = RuntimeState.EXECUTING;
      const execResult = await this._executeTaskGraph(session, { replanAttempts, MAX_REPLAN_ATTEMPTS, originalPlan });

      // 9-11. Update semantic state + memory, then final goal verification.
      // Skip finalization if the loop already reached a terminal state
      // (rollback / hard failure / awaiting approval) so we don't overwrite it.
      if (!execResult?.terminated) {
        await this._finalizeSession(session);
      }
      return session;
    } catch (error) {
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = { status: "FAILED", message: error.message };
      await this.addSessionEvent(session, "ERROR_OCCURRED", { error: error.message });
      await this.persistSession(session);
      return session;
    }
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
  // the TaskGraphScheduler: checkpoint -> execute -> observe -> verify, with
  // bounded replanning on verification failure. Both fresh intents
  // (submitIntent) and resumed/approved sessions use this exact loop, so there
  // is exactly one execution path in the runtime.
  async _executeTaskGraph(session, options = {}) {
    let replanAttempts = options.replanAttempts ?? 0;
    const MAX_REPLAN_ATTEMPTS = options.MAX_REPLAN_ATTEMPTS ?? 2;
    const originalPlan = options.originalPlan ?? session.plan;

    // Issue authoritative capability grants for the approved plan before any
    // task runs. Deny-by-default enforcement in the pipeline's authorize()
    // callback consumes these; without a grant a capability cannot execute even
    // though the session and policy approval exist.
    await this._issuePlanGrants(session, session.plan);

    this.taskGraphScheduler.initialize(session.plan.taskGraph);

    while (!this.taskGraphScheduler.isComplete()) {
      const readyTasks = this.taskGraphScheduler.getReadyTasks();

      for (const task of readyTasks) {
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
          capability: task.capability
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
          execution = await this.taskGraphScheduler.executeTask(task);
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
        await this.addSessionEvent(session, "VERIFICATION_COMPLETED", verification);
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
            (verification.status === "VERIFIED" || verification.status === "PARTIALLY_VERIFIED")) {
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
            (verification.status === "VERIFIED" || verification.status === "PARTIALLY_VERIFIED") &&
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

        if (verification.status !== "VERIFIED" && verification.status !== "PARTIALLY_VERIFIED") {
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

  async addSessionEvent(session, eventType, details) {
    const event = {
      eventId: createId("event"),
      eventType,
      timestamp: new Date().toISOString(),
      details
    };
    session.events.push(event);
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
          .filter((v) => v && v.status !== "VERIFIED" && v.status !== "PARTIALLY_VERIFIED")
          .map((v) => v.message)
      };
      const summaryResult = await this.reasoningEngine.summarizeExecution(facts);
      if (summaryResult.ok) {
        executionSummary = { ...summaryResult.data, source: summaryResult.source };
      }
    } catch {
      executionSummary = null;
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
      maxReplanAttempts: MAX_REPLAN_ATTEMPTS
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

      session.currentState = RuntimeState.VALIDATE_PLAN;
      const planValidation = this.planValidator.validatePlan(newPlan.taskGraph);
      await this.addSessionEvent(session, "PLAN_VALIDATED", planValidation);
      if (!planValidation.valid) {
        await this.addSessionEvent(session, "REPLAN_FAILED", { reason: "Plan validation failed", errors: planValidation.errors });
        return this._handleFailureWithoutReplan(session, task, verification, diagnosis);
      }

      newPlan.planVersion = (session.plan.planVersion || 1) + 1;
      newPlan.parentPlanId = session.plan.planId;
      session.plan = newPlan;
      await this.addSessionEvent(session, "PLAN_UPDATED", { planId: newPlan.planId, planVersion: newPlan.planVersion, preservedTaskIds: completedTaskIds });
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
      const permissionDecision = this.permissionBroker.evaluate({
        policyDecision: session.policyDecision,
        autoApprove: options.autoApprove === true
      });
      await this.auditRepository.append(session.sessionId, "APPROVAL_EVALUATED", {
        required: permissionDecision.required,
        approved: permissionDecision.approved,
        reason: `Resume flow: ${permissionDecision.reason}`
      });
      if (!permissionDecision.approved) {
        session.finalResponse = {
          status: "AWAITING_APPROVAL",
          reason: permissionDecision.reason
        };
        await this.persistSession(session);
        return session;
      }
      return this.continueApprovedSession(session);
    }

    return session;
  }

  async pauseSessionById(sessionId, reason = "Paused by user request.") {
    const session = await this.sessionStore.get(sessionId);
    validateExecutionSession(session);
    if ([RuntimeState.COMPLETED, RuntimeState.FAILED, RuntimeState.ROLLED_BACK, RuntimeState.CANCELLED].includes(session.currentState)) {
      return session;
    }
    session.suspension = {
      suspendedFromState: session.currentState,
      reason,
      pausedAt: new Date().toISOString()
    };
    session.currentState = RuntimeState.PAUSED;
    session.finalResponse = {
      status: "PAUSED",
      reason
    };
    await this.auditRepository.append(session.sessionId, "SESSION_PAUSED", { reason });
    await this.persistSession(session);
    return session;
  }

  async cancelSessionById(sessionId, reason = "Cancelled by user request.") {
    const session = await this.sessionStore.get(sessionId);
    validateExecutionSession(session);
    if ([RuntimeState.COMPLETED, RuntimeState.FAILED, RuntimeState.ROLLED_BACK, RuntimeState.CANCELLED].includes(session.currentState)) {
      return session;
    }
    session.currentState = RuntimeState.CANCELLED;
    session.finalResponse = {
      status: "CANCELLED",
      reason
    };
    await this.auditRepository.append(session.sessionId, "SESSION_CANCELLED", { reason });
    await this.persistSession(session);
    return session;
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
