import crypto from "node:crypto";

export const PROTOCOL_VERSION = "0.1.0";

export const RuntimeState = Object.freeze({
  RECEIVE_INTENT: "RECEIVE_INTENT",
  BUILD_CONTEXT: "BUILD_CONTEXT",
  GENERATE_PLAN: "GENERATE_PLAN",
  ASSESS_RISK: "ASSESS_RISK",
  APPLY_POLICY: "APPLY_POLICY",
  REQUEST_CONFIRMATION_IF_REQUIRED: "REQUEST_CONFIRMATION_IF_REQUIRED",
  EXECUTE_NEXT_ACTION: "EXECUTE_NEXT_ACTION",
  OBSERVE_RESULT: "OBSERVE_RESULT",
  VERIFY_RESULT: "VERIFY_RESULT",
  UPDATE_SEMANTIC_STATE: "UPDATE_SEMANTIC_STATE",
  UPDATE_MEMORY: "UPDATE_MEMORY",
  VERIFY_FINAL_GOAL: "VERIFY_FINAL_GOAL",
  GENERATE_RESPONSE: "GENERATE_RESPONSE",
  PAUSED: "PAUSED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ROLLED_BACK: "ROLLED_BACK",
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
  // States used by the canonical graph runtime (submitIntent).
  AMBIGUOUS_INTENT: "AMBIGUOUS_INTENT",
  VALIDATE_PLAN: "VALIDATE_PLAN",
  PLAN_REJECTED: "PLAN_REJECTED",
  EXECUTING: "EXECUTING",
  DIAGNOSING: "DIAGNOSING",
  RECOVERING: "RECOVERING",
  ROLLING_BACK: "ROLLING_BACK"
});

export const RiskLevel = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL"
});

export const PolicyEffect = Object.freeze({
  ALLOW: "ALLOW",
  CONFIRM: "CONFIRM",
  DENY: "DENY"
});

// The full control ladder a policy decision may require before an action runs.
// Ordered weakest -> strongest; a policy may only ever move UP this ladder as
// risk rises, never down. Each level has explicit semantics enforced by the
// PolicyEngine + PermissionBroker (see policy-engine/src/index.js):
//   NONE           - safe, runs with no extra interaction.
//   AUDIT          - runs automatically but MUST emit the declared audit evidence.
//   CONFIRM        - requires explicit, informed, operation-scoped user approval.
//   REAUTHENTICATE - requires fresh proof of user presence/identity.
//   ELEVATE        - requires privileged execution through the bounded helper.
//   SANDBOX        - requires isolated execution.
//   DENY           - must not execute.
export const ConfirmationLevel = Object.freeze({
  NONE: "NONE",
  AUDIT: "AUDIT",
  CONFIRM: "CONFIRM",
  REAUTHENTICATE: "REAUTHENTICATE",
  ELEVATE: "ELEVATE",
  SANDBOX: "SANDBOX",
  DENY: "DENY"
});

// Monotonic strength ordering for ConfirmationLevel. Used to take the STRONGEST
// required control across independent rules and to assert (in tests and at
// runtime) that a decision never weakens a required control. DENY is the
// strongest terminal control; SANDBOX/ELEVATE/REAUTH sit above CONFIRM because
// each demands a mechanism CONFIRM cannot substitute for.
export const CONFIRMATION_LEVEL_ORDER = Object.freeze({
  NONE: 0,
  AUDIT: 1,
  CONFIRM: 2,
  REAUTHENTICATE: 3,
  ELEVATE: 4,
  SANDBOX: 5,
  DENY: 6
});

// A policy decision's terminal disposition. Distinct from ConfirmationLevel so
// we can express "a control is required but the mechanism to satisfy it does
// not exist" WITHOUT silently downgrading to a weaker control.
//   PROCEED                     - the required control can be satisfied; continue.
//   BLOCKED                     - policy hard-denies (DENY level).
//   REQUIRED_CONTROL_UNAVAILABLE- the required control (SANDBOX/REAUTH/ELEVATE)
//                                 has no available mechanism; fail closed.
export const PolicyOutcome = Object.freeze({
  PROCEED: "PROCEED",
  BLOCKED: "BLOCKED",
  REQUIRED_CONTROL_UNAVAILABLE: "REQUIRED_CONTROL_UNAVAILABLE"
});

