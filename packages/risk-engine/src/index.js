import {
  RiskLevel,
  RiskDimension,
  RiskScale,
  RISK_DIMENSION_DEFAULT,
  riskDimensionRank,
  riskDimensionSeverity,
  maxRiskValue,
  completeRiskDimensions
} from "../../shared-types/src/domain.js";

const RISK_ORDER = {
  [RiskLevel.LOW]: 1,
  [RiskLevel.MEDIUM]: 2,
  [RiskLevel.HIGH]: 3,
  [RiskLevel.CRITICAL]: 4
};

function higherLevel(a, b) {
  return (RISK_ORDER[a] ?? 0) >= (RISK_ORDER[b] ?? 0) ? a : b;
}

// Deterministic per-dimension contribution to overall risk. Each dimension
// value maps to the MINIMUM RiskLevel it can justify; overall risk is the MAX
// contribution across every dimension. This is a pure lookup — no model, no
// randomness, no caller-tunable weights — so the same assessment always yields
// the same level. UNKNOWN-equivalents contribute MEDIUM (never LOW) and also
// raise the uncertainty score, honouring "unknown fails conservatively".
const DIMENSION_CONTRIBUTION = Object.freeze({
  [RiskDimension.REVERSIBILITY]: {
    FULLY_REVERSIBLE: RiskLevel.LOW,
    PARTIALLY_REVERSIBLE: RiskLevel.MEDIUM,
    IRREVERSIBLE: RiskLevel.HIGH,
    UNKNOWN: RiskLevel.MEDIUM
  },
  [RiskDimension.BLAST_RADIUS]: {
    SINGLE_RESOURCE: RiskLevel.LOW,
    PROJECT: RiskLevel.LOW,
    USER_ACCOUNT: RiskLevel.MEDIUM,
    SYSTEM_WIDE: RiskLevel.HIGH,
    EXTERNAL_SYSTEM: RiskLevel.HIGH
  },
  [RiskDimension.PRIVILEGE]: {
    STANDARD_USER: RiskLevel.LOW,
    ELEVATED: RiskLevel.HIGH,
    ADMINISTRATOR: RiskLevel.HIGH
  },
  [RiskDimension.DATA_SENSITIVITY]: {
    PUBLIC: RiskLevel.LOW,
    USER_DATA: RiskLevel.LOW,
    CONFIDENTIAL: RiskLevel.MEDIUM,
    CREDENTIAL: RiskLevel.MEDIUM,
    SECURITY_CRITICAL: RiskLevel.HIGH
  },
  [RiskDimension.MUTATION_IMPACT]: {
    READ_ONLY: RiskLevel.LOW,
    TEMPORARY: RiskLevel.LOW,
    PERSISTENT: RiskLevel.MEDIUM,
    DESTRUCTIVE: RiskLevel.HIGH
  },
  [RiskDimension.EXECUTION_RISK]: {
    NO_EXECUTION: RiskLevel.LOW,
    TRUSTED_EXECUTABLE: RiskLevel.MEDIUM,
    PACKAGE_INSTALL: RiskLevel.HIGH,
    SCRIPT_EXECUTION: RiskLevel.HIGH,
    UNTRUSTED_EXECUTION: RiskLevel.CRITICAL
  },
  [RiskDimension.EXTERNAL_EFFECT]: {
    LOCAL_ONLY: RiskLevel.LOW,
    NETWORK_READ: RiskLevel.LOW,
    EXTERNAL_MUTATION: RiskLevel.MEDIUM,
    COMMUNICATION: RiskLevel.MEDIUM,
    FINANCIAL_OR_SECURITY: RiskLevel.HIGH
  },
  [RiskDimension.PERSISTENCE]: {
    EPHEMERAL: RiskLevel.LOW,
    SESSION: RiskLevel.LOW,
    USER_PERSISTENT: RiskLevel.MEDIUM,
    SYSTEM_PERSISTENT: RiskLevel.HIGH
  },
  [RiskDimension.RECOVERY_CONFIDENCE]: {
    VERIFIED_ROLLBACK: RiskLevel.LOW,
    BEST_EFFORT_ROLLBACK: RiskLevel.MEDIUM,
    NO_ROLLBACK: RiskLevel.MEDIUM,
    UNKNOWN: RiskLevel.MEDIUM
  },
  [RiskDimension.INPUT_TRUST]: {
    INTERNAL: RiskLevel.LOW,
    VALIDATED_USER_INPUT: RiskLevel.LOW,
    MODEL_DERIVED: RiskLevel.MEDIUM,
    EXTERNAL_UNTRUSTED: RiskLevel.HIGH
  },
  [RiskDimension.STATE_CERTAINTY]: {
    FRESH_VERIFIED: RiskLevel.LOW,
    STALE: RiskLevel.MEDIUM,
    INCOMPLETE: RiskLevel.MEDIUM,
    CONFLICTING: RiskLevel.HIGH
  }
});

