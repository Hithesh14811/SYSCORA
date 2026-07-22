import {
  PolicyEffect,
  RiskLevel,
  RiskDimension,
  ConfirmationLevel,
  PolicyOutcome,
  CONFIRMATION_LEVEL_ORDER,
  confirmationLevelToEffect,
  maxConfirmationLevel,
  completeRiskDimensions
} from "../../shared-types/src/domain.js";

// Which control mechanisms are actually wired in this runtime. A required
// control whose mechanism is absent must FAIL CLOSED (PolicyOutcome
// REQUIRED_CONTROL_UNAVAILABLE) rather than silently degrade to a weaker
// control. CONFIRM and AUDIT are always available (ask the user / write the
// audit trail). ELEVATE availability is injected (true only when the privileged
// helper + approval-token flow is wired). SANDBOX and REAUTHENTICATE have no
// mechanism in this build, so they default to unavailable.
export const DEFAULT_CONTROL_AVAILABILITY = Object.freeze({
  [ConfirmationLevel.NONE]: true,
  [ConfirmationLevel.AUDIT]: true,
  [ConfirmationLevel.CONFIRM]: true,
  [ConfirmationLevel.REAUTHENTICATE]: false,
  [ConfirmationLevel.ELEVATE]: false,
  [ConfirmationLevel.SANDBOX]: false,
  [ConfirmationLevel.DENY]: true
});

export class PolicyEngine {
  // controlAvailability may be overridden at construction (runtime-factory sets
  // ELEVATE true when a privileged helper is wired) or per-call via options.
  constructor({ controlAvailability = {} } = {}) {
    this.controlAvailability = { ...DEFAULT_CONTROL_AVAILABILITY, ...controlAvailability };
  }

