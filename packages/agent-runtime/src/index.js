import path from "node:path";
import {
  PolicyEffect,
  RuntimeState,
  createId,
  validateExecutionSession,
  validateIntent
} from "../../shared-types/src/domain.js";
import { MockModelProvider } from "../../model-providers/src/index.js";
import { ReasoningEngine } from "../../reasoning-engine/src/index.js";
import { RollbackManager } from "./rollback-manager.js";
import { createRecoveryBudget } from "../../recovery-engine/src/index.js";
import { createEvidenceLedger } from "../../shared-types/src/evidence-ledger.js";
// `FailureReason` went with the offline fallback: nothing in this file branches
// on why the loop stopped any more, because every reason now keeps the loop's
// own sentence. The loop still records it, and the session still carries it.
import { FastAgent, buildToolset } from "../../fast-agent/src/index.js";
// Replaying a saved route with nobody watching — see `runSkillUnattended`.
import { replaySkill } from "../../fast-agent/src/skill-replay.js";
import { verifyReplayStep } from "../../fast-agent/src/skill-verify.js";
import { deleteSkill, readSkills, recordSkillRun, writeSkill } from "../../fast-agent/src/skills.js";
import {
  canAutoApprove,
  normalizeAccessPolicy
} from "../../shared-types/src/access-policy.js";

// How long the agent waits for an answer before treating silence as "no". Long
// enough that the user can read the command and think about it; short enough
// that a question asked while nobody is watching does not hold a run open until
// its own six-minute budget runs out.
const APPROVAL_TIMEOUT_MS = 120000;

export class AgentRuntime {
  // HOW OFTEN THE OFFLINE PIPELINE IS REACHED. IT IS NOW ZERO BY CONSTRUCTION.
  //
  // This counter was added expressly so the deletion decision could be made on a
  // number rather than an argument, and it answered: 0 of 60 runs on 19 Aug, 0 of
  // 63 on 21 Aug, 0 of 69 on 22 Aug, and 0 of 143 real sessions between 28 Aug
  // and 1 Sep. The pipeline it counted is gone.
  //
  // The field stays because the eval reports it and the scoreboard prints it, and
  // a row that silently stops being measured is worse than one that reads zero.
  // It can no longer be incremented by anything.
  static stagedPipelineReaches = 0;