// Dimension values that represent genuine uncertainty (as opposed to known
// danger). Presence of any of these raises the uncertainty score so policy can
// treat the decision as less-certain and fail conservatively.
const UNCERTAIN_VALUES = new Set(["UNKNOWN", "STALE", "INCOMPLETE", "CONFLICTING", "MODEL_DERIVED", "EXTERNAL_UNTRUSTED"]);

// The stages a browser workflow moves through. Reading and preparing are cheap
// and reversible; entering credentials or payment details and submitting are
// not. Keeping them as distinct named stages is what lets research proceed
// freely while the two consequential stages always stop for the user.
export const BrowserStage = Object.freeze({
  RESEARCH: "RESEARCH",
  SELECTION: "SELECTION",
  FORM_PREPARATION: "FORM_PREPARATION",
  SENSITIVE_DATA_ENTRY: "SENSITIVE_DATA_ENTRY",
  CONSEQUENTIAL_SUBMISSION: "CONSEQUENTIAL_SUBMISSION",
  CONFIRMATION_VERIFICATION: "CONFIRMATION_VERIFICATION"
});

export class RiskEngine {
  // The registry is optional. When present, the authoritative per-capability
  // risk floor (capability.riskProfile) is read from it; runtime context may
  // only raise those dimensions. When absent (lightweight/legacy callers), the
  // engine derives a conservative profile from the task/plan shape alone.
  constructor({ capabilityRegistry = null } = {}) {
    this.capabilityRegistry = capabilityRegistry;
  }