  // decide(riskAssessment, plan, options?)
  //   options.capabilities        - array of normalized capabilities for the plan
  //                                 (carry the authoritative riskProfile). Used to
  //                                 read privilege/execution floors per task.
  //   options.controlAvailability - per-call override of wired mechanisms.
  //   options.context             - runtime context (freshness/uncertainty).
  //
  // Returns a decision carrying BOTH the rich ConfirmationLevel (authoritative)
  // and the legacy `effect` (derived, for back-compat with the broker/runtime).
  decide(riskAssessment, plan, options = {}) {
    const tasks = plan?.taskGraph?.tasks ?? [];
    const availability = { ...this.controlAvailability, ...(options.controlAvailability ?? {}) };

    const hasSupportedAction = tasks.some((task) =>
      Boolean(task.capability) ||
      Boolean(task.selectedCapability) ||
      ["EnvironmentVariableSetAction", "CommandExecutionAction", "ProcessStartAction"].includes(
        task.action?.actionType
      )
    );
    if (tasks.length === 0 || !hasSupportedAction) {
      return this._finalize(
        ConfirmationLevel.DENY,
        "Plan does not contain a recognized supported action or capability.",
        { riskAssessment, availability, reasons: ["No supported action or capability in plan."] }
      );
    }

    const dimensions = completeRiskDimensions(riskAssessment?.dimensions ?? {});
    const overallRisk = riskAssessment?.overallRisk ?? RiskLevel.MEDIUM;
    const uncertainty = riskAssessment?.uncertainty ?? 0;
    // The built-in WinGet install capability pins every command to the signed
    // `winget` community source and accepts only an exact package id. This is a
    // trusted-source install, unlike an arbitrary downloaded installer. Keep
    // confirmation for third-party/install-from-URL capabilities, but permit
    // this one bounded install when it is the whole requested operation.
    const trustedWingetInstall = tasks.length === 1 && tasks[0]?.capability === "package.winget.install";

    // Independent control rules. Each proposes the MINIMUM control it requires;
    // the decision takes the STRONGEST across all of them (controls only ever
    // escalate — maxConfirmationLevel guarantees monotonicity).
    let level = ConfirmationLevel.NONE;
    const reasons = [];
    const requiredControls = [];
    const raise = (candidate, why) => {
      const next = maxConfirmationLevel(level, candidate);
      if (CONFIRMATION_LEVEL_ORDER[candidate] > CONFIRMATION_LEVEL_ORDER[ConfirmationLevel.NONE]) {
        requiredControls.push({ control: candidate, why });
        reasons.push(why);
      }
      level = next;
    };

    // Rule 1 — untrusted/critical code execution is hard-denied.
    if (dimensions[RiskDimension.EXECUTION_RISK] === "UNTRUSTED_EXECUTION" || overallRisk === RiskLevel.CRITICAL) {
      raise(ConfirmationLevel.DENY, "Untrusted or critical-risk execution is not permitted.");
    }

    // Rule 2 — privileged operations require ELEVATE (bounded privileged helper).
    const privilege = dimensions[RiskDimension.PRIVILEGE];
    if (privilege === "ELEVATED" || privilege === "ADMINISTRATOR") {
      raise(ConfirmationLevel.ELEVATE, `Operation requires ${privilege} privilege via the bounded helper.`);
    }

    // Rule 3 — irreversible / destructive mutation without verified rollback
    // requires explicit informed confirmation. Conflicting state on a
    // destructive op is denied (we cannot reason about the target safely).
    const mutation = dimensions[RiskDimension.MUTATION_IMPACT];
    const reversibility = dimensions[RiskDimension.REVERSIBILITY];
    const recovery = dimensions[RiskDimension.RECOVERY_CONFIDENCE];
    const stateCertainty = dimensions[RiskDimension.STATE_CERTAINTY];
    if (mutation === "DESTRUCTIVE" && stateCertainty === "CONFLICTING") {
      raise(ConfirmationLevel.DENY, "Destructive operation on conflicting/unresolved state is not permitted.");
    }
    if (mutation === "DESTRUCTIVE" || reversibility === "IRREVERSIBLE") {
      raise(ConfirmationLevel.CONFIRM, "Destructive or irreversible change requires explicit confirmation.");
    }
    if (!trustedWingetInstall && (mutation === "PERSISTENT" || reversibility === "PARTIALLY_REVERSIBLE") && recovery !== "VERIFIED_ROLLBACK") {
      raise(ConfirmationLevel.CONFIRM, "Persistent change without verified rollback requires confirmation.");
    }

    // Rule 4 — handling security-critical data requires confirmation.
    const dataSensitivity = dimensions[RiskDimension.DATA_SENSITIVITY];
    if (dataSensitivity === "SECURITY_CRITICAL") {
      raise(ConfirmationLevel.CONFIRM, "Operation touches security-critical data.");
    } else if (dataSensitivity === "CREDENTIAL" && mutation !== "READ_ONLY") {
      raise(ConfirmationLevel.CONFIRM, "Operation writes or moves credential-class data.");
    }

    // Rule 5 — untrusted external input driving a mutation requires confirmation.
    const inputTrust = dimensions[RiskDimension.INPUT_TRUST];
    if (inputTrust === "EXTERNAL_UNTRUSTED" && mutation !== "READ_ONLY") {
      raise(ConfirmationLevel.CONFIRM, "Mutation driven by untrusted external input requires confirmation.");
    }

    // Rule 6 — capability-declared explicit policy requirements (e.g. a plugin
    // that demands SANDBOX or REAUTHENTICATE). These are honoured as-is; if the
    // mechanism is not wired the decision fails closed (below).
    for (const capability of options.capabilities ?? []) {
      for (const requirement of capability?.risk?.policyRequirements ?? []) {
        if (CONFIRMATION_LEVEL_ORDER[requirement] !== undefined) {
          raise(requirement, `Capability ${capability.name ?? capability.capabilityId} requires ${requirement}.`);
        }
      }
    }

    // Rule 7 — high overall risk that has not already triggered a stronger
    // control still requires, at minimum, explicit confirmation. This is the
    // floor that replaces the old blanket "HIGH => DENY": high risk is allowed
    // to proceed, but never silently.
    if (overallRisk === RiskLevel.HIGH && !trustedWingetInstall) {
      raise(ConfirmationLevel.CONFIRM, "High-risk operation requires explicit confirmation.");
    } else if (overallRisk === RiskLevel.MEDIUM && !trustedWingetInstall) {
      raise(ConfirmationLevel.CONFIRM, "Medium-risk persistent operation requires confirmation.");
    }

    // Rule 8 — a decision made under high uncertainty is escalated to at least
    // AUDIT even if every known dimension looks benign, so an under-informed
    // "safe" verdict is never silently auto-run.
    if (level === ConfirmationLevel.NONE && uncertainty > 0.25) {
      raise(ConfirmationLevel.AUDIT, "Decision made under elevated uncertainty; auditing execution.");
    }

    let reason;
    if (level === ConfirmationLevel.NONE) reason = "Low-risk read-only operation permitted without confirmation.";
    else reason = reasons[reasons.length - 1] ?? "Operation requires additional control.";

    return this._finalize(level, reason, { riskAssessment, availability, reasons, requiredControls, dimensions });
  }