// Map a ConfirmationLevel onto the legacy PolicyEffect triad so existing callers
// (PermissionBroker.evaluate, runtime DENY gate, older tests) keep working while
// the richer ConfirmationLevel drives behavior. NONE/AUDIT need no interactive
// approval (ALLOW); DENY maps to DENY; everything in between requires approval
// of some kind (CONFIRM).
export function confirmationLevelToEffect(level) {
  if (level === ConfirmationLevel.DENY) return PolicyEffect.DENY;
  if (level === ConfirmationLevel.NONE || level === ConfirmationLevel.AUDIT) return PolicyEffect.ALLOW;
  return PolicyEffect.CONFIRM;
}

// Return the stronger of two confirmation levels (never the weaker). This is the
// only sanctioned way to combine control requirements, guaranteeing controls
// escalate monotonically.
export function maxConfirmationLevel(a, b) {
  const av = CONFIRMATION_LEVEL_ORDER[a] ?? -1;
  const bv = CONFIRMATION_LEVEL_ORDER[b] ?? -1;
  return av >= bv ? a : b;
}

// ---------------------------------------------------------------------------
// Structured, multi-dimensional risk taxonomy.
//
// Each dimension is an ORDERED scale (index = severity). Deterministic scoring
// (risk-engine) maps a dimension value to its index; the capability contract
// declares a BASELINE per dimension that runtime evidence may only raise. No
// enum here is optional-by-omission: an unset dimension resolves to UNKNOWN,
// which scores conservatively (never as "safe").
// ---------------------------------------------------------------------------

export const RiskDimension = Object.freeze({
  REVERSIBILITY: "reversibility",
  BLAST_RADIUS: "blastRadius",
  PRIVILEGE: "privilege",
  DATA_SENSITIVITY: "dataSensitivity",
  MUTATION_IMPACT: "mutationImpact",
  EXECUTION_RISK: "executionRisk",
  EXTERNAL_EFFECT: "externalEffect",
  PERSISTENCE: "persistence",
  RECOVERY_CONFIDENCE: "recoveryConfidence",
  INPUT_TRUST: "inputTrust",
  STATE_CERTAINTY: "stateCertainty"
});

// Ordered scales. Index within the array IS the severity rank (0 = least risk).
// UNKNOWN, where present, is deliberately placed at a HIGH rank so uncertainty
// is treated as dangerous, per the "fail conservatively" rule.
export const RiskScale = Object.freeze({
  reversibility: ["FULLY_REVERSIBLE", "PARTIALLY_REVERSIBLE", "IRREVERSIBLE", "UNKNOWN"],
  blastRadius: ["SINGLE_RESOURCE", "PROJECT", "USER_ACCOUNT", "SYSTEM_WIDE", "EXTERNAL_SYSTEM"],
  privilege: ["STANDARD_USER", "ELEVATED", "ADMINISTRATOR"],
  dataSensitivity: ["PUBLIC", "USER_DATA", "CONFIDENTIAL", "CREDENTIAL", "SECURITY_CRITICAL"],
  mutationImpact: ["READ_ONLY", "TEMPORARY", "PERSISTENT", "DESTRUCTIVE"],
  executionRisk: ["NO_EXECUTION", "TRUSTED_EXECUTABLE", "PACKAGE_INSTALL", "SCRIPT_EXECUTION", "UNTRUSTED_EXECUTION"],
  externalEffect: ["LOCAL_ONLY", "NETWORK_READ", "EXTERNAL_MUTATION", "COMMUNICATION", "FINANCIAL_OR_SECURITY"],
  persistence: ["EPHEMERAL", "SESSION", "USER_PERSISTENT", "SYSTEM_PERSISTENT"],
  recoveryConfidence: ["VERIFIED_ROLLBACK", "BEST_EFFORT_ROLLBACK", "NO_ROLLBACK", "UNKNOWN"],
  inputTrust: ["INTERNAL", "VALIDATED_USER_INPUT", "MODEL_DERIVED", "EXTERNAL_UNTRUSTED"],
  stateCertainty: ["FRESH_VERIFIED", "STALE", "INCOMPLETE", "CONFLICTING"]
});