  constructor({
    sessionStore,
    auditRepository,
    capabilityRegistry,
    policyEngine,
    permissionBroker,
    adapter,
    modelProvider,
    reasoningEngine,
    secretBroker,
    memory,
    // GONE WITH THE STAGED PIPELINE: `riskEngine`, `troubleshootingEngine`,
    // `recoveryEngine`, `intentEngine`, `contextEngine`, `semanticState`. A
    // caller that still passes them is harmless — destructuring ignores what it
    // does not name — so no existing construction site breaks on this.
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
    this.policyEngine = policyEngine;
    this.permissionBroker = permissionBroker;
    this.adapter = adapter;
    this.developerIntelligence = null;
    const provider = modelProvider || new MockModelProvider();
    // THE REASONING ENGINE IS NOW ONLY A PROVIDER HOLDER, AND IT IS LOAD-BEARING.
    //
    // It used to be the single boundary to any language model for the whole
    // staged pipeline. That pipeline is gone, and what is left is the one thing
    // everything still depends on: `_canRunFastAgent` reads
    // `reasoningEngine.modelProvider` to decide whether the agent loop can run at
    // all, `_submitFastIntent` hands that same provider to the loop, and the
    // daemon's health check calls `.health()` on it. Deleting this class would
    // silently turn the agent off — which is exactly how pointing this product at
    // Claude turned it off once already.
    this.reasoningEngine = reasoningEngine || new ReasoningEngine({
      modelProvider: provider,
      capabilityRegistry: this.capabilityRegistry
    });
    // The secret broker (DPAPI) supplies secrets to capability execution only.
    // It is NEVER passed to the reasoning engine or included in prompts/audit.
    this.secretBroker = secretBroker || null;
    this.memory = memory;
    // THE ROLLBACK MANAGER STAYS, BECAUSE A LIVE CAPABILITY HOLDS A REFERENCE.
    //
    // Everything else the staged pipeline constructed here has gone with it. This
    // one has not: the registry's `session.rollback` capability performs its
    // restore through this exact instance, and it checks for it
    // (`if (!registry.rollbackManager)`). A late DI setter breaks the cycle —
    // the manager needs the registry, the capability needs the manager.
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

  // It used to also rebuild the context providers and the perception engine so
  // both carried the developer engine. Neither exists any more — those were the
  // staged pipeline's own world model, and the agent loop reads the machine
  // directly through its tools instead. What is left is the field itself, which
  // `runProjectWorkflow` still reads.
  setDeveloperIntelligence(engine) {
    this.developerIntelligence = engine;
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
  resolveApproval(approvalId, approved, remember = false) {
    const settle = this._approvals?.get(String(approvalId));
    if (!settle) return false;
    // `remember` is the user having also pressed "and don't ask again" on the
    // card. It travels BESIDE the yes rather than as a second request, so the
    // two can never disagree: there is no state in which the command ran and the
    // consent to stop asking was lost, or in which the consent was recorded for
    // something that never ran.
    settle(approved === true, false, remember === true);
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
  /**
   * Replay a saved route with nobody watching.
   *
   * THE ONLY CALLER IS THE TRIGGER RUNNER, and everything unusual about this
   * method follows from that: there is no user, so nothing may wait for one.
   *
   * IT IS SAFE BY CONSTRUCTION RATHER THAN BY CARE. The shared toolset is built
   * with no `confirm`, and `askPermission` in tools.js returns
   * `{approved: false, asked: false}` when there is no confirmer — so a gated
   * step is REFUSED rather than approved, and refused immediately rather than
   * after a two-minute timeout that nobody is there to beat. That behaviour
   * predates triggers and is what makes this method a small one.
   *
   * The refusal is then read back off the tool's OWN typed receipt
   * (`refusedByUser`), never by matching English in a message — the same rule
   * the loop follows when it settles DECLINED. `needsApproval` is what the
   * runner turns into "Stopped part-way: it reached a step that needed your
   * approval", which is the sentence the user reads in the morning.
   *
   * @returns {Promise<{ok: boolean, detail: string, needsApproval?: boolean}>}
   */
  async runSkillUnattended(skill, parameters = {}) {
    const toolset = this._ensureToolset();
    let refused = null;
    const outcome = await replaySkill({
      skill,
      parameters,
      execute: async (tool, args) => {
        const result = await toolset.execute(tool, args);
        // Captured on the way past: `replaySkill` reports a failed step as a
        // handover with the step's text, and "the user said no" has to be told
        // apart from "the button was not there" — they need different sentences
        // and only one of them is worth retrying tomorrow.
        if (result?.raw?.refusedByUser === true && !refused) {
          refused = `${tool}${args?.text ? ` "${args.text}"` : ""}`;
        }
        return result;
      },
      verifyStep: (check, context) => verifyReplayStep(check, {
        execute: (tool, args) => toolset.execute(tool, args),
        focusedValue: toolset.focusedValue ? () => toolset.focusedValue() : null,
        lastResult: context?.result
      })
    });
    if (refused) {
      return { ok: false, needsApproval: true, detail: refused };
    }
    if (outcome.replayed) {
      return { ok: true, detail: `${outcome.steps} step(s) in ${(outcome.elapsedMs / 1000).toFixed(1)}s, no model calls` };
    }
    // `handover` carries the context; `handover.failure` is what went wrong. A
    // first version read the outer object and reported every failure as
    // "stopped at step ?: it could not be verified" — which is the shape of an
    // error message that has lost its error, and it hid a real defect for a
    // whole run of the end-to-end proof.
    const failure = outcome.handover?.failure ?? {};
    return {
      ok: false,
      detail: `stopped at step ${failure.step ?? "?"}${failure.tool ? ` (${failure.tool})` : ""}: ` +
        `${String(failure.reason ?? "it could not be verified").slice(0, 200)}`
    };
  }

  /**
   * Where this runtime keeps its state.
   *
   * Exposed because the trigger store needs it and reaching into `_basePath`
   * from the daemon would make a private field part of the HTTP layer's
   * contract — which is how it stops being changeable.
   */
  get basePath() {
    return this._basePath ?? process.cwd();
  }

  /** One saved route by id, or null. */
  async readSkill(id) {
    const skills = await this.listSkills();
    return skills.find((skill) => skill.id === String(id ?? "").toLowerCase()) ?? null;
  }

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

  // THE WALL-CLOCK RACE THAT USED TO WRAP THIS IS GONE, AND `maxElapsedTime` IS NOT.
  //
  // `submitIntent` used to race `_submitIntent` against a `setTimeout` and settle
  // TIMED_OUT if the staged pipeline overran. That race only ever guarded the
  // staged branch — the fast path returns above it and never entered the race —
  // and the thing it was guarding against was a pipeline stage that could hang
  // indefinitely (the test for it stubbed `intentEngine.classify` with a promise
  // that never settles). `_submitIntent` cannot hang any more: it is a few lines
  // that build a session and return. Racing it against a timer would be ceremony
  // around something that completes synchronously.
  //
  // `maxElapsedTime` still does exactly what it did on the route that matters:
  // `_submitFastIntent` reads it and passes it to the loop as `maxElapsedMs`.
  async submitIntent(rawText, options = {}) {
    if (this._canRunFastAgent(options)) return this._submitFastIntent(rawText, options);
    return this._submitIntent(rawText, options);
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
      const settle = (approved, automatic = false, remember = false) => {
        if (!this._approvals.delete(approvalId)) return;
        clearTimeout(timer);
        emit({
          type: "APPROVAL_RESOLVED",
          details: { approvalId, approved, autoApproved: automatic, remember: remember === true }
        });
        // AN OBJECT, NOT A BOOLEAN, because the card now carries two answers.
        // `askPermission` in tools.js accepts either shape, so every other
        // confirmer in the tree — the probes, the tests — keeps working
        // unchanged and simply never sets `remember`.
        resolve({ approved, remember: remember === true });
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
          approvalMode: accessPolicy.approvalMode,
          // WHAT THE CARD MAY ALSO OFFER TO STOP ASKING ABOUT, or absent.
          // Decided in shell-rules.js, forwarded verbatim: the label the user
          // reads has to be the exact shape the allowlist will match, or they
          // are consenting to something other than what they were shown.
          ...(request.remember ? { remember: request.remember } : {})
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
    // THE STAGED PIPELINE IS NO LONGER REACHED FROM THE PRODUCT.
    //
    // This branch was the only route to it: when the model could not be reached,
    // the request was re-planned from typed capabilities with no model at all.
    // The count above it — `stagedPipelineReaches`, added expressly so the
    // decision could be made on a number rather than an argument — answered the
    // question it was written for:
    //
    //   0 of 60 runs, 19 Aug        0 of 63 runs, 21 Aug
    //   0 of 69 runs, 22 Aug        0 of 143 real sessions, 28 Aug – 1 Sep
    //
    // Never once, in either the suite or five days of real use. And the two
    // occasions it IS known to have run, it made things worse rather than
    // better. Asked "is python installed?" on a brief network wobble it ran a
    // WinGet package scan and answered:
    //
    //   Task 1fce993df4344396d96cb860502089b5 failed: Execution exited with
    //   nonzero code 2316632084
    //
    // — a raw Win32 status and an internal GUID, for a question `python
    // --version` answers in a second, replacing the truthful sentence the loop
    // had already written. On the safety task it spent 93 further seconds
    // re-deriving an answer that was already correct and already on screen.
    //
    // IT PLANS FROM TYPED CAPABILITIES, WHICH IS WHY IT CANNOT FALL SILENT. Given
    // a request it cannot map, it does not decline — it maps it to the nearest
    // capability it has and runs that. A fallback whose failure mode is
    // confident nonsense is worse than no fallback, because the honest message
    // it overwrites was the correct answer.
    //
    // So a request that cannot reach the model now keeps the loop's own sentence
    // — "I could not reach the model — the connection dropped. That is the
    // network, not the machine or the request; try again in a moment" — which is
    // both true and actionable, and nothing on the machine is touched.
    //
    // WHAT IS LEFT BEHIND, DELIBERATELY. The ~15,000 lines under `_submitIntent`
    // are now unreachable from any product route and are still in the tree. They
    // are not deleted in this change because `_submitIntent` shares this file
    // with the hot path, 32 test files reference it, and a deletion that large
    // must be its own change with its own verification — mixing it in here would
    // make any later regression impossible to attribute. `stagedPipelineReaches`
    // stays too: it is what the eval reports, and it must keep reading 0.

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
      // WHY IT ENDED THAT WAY, AND IT WAS BEING THROWN AWAY HERE.
      //
      // `_settle` computes `failureReason` on every failing path and carries a
      // paragraph explaining why inferring it from the message was wrong — the
      // runtime used to decide whether the model was reachable by running a regex
      // over the sentence, and spent ninety seconds in the offline pipeline when
      // it guessed wrong. Then this object was built without the field, and
      // `AGENT_DONE` is an event the session store does not keep.
      //
      // Measured on the real store, 4 Sep 2026, over the 169 sessions of the last
      // seven days: 167 carry events, ZERO carry an AGENT_DONE, and not one holds
      // a failureReason anywhere. So "why do requests fail" — the first question
      // anyone asks of a week of use — was unanswerable, and every improvement to
      // failure handling has been argued from transcripts read by hand.
      //
      // Null on a run that worked, which is the same convention `_settle` uses.
      failureReason: outcome.failureReason ?? null,
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

  // THE STAGED PIPELINE IS GONE. THIS IS WHAT IS LEFT OF ITS ENTRY POINT.
  //
  // `_submitIntent` used to re-plan a request from typed capabilities with no
  // model at all: classify, collect context, plan, validate, assess risk, apply
  // policy, request approval, schedule, observe, verify. It was roughly 15,000
  // lines across ten packages, and `stagedPipelineReaches` — the counter added
  // expressly so this decision could be made on a number rather than an
  // argument — answered the question it was written for:
  //
  //   0 of 60 runs, 19 Aug        0 of 63 runs, 21 Aug
  //   0 of 69 runs, 22 Aug        0 of 143 real sessions, 28 Aug - 1 Sep
  //
  // Never once, in either the suite or five days of real use.
  //
  // AND THE TWO OCCASIONS IT IS KNOWN TO HAVE RUN, IT MADE THINGS WORSE. Asked
  // "is python installed?" on a brief network wobble it ran a WinGet package
  // scan and answered
  //
  //   Task 1fce993df4344396d96cb860502089b5 failed: Execution exited with
  //   nonzero code 2316632084
  //
  // — a raw Win32 status and an internal GUID, for a question `python
  // --version` answers in a second, replacing the truthful sentence the loop
  // had already written. On the safety task it spent 93 further seconds
  // re-deriving an answer that was already correct and already on screen.
  //
  // IT PLANNED FROM TYPED CAPABILITIES, WHICH IS WHY IT COULD NOT FALL SILENT.
  // Given a request it could not map it did not decline — it mapped it to the
  // nearest capability it had and ran that. A fallback whose failure mode is
  // confident nonsense is worse than no fallback, because the honest message it
  // overwrites was the correct answer.
  //
  // So the one route that still reached it — an install with NO model
  // configured — now gets a sentence that is true and that names the fix. The
  // house rule applies to the scaffolding as much as to the model: never claim
  // something happened without evidence, and never answer at all rather than
  // answer with nonsense.
  async _submitIntent(rawText, options = {}) {
    const session = this._createSession(options);
    session.currentState = RuntimeState.FAILED;
    options.onSessionCreated?.(session);
    options.onSessionStarted?.(session.sessionId);
    session.finalResponse = {
      status: "FAILED",
      message:
        "I cannot do anything on this machine because no model is configured. SYSCORA needs a model " +
        "provider to decide anything at all — open Settings and add an API key, or set " +
        "SYSCORA_MODEL_API_KEY before starting the daemon. Nothing on your machine was touched.",
      rawText,
      // The loop's own vocabulary, so every surface reads one set of reasons.
      failureReason: "MODEL_UNREACHABLE",
      metrics: { steps: 0, toolCalls: 0, elapsedMs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensFresh: 0 }
    };
    await this.addSessionEvent(session, "AGENT_DONE", session.finalResponse).catch(() => {});
    await this.persistSession(session).catch(() => {});
    return session;
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

  // Nothing reaches this any more, and it says so rather than pretending.
  //
  // It used to hand an approved plan to `_executeTaskGraph`. Both the plan and
  // the scheduler belonged to the staged pipeline; a session created by the
  // agent loop has never had either, so there has never been anything here for
  // it to continue. The endpoint is kept so the daemon's HTTP contract and the
  // desktop UI are unchanged.
  async continueApprovedSession(session) {
    session.currentState = RuntimeState.FAILED;
    session.finalResponse = {
      status: "FAILED",
      message:
        "That session cannot be continued: it was created by the staged execution pipeline, which no " +
        "longer exists. Ask again and the request will run on the agent loop from the start.",
      failureReason: "MODEL_UNREACHABLE"
    };
    await this.persistSession(session).catch(() => {});
    return session;
  }
  // UN-PAUSING IS STILL REAL. RESUMING A PLAN IS NOT.
  //
  // This method did two unrelated things. The first — moving a PAUSED session
  // back to the state it was suspended from, with an audit record — is an
  // honest transition on a stored session and never depended on the staged
  // pipeline, so it stays exactly as it was.
  //
  // The second re-checked a plan's approval commitment and handed the plan to
  // the scheduler. There are no plans and no scheduler now, so that branch
  // answers honestly instead of fabricating a resume.
  async resumeSessionById(sessionId, options = {}) {
    const session = await this.sessionStore.get(sessionId);
    validateExecutionSession(session);

    if (session.currentState === RuntimeState.PAUSED) {
      session.currentState = session.suspension?.suspendedFromState ?? RuntimeState.COMPLETED;
      await this.auditRepository.append(session.sessionId, "SESSION_RESUMED", {
        resumedToState: session.currentState
      });
      await this.persistSession(session);
      return session;
    }

    if (session.currentState === RuntimeState.REQUEST_CONFIRMATION_IF_REQUIRED) {
      return this.continueApprovedSession(session);
    }

    return session;
  }
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

}
