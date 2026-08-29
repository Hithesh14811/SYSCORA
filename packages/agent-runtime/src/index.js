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
import { IntentEngine, providerIsRemoteModel } from "../../intent-engine/src/index.js";
import { ContextEngine, SystemContextProvider, ProcessContextProvider, PortContextProvider, EnvironmentContextProvider, WorkspaceContextProvider } from "../../context-engine/src/index.js";
import { GeneralPlanner, OPERATION_PLANS, PlanValidator, assessPlanGoalCoverage } from "../../planner/src/index.js";
import { MockModelProvider, validateSchema } from "../../model-providers/src/index.js";
import { TaskGraphScheduler } from "../../task-graph-scheduler/src/index.js";
import { PerceptionEngine } from "../../perception/src/index.js";
import { captureScreenSnapshotViaAdapter } from "../../perception/src/vision-provider.js";
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
  buildExplicitApplicationLaunchStrategy,
  isUiFacingAction
} from "./interactive-agent-controller.js";
import {
  assessGoalContractEvidence,
  createGoalContract,
  matchGoalCriteriaForTask
} from "../../shared-types/src/goal-contract.js";
import {
  appendEvidence,
  createEvidenceLedger,
  evaluateEvidenceLedger
} from "../../shared-types/src/evidence-ledger.js";
import { summarizeReadOnlyResults } from "./read-result-summary.js";
import { PrerequisiteResolver } from "./prerequisite-resolver.js";
import { EnvironmentModel } from "../../context-engine/src/environment-model.js";
import { FailureReason, FastAgent, buildToolset } from "../../fast-agent/src/index.js";
import { deleteSkill, readSkills, recordSkillRun, writeSkill } from "../../fast-agent/src/skills.js";
import {
  canAutoApprove,
  normalizeAccessPolicy
} from "../../shared-types/src/access-policy.js";

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

// How long a reading of a window may stand in for "what is on screen right
// now". Deliberately short: it exists to stop the same picture being taken twice
// within one step, not to let the agent act on a stale view. Anything the agent
// itself just did invalidates it, because a post-action reading never uses it.
const SCREEN_MEMO_TTL_MS = 2500;

// How long the agent waits for an answer before treating silence as "no". Long
// enough that the user can read the command and think about it; short enough
// that a question asked while nobody is watching does not hold a run open until
// its own six-minute budget runs out.
const APPROVAL_TIMEOUT_MS = 120000;

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

function evidenceIdentity(task, observation) {
  const state = observation?.structuredState ?? {};
  const target = state.target ?? task?.inputs?.target ?? {};
  const window = state.groundedWindow ?? state.window ?? target.windowIdentity ?? {};
  return {
    application: window.application ?? window.processName ?? task?.inputs?.application ?? null,
    processId: window.processId ?? state.processId ?? null,
    windowId: window.windowId ?? target.windowId ?? task?.inputs?.windowId ?? null,
    pageId: state.pageId ?? state.tabId ?? null,
    url: state.url ?? state.location ?? null
  };
}

function verificationIsIndependent(capability, executionResult, observation, verification) {
  if (verification?.independentFromActionResult === true) return true;
  if (capability?.permissionModel?.type === "READ") return true;
  const evidence = verification?.evidence;
  return evidence != null
    && evidence !== executionResult
    && evidence !== observation?.structuredState;
}

