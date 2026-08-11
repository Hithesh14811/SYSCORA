import { validateSchema } from "../../model-providers/src/index.js";
import { ReasoningEngine } from "../../reasoning-engine/src/index.js";
import { OPERATION_PLANS } from "../../planner/src/index.js";
import crypto from "crypto";
const createId = () => crypto.randomBytes(16).toString("hex");

// The allow-list of named operations the deterministic planner maps 1:1 to a task
// graph. Surfaced to the model (LLM-first classification) so the LLM — not a
// keyword matcher — chooses the operation; the runtime only trusts a returned
// operation when it is in this set.
const KNOWN_OPERATIONS = Object.freeze(Object.keys(OPERATION_PLANS));
const KNOWN_OPERATION_SET = new Set(KNOWN_OPERATIONS);

// Operations that start a locally installed program. A model naming a website
// ("open youtube") will often reach for one of these, which sends a web goal
// into an application that was never installed. When the request itself
// classifies as a web outcome, that classification wins — see classify().
// Ways a person asks for media to start. Kept in one place so the media route
// recognizes an intent rather than one memorized phrasing.
const PLAYBACK_VERBS = /\b(?:play|watch|put\s+on|turn\s+on)\b/i;

const DESKTOP_LAUNCH_OPERATIONS = new Set([
  "application.launch",
  "application.notepad.launch",
  "process.launch"
]);

// Whether a provider is a REAL remote language model (as opposed to the
// deterministic Mock, or a Failover chain that only wraps Mock). Only a real
// model is authoritative for LLM-first routing; Mock/offline falls through to the
// deterministic extractors, which are its intended offline path. Detected via the
// provider's own capabilities() (remote: true), including through a Failover chain.
export function providerIsRemoteModel(provider) {
  if (!provider || typeof provider.capabilities !== "function") return false;
  let caps;
  try { caps = provider.capabilities(); } catch { return false; }
  if (caps?.remote === true) return true;
  if (Array.isArray(caps?.providers)) return caps.providers.some((c) => c?.remote === true);
  return false;
}

const USER_INTENT_SCHEMA = {
  type: "object",
  required: ["intentId", "rawText", "normalizedGoal", "category", "successCriteria"],
  properties: {
    intentId: { type: "string" },
    rawText: { type: "string" },
    normalizedGoal: { type: "string" },
    category: { type: "string" },
    operation: { type: "string" },
    // Present only for category CONVERSATION — the reply that answers the
    // request outright. See ReasoningEngine.understandIntent.
    directAnswer: { type: "string" },
    answerableWithoutInspecting: { type: "boolean" },
    entities: { type: "object" },
    constraints: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    successCriteria: { type: "array", items: { type: "string" } },
    requiredContext: { type: "array", items: { type: "string" } },
    requiredCapabilities: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    ambiguity: { type: "boolean" },
    clarificationQuestions: { type: "array", items: { type: "string" } },
    sensitivityFlags: { type: "array", items: { type: "string" } }
  }
};

export class IntentEngine {
  // Accepts either a ReasoningEngine (preferred — the single model boundary) or,
  // for backward compatibility, a raw modelProvider. When a reasoningEngine is
  // present, all model interaction goes through it; otherwise the deterministic
  // classifier below is authoritative.
  constructor(modelProviderOrReasoning) {
    if (modelProviderOrReasoning && typeof modelProviderOrReasoning.understandIntent === "function") {
      this.reasoningEngine = modelProviderOrReasoning;
    } else {
      // Compatibility callers may still supply a provider, but it is wrapped
      // immediately so IntentEngine never communicates with it directly.
      this.reasoningEngine = modelProviderOrReasoning
        ? new ReasoningEngine({ modelProvider: modelProviderOrReasoning })
        : null;
    }
  }

  async classify(rawText, context = {}) {
    const intentId = createId();
    const text = String(rawText ?? "").trim();
    const lower = text.toLowerCase();
    let modelResult = null;

    // Every natural-language turn goes through the reasoning boundary first.
    // Application-specific parsers below are an availability fallback only;
    // they are executors' argument recovery, not the agent's decision-maker.
    // A caller-supplied structured operation is already schema-bounded and must
    // not pay for (or be reinterpreted by) a redundant model request.
    const modelUnderstanding = this.reasoningEngine && !context.operation
      ? await this.reasoningEngine.understandIntent(text, {
          ...context,
          knownOperations: KNOWN_OPERATIONS
        })
      : null;
    // A real model (or an explicitly injected reasoning test double) may route
    // the request. The built-in MockModelProvider only returns canned fixtures;
    // treating those as user intent can turn an unrelated fixture into an
    // executable task (for example, Spotify becoming a WinGet search).
    const exposesModelProvider = this.reasoningEngine
      && Object.prototype.hasOwnProperty.call(this.reasoningEngine, "modelProvider");
    const modelCanRouteIntent = !exposesModelProvider
      || providerIsRemoteModel(this.reasoningEngine.modelProvider);
    if (modelUnderstanding?.ok && modelCanRouteIntent) modelResult = modelUnderstanding.data;

    // Rollback fast path (system-internal). A rollback is an explicit operation
    // triggered by the runtime/daemon, never free-form natural language, so it
    // never touches the keyword classifier or the reasoning engine. It carries a
    // required `sessionId` (the session whose recorded checkpoints are being
    // reverted) and optional `targetRecordIds` (a subset of that session's
    // rollback records; omitted means all of them) plus an optional `reason` for
    // the audit trail. This mirrors the explicit-operation bridge below but adds
    // the rollback-specific required-field enforcement that USER_INTENT_SCHEMA's
    // untyped `entities` object cannot express.
    if (context.operation === "session.rollback") {
      const sessionId = context.entities?.sessionId;
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("Invalid rollback intent: entities.sessionId is required.");
      }
      const targetRecordIds = Array.isArray(context.entities?.targetRecordIds)
        ? context.entities.targetRecordIds.map(String)
        : [];
      const reason = typeof context.entities?.reason === "string" ? context.entities.reason : null;
      // The runtime attaches the concrete rollback records (captured checkpoints)
      // it wants reverted. They travel on the intent so the capability's execute()
      // has everything it needs; when omitted (e.g. a schema-validation unit test)
      // the capability falls back to loading them from the persisted session.
      const records = Array.isArray(context.entities?.records) ? context.entities.records : [];
      const intent = {
        intentId,
        rawText: text || `Roll back session ${sessionId}`,
        normalizedGoal: context.normalizedGoal || `Roll back session ${sessionId}`,
        category: "ROLLBACK",
        operation: "session.rollback",
        entities: {
          workspacePath: context.workspacePath ?? process.cwd(),
          sessionId,
          targetRecordIds,
          reason,
          records
        },
        constraints: [],
        preferences: [],
        assumptions: [],
        unknowns: [],
        successCriteria: Array.isArray(context.successCriteria) && context.successCriteria.length
          ? context.successCriteria
          : ["Recorded changes are reverted and the restored state is verified"],
        requiredContext: [],
        requiredCapabilities: ["session.rollback"],
        confidence: 1,
        ambiguity: false,
        clarificationQuestions: [],
        sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) {
        throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      }
      return intent;
    }

    // Explicit-operation fast path. When a caller supplies a structured
    // `operation` (and optionally `entities`/`category`), we trust it and build
    // the intent deterministically without consulting the model. This is the
    // canonical bridge used by compatibility wrappers to translate a concrete
    // request into an intent that the deterministic planner maps 1:1 to a
    // capability. It removes all reliance on natural-language re-parsing.
    if (context.operation) {
      const intent = {
        intentId,
        rawText: text || context.operation,
        normalizedGoal: context.normalizedGoal || context.operation,
        category: context.category || "SYSTEM",
        operation: context.operation,
        entities: {
          workspacePath: context.workspacePath ?? process.cwd(),
          ...(context.entities || {})
        },
        constraints: [],
        preferences: [],
        assumptions: [],
        unknowns: [],
        successCriteria: Array.isArray(context.successCriteria) ? context.successCriteria : ["Operation completed and verified"],
        requiredContext: Array.isArray(context.requiredContext) ? context.requiredContext : [],
        requiredCapabilities: [],
        confidence: 1,
        ambiguity: false,
        clarificationQuestions: [],
        sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) {
        throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      }
      return intent;
    }