  // context may be legacy ({ currentEnvironment: { exists } }) or canonical
  // (an array/collection of context items from ContextEngine). Both are read
  // as EVIDENCE that can only raise risk; nothing here lowers a floor.
  //
  // options.evaluatedAt is the EXPLICIT evaluation time (epoch ms or ISO string)
  // against which context freshness is judged. It must be supplied by the caller
  // so the assessment is deterministic and reproducible for a fixed
  // (plan, context, capability contracts, evaluatedAt). When omitted the engine
  // falls back to wall-clock time (legacy/direct callers), but the production
  // runtime always passes it and records it on the assessment.
  assess(plan, context, options = {}) {
    const tasks = plan?.taskGraph?.tasks ?? [];
    const evaluatedAtMs = this._resolveEvaluatedAt(options.evaluatedAt);

    const modifiesExistingEnvFile = this._detectExistingEnv(context);
    const contextPresent = this._contextPresent(context);
    const contextStale = this._contextStale(context, evaluatedAtMs);

    let containsSensitiveValue = false;
    let hintRisk = RiskLevel.LOW;

    // Start every dimension at its most-benign value; each task raises it.
    let merged = {};
    for (const dimension of Object.values(RiskDimension)) {
      merged[dimension] = RiskScale[dimension][0];
    }

    const reasons = [];
    const perTaskProfiles = [];

    for (const task of tasks) {
      // 1. Capability-declared floor (authoritative). Never lowered below this.
      const capability = this._resolveCapability(task);
      const floor = completeRiskDimensions(capability?.riskProfile ?? {});

      // 2. Runtime evidence — raise-only refinements for THIS task.
      const evidence = { ...floor };

      // Sensitive key/value in inputs raises data sensitivity to CREDENTIAL.
      const key = task?.action?.parameters?.key ?? task?.inputs?.key ?? "";
      const value = task?.action?.parameters?.value ?? task?.inputs?.value ?? "";
      if (/(token|secret|password|key|credential)/i.test(String(key)) || /(token|secret|password|credential)/i.test(String(value))) {
        containsSensitiveValue = true;
        evidence[RiskDimension.DATA_SENSITIVITY] = maxRiskValue(
          RiskDimension.DATA_SENSITIVITY, evidence[RiskDimension.DATA_SENSITIVITY], "CREDENTIAL"
        );
        reasons.push({ dimension: RiskDimension.DATA_SENSITIVITY, value: "CREDENTIAL", why: `Task references a sensitive key/value (${key || "value"}).` });
      }

      // Browser interactions carry real exfiltration / unintended-action risk.
      // Read-only navigation and extraction stay MEDIUM (declared on the
      // capability), but interacting with a control whose own label says it
      // submits, buys, sends or deletes is a consequential external effect.
      // Classified from the SAME verb vocabulary used for OS actions, and, like
      // every other rule here, raise-only.
      const consequential = this._detectConsequentialBrowserAction(task);
      if (consequential) {
        evidence[RiskDimension.EXTERNAL_EFFECT] = maxRiskValue(
          RiskDimension.EXTERNAL_EFFECT, evidence[RiskDimension.EXTERNAL_EFFECT], consequential.externalEffect
        );
        evidence[RiskDimension.MUTATION_IMPACT] = maxRiskValue(
          RiskDimension.MUTATION_IMPACT, evidence[RiskDimension.MUTATION_IMPACT], "PERSISTENT"
        );
        reasons.push({
          dimension: RiskDimension.EXTERNAL_EFFECT,
          value: consequential.externalEffect,
          why: `Browser interaction targets a consequential control (${consequential.matched}); ` +
            "submitting, purchasing, sending or deleting through a page is an external effect " +
            "this runtime cannot roll back."
        });
      }

      // Entering credentials, payment instruments or government identifiers into
      // a page transmits data this runtime cannot recall. It is a financial or
      // security effect in its own right, independent of whether the eventual
      // submit button happens to be worded consequentially.
      const browserStage = this.classifyBrowserStage(task);
      if (browserStage === BrowserStage.SENSITIVE_DATA_ENTRY) {
        evidence[RiskDimension.EXTERNAL_EFFECT] = maxRiskValue(
          RiskDimension.EXTERNAL_EFFECT, evidence[RiskDimension.EXTERNAL_EFFECT], "FINANCIAL_OR_SECURITY"
        );
        evidence[RiskDimension.DATA_SENSITIVITY] = maxRiskValue(
          RiskDimension.DATA_SENSITIVITY, evidence[RiskDimension.DATA_SENSITIVITY], "SECRET"
        );
        reasons.push({
          dimension: RiskDimension.EXTERNAL_EFFECT,
          value: "FINANCIAL_OR_SECURITY",
          why: "Browser interaction enters credential, payment or identity data into a page; " +
            "transmitted secrets cannot be withdrawn once sent."
        });
      }

      // Writing over an existing file is at least a persistent mutation.
      if (modifiesExistingEnvFile) {
        evidence[RiskDimension.MUTATION_IMPACT] = maxRiskValue(RiskDimension.MUTATION_IMPACT, evidence[RiskDimension.MUTATION_IMPACT], "PERSISTENT");
        reasons.push({ dimension: RiskDimension.MUTATION_IMPACT, value: evidence[RiskDimension.MUTATION_IMPACT], why: "Operation modifies an existing environment file." });
      }

      // Input trust: model-derived plans are less trusted than internally built
      // ones; explicitly-flagged external content is least trusted. This RAISES
      // the inputTrust dimension — it can never be used to claim MORE trust.
      const inputTrust = this._deriveInputTrust(task, plan);
      evidence[RiskDimension.INPUT_TRUST] = maxRiskValue(RiskDimension.INPUT_TRUST, evidence[RiskDimension.INPUT_TRUST], inputTrust);

      // State certainty: stale/missing context degrades certainty (raise-only).
      if (contextStale) {
        evidence[RiskDimension.STATE_CERTAINTY] = maxRiskValue(RiskDimension.STATE_CERTAINTY, evidence[RiskDimension.STATE_CERTAINTY], "STALE");
      }
      if (!contextPresent && this._taskMutates(evidence)) {
        // A mutating task assessed with NO context evidence is incomplete.
        evidence[RiskDimension.STATE_CERTAINTY] = maxRiskValue(RiskDimension.STATE_CERTAINTY, evidence[RiskDimension.STATE_CERTAINTY], "INCOMPLETE");
      }

      // 3. Caller/model risk hint may only RAISE the coarse floor, never lower.
      // This is the anti-downgrade guarantee for the legacy hint field: a plan
      // that claims "LOW" for a MEDIUM/HIGH capability is ignored downward.
      const hint = task?.riskHints ?? task?.riskEstimate ?? task?.action?.riskLevel;
      if (hint && RISK_ORDER[hint] > RISK_ORDER[hintRisk]) hintRisk = hint;

      perTaskProfiles.push(evidence);

      // Merge into the plan-wide worst-case (riskiest value per dimension).
      for (const dimension of Object.values(RiskDimension)) {
        merged[dimension] = maxRiskValue(dimension, merged[dimension], evidence[dimension]);
      }
    }

    // Aggregate: overall risk is the MAX per-dimension contribution.
    let dimensionLevel = RiskLevel.LOW;
    const contributingReasons = [];
    for (const dimension of Object.values(RiskDimension)) {
      const value = merged[dimension];
      const contribution = DIMENSION_CONTRIBUTION[dimension]?.[value] ?? RiskLevel.MEDIUM;
      if (RISK_ORDER[contribution] > RISK_ORDER[dimensionLevel]) dimensionLevel = contribution;
      if (contribution !== RiskLevel.LOW && value !== RISK_DIMENSION_DEFAULT[dimension]) {
        contributingReasons.push({ dimension, value, contribution });
      }
    }

    // Anti-downgrade: overall risk is the strongest of the dimensional
    // aggregate and the (raise-only) caller/model hint. The hint can lift risk
    // but the dimensional floor sets the minimum — a LOW hint never lowers it.
    const overallRisk = higherLevel(dimensionLevel, hintRisk);

    // Uncertainty ∈ [0,1]: fraction of dimensions sitting on an uncertain value.
    const dims = Object.values(RiskDimension);
    const uncertainCount = dims.filter((d) => UNCERTAIN_VALUES.has(merged[d])).length;
    const uncertainty = Number((uncertainCount / dims.length).toFixed(3));

    // Score ∈ [0,1]: mean normalized severity across dimensions (a smooth
    // magnitude alongside the discrete overallRisk level).
    const score = Number(
      (dims.reduce((sum, d) => sum + riskDimensionSeverity(d, merged[d]), 0) / dims.length).toFixed(3)
    );

    const mitigations = this._mitigations(merged);

    return {
      overallRisk,
      score,
      dimensions: merged,
      // The explicit evaluation time this assessment was computed against, so a
      // decision is reproducible and the audit trail records exactly when
      // freshness was judged (M2.1 Part G).
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      reasons: [...reasons, ...contributingReasons.map((r) => ({
        dimension: r.dimension,
        value: r.value,
        why: `${r.dimension} = ${r.value} contributes ${r.contribution} risk.`
      }))],
      mitigations,
      uncertainty,
      contextEvidence: {
        contextPresent,
        contextStale,
        modifiesExistingEnvFile,
        containsSensitiveValue,
        highestRiskHint: hintRisk,
        taskCount: tasks.length
      },
      // Back-compat: existing callers/tests read `evidence` + these fields.
      evidence: {
        modifiesExistingEnvFile,
        containsSensitiveValue,
        highestRiskHint: hintRisk,
        taskCount: tasks.length
      }
    };
  }