export class AgentRuntime {
  // HOW OFTEN THE OFFLINE PIPELINE IS ACTUALLY REACHED, counted for the whole
  // process rather than per session, because the question it answers is about
  // the product and not about one request: `docs/production-plan.md` W4.2 wants
  // those ~20,000 lines deleted or quarantined, and that should be settled by a
  // number. Quarantined behind a typed reason first (see _submitFastIntent);
  // deleting it is a later session's job, with this count as the evidence.
  static stagedPipelineReaches = 0;

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
    memory,
    // WHERE THIS RUNTIME'S STATE LIVES, KNOWN BEFORE THE FIRST REQUEST.
    //
    // `_basePath` was set lazily, by the first `submitIntent`, from that call's
    // `workspacePath`. Everything that reads or writes a skill falls back to
    // `process.cwd()` until then — so `startServer({ basePath: someTempDir })`
    // was honoured for config, audit and sessions, and silently ignored for
    // skills. A test that started a daemon on a temp workspace and saved a route
    // wrote it into the REAL `.syscora/skills` of whatever directory node
    // happened to be started from, and then three other tests failed because the
    // store they expected to be empty was not.
    //
    // The daemon knows this path at construction. Passing it means the lazy
    // default is only reached by a caller that genuinely never said.
    basePath = null
  }) {
    this._basePath = basePath;
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
          capabilityRegistry: this.capabilityRegistry,
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
    // Questions the agent has asked and nobody has answered yet, by id.
    this._approvals = new Map();
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
          capabilityRegistry: this.capabilityRegistry,
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
      evidenceLedger: createEvidenceLedger(),
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

  // THE ROUTE A REQUEST TAKES.
  //
  // A model that can hold a tool-calling conversation runs the agent loop, which
  // is every case that matters in production. The staged pipeline below it —
  // classify, collect context, plan, validate, assess risk, apply policy,
  // request approval, schedule, observe, verify — remains the route when there
  // is no such model, because offline it is not a degraded path, it is the only
  // one that works at all. It is not a fallback FROM the loop: a loop that fails
  // fails for reasons re-running it as a plan will not fix.
  _canRunFastAgent(options = {}) {
    if (options.fast === false) return false;
    const provider = this.reasoningEngine?.modelProvider;
    return typeof provider?.chat === "function" && provider.supportsChat?.() === true;
  }

  /**
   * Answer a question the agent asked before doing something irreversible.
   *
   * Returns false when the approval is unknown — already answered, timed out, or
   * from a run that has since finished — so a late click cannot authorize
   * anything.
   */
  resolveApproval(approvalId, approved) {
    const settle = this._approvals?.get(String(approvalId));
    if (!settle) return false;
    settle(approved === true);
    return true;
  }

  _resolveAllApprovals(approved) {
    if (!this._approvals?.size) return;
    for (const settle of [...this._approvals.values()]) settle(approved === true);
  }

  /**
   * What this runtime did to the machine that nobody has been told about.
   *
   * For the crash handler in the daemon: if the process dies mid-action, the
   * only record that a file was overwritten or a message sent is the in-memory
   * journal, and it dies with it. This is what gets written down instead.
   *
   * Deliberately NOT through `_ensureToolset()`. A crash handler that
   * CONSTRUCTS things — a toolset, a PowerShell host, a registry — can fail
   * inside the failure and lose the original error. No toolset means nothing
   * was done, which is both the honest answer and the cheap one.
   */
  interruptedWork() {
    try { return this._toolset?.interruptedWork?.() ?? []; } catch { return []; }
  }

  _ensureToolset(workspacePath = null) {
    if (!this._toolset) {
      // A request that names a workspace still wins — that is the caller being
      // specific — but the runtime's own base path is the default now, not cwd.
      this._basePath = workspacePath ?? this._basePath ?? process.cwd();
      this._toolset = buildToolset({
        registry: this.capabilityRegistry,
        adapter: this.adapter,
        basePath: this._basePath
      });
    }
    return this._toolset;
  }

  /**
   * The saved routes, as the loop wants them.
   *
   * Only `list` and `recordRun`: nothing here can WRITE a skill, because a run
   * that worked is offered rather than saved (see `_offerSkill`), and the offer
   * is accepted by the user through the surface. A route that drives somebody's
   * machine should not appear on their disk because a task happened to succeed.
   */
  /** Every saved route. The surface lists these beside the chats. */
  async listSkills() {
    this._ensureToolset();
    return readSkills(this._basePath ?? process.cwd());
  }

  /**
   * Keep a route the user has just agreed to.
   *
   * The ONLY way a skill reaches the disk. `writeSkill` refuses anything
   * positional or stepless and says why, and that refusal is passed straight
   * back rather than softened — a skill saved with a coordinate in it is a macro
   * that will click a blank pixel one day and report success.
   */
  async saveSkill(skill) {
    this._ensureToolset();
    if (!skill || typeof skill !== "object") return { saved: false, problems: ["no skill was given"] };
    return writeSkill(this._basePath ?? process.cwd(), skill);
  }

  async deleteSkill(id) {
    this._ensureToolset();
    return deleteSkill(this._basePath ?? process.cwd(), id);
  }

  _skillStore() {
    const basePath = this._basePath ?? process.cwd();
    return {
      list: () => readSkills(basePath),
      recordRun: (id, outcome) => recordSkillRun(basePath, id, outcome)
    };
  }

  /**
   * Read what machine this is before the user's first message, not inside it.
   *
   * The profile — the real Documents/Desktop paths, whether OneDrive holds them,
   * which desktop applications exist — is one PowerShell call cached for the life
   * of the process. Read lazily it was paid for inside the FIRST request of every
   * session, where it is several seconds of silence before a single word appears.
   * The automation host has been warmed at startup all along; this is the same
   * argument for the same reason.
   *
   * Best-effort and never throws: a machine this cannot be read on is one the
   * agent still has to work on.
   */
  warmMachineFacts(workspacePath = null) {
    try {
      return Promise.resolve(this._ensureToolset(workspacePath).machineFacts?.()).catch(() => "");
    } catch {
      return Promise.resolve("");
    }
  }

  async submitIntent(rawText, options = {}) {
    if (this._canRunFastAgent(options)) return this._submitFastIntent(rawText, options);
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

  /**
   * Run one request through the agent loop.
   *
   * The session object it returns is the same shape every other route returns,
   * because the daemon, the session store and the chat surface all read it — but
   * what it records is only what happened: what was said, which tools ran, and
   * what they returned. There is no plan, because nothing composed one; no risk
   * assessment, policy decision or approval commitment, because nothing was
   * gated; no evidence ledger, because the model checks its own work by reading
   * the screen back and says so in words the user can see.
   */
  async _submitFastIntent(rawText, options = {}) {
    const session = this._createSession(options);
    session.currentState = RuntimeState.EXECUTING;
    session.fast = true;
    options.onSessionCreated?.(session);
    options.onSessionStarted?.(session.sessionId);

    // Streaming means an event per token. Routing those through addSessionEvent
    // would append one audit file write per token and store the whole stream
    // twice — once as deltas, once as the finished message. Prose deltas are
    // published live and not retained; everything else is a durable event.
    const emit = (event) => {
      if (event.type === "AGENT_DELTA") {
        this.onSessionEvent?.(session.sessionId, { eventType: event.type, ...event });
        return;
      }
      const record = {
        eventId: createId("event"),
        eventType: event.type,
        timestamp: new Date().toISOString(),
        details: event.details ?? {}
      };
      // PROGRESS IS FOR THE PERSON WATCHING, NOT FOR THE RECORD.
      //
      // A bar that moves is a hundred events over a forty-second install, and
      // every one of them is superseded by the next. Keeping them would put a
      // hundred rows in the session history and the audit log to say what the
      // command's own output says once, in full, when it finishes — and the
      // session record is replayed to rebuild a transcript, where a stale 43%
      // means nothing at all.
      //
      // So they go to whoever is watching right now and nowhere else.
      //
      // TOOL_STREAMING is the same kind of thing at the other end of a step: the
      // model composing the call, byte count climbing, every event superseded by
      // the next and all of them superseded by the TOOL_STARTED that follows. It
      // is worth watching and worthless to keep.
      if (event.type === "TOOL_PROGRESS" || event.type === "TOOL_STREAMING") {
        this.onSessionEvent?.(session.sessionId, record);
        return;
      }
      session.events.push(record);
      this.onSessionEvent?.(session.sessionId, record);
      this.auditRepository?.append?.(session.sessionId, event.type, record.details).catch?.(() => {});
    };

    emit({ type: "INTENT_RECEIVED", details: { rawText } });

    // ONE TOOLSET, NOT ONE PER MESSAGE.
    //
    // The toolset holds what the agent knows about the machine right now: which
    // window it is working in, which windows it opened itself, what the last
    // screen reading found, which directory the terminal is in. Rebuilding it
    // per request threw all of that away between turns — so "open Notepad" and
    // then "now write a poem in it" were two strangers. The second turn had no
    // working window, and `screen` with nothing to go on reads whatever is in
    // front, which is this application's own chat window.
    //
    // The state is about the MACHINE, and there is one machine. Conversations
    // are the client's to keep; where the pointer and the focus are is not.
    const toolset = this._ensureToolset(options.workspacePath);
    const accessPolicy = normalizeAccessPolicy(options);
    toolset.setAccessPolicy?.(accessPolicy);
    // ASKING, WITHOUT A PIPELINE BEHIND IT.
    //
    // The staged route had a whole approval apparatus — risk assessment, policy
    // evaluation, a signed commitment, a token — and it cost several model calls
    // and several seconds on EVERY action, which is why it is not on this path.
    // What it was protecting against, though, is real: an agent that deletes the
    // wrong folder or uninstalls the wrong application cannot put it back.
    //
    // So the question is asked where it costs nothing to not ask: one regex over
    // the command line, and a card in the transcript only for the handful of
    // shapes that are irreversible. No model call, no plan, no scheduler.
    //
    // A CALLER THAT SAID "YES" IN ADVANCE HAS TO BE HEARD, OR NOTHING
    // IRREVERSIBLE CAN EVER RUN UNATTENDED.
    //
    // `autoApprove` was honoured by the staged pipeline and NEVER read here, on
    // the route every real request takes — not a regression, it has been absent
    // since d91fd43 first put an approval gate on this path. Nothing surfaced it
    // because the only task that exercises it verified with
    // `Write-Output 'checked-by-human'` and passed unconditionally.
    //
    // What it looked like, measured 19 Aug 2026: the eval sends
    // `autoApprove: true`, the daemon forwards it, the card is emitted to nobody,
    // and 120,000ms later the timeout below reads the silence as a refusal. The
    // agent then behaved perfectly — reported the draft unsent, refused to retry
    // by another route — so the product's flagship demonstration failed 0/3 with
    // an honest explanation, and the honesty made it look like a click bug.
    // Three runs at 136.7s, 137.0s and 149.9s: about twenty seconds of work and
    // two minutes of waiting.
    //
    // The card is STILL emitted when auto-approving. A standing authorization is
    // a reason not to ask, never a reason not to record — the audit has to be
    // able to say what was authorized, and `autoApproved` on the resolution is
    // what tells a human click apart from a caller's blanket yes.
    //
    // This answers CONFIRM cards only. The DENY floor is checked where the
    // process is actually spawned (see the gate in tools.js), so nothing here
    // can talk it round.
    const askUser = (request) => new Promise((resolve) => {
      const automatic = canAutoApprove(request, accessPolicy);
      const approvalId = createId("approval");
      const settle = (approved, automatic = false) => {
        if (!this._approvals.delete(approvalId)) return;
        clearTimeout(timer);
        emit({ type: "APPROVAL_RESOLVED", details: { approvalId, approved, autoApproved: automatic } });
        resolve(approved);
      };
      // Nobody answered. Not approving is the only safe reading of silence, and
      // it must not hold the run open forever.
      const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this._approvals.set(approvalId, settle);
      emit({
        type: "APPROVAL_REQUIRED",
        details: {
          approvalId,
          sessionId: session.sessionId,
          summary: request.summary,
          reason: request.reason,
          rule: request.rule,
          detail: request.detail,
          timeoutMs: APPROVAL_TIMEOUT_MS,
          autoApproved: automatic,
          approvalMode: accessPolicy.approvalMode
        }
      });
      if (automatic) settle(true, true);
    });
    // A stop press is an answer too: refuse anything still waiting rather than
    // leaving the run stuck behind a card nobody is going to click.
    options.signal?.addEventListener?.("abort", () => this._resolveAllApprovals(false), { once: true });
    toolset.setConfirmer?.(askUser);
    const agent = new FastAgent({
      provider: this.reasoningEngine.modelProvider,
      toolset,
      onEvent: emit,
      signal: options.signal ?? null,
      skills: this._skillStore(),
      memory: this.memory,
      // The composer's Thinking control, per request. Null when the caller did
      // not choose, which leaves the process default alone.
      thinking: options.thinking ?? null,
      ...(Number.isFinite(Number(options.maxElapsedTime)) && Number(options.maxElapsedTime) > 0
        ? { maxElapsedMs: Number(options.maxElapsedTime) }
        : {})
    });

    let outcome;
    try {
      outcome = await agent.run(rawText, { history: options.history ?? [] });
    } catch (error) {
      outcome = {
        status: "FAILED",
        message: error instanceof Error ? error.message : String(error),
        steps: 0,
        toolCalls: 0,
        elapsedMs: 0
      };
    } finally {
      // The transcript this could have asked in is finished. Anything still
      // waiting is refused, and nothing may ask through it again.
      this._resolveAllApprovals(false);
      toolset.setConfirmer?.(null);
    }

    // The model was configured but could not be reached, and nothing has run —
    // no tool was called, so nothing on the machine has been touched. That is
    // the one case where the staged pipeline is worth paying for: it plans from
    // typed capabilities without a model at all, so a request like "tell me
    // about this computer" is still answerable with the network down. It is
    // reached only from a standing start, never to retry work the loop began.
    // A THROTTLED ACCOUNT IS NOT AN OFFLINE MACHINE.
    //
    // The staged pipeline exists for the case where no model can be reached at
    // all, and it answers from typed capabilities — so when it cannot map a
    // request it says "I couldn't turn that into a concrete action". Live, a
    // 429 took that branch, and the honest message the loop had already written
    // ("your model provider is rate-limiting this account") was thrown away and
    // replaced with a sentence that blames the request. The user asked a
    // perfectly clear question and was told it made no sense.
    //
    // Rate limiting, quota and authentication are facts about the account, and
    // re-planning cannot help with any of them.
    //
    // A DROPPED CONNECTION IS NOT AN OFFLINE MACHINE EITHER, AND THIS IS THE
    // COMMON CASE. Measured live, 16 Aug 2026: four requests in a row hit
    // "deepseek: fetch failed" on a brief network wobble, and every one fell
    // through to the staged pipeline. Asked "is python installed?", it ran a
    // WinGet package inspection and answered:
    //
    //   Task 1fce993df4344396d96cb860502089b5 failed: Execution exited with
    //   nonzero code 2316632084.
    //
    // A raw Win32 status and an internal GUID, for a question `python --version`
    // answers in a second. The pipeline plans from typed capabilities, so on
    // anything it cannot map it produces confident nonsense rather than nothing
    // — and the loop had already written the truthful message, which was thrown
    // away to make room for it.
    // ASK THE LOOP WHY, DO NOT GUESS FROM WHAT IT SAID.
    //
    // Both paragraphs above were written after the guess went wrong, and both
    // fixes were regexes over the user-facing sentence — first for 429s, then
    // for dropped connections. The third case arrived on 20 Aug 2026 and no
    // regex would have caught it, because the run had not failed for any
    // model-related reason at all: the model refused a dangerous request
    // correctly, the lie detector read the refusal's mention of `C:\Windows` as
    // an unevidenced machine fact, and the loop settled FAILED with zero tool
    // calls. `FAILED && toolCalls === 0` said "unreachable". It was not.
    //
    // Measured, live, on the safety task: refusal correct at 11.4s, FAILED at
    // 14.4s, the offline pipeline then running until 107.7s before reporting it
    // could not help either. Ninety-three seconds re-deriving an answer that was
    // already right and already on screen.
    //
    // The loop now records WHY it stopped. Only MODEL_UNREACHABLE takes this
    // branch, because it is the only reason for which planning without a model
    // beats what the loop already has. Everything else — throttled, malformed,
    // out of budget, no evidence — keeps the loop's own honest sentence.
    const unreachable = outcome.failureReason === FailureReason.MODEL_UNREACHABLE;
    if (unreachable && options.fast !== true) {
      // HOW OFTEN IS THIS ACTUALLY REACHED? production-plan.md W4.2 wants ~20,000
      // lines of staged pipeline deleted or quarantined, and that decision should
      // be made on a count rather than an argument. Counted per process and
      // surfaced through the daemon so the eval can record it.
      AgentRuntime.stagedPipelineReaches += 1;
      emit({
        type: "FAST_AGENT_UNAVAILABLE",
        details: { reason: outcome.message, failureReason: outcome.failureReason }
      });
      const staged = await this._submitIntent(rawText, { ...options, fast: false, existingSession: session });
      // AND IF THE FALLBACK CANNOT ANSWER EITHER, SAY THE TRUE THING.
      //
      // The staged pipeline plans from typed capabilities, so for a request it
      // cannot map it does not fall silent — it maps the request to the nearest
      // capability it has and runs that. Measured live, 16 Aug 2026: four turns
      // in a row hit "deepseek: fetch failed" on a brief network wobble, and
      // "is python installed?" came back as
      //
      //   Task 1fce993df4344396d96cb860502089b5 failed: Execution exited with
      //   nonzero code 2316632084
      //
      // — a WinGet scan, a raw Win32 status and an internal GUID, for a question
      // `python --version` answers in a second. The loop had already written the
      // truthful message and it was thrown away to make room for that.
      //
      // Its successes are worth keeping: with the network genuinely down it can
      // still describe the machine. Only its FAILURES are replaced, and only
      // with the reason the model could not be reached.
      if (staged?.finalResponse && staged.finalResponse.status !== "COMPLETED") {
        staged.finalResponse = {
          ...staged.finalResponse,
          message: `${outcome.message}\n\nI tried to answer without the model and could not map that request ` +
            "to something I can do offline. Nothing on the machine was changed."
        };
      }
      return staged;
    }

    // COMPLETED is the only state the runtime can honestly claim here, and it
    // claims it whenever the loop finished — the model's own words say what was
    // and was not achieved. A stopped-early run is recorded as FAILED so the
    // daemon treats it as terminal, with the real status on finalResponse.
    //
    // DECLINED sits with COMPLETED rather than with FAILED, and the distinction
    // is the point: a user saying no is a run that ENDED PROPERLY. Nothing went
    // wrong, nothing needs retrying, and nothing should be coloured red. The
    // status string is not new — `unsupportedAction` below has settled DECLINED
    // against a COMPLETED runtime state since long before this, for the same
    // reason. What is new is that the agent loop can reach it.
    session.currentState = outcome.status === "COMPLETED" || outcome.status === "DECLINED"
      ? RuntimeState.COMPLETED
      : outcome.status === "CANCELLED"
        ? RuntimeState.CANCELLED
        : RuntimeState.FAILED;
    session.finalResponse = {
      status: outcome.status,
      message: outcome.message,
      rawText,
      metrics: {
        steps: outcome.steps,
        toolCalls: outcome.toolCalls,
        elapsedMs: outcome.elapsedMs,
        tokensIn: outcome.tokensIn ?? 0,
        tokensOut: outcome.tokensOut ?? 0,
        // What was sent versus what was billed at full rate. The endpoint serves
        // the fixed prefix from its cache at roughly a tenth of the price, and
        // reporting only `tokensIn` made every long run look an order of
        // magnitude more expensive than it is. See the fast-agent loop.
        tokensCached: outcome.tokensCached ?? 0,
        tokensFresh: outcome.tokensFresh ?? Math.max(0, (outcome.tokensIn ?? 0) - (outcome.tokensCached ?? 0))
      }
    };
    await this.persistSession(session).catch(() => {});
    return session;
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
      evidenceLedger: createEvidenceLedger(),
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
    // Continuing a session the agent loop opened and could not use, because the
    // model was unreachable. It keeps its id and its events: the daemon has
    // already published that id to the client, and a second id would strand the
    // live stream on a session nothing further is ever written to.
    if (options.existingSession) {
      session.sessionId = options.existingSession.sessionId;
      session.createdAt = options.existingSession.createdAt;
      session.events = options.existingSession.events;
    }
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
      // Whether this turn's meaning depends on what was said before. Goal
      // coverage reads it: a follow-up like "bump it up to 55" cannot be judged
      // against its own words, because its subject is in the previous turn.
      session.intent.resolvedFromConversation = Array.isArray(options.history) && options.history.length > 0;
      session.goalContract = createGoalContract(session.intent);
      session.intent.goalContract = session.goalContract;
      await this.addSessionEvent(session, "INTENT_CLASSIFIED", session.intent);
      if (session.goalContract) {
        await this.addSessionEvent(session, "GOAL_CONTRACT_CREATED", session.goalContract);
      }
      await this.persistSession(session);

      // The request asks the runtime to commit money or a reservation. No
      // capability does that, so there is nothing to plan: answer plainly and
      // stop here rather than composing UI automation that would drive a real
      // checkout flow it cannot safely finish. Nothing has run at this point,
      // so no state was touched.
      if (session.intent.unsupportedAction) {
        session.currentState = RuntimeState.COMPLETED;
        session.finalResponse = {
          status: "DECLINED",
          message: session.intent.unsupportedAction.message,
          reason: session.intent.unsupportedAction.kind,
          rawText
        };
        await this.addSessionEvent(session, "UNSUPPORTED_ACTION_DECLINED", {
          kind: session.intent.unsupportedAction.kind,
          rawText
        });
        session.plan = null;
        await this.persistSession(session);
        return session;
      }

      // 1a. CONVERSATION. The model classified this as a message that asks
      // nothing of the computer and answered it in the same call. Talking is a
      // first-class outcome, not the thing left over when planning finds no
      // task, so it settles here — before context collection and planning —
      // rather than after paying for both and discovering there was nothing to
      // plan. Nothing has executed at this point, so nothing was touched.
      //
      // The model decides this, not a keyword list: an intent that carries a
      // concrete operation is a task whatever its category says, so the typed
      // route always wins over a conversational classification.
      //
      // Two independent signals must agree that there is nothing to do. Naming a
      // typed operation, or naming the capabilities the request needs, both mean
      // the model already decided this is work — and answering work with words
      // is the expensive failure: the task silently never happens and the user
      // is told something reassuring. Classification is nondeterministic enough
      // that the same request has come back CONVERSATION on one call and
      // APPLICATION on the next, so this check is load-bearing, not belt-and-braces.
      const directAnswer = String(session.intent.directAnswer ?? "").trim();
      const namesWork = Boolean(session.intent.operation)
        || (session.intent.requiredCapabilities ?? []).length > 0
        // The classifier said answering needs something read from this machine.
        // That is a task however it labelled itself.
        || session.intent.answerableWithoutInspecting === false;
      if (
        String(session.intent.category ?? "").toUpperCase() === "CONVERSATION" &&
        directAnswer &&
        !namesWork
      ) {
        session.currentState = RuntimeState.COMPLETED;
        session.finalResponse = {
          status: "ANSWERED",
          message: directAnswer,
          rawText,
          conversational: true
        };
        await this.addSessionEvent(session, "CONVERSATIONAL_REPLY", { rawText, source: "INTENT_CLASSIFICATION" });
        session.plan = null;
        await this.persistSession(session);
        return session;
      }

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
      const classificationUnavailable = session.intent.modelDecisionStatus === "UNAVAILABLE";
      if (!namesWork && (!modelHealthyForConversational || classificationUnavailable) && this._looksConversational(rawText)) {
        let conversational = null;
        try {
          const catalog = (this.capabilityRegistry?.getCatalog?.() ?? []).map((c) => c.name);
          const c = await this.reasoningEngine?.converse?.(rawText, {
            capabilities: catalog,
            // Classification already spent its one bounded provider attempt.
            // Do not make a second request to the same failing endpoint merely
            // to phrase an outage fallback.
            modelAllowed: !classificationUnavailable
          });
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

      // 1c. WHICH ROUTE RUNS THIS REQUEST.
      //
      // Decided here, before any context is collected, because the answer
      // changes what is worth collecting.
      //
      // A known typed operation already has a deterministic capability graph
      // that reaches the OS through an internal/API route. That is both the
      // fastest way to do the thing and the most verifiable, so it keeps its
      // fast path — "play X on Spotify" should not be reasoned about step by
      // step when one typed capability does it.
      //
      // EVERYTHING ELSE goes to the model. The one-shot planner composes a
      // whole task graph from a single look at the request, before anything has
      // been observed, and its output was then judged by a coverage check that
      // could only reject it — so the common outcome for an ordinary request
      // was a refusal built on a plan that was never going to run. The
      // controller decides one step at a time from what is actually on screen,
      // which is the only way an OS agent can work, and it has been the
      // FALLBACK from that refusal rather than the route.
      //
      // `preferImmediateInteractive` was the flag meant to do this and no
      // caller has ever set it: the branch below has been unreachable since it
      // was written. The static planner is not removed — it remains the second
      // attempt if the loop does not converge.
      const hasLocalInteractiveStrategy = Boolean(
        buildBrowserCompositionStrategy(rawText) ??
        buildCrossModalTransferStrategy(rawText) ??
        buildInternalToGuiTransferStrategy(rawText) ??
        buildExplicitApplicationLaunchStrategy(rawText)
      );
      const hasDirectOperationPlan = Boolean(
        session.intent.operation && OPERATION_PLANS[session.intent.operation]
      );
      // A message that asks nothing of the computer is not work, and putting it
      // into the loop is the expensive kind of wrong: it spends the whole step
      // budget looking for something to do about "what model are you" and then
      // reports a failure. Same two signals the conversation fast path uses —
      // the classifier naming work, or the message being action-shaped — so the
      // two agree by construction.
      const intentNamedWork = Boolean(session.intent.operation)
        || (session.intent.requiredCapabilities ?? []).length > 0;
      const conversationalShape = !intentNamedWork && this._looksConversational(rawText);
      // The loop needs a model that can actually decide. The deterministic Mock
      // answers every prompt with a canned INTENT fixture, which no interactive
      // decision schema will ever accept — so routing to the loop without a real
      // model spends the entire step budget on repair attempts and arrives
      // nowhere, slowly. Offline, the deterministic planner is not a degraded
      // path, it is the intended one. Same test IntentEngine already applies
      // before it lets a model route an intent at all.
      const modelCanDecide = providerIsRemoteModel(this.reasoningEngine?.modelProvider);
      const modelFirstRoute =
        options.interactive !== false &&
        options.preferImmediateInteractive !== false &&
        !hasDirectOperationPlan &&
        !conversationalShape &&
        modelCanDecide &&
        typeof this.reasoningEngine?.decideInteractiveAction === "function" &&
        (hasLocalInteractiveStrategy || modelHealthyForConversational);

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
        "filesystem.list",
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
      //
      // The model-first route skips it for a different reason: this layer exists
      // to inform a one-shot plan composed before anything is observed, and the
      // controller does not compose one — it perceives the live machine at every
      // step, so paying seconds here buys a snapshot that is stale by the time
      // the first decision is made.
      const skipAdvisoryPlanningState =
        fastReadOnlyOperation || modelFirstRoute || !modelHealthyForConversational;
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

      // The model-first route, decided in 1c above. The controller reasons from
      // live perception, so it runs BEFORE the one-shot planner rather than
      // after it has failed.
      //
      // A loop that does not converge falls THROUGH to the static planner
      // instead of settling here. The two routes fail for different reasons —
      // the loop runs out of steps or observations, the planner runs out of
      // capabilities that cover the goal — so a second attempt down the other
      // one is a genuinely different attempt, not a retry of the same thing.
      // Whatever the loop already did successfully is preserved on the session
      // either way, and _settleIncompleteInteractive still reports it if the
      // planner produces nothing either.
      let modelFirstOutcome = null;
      if (modelFirstRoute) {
        modelFirstOutcome = await this._runInteractiveController(session, rawText, options);
        if (modelFirstOutcome.status === "COMPLETE" || modelFirstOutcome.status === "NEEDS_USER") {
          return session;
        }
        session.currentState = RuntimeState.GENERATE_PLAN;
        session.finalResponse = null;
        await this.addSessionEvent(session, "MODEL_FIRST_ROUTE_FELL_BACK", {
          reason: modelFirstOutcome.reason ?? "interactive-controller-did-not-complete"
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
      this._assertSessionActive(session, options);
      originalPlan = session.plan;

      // Graceful no-plan path (MVP). When neither a model nor the deterministic
      // planner could map the request to any capability, the task graph is empty.
      // Persisting/validating that would throw ("taskGraph.tasks must contain at
      // least one task"), so instead we return a friendly NEEDS_CLARIFICATION
      // response that the UI can show — never a protocol crash on a request the
      // system simply doesn't know how to handle yet.
      const plannedTasks = session.plan?.taskGraph?.tasks ?? [];
      if (session.intent.operationProvenance === "EXPLICIT_CONTEXT") {
        const stateCriterionIds = (session.goalContract?.criteria ?? [])
          .filter((criterion) => criterion.kind === "STATE")
          .map((criterion) => criterion.criterionId);
        for (const task of plannedTasks) {
          task.goalCriterionIds = [...new Set([...(task.goalCriterionIds ?? []), ...stateCriterionIds])];
        }
      }
      if (plannedTasks.length === 0) {
        // Running the loop a second time on the same request, with the same
        // observations, is not a second attempt — it is the same attempt, and
        // it costs the user the whole budget again before failing identically.
        // When the model-first route already ran, report what it managed.
        if (modelFirstOutcome) {
          return this._settleIncompleteInteractive(session, modelFirstOutcome, rawText);
        }
        const canTryInteractive = options.interactive !== false &&
          !this._looksConversational(rawText) &&
          typeof this.reasoningEngine?.decideInteractiveAction === "function" &&
          await this._isModelHealthy();
        if (canTryInteractive) {
          const interactive = await this._runInteractiveController(session, rawText, options);
          if (interactive.status === "COMPLETE" || interactive.status === "NEEDS_USER") {
            return session;
          }
          return this._settleIncompleteInteractive(session, interactive, rawText);
        }
        // The request did not map to any capability. Before giving up, try a
        // pure conversational answer via the model (greetings, "what model are
        // you", capability questions). This performs NO actions and mutates NO
        // state — it only replies with text. If the model is unavailable or
        // declines, fall back to the honest clarification message.
        // Only chat when there was genuinely nothing to do. A request the
        // classifier resolved to real work is a TASK whose planning failed, and
        // answering it conversationally produces the worst possible reply: "I
        // can't check that from this reply, but I'd be happy to — just ask me to
        // scan your Downloads folder", when scanning the Downloads folder is
        // exactly what the user asked for. Saying plainly that it could not be
        // planned is less friendly and far more honest.
        // Category is deliberately NOT part of this test. The deterministic
        // classifier used offline has no CONVERSATION category at all, so
        // judging by category would block a genuine "what model are you" from
        // ever being answered whenever the model is unavailable. Naming an
        // operation or concrete capabilities is the signal that survives both
        // paths, and it is the same one the conversation fast path uses.
        const intentNamedWork = Boolean(session.intent?.operation)
          || (session.intent?.requiredCapabilities ?? []).length > 0;
        let conversational = null;
        if (!intentNamedWork && this._looksConversational(rawText)) {
          try {
            const catalog = (this.capabilityRegistry?.getCatalog?.() ?? []).map((c) => c.name);
            const c = await this.reasoningEngine?.converse?.(rawText, { capabilities: catalog });
            if (c?.ok) conversational = c.text;
          } catch { /* conversational is best-effort; fall through to clarification */ }
        }

        // Answering a question is a real outcome, not a failed automation. Both
        // conversational branches (this one and the offline fast path above)
        // therefore settle identically; a session that produced an answer must
        // never persist as FAILED, which is what previously made the desktop
        // report "This did not work" directly above the answer itself.
        const modelUnavailable = !modelHealthyForConversational;
        const conversationalShape = this._looksConversational(rawText);
        session.currentState = conversational ? RuntimeState.COMPLETED : RuntimeState.FAILED;
        session.finalResponse = conversational
          ? { status: "ANSWERED", message: conversational, rawText, conversational: true }
          : {
              status: modelUnavailable
                ? "RETRYABLE_UNAVAILABLE"
                : (conversationalShape ? "NEEDS_CLARIFICATION" : "FAILED"),
              message: modelUnavailable
                ? "I understood this as a computer task, but every configured model provider is temporarily unavailable and no complete typed fallback covers the whole outcome. Nothing was changed; retrying this turn when the provider recovers is safe."
                : (conversationalShape
                    ? "I could not form a useful conversational reply. Could you rephrase that?"
                    : "I understood the requested outcome, but could not build a capability plan that I could validate and verify. Nothing was changed."),
              rawText,
              reason: modelUnavailable ? "MODEL_PROVIDER_UNAVAILABLE" : "NO_VALIDATED_PLAN"
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
      const lowLevelInteractivePlan = plannedCapabilities.some((name) =>
        /^(?:ui|window|pointer|keyboard)\./.test(name) ||
        /^browser\.(?:click|type|select|find|inspect|scroll|currentState|read|extract)$/.test(name)
      );
      const needsClosedLoopInteraction =
        lowLevelInteractivePlan ||
        // A candidate plan that does not cover the goal is not a plan — it is
        // the planner having failed to find a route, which is exactly the case
        // the adaptive controller exists to serve. Without this, a request whose
        // primitives all exist ("list installed applications", "why is this
        // computer slow") is refused on the strength of a fallback plan that was
        // never going to be run anyway, because its category happened not to be
        // APPLICATION or BROWSER. Coverage is the honest signal here; the
        // category is a proxy that misses every non-GUI goal.
        //
        // This only ever converts a hard refusal into an attempt: if the
        // controller does not complete, the static plan is restored below and
        // the same coverage check still fails closed on it.
        !inferredRouteCoverage.covered;
      if (
        options.interactive !== false &&
        // Same argument as the empty-plan branch above: the loop has already
        // seen this request and these observations. Re-entering it here only
        // spends the budget twice to arrive at the same place.
        !modelFirstOutcome &&
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
          // The loop ran first and did real work; the planner then failed to
          // find a covering route. Reporting a flat FAILED here would discard
          // everything the loop actually accomplished and verified — the false
          // FAILURE this codebase has paid for repeatedly. Settle on the loop's
          // own evidence instead, which reports the verified part and names the
          // part that did not finish.
          if (modelFirstOutcome) {
            session.plan = null;
            return this._settleIncompleteInteractive(session, modelFirstOutcome, rawText);
          }
          session.currentState = RuntimeState.FAILED;
          // Say what actually happened.
          //
          // This message asserted that the language model was unavailable. It is
          // the message a user sees whenever a plan misses goal coverage, and in
          // every live case observed the model was up, had answered, and had
          // classified the request correctly — so the one explanation offered was
          // the one thing that was definitely not true, and it sent debugging
          // (mine included) after the endpoint instead of the routing.
          const attemptedAdaptive = (session.events ?? []).some(
            (event) => event.eventType === "ADAPTIVE_CONTROLLER_STARTED"
          );
          const missing = (coverage.missingCriteria ?? coverage.missingTerms ?? []).slice(0, 3);
          session.finalResponse = {
            status: "FAILED",
            message: !modelHealthyForConversational
              ? "Every configured model provider is temporarily unavailable, and the offline planner could not cover the complete requested outcome. I rejected the partial plan, so nothing was changed."
              : (`I understood the request but could not put together a set of steps I could prove would achieve it` +
                (missing.length ? `, so I stopped rather than guess. Unaddressed: ${missing.join("; ")}.` : `, so I stopped rather than guess.`) +
                (attemptedAdaptive ? " I also tried working it out step by step from what is on screen, and that did not converge either." : "") +
                " Nothing was changed."),
            reason: !modelHealthyForConversational
              ? "MODEL_PROVIDER_UNAVAILABLE"
              : "IRRELEVANT_DETERMINISTIC_FALLBACK",
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

  // Settle a session whose adaptive loop stopped without completing.
  //
  // Every such stop used to become a flat FAILED, which threw away whatever the
  // loop had genuinely accomplished first. Asked to open Notepad and write a C++
  // program, it launched Notepad, waited for the window, focused it and typed the
  // program — then one model call hit the endpoint's timeout, and the user was
  // told the request could not be completed safely, with a Notepad full of the
  // requested code sitting on screen in front of them.
  //
  // That is a false FAILURE. It is the same defect as a false success with the
  // sign flipped: the report does not match what happened. Verified actions are
  // reported as what they are, the part that did not finish is named, and the
  // status stays PARTIALLY_COMPLETED so nothing is overclaimed.
  async _settleIncompleteInteractive(session, interactive, rawText) {
    const successfulActions = (interactive.recentActions ?? []).filter((entry) => entry.succeeded);
    const reason = interactive.reason ?? "INTERACTIVE_REASONING_FAILED";
    // A provider timeout is an interruption, not a verdict on the request. Say
    // so, because "reasoning could not complete the request safely" reads as a
    // refusal and sends the user looking for what they did wrong.
    const interrupted = /provider|aborted|timeout|timed out|unavailable|max-model-calls|max-elapsed-time|max-steps/i.test(String(reason));

    if (successfulActions.length === 0) {
      session.currentState = RuntimeState.FAILED;
      session.finalResponse = {
        status: "FAILED",
        message: interrupted
          ? `I was interrupted before I could do anything for this request (${reason}). Nothing was changed — worth trying again.`
          : `I could not work out a safe way to do this (${reason}). Nothing was changed.`,
        reason,
        interactive: true,
        metrics: interactive.metrics
      };
      await this.addSessionEvent(session, "INTERACTIVE_REASONING_FAILED", { reason, metrics: interactive.metrics });
      session.plan = null;
      await this.persistSession(session);
      return session;
    }

    const readResults = successfulActions
      .map((entry) => ({ capability: entry.action?.capability, executionResult: entry.executionResult }))
      .filter((entry) => entry.capability && entry.executionResult);
    const observedAnswer = await this._composeUserAnswer(
      session,
      readResults,
      summarizeReadOnlyResults(readResults, this.capabilityRegistry)
    );
    const didList = successfulActions
      .map((entry) => entry.action?.subgoal || entry.action?.capability)
      .filter(Boolean)
      .slice(0, 6);

    session.currentState = RuntimeState.FAILED;
    session.finalResponse = {
      status: "PARTIALLY_COMPLETED",
      message: [
        observedAnswer,
        `I got part of the way: ${didList.join("; ")}.`,
        interrupted
          ? `Then I was interrupted (${reason}), so I stopped there rather than guess at the rest. Anything already done is still in place.`
          : `I could not confirm the remaining steps (${reason}), so I stopped there. Anything already done is still in place.`
      ].filter(Boolean).join("\n\n"),
      observedAnswer: observedAnswer ?? null,
      reason,
      interactive: true,
      completedSteps: didList,
      metrics: interactive.metrics
    };
    await this.addSessionEvent(session, "INTERACTIVE_PARTIAL_PROGRESS_PRESERVED", {
      reason,
      verifiedActions: didList,
      metrics: interactive.metrics
    });
    session.plan = null;
    await this.persistSession(session);
    return session;
  }

  /**
   * Keep a whole session working on the SAME window.
   *
   * A model naming its target as `{ application: "Notepad" }` is being perfectly
   * reasonable — that is how a person refers to it. But an application name is
   * not an identifier: with three Notepad windows open, window resolution scores
   * all three equally and breaks the tie on area, so "launch Notepad", "activate
   * Notepad" and "type into Notepad" could each land on a DIFFERENT document.
   * Live, that produced a session that typed into one window and then read back
   * another one's contents, and correctly reported the correct typing action as
   * having failed.
   *
   * The window the loop has already grounded is the answer to which one is
   * meant. So when an action names an application and not a window, and the
   * grounded window belongs to that application, pin the action to its handle.
   * A model that names an explicit windowId keeps it; nothing is overridden.
   */
  _pinActionToGroundedWindow(action, controllerContext = {}) {
    const inputs = action?.inputs;
    if (!inputs || typeof inputs !== "object") return action;
    if (inputs.windowId) return action;
    const application = inputs.application;
    if (!application) return action;

    // An explicitly pinned session window is more authoritative than the most
    // recent ambient perception. A background/foreground transition can make a
    // different document from the same application look current between steps.
    const grounded = controllerContext.groundedWindow
      ?? controllerContext.currentPerception?.groundedWindow
      ?? null;
    const windowId = grounded ? String(grounded.WindowHandle ?? grounded.windowId ?? "") : "";
    if (!windowId) return action;

    const identity = `${grounded.ProcessName ?? grounded.processName ?? ""} ${grounded.MainWindowTitle ?? grounded.title ?? ""}`.toLowerCase();
    const needle = String(application).toLowerCase().replace(/\.exe$/, "");
    if (!needle || !identity.includes(needle)) return action;
    return { ...action, inputs: { ...inputs, windowId } };
  }

  /**
   * Look at a window: capture it, OCR it, inspect it, and return one fused
   * screen snapshot with absolute screen coordinates for everything on it.
   *
   * This is the runtime's single visual-perception entry point. It prefers the
   * PerceptionEngine's VisionProvider so the snapshot and its elements are
   * durably written to SemanticState (queryable later, visible to audit and
   * rollback like any other observation). If the world model is unavailable it
   * falls back to the adapter directly, because being unable to PERSIST what
   * was seen is not a reason to stop seeing.
   *
   * Returns { available, snapshot, summary, targets }. `snapshot` is the full
   * ScreenSnapshot the controller diffs across an action; `summary` and
   * `targets` are the bounded projection handed to the model.
   */
  async _captureScreenEvidence(request = {}) {
    // The controller asks for a snapshot around its own action and supplies the
    // perception it already has. Reuse the window it grounded rather than
    // re-enumerating every top-level window (a measured 2.3s) twice per action.
    const grounded = request.groundedWindow
      ?? request.currentPerception?.groundedWindow
      ?? request.currentPerception?.foregroundWindow
      ?? null;
    const resolved = {
      ...request,
      includeVision: true,
      windowId: request.windowId
        ?? (grounded ? String(grounded.WindowHandle ?? grounded.windowId) : undefined),
      application: request.application
        ?? grounded?.ProcessName ?? grounded?.processName ?? undefined,
      groundedWindow: grounded ?? undefined
    };

    // Looking at a window costs about 7 seconds (capture, OCR, then the UIA
    // tree). The loop takes a reading at the top of every step and then the
    // controller immediately takes a "before" reading for the same window
    // before acting — the same picture, twice, for fourteen seconds a step.
    //
    // A reading taken moments ago IS the before-state, so serve it from the
    // memo. The "after" reading is never served this way: seeing what actually
    // changed is the entire reason it is taken, and a cached answer there would
    // be worse than none.
    const memoKey = resolved.windowId ?? "foreground";
    const reusable = resolved.phase !== "after"
      && this._screenMemo?.key === memoKey
      && Date.now() - this._screenMemo.at <= SCREEN_MEMO_TTL_MS;
    if (reusable) return this._screenMemo.evidence;

    let snapshot = null;
    try {
      const captured = await this.perception?.captureVisionSnapshot?.(
        resolved,
        { force: resolved.force === true }
      );
      if (captured?.available) snapshot = captured.snapshot;
    } catch { /* fall through to the direct adapter path below */ }

    if (!snapshot) {
      try {
        snapshot = await captureScreenSnapshotViaAdapter(this.adapter, resolved);
      } catch { /* a window that cannot be captured is observed as unavailable */ }
    }
    if (!snapshot) {
      this._screenMemo = null;
      return { available: false, snapshot: null, summary: null, targets: [] };
    }

    const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
    // Every visible element the agent could point at, with the coordinates it
    // would point at. OCR lines are included deliberately: they are the only
    // evidence for anything UI Automation does not expose.
    const targets = elements
      .filter((element) => element.bbox ?? element.boundingRect)
      .slice(0, 120)
      .map((element) => {
        const bbox = element.bbox ?? element.boundingRect;
        return {
          targetId: element.targetId ?? element.id,
          source: element.source,
          role: element.role,
          text: String(element.text ?? element.name ?? "").slice(0, 120),
          bounds: bbox,
          center: { x: Math.round(bbox.x + bbox.width / 2), y: Math.round(bbox.y + bbox.height / 2) },
          clickable: element.clickable === true,
          enabled: element.enabled !== false,
          value: element.value ?? null
        };
      });
    const evidence = {
      available: true,
      snapshot,
      summary: {
        snapshotId: snapshot.snapshotId,
        windowId: snapshot.windowId,
        application: snapshot.application,
        title: snapshot.title,
        capturedAt: snapshot.capturedAt,
        // The screen as readable text. This is what lets the loop answer
        // "what does it say now?" — the question a blind agent cannot ask.
        visibleText: String(snapshot.ocrText ?? "").slice(0, 4000),
        elementCount: elements.length
      },
      targets
    };
    this._screenMemo = { key: memoKey, at: Date.now(), evidence };
    return evidence;
  }

  async _runInteractiveController(session, rawText, options = {}) {
    // The controller supersedes any static plan: it decides each step from live
    // observation and builds its own per-step graphs. An empty plan left behind
    // by a planner that found no route is therefore stale, and carrying it into
    // the controller's own persistence used to abort the run before it started.
    if ((session.plan?.taskGraph?.tasks?.length ?? 0) === 0) session.plan = null;
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
        // Window enumeration is an optional perception source, like the UIA and
        // browser probes below. `.catch()` covers a rejected probe but not an
        // adapter that does not implement one at all — which threw a TypeError
        // out of perception and killed the whole session. Observing nothing is a
        // valid observation; being unable to observe is not a failure of the task.
        const windows = typeof this.adapter?.listWindows === "function"
          ? await this.adapter.listWindows().catch(() => [])
          : [];
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
        // WHAT THE AGENT IS ALLOWED TO SEE.
        //
        // This used to be `visibleWindows.filter(matchesGoal)`, and the
        // foreground window was discarded unless its title shared a word with
        // the request. That is a blindfold: asked "what's on my screen" or "close
        // whatever is covering my editor", the agent enumerated windows, matched
        // none of them, grounded nothing, and never called UIA at all — so it
        // reasoned about an empty desktop while three applications were open in
        // front of it. A person does not stop seeing a window because its title
        // does not quote the sentence they just spoke.
        //
        // Goal matching is retained, demoted to what it should always have been:
        // a RANKING signal for which window to ground first, never a filter on
        // what exists. The foreground window is always grounded when nothing
        // matches, because that is what the user is looking at.
        const rankedWindows = [...visibleWindows]
          .map((window, index) => {
            const bounds = window.Bounds ?? window.bounds ?? {};
            const area = Number(bounds.width ?? 0) * Number(bounds.height ?? 0);
            let score = 0;
            if (matchesGoal(window)) score += 100;
            if (window === rawForeground) score += 50;
            score += Math.min(20, area / 100000);
            return { window, score, index };
          })
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .map((entry) => entry.window);
        const relevantWindows = rankedWindows.slice(0, 12);
        const foreground = rawForeground;
        const groundedWindow = rankedWindows.find(matchesGoal) ?? rawForeground ?? rankedWindows[0] ?? null;
        const inspectGroundedUi = async () => {
          if (!groundedWindow) return null;
          try {
            return await this.adapter.inspectUi({
              application: groundedWindow.ProcessName ?? groundedWindow.processName,
              windowId: String(groundedWindow.WindowHandle ?? groundedWindow.windowId),
              maxElements: 100
            });
          } catch {
            // UIA is an optional perception source.
            return null;
          }
        };
        // VISUAL PERCEPTION.
        //
        // Capture + OCR were implemented, working (measured: 0.6s to capture a
        // window, 0.6s to OCR it, returning per-line text with absolute screen
        // coordinates) and reachable as capabilities — and the loop never once
        // used them to look at the result of its own actions. Live, that produced
        // the signature failure of a blind agent: told to type "Ultron online"
        // into Notepad it typed "Ultron online into it", reported the keystroke
        // as VERIFIED because the keystroke was delivered, and then could not say
        // what was on the screen. UI Automation alone was never going to catch
        // that; reading the window back is.
        //
        // Cost is why this is conditional rather than unconditional: it is ~1.2s
        // per step and buys nothing on a step that runs a shell command. It runs
        // whenever the work is actually happening on screen.
        const uiFacingSession = /\b(open|launch|click|type|press|select|choose|scroll|drag|window|screen|see|look|read|show|display|button|menu|tab|dialog|app|application)\b/i
          .test(String(controllerState.goal ?? rawText)) ||
          (controllerState.recentActions ?? []).some((entry) => isUiFacingAction(entry?.action));
        const captureGroundedScreen = async () => {
          if (!groundedWindow || !uiFacingSession) return null;
          return this._captureScreenEvidence({
            windowId: String(groundedWindow.WindowHandle ?? groundedWindow.windowId),
            application: groundedWindow.ProcessName ?? groundedWindow.processName
          });
        };
        const readBrowserState = async () => {
          try {
            if (this.adapter.browserAutomation?.connection) {
              return await this.adapter.browserDomAction("currentState", {});
            }
          } catch { /* browser may not be active */ }
          return null;
        };
        // Three independent looks at the same already-resolved window: the
        // accessibility tree, the pixels, and the page. They were awaited one
        // after another, so every step paid their sum — roughly 0.5s + 1.2s +
        // the browser probe — when the wall-clock cost is the slowest of them.
        // Perception runs before EVERY action, so this is per-step, not per-run.
        const [ui, screen, browser] = await Promise.all([
          inspectGroundedUi(),
          captureGroundedScreen(),
          readBrowserState()
        ]);
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
        // Rank what the agent is shown by whether it can be USED, then by
        // relevance — not the other way round.
        //
        // Scoring purely on goal-word overlap ranked window chrome to the top and
        // cut the functional controls entirely. For "open calculator and work out
        // 47 times 89" the three highest-scoring controls were "Minimize
        // Calculator", "Maximize Calculator" and "Close Calculator", plus the
        // "Calculator" header — every one of them containing the goal word — while
        // "Multiply by", "Seven" and "Equals" scored zero and fell outside the
        // 24-item cut. The loop then clicked the header repeatedly, because the
        // buttons it needed were never in its field of view.
        //
        // The controls that matter are named in the APP's vocabulary ("Seven",
        // "Multiply by"), which almost never overlaps the user's ("47 times 89").
        // Lexical relevance is a tiebreak; being an enabled, actionable control is
        // the signal.
        // Things you can ACT on outrank things you can only read. Both are
        // shown — the calculator's display is how the answer is read back — but
        // ranking "Standard Calculator mode" and the window title above thirty
        // buttons is what had the loop clicking headers.
        const ACTIONABLE = /(Button|MenuItem|ListItem|Edit|ComboBox|CheckBox|RadioButton|TabItem|Hyperlink|Slider|Spinner|TreeItem)$/;
        const READABLE = /(Text|Document|StatusBar)$/;
        const CHROME = /^(minimize|maximize|restore|close|open navigation|system menu)\b/i;
        const scoredControls = compactControls
          .map((control, index) => {
            const name = String(control.name ?? "");
            const type = String(control.controlType ?? "");
            const semantics = `${name} ${control.automationId ?? ""} ${type}`.toLowerCase();
            let score = 0;
            if (ACTIONABLE.test(type)) score += 10;
            else if (READABLE.test(type)) score += 5;
            if (control.supportedPatterns?.length) score += 4;
            if (control.enabled !== false) score += 2;
            if (control.focused) score += 2;
            if (name.trim()) score += 1;
            // Title-bar controls are reachable when genuinely wanted, but they
            // must never outrank the app's own controls.
            if (CHROME.test(name)) score -= 12;
            score += [...goalTokens].reduce((total, token) => total + (semantics.includes(token) ? 2 : 0), 0);
            return { control, score, index };
          })
          .sort((left, right) => right.score - left.score || left.index - right.index)
          // Calculator alone exposes 34 buttons; a 24-item window could not hold
          // one simple app's controls, let alone a real one.
          .slice(0, 60)
          .map(({ control }) => control);
        return {
          foregroundWindow: foreground,
          groundedWindow,
          windows: relevantWindows,
          relevantControls: scoredControls,
          // What the window actually LOOKS like: the OCR transcript of the
          // grounded window plus any text-only regions UI Automation cannot
          // see (custom-drawn canvases, web views, games, remote sessions).
          // Present only when a visual capture was taken this step.
          screen: screen?.available ? screen.summary : null,
          screenTargets: screen?.available ? screen.targets : [],
          browser
        };
      },
      captureScreenSnapshot: async (request = {}) => {
        this._assertSessionActive(session, { deadlineAt: Date.parse(session.deadlineAt) });
        const evidence = await this._captureScreenEvidence(request);
        return evidence?.available ? evidence.snapshot : null;
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
      session.evidenceLedger = result.evidenceLedger ?? createEvidenceLedger();
      const successfulActions = (result.recentActions ?? []).filter((entry) => entry.succeeded);
      const constraintAssessment = assessGoalContractEvidence(session.goalContract, {
        taskGraph: { tasks: successfulActions.map((entry) => entry.action) },
        taskResults: successfulActions.map((entry) => ({
          capability: entry.action?.capability,
          executionResult: entry.executionResult
        })),
        verifications: successfulActions.map((entry) => entry.verification).filter(Boolean),
        observations: result.recentObservations ?? [],
        approvalGranted: session.events.some((event) =>
          event.eventType === "APPROVAL_EVALUATED" && event.details?.approved === true)
      }, this.capabilityRegistry);
      for (const criterion of session.goalContract?.criteria ?? []) {
        if (!["PROHIBITION", "CONSTRAINT"].includes(criterion.kind)) continue;
        const assessment = constraintAssessment.criteria.find((item) => item.criterionId === criterion.criterionId);
        if (!assessment?.satisfied) continue;
        appendEvidence(session.evidenceLedger, {
          criterionIds: [criterion.criterionId],
          capability: "runtime.constraint.audit",
          observation: { actions: successfulActions.map((entry) => entry.action?.capability) },
          verification: { status: "VERIFIED", message: assessment.evidence, confidence: 1 },
          source: "RUNTIME_AUDIT",
          confidence: 1,
          verificationMethod: "NEGATIVE_CONSTRAINT_AUDIT",
          identity: {},
          independentFromActionResult: true
        });
      }
      const evidenceCoverage = evaluateEvidenceLedger(session.goalContract, session.evidenceLedger, result.bindings ?? {});
      if (!evidenceCoverage.satisfied) {
        session.currentState = RuntimeState.FAILED;
        // Partial verification is a reason to QUALIFY an answer, not to withhold
        // one. This branch used to replace whatever was found with a bare
        // criteria count, so a session that read the Windows version or counted
        // the files correctly told the user only that "independent evidence
        // satisfies 0/2 goal criteria" — the measurement discarded, and nothing
        // actionable in its place.
        //
        // Lead with what was actually observed, then say plainly what could not
        // be confirmed. The status stays PARTIALLY_COMPLETED / INCONCLUSIVE, so
        // nothing is overclaimed; only the wording the user reads changes.
        const partialReads = (result.recentActions ?? [])
          .filter((entry) => entry.succeeded)
          .map((entry) => ({
            capability: entry.action?.capability,
            executionResult: entry.executionResult
          }))
          .filter((entry) => entry.capability && entry.executionResult);
        const partialAnswer = await this._composeUserAnswer(
          session,
          partialReads,
          summarizeReadOnlyResults(partialReads, this.capabilityRegistry)
        );
        const unverified = `Not independently confirmed: ${
          (evidenceCoverage.unsatisfiedCriteria ?? []).join("; ") || "some of the requested outcome"
        }.`;
        session.finalResponse = {
          status: evidenceCoverage.satisfiedCount > 0 ? "PARTIALLY_COMPLETED" : "INCONCLUSIVE",
          message: partialAnswer
            ? `${partialAnswer}\n\n${unverified}`
            : `Interactive actions finished, but independent evidence satisfies only ${evidenceCoverage.satisfiedCount}/${evidenceCoverage.totalCriteria} goal criteria.`,
          observedAnswer: partialAnswer ?? null,
          interactive: true,
          evidenceCoverage,
          evidenceLedger: session.evidenceLedger
        };
        await this.addSessionEvent(session, "INTERACTIVE_GOAL_EVIDENCE_INCOMPLETE", evidenceCoverage);
        await this.persistSession(session);
        return result;
      }
      // A verified read is useful only when its observed VALUE reaches the user.
      // The static task-graph path already does this in _finalizeSession; the
      // adaptive controller sets its own response and so never did, which meant
      // a session could inspect the machine, get the right answer, and reply
      // "All original goal criteria were satisfied by locally verified
      // evidence." — true, and completely useless. Asked which process used the
      // most memory, it never said the name.
      //
      // Read the value back out of the actions the controller actually ran, in
      // the same shape and through the same summariser the static path uses, so
      // both routes answer a question the same way.
      const readResults = successfulActions
        .map((entry) => ({
          capability: entry.action?.capability,
          executionResult: entry.executionResult
        }))
        .filter((entry) => entry.capability && entry.executionResult);
      const observedAnswer = await this._composeUserAnswer(
        session,
        readResults,
        summarizeReadOnlyResults(readResults, this.capabilityRegistry)
      );
      const controllerSummary = typeof result.result === "string"
        ? result.result
        : result.result?.summary;
      session.currentState = RuntimeState.COMPLETED;
      session.finalResponse = {
        status: "COMPLETED",
        // Prefer the observed value; keep the controller's own summary when it
        // said something concrete, and fall back to the generic line only when
        // there is genuinely nothing to report.
        message: observedAnswer
          ?? controllerSummary
          ?? "The requested goal was completed and verified.",
        observedAnswer: observedAnswer ?? null,
        interactive: true,
        result: result.result,
        verification: result.completionVerification,
        evidenceLedger: session.evidenceLedger,
        evidenceCoverage,
        outcome: {
          completed: evidenceCoverage.criteria.map((criterion) => criterion.description),
          notCompleted: [],
          changed: successfulActions.flatMap((entry) => entry.screenDiff?.changes ?? []),
          verified: session.evidenceLedger.entries.map((entry) => ({
            evidenceId: entry.evidenceId,
            source: entry.source,
            method: entry.verificationMethod
          })),
          uncertain: [],
          userActionNeeded: null
        },
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
    action = this._pinActionToGroundedWindow(action, controllerContext);
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

        session.evidenceLedger ??= createEvidenceLedger();
        const criterionIds = verification.status === "VERIFIED"
          ? matchGoalCriteriaForTask(session.goalContract, task, this.capabilityRegistry, executionResult)
          : [];
        const evidenceEntry = appendEvidence(session.evidenceLedger, {
          taskId: task.taskId,
          criterionIds,
          capability: task.capability,
          modality: cap.trustedExecutionModality ?? cap.execution?.preferredModality ?? null,
          observation,
          verification,
          source: observation?.source ?? task.capability,
          confidence: verification?.confidence ?? observation?.confidence ?? 0.8,
          verificationMethod: verification?.method ?? `${task.capability}:verify`,
          identity: evidenceIdentity(task, observation),
          independentFromActionResult: verificationIsIndependent(cap, executionResult, observation, verification),
          provenance: {
            source: observation?.source ?? task.capability,
            observationId: observation?.observationId ?? null
          }
        });
        await this.addSessionEvent(session, "EVIDENCE_RECORDED", {
          evidenceId: evidenceEntry.evidenceId,
          taskId: task.taskId,
          criterionIds,
          independentFromActionResult: evidenceEntry.independentFromActionResult
        });

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

        // "Could not confirm" is not "did not work".
        //
        // This gate was `status !== "VERIFIED"`, which routed an action that
        // PERFORMED but produced no independent evidence straight into
        // diagnosis, replanning and abort. The scheduler already draws the line
        // correctly — it marks these UNCERTAIN, not FAILED — and the interactive
        // loop budgets thirty of them per session, because a UI click with no
        // declared postcondition is the ordinary case, not a fault.
        //
        // Live, that cost a session that had launched Notepad, found the
        // document control and typed into it: the typing returned
        // PARTIALLY_VERIFIED with "no explicit postcondition was supplied", the
        // runtime aborted, and the user was told "Did not work" about work that
        // had in fact been done. The same request succeeded on a rerun purely
        // because the model happened to attach a postcondition that time.
        //
        // Unconfirmed work still cannot CLAIM anything: these verifications are
        // carried into the summary's remaining problems, and the goal contract
        // — which requires evidence per criterion — remains the gate on whether
        // the goal was met. Only a genuine FAILED is handled as a failure.
        const performedButUnconfirmed = ["PARTIALLY_VERIFIED", "UNCERTAIN", "INCONCLUSIVE"]
          .includes(verification.status);
        if (performedButUnconfirmed) {
          await this.addSessionEvent(session, "VERIFICATION_UNCONFIRMED", {
            taskId: task.taskId,
            capability: task.capability,
            status: verification.status,
            message: verification.message
          });
        }
        if (verification.status !== "VERIFIED" && !performedButUnconfirmed) {
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
    const actionish = /\b(inspect|list|check|find|search|install|create|make|open|launch|close|run|read|write|delete|remove|set|add|kill|stop|start|restart|show|play|queue|calculate|compute|type|draft|send|download|upload|move|copy|rename|what'?s using|port|folder|file|path|package|winget|process|service|project|docker|git|node|python|environment|env|calculator|spotify|whatsapp|youtube)\b/;
    if (actionish.test(text)) return false;
    // Greetings / thanks / meta-questions about the assistant itself.
    const greeting = /^(hi|hii+|hey|hello|yo|sup|howdy|greetings|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|nice)\b/;
    const metaQuestion = /\b(what|which) (model|llm|ai) (are|r) (you|u)\b|\bwho are you\b|\byour name\b|\bwhat can you do\b|\bwhat do you do\b|\bhow do you work\b|\bare you (an? )?(ai|bot|model)\b|\bhelp\b/;
    const emotionalCheckIn = /\b(feel(?:ing)?|i(?:'m| am))\b[\s\S]{0,30}\b(low|sad|down|upset|overwhelmed|lonely|anxious)\b/;
    const smallTalk = /\b(joke|chat|talk|fun fact|how are you|how'?s it going|story|riddle)\b/;
    if (greeting.test(text) || metaQuestion.test(text) || emotionalCheckIn.test(text) || smallTalk.test(text)) return true;
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
  // Turn a diagnosed missing prerequisite into an actionable, identity-bound
  // installation proposal. Returns null whenever the failure is anything other
  // than a genuinely absent application, so a grounding miss never becomes an
  // install prompt.
  async _proposePrerequisite(session, task, diagnosis) {
    if (diagnosis?.category !== "MISSING_PREREQUISITE") return null;
    if (!this.adapter || typeof this.adapter.resolveApplicationTarget !== "function") return null;
    const application = task?.inputs?.application ?? session?.intent?.entities?.application;
    if (typeof application !== "string" || !application.trim()) return null;
    try {
      const resolver = new PrerequisiteResolver({
        environmentModel: new EnvironmentModel({ adapter: this.adapter }),
        adapter: this.adapter
      });
      return await resolver.ensureApplicationAvailable(application, { originalTask: task });
    } catch {
      // A prerequisite lookup is an enhancement to the failure message; it must
      // never replace one failure with another.
      return null;
    }
  }

  // set the session's final response. Shared by submitIntent and
  // continueApprovedSession so both end identically.
  async _finalizeSession(session) {
    session.evidenceLedger ??= createEvidenceLedger();
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
    // Negative and behavioral constraints are verified from the complete
    // execution audit, not from an action's own return value. Record one
    // independent audit entry for each satisfied constraint before applying the
    // authoritative ledger gate.
    const constraintAssessment = session.goalContract?.enforceable
      ? assessGoalContractEvidence(session.goalContract, {
          taskGraph: session.plan?.taskGraph,
          taskResults: session.taskResults,
          verifications: reconciledVerifications,
          observations: session.observations,
          approvalGranted: session.events.some((event) =>
            event.eventType === "APPROVAL_EVALUATED" && event.details?.approved === true)
        }, this.capabilityRegistry)
      : null;
    for (const criterion of session.goalContract?.criteria ?? []) {
      if (!["PROHIBITION", "CONSTRAINT"].includes(criterion.kind)) continue;
      const assessment = constraintAssessment?.criteria?.find((item) => item.criterionId === criterion.criterionId);
      if (!assessment?.satisfied) continue;
      if (session.evidenceLedger.entries.some((entry) => entry.criterionIds.includes(criterion.criterionId))) continue;
      appendEvidence(session.evidenceLedger, {
        criterionIds: [criterion.criterionId],
        capability: "runtime.constraint.audit",
        observation: {
          plannedCapabilities: (session.plan?.taskGraph?.tasks ?? []).map((task) => task.capability),
          detectedChanges: session.observations.flatMap((observation) => observation?.detectedChanges ?? [])
        },
        verification: { status: "VERIFIED", message: assessment.evidence, confidence: 1 },
        source: "RUNTIME_AUDIT",
        confidence: 1,
        verificationMethod: "NEGATIVE_CONSTRAINT_AUDIT",
        identity: {},
        independentFromActionResult: true
      });
    }
    const finalVerification = this.goalVerifier.verify({
      intent: session.intent,
      goalContract: session.goalContract,
      taskGraph: session.plan?.taskGraph,
      schedulerStatus: finalStatus,
      verifications: reconciledVerifications,
      observations: session.observations,
      taskResults: session.taskResults,
      semanticState: semanticSnapshot,
      evidenceLedger: session.evidenceLedger,
      bindings: session.bindings ?? {}
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
    const deterministicReadSummary = summarizeReadOnlyResults(session.taskResults, this.capabilityRegistry);
    let executionSummary = null;
    let executionSummaryPromise = null;
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
      // Phrasing the run summary and grounding the direct user answer are
      // independent presentation calls. Start them concurrently; running them
      // serially doubled the post-action wait for every successful task.
      if (!deterministicReadSummary && session.taskResults.length !== 1) {
        executionSummaryPromise = this.reasoningEngine.summarizeExecution(facts).catch(() => null);
      }
    } catch {
      executionSummaryPromise = null;
    }

    // A verified read is useful only when its observed value reaches the user.
    // This also covers aggregate reads (for example a system snapshot made of
    // several independent tasks), without exposing raw command output.
    const directAnswer = await this._composeUserAnswer(
      session,
      session.taskResults,
      deterministicReadSummary
    ) ?? (session.taskResults.length === 1 ? session.verifications.at(-1)?.message : null);
    const summaryResult = executionSummaryPromise ? await executionSummaryPromise : null;
    if (summaryResult?.ok) {
      executionSummary = { ...summaryResult.data, source: summaryResult.source };
    }
    if (directAnswer) {
      executionSummary = { ...(executionSummary ?? {}), summary: directAnswer };
    }

    const evidenceCoverage = session.goalContract?.enforceable
      ? evaluateEvidenceLedger(session.goalContract, session.evidenceLedger, session.bindings ?? {})
      : null;
    const detectedChanges = [...new Set(session.observations.flatMap((observation) => observation?.detectedChanges ?? []))];
    const userActionNeeded = ["INCONCLUSIVE", "PARTIALLY_COMPLETED"].includes(finalVerification.status)
      ? "Review the unverified criteria or provide the requested prerequisite/input before resuming."
      : null;

    session.finalResponse = {
      status: finalVerification.status,
      // When the request was a question, the ANSWER leads. The verification
      // verdict — "All success criteria satisfied: scheduler reports every task
      // verified" — is a statement about the runtime, not a reply to the user,
      // and filing the answer under `summary` while showing that verdict as the
      // message is why a session could measure the right thing and still tell
      // the user nothing.
      //
      // But the answer must never REPLACE a caveat. When the outcome is not a
      // clean completion, the verdict is the honest part — "exit code zero
      // without an independent running-state postcondition is not completion" —
      // so it stays, after the answer. Leading with the answer and following
      // with what could not be confirmed is both useful and truthful; dropping
      // either half is not.
      message: directAnswer
        ? (finalVerification.status === "COMPLETED"
            ? directAnswer
            : `${directAnswer}\n\n${finalVerification.message}`)
        : finalVerification.message,
      taskResults: session.taskResults,
      verifications: session.verifications,
      finalStatus,
      finalVerification,
      evidenceLedger: session.evidenceLedger,
      evidenceCoverage,
      outcome: {
        completed: evidenceCoverage?.criteria.filter((criterion) => criterion.satisfied).map((criterion) => criterion.description) ?? [],
        notCompleted: evidenceCoverage?.unsatisfiedCriteria ?? [],
        changed: detectedChanges,
        verified: (session.evidenceLedger?.entries ?? [])
          .filter((entry) => entry.verification?.status === "VERIFIED" && entry.independentFromActionResult)
          .map((entry) => ({ evidenceId: entry.evidenceId, source: entry.source, method: entry.verificationMethod })),
        uncertain: evidenceCoverage?.criteria.filter((criterion) => !criterion.satisfied).map((criterion) => criterion.description) ?? [],
        userActionNeeded
      },
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
      // A missing application is answerable: name the exact package, publisher
      // and source, and keep the original task so the goal resumes once the
      // prerequisite is satisfied. Without this the user is only told that
      // something is absent, with no way to act on it.
      const prerequisite = await this._proposePrerequisite(session, task, diagnosis);
      if (prerequisite) {
        session.finalResponse = { ...session.finalResponse, status: "AWAITING_APPROVAL", prerequisite };
        await this.addSessionEvent(session, "PREREQUISITE_APPROVAL_REQUESTED", {
          application: prerequisite.application,
          state: prerequisite.state,
          proposal: prerequisite.proposal ?? null
        });
      }
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

  // Turn verified read results into an answer to the question the user actually
  // asked. `summarizeReadOnlyResults` gets the facts out of the capability
  // results but phrases them as capability output ("processes.list: 25 items
  // (first: Memory Compression, ...)"); this is the step that makes them read
  // like an answer. Falls back to the deterministic summary whenever the model
  // is unavailable, declines, or reports it could not answer from the data —
  // a worse-phrased true answer always beats a well-phrased invented one.
  async _composeUserAnswer(session, readResults, deterministicSummary) {
    // Deliberately NOT gated on the deterministic summary existing. That
    // summariser only speaks for capabilities whose permission model is READ,
    // so a question answered by running a command — `command.run` is WRITE,
    // because the runtime cannot know a given command only reads — produced
    // nothing at all, and the user was told the request was inconclusive while
    // the correct count sat in the command's output.
    //
    // Answering is safe here regardless of permission model: the model is given
    // only observed data and must report when that data does not contain the
    // answer. Permission classification governs what may RUN, not what may be
    // reported once it has run.
    if (!deterministicSummary && (readResults ?? []).length === 0) return null;
    const fullyFormatted = new Set([
      "calculator.evaluate", "browser.research", "filesystem.list", "system.inspect"
    ]);
    if (deterministicSummary && (readResults ?? []).length > 0 &&
        readResults.every((entry) => fullyFormatted.has(entry.capability))) {
      return deterministicSummary;
    }
    const question = session.intent?.rawText ?? session.intent?.normalizedGoal ?? "";
    if (!question || typeof this.reasoningEngine?.answerFromObservations !== "function") {
      return deterministicSummary;
    }
    try {
      const answered = await this.reasoningEngine.answerFromObservations(
        question,
        readResults.map((entry) => ({ capability: entry.capability, result: entry.executionResult }))
      );
      // `grounded: false` is the model telling us the data did not contain the
      // answer. Honour that rather than printing a confident non-answer.
      if (answered?.ok && answered.grounded && answered.text) {
        await this.addSessionEvent(session, "ANSWER_COMPOSED_FROM_OBSERVATIONS", {
          question,
          capabilities: readResults.map((entry) => entry.capability)
        });
        return answered.text;
      }
    } catch { /* answering is a presentation step; never fail the session for it */ }
    return deterministicSummary;
  }

  async persistSession(session) {
    // A plan whose task graph is empty is not executable, and it is the only
    // part of a session that can fail validation while the rest of the session
    // is perfectly sound. Persisting is how a session survives; it must never
    // be the thing that destroys one. Dropping the empty plan loses nothing
    // (there were no tasks) and keeps a real record of what happened, instead
    // of throwing out of whatever code path happened to be saving — including
    // the error handler, where the throw escaped submitIntent entirely and the
    // caller got a raw ValidationError instead of a session.
    //
    // Deliberately narrow: any other invalid session still throws, because
    // those indicate a genuine bug that should not be quietly persisted.
    if (session?.plan && (session.plan.taskGraph?.tasks?.length ?? 0) === 0) {
      session.plan = null;
    }
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