// The conservative default for every dimension when a capability/context does
// not declare it. Chosen so an undeclared dimension is treated as risky, never
// safe. Recovery/state/input default to their UNKNOWN-equivalent worst rank.
export const RISK_DIMENSION_DEFAULT = Object.freeze({
  reversibility: "UNKNOWN",
  blastRadius: "SINGLE_RESOURCE",
  privilege: "STANDARD_USER",
  dataSensitivity: "USER_DATA",
  mutationImpact: "READ_ONLY",
  executionRisk: "NO_EXECUTION",
  externalEffect: "LOCAL_ONLY",
  persistence: "EPHEMERAL",
  recoveryConfidence: "UNKNOWN",
  inputTrust: "INTERNAL",
  stateCertainty: "FRESH_VERIFIED"
});

// Severity rank (0-based index) of a dimension value on its scale. An
// unrecognized value resolves to the TOP of the scale (max severity) so a
// bogus/forged value can never score as safe.
export function riskDimensionRank(dimension, value) {
  const scale = RiskScale[dimension];
  if (!scale) return 0;
  const idx = scale.indexOf(value);
  return idx === -1 ? scale.length - 1 : idx;
}

// Normalize a dimension rank to [0,1] for aggregation.
export function riskDimensionSeverity(dimension, value) {
  const scale = RiskScale[dimension];
  if (!scale || scale.length <= 1) return 0;
  return riskDimensionRank(dimension, value) / (scale.length - 1);
}

// Take the RISKIER (higher-rank) of two values on the same dimension. This is
// the only sanctioned combinator, guaranteeing risk escalates monotonically
// when capability baseline and runtime evidence are merged.
export function maxRiskValue(dimension, a, b) {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  return riskDimensionRank(dimension, a) >= riskDimensionRank(dimension, b) ? a : b;
}

// Build a fully-populated dimensions object, filling any unset dimension with
// its conservative default.
export function completeRiskDimensions(partial = {}) {
  const out = {};
  for (const dimension of Object.values(RiskDimension)) {
    out[dimension] = partial[dimension] ?? RISK_DIMENSION_DEFAULT[dimension];
  }
  return out;
}

// Validate a structured RiskAssessment shape (used by tests and audit). Ensures
// every dimension value is on its scale and overallRisk is a valid RiskLevel.
export function validateRiskAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") {
    throw new ValidationError("riskAssessment must be an object");
  }
  assertEnum(assessment.overallRisk, RiskLevel, "riskAssessment.overallRisk");
  if (typeof assessment.score !== "number" || assessment.score < 0 || assessment.score > 1) {
    throw new ValidationError("riskAssessment.score must be a number in [0,1]");
  }
  if (!assessment.dimensions || typeof assessment.dimensions !== "object") {
    throw new ValidationError("riskAssessment.dimensions must be an object");
  }
  for (const [dimension, value] of Object.entries(assessment.dimensions)) {
    const scale = RiskScale[dimension];
    if (!scale) {
      throw new ValidationError(`riskAssessment.dimensions has unknown dimension ${dimension}`);
    }
    if (!scale.includes(value)) {
      throw new ValidationError(`riskAssessment.dimensions.${dimension} value ${value} is not on its scale`);
    }
  }
  if (!Array.isArray(assessment.reasons)) throw new ValidationError("riskAssessment.reasons must be an array");
  if (typeof assessment.uncertainty !== "number" || assessment.uncertainty < 0 || assessment.uncertainty > 1) {
    throw new ValidationError("riskAssessment.uncertainty must be a number in [0,1]");
  }
  return assessment;
}

export const ActionType = Object.freeze({
  FILE_READ: "FileReadAction",
  ENVIRONMENT_VARIABLE_SET: "EnvironmentVariableSetAction",
  ENVIRONMENT_VARIABLE_READ: "EnvironmentVariableReadAction",
  FILE_ROLLBACK: "FileRollbackAction",
  COMMAND_EXECUTION: "CommandExecutionAction",
  PROCESS_START: "ProcessStartAction",
  USER_PATH_SET: "UserPathSetAction",
  WINGET_SEARCH: "WinGetSearchAction",
  WINGET_INSTALL: "WinGetInstallAction",
  PORT_INSPECT: "PortInspectAction"
});

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function assertString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
}

export function assertEnum(value, values, fieldName) {
  if (!Object.values(values).includes(value)) {
    throw new ValidationError(`${fieldName} must be one of ${Object.values(values).join(", ")}`);
  }
}