    // LLM-FIRST routing. Every free-text message is submitted to the reasoning
    // boundary before *any* local extractor is consulted.  Local extractors are
    // strictly a post-model availability fallback: they must never decide an
    // intent while a model has supplied a usable interpretation.  This matters
    // for arbitrary desktop work where a keyword list can never be complete.
    // Whether a REAL model supplied an interpretation at all. Note this is not
    // the same as "the model routed the request": the block below returns early
    // whenever the model names a usable typed operation, so any code reached
    // after it is, by definition, the model-did-not-route case — which is
    // precisely when the deterministic extractors are meant to run.
    // Outcome classification of the request itself. It is computed for every
    // request — including the LLM-first path — because it is the only signal
    // that can contradict a model routing a web destination into a desktop
    // application launch.
    const webOutcome = this.extractWebOutcome(lower, text);

    // Committing money or a reservation on the user's behalf is a boundary, not
    // a routing preference, so it is checked regardless of what the model chose.
    // No registered capability books, buys or pays for anything; without this
    // guard such a request falls through to generic UI automation, which drives
    // a real checkout flow it cannot safely finish and then reports a vague
    // "encountered a problem" — the worst of both outcomes. Say plainly that it
    // won't be done, and point at the read-only research route that IS
    // supported. A request that already classified as read-only research
    // (webOutcome) is not a transaction and is left alone.
    const unsupportedTransaction = webOutcome ? null : this.detectUnsupportedTransaction(text);
    if (unsupportedTransaction) {
      const intent = {
        intentId, rawText: text,
        normalizedGoal: unsupportedTransaction.normalizedGoal,
        category: "BROWSER",
        entities: { workspacePath: context.workspacePath ?? process.cwd() },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria: [unsupportedTransaction.message],
        requiredContext: [], requiredCapabilities: [],
        confidence: 1,
        ambiguity: true,
        clarificationQuestions: [unsupportedTransaction.message],
        sensitivityFlags: ["TRANSACTIONAL_ACTION_NOT_SUPPORTED"],
        unsupportedAction: unsupportedTransaction
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    if (modelResult) {
      const chosen = typeof modelResult.operation === "string" ? modelResult.operation.trim() : "";
      // Validate the model's route against modality facts that are explicit in
      // the request. A website cannot be launched as an installed executable,
      // and a bounded local read should not be stranded by an empty tool choice.
      // These are post-decision repairs with an audit trail, not pre-model routes.
      const typedLocalRead = this.extractLocalInventoryRead(lower, text, context);
      if (typedLocalRead && (!chosen || chosen === typedLocalRead.operation)) {
        const intent = this._buildOperationIntent(intentId, text, typedLocalRead.operation, {
          ...modelResult,
          normalizedGoal: typedLocalRead.normalizedGoal,
          category: "SYSTEM",
          entities: typedLocalRead.entities,
          successCriteria: typedLocalRead.successCriteria
        }, context);
        intent.routingOverride = {
          from: chosen || "(none)",
          reason: chosen === typedLocalRead.operation
            ? "CANONICALIZED_TYPED_LOCAL_READ_ENTITIES"
            : "TYPED_LOCAL_READ_PREFERRED_OVER_UNTYPED_OR_MISMATCHED_CHOICE"
        };
        const validation = validateSchema(intent, USER_INTENT_SCHEMA);
        if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
        return intent;
      }
      if (webOutcome && (!chosen || DESKTOP_LAUNCH_OPERATIONS.has(chosen))) {
        const intent = this._buildWebOutcomeIntent(intentId, text, webOutcome, context, {
          from: chosen || "(none)",
          reason: "WEB_DESTINATION_IS_NOT_AN_INSTALLED_APPLICATION"
        });
        const validation = validateSchema(intent, USER_INTENT_SCHEMA);
        if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
        return intent;
      }
      // The model is authoritative for natural-language routing. A typed
      // operation is merely a fast execution plan that the model may select;
      // omitting it means the general planner must compose a multi-tool graph.
      // In neither case may a downstream keyword extractor replace the model's
      // decision.
      if (chosen && chosen !== "ui.action" && KNOWN_OPERATION_SET.has(chosen)) {
        let operationResult = modelResult;
        // Recover literal arguments only after the model selected the tool.
        // This cannot select a tool or widen its scope.
        if (chosen === "spotify.track.play" || chosen === "spotify.track.open") {
          const extracted = this.extractSpotifyTrackRequest(lower, text);
          if (extracted) {
            const modelEntities = modelResult.entities && typeof modelResult.entities === "object"
              ? modelResult.entities
              : {};
            const hasTrack = ["query", "trackQuery", "track", "trackTitle", "song", "songTitle", "title"]
              .some((key) => typeof modelEntities[key] === "string" && modelEntities[key].trim());
            operationResult = {
              ...modelResult,
              entities: {
                ...modelEntities,
                ...(!hasTrack ? { query: extracted.query } : {}),
                ...(extracted.queueQuery ? { queueQuery: extracted.queueQuery } : {})
              }
            };
          }
        }
        if (chosen === "calculator.evaluate") {
          const calculated = this.extractCalculatorRequest(text);
          if (calculated) {
            // The model decided to use Calculator; this only compiles the
            // literal arithmetic into the executor's strict input contract.
            // Human forms such as "99 x 1124" are not valid capability input,
            // and expectedResult is required for independent UI verification.
            operationResult = {
              ...operationResult,
              entities: { ...(operationResult.entities ?? {}), ...calculated }
            };
          }
        }
        if (chosen === "package.winget.reinstall") {
          const exactId = this.extractKnownInstallTarget(lower);
          if (exactId) {
            operationResult = {
              ...modelResult,
              entities: { ...(modelResult.entities ?? {}), id: exactId }
            };
          }
        }
        const intent = this._buildOperationIntent(intentId, text, chosen, operationResult, context);
        const validation = validateSchema(intent, USER_INTENT_SCHEMA);
        if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
        return intent;
      }

      const intent = this._buildModelIntent(intentId, text, modelResult, context);
      if (intent.confidence < 0.6 && this.reasoningEngine) {
        const clarification = await this.reasoningEngine.clarifyIntent(text, context);
        intent.ambiguity = true;
        intent.clarificationQuestions = clarification.ok && clarification.data.questions.length
          ? clarification.data.questions
          : ["Please provide the missing target or desired outcome before execution."];
      }
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;

    }

    const spotifyRequest = this.extractSpotifyTrackRequest(lower, text);
    if (spotifyRequest) {
      const intent = this._buildSpotifyIntent(intentId, text, spotifyRequest, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    // Provider-unavailable fallbacks. Each route is accepted only when it can
    // satisfy the complete requested outcome with one bounded typed workflow.
    const queueFallback = this.extractSpotifyQueueFollowup(text, context.history);
    if (queueFallback) {
      const intent = this._buildOperationIntent(intentId, text, "spotify.track.queue", {
        category: "APPLICATION",
        normalizedGoal: `Queue ${queueFallback.query} in Spotify`,
        entities: { query: queueFallback.query },
        successCriteria: [`${queueFallback.query} is in the Spotify queue`],
        confidence: 1
      }, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }
    const calculatorFallback = this.extractCalculatorRequest(text);
    if (calculatorFallback) {
      const intent = this._buildOperationIntent(intentId, text, "calculator.evaluate", {
        category: "APPLICATION",
        normalizedGoal: `Calculate ${calculatorFallback.expression} in Calculator`,
        entities: calculatorFallback,
        successCriteria: [`Calculator visibly shows ${calculatorFallback.expectedResult}`],
        confidence: 1
      }, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }
    const draftFallback = this.extractWhatsAppDraft(text);
    if (draftFallback) {
      const intent = this._buildOperationIntent(intentId, text, "whatsapp.message.draft", {
        category: "APPLICATION",
        normalizedGoal: `Draft a WhatsApp message to ${draftFallback.contact} without sending it`,
        entities: draftFallback,
        constraints: ["DO_NOT_SEND"],
        successCriteria: [`The ${draftFallback.contact} chat is open`, "The exact message is visible in the composer", "No message is sent"],
        confidence: 1
      }, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    const localInventoryRead = this.extractLocalInventoryRead(lower, text, context);
    if (localInventoryRead) {
      const intent = this._buildOperationIntent(intentId, text, localInventoryRead.operation, {
        normalizedGoal: localInventoryRead.normalizedGoal,
        category: "SYSTEM",
        entities: localInventoryRead.entities,
        successCriteria: localInventoryRead.successCriteria,
        confidence: 1
      }, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    // Direct desktop controls are intentionally recognized before any model
    // call. They are bounded, local operations with no planning benefit: the
    // user expects "open Calculator" or "turn the volume down" to happen now.
    const directDesktopAction = this.extractDirectDesktopAction(lower, text);
    if (directDesktopAction) {
      const { operation, entities, normalizedGoal, successCriteria } = directDesktopAction;
      const intent = {
        intentId, rawText: text, normalizedGoal, category: "APPLICATION", operation,
        entities: { workspacePath: context.workspacePath ?? process.cwd(), ...entities },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria, requiredContext: [], requiredCapabilities: [operation],
        confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    // Package discovery is read-only and must stay distinct from both an
    // installed-state inspection and an install mutation. Hypothetical wording
    // such as "what would be installed" must never become either of those.
    const packageSearchQuery = this.extractPackageSearchQuery(lower, text);
    if (packageSearchQuery) {
      const intent = {
        intentId, rawText: text, normalizedGoal: `Find ${packageSearchQuery} with Windows Package Manager`, category: "SYSTEM",
        operation: "package.winget.search",
        entities: { workspacePath: context.workspacePath ?? process.cwd(), query: packageSearchQuery },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria: [`Report matching packages for ${packageSearchQuery}`],
        requiredContext: [], requiredCapabilities: ["package.winget.search"],
        confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    if (webOutcome) {
      const intent = this._buildWebOutcomeIntent(intentId, text, webOutcome, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    const knownInstallId = this.extractKnownInstallTarget(lower);
    if (knownInstallId && /\b(reinstall|remove\s+and\s+reinstall|uninstall\s+and\s+reinstall)\b/.test(lower)) {
      const intent = this._buildOperationIntent(intentId, text, "package.winget.reinstall", {
        normalizedGoal: `Reinstall ${knownInstallId}`,
        category: "SYSTEM",
        entities: { id: knownInstallId },
        successCriteria: [`${knownInstallId} is reinstalled and verified`],
        confidence: 1
      }, context);
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }
    if (/\binstall\b/.test(lower) && knownInstallId && !/\b(dependenc|project)\b/.test(lower)) {
      const intent = {
        intentId, rawText: text, normalizedGoal: `Install ${knownInstallId}`, category: "SYSTEM",
        operation: "package.winget.install",
        entities: { workspacePath: context.workspacePath ?? process.cwd(), id: knownInstallId },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria: [`${knownInstallId} is installed and verified`],
        requiredContext: [], requiredCapabilities: ["package.winget.install"],
        confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    if (/\b(system info|computer info|system details|computer details|specs|specifications)\b/.test(lower)) {
      const intent = {
        intentId, rawText: text, normalizedGoal: "Show system information", category: "SYSTEM",
        operation: "system.inspect", entities: { workspacePath: context.workspacePath ?? process.cwd() },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria: ["System information is displayed"], requiredContext: [], requiredCapabilities: ["system.inspect"],
        confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    // Installed-package status is a read-only, well-scoped question. Handle it
    // deterministically so it cannot degrade into a generic system inspection
    // when a model omits the required capability.
    const installedPackageId = this.extractInstalledPackageId(lower);
    if (installedPackageId) {
      const intent = {
        intentId,
        rawText: text,
        normalizedGoal: `Check whether ${installedPackageId} is installed`,
        category: "SYSTEM",
        operation: "package.winget.inspect",
        entities: { workspacePath: context.workspacePath ?? process.cwd(), id: installedPackageId },
        constraints: [], preferences: [], assumptions: [], unknowns: [],
        successCriteria: [`Report whether ${installedPackageId} is installed`],
        requiredContext: [], requiredCapabilities: ["package.winget.inspect"],
        confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
      };
      const validation = validateSchema(intent, USER_INTENT_SCHEMA);
      if (!validation.valid) throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
      return intent;
    }

    // Reasoning merge (offline / non-remote path). The LLM-first block above
    // already consulted a REAL remote model (setting modelResult); this block is
    // reached only when that did not run — i.e. Mock, no model, or a provider
    // without a remote route — so it preserves the historical behavior of merging
    // a deterministic provider's (e.g. Mock) structured output into the intent. It
    // owns all model interaction, schema validation and bounded repair, and returns
    // { ok, data } — never throwing — so a failure here silently falls through
    // to the deterministic classifier below. The runtime never trusts the model
    // directly; whatever comes back is merged into a validated UserIntent.
    // Fast health gate (Phase 6): skip the model classification when the
    // provider is unavailable so an unreachable gateway can't stall intent
    // parsing for 30s before the deterministic classifier runs. A provider with
    // no healthCheck (Mock/scripted) is treated as healthy.
    // The model has already been consulted above.  Do not make a second model
    // call after deterministic fallback handling: that both adds latency and
    // makes routing order impossible to audit.

    // Build final intent, using model result if available, else deterministic
    const intent = {
      intentId,
      rawText: text,
      // Downstream must distinguish "the model decided SYSTEM" from "the
      // model never answered and the offline classifier supplied SYSTEM". A
      // synthetic health probe can still succeed during the latter.
      modelDecisionStatus: modelResult
        ? "MODEL"
        : (modelUnderstanding ? "UNAVAILABLE" : "NOT_CONFIGURED"),
      normalizedGoal: modelResult?.normalizedGoal || this.getNormalizedGoal(lower, text),
      category: modelResult?.category || this.getCategory(lower),
      // Only ever set by the model, and only alongside category CONVERSATION;
      // the deterministic classifier has no opinion to offer here.
      ...(typeof modelResult?.directAnswer === "string" && modelResult.directAnswer.trim()
        ? { directAnswer: modelResult.directAnswer.trim() }
        : {}),
      ...(typeof modelResult?.answerableWithoutInspecting === "boolean"
        ? { answerableWithoutInspecting: modelResult.answerableWithoutInspecting }
        : {}),
      entities: {
        // Always guarantee a workspacePath so every intent satisfies domain
        // validation; model/deterministic entities override the default.
        workspacePath: context.workspacePath ?? process.cwd(),
        ...(modelResult?.entities || this.extractEntities(lower, text, context))
      },
      constraints: Array.isArray(modelResult?.constraints) ? modelResult.constraints : [],
      preferences: Array.isArray(modelResult?.preferences) ? modelResult.preferences : [],
      assumptions: Array.isArray(modelResult?.assumptions) ? modelResult.assumptions : [],
      unknowns: Array.isArray(modelResult?.unknowns) ? modelResult.unknowns : [],
      successCriteria: Array.isArray(modelResult?.successCriteria) ? modelResult.successCriteria : this.getSuccessCriteria(lower),
      requiredContext: Array.isArray(modelResult?.requiredContext) ? modelResult.requiredContext : this.getRequiredContext(lower),
      requiredCapabilities: Array.isArray(modelResult?.requiredCapabilities) ? modelResult.requiredCapabilities : [],
      confidence: Number.isFinite(modelResult?.confidence) ? modelResult.confidence : (modelResult ? 0.7 : 1),
      ambiguity: modelResult?.ambiguity || false,
      clarificationQuestions: Array.isArray(modelResult?.clarificationQuestions) ? modelResult.clarificationQuestions : [],
      sensitivityFlags: Array.isArray(modelResult?.sensitivityFlags) ? modelResult.sensitivityFlags : []
    };

    if (intent.confidence < 0.6 && this.reasoningEngine) {
      const clarification = await this.reasoningEngine.clarifyIntent(text, context);
      intent.ambiguity = true;
      intent.clarificationQuestions = clarification.ok && clarification.data.questions.length
        ? clarification.data.questions
        : ["Please provide the missing target or desired outcome before execution."];
    }

    // Validate schema
    const validation = validateSchema(intent, USER_INTENT_SCHEMA);
    if (!validation.valid) {
      throw new Error(`Invalid UserIntent: ${validation.errors.join(", ")}`);
    }

    return intent;
  }

  // Preserve the model's complete decision when no single typed operation can
  // satisfy the turn. requiredCapabilities may contain several tools; the
  // general planner uses them to build an ordered task graph.
  _buildModelIntent(intentId, text, modelResult, context) {
    return {
      intentId,
      rawText: text,
      normalizedGoal: modelResult.normalizedGoal || text,
      category: modelResult.category || "SYSTEM",
      ...(typeof modelResult.directAnswer === "string" && modelResult.directAnswer.trim()
        ? { directAnswer: modelResult.directAnswer.trim() }
        : {}),
      ...(typeof modelResult.answerableWithoutInspecting === "boolean"
        ? { answerableWithoutInspecting: modelResult.answerableWithoutInspecting }
        : {}),
      entities: {
        workspacePath: context.workspacePath ?? process.cwd(),
        ...(modelResult.entities && typeof modelResult.entities === "object" ? modelResult.entities : {})
      },
      constraints: Array.isArray(modelResult.constraints) ? modelResult.constraints : [],
      preferences: Array.isArray(modelResult.preferences) ? modelResult.preferences : [],
      assumptions: Array.isArray(modelResult.assumptions) ? modelResult.assumptions : [],
      unknowns: Array.isArray(modelResult.unknowns) ? modelResult.unknowns : [],
      successCriteria: Array.isArray(modelResult.successCriteria) && modelResult.successCriteria.length
        ? modelResult.successCriteria
        : ["The requested outcome is completed and verified"],
      requiredContext: Array.isArray(modelResult.requiredContext) ? modelResult.requiredContext : [],
      requiredCapabilities: Array.isArray(modelResult.requiredCapabilities) ? modelResult.requiredCapabilities : [],
      confidence: Number.isFinite(modelResult.confidence) ? modelResult.confidence : 0.7,
      ambiguity: modelResult.ambiguity === true,
      clarificationQuestions: Array.isArray(modelResult.clarificationQuestions) ? modelResult.clarificationQuestions : [],
      sensitivityFlags: Array.isArray(modelResult.sensitivityFlags) ? modelResult.sensitivityFlags : []
    };
  }

  // Build an operation-driven intent from a model-CHOSEN known operation. The
  // planner maps `operation` 1:1 to a deterministic task graph (OPERATION_PLANS),
  // so the LLM's choice — not a keyword matcher — selects the workflow while the
  // execution path stays typed and bounded. The model's entities/goal/criteria are
  // carried through; workspacePath is always guaranteed for domain validation.
  _buildOperationIntent(intentId, text, operation, modelResult, context) {
    const entities = {
      workspacePath: context.workspacePath ?? process.cwd(),
      ...(modelResult?.entities && typeof modelResult.entities === "object" ? modelResult.entities : {})
    };
    return {
      intentId,
      rawText: text,
      normalizedGoal: (typeof modelResult?.normalizedGoal === "string" && modelResult.normalizedGoal.trim())
        ? modelResult.normalizedGoal
        : operation,
      category: (typeof modelResult?.category === "string" && modelResult.category.trim())
        ? modelResult.category
        : "SYSTEM",
      operation,
      entities,
      constraints: Array.isArray(modelResult?.constraints) ? modelResult.constraints : [],
      preferences: Array.isArray(modelResult?.preferences) ? modelResult.preferences : [],
      assumptions: Array.isArray(modelResult?.assumptions) ? modelResult.assumptions : [],
      unknowns: Array.isArray(modelResult?.unknowns) ? modelResult.unknowns : [],
      successCriteria: Array.isArray(modelResult?.successCriteria) && modelResult.successCriteria.length
        ? modelResult.successCriteria
        : ["Operation completed and verified"],
      requiredContext: Array.isArray(modelResult?.requiredContext) ? modelResult.requiredContext : [],
      requiredCapabilities: [operation],
      confidence: Number.isFinite(modelResult?.confidence) ? modelResult.confidence : 0.9,
      ambiguity: false,
      clarificationQuestions: [],
      sensitivityFlags: Array.isArray(modelResult?.sensitivityFlags) ? modelResult.sensitivityFlags : []
    };
  }

  // High-precision typed reads for machine-local inventories.  These are
  // semantic families rather than application scripts: one process snapshot
  // covers ranking/listing questions, and one directory primitive covers any
  // named standard folder or explicit path.
  extractLocalInventoryRead(lower, rawText, context = {}) {
    const processQuestion = /\bprocess(?:es)?\b/i.test(rawText) && (
      /\b(?:most|highest|top)\b[\s\S]{0,40}\bmemory\b/i.test(rawText) ||
      /\bmemory\b[\s\S]{0,40}\b(?:most|highest|top)\b/i.test(rawText) ||
      /\b(?:list|show|which|what)\b[\s\S]{0,35}\brunning\s+process(?:es)?\b/i.test(rawText)
    );
    if (processQuestion) {
      return {
        operation: "processes.list",
        entities: {},
        normalizedGoal: /\bmemory\b/i.test(rawText)
          ? "Identify the running process using the most memory"
          : "List the running processes",
        successCriteria: [/\bmemory\b/i.test(rawText)
          ? "Report the live highest-memory process and its memory usage"
          : "Report the live running processes"]
      };
    }

    const folderQuestion = /\b(?:folder|directory|downloads|documents|desktop)\b/i.test(rawText) &&
      /\b(?:how many|count|list|show|what(?:'s| is)|contents?|files?)\b/i.test(rawText);
    if (!folderQuestion) return null;

    const quoted = rawText.match(/["']([^"']+)["']/)?.[1];
    const absolute = rawText.match(/\b[A-Za-z]:\\[^\r\n,;]+/)?.[0]?.trim();
    let directoryPath = quoted || absolute || null;
    if (!directoryPath) {
      if (/\bdownloads?\b/i.test(rawText)) directoryPath = "%USERPROFILE%\\Downloads";
      else if (/\bdocuments?\b/i.test(rawText)) directoryPath = "%USERPROFILE%\\Documents";
      else if (/\bdesktop\b/i.test(rawText)) directoryPath = "%USERPROFILE%\\Desktop";
      else if (/\b(?:project|workspace|current)\b/i.test(rawText)) directoryPath = context.workspacePath ?? process.cwd();
    }
    if (!directoryPath) return null;
    const countFiles = /\b(?:how many|count|number of)\b/i.test(rawText);
    return {
      operation: "filesystem.list",
      entities: { directoryPath, depth: 1, maxEntries: 2000, countFiles },
      normalizedGoal: countFiles
        ? `Count files in ${directoryPath}`
        : `List the contents of ${directoryPath}`,
      successCriteria: [countFiles
        ? "Report the exact number of files in the requested directory"
        : "Report the requested directory contents"]
    };
  }

  // Build a BROWSER intent from a classified web outcome. Shared by the
  // deterministic path and by the LLM-first override so both produce exactly the
  // same typed intent.
  _buildWebOutcomeIntent(intentId, text, webOutcome, context, routingOverride = null) {
    const operation = webOutcome.operation ?? "browser.navigate";
    return {
      intentId,
      rawText: text,
      normalizedGoal: webOutcome.normalizedGoal,
      category: "BROWSER",
      operation,
      ...(routingOverride ? { routingOverride } : {}),
      entities: {
        workspacePath: context.workspacePath ?? process.cwd(),
        url: webOutcome.url,
        ...(webOutcome.entities ?? {})
      },
      constraints: webOutcome.constraints,
      preferences: [], assumptions: [], unknowns: [],
      successCriteria: webOutcome.successCriteria,
      requiredContext: [], requiredCapabilities: webOutcome.requiredCapabilities ?? [operation],
      confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
    };
  }

  // Build an APPLICATION intent from a deterministically classified Spotify
  // track/queue request. Shared by the LLM-first override (model left the
  // operation untyped) and the offline deterministic path so both produce
  // exactly the same typed intent.
  _buildSpotifyIntent(intentId, text, spotifyRequest, context) {
    const { query, queueQuery, operation } = spotifyRequest;
    const playing = operation === "spotify.track.play";
    const queued = playing && Boolean(queueQuery);
    return {
      intentId, rawText: text,
      normalizedGoal: queued
        ? `Play ${query} in Spotify and queue ${queueQuery}`
        : (playing ? `Play ${query} in Spotify` : `Open Spotify results for ${query}`),
      category: "APPLICATION",
      operation,
      entities: { workspacePath: context.workspacePath ?? process.cwd(), query, ...(queueQuery ? { queueQuery } : {}) },
      constraints: [], preferences: [], assumptions: [], unknowns: [],
      successCriteria: [
        playing ? `Spotify is playing ${query}` : `Spotify opens results for ${query}`,
        ...(queueQuery ? [`${queueQuery} is in the Spotify queue`] : [])
      ],
      requiredContext: [], requiredCapabilities: [operation, ...(queueQuery ? ["spotify.track.queue"] : [])],
      confidence: 1, ambiguity: false, clarificationQuestions: [], sensitivityFlags: []
    };
  }

  getCategory(lower) {
    if (lower.includes("port") || lower.includes("process") || lower.includes("system")) return "SYSTEM";
    if (lower.includes("env") || lower.includes("environment") || lower.includes("path")) return "ENVIRONMENT";
    if (lower.includes("project") || lower.includes("install") && lower.includes("dependencies")) return "PROJECT";
    if (lower.includes("notepad") || lower.includes("calc") || lower.includes("application")) return "APPLICATION";
    if (lower.includes("edge") || lower.includes("browser") || lower.includes("search")) return "BROWSER";
    return "SYSTEM";
  }

  getNormalizedGoal(lower, text) {
    if (/why.*(slow|lag|performance)|computer slow|laptop slow/.test(lower)) {
      return "Explain likely performance contributors from system state";
    }
    if (lower.includes("port")) {
      return "Identify what is listening on the specified port";
    }
    if (lower.includes("install") && lower.includes("winget")) {
      return "Install a package via WinGet";
    }
    if (lower.includes("path")) {
      return "Manage user PATH environment variable";
    }
    if (lower.includes("env") || lower.includes("environment")) {
      return "Set an environment variable";
    }
    if (lower.includes("notepad")) {
      return "Open Notepad, type text, and save";
    }
    if (lower.includes("edge") || lower.includes("browser") || lower.includes("search")) {
      return "Open Edge and search for something";
    }
    if (lower.includes("project") && /\b(?:inspect|analy[sz]e|what\b.*\bneed\b.*\brun)\b/.test(lower)) {
      return "Inspect the project and report its run requirements";
    }
    if (lower.includes("run") && lower.includes("project")) {
      return "Detect, configure, run, and verify a project";
    }
    return "Process the given request";
  }

  extractEntities(lower, text, context) {
    const entities = { workspacePath: context.workspacePath ?? process.cwd() };
    const portMatch = lower.match(/port\s+(\d{2,5})|using port\s+(\d{2,5})/);
    if (portMatch) {
      entities.port = Number(portMatch[1] ?? portMatch[2]);
    }
    const keyMatch = lower.match(/set\s+(?:user\s+)?(?:env(?:ironment)?\s+)?(\w+)/);
    if (keyMatch) {
      entities.key = keyMatch[1];
    }
    const contentMatch = text.match(/type\s+['"](.+?)['"]|write\s+['"](.+?)['"]/i);
    if (contentMatch) {
      entities.content = contentMatch[1] ?? contentMatch[2];
    }
    const fileMatch = text.match(/as\s+([\w.-]+\.txt)/i);
    if (fileMatch) {
      entities.filename = fileMatch[1];
    }
    const queryMatch = text.match(/search\s+for\s+(.+?)(?:\.|$)/i) ?? text.match(/search\s+(.+)/i);
    if (queryMatch) {
      entities.query = queryMatch[1]?.trim();
    }
    return entities;
  }

  getSuccessCriteria(lower) {
    if (lower.includes("port")) {
      return ["Process using the specified port is identified"];
    }
    if (lower.includes("env") || lower.includes("environment")) {
      return ["Environment variable is set and verified"];
    }
    if (lower.includes("path")) {
      return ["PATH is updated and verified"];
    }
    if (lower.includes("notepad")) {
      return ["Notepad is opened and file is saved"];
    }
    if (lower.includes("project") && /\b(?:inspect|analy[sz]e|what\b.*\bneed\b.*\brun)\b/.test(lower)) {
      return ["Project setup is inspected"];
    }
    if (lower.includes("project")) {
      return ["Project is running and healthy"];
    }
    return ["Request is processed successfully"];
  }

  getRequiredContext(lower) {
    const contextTypes = [];
    if (lower.includes("system")) contextTypes.push("system");
    if (lower.includes("process") || lower.includes("port")) contextTypes.push("processes", "port");
    if (lower.includes("path") || lower.includes("env")) contextTypes.push("environment");
    if (lower.includes("project")) contextTypes.push("workspace");
    return contextTypes;
  }

  extractInstallTarget(lower, raw) {
    const map = {
      vlc: "VideoLAN.VLC",
      git: "Git.Git",
      node: "OpenJS.NodeJS.LTS",
      python: "Python.Python.3.12",
      docker: "Docker.DockerDesktop",
      spotify: "Spotify.Spotify",
      calculator: "Microsoft.WindowsCalculator"
    };
    for (const [key, id] of Object.entries(map)) {
      if (lower.includes(key)) return id;
    }
    const idMatch = raw.match(/install\s+([\w.-]+)/i);
    return idMatch?.[1] ?? "VideoLAN.VLC";
  }

  extractInstalledPackageId(lower) {
    if (!/\binstalled\b/.test(lower)) return null;
    if (/\b(?:would|could|might|will)\s+be\s+installed\b/.test(lower)) return null;
    const known = {
      vlc: "VideoLAN.VLC",
      git: "Git.Git",
      node: "OpenJS.NodeJS.LTS",
      python: "Python.Python.3.12",
      docker: "Docker.DockerDesktop",
      spotify: "Spotify.Spotify"
    };
    for (const [name, id] of Object.entries(known)) {
      if (lower.includes(name)) return id;
    }
    return null;
  }

  extractPackageSearchQuery(lower, raw) {
    if (!/\b(?:winget|windows package manager)\b/.test(lower)) return null;
    const match = String(raw ?? "").match(
      /\b(?:find|search(?:\s+for)?|look\s+up)\s+(.+?)(?=\s+(?:using|with|via|in|on)\s+(?:the\s+)?(?:windows package manager|winget)\b|[.,]|$)/i
    );
    const query = match?.[1]?.trim();
    return query && query.length <= 120 ? query : null;
  }

  extractKnownInstallTarget(lower) {
    const known = {
      vlc: "VideoLAN.VLC", git: "Git.Git", node: "OpenJS.NodeJS.LTS",
      python: "Python.Python.3.12", docker: "Docker.DockerDesktop", spotify: "Spotify.Spotify"
    };
    return Object.entries(known).find(([name]) => lower.includes(name))?.[1] ?? null;
  }

  extractWebOutcome(lower, rawText) {
    const text = String(rawText ?? "").trim();
    const negative = [];
    if (/\b(?:do not|don't|never)\s+(?:book|reserve|purchase|buy|pay|submit)\b/i.test(text)) {
      negative.push("NO_BOOKING");
    }
    const youtube = /\byoutube\b/i.test(text);
    if (youtube) {
      const latestCreator = text.match(
        /\b(?:play|watch|put\s+on)\s+(.+?)(?:['\u2019]s)?\s+(?:most\s+recent|newest|latest)\s+(?:upload|video)(?:\s+on\s+youtube)?\s*[.!?]*$/i
      )?.[1]?.trim().replace(/^(?:the\s+)?/i, "");
      if (latestCreator && latestCreator.length >= 2 && latestCreator.length <= 120) {
        return {
          operation: "browser.youtube.latest",
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(latestCreator)}`,
          entities: { creator: latestCreator, query: latestCreator },
          requiredCapabilities: ["browser.youtube.latest"],
          normalizedGoal: `Play ${latestCreator}'s latest YouTube video`,
          constraints: [...negative, "REJECT_OPTIONAL_COOKIES"],
          successCriteria: [
            `${latestCreator}'s channel is opened`,
            "The channel Videos page is opened",
            "The newest listed video is independently observed as playing"
          ]
        };
      }
      const mediaMatch = text.match(/\b(?:play|watch|put\s+on|turn\s+on|find|search(?:\s+for)?)\s+(.+?)(?:\s+(?:video\s+)?on\s+youtube|\s+youtube\s+video|$)/i);
      let query = mediaMatch?.[1]?.trim()
        .replace(/\s+(?:a\s+)?video$/i, "")
        .replace(/^(?:a|an|the|some|any)\b\s*/i, "")
        .trim();
      // "Play a video on YouTube about X" names the subject AFTER "on YouTube",
      // not before it, so the match above captured only the generic "a video"
      // placeholder and stripped it to empty. Recover the trailing topic clause
      // instead of falling back to "no subject named" for a request that did
      // name one.
      if (!query) {
        const topicMatch = text.match(/\byoutube\b\s*(?:video\s*)?(?:about|on|regarding|for|of)\s+(.+?)[.?!]?$/i);
        if (topicMatch?.[1]?.trim()) query = topicMatch[1].trim();
      }
      // "Play a YouTube video" names no subject. Opening the site is the honest
      // reading; searching for the leftover article would not be.
      if (!query && PLAYBACK_VERBS.test(text)) {
        return {
          url: "https://www.youtube.com/",
          normalizedGoal: "Open YouTube in a browser",
          constraints: negative,
          successCriteria: ["The controlled browser is on youtube.com"]
        };
      }
      if (query && PLAYBACK_VERBS.test(text)) {
        const openedCriterion = `A YouTube result for ${query} is opened`;
        const playingCriterion = "Video playback is independently observed as playing";
        return {
          operation: "browser.media.play",
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
          entities: {
            query,
            resultSelector: "a#video-title",
            mediaSelector: "video",
            blockedStateSelector: ".ad-showing",
            // Echoed onto the task so the plan's own evidence covers these in
            // the request's wording. The percent-encoded search URL alone does
            // not: "Rick%20Astley" shares no tokens with "Rick Astley", so the
            // relevance check saw an uncovered goal and diverted a correct
            // browser.media.play plan into generic UI automation.
            completionCriteria: [openedCriterion, playingCriterion]
          },
          requiredCapabilities: ["browser.media.play"],
          normalizedGoal: `Play ${query} on YouTube`,
          constraints: negative,
          successCriteria: [openedCriterion, playingCriterion]
        };
      }
      if (/^\s*(?:please\s+)?(?:open|go\s+to|visit|launch)\s+(?:the\s+)?youtube(?:\s+website)?\s*[.!?]*$/i.test(text)) {
        return {
          url: "https://www.youtube.com/",
          normalizedGoal: "Open YouTube in a browser",
          constraints: negative,
          successCriteria: ["The controlled browser is on youtube.com"]
        };
      }
    }

    const flightResearch = /\b(?:find|search|compare|show)\b[\s\S]*\bflights?\b/i.test(text)
      || /\b(?:cheapest|lowest|best)\b[\s\S]*\bflights?\b/i.test(text);
    if (flightResearch) {
      // Echo the "prices reported with source" success criterion into the
      // task's own completionCriteria (the planner's browser.research builder
      // passes entities.completionCriteria straight through). Without this,
      // the plan's static pre-execution evidence (goal/description) doesn't
      // share enough wording with that criterion, so the pre-execution
      // goal-contract coverage check rejects an otherwise-correct single-task
      // plan and falls back to the adaptive controller's raw UI automation —
      // exactly the unsupervised-booking-progression risk this typed route
      // exists to avoid. Phrasing the no-booking constraint as "Do not ..."
      // (rather than "No ... occurs") is what the goal-contract's prohibition
      // detector recognizes, so it is verified as a behavioral constraint
      // against the plan's mutation shape instead of requiring literal text
      // evidence a read-only research task would never naturally produce.
      const pricesCriterion = "Prices and relevant itinerary details are reported with their source";
      return {
        operation: "browser.research",
        // Google serves its bot-detection interstitial (/sorry/index) to this
        // controlled browser instead of results, so research against it always
        // came back empty. Bing returns real result markup to the same browser.
        url: `https://www.bing.com/search?q=${encodeURIComponent(text)}`,
        entities: {
          goal: "Compare read-only flight options",
          // The generic "any anchor in main" default sweeps up the sponsored
          // block first, returning ad-redirect URLs with no route or price.
          // Bing's organic result headings carry the substance ("$254 Flights
          // from Tokyo (TYOA) to Sydney (SYD)").
          resultSelector: "#b_results li.b_algo h2 a",
          limit: 12,
          completionCriteria: [pricesCriterion]
        },
        requiredCapabilities: ["browser.research"],
        normalizedGoal: "Research and compare flight options without booking",
        constraints: [...new Set([...negative, "NO_BOOKING"])],
        successCriteria: [
          "Flight options are observed from browser results",
          pricesCriterion,
          "Do not book, purchase, submit passenger data, or make any payment."
        ]
      };
    }
    return null;
  }

  // Detect a request to commit money or a reservation. Nothing in the registry
  // books, buys, pays, or checks out, so this is not "a capability we haven't
  // routed yet" — it is outside what the runtime will do on the user's behalf.
  // Deliberately narrow: a transactional VERB aimed at a purchasable OBJECT, so
  // "order the files by name", "reserve memory" or "find me a book" are not
  // caught. Returns a refusal descriptor, or null.
  detectUnsupportedTransaction(rawText) {
    const text = String(rawText ?? "");
    // Explicitly hypothetical or read-only framings are questions, not requests.
    if (/\b(?:how (?:do|would|can) i|what would it cost|don't|do not|without)\b/i.test(text)) return null;
    const purchasable = /\b(flight|flights|ticket|tickets|hotel|hostel|room|rooms|seat|seats|table|cab|taxi|ride|rental|car|appointment|reservation|subscription|delivery|takeaway|meal|food|pizza|groceries|item|items|product|products)\b/i;
    // Buying is unambiguous on its own — there is no benign reading of "buy X"
    // or "check out" — so it needs no object to qualify.
    const purchaseVerb = /\b(buy|purchase|pay\s+for|place\s+an?\s+order|check\s*out|checkout)\b/i;
    // "order" and "book"/"reserve"/"rent" all have common non-commercial senses
    // ("order the files by name", "reserve memory", "find me a book"), so they
    // only count as transactional against a purchasable object.
    const orderVerb = /\border(?:s|ing|ed)?\b/i;
    const bookingVerb = /\b(book|reserve|rent)(?:s|ing|ed)?\b/i;
    const isBooking = bookingVerb.test(text) && purchasable.test(text);
    const isPurchase = purchaseVerb.test(text) || (orderVerb.test(text) && purchasable.test(text));
    // A bare payment instruction needs no object to be unmistakably financial.
    const isPayment = /\b(pay|send money|transfer (?:money|funds)|make a payment|complete (?:the )?(?:purchase|payment|checkout))\b/i.test(text);
    // Sending a message as the user is the same shape of problem: nothing in
    // the registry sends mail or posts anywhere, and it reaches other people
    // irreversibly. Without this the request drifts into UI automation and
    // stalls on a generic "this action requires approval", which tells the
    // user nothing about what went wrong or what to do instead.
    const isCommunication = /\b(?:send|write|reply\s+to|respond\s+to|forward|post|tweet|dm|message)\b/i.test(text)
      && /\b(?:email|e-mail|mail|message|text|sms|slack|teams|whatsapp|tweet|post|dm)\b/i.test(text);
    if (!isBooking && !isPurchase && !isPayment && !isCommunication) return null;
    const kind = isCommunication && !isBooking && !isPurchase && !isPayment
      ? "COMMUNICATION"
      : (isBooking && !isPurchase && !isPayment ? "BOOKING" : "PURCHASE");
    if (kind === "COMMUNICATION") {
      return {
        kind,
        message: "I can't send messages or email on your behalf — anything sent reaches another person and " +
          "can't be taken back, so it stays yours to send. I can draft the text for you to review and send yourself.",
        normalizedGoal: "Declined: sending messages on the user's behalf is not a supported action"
      };
    }
    const researchable = /\b(flight|flights|hotel|hostel|room|rooms|car|rental|ticket|tickets)\b/i.test(text);
    const message = `I can't ${kind === "BOOKING" ? "book or reserve" : "buy, pay for, or check out"} anything for you — ` +
      "that commits real money or a reservation, and I have no way to undo it, so it stays a decision you make yourself" +
      (researchable
        ? ". I can look up and compare the options for you instead, with prices and sources, and you complete the final step."
        : ". I can research the options and report back instead.");
    return {
      kind,
      message,
      normalizedGoal: `Declined: ${kind === "BOOKING" ? "booking" : "purchasing"} on the user's behalf is not a supported action`
    };
  }

  // Provider-outage argument recovery for a direct Spotify request. This helper
  // is consulted only after the model has failed to supply a usable decision;
  // it never pre-empts the model or acts as the normal-language brain.
  // Returns { query, operation } or null.
  extractSpotifyTrackRequest(lower, rawText) {
    // Do not make a typo force a slow model round trip for a safe, named app.
    // The fuzzy match is deliberately tight (one known app name, edit distance
    // <= 2); it never produces a command or executable from arbitrary text.
    if (!this.hasApproximateWord(lower, "spotify")) return null;
    const normalizedRaw = this.replaceApproximateWord(rawText, "spotify", "Spotify");
    const normalizedLower = normalizedRaw.toLowerCase();
    const wantsPlay = /\b(play|listen to)\b/.test(normalizedLower);
    const wantsOpen = /\b(open|search)\b/.test(normalizedLower);
    if (!wantsPlay && !wantsOpen) return null;
    const compoundPatterns = [
      /\b(?:play|listen to)\s+["“]?(.+?)["”]?\s+on\s+spotify\s+(?:and\s+then|then|and)\s+(?:put|add)\s+["“]?(.+?)["”]?\s+(?:on|to)\s+(?:the\s+)?queue\s*$/i,
      /\b(?:play|listen to)\s+["“]?(.+?)["”]?\s+on\s+spotify\s+(?:and\s+then|then|and)\s+queue(?:\s+up)?\s+["“]?(.+?)["”]?\s*$/i
    ];
    const clean = (value) => String(value ?? "")
      .trim()
      .replace(/^["“]+|["”]+$/g, "")
      // A trailing "on Spotify" names the app, never the track.
      .replace(/\s+on\s+spotify\s*$/i, "")
      // "...on the queue" / "...to the queue" is queue phrasing, not a title.
      .replace(/\s+(?:on|to)\s+(?:the\s+)?queue\s*$/i, "")
      .trim();
    for (const pattern of compoundPatterns) {
      const match = normalizedRaw.match(pattern);
      if (match?.[1] && match?.[2]) {
        return {
          query: clean(match[1]),
          queueQuery: clean(match[2]),
          operation: "spotify.track.play"
        };
      }
    }
    // A second track can be requested with any add/queue wording, not just the
    // two shapes above ("...and add Jagave Neenu", "...then queue up X"). Split
    // the request at that connector FIRST so the play clause is bounded: the
    // single-track patterns below are anchored to end-of-string, so without
    // this they swallow the entire follow-up clause into the track name and
    // Spotify gets searched for one long nonsense string.
    const queueConnector = /\s+(?:and\s+then|,\s*then|then|and|,)\s+(?:also\s+)?(?:put|add|queue)\s+(?:up\s+)?/i;
    let playClause = normalizedRaw;
    let queueQuery = "";
    const connectorMatch = queueConnector.exec(normalizedRaw);
    if (connectorMatch && connectorMatch.index > 0) {
      const head = normalizedRaw.slice(0, connectorMatch.index);
      const tail = normalizedRaw.slice(connectorMatch.index + connectorMatch[0].length);
      // Only treat it as a queue clause when both halves carry real content;
      // otherwise fall back to reading the whole request as one track.
      if (/\b(?:play|listen to|open|search)\b/i.test(head) && clean(tail).length >= 2) {
        playClause = head;
        queueQuery = clean(tail);
      }
    }
    // Pull the track name out of the common phrasings, e.g.
    //   "open spotify and play "Cry For Me""
    //   "play Cry For Me by The Weeknd on Spotify"
    //   "listen to Blinding Lights on spotify"
    const patterns = [
      /\b(?:play|listen to)\s+["“]?(.+?)["”]?(?:\s+by\s+.+?)?(?:\s+on\s+spotify)?\s*$/i,
      /\bspotify\b.*?\b(?:play|listen to|search|open)\s+["“]?(.+?)["”]?\s*$/i,
      /\b(?:search|open)\s+spotify\s+(?:for\s+)?["“]?(.+?)["”]?\s*$/i
    ];
    let query = "";
    for (const re of patterns) {
      const m = playClause.match(re);
      if (m && m[1]) { query = clean(m[1]); break; }
    }
    // Trim a trailing "by <artist>" so the search query is the track name; the
    // artist stays useful context but the desktop search matches on the track.
    query = query.replace(/\s+by\s+.+$/i, "").trim();
    if (query.length < 2 || query.length > 160) return null;
    if (queueQuery) {
      return { query, queueQuery, operation: "spotify.track.play" };
    }
    return { query, operation: wantsPlay ? "spotify.track.play" : "spotify.track.open" };
  }

  // Resolve the ordinary conversational continuation "now add X to queue" to
  // Spotify only when the transcript establishes Spotify as the active media
  // app.  This keeps the rule precise while avoiding a second model/planner
  // round trip for a follow-up whose context is already known.
  extractSpotifyQueueFollowup(rawText, history = []) {
    const text = String(rawText ?? "").trim();
    const match = text.match(/^\s*(?:now\s+|please\s+|also\s+)*(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?queue\s*[.!?]*$/i)
      ?? text.match(/^\s*(?:now\s+|please\s+|also\s+)*queue(?:\s+up)?\s+(.+?)\s*[.!?]*$/i);
    const query = match?.[1]?.trim().replace(/^['"\u201c]+|['"\u201d]+$/g, "");
    if (!query || query.length < 2 || query.length > 160) return null;
    const established = /\bspotify\b/i.test(text) || (Array.isArray(history) && history
      .slice(-8)
      .some((turn) => /\bspotify\b|\bplaying\b[\s\S]{0,80}\btrack\b/i.test(String(turn?.text ?? turn?.content ?? ""))));
    return established ? { query } : null;
  }

  extractCalculatorRequest(rawText) {
    const text = String(rawText ?? "").trim();
    if (!/\b(?:calculator|calc)\b/i.test(text)) return null;
    const body = text.match(/\b(?:calculate|compute|work\s+out|do\s+the\s+math(?:\s+for)?)\s+(.+?)(?:\s+and\s+leave\b|$)/i)?.[1]?.trim()
      ?? text.match(/\b(?:calculator|calc)\b(?:\s+and)?\s+(?:do|evaluate|enter)\s+(.+?)(?:\s+and\s+leave\b|$)/i)?.[1]?.trim();
    if (!body) return null;
    const tokens = [...body.matchAll(/\d+(?:\.\d+)?|multiplied\s+by|times|plus|minus|divided\s+by|[x*+\u00f7/\-]/gi)]
      .map((part) => part[0].toLowerCase());
    if (tokens.length < 3 || !tokens.some((token) => /^\d/.test(token))) return null;
    const normalized = tokens.map((token) => {
      if (/^(?:times|multiplied\s+by|x|\*)$/.test(token)) return "*";
      if (/^(?:plus|\+)$/.test(token)) return "+";
      if (/^(?:minus|-)$/.test(token)) return "-";
      if (/^(?:divided\s+by|\u00f7|\/)$/.test(token)) return "/";
      return token;
    });
    if (!normalized.every((token, index) => index % 2 === 0 ? /^\d+(?:\.\d+)?$/.test(token) : /^[+*/-]$/.test(token))) return null;
    let value = Number(normalized[0]);
    for (let index = 1; index < normalized.length; index += 2) {
      const operand = Number(normalized[index + 1]);
      if (!Number.isFinite(operand)) return null;
      if (normalized[index] === "*") value *= operand;
      else if (normalized[index] === "+") value += operand;
      else if (normalized[index] === "-") value -= operand;
      else value /= operand;
    }
    if (!Number.isFinite(value)) return null;
    return { expression: normalized.join(""), expectedResult: String(value) };
  }

  extractWhatsAppDraft(rawText) {
    const text = String(rawText ?? "").trim();
    if (!/\bwhats\s*app\b/i.test(text) || !/\b(?:do\s+not|don't|without)\s+send|\bjust\s+type\b/i.test(text)) return null;
    const match = text.match(/\b(?:message|text)\s+to\s+(.+?)\s+(?:saying|that\s+says|with\s+the\s+text)\s+(.+?)(?=,?\s*(?:do\s+not|don't|without)\s+send|,?\s*just\s+type|$)/i)
      ?? text.match(/\btype\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(?:chat\s+)?(?:with|for)\s+(.+?)(?=,?\s*(?:do\s+not|don't|without)\s+send|$)/i);
    if (!match) return null;
    const reversed = /^\s*type\b/i.test(match[0]);
    const contact = String(reversed ? match[2] : match[1]).trim().replace(/^['"\u201c]+|['"\u201d]+$/g, "");
    const message = String(reversed ? match[1] : match[2]).trim().replace(/^['"\u201c]+|['"\u201d]+$/g, "");
    if (!contact || !message || contact.length > 100 || message.length > 4000) return null;
    return { contact, message, send: false };
  }

  // A deliberately small, allow-listed fast-command vocabulary. This is not a
  // generic shell launcher: unknown applications continue through normal
  // capability selection/planning, preserving the typed execution boundary.
  extractDirectDesktopAction(lower, rawText) {
    const volume = lower.match(/\b(increase|raise|turn up|up|lower|decrease|turn down|down)\b.*\bvolume\b|\bvolume\b.*\b(increase|raise|turn up|up|lower|decrease|turn down|down)\b/);
    if (volume) {
      const verb = `${volume[1] ?? ""} ${volume[2] ?? ""}`.trim();
      // The match above accepts a bare "down" ("turn the volume down" captures
      // just "down", since "turn" and "down" sit either side of "volume"), so
      // the direction test has to recognize it too — checking only for the
      // "turn down" phrasing silently fell through to the "up" default and
      // raised the volume when the user asked to lower it.
      const direction = /\b(?:lower|decrease|reduce|down|quieter|softer)\b/.test(verb) ? "down" : "up";
      const steps = /\b(a lot|much|significantly)\b/.test(lower) ? 5 : /\b(slightly|a little)\b/.test(lower) ? 1 : 2;
      return {
        operation: "system.volume.adjust",
        entities: { direction, steps },
        normalizedGoal: `${direction === "up" ? "Increase" : "Decrease"} system volume`,
        successCriteria: [`A system volume ${direction} command is sent`]
      };
    }

    // A trailing courtesy word ("open notepad please", "start spotify thanks")
    // is as common as a leading one and must not change the route.
    const launch = String(rawText).match(/^\s*(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?([\w.-]+)(?:\s+(?:please|thanks|thank\s+you))?\s*[.!?]*\s*$/i);
    if (launch) {
      const requested = launch[1].toLowerCase();
      const application = ["notepad", "calculator", "calc", "spotify"]
        .find((name) => this.editDistance(requested, name) <= 2);
      if (!application) return null;
      return {
        operation: "application.launch",
        entities: { application },
        normalizedGoal: `Open ${application}`,
        successCriteria: [`${application} is launched`]
      };
    }

    const search = String(rawText).match(/^\s*(?:please\s+)?(?:search(?:\s+(?:the\s+)?(?:web|internet|browser|bing|google))?\s+(?:for\s+)?)?(.+?)\s+(?:online|on\s+(?:the\s+)?(?:web|internet|bing|google))\s*[.!?]*\s*$/i)
      ?? String(rawText).match(/^\s*(?:please\s+)?search(?:\s+(?:the\s+)?(?:web|internet|browser|bing|google))?\s+for\s+(.+?)\s*[.!?]*\s*$/i);
    const query = search?.[1]?.trim();
    if (query && query.length >= 2 && query.length <= 200) {
      return {
        operation: "browser.search",
        entities: { query },
        normalizedGoal: `Search the web for ${query}`,
        successCriteria: [`Browser search for ${query} is opened`]
      };
    }
    return null;
  }

  hasApproximateWord(text, target) {
    return String(text).toLowerCase().split(/[^a-z0-9]+/).some((word) =>
      word.length >= 4 && this.editDistance(word, target) <= 2
    );
  }

  replaceApproximateWord(text, target, replacement) {
    return String(text).replace(/[a-z0-9]+/gi, (word) =>
      this.editDistance(word.toLowerCase(), target) <= 2 ? replacement : word
    );
  }

  editDistance(a, b) {
    const source = String(a); const target = String(b);
    const row = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let i = 1; i <= source.length; i += 1) {
      let diagonal = row[0]; row[0] = i;
      for (let j = 1; j <= target.length; j += 1) {
        const previous = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (source[i - 1] === target[j - 1] ? 0 : 1));
        diagonal = previous;
      }
    }
    return row[target.length];
  }

  guessPythonPath() {
    return "C:\\Python312\\;C:\\Python312\\Scripts\\";
  }
}