  // Verbs that mark a page control as producing an irreversible external
  // effect. Deliberately matched against the control's OWN accessible label /
  // text / type, never against the user's phrasing, so a benign request cannot
  // be talked into a low tier and a dangerous button cannot hide behind one.
  // Graded by consequence, using the SAME externalEffect vocabulary as OS
  // actions: money/security first, then communication, then any other external
  // mutation. Ordered most-severe-first so the first match wins.
  static CONSEQUENTIAL_BROWSER_VERBS = Object.freeze([
    {
      externalEffect: "FINANCIAL_OR_SECURITY",
      pattern: /\b(buy|purchase|order|checkout|pay|payment|place\s+order|transfer|withdraw|deposit|subscribe|book\s+now|reserve)\b/i
    },
    {
      externalEffect: "COMMUNICATION",
      pattern: /\b(send|post|publish|reply|share|invite|message)\b/i
    },
    {
      externalEffect: "EXTERNAL_MUTATION",
      pattern: /\b(submit|confirm|delete|remove|destroy|sign\s+up|apply\s+now|save\s+changes|update)\b/i
    }
  ]);

  // Classify a browser task into its transactional stage. The stage is derived
  // ONLY from the capability and the control's own attributes — never from the
  // user's phrasing or the value being typed — so a benign-sounding request can
  // never lower the tier of a payment field or an order button.
  classifyBrowserStage(task) {
    const capability = String(task?.capability ?? task?.selectedCapability ?? "");
    if (!/^browser\./.test(capability)) return null;
    const inputs = task?.inputs ?? task?.action?.parameters ?? {};

    if (/^browser\.(read|extract|inspect|find|currentState|wait)$/.test(capability)) {
      return String(inputs.purpose ?? "").toLowerCase() === "confirmation"
        ? BrowserStage.CONFIRMATION_VERIFICATION
        : BrowserStage.RESEARCH;
    }
    if (/^browser\.(launch|navigate|research|search|media\.play)$/.test(capability)) {
      return BrowserStage.RESEARCH;
    }
    if (this._detectConsequentialBrowserAction(task)) {
      return BrowserStage.CONSEQUENTIAL_SUBMISSION;
    }
    if (/^browser\.(type|select)$/.test(capability)) {
      return RiskEngine.isSensitiveField(inputs.target ?? {})
        ? BrowserStage.SENSITIVE_DATA_ENTRY
        : BrowserStage.FORM_PREPARATION;
    }
    if (/^browser\.(click|download)$/.test(capability)) {
      return BrowserStage.SELECTION;
    }
    return BrowserStage.RESEARCH;
  }