export function validateIntent(intent) {
  assertString(intent.rawText, "intent.rawText");
  if (!intent.entities || typeof intent.entities !== "object") {
    throw new ValidationError("intent.entities must be an object");
  }
  if (intent.intentType) {
    return intent;
  }
  // workspacePath should always be present
  assertString(intent.entities.workspacePath, "intent.entities.workspacePath");
  // key and value are only required for environment setting intents, not all intents
  return intent;
}

export function validateAction(action) {
  assertString(action.actionId, "action.actionId");
  assertEnum(action.actionType, ActionType, "action.actionType");
  assertString(action.description, "action.description");
  if (!action.parameters || typeof action.parameters !== "object") {
    throw new ValidationError("action.parameters must be an object");
  }
  if (!Array.isArray(action.requiredCapabilities)) {
    throw new ValidationError("action.requiredCapabilities must be an array");
  }
  if (!Array.isArray(action.requiredPermissions)) {
    throw new ValidationError("action.requiredPermissions must be an array");
  }
  if (!Array.isArray(action.dependencies)) {
    throw new ValidationError("action.dependencies must be an array");
  }
  if (!action.timeout || typeof action.timeout !== "object") {
    throw new ValidationError("action.timeout must be an object");
  }
  if (!action.retryPolicy || typeof action.retryPolicy !== "object") {
    throw new ValidationError("action.retryPolicy must be an object");
  }
  return action;
}

export function validateTaskGraph(taskGraph) {
  if (!taskGraph || !Array.isArray(taskGraph.tasks) || taskGraph.tasks.length === 0) {
    throw new ValidationError("taskGraph.tasks must contain at least one task");
  }
  assertString(taskGraph.graphId, "taskGraph.graphId");
  for (const task of taskGraph.tasks) {
    assertString(task.taskId, "task.taskId");
    if (!Array.isArray(task.dependencies)) {
      throw new ValidationError("task.dependencies must be an array");
    }
    // Two task shapes are supported: the canonical scheduler shape
    // (task.capability, validated in depth by PlanValidator) and the legacy
    // typed-action shape (task.selectedCapability + task.action). Detect which
    // one this is and validate accordingly.
    const canonicalCapability = task.capability ?? task.selectedCapability;
    assertString(canonicalCapability, "task.capability");
    if (task.action) {
      assertString(task.description, "task.description");
      if (!Array.isArray(task.completionCriteria) || task.completionCriteria.length === 0) {
        throw new ValidationError("task.completionCriteria must contain at least one value");
      }
      validateAction(task.action);
    }
  }
  return taskGraph;
}

export function validateExecutionPlan(plan) {
  if (!plan || typeof plan !== "object") {
    throw new ValidationError("plan must be an object");
  }
  assertString(plan.planId, "plan.planId");
  assertString(plan.goal, "plan.goal");
  assertString(plan.summary, "plan.summary");
  validateTaskGraph(plan.taskGraph);
  return plan;
}

export function validateActionResult(actionResult) {
  if (!actionResult || typeof actionResult !== "object") {
    throw new ValidationError("actionResult must be an object");
  }
  assertString(actionResult.resultId, "actionResult.resultId");
  assertString(actionResult.actionId, "actionResult.actionId");
  assertString(actionResult.status, "actionResult.status");
  if (!actionResult.output || typeof actionResult.output !== "object") {
    throw new ValidationError("actionResult.output must be an object");
  }
  if (typeof actionResult.attempt !== "number") {
    throw new ValidationError("actionResult.attempt must be a number");
  }
  return actionResult;
}

export function validateExecutionSession(session) {
  if (!session || typeof session !== "object") {
    throw new ValidationError("session must be an object");
  }
  assertString(session.sessionId, "session.sessionId");
  assertString(session.createdAt, "session.createdAt");
  assertEnum(session.currentState, RuntimeState, "session.currentState");
  if (session.intent) {
    if (session.intent.intentType) {
      assertString(session.intent.rawText, "intent.rawText");
    } else {
      validateIntent(session.intent);
    }
  }
  if (session.plan) {
    validateExecutionPlan(session.plan);
  }
  if (!Array.isArray(session.taskResults)) {
    throw new ValidationError("session.taskResults must be an array");
  }
  return session;
}

export function createAuditEvent(eventType, payload, sessionId) {
  return {
    eventId: createId("audit"),
    sessionId,
    eventType,
    payload,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: new Date().toISOString()
  };
}