  // Resolve the confirmation level against wired mechanisms and attach an
  // informed-approval descriptor. If the required control's mechanism is not
  // available, the outcome is REQUIRED_CONTROL_UNAVAILABLE (fail closed) — the
  // control is NEVER downgraded to a weaker one that happens to be available.
  _finalize(level, reason, meta = {}) {
    const availability = meta.availability ?? this.controlAvailability;
    let outcome;
    if (level === ConfirmationLevel.DENY) {
      outcome = PolicyOutcome.BLOCKED;
    } else if (availability[level] === false) {
      outcome = PolicyOutcome.REQUIRED_CONTROL_UNAVAILABLE;
    } else {
      outcome = PolicyOutcome.PROCEED;
    }

    const decision = {
      // Legacy field: still the gate the PermissionBroker + runtime read today.
      // A required-but-unavailable control maps to DENY so it fails closed.
      effect: outcome === PolicyOutcome.REQUIRED_CONTROL_UNAVAILABLE
        ? PolicyEffect.DENY
        : confirmationLevelToEffect(level),
      confirmationLevel: level,
      outcome,
      reason: outcome === PolicyOutcome.REQUIRED_CONTROL_UNAVAILABLE
        ? `${reason} Required control ${level} is unavailable in this runtime; failing closed.`
        : reason,
      reasons: meta.reasons ?? [],
      requiredControls: meta.requiredControls ?? [],
      informedApproval: this._describeApproval(level, meta),
      riskLevel: meta.riskAssessment?.overallRisk ?? null,
      uncertainty: meta.riskAssessment?.uncertainty ?? 0
    };
    return decision;
  }

  // Build a structured descriptor of what the user is being asked to approve,
  // so approval is INFORMED rather than a blind yes. Surfaces the dimensions
  // that actually drove the decision plus the mitigations already identified.
  _describeApproval(level, meta) {
    if (level === ConfirmationLevel.NONE || level === ConfirmationLevel.AUDIT) return null;
    const dimensions = meta.dimensions ?? completeRiskDimensions(meta.riskAssessment?.dimensions ?? {});
    return {
      requiredControl: level,
      riskLevel: meta.riskAssessment?.overallRisk ?? null,
      whatItDoes: (meta.reasons ?? []).slice(),
      blastRadius: dimensions[RiskDimension.BLAST_RADIUS],
      reversibility: dimensions[RiskDimension.REVERSIBILITY],
      recoveryConfidence: dimensions[RiskDimension.RECOVERY_CONFIDENCE],
      privilege: dimensions[RiskDimension.PRIVILEGE],
      mitigations: meta.riskAssessment?.mitigations ?? []
    };
  }

  // Authorization for control intents (pause / resume / cancel). Unchanged
  // semantics: pure state-legality check, not risk-routed. Now also carries a
  // confirmationLevel/outcome for a uniform decision shape.
  decideControl(command, session) {
    const TERMINAL = ["COMPLETED", "FAILED", "ROLLED_BACK", "CANCELLED"];
    const state = session?.currentState;
    const known = ["pause", "resume", "cancel"];

    const deny = (reason) => ({
      effect: PolicyEffect.DENY,
      confirmationLevel: ConfirmationLevel.DENY,
      outcome: PolicyOutcome.BLOCKED,
      reason
    });
    const allow = (reason) => ({
      effect: PolicyEffect.ALLOW,
      confirmationLevel: ConfirmationLevel.NONE,
      outcome: PolicyOutcome.PROCEED,
      reason
    });

    if (!known.includes(command)) return deny(`Unknown control command: ${command}.`);
    if (TERMINAL.includes(state)) return deny(`Session is in terminal state ${state}; ${command} is not permitted.`);
    if (command === "resume" && state !== "PAUSED") {
      return deny(`Only a PAUSED session can be resumed (current state ${state}).`);
    }
    return allow(`Control command ${command} authorized from state ${state}.`);
  }
}