  // A field that carries credentials, payment instruments or government
  // identifiers. Detected from the field's own type, autocomplete token, name,
  // id and visible label.
  static isSensitiveField(target = {}) {
    if (String(target.type ?? "").toLowerCase() === "password") return true;
    const autocomplete = String(target.autocomplete ?? "").toLowerCase();
    if (/\b(?:cc-(?:number|exp|exp-month|exp-year|csc|name)|current-password|new-password)\b/.test(autocomplete)) {
      return true;
    }
    const descriptor = [target.name, target.id, target.label, target.text, target.placeholder, target.ariaLabel]
      .filter((entry) => typeof entry === "string")
      .join(" ")
      .toLowerCase();
    return /\b(?:password|passcode|pin\b|card\s*number|cardnumber|credit\s*card|debit\s*card|cvv|cvc|csc|security\s*code|expiry|expiration|iban|swift|sort\s*code|routing\s*number|account\s*number|accountnumber|ssn|social\s*security|tax\s*id|passport|national\s*id|driver'?s?\s*licen[cs]e|date\s*of\s*birth)\b/
      .test(descriptor);
  }

  static browserStageRequiresConfirmation(stage) {
    return stage === BrowserStage.SENSITIVE_DATA_ENTRY || stage === BrowserStage.CONSEQUENTIAL_SUBMISSION;
  }

  _detectConsequentialBrowserAction(task) {
    const capability = String(task?.capability ?? task?.selectedCapability ?? "");
    if (!/^browser\.(click|type|select|download)$/.test(capability)) return null;
    const inputs = task?.inputs ?? task?.action?.parameters ?? {};
    const target = inputs.target ?? {};
    // Matched against the control's OWN label/type — never the user's phrasing —
    // so a benign request cannot talk a dangerous button into a lower tier.
    const label = [target.text, target.name, target.controlType, target.role, target.id, inputs.value]
      .filter((entry) => typeof entry === "string")
      .join(" ");
    for (const { externalEffect, pattern } of RiskEngine.CONSEQUENTIAL_BROWSER_VERBS) {
      const matched = label.match(pattern)?.[0];
      if (matched) return { matched, capability, externalEffect };
    }
    // A submit-typed control is consequential regardless of its wording.
    if (String(target.type ?? "").toLowerCase() === "submit") {
      return { matched: "submit-input", capability, externalEffect: "EXTERNAL_MUTATION" };
    }
    if (String(target.tag ?? "").toLowerCase() === "form") {
      return { matched: "form", capability, externalEffect: "EXTERNAL_MUTATION" };
    }
    return null;
  }

  _resolveCapability(task) {
    const name = task?.capability ?? task?.selectedCapability;
    if (!name || !this.capabilityRegistry?.get) return null;
    try {
      return this.capabilityRegistry.get(name) ?? null;
    } catch {
      return null;
    }
  }

  _deriveInputTrust(task, plan) {
    // Derive trust from provenance FIRST, then let a task only RAISE it. A task
    // cannot claim "INTERNAL" to escape a model-derived provenance: the derived
    // value is the floor and maxRiskValue keeps the riskier of the two.
    let derived = "INTERNAL";
    if (plan?.source === "model" || plan?.origin === "model" || task?.modelDerived === true) derived = "MODEL_DERIVED";
    if (task?.externalContent === true) derived = "EXTERNAL_UNTRUSTED";
    if (task?.inputTrust && RiskScale[RiskDimension.INPUT_TRUST].includes(task.inputTrust)) {
      derived = maxRiskValue(RiskDimension.INPUT_TRUST, derived, task.inputTrust);
    }
    return derived;
  }

  _taskMutates(dimensions) {
    return dimensions[RiskDimension.MUTATION_IMPACT] !== "READ_ONLY";
  }

  _mitigations(dimensions) {
    const out = [];
    if (dimensions[RiskDimension.MUTATION_IMPACT] !== "READ_ONLY") {
      out.push("Create a verified checkpoint before mutation.");
    }
    if (dimensions[RiskDimension.RECOVERY_CONFIDENCE] !== "VERIFIED_ROLLBACK") {
      out.push("Rollback is not guaranteed; confirm intent before proceeding.");
    }
    if (dimensions[RiskDimension.PRIVILEGE] !== "STANDARD_USER") {
      out.push("Requires privileged execution through the bounded helper.");
    }
    if (dimensions[RiskDimension.EXECUTION_RISK] !== "NO_EXECUTION") {
      out.push("Verify the executable/package source before running.");
    }
    out.push("Verify final state after execution.");
    return out;
  }

  _contextPresent(context) {
    if (!context) return false;
    if (Array.isArray(context)) return context.length > 0;
    if (context.items) return Array.isArray(context.items) && context.items.length > 0;
    if (context.currentEnvironment) return true;
    return Object.keys(context).length > 0;
  }

  // Resolve the explicit evaluation time to epoch ms. Accepts a number (epoch
  // ms), an ISO string, or undefined (falls back to wall clock for legacy/direct
  // callers). Freshness still legitimately varies with time — the point is that
  // time is an EXPLICIT, auditable input, not a hidden global read.
  _resolveEvaluatedAt(evaluatedAt) {
    if (typeof evaluatedAt === "number" && Number.isFinite(evaluatedAt)) return evaluatedAt;
    if (typeof evaluatedAt === "string") {
      const ms = new Date(evaluatedAt).getTime();
      if (Number.isFinite(ms)) return ms;
    }
    return Date.now();
  }

  // Stale iff any context item declares an age/freshness beyond a small bound,
  // measured against the EXPLICIT evaluation time (not a hidden Date.now()).
  _contextStale(context, evaluatedAtMs) {
    const items = Array.isArray(context) ? context : context?.items;
    if (!Array.isArray(items)) return false;
    const now = Number.isFinite(evaluatedAtMs) ? evaluatedAtMs : Date.now();
    for (const item of items) {
      if (item?.stale === true) return true;
      const ts = item?.observedAt ?? item?.timestamp;
      if (ts) {
        const age = now - new Date(ts).getTime();
        if (Number.isFinite(age) && age > 60_000) return true;
      }
    }
    return false;
  }

  _detectExistingEnv(context) {
    if (!context) return false;
    if (context.currentEnvironment && typeof context.currentEnvironment === "object") {
      return Boolean(context.currentEnvironment.exists);
    }
    const items = Array.isArray(context) ? context : context.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item?.type === "environment" && item?.data?.currentEnvironment?.exists) {
          return true;
        }
      }
    }
    return false;
  }
}
