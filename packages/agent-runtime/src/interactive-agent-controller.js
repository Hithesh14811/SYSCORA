import crypto from "node:crypto";
import { validateSchema } from "../../model-providers/src/index.js";
import { sanitizeExternalContext, classifyExternalContext } from "../../shared-types/src/external-context.js";
import {
  InteractiveDecisionKind,
  normalizeInteractiveDecision
} from "../../shared-types/src/interactive-decision.js";
import { assessGoalContractEvidence } from "../../shared-types/src/goal-contract.js";
import { createResultEnvelope, extractResultValue } from "../../shared-types/src/result-envelope.js";
import { createCompositionGraph, validateCompositionGraph } from "../../shared-types/src/composition-graph.js";
import { evaluateTransitionContracts } from "../../shared-types/src/transition-contract.js";
import {
  CapabilityResolutionKind,
  canonicalizeCapabilityAction
} from "../../shared-types/src/capability-resolution.js";
import {
  appendEvidence,
  createEvidenceLedger,
  evaluateEvidenceLedger
} from "../../shared-types/src/evidence-ledger.js";
import { evaluatePostcondition } from "../../shared-types/src/postconditions.js";
import { diffScreenSnapshots } from "../../perception/src/vision-provider.js";

const DEFAULT_BUDGETS = Object.freeze({
  maxSteps: 24,
  maxModelCalls: 8,
  maxElapsedTime: 120000,
  maxRepeatedActions: 2,
  maxFailedActions: 5,
  recoveryBudget: 4
});

const TERMINAL = new Set(["COMPLETE", "FAILED", "NEEDS_USER"]);
const SUCCESS = new Set(["VERIFIED"]);
const MAX_MODEL_OBSERVATION_BYTES = 4_000;

export function isUiFacingAction(action) {
  return /^(application\.(launch|close)|window\.|ui\.|screen\.|ocr\.|vision\.|pointer\.|keyboard\.|gui\.)/.test(
    String(action?.capability ?? "")
  );
}

export const InteractiveConvergenceState = Object.freeze({
  SUPPORTED_ACTION: "SUPPORTED_ACTION",
  UNSUPPORTED_ACTION: "UNSUPPORTED_ACTION",
  NO_PROGRESS: "NO_PROGRESS",
  PROGRESS: "PROGRESS",
  TARGET_EXHAUSTED: "TARGET_EXHAUSTED",
  RECOVERABLE: "RECOVERABLE",
  UNRECOVERABLE: "UNRECOVERABLE"
});

export function sanitizeInteractiveState(value) {
  return sanitizeExternalContext(value);
}

export const classifyInteractiveContext = classifyExternalContext;

// Execution observations can contain complete UI trees, process listings, or
// browser state. They remain available locally for grounding and audit, but an
// action result must never make the *next* external reasoning request
// unbounded. Keep useful result fields when possible; otherwise send an
// explicit bounded summary rather than a partial JSON blob.
export function compactObservationForModel(value, maxBytes = MAX_MODEL_OBSERVATION_BYTES) {
  const safe = sanitizeInteractiveState(value ?? null);
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") <= maxBytes) return safe;
  const fields = [
    "status", "message", "summary", "success", "result", "value", "data",
    "application", "process", "window", "target", "targets", "verification"
  ];
  if (safe && typeof safe === "object" && !Array.isArray(safe)) {
    const selected = Object.fromEntries(
      fields.filter((field) => Object.hasOwn(safe, field)).map((field) => [field, safe[field]])
    );
    if (Object.keys(selected).length && Buffer.byteLength(JSON.stringify(selected), "utf8") <= maxBytes) {
      return { ...selected, truncated: true };
    }
  }
  return {
    summary: "Execution observation retained locally; its external reasoning summary was size-limited.",
    truncated: true
  };
}

function actionSignature(action, stateFingerprint) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      capability: action?.capability,
      inputs: action?.inputs,
      stateFingerprint
    }))
    .digest("hex");
}

function stableTargetKey(target) {
  return [
    target?.windowId ?? target?.windowIdentity?.processId ?? "",
    target?.automationId ?? "",
    target?.controlType ?? "",
    String(target?.name ?? "").trim().toLowerCase()
  ].join("|");
}

function stablePerceptionValue(value) {
  if (Array.isArray(value)) {
    return value.map(stablePerceptionValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ![
        "targetId", "observedAt", "timestamp", "capturedAt", "confidence",
        "runtimeId", "nativeWindowHandle", "snapshotId", "capturePath", "cached"
      ].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stablePerceptionValue(child)])
  );
}


function stateFingerprint(perception) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(stablePerceptionValue(sanitizeInteractiveState(perception ?? {}))))
    .digest("hex")
    .slice(0, 16);
}

function collectGroundedControls(value, controls = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectGroundedControls(item, controls);
  } else if (value && typeof value === "object") {
    if (value.targetId && Array.isArray(value.supportedPatterns)) controls.push(value);
    for (const child of Object.values(value)) collectGroundedControls(child, controls);
  }
  return controls;
}

function hasPattern(target, name) {
  return (target?.supportedPatterns ?? []).some((pattern) =>
    String(pattern).toLowerCase().includes(String(name).toLowerCase())
  );
}

function canonicalUiActionName(action) {
  const normalized = String(action ?? "").replace(/[_\s-]/g, "").toLowerCase();
  if (["setvalue", "settext"].includes(normalized)) return "setValue";
  if (normalized === "scrollintoview") return "scrollIntoView";
  if (normalized === "selectaccessiblechild") return "selectAccessibleChild";
  return {
    invoke: "invoke", click: "click", focus: "focus", type: "type",
    select: "select", expand: "expand", collapse: "collapse",
    toggle: "toggle", nextsection: "nextSection"
  }[normalized] ?? action;
}

export function supportedUiActions(target) {
  const actions = [];
  const controlType = String(target?.controlType ?? "");
  if (hasPattern(target, "ValuePattern") && /\.(?:Edit|Document|ComboBox|Spinner)$/i.test(controlType)) {
    actions.push("setValue", "type");
  }
  if (hasPattern(target, "SelectionItemPattern")) actions.push("select");
  if (hasPattern(target, "InvokePattern") && !/\.Text$/i.test(String(target?.controlType ?? ""))) actions.push("invoke");
  if (hasPattern(target, "TogglePattern")) actions.push("toggle");
  if (hasPattern(target, "ExpandCollapsePattern")) {
    const state = String(target?.expandCollapseState ?? "").toLowerCase();
    actions.push(state.includes("expanded") ? "collapse" : "expand");
  }
  if (hasPattern(target, "ScrollItemPattern")) actions.push("scrollIntoView");
  return [...new Set(actions)];
}

function actionPairKey(action) {
  if (action?.capability !== "ui.action") return null;
  return `${stableTargetKey(action.inputs?.target)}|${canonicalUiActionName(action.inputs?.action)}`;
}

function normalizeUiAction(action) {
  if (action?.capability !== "ui.action") return action;
  const target = action.inputs?.target;
  const requested = canonicalUiActionName(action.inputs?.action);
  const supported = supportedUiActions(target);
  let normalized = requested;
  if (requested === "click") {
    normalized = supported.includes("invoke") ? "invoke"
      : supported.includes("select") ? "select" : requested;
  }
  if (requested === "type" && supported.includes("setValue")) normalized = "setValue";
  const inputs = { ...(action.inputs ?? {}), action: normalized };
  if (normalized === "setValue" && typeof inputs.text !== "string" && inputs.value != null) {
    inputs.text = String(inputs.value);
  }
  return { ...action, inputs };
}

function hydrateGroundedActionTarget(action, perception) {
  if (action?.capability !== "ui.action" || !action.inputs?.target?.targetId) return action;
  const proposed = action.inputs.target;
  const observed = collectGroundedControls(perception)
    .find((control) => control.targetId === proposed.targetId);
  if (!observed) return action;
  return {
    ...action,
    inputs: {
      ...(action.inputs ?? {}),
      target: { ...proposed, ...observed }
    }
  };
}

function snapshotTarget(target) {
  if (!target) return null;
  return {
    key: stableTargetKey(target),
    name: target.name ?? null,
    value: target.value ?? target.text ?? null,
    selected: target.selected ?? target.isSelected ?? null,
    focused: target.focused ?? target.hasKeyboardFocus ?? null,
    toggleState: target.toggleState ?? null,
    expandCollapseState: target.expandCollapseState ?? null,
    offscreen: target.offscreen ?? target.isOffscreen ?? null,
    boundingRect: target.boundingRect ?? null
  };
}

function predictUiPostcondition(action, perception) {
  if (action?.capability !== "ui.action") return null;
  const verb = canonicalUiActionName(action.inputs?.action);
  const target = action.inputs?.target;
  const before = snapshotTarget(
    collectGroundedControls(perception).find((control) => stableTargetKey(control) === stableTargetKey(target)) ?? target
  );
  if (verb === "setValue" || verb === "type") {
    return { kind: "VALUE_EQUALS", expected: String(action.inputs?.value ?? action.inputs?.text ?? ""), before };
  }
  if (verb === "select") return { kind: "SELECTED", before };
  if (verb === "toggle") return { kind: "TOGGLED", before };
  if (verb === "expand" || verb === "collapse") return { kind: verb.toUpperCase(), before };
  if (verb === "scrollIntoView") return { kind: "ONSCREEN", before };
  return { kind: "OBSERVABLE_DELTA", before, fingerprint: stateFingerprint(perception) };
}

export function measureUiProgress(expected, perception) {
  if (!expected) return { state: InteractiveConvergenceState.NO_PROGRESS, reason: "missing expected postcondition" };
  const controls = collectGroundedControls(perception);
  const afterTarget = controls.find((control) => stableTargetKey(control) === expected.before?.key);
  const after = snapshotTarget(afterTarget);
  let matched = false;
  if (expected.kind === "VALUE_EQUALS") {
    const observed = String(after?.value ?? afterTarget?.name ?? "");
    matched = observed === expected.expected || observed.includes(expected.expected);
  } else if (expected.kind === "SELECTED") {
    matched = after?.selected === true && expected.before?.selected !== true;
  } else if (expected.kind === "TOGGLED") {
    matched = after?.toggleState != null && after.toggleState !== expected.before?.toggleState;
  } else if (expected.kind === "EXPAND") {
    matched = /expanded/i.test(String(after?.expandCollapseState ?? ""));
  } else if (expected.kind === "COLLAPSE") {
    matched = /collapsed/i.test(String(after?.expandCollapseState ?? ""));
  } else if (expected.kind === "ONSCREEN") {
    matched = after?.offscreen === false && expected.before?.offscreen !== false;
  } else {
    matched = stateFingerprint(perception) !== expected.fingerprint;
  }
  return {
    state: matched ? InteractiveConvergenceState.PROGRESS : InteractiveConvergenceState.NO_PROGRESS,
    expected,
    observed: after,
    observedFingerprint: stateFingerprint(perception)
  };
}

function collectTargetIds(value, targetIds = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectTargetIds(item, targetIds);
  } else if (value && typeof value === "object") {
    if (typeof value.targetId === "string") targetIds.add(value.targetId);
    for (const child of Object.values(value)) collectTargetIds(child, targetIds);
  }
  return targetIds;
}

function readPath(value, path) {
  let current = value;
  for (const part of String(path ?? "").split(".").filter(Boolean)) current = current?.[part];
  return current;
}

function resolveRuntimeReferences(value, lastOutcome, bindings) {
  if (Array.isArray(value)) return value.map((item) => resolveRuntimeReferences(item, lastOutcome, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveRuntimeReferences(child, lastOutcome, bindings)]));
  }
  if (typeof value !== "string") return value;
  if (value.startsWith("$last.")) return readPath(lastOutcome, value.slice("$last.".length));
  if (value.startsWith("$binding.")) {
    const [name, ...path] = value.slice("$binding.".length).split(".");
    const bound = bindings?.[name]?.value;
    return path.length ? readPath(bound, path.join(".")) : bound;
  }
  return value
    .replace(/\$binding\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g, (reference, bindingPath) => {
      const [name, ...path] = bindingPath.split(".");
      const bound = bindings?.[name]?.value;
      const resolved = path.length ? readPath(bound, path.join(".")) : bound;
      return String(resolved ?? reference);
    })
    .replace(/\$last\.([A-Za-z0-9_.-]+)/g, (_, path) => String(readPath(lastOutcome, path) ?? `$last.${path}`));
}

function normalizeBoundValue(value, normalization) {
  const text = typeof value === "string" ? value.trim() : value;
  if (normalization === "version") return String(text ?? "").match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] ?? null;
  if (normalization === "trim") return String(text ?? "").trim();
  if (normalization === "maxWorkingSet") {
    const rows = Array.isArray(value) ? value : [];
    return rows.reduce((best, row) =>
      Number(row?.WorkingSet64 ?? row?.workingSet ?? 0) > Number(best?.WorkingSet64 ?? best?.workingSet ?? 0)
        ? row : best
    , null);
  }
  if (normalization === "firstPercentage") {
    const matches = [];
    const visit = (candidate) => {
      if (Array.isArray(candidate)) return candidate.forEach(visit);
      if (!candidate || typeof candidate !== "object") return;
      for (const field of [candidate.name, candidate.value, candidate.text, candidate.label]) {
        const match = String(field ?? "").match(/\b\d+(?:\.\d+)?%\b(?:\s*\([^)]*\))?/);
        if (match) matches.push(match[0]);
      }
      Object.values(candidate).forEach(visit);
    };
    visit(value);
    return matches.find((match) => /recommended|selected/i.test(match)) ?? matches[0] ?? null;
  }
  return text;
}

function inferCriterionIds(action, goalContract, actual = null) {
  if (Array.isArray(action?.criterionIds) && action.criterionIds.length) return action.criterionIds;
  const evidence = JSON.stringify({
    capability: action?.capability,
    inputs: action?.inputs,
    subgoal: action?.subgoal,
    expectedEffect: action?.expectedEffect,
    actual
  }).toLowerCase();
  const mutating = /^(?:filesystem\.write|filesystem\.create|ui\.action|ui\.navigate|pointer\.|keyboard\.|browser\.(?:click|type|select)|window\.(?:activate|moveResize)|process\.(?:start|stop))/.test(String(action?.capability ?? ""));
  return (goalContract?.criteria ?? []).filter((criterion) => {
    if (criterion.kind === "PROHIBITION") return false;
    const requiresMutation = /\b(?:create|write|modify|update|enter|type|click|select|choose|toggle|enable|disable|close|open|navigate|save|persist)\b/i.test(criterion.description);
    if (requiresMutation && !mutating && !/(?:\.read$|\.verify|\.currentState$|\.find$)/.test(String(action?.capability ?? ""))) return false;
    if (criterion.anchors?.length && !criterion.anchors.every((anchor) => evidence.includes(String(anchor).toLowerCase()))) return false;
    const informative = (criterion.tokens ?? []).filter((token) => token.length > 2);
    const overlap = informative.filter((token) => evidence.includes(token)).length;
    return overlap >= Math.min(2, Math.max(1, informative.length));
  }).map((criterion) => criterion.criterionId);
}

export function evaluateSubgoalCompletion(subgoal, observations = [], actionResults = [], bindings = {}) {
  const goal = String(subgoal ?? "").toLowerCase();
  const readOnlyQuestion = /\b(tell|whether|determine|read|what|which|state|status|enabled|disabled|on or off)\b/.test(goal);
  // Negative safety constraints describe actions the user explicitly forbids;
  // they must not turn a read-only question into a mutating goal.
  const affirmativeGoal = goal
    .replace(/\b(?:do not|don't|dont|never)\s+(?:make\s+(?:any\s+)?)?(?:change|changes|toggle|click|set|enable|disable)\b[^.!?]*/g, "")
    .replace(/\bwithout\s+(?:making\s+(?:any\s+)?)?(?:change|changes|changing|toggling|clicking|setting|enabling|disabling)\b[^.!?]*/g, "");
  const mutation = /\b(turn on|turn off|enable|disable|change|set|toggle|click|type|enter|put|play|close|activate|select|choose|navigate|invoke)\b/.test(affirmativeGoal);
  const navigationRequired = /\b(select|choose|navigate|open|switch)\b[\s\S]{0,80}\b(section|tab|menu|view)\b/.test(affirmativeGoal);
  const navigationSucceeded = actionResults.some((entry) =>
    entry?.succeeded && (
      entry.action?.capability === "ui.navigateSection" ||
      entry.action?.capability === "ui.action"
    )
  );
  const expectedControl = goal.match(/\bverify(?:\s+that)?\s+(?:the\s+)?(.+?)\s+control\s+(?:appears?|exists?|is\s+visible)\b/)?.[1]?.trim();
  if (expectedControl && (!navigationRequired || navigationSucceeded) && actionResults.some((entry) =>
    entry?.succeeded && /^(?:ui|pointer|keyboard)\./.test(String(entry.action?.capability ?? ""))
  )) {
    const controls = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value.relevantControls)) controls.push(...value.relevantControls);
      Object.values(value).forEach(visit);
    };
    observations.forEach(visit);
    const expectedTokens = expectedControl.match(/[a-z0-9]{2,}/g) ?? [];
    const match = controls.find((control) => {
      const semantics = `${control?.name ?? ""} ${control?.automationId ?? ""}`.toLowerCase();
      return expectedTokens.length > 0 && expectedTokens.every((token) => semantics.includes(token));
    });
    if (match) {
      return {
        status: "COMPLETE",
        result: { summary: `Verified that the ${match.name || expectedControl} control is visible.`, control: match },
        evidence: `After the grounded UI action, perception exposed ${match.name || expectedControl} (${match.automationId || match.controlType || "accessible control"}).`
      };
    }
  }
  // A grounded UI interaction can be the entire request (for example,
  // "select the Harmless Mode control").  Do not require a model follow-up
  // once the runtime has independently verified the action and perception
  // shows an observable postcondition.  This remains deliberately narrow:
  // the control must be named in the request, the exact runtime action must
  // have succeeded, and the controller's postcondition measurement must show
  // progress.  It does not treat a bare execution acknowledgement as proof.
  const requestedControl = goal.match(/["']([^"']+)["']\s+(?:field|button|control|option|setting|mode)/i)?.[1]?.trim();
  if (mutation && requestedControl) {
    const requestedTokens = requestedControl.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
    const completedAction = actionResults.find((entry) => {
      if (!entry?.succeeded || entry?.action?.capability !== "ui.action") return false;
      if (entry?.verification?.status !== "VERIFIED") return false;
      if (entry?.progressMeasurement?.state !== InteractiveConvergenceState.PROGRESS) return false;
      const target = entry.action?.inputs?.target ?? entry.executionResult?.target;
      const semantics = `${target?.name ?? ""} ${target?.automationId ?? ""}`.toLowerCase();
      return requestedTokens.length > 0 && requestedTokens.every((token) => semantics.includes(token));
    });
    if (completedAction) {
      const target = completedAction.action?.inputs?.target ?? completedAction.executionResult?.target;
      return {
        status: "COMPLETE",
        result: {
          summary: `${target?.name ?? requestedControl} was completed and independently verified.`,
          control: target
        },
        evidence: `Grounded UI action on ${target?.name ?? requestedControl} produced the required observable postcondition and verified successfully.`
      };
    }
  }
  const inspectionGoal = /\b(inspect|controls?|interface|available)\b/.test(goal);
  if (inspectionGoal && !mutation && (!navigationRequired || navigationSucceeded)) {
    const controls = [];
    const groundedWindows = [];
    const visitInspection = (value) => {
      if (Array.isArray(value)) return value.forEach(visitInspection);
      if (!value || typeof value !== "object") return;
      if (value.groundedWindow) groundedWindows.push(value.groundedWindow);
      if (Array.isArray(value.relevantControls)) controls.push(...value.relevantControls);
    };
    observations.forEach(visitInspection);
    const major = [...new Map(
      controls
        .filter((control) => control?.name || control?.automationId)
        .map((control) => [
          `${control.controlType ?? ""}:${control.name ?? control.automationId}`,
          {
            name: control.name || control.automationId,
            controlType: control.controlType ?? "Control",
            enabled: control.enabled,
            value: control.value ?? null,
            toggleState: control.toggleState ?? null
          }
        ])
    ).values()].slice(0, 16);
    if (groundedWindows.length > 0 && major.length > 0) {
      return {
        status: "COMPLETE",
        result: {
          summary: `Observed ${major.length} major accessible controls without changing the application.`,
          controls: major
        },
        evidence: `Grounded window ${groundedWindows[0].MainWindowTitle ?? groundedWindows[0].title ?? ""} exposed controls: ${major.map((control) => control.name).join(", ")}`
      };
    }
  }
  if (readOnlyQuestion && !mutation) {
    const candidates = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      const name = String(value.name ?? value.label ?? value.text ?? "").trim();
      if (name && (value.toggleState != null || /\b(turned|enabled|disabled)\s+(?:is\s+)?(?:on|off)\b|\bis (?:on|off)\b/i.test(name))) {
        candidates.push(value);
      }
      Object.values(value).forEach(visit);
    };
    observations.forEach(visit);
    const tokens = goal.match(/[a-z0-9]{3,}/g)?.filter((token) => !["tell", "whether", "determine", "state", "status", "open", "settings"].includes(token)) ?? [];
    const ranked = candidates.map((candidate) => {
      const text = `${candidate.name ?? ""} ${candidate.automationId ?? ""}`.toLowerCase();
      return { candidate, score: tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0) };
    }).sort((a, b) => b.score - a.score);
    if (ranked[0]?.score > 0) {
      const candidate = ranked[0].candidate;
      const state = candidate.toggleState ?? candidate.name;
      return {
        status: "COMPLETE",
        result: { summary: `${candidate.name || "Observed control"}: ${state}`, value: state },
        evidence: `Observed ${candidate.name || candidate.automationId} with state ${state}`
      };
    }
  }
  return { status: Object.keys(bindings).length ? "CONTINUE_MECHANICALLY" : "INCONCLUSIVE" };
}

export function enumerateGroundedActionCandidates(goal, perception, exhaustedPairs = new Set()) {
  const controls = [...new Map(
    collectGroundedControls(perception).map((control) => [stableTargetKey(control), control])
  ).values()];
  const ambientTokens = new Set(
    [
      perception?.groundedWindow?.MainWindowTitle,
      perception?.groundedWindow?.title,
      perception?.foregroundWindow?.MainWindowTitle,
      perception?.foregroundWindow?.title
    ].filter(Boolean).flatMap((title) => String(title).toLowerCase().match(/[a-z0-9]+/g) ?? [])
  );
  const tokens = String(goal ?? "").toLowerCase().match(/[a-z0-9]+/g)?.filter((token) =>
    !ambientTokens.has(token) &&
    !["open", "tell", "whether", "determine", "current", "state", "status", "settings", "application"].includes(token)
  ) ?? [];
  const candidates = controls.flatMap((control) => {
    const semantics = `${control.name ?? ""} ${control.automationId ?? ""}`.toLowerCase();
    const overlap = tokens.reduce((total, token) => total + (semantics.includes(token) ? 1 : 0), 0);
    return supportedUiActions(control).map((action) => {
      let score = overlap * 10;
      let relevant = overlap > 0;
      if (control.enabled !== false) score += 2;
      if (action === "setValue" && /\b(type|enter|write|input|navigate|address|url)\b/i.test(goal)) {
        score += 12;
        relevant = true;
      }
      if (action === "select" && /\b(select|choose|tab|section|page|view)\b/i.test(goal)) {
        score += 6;
        relevant = true;
      }
      // A Button normally exposes InvokePattern rather than SelectionItemPattern.
      // Natural-language requests such as "choose the Safe Preview control" or
      // "select Harmless Mode" therefore still need to consider its `invoke`
      // action.  Previously those verbs only made SelectionItemPattern targets
      // eligible, so the controller unnecessarily asked the model (and failed
      // outright while the provider was unavailable) despite having a grounded,
      // supported local action.
      if (action === "invoke" && /\b(click|invoke|press|calculate|select|choose)\b/i.test(goal)) {
        score += 4;
        relevant = true;
      }
      const chromeVerb = String(control.name ?? "").match(/^(minimize|maximize|close)\b/i)?.[1]?.toLowerCase();
      if (chromeVerb && !new RegExp(`\\b${chromeVerb}\\b`, "i").test(String(goal ?? ""))) {
        score -= 100;
        relevant = false;
      }
      if (action === "scrollIntoView" && control.offscreen !== true && control.isOffscreen !== true) score -= 20;
      return { control, action, score, relevant };
    });
  }).map((candidate) => ({
    ...candidate,
    pairKey: `${stableTargetKey(candidate.control)}|${candidate.action}`
  })).filter((candidate) => candidate.relevant && !exhaustedPairs.has(candidate.pairKey) && candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.pairKey.localeCompare(right.pairKey));
  return candidates.map((candidate) => ({
      capability: "ui.action",
      inputs: { target: candidate.control, action: candidate.action },
      subgoal: `Interact with ${candidate.control.name ?? candidate.control.automationId ?? "grounded control"}`,
      expectedPostcondition: { kind: "CONTROLLER_OBSERVED_DELTA" },
      convergencePairKey: candidate.pairKey,
      mechanicallySelected: true
    }));
}

const DIGIT_CONTROL_NAMES = Object.freeze([
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"
]);

function parseArithmeticOperation(goal) {
  const request = String(goal ?? "");
  const expression = request.match(/\bcalculate\s+(.+?)(?=,\s*(?:and\s+)?leave\b|\s+and\s+leave\b|$)/i)?.[1];
  if (!expression) return null;
  const lexemes = [...expression.matchAll(/\d+(?:\.\d+)?|times|multiplied by|multiply by|plus|minus|divided by|divide by|[x*+÷/=-]/gi)]
    .map((match) => match[0].toLowerCase());
  if (!lexemes.some((token) => /^\d/.test(token)) || !lexemes.some((token) => /times|multipl|\*|x|plus|\+|minus|-|divid|÷|\//.test(token))) {
    return null;
  }
  const labels = [];
  const calculation = [];
  for (const token of lexemes) {
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      for (const character of token) {
        if (character === ".") labels.push("Decimal point");
        else labels.push(DIGIT_CONTROL_NAMES[Number(character)]);
      }
      calculation.push(token);
    } else if (/times|multipl|\*|^x$/.test(token)) {
      labels.push("Multiply by");
      calculation.push("*");
    } else if (/plus|\+/.test(token)) {
      labels.push("Plus");
      calculation.push("+");
    } else if (/minus|^-$/i.test(token)) {
      labels.push("Minus");
      calculation.push("-");
    } else if (/divid|÷|\//.test(token)) {
      labels.push("Divide by");
      calculation.push("/");
    }
  }
  labels.push("Equals");
  let result = Number(calculation[0]);
  for (let index = 1; index < calculation.length; index += 2) {
    const operator = calculation[index];
    const operand = Number(calculation[index + 1]);
    if (!Number.isFinite(result) || !Number.isFinite(operand)) return null;
    if (operator === "*") result *= operand;
    else if (operator === "+") result += operand;
    else if (operator === "-") result -= operand;
    else if (operator === "/") result /= operand;
  }
  if (!Number.isFinite(result)) return null;
  const application = request.match(/^\s*open\s+([^,]+?)(?=,\s*calculate\b)/i)?.[1]?.trim() ?? null;
  return { application, labels, result: String(result) };
}

export function buildSupportedUiOperationStrategy(goal) {
  const parsed = parseArithmeticOperation(goal);
  if (!parsed?.application) return null;
  const actions = [];
  for (const label of parsed.labels) {
    actions.push({
      capability: "ui.find",
      inputs: { application: parsed.application, selector: { name: label } },
      subgoal: `Ground the ${label} control`
    });
    actions.push({
      capability: "ui.action",
      inputs: { application: parsed.application, target: "$last.output.target", action: "click" },
      subgoal: `Invoke the grounded ${label} control`
    });
  }
  actions.push({
    capability: "ui.find",
    inputs: { application: parsed.application, selector: { nameContains: parsed.result } },
    subgoal: `Observe the expected result ${parsed.result}`,
    completesGoal: true,
    completionResult: { summary: `The requested operation converged and the visible result is ${parsed.result}.` }
  });
  return {
    action: { capability: "application.launch", inputs: { application: parsed.application }, subgoal: `Open ${parsed.application}` },
    localSteps: actions,
    source: "SUPPORTED_UIA_SEQUENCE_COMPILER",
    expectedResult: parsed.result
  };
}

export function buildSupportedTextEntryStrategy(goal) {
  const request = String(goal ?? "").trim();
  const application = request.match(/^\s*open\s+([^,]+?)(?=,\s*(?:type|enter|write)\b)/i)?.[1]?.trim();
  if (!application) return null;
  const twoLines = request.match(
    /\b(?:type|enter|write)\s+(.+?)\s+on\s+the\s+first\s+line\s+and\s+(.+?)\s+on\s+the\s+second\s+line(?=,|\s+then\b|$)/i
  );
  const simple = request.match(
    /\b(?:type|enter|write)\s+(.+?)(?=,\s*(?:then|and)\s+leave\b|\s+then\s+leave\b|\s+without\s+saving\b|$)/i
  );
  const text = twoLines
    ? `${twoLines[1].trim()}\n${twoLines[2].trim()}`
    : simple?.[1]?.trim();
  if (!text) return null;
  const selector = { controlType: "Document" };
  return {
    action: {
      capability: "application.launch",
      inputs: { application },
      subgoal: `Open ${application}`
    },
    localSteps: [
      {
        capability: "ui.find",
        inputs: { application, selector },
        subgoal: "Ground the editable document control"
      },
      {
        capability: "ui.action",
        inputs: { application, target: "$last.output.target", action: "setValue", text },
        subgoal: "Set the grounded editable document value"
      },
      {
        capability: "ui.verifyValue",
        inputs: { application, selector, expected: text },
        subgoal:
          `Verify that the specified text is entered in ${application}, the document remains unsaved, ` +
          `and ${application} remains visible`,
        expectedEffect:
          "The exact specified text is visible in the grounded editable document; no save action was issued and the application window remains visible.",
        completesGoal: true,
        completionResult: {
          summary:
            `The requested text was entered through the control's advertised ValuePattern, verified visible, ` +
            `and ${application} remains open without a save action.`
        }
      }
    ],
    source: "SUPPORTED_UIA_TEXT_ENTRY_COMPILER",
    expectedText: text
  };
}

export function buildSupportedReadOnlyNavigationStrategy(goal) {
  const request = String(goal ?? "").trim();
  if (!/\b(?:report|read|tell|identify|what)\b/i.test(request) || !/\bdo not change\b|\bwithout changing\b/i.test(request)) {
    return null;
  }
  const navigation = request.match(
    /^\s*open\s+(.+?)\s+to\s+the\s+(.+?)\s+page,\s*(?:report|read|tell me)\s+(?:the\s+)?current\s+(.+?)(?=,\s*(?:and\s+)?do not change\b|$)/i
  );
  if (!navigation) return null;
  const [, applicationText, pageText, queryText] = navigation;
  const application = applicationText.replace(/^(?:the\s+)?windows\s+/i, "").trim();
  const page = pageText.trim();
  const query = queryText.trim();
  const selectorToken = query.match(/[a-z0-9%]+/i)?.[0] ?? query;
  const bindingName = "observedUiValue";
  const percentageRead = /\bpercentage\b|%/i.test(query);
  const readStep = percentageRead ? {
    capability: "ui.inspect",
    inputs: { application, maxElements: 320 },
    bindOutput: { name: bindingName, path: "output", normalize: "firstPercentage" },
    subgoal: `Read and report the current ${query} without changing it`,
    expectedEffect: `The current ${query} is extracted from the visible ${page} page without mutation.`,
    completesGoal: true,
    completionResult: {
      summary: `Current ${query}: $binding.${bindingName}`,
      value: `$binding.${bindingName}`
    }
  } : {
    capability: "ui.extract",
    inputs: { application, query, selector: { nameContains: selectorToken }, maxElements: 240 },
    bindOutput: { name: bindingName, path: "output.value", normalize: "trim" },
    subgoal: `Read and report the current ${query} without changing it`,
    expectedEffect: `The current ${query} is extracted from the visible ${page} page without mutation.`,
    completesGoal: true,
    completionResult: {
      summary: `Current ${query}: $binding.${bindingName}`,
      value: `$binding.${bindingName}`
    }
  };
  const localSteps = [
    {
      capability: "window.moveResize",
      inputs: { application, x: 80, y: 40, width: 1600, height: 1000 },
      subgoal: `Expose enough of ${application} for deterministic read-only inspection`
    },
    {
      capability: "ui.navigateSection",
      inputs: { application, query: page, maxTransitions: 8 },
      subgoal: `Deterministically navigate to the ${page} page without changing a setting`
    }
  ];
  if (percentageRead) {
    localSteps.push({
      capability: "keyboard.press",
      inputs: { application, keys: "{PGDN}" },
      subgoal: `Reveal the requested ${query} for read-only inspection`
    });
  }
  localSteps.push(readStep);
  return {
    action: {
      capability: "application.launch",
      inputs: { application },
      subgoal: `Open ${application}`
    },
    localSteps,
    source: "SUPPORTED_UIA_READ_ONLY_NAVIGATION_COMPILER",
    application,
    page,
    query
  };
}

export function buildSupportedBrowserReadStrategy(goal) {
  const request = String(goal ?? "").trim();
  const navigation = request.match(
    /^\s*open\s+(.+?),\s*navigate\s+to\s+(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)[, ]+\s*(?:and\s+)?report\s+the\s+page\s+(.+?)(?=,\s*(?:and\s+)?leave\b|$)/i
  );
  if (!navigation) return null;
  const [, application, domain, requestedValue] = navigation;
  if (!/\b(?:browser|edge|chrome|firefox|opera)\b/i.test(application)) return null;
  const bindingName = "observedPageValue";
  const selector = /\bheading\b/i.test(requestedValue) ? "h1" : "body";
  return {
    action: {
      capability: "browser.launch",
      inputs: { url: `https://${domain}` },
      subgoal: `Open ${domain} in ${application.trim()}`
    },
    localSteps: [
      {
        capability: "browser.wait",
        inputs: { condition: "document.readyState", value: "complete", timeoutMs: 15000 },
        subgoal: `Wait for ${domain}`
      },
      {
        capability: "browser.extract",
        inputs: { kind: "text", query: requestedValue.trim(), selector },
        bindOutput: { name: bindingName, path: "output.value", normalize: "trim" },
        subgoal: `Report the page ${requestedValue.trim()} and leave the page open`,
        expectedEffect: `The ${requestedValue.trim()} is read from ${domain} while the page remains open.`,
        completesGoal: true,
        completionResult: {
          summary: `Page ${requestedValue.trim()}: $binding.${bindingName}`,
          value: `$binding.${bindingName}`
        }
      }
    ],
    source: "SUPPORTED_BROWSER_READ_COMPILER",
    domain
  };
}

export function buildSupportedRankedProcessReadStrategy(goal) {
  const request = String(goal ?? "").trim();
  const application = request.match(/^\s*open\s+([^,]+),/i)?.[1]?.trim();
  if (!application || !/\bprocess\b/i.test(request) || !/\bmost\s+memory\b/i.test(request)
    || !/\breport\b/i.test(request) || !/\bwithout\s+ending\b|\bdo not end\b/i.test(request)) {
    return null;
  }
  const bindingName = "topMemoryProcess";
  return {
    action: {
      capability: "application.launch",
      inputs: { application },
      subgoal: `Open ${application}`
    },
    localSteps: [{
      capability: "processes.list",
      inputs: {},
      bindOutput: { name: bindingName, path: "output", normalize: "maxWorkingSet" },
      subgoal:
        `Identify and report the process using the most memory while ${application} remains open and no process is ended`,
      expectedEffect:
        "The highest-memory process name and memory usage are read without ending or changing any process.",
      completesGoal: true,
      completionResult: {
        summary:
          `Highest memory process: $binding.${bindingName}.ProcessName ` +
          `($binding.${bindingName}.WorkingSet64 bytes)`,
        process: `$binding.${bindingName}.ProcessName`,
        workingSetBytes: `$binding.${bindingName}.WorkingSet64`
      }
    }],
    source: "SUPPORTED_RANKED_PROCESS_READ_COMPILER"
  };
}

export function chooseMechanicalContinuation(goal, perception, exhaustedPairs = new Set()) {
  const candidates = enumerateGroundedActionCandidates(goal, perception, exhaustedPairs);
  if (!candidates[0]) return null;
  const scoreFor = (candidate) => {
    const control = candidate.inputs?.target;
    const semantics = `${control?.name ?? ""} ${control?.automationId ?? ""}`.toLowerCase();
    return (String(goal ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .reduce((score, token) => score + (semantics.includes(token) ? 1 : 0), 0);
  };
  return candidates[1] && scoreFor(candidates[0]) === scoreFor(candidates[1]) ? null : candidates[0];
}

export function buildCrossModalTransferStrategy(goal) {
  const text = String(goal ?? "").trim();
  const domain = text.match(/\b(?:open|visit|browse|from|website|webpage|site)\s+(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=\/|\s|[.,;]|$)/i)?.[1];
  const destination = text.match(/\b(?:into|in)\s+([a-z][a-z0-9 ._-]{0,40}?)(?=\s+and\b|\s+then\b|[.,;]|$)/i)?.[1]?.trim();
  const transferRequested = /\b(put|enter|type|copy|transfer|insert)\b/i.test(text);
  const browserRequested = /\b(browser|website|web)\b/i.test(text) || Boolean(domain);
  if (!domain || !destination || !transferRequested || !browserRequested) return null;
  const kind = /\bversion\b/i.test(text) ? "version" : /\bnumber\b/i.test(text) ? "number" : "text";
  const query = text.match(/\b([a-z][a-z0-9_-]*)\s+(?:download\s+)?(?:version|number)\b/i)?.[1] ?? null;
  const path = /\bdownload\s+version\b/i.test(text) ? "/downloads/" : "/";
  const url = `https://${domain}${path}`;
  const bindingName = "transferredValue";
  const localSteps = [
    { capability: "browser.wait", inputs: { condition: "document.readyState", value: "complete", timeoutMs: 15000 } },
    {
      capability: "browser.extract",
      inputs: { kind, query, selector: "body" },
      bindOutput: { name: bindingName, path: "output.value", normalize: kind === "version" ? "version" : "trim" }
    },
    { capability: "application.launch", inputs: { application: destination } },
    { capability: "window.wait", inputs: { application: destination, timeoutMs: 10000 } },
    { capability: "window.activate", inputs: { application: destination } }
  ];
  localSteps.push(
    { capability: "keyboard.type", inputs: { application: destination, text: `$binding.${bindingName}` } },
    {
      capability: "ui.find",
      inputs: { application: destination, selector: { nameContains: `$binding.${bindingName}` } },
      completesGoal: true,
      completionResult: { summary: `The extracted ${kind} was transferred to ${destination} and verified visible.` }
    }
  );
  return {
    action: { capability: "browser.launch", inputs: { url }, subgoal: `Open ${domain}` },
    localSteps,
    source: "MODEL_INTENT_MECHANICAL_COMPILER",
    bindingName,
    destination,
    domain,
    kind
  };
}

export function buildInternalToGuiTransferStrategy(goal) {
  const text = String(goal ?? "").trim();
  const filePath = text.match(/\b(?:contents?|text|value)\s+(?:of|from)\s+["']([^"']+)["']/i)?.[1];
  const target = text.match(/\b(?:into|in)\s+(?:the\s+)?["']([^"']+)["']\s+(?:field|control|box)/i)?.[1];
  const destination = target
    ? text.match(new RegExp(`["']${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s+(?:field|control|box)\\s+in\\s+([a-z][a-z0-9 ._-]{0,40}?)(?=,|\\s+and\\b|\\s+then\\b|$)`, "i"))?.[1]?.trim()
    : null;
  if (!filePath || !target || !destination || !/\b(enter|type|put|copy|transfer|insert)\b/i.test(text)) return null;
  const bindingName = "transferredValue";
  return {
    action: {
      capability: "filesystem.read",
      inputs: { filePath },
      bindOutput: { name: bindingName, path: "output.contents", normalize: "trim" },
      subgoal: `Read ${filePath}`
    },
    localSteps: [
      { capability: "application.launch", inputs: { application: destination } },
      { capability: "window.wait", inputs: { application: destination, timeoutMs: 10000 } },
      { capability: "ui.find", inputs: { application: destination, selector: { name: target, controlType: "Edit" } } },
      {
        capability: "ui.action",
        inputs: { application: destination, target: "$last.output.target", action: "type", text: `$binding.${bindingName}` }
      },
      {
        capability: "ui.verifyValue",
        inputs: { application: destination, selector: { name: target, controlType: "Edit" }, expected: `$binding.${bindingName}` },
        completesGoal: true,
        completionResult: { summary: `The file value was transferred to ${destination} and independently verified.` }
      }
    ],
    source: "GENERIC_INTERNAL_TO_GUI_COMPOSITION",
    bindingName,
    destination,
    target,
    filePath
  };
}

export function buildBrowserCompositionStrategy(goal) {
  const text = String(goal ?? "").trim();
  const dataUrl = (text.match(/\bdata:text\/html,[^\s"'`;]+/i)?.[0]
    ?? text.match(/\b(data:text\/html,[\s\S]*?)(?=\s+(?:in\s+(?:a|the)\s+browser\b|(?:(?:and\s+)?then\s+)?(?:save|store|persist|write|copy|enter|put)\b))/i)?.[1])
    ?.replace(/^["']|["'.,;]+$/g, "") ?? null;
  const explicitUrl = dataUrl ?? text.match(/\bhttps?:\/\/[^\s"'`,;]+/i)?.[0] ?? null;
  const domain = explicitUrl
    ? (explicitUrl.startsWith("data:") ? "local-browser-document" : new URL(explicitUrl).hostname)
    : text.match(/\b(?:open|visit|browse|from|website|webpage|site)\s+(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=\/|\s|[.,;]|$)/i)?.[1];
  const filePath = text.match(/\b(?:save|store|persist|write)\b[\s\S]*?\b(?:to|as|in)\s+["']([^"']+\.[a-z0-9]{1,8})["']/i)?.[1];
  if (!domain || !filePath || !/\b(?:browser|page|website|web)\b/i.test(text) || !/\btitle\b/i.test(text)) return null;
  const target = text.match(/\b(?:into|in)\s+(?:the\s+)?["']([^"']+)["']\s+(?:field|control|box)/i)?.[1] ?? null;
  const destination = target
    ? text.match(new RegExp(`["']${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s+(?:field|control|box)\\s+in\\s+([a-z][a-z0-9 ._-]{0,40}?)(?=,|\\s+and\\b|\\s+then\\b|$)`, "i"))?.[1]?.trim()
    : null;
  const bindingName = "browserValue";
  const localSteps = [
    {
      capability: "browser.currentState",
      inputs: {},
      bindOutput: { name: bindingName, path: "output.title", normalize: "trim" },
      subgoal: `Extract the page title from ${domain}`
    },
    {
      capability: "filesystem.write",
      inputs: { filePath, content: `$binding.${bindingName}` },
      subgoal: `Write the exact browser title to ${filePath}`
    },
    {
      capability: "filesystem.read",
      inputs: { filePath },
      subgoal: `Verify ${filePath}`
    }
  ];
  if (target && destination) {
    localSteps.push(
      { capability: "application.launch", inputs: { application: destination } },
      { capability: "window.wait", inputs: { application: destination, timeoutMs: 10000 } },
      { capability: "ui.find", inputs: { application: destination, selector: { name: target, controlType: "Edit" } } },
      {
        capability: "ui.action",
        inputs: { application: destination, target: "$last.output.target", action: "type", text: `$binding.${bindingName}` }
      },
      {
        capability: "ui.verifyValue",
        inputs: { application: destination, selector: { name: target, controlType: "Edit" }, expected: `$binding.${bindingName}` },
        completesGoal: true,
        completionResult: { summary: `The browser title was persisted and transferred to ${destination}.` }
      }
    );
  } else {
    localSteps.at(-1).completesGoal = true;
    localSteps.at(-1).completionResult = { summary: `The browser title was written to ${filePath} and read back.` };
  }
  return {
    action: { capability: "browser.launch", inputs: { url: explicitUrl ?? `https://${domain}`, headless: true }, subgoal: `Open ${domain}` },
    localSteps,
    source: "GENERIC_BROWSER_COMPOSITION",
    bindingName,
    destination,
    domain
  };
}

export function buildGuiToInternalStrategy(goal) {
  const text = String(goal ?? "").trim();
  if (/\b(?:browser|webpage|website|url)\b/i.test(text)) return null;
  const application = text.match(/^\s*(?:please\s+)?(?:open|launch|start)\s+(.+?)(?=,\s*|\s+(?:and\s+)?(?:read|obtain|extract|get)\b)/i)?.[1]?.trim();
  const extraction = text.match(/\b(?:read|obtain|extract|get)\s+(.+?)(?=,\s*(?:and\s+)?(?:save|store|persist|write)\b|\s+(?:and\s+)?(?:save|store|persist|write)\b)/i)?.[1]?.trim();
  const filePath = text.match(/\b(?:save|store|persist|write)\b[\s\S]*?\b(?:to|as|in)\s+["']([^"']+\.[a-z0-9]{1,8})["']/i)?.[1];
  if (!application || !extraction || !filePath) return null;
  const bindingName = "guiValue";
  return {
    action: {
      capability: "application.launch",
      inputs: { application },
      subgoal: `Open ${application}`
    },
    localSteps: [
      {
        capability: "ui.extract",
        inputs: {
          application,
          windowId: "$last.output.windowIdentity.windowId",
          query: extraction
        },
        bindOutput: {
          name: bindingName,
          path: "output.value",
          normalize: "trim",
          expectedType: "string",
          requiredSourceCapability: "ui.extract"
        },
        subgoal: `Extract ${extraction} from ${application}`
      },
      {
        capability: "filesystem.write",
        inputs: { filePath, content: `$binding.${bindingName}` },
        subgoal: `Save the exact GUI value to ${filePath}`
      },
      {
        capability: "filesystem.read",
        inputs: { filePath },
        subgoal: `Independently verify ${filePath}`,
        completesGoal: true,
        completionResult: { summary: `The typed GUI value was saved to ${filePath} and independently read back.` }
      }
    ],
    source: "GENERIC_GUI_TO_INTERNAL_COMPOSITION",
    bindingName,
    application,
    filePath
  };
}

// Sub-step verbs whose effect the runtime can predict and verify on its own
// (grounded target + durable screen diff), so resolving them never needs to
// cost a model call.  This mirrors the planner's DIRECT_OPERATION shortcut, but
// applies it to the *sub-steps* of an interactive session rather than only to
// top-level intent routing.
export const DETERMINISTIC_SUBGOAL_VERBS = Object.freeze(
  new Set(["type", "click", "select", "screenshot", "scroll", "press"])
);

const COMPOUND_STEP_PATTERNS = Object.freeze([
  { verb: "launch", pattern: /^(?:please\s+)?(?:open|launch|start|run)\s+(?:the\s+)?(?:windows\s+)?(.+?)\s*$/i, field: "application" },
  { verb: "screenshot", pattern: /^(?:(?:take|capture|grab|get)\s+)?(?:a\s+|the\s+)?screen\s?shot(?:\s+(?:of|for)\s+(.+))?\s*$/i, field: "subject" },
  { verb: "screenshot", pattern: /^capture\s+the\s+screen\s*$/i },
  { verb: "type", pattern: /^(?:type|enter|write|input)\s+(?:in\s+|into\s+)?(.+?)\s*$/i, field: "text" },
  { verb: "press", pattern: /^press\s+((?:ctrl|control|alt|shift|win|enter|return|tab|escape|esc|backspace|delete|f\d{1,2})\b.*?)\s*$/i, field: "keys" },
  { verb: "scroll", pattern: /^scroll\s+(up|down|left|right)\b.*$/i, field: "direction" },
  { verb: "click", pattern: /^(?:click|press|invoke|tap|push)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|control|link|option|item))?\s*$/i, field: "targetName" },
  { verb: "select", pattern: /^(?:select|choose)\s+(?:the\s+)?(.+?)(?:\s+(?:tab|option|item|control|section))?\s*$/i, field: "targetName" }
]);

/**
 * Split a compound natural-language desktop request into ordered, typed
 * sub-steps.  Quoted spans are masked before splitting so that a literal
 * "type 'hello and goodbye'" is not torn apart by the conjunction splitter.
 *
 * Returns null unless EVERY segment maps to a known verb: a partially
 * understood request must fall through to the existing strategies rather than
 * silently dropping a clause the user asked for.
 */
export function parseCompoundDesktopRequest(goal) {
  const raw = String(goal ?? "").trim();
  if (!raw) return null;
  const quoted = [];
  const masked = raw.replace(/(["'])([^"']*)\1/g, (_match, _quote, inner) => {
    quoted.push(inner);
    return ` ${quoted.length - 1} `;
  });
  const unmask = (value) =>
    String(value ?? "").replace(/ (\d+) /g, (_match, index) => quoted[Number(index)] ?? "");
  const segments = masked
    .split(/\s*[,;]\s*(?:and\s+|then\s+)?|\s+and\s+then\s+|\s+and\s+|\s+then\s+/i)
    .map((segment) => segment.trim().replace(/[.\s]+$/, ""))
    .filter(Boolean);
  if (segments.length < 2) return null;
  const steps = [];
  for (const segment of segments) {
    const matched = COMPOUND_STEP_PATTERNS
      .map((candidate) => ({ candidate, match: segment.match(candidate.pattern) }))
      .find((entry) => entry.match);
    if (!matched) return null;
    const { candidate, match } = matched;
    const value = candidate.field ? unmask(match[1] ?? "").trim() : null;
    if (candidate.field && candidate.field !== "subject" && !value) return null;
    steps.push({
      verb: candidate.verb,
      ...(candidate.field ? { [candidate.field]: value } : {}),
      source: unmask(segment)
    });
  }
  return steps;
}

/**
 * Compile a fully understood compound desktop request into one composition
 * graph up front.  Every sub-step is mechanically derivable from the request
 * plus runtime grounding, so the whole task executes with ZERO model calls
 * instead of spending one reasoning call per micro-decision.
 */
export function buildDeterministicCompoundStrategy(goal) {
  const steps = parseCompoundDesktopRequest(goal);
  if (!steps || steps.length < 2) return null;
  if (steps[0].verb !== "launch") return null;
  const application = steps[0].application;
  if (!application || /\b(?:file|folder|website|url|browser)\b/i.test(application)) return null;
  if (!steps.slice(1).every((step) => DETERMINISTIC_SUBGOAL_VERBS.has(step.verb))) return null;

  const localSteps = [
    {
      capability: "window.wait",
      inputs: { application, timeoutMs: 10000 },
      subgoal: `Wait for ${application} to present a window`,
      deterministicStepIndex: 0
    },
    {
      capability: "window.activate",
      inputs: { application },
      subgoal: `Focus ${application}`,
      deterministicStepIndex: 0
    }
  ];
  for (const [offset, step] of steps.slice(1).entries()) {
    localSteps.push(...compileDeterministicSubgoal(step, application, offset + 1));
  }
  const terminal = localSteps.at(-1);
  terminal.completesGoal = true;
  terminal.completionResult = {
    summary:
      `${application} was opened and every requested step ran under runtime verification: ` +
      `${steps.slice(1).map((step) => step.source).join("; ")}.`
  };
  return {
    action: {
      capability: "application.launch",
      inputs: { application },
      subgoal: `Open ${application}`,
      deterministicStepIndex: 0
    },
    localSteps,
    source: "DETERMINISTIC_COMPOUND_DESKTOP_COMPILER",
    application,
    steps
  };
}

function compileDeterministicSubgoal(step, application, stepIndex) {
  const tag = (action) => ({ ...action, deterministicStepIndex: stepIndex });
  if (step.verb === "type") {
    return [tag({
      capability: "keyboard.type",
      inputs: { application, text: step.text },
      subgoal: `Type the requested text into ${application}`,
      expectedEffect: `The text "${step.text}" becomes visible in the focused ${application} control.`
    })];
  }
  if (step.verb === "screenshot") {
    return [tag({
      capability: "screen.capture",
      inputs: { application },
      subgoal: "Capture a screenshot",
      expectedEffect: "A PNG of the current screen is written to a local capture path."
    })];
  }
  if (step.verb === "press") {
    return [tag({
      capability: "keyboard.press",
      inputs: { application, keys: step.keys },
      subgoal: `Send ${step.keys} to ${application}`
    })];
  }
  if (step.verb === "scroll") {
    const delta = ["up", "left"].includes(String(step.direction).toLowerCase()) ? 3 : -3;
    return [tag({
      capability: "pointer.wheel",
      inputs: { application, delta },
      subgoal: `Scroll ${step.direction}`
    })];
  }
  // click / select must consume a target the runtime actually grounded first.
  const verb = step.verb === "select" ? "select" : "click";
  return [
    tag({
      capability: "ui.find",
      inputs: { application, selector: { nameContains: step.targetName } },
      subgoal: `Ground the ${step.targetName} control`
    }),
    tag({
      capability: "ui.action",
      inputs: { application, target: "$last.output.target", action: verb },
      subgoal: `${verb === "select" ? "Select" : "Click"} ${step.targetName}`
    })
  ];
}

/**
 * Per-session model-call budget. A compound task legitimately needs more
 * reasoning headroom than a single-step one, so the budget varies by task
 * shape instead of being a flat global constant.
 */
export function computeSessionModelCallBudget(goal, strategy, floor = DEFAULT_BUDGETS.maxModelCalls) {
  const strategySteps = strategy ? 1 + (strategy.localSteps?.length ?? 0) : 0;
  const parsedSteps = parseCompoundDesktopRequest(goal)?.length ?? 0;
  const plannedSteps = Math.max(strategySteps, parsedSteps, 1);
  return Math.min(24, Math.max(floor, plannedSteps * 2));
}

export function buildExplicitApplicationLaunchStrategy(goal) {
  const text = String(goal ?? "").trim();
  const match = text.match(/^\s*(?:please\s+)?(?:open|launch|start)\s+(.+?)(?=\s+(?:and|then|to)\b|[.,;]|$)/i);
  if (!match) return null;
  let application = match[1].replace(/^(?:the\s+)?windows\s+/i, "").trim();
  if (!application || /\b(?:file|folder|website|url)\b/i.test(application)) return null;
  return {
    action: { capability: "application.launch", inputs: { application }, subgoal: `Open ${application}` },
    source: "EXPLICIT_APPLICATION_MECHANICAL_COMPILER",
    application
  };
}

function validateCompletionEvidence(data, initialContext, state, trustedLocalEvidence = null) {
  const requiredCriteria = Array.isArray(initialContext?.successCriteria)
    ? initialContext.successCriteria.filter(Boolean)
    : [];
  const satisfied = data?.verification?.satisfiedCriteria;
  const errors = [];
  if (!data?.result || typeof data.result !== "object") errors.push("completion result is missing");
  if (data?.verification?.allCriteriaSatisfied !== true) errors.push("all criteria were not explicitly satisfied");
  if (!Array.isArray(satisfied) || satisfied.length < requiredCriteria.length) {
    errors.push(`evidence is required for all ${requiredCriteria.length} success criteria`);
  } else {
    for (const [index, item] of satisfied.entries()) {
      if (!item || typeof item.criterion !== "string" || typeof item.evidence !== "string" || !item.evidence.trim()) {
        errors.push(`criterion evidence ${index} is incomplete`);
      }
    }
  }
  if (!state.recentActions.some((entry) => entry.succeeded)) {
    errors.push("no runtime-verified action supports completion");
  }
  if (initialContext?.goalContract?.enforceable) {
    const ledgerAssessment = evaluateEvidenceLedger(
      initialContext.goalContract,
      state.evidenceLedger,
      state.bindings
    );
    if (ledgerAssessment.satisfied) return { valid: errors.length === 0, errors, ledgerAssessment };
    const successfulActions = state.recentActions.filter((entry) => entry.succeeded);
    const contractEvidence = assessGoalContractEvidence(initialContext.goalContract, {
      taskGraph: { tasks: successfulActions.map((entry) => entry.action) },
      taskResults: successfulActions.map((entry) => ({
        capability: entry.action?.capability,
        executionResult: entry.executionResult
      })),
      verifications: successfulActions.map((entry) => entry.verification).filter(Boolean),
      observations: [
        trustedLocalEvidence ? { source: "trusted-local-completion", structuredState: trustedLocalEvidence } : null,
        state.transitionContracts?.length
          ? { source: "typed-transition-contracts", structuredState: state.transitionContracts }
          : null,
        state.currentPerception,
        ...state.recentObservations
      ].filter(Boolean)
    });
    if (!contractEvidence.satisfied) {
      errors.push(
        `independent goal evidence satisfies ${contractEvidence.satisfiedCount}/${contractEvidence.totalCriteria} criteria; ` +
        `missing: ${contractEvidence.unsatisfiedCriteria.join("; ")}`
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

const BUDGET_EXHAUSTION_REASONS = Object.freeze(
  new Set(["max-model-calls", "max-steps", "max-elapsed-time"])
);

/**
 * Evidence for an early clause must not be mistaken for evidence for the whole
 * request.  "Open Notepad and type X then take a screenshot" is not complete
 * once the text is typed: the screenshot is a clause the user explicitly asked
 * for.  Completion is therefore blocked while any compiled step of the request
 * is still queued or still unattempted.
 */
function outstandingRequestedSteps(state, pendingActions = []) {
  const queued = pendingActions.map((action) => action.capability);
  const plan = state.deterministicPlan;
  const unattempted = [];
  if (Array.isArray(plan)) {
    const attempted = new Set(
      (state.recentActions ?? [])
        .map((entry) => entry.action?.deterministicStepIndex)
        .filter(Number.isInteger)
    );
    for (const [index, step] of plan.entries()) {
      if (index > 0 && DETERMINISTIC_SUBGOAL_VERBS.has(step.verb) && !attempted.has(index)) {
        unattempted.push(step.source ?? step.verb);
      }
    }
  }
  return [...queued, ...unattempted];
}

/**
 * A budget ceiling is a limit on how much *reasoning* the session may spend, not
 * a statement that nothing was accomplished.  When the primary goal capability
 * already succeeded under runtime verification, discarding the evidence ledger
 * and reporting a bare failure loses real, audited progress.  Return the
 * partial-success shape instead so the caller can report
 * COMPLETED_WITH_WARNINGS with that evidence attached.
 *
 * Returns null when nothing was actually achieved — a genuine failure must
 * still surface as one.
 */
export function assessDegradedCompletion(state, reason) {
  const ledgerEntries = state?.evidenceLedger?.entries ?? [];
  if (!ledgerEntries.length) return null;
  const succeededActions = (state.recentActions ?? []).filter((entry) => entry.succeeded);
  if (!succeededActions.length) return null;
  const primaryPattern = /^(?:application\.launch|browser\.launch|process\.start|filesystem\.write|package\.)/;
  const primary = succeededActions.find((entry) => primaryPattern.test(String(entry.action?.capability ?? "")));
  if (!primary) return null;
  const completedCapabilities = succeededActions.map((entry) => entry.action?.capability);
  const attempted = (state.recentActions ?? [])
    .filter((entry) => !entry.succeeded)
    .map((entry) => entry.action?.capability);
  return {
    reason,
    result: {
      summary:
        `${primary.action.capability} completed and was runtime-verified, but the session reached its ` +
        `${reason} ceiling before every requested step could be confirmed.`,
      completedCapabilities,
      attemptedWithoutConfirmation: [...new Set(attempted)],
      evidenceIds: ledgerEntries.map((entry) => entry.evidenceId).filter(Boolean)
    },
    verification: {
      allCriteriaSatisfied: false,
      locallyEvaluated: true,
      partial: true,
      satisfiedCriteria: succeededActions.map((entry) => ({
        criterion: entry.action?.subgoal ?? entry.action?.capability,
        evidence: entry.verification?.message ?? `${entry.action?.capability} was runtime-verified`
      }))
    },
    warnings: [
      `Session stopped at the ${reason} budget ceiling before all requested steps were confirmed.`,
      ...(attempted.length ? [`Unconfirmed steps: ${[...new Set(attempted)].join(", ")}`] : [])
    ]
  };
}

/**
 * Bounded perceive -> decide -> act -> observe -> verify controller.
 *
 * It intentionally does not execute capabilities itself. `executeAction` is the
 * canonical runtime boundary and must perform validation, risk/policy,
 * permission, execution, observation and verification.
 */
export class InteractiveAgentController {
  constructor({
    reasoningEngine,
    capabilityRegistry,
    perceive,
    captureScreenSnapshot = null,
    executeAction,
    onEvent = null,
    budgets = {},
    now = () => Date.now()
  } = {}) {
    this.reasoningEngine = reasoningEngine;
    this.capabilityRegistry = capabilityRegistry;
    this.perceive = perceive;
    this.captureScreenSnapshot = captureScreenSnapshot;
    this.executeAction = executeAction;
    this.onEvent = onEvent;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    // An explicitly supplied ceiling is authoritative — the adaptive
    // per-session budget only applies when the caller left it to the default.
    this.explicitModelCallBudget = Object.hasOwn(budgets ?? {}, "maxModelCalls");
    this.now = now;
  }

  async emit(type, details = {}) {
    await this.onEvent?.({ type, timestamp: new Date().toISOString(), ...details });
  }

  _catalog(goal = "") {
    const normalizedGoal = String(goal).toLowerCase();
    const goalTokens = new Set(
      String(goal).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((token) =>
        !["and", "the", "with", "from", "then", "open", "tell"].includes(token)
      ) ?? []
    );
    const alwaysCore = /^(application\.launch|window\.(enumerate|resolve|wait|activate)|ui\.(inspect|find|extract|navigateSection|resolveTarget|verifyValue|action))$/;
    const browserGoal = /\b(browser|website|web|url)\b|\.(?:org|com|net)\b/.test(normalizedGoal);
    const modalityRelevant = (name) =>
      (browserGoal && /^(browser\.(launch|navigate|currentState|inspect|find|read|extract|wait))$/.test(name)) ||
      (browserGoal && /\b(click|submit|select|choose|fill|type)\b/.test(normalizedGoal) && /^(browser\.(click|type|select|scroll))$/.test(name)) ||
      (browserGoal && /\b(download (?:the )?file|save (?:the )?file|download to)\b/.test(normalizedGoal) && name === "browser.download") ||
      (name.startsWith("keyboard.") && /\b(type|enter|input|put|write|calculator|notepad)\b/.test(normalizedGoal)) ||
      (name.startsWith("pointer.") && /\b(click|drag|move|scroll|pointer|mouse)\b/.test(normalizedGoal)) ||
      (/^(screen|ocr|vision)\./.test(name) && /\b(visual|ocr|screen|screenshot|image)\b/.test(normalizedGoal)) ||
      (name === "window.moveResize" && /\b(move|resize)\b/.test(normalizedGoal));
    return (this.capabilityRegistry?.getCatalog?.() ?? [])
      .filter((capability) => {
        if (alwaysCore.test(capability.name) || modalityRelevant(capability.name)) return true;
        const explicitInternal =
          (/\b(file|directory|folder|save|store|persist|write)\b/.test(normalizedGoal) && capability.name.startsWith("filesystem.")) ||
          (/\b(process|executable|program)\b/.test(normalizedGoal) && capability.name.startsWith("process.")) ||
          (/\bclipboard\b/.test(normalizedGoal) && capability.name.startsWith("clipboard.")) ||
          (/\bvolume\b/.test(normalizedGoal) && capability.name === "system.volume.adjust");
        const customNamespace = !/^(application|window|ui|browser|keyboard|pointer|screen|ocr|vision|filesystem|process|clipboard|system|gui)\./.test(capability.name);
        const customNameMatch = customNamespace && [...goalTokens].some((token) => capability.name.toLowerCase().includes(token));
        return explicitInternal || customNameMatch;
      })
      .map((capability) => ({
      name: capability.name,
      description: capability.description,
      inputs: Object.fromEntries(
        Object.entries(capability.inputSchema?.properties ?? {}).map(([name, schema]) => [
          name,
          {
            type: schema.type,
            ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {})
          }
        ])
      ),
      requiredInputs: capability.inputSchema?.required ?? [],
      modality: capability.execution?.modality,
      modalities: capability.execution?.modalities
      }));
  }

  _validateAction(action, observedTargetIds = null) {
    if (!action || typeof action !== "object") return { valid: false, errors: ["action is required"] };
    const capability = this.capabilityRegistry?.get?.(action.capability);
    if (!capability) return { valid: false, errors: [`unknown capability: ${action.capability}`] };
    const validation = validateSchema(action.inputs ?? {}, capability.inputSchema ?? { type: "object" });
    const errors = [...(validation.errors ?? [])];
    const groundedFields = action.capability === "pointer.drag"
      ? ["fromTarget", "toTarget"]
      : (["ui.action", "pointer.click", "browser.click", "browser.type", "browser.select", "browser.download"].includes(action.capability) ? ["target"] : []);
    for (const field of groundedFields) {
      const target = action.inputs?.[field];
      if (!target?.targetId || !observedTargetIds?.has(target.targetId)) {
        errors.push(`${field} was not present in runtime-observed state`);
      }
    }
    if (action.capability === "ui.action" && action.inputs?.target?.source === "UIA") {
      const requested = canonicalUiActionName(action.inputs?.action);
      const supported = supportedUiActions(action.inputs.target);
      if (!supported.includes(requested)) {
        errors.push(
          `${InteractiveConvergenceState.UNSUPPORTED_ACTION}: ${requested} is not exposed by ` +
          `${action.inputs.target.name ?? action.inputs.target.automationId ?? "the grounded target"} ` +
          `(supported: ${supported.join(", ") || "none"})`
        );
      }
      if (requested === "setValue" && typeof action.inputs?.text !== "string") {
        errors.push(`${InteractiveConvergenceState.UNSUPPORTED_ACTION}: setValue requires text`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Resolve the next unsatisfied deterministic sub-step of a parsed compound
   * request without consulting the model.
   *
   * Deliberately conservative: it only fires when the surface is already
   * grounded, and it attempts any given sub-step at most once through this
   * path, so a step the runtime cannot actually land still escalates to the
   * model instead of spinning.
   */
  _resolveDeterministicContinuation(state, perception) {
    const plan = state.deterministicPlan;
    if (!Array.isArray(plan) || plan.length < 2) return null;
    const grounded = perception?.groundedWindow ?? perception?.foregroundWindow ?? null;
    if (!grounded) return null;
    const application = plan[0]?.verb === "launch"
      ? plan[0].application
      : (grounded.ProcessName ?? grounded.processName ?? null);
    if (!application) return null;

    const satisfied = new Set(
      (state.recentActions ?? [])
        .filter((entry) => entry.succeeded && Number.isInteger(entry.action?.deterministicStepIndex))
        .map((entry) => entry.action.deterministicStepIndex)
    );
    // The launch step is proven by the window actually being grounded.
    satisfied.add(0);

    const nextIndex = plan.findIndex((step, index) =>
      index > 0 && DETERMINISTIC_SUBGOAL_VERBS.has(step.verb) && !satisfied.has(index)
    );
    if (nextIndex === -1) return null;
    const attempts = state.deterministicAttempts.get(nextIndex) ?? 0;
    if (attempts >= 1) return null;
    state.deterministicAttempts.set(nextIndex, attempts + 1);

    // Emit the whole remaining deterministic tail in one batch so the queue
    // drains without returning to the model between steps.
    const remaining = [];
    for (let index = nextIndex; index < plan.length; index += 1) {
      const step = plan[index];
      if (!DETERMINISTIC_SUBGOAL_VERBS.has(step.verb)) break;
      remaining.push(...compileDeterministicSubgoal(step, application, index));
    }
    if (!remaining.length) return null;
    return remaining.filter((action) => Boolean(this.capabilityRegistry?.get?.(action.capability)));
  }

  async run(goal, initialContext = {}) {
    if (typeof this.perceive !== "function" || typeof this.executeAction !== "function") {
      throw new Error("InteractiveAgentController requires perceive and executeAction");
    }
    const startedAt = this.now();
    const state = {
      goal: String(goal ?? "").trim(),
      status: "IN_PROGRESS",
      completedSubgoals: [],
      semanticState: {},
      bindings: {},
      recentActions: [],
      recentObservations: [],
      recentModelObservations: [],
      transitionContracts: [],
      evidenceLedger: createEvidenceLedger(),
      failedAttempts: [],
      unsupportedAttempts: [],
      modelCalls: 0,
      steps: 0,
      recoveries: 0,
      metrics: {
        firstActionMs: null,
        uiActions: 0,
        localActions: 0,
        retries: 0,
        fallbacks: 0,
        intentCalls: 0,
        planningCalls: 0,
        adaptiveCalls: 0,
        repairCalls: 0,
        recoveryCalls: 0,
        totalModelCalls: 0,
        modelLatencyMs: 0
      },
      observability: {
        provider: this.reasoningEngine?.modelProvider?.provider?.providers?.[0]?.name
          ?? this.reasoningEngine?.modelProvider?.provider?.name
          ?? this.reasoningEngine?.modelProvider?.name
          ?? "none",
        model: this.reasoningEngine?.modelProvider?.provider?.providers?.[0]?.model
          ?? this.reasoningEngine?.modelProvider?.provider?.model
          ?? this.reasoningEngine?.modelProvider?.model
          ?? null,
        modelCalls: [],
        modalities: [],
        deterministicRecoveryAttempts: [],
        uiaActions: 0,
        ocrFallbacks: 0,
        browserActions: 0,
        internalActions: 0,
        verificationEvidence: []
      },
      currentPerception: null
    };
    const repetitions = new Map();
    const exhaustedActionPairs = new Map();
    let pendingActions = [];
    let lastPerception = null;
    let lastOutcome = null;
    const completedNodes = new Set();
    await this.emit("ADAPTIVE_CONTROLLER_STARTED", { goal: state.goal, budgets: this.budgets });

    const initialStrategy = buildSupportedUiOperationStrategy(state.goal)
      ?? buildSupportedTextEntryStrategy(state.goal)
      ?? buildSupportedReadOnlyNavigationStrategy(state.goal)
      ?? buildSupportedBrowserReadStrategy(state.goal)
      ?? buildSupportedRankedProcessReadStrategy(state.goal)
      ?? buildBrowserCompositionStrategy(state.goal)
      ?? buildGuiToInternalStrategy(state.goal)
      ?? buildInternalToGuiTransferStrategy(state.goal)
      ?? buildCrossModalTransferStrategy(state.goal)
      ?? buildDeterministicCompoundStrategy(state.goal)
      ?? buildExplicitApplicationLaunchStrategy(state.goal);
    // A compound request needs more reasoning headroom than a single-step one.
    // Derive the ceiling from the plan's shape at session start rather than
    // relying on a flat global constant.
    state.deterministicPlan = parseCompoundDesktopRequest(state.goal);
    state.deterministicAttempts = new Map();
    const budgets = {
      ...this.budgets,
      maxModelCalls: this.explicitModelCallBudget
        ? this.budgets.maxModelCalls
        : computeSessionModelCallBudget(state.goal, initialStrategy, this.budgets.maxModelCalls)
    };
    state.budgets = budgets;
    await this.emit("ADAPTIVE_SESSION_BUDGET_RESOLVED", {
      maxModelCalls: budgets.maxModelCalls,
      baselineMaxModelCalls: this.budgets.maxModelCalls,
      plannedSteps: (initialStrategy ? 1 + (initialStrategy.localSteps?.length ?? 0) : 0),
      parsedSteps: state.deterministicPlan?.length ?? 0
    });
    if (initialStrategy) {
      if (String(initialStrategy.source ?? "").startsWith("SUPPORTED_")) {
        const terminalStep = initialStrategy.localSteps?.at(-1);
        if (terminalStep?.completesGoal === true) {
          terminalStep.criterionIds = (initialContext.goalContract?.criteria ?? [])
            .map((criterion) => criterion.criterionId)
            .filter(Boolean);
        }
      }
      const graph = createCompositionGraph(
        [initialStrategy.action, ...(initialStrategy.localSteps ?? [])],
        { id: initialStrategy.source.toLowerCase() }
      );
      const graphValidation = validateCompositionGraph(graph, {
        capabilityExists: (name) => Boolean(this.capabilityRegistry?.get?.(name))
      });
      if (!graphValidation.valid) {
        state.status = "FAILED";
        state.reason = "invalid-composition-graph";
        state.failedAttempts.push({ action: "COMPILE", reason: graphValidation.errors.join(", ") });
        await this.emit("ADAPTIVE_COMPOSITION_REJECTED", { errors: graphValidation.errors, graph });
      } else {
        pendingActions = graph.nodes;
        state.compositionGraph = graph;
      }
      await this.emit("ADAPTIVE_MECHANICAL_STRATEGY_COMPILED", {
        source: initialStrategy.source,
          capabilities: graph.nodes.map((action) => action.capability),
        bindingName: initialStrategy.bindingName,
        destination: initialStrategy.destination,
        domain: initialStrategy.domain,
        kind: initialStrategy.kind
      });
    }

    while (!TERMINAL.has(state.status)) {
      const elapsed = this.now() - startedAt;
      if (elapsed >= this.budgets.maxElapsedTime || state.steps >= this.budgets.maxSteps) {
        state.status = "FAILED";
        state.reason = elapsed >= this.budgets.maxElapsedTime ? "max-elapsed-time" : "max-steps";
        break;
      }
      if (state.failedAttempts.length >= this.budgets.maxFailedActions) {
        state.status = "FAILED";
        state.reason = "max-failed-actions";
        break;
      }

      lastPerception = await this.perceive({
        goal: state.goal,
        semanticState: state.semanticState,
        recentActions: state.recentActions.slice(-6)
      });
      state.currentPerception = lastPerception;
      const fingerprint = stateFingerprint(lastPerception);
      for (const [pairKey, exhaustedFingerprint] of exhaustedActionPairs) {
        if (exhaustedFingerprint !== "UNSUPPORTED" && exhaustedFingerprint !== fingerprint) {
          exhaustedActionPairs.delete(pairKey);
        }
      }
      await this.emit("ADAPTIVE_PERCEIVED", {
        step: state.steps,
        stateFingerprint: fingerprint,
        summary: sanitizeInteractiveState(lastPerception)
      });

      const localCompletion = evaluateSubgoalCompletion(
        state.goal,
        [lastPerception, ...state.recentObservations.slice(-4)],
        state.recentActions.slice(-4),
        state.bindings
      );
      const outstandingAtTopOfLoop = outstandingRequestedSteps(state, pendingActions);
      if (outstandingAtTopOfLoop.length && localCompletion.status === "COMPLETE") {
        await this.emit("ADAPTIVE_COMPLETION_DEFERRED", {
          reason: "requested steps remain unattempted",
          outstanding: outstandingAtTopOfLoop
        });
      }
      if (
        localCompletion.status === "COMPLETE" &&
        !outstandingAtTopOfLoop.length &&
        state.recentActions.some((entry) => entry.succeeded)
      ) {
        const proposedVerification = {
          allCriteriaSatisfied: true,
          locallyEvaluated: true,
          satisfiedCriteria: (initialContext.successCriteria ?? [state.goal]).map((criterion) => ({
            criterion,
            evidence: localCompletion.evidence
          }))
        };
        const completion = validateCompletionEvidence({
          result: localCompletion.result,
          verification: proposedVerification
        }, initialContext, state, localCompletion);
        if (completion.valid) {
          state.status = "COMPLETE";
          state.result = localCompletion.result;
          state.completionVerification = proposedVerification;
          await this.emit("ADAPTIVE_LOCAL_EVIDENCE_COMPLETED", { result: state.result, verification: state.completionVerification });
          break;
        }
      }

      if (pendingActions.length === 0) {
        const groundedTarget = lastOutcome?.output?.target;
        const priorAction = state.recentActions.at(-1);
        const requestsInteraction = /\b(click|invoke|press|select|choose|toggle|expand|open)\b/i.test(state.goal);
        if (
          groundedTarget?.targetId &&
          priorAction?.succeeded &&
          ["ui.find", "ui.resolveTarget", "vision.locate"].includes(priorAction.action?.capability) &&
          requestsInteraction
        ) {
          const verbs = supportedUiActions(groundedTarget)
            .filter((verb) => !["setValue", "type"].includes(verb));
          const verb = verbs[0] ?? null;
          const pairKey = verb ? `${stableTargetKey(groundedTarget)}|${verb}` : null;
          if (verb && !exhaustedActionPairs.has(pairKey)) pendingActions = [{
            capability: "ui.action",
            inputs: {
              application: groundedTarget.windowIdentity?.processName,
              windowId: groundedTarget.windowId,
              target: groundedTarget,
              action: verb
            },
            subgoal: `Interact with grounded ${groundedTarget.name ?? "target"}`,
            convergencePairKey: pairKey,
            mechanicallySelected: true
          }];
          if (verb) await this.emit("ADAPTIVE_GROUNDED_ACTION_CHAINED", {
            from: priorAction.action.capability,
            targetId: groundedTarget.targetId,
            action: verb
          });
        }
      }

      if (pendingActions.length === 0) {
        const mechanical = chooseMechanicalContinuation(state.goal, lastPerception, exhaustedActionPairs);
        if (mechanical) {
          pendingActions = [mechanical];
          await this.emit("ADAPTIVE_MECHANICAL_CONTINUATION", { action: mechanical });
        }
      }

      if (pendingActions.length === 0) {
        if (state.modelCalls >= this.budgets.maxModelCalls) {
          state.status = "FAILED";
          state.reason = "max-model-calls";
          break;
        }
        const decisionStarted = this.now();
        const groundedActionCandidates = enumerateGroundedActionCandidates(
          state.goal,
          lastPerception,
          exhaustedActionPairs
        ).slice(0, 24);
        const decision = await this.reasoningEngine.decideInteractiveAction({
          reasoningPhase: state.modelCalls === 0 ? "INITIAL_STRATEGY" : "RECOVERY",
          goal: state.goal,
          completedSubgoals: state.completedSubgoals,
          currentState: lastPerception,
          semanticState: state.semanticState,
          bindings: state.bindings,
          recentActions: state.recentActions.slice(-8),
          recentObservations: state.recentModelObservations.slice(-8),
          failedAttempts: [
            ...state.failedAttempts.slice(-4),
            ...state.unsupportedAttempts.slice(-4)
          ],
          groundedActionCandidates: groundedActionCandidates.map((candidate) => ({
            capability: candidate.capability,
            inputs: {
              action: candidate.inputs.action,
              target: candidate.inputs.target
            },
            expectedPostcondition: candidate.expectedPostcondition
          })),
          availableCapabilities: this._catalog(state.goal),
          remainingBudgets: {
            steps: this.budgets.maxSteps - state.steps,
            modelCalls: this.budgets.maxModelCalls - state.modelCalls,
            elapsedMs: this.budgets.maxElapsedTime - elapsed,
            recovery: this.budgets.recoveryBudget - state.recoveries
          },
          initialContext: sanitizeInteractiveState(initialContext)
        });
        const decisionLatencyMs = this.now() - decisionStarted;
        state.metrics.modelLatencyMs += decisionLatencyMs;
        state.modelCalls += 1;
        state.metrics.adaptiveCalls += 1;
        state.metrics.totalModelCalls += 1;
        await this.emit("ADAPTIVE_DECIDED", {
          step: state.steps,
          ok: decision?.ok === true,
          decision: sanitizeInteractiveState(decision?.data ?? { error: decision?.error })
        });
        if (!decision?.ok) {
          state.status = "FAILED";
          state.reason = decision?.error ?? "reasoning-unavailable";
          break;
        }
        const normalizedDecision = normalizeInteractiveDecision(decision.data);
        if (!normalizedDecision.ok) {
          state.status = "FAILED";
          state.reason = normalizedDecision.errors.join(", ");
          break;
        }
        const data = normalizedDecision.data;
        state.observability.modelCalls.push({
          call: state.modelCalls,
          latencyMs: decisionLatencyMs,
          decisionType: data.kind,
          phase: state.modelCalls === 1 ? "INITIAL_STRATEGY" : "RECOVERY"
        });
        if (data.kind === InteractiveDecisionKind.COMPLETE) {
          const completion = validateCompletionEvidence(data, initialContext, state);
          if (completion.valid) {
            state.status = "COMPLETE";
            state.result = data.result;
            state.completionVerification = data.verification;
            break;
          }
          state.failedAttempts.push({ action: "COMPLETE", reason: completion.errors.join(", ") });
          await this.emit("ADAPTIVE_COMPLETION_REJECTED", { errors: completion.errors });
          continue;
        }
        if (data.kind === InteractiveDecisionKind.CLARIFY) {
          if (groundedActionCandidates.length > 0 && state.recoveries < this.budgets.recoveryBudget) {
            state.recoveries += 1;
            state.unsupportedAttempts.push({
              action: "CLARIFY",
              reason:
                `${InteractiveConvergenceState.RECOVERABLE}: clarification was rejected because ` +
                `${groundedActionCandidates.length} grounded supported action candidates remain`
            });
            state.semanticState.interactiveConvergence = InteractiveConvergenceState.RECOVERABLE;
            await this.emit("ADAPTIVE_PREMATURE_ESCALATION_REJECTED", {
              requested: "CLARIFY",
              convergenceState: InteractiveConvergenceState.RECOVERABLE,
              remainingCandidates: groundedActionCandidates.length
            });
            continue;
          }
          state.status = "NEEDS_USER";
          state.reason = data.question ?? "User input is required";
          break;
        }
        if (data.kind === InteractiveDecisionKind.FAIL) {
          state.status = "FAILED";
          state.reason = data.reason ?? "Goal cannot be completed safely";
          break;
        }
        if (data.kind === InteractiveDecisionKind.OBSERVE) {
          state.recoveries += 1;
          state.metrics.recoveryCalls += 1;
          await this.emit("ADAPTIVE_OBSERVATION_REQUESTED", {
            reason: data.reason,
            requestedPerception: data.requestedPerception
          });
          continue;
        }
        if (data.kind === InteractiveDecisionKind.RECOVER) {
          state.recoveries += 1;
          state.metrics.recoveryCalls += 1;
          state.failedAttempts.push({ action: "RECOVER", reason: data.reason, strategy: data.strategy });
          await this.emit("ADAPTIVE_RECOVERY_REQUESTED", {
            reason: data.reason,
            strategy: data.strategy
          });
          continue;
        }
        const catalog = this.capabilityRegistry?.getCatalog?.() ?? [];
        const proposedActions = [data.action, ...(data.localSteps ?? [])].filter(Boolean).map((action, index) => ({
          ...action,
          subgoal: action.subgoal ?? data.subgoal,
          expectedEffect: action.expectedEffect ?? data.expectedEffect,
          verification: action.verification ?? data.verification,
          fallback: index === 0 ? (data.fallback ?? []) : (action.fallback ?? [])
        })).map((action) => {
          const canonical = canonicalizeCapabilityAction(action, catalog);
          return canonical.ok ? canonical.action : action;
        }).filter((action, index, actions) => {
          if (index === 0) return true;
          const prior = actions[index - 1];
          return action.capability !== prior.capability
            || JSON.stringify(action.inputs ?? {}) !== JSON.stringify(prior.inputs ?? {});
        });
        const proposedGraph = createCompositionGraph(proposedActions, { id: `model:${state.modelCalls}` });
        const proposedValidation = validateCompositionGraph(proposedGraph, {
          capabilityExists: (name) => Boolean(this.capabilityRegistry?.get?.(name))
        });
        if (!proposedValidation.valid) {
          state.failedAttempts.push({ action: "COMPILE", reason: proposedValidation.errors.join(", ") });
          await this.emit("ADAPTIVE_COMPOSITION_REJECTED", { errors: proposedValidation.errors, graph: proposedGraph });
          continue;
        }
        pendingActions = proposedGraph.nodes;
      }

      const queuedAction = pendingActions.shift();
      const missingDependency = (queuedAction.dependsOn ?? []).find((nodeId) => !completedNodes.has(nodeId));
      const missingBinding = (queuedAction.requiresBindings ?? []).find((name) => !Object.hasOwn(state.bindings, name));
      if (missingDependency || missingBinding) {
        state.failedAttempts.push({
          action: queuedAction,
          reason: missingDependency
            ? `dependency ${missingDependency} has not completed`
            : `required binding ${missingBinding} is unavailable`
        });
        pendingActions = [];
        await this.emit("ADAPTIVE_COMPOSITION_BLOCKED", {
          nodeId: queuedAction.nodeId,
          missingDependency: missingDependency ?? null,
          missingBinding: missingBinding ?? null
        });
        continue;
      }
      const action = normalizeUiAction(hydrateGroundedActionTarget({
        ...queuedAction,
        inputs: resolveRuntimeReferences(queuedAction.inputs ?? {}, lastOutcome, state.bindings)
      }, [lastPerception, ...state.recentObservations.slice(-4)]));
      const consumedBindings = (queuedAction.requiresBindings ?? [])
        .map((name) => state.bindings[name]?.bindingId ?? name);
      const observedTargetIds = collectTargetIds([lastPerception, ...state.recentObservations]);
      const validation = this._validateAction(action, observedTargetIds);
      if (!validation.valid) {
        const unsupported = validation.errors.some((error) =>
          String(error).includes(InteractiveConvergenceState.UNSUPPORTED_ACTION)
        ) && !validation.errors.some((error) => String(error).includes("was not present in runtime-observed state"));
        if (unsupported) {
          const pairKey = actionPairKey(action);
          if (pairKey) exhaustedActionPairs.set(pairKey, "UNSUPPORTED");
          state.unsupportedAttempts.push({
            action: {
              capability: action.capability,
              inputs: {
                action: action.inputs?.action,
                target: {
                  targetId: action.inputs?.target?.targetId,
                  name: action.inputs?.target?.name,
                  automationId: action.inputs?.target?.automationId
                }
              }
            },
            reason: validation.errors.join(", ")
          });
          state.semanticState.interactiveConvergence = InteractiveConvergenceState.UNSUPPORTED_ACTION;
        } else {
          state.failedAttempts.push({ action, reason: validation.errors.join(", ") });
        }
        pendingActions = [];
        await this.emit("ADAPTIVE_ACTION_REJECTED", {
          action,
          errors: validation.errors,
          convergenceState: unsupported ? InteractiveConvergenceState.UNSUPPORTED_ACTION : null
        });
        continue;
      }
      const proposedPairKey = actionPairKey(action);
      if (proposedPairKey && exhaustedActionPairs.has(proposedPairKey)) {
        pendingActions = [];
        state.semanticState.interactiveConvergence = InteractiveConvergenceState.TARGET_EXHAUSTED;
        state.unsupportedAttempts.push({
          action: {
            capability: action.capability,
            inputs: {
              action: action.inputs?.action,
              target: {
                targetId: action.inputs?.target?.targetId,
                name: action.inputs?.target?.name,
                automationId: action.inputs?.target?.automationId
              }
            }
          },
          reason:
            `${InteractiveConvergenceState.TARGET_EXHAUSTED}: the same target/action pair previously ` +
            "produced no observable progress and cannot be executed again until state changes"
        });
        await this.emit("ADAPTIVE_TARGET_EXHAUSTED", {
          action,
          pairKey: proposedPairKey,
          convergenceState: InteractiveConvergenceState.TARGET_EXHAUSTED
        });
        continue;
      }
      const expectedUiPostcondition = predictUiPostcondition(action, lastPerception);
      if (action.capability === "ui.action") {
        state.semanticState.interactiveConvergence = InteractiveConvergenceState.SUPPORTED_ACTION;
        await this.emit("ADAPTIVE_SUPPORTED_ACTION", {
          action,
          expectedPostcondition: expectedUiPostcondition
        });
      }
      const signature = actionSignature(action, fingerprint);
      const repeatCount = (repetitions.get(signature) ?? 0) + 1;
      repetitions.set(signature, repeatCount);
      if (repeatCount > this.budgets.maxRepeatedActions) {
        const pairKey = actionPairKey(action);
        if (pairKey) {
          exhaustedActionPairs.set(pairKey, fingerprint);
          pendingActions = [];
          state.semanticState.interactiveConvergence = InteractiveConvergenceState.TARGET_EXHAUSTED;
          await this.emit("ADAPTIVE_TARGET_EXHAUSTED", { action, pairKey, signature, repeatCount });
          continue;
        }
        state.status = "FAILED";
        state.reason = "repeated-action-loop";
        await this.emit("ADAPTIVE_LOOP_DETECTED", { action, signature, repeatCount });
        break;
      }

      const actionStarted = this.now();
      if (state.metrics.firstActionMs == null) state.metrics.firstActionMs = actionStarted - startedAt;
      state.steps += 1;
      state.metrics.localActions += 1;
      if (/^(ui|pointer|keyboard|window)\./.test(action.capability)) state.metrics.uiActions += 1;
      const capabilityContract = this.capabilityRegistry?.get?.(action.capability);
      const modality = action.modality
        ?? capabilityContract?.execution?.preferredModality
        ?? capabilityContract?.execution?.modality
        ?? (/^browser\./.test(action.capability) ? "BROWSER_DOM"
          : /^(ui|window|pointer|keyboard)\./.test(action.capability) ? "UI_AUTOMATION"
            : /^(ocr|vision|screen)\./.test(action.capability) ? "VISION_GUI"
              : "INTERNAL");
      state.observability.modalities.push({
        step: state.steps,
        subgoal: action.subgoal ?? null,
        capability: action.capability,
        modality
      });
      if (/^browser\./.test(action.capability)) state.observability.browserActions += 1;
      else if (/^(ocr|vision|screen)\./.test(action.capability)) state.observability.ocrFallbacks += 1;
      else if (/^(ui|window|pointer|keyboard)\./.test(action.capability)) state.observability.uiaActions += 1;
      else state.observability.internalActions += 1;
      await this.emit("ADAPTIVE_ACTION_STARTING", { step: state.steps, action });
      let beforeScreenSnapshot = null;
      let afterScreenSnapshot = null;
      let screenDiff = null;
      if (isUiFacingAction(action) && typeof this.captureScreenSnapshot === "function") {
        try {
          beforeScreenSnapshot = await this.captureScreenSnapshot({
            phase: "before",
            action,
            step: state.steps,
            currentPerception: lastPerception,
            force: true
          });
          await this.emit("ADAPTIVE_SCREEN_SNAPSHOT_CAPTURED", {
            phase: "before",
            step: state.steps,
            action: action.capability,
            snapshotId: beforeScreenSnapshot?.snapshotId ?? null
          });
        } catch (error) {
          await this.emit("ADAPTIVE_SCREEN_SNAPSHOT_FAILED", {
            phase: "before",
            step: state.steps,
            action: action.capability,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      let outcome;
      try {
        outcome = await this.executeAction(action, {
          goal: state.goal,
          step: state.steps,
          stateFingerprint: fingerprint
        });
      } catch (error) {
        outcome = {
          executionResult: { error: error?.message ?? String(error) },
          verification: { status: "FAILED", message: error?.message ?? String(error), confidence: 1 }
        };
      }
      if (outcome?.paused) {
        state.status = "NEEDS_USER";
        state.reason = outcome.reason ?? "Approval or user input is required";
        break;
      }
      if (isUiFacingAction(action) && typeof this.captureScreenSnapshot === "function") {
        try {
          afterScreenSnapshot = await this.captureScreenSnapshot({
            phase: "after",
            action,
            step: state.steps,
            currentPerception: lastPerception,
            force: true
          });
          screenDiff = beforeScreenSnapshot && afterScreenSnapshot
            ? diffScreenSnapshots(beforeScreenSnapshot, afterScreenSnapshot)
            : null;
          state.semanticState.latestScreenSnapshotId = afterScreenSnapshot?.snapshotId ?? null;
          state.semanticState.latestScreenDiff = screenDiff;
          await this.emit("ADAPTIVE_SCREEN_DIFF", {
            step: state.steps,
            action: action.capability,
            beforeSnapshotId: beforeScreenSnapshot?.snapshotId ?? null,
            afterSnapshotId: afterScreenSnapshot?.snapshotId ?? null,
            diff: screenDiff
          });
        } catch (error) {
          await this.emit("ADAPTIVE_SCREEN_SNAPSHOT_FAILED", {
            phase: "after",
            step: state.steps,
            action: action.capability,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      lastOutcome = {
        output: outcome?.executionResult,
        observation: outcome?.observation,
        verification: outcome?.verification,
        resultEnvelope: createResultEnvelope({
          capability: action.capability,
          executionResult: outcome?.executionResult,
          observation: outcome?.observation,
          verification: outcome?.verification,
          step: state.steps
        })
      };
      let verification = outcome?.verification ?? {};
      let succeeded = SUCCESS.has(verification.status);
      let progressMeasurement = null;
      let deterministicVerifierPending = false;
      // Deterministic postcondition check for a batched sub-step: when the
      // capability could not judge its own effect, the durable screen diff is
      // authoritative evidence that the action landed. This replaces a model
      // call per step. An explicit FAILED verification is never overridden.
      if (
        !succeeded &&
        Number.isInteger(action.deterministicStepIndex) &&
        screenDiff?.changed === true &&
        verification.status !== "FAILED"
      ) {
        succeeded = true;
        progressMeasurement = {
          state: InteractiveConvergenceState.PROGRESS,
          evidence: "durable-screen-snapshot-diff",
          screenDiff
        };
        await this.emit("ADAPTIVE_DETERMINISTIC_POSTCONDITION_ACCEPTED", {
          step: state.steps,
          capability: action.capability,
          stepIndex: action.deterministicStepIndex,
          evidence: "durable-screen-snapshot-diff"
        });
      }
      if (action.capability === "ui.action") {
        const postActionPerception = await this.perceive({
          goal: state.goal,
          semanticState: state.semanticState,
          recentActions: state.recentActions.slice(-6)
        });
        state.currentPerception = postActionPerception;
        lastPerception = postActionPerception;
        progressMeasurement = measureUiProgress(expectedUiPostcondition, postActionPerception);
        if (
          expectedUiPostcondition?.kind === "OBSERVABLE_DELTA" &&
          progressMeasurement.state !== InteractiveConvergenceState.PROGRESS &&
          screenDiff?.changed === true
        ) {
          progressMeasurement = {
            state: InteractiveConvergenceState.PROGRESS,
            expected: expectedUiPostcondition,
            evidence: "durable-screen-snapshot-diff",
            screenDiff
          };
        }
        // Some adapters return a freshly grounded action observation before the
        // next broad perception cycle has caught up (common for selection state
        // in Windows UIA).  Accept that observation only when it independently
        // proves the exact predicted delta; never accept `performed: true` by
        // itself.  This avoids discarding a verified interaction merely because
        // the subsequent ambient scan is eventually consistent.
        if (progressMeasurement.state !== InteractiveConvergenceState.PROGRESS && outcome?.observation) {
          const actionObservationProgress = measureUiProgress(expectedUiPostcondition, outcome.observation);
          if (actionObservationProgress.state === InteractiveConvergenceState.PROGRESS) {
            progressMeasurement = actionObservationProgress;
          }
        }
        if (
          verification.status === "PARTIALLY_VERIFIED" &&
          progressMeasurement.state === InteractiveConvergenceState.PROGRESS
        ) {
          verification = {
            ...verification,
            status: "VERIFIED",
            message: verification.message ?? "UI action independently verified by its observed postcondition.",
            independentPostcondition: true,
            postconditionEvidence: progressMeasurement
          };
          lastOutcome.verification = verification;
          lastOutcome.resultEnvelope = createResultEnvelope({
            capability: action.capability,
            executionResult: outcome?.executionResult,
            observation: outcome?.observation,
            verification,
            step: state.steps
          });
        }
        succeeded = verification.status === "VERIFIED" &&
          progressMeasurement.state === InteractiveConvergenceState.PROGRESS;
        state.semanticState.interactiveConvergence = progressMeasurement.state;
        await this.emit("ADAPTIVE_PROGRESS_MEASURED", {
          step: state.steps,
          action,
          ...progressMeasurement
        });
        if (!succeeded) {
          deterministicVerifierPending = outcome?.executionResult?.performed === true
            && pendingActions[0]?.capability === "ui.verifyValue";
          const pairKey = actionPairKey(action);
          if (pairKey) exhaustedActionPairs.set(pairKey, stateFingerprint(postActionPerception));
          state.unsupportedAttempts.push({
            action: {
              capability: action.capability,
              inputs: {
                action: action.inputs?.action,
                target: {
                  targetId: action.inputs?.target?.targetId,
                  name: action.inputs?.target?.name,
                  automationId: action.inputs?.target?.automationId
                }
              }
            },
            reason:
              `${InteractiveConvergenceState.NO_PROGRESS}: observed UI delta did not match ` +
              "the predicted postcondition; this target/action pair is exhausted"
          });
          if (!deterministicVerifierPending) pendingActions = [];
          await this.emit("ADAPTIVE_TARGET_ACTION_ELIMINATED", {
            pairKey,
            convergenceState: InteractiveConvergenceState.NO_PROGRESS
          });
        }
      }
      state.observability.verificationEvidence.push({
        step: state.steps,
        capability: action.capability,
        status: verification.status,
        message: verification.message,
        confidence: verification.confidence
      });
      const deterministicRecovery = outcome?.executionResult?.deterministicRecovery
        ?? (outcome?.executionResult?.reGrounded && outcome?.executionResult?.geometryChanged
          ? {
              attempted: true,
              strategy: "re-ground-after-window-geometry-change",
              succeeded: outcome.executionResult.performed === true,
              groundingAttempts: outcome.executionResult.groundingAttempts
            }
          : null);
      if (deterministicRecovery?.attempted) {
        state.observability.deterministicRecoveryAttempts.push({
          step: state.steps,
          capability: action.capability,
          ...deterministicRecovery
        });
        state.metrics.retries += 1;
      }
      state.recentActions.push({
        action,
        at: new Date().toISOString(),
        succeeded,
        executionResult: outcome?.executionResult,
        resultEnvelope: lastOutcome.resultEnvelope,
        verification,
        progressMeasurement,
        beforeScreenSnapshotId: beforeScreenSnapshot?.snapshotId ?? null,
        afterScreenSnapshotId: afterScreenSnapshot?.snapshotId ?? null,
        screenDiff
      });
      state.recentObservations.push(
        action.capability === "ui.action"
          ? lastPerception
          : (outcome?.observation ?? outcome?.executionResult ?? outcome)
      );
      state.recentModelObservations.push(compactObservationForModel(
        outcome?.observation ?? outcome?.executionResult ?? outcome
      ));
      if (action.bindOutput) {
        const bindingSpec = typeof action.bindOutput === "string" ? { name: action.bindOutput } : action.bindOutput;
        const requestedPath = bindingSpec.path ?? "output.text";
        const rawValue = readPath(lastOutcome, requestedPath)
          ?? extractResultValue(lastOutcome.resultEnvelope, requestedPath);
        const boundValue = normalizeBoundValue(rawValue, bindingSpec.normalize);
        if (bindingSpec.name && boundValue != null && boundValue !== "") {
          const actualType = typeof boundValue;
          if (bindingSpec.expectedType && actualType !== bindingSpec.expectedType) {
            state.failedAttempts.push({
              action,
              reason: `binding ${bindingSpec.name} expected ${bindingSpec.expectedType} but producer returned ${actualType}`
            });
            pendingActions = [];
            continue;
          }
          if (bindingSpec.requiredSourceCapability && action.capability !== bindingSpec.requiredSourceCapability) {
            state.failedAttempts.push({
              action,
              reason: `binding ${bindingSpec.name} requires producer ${bindingSpec.requiredSourceCapability}`
            });
            pendingActions = [];
            continue;
          }
          const bindingId = `binding_${crypto.randomUUID()}`;
          state.bindings[bindingSpec.name] = {
            bindingId,
            value: boundValue,
            type: actualType,
            sourceCapability: action.capability,
            sourceStep: state.steps,
            confidence: outcome?.verification?.confidence ?? 0.8,
            sanitized: true,
            provenance: lastOutcome.resultEnvelope.provenance,
            evidence: lastOutcome.resultEnvelope.evidence,
            createdAt: new Date().toISOString()
          };
          await this.emit("ADAPTIVE_BINDING_CREATED", { name: bindingSpec.name, provenance: state.bindings[bindingSpec.name] });
        }
        if (bindingSpec.name && !state.bindings[bindingSpec.name]) {
          state.recentActions.at(-1).succeeded = false;
          state.failedAttempts.push({
            action,
            reason: `required output binding ${bindingSpec.name} was not produced`
          });
          pendingActions = [];
          await this.emit("ADAPTIVE_BINDING_REJECTED", {
            name: bindingSpec.name,
            reason: "required output binding was not produced"
          });
          continue;
        }
      }
      state.transitionContracts = evaluateTransitionContracts(state.recentActions, state.bindings);
      let evidenceEntry = null;
      if (succeeded) {
        const predicateResult = action.expectedPostcondition
          ? evaluatePostcondition(action.expectedPostcondition, {
              executionResult: outcome?.executionResult,
              observation: outcome?.observation,
              verification
            })
          : null;
        const criterionIds = inferCriterionIds(
          action,
          initialContext.goalContract,
          [outcome?.executionResult, outcome?.observation, verification]
        );
        evidenceEntry = appendEvidence(state.evidenceLedger, {
          taskId: action.nodeId ?? `step_${state.steps}`,
          subgoalId: action.subgoalId ?? action.nodeId ?? `step_${state.steps}`,
          criterionIds: predicateResult && !predicateResult.satisfied ? [] : criterionIds,
          capability: action.capability,
          modality,
          observation: outcome?.observation ?? outcome?.executionResult,
          verification,
          value: lastOutcome.resultEnvelope?.data?.value,
          provenance: lastOutcome.resultEnvelope?.provenance,
          producedBindings: action.bindOutput
            ? [state.bindings[typeof action.bindOutput === "string" ? action.bindOutput : action.bindOutput.name]?.bindingId].filter(Boolean)
            : [],
          consumedBindings
        });
        for (const name of (action.bindOutput
          ? [typeof action.bindOutput === "string" ? action.bindOutput : action.bindOutput.name]
          : [])) {
          if (state.bindings[name]) state.bindings[name].producerEvidenceId = evidenceEntry.evidenceId;
        }
      }
      await this.emit("ADAPTIVE_ACTION_VERIFIED", {
        step: state.steps,
        capability: action.capability,
        verification,
        durationMs: this.now() - actionStarted
      });

      if (succeeded) {
        if (action.nodeId) completedNodes.add(action.nodeId);
        if (action.subgoal && !state.completedSubgoals.includes(action.subgoal)) {
          state.completedSubgoals.push(action.subgoal);
        }
        state.semanticState.lastSuccessfulAction = action.capability;
        state.semanticState.lastResult = compactObservationForModel(outcome?.executionResult ?? null);
        const ledgerCompletion = initialContext.goalContract?.enforceable
          ? evaluateEvidenceLedger(initialContext.goalContract, state.evidenceLedger, state.bindings)
          : null;
        const outstanding = outstandingRequestedSteps(state, pendingActions);
        if (ledgerCompletion?.satisfied && outstanding.length) {
          await this.emit("ADAPTIVE_COMPLETION_DEFERRED", {
            reason: "goal-contract evidence is satisfied but requested steps remain",
            outstanding
          });
        }
        if (ledgerCompletion?.satisfied && !outstanding.length) {
          state.status = "COMPLETE";
          state.result = {
            summary: "All original goal criteria were satisfied by locally verified evidence.",
            evidenceIds: ledgerCompletion.criteria.flatMap((criterion) => criterion.evidenceIds)
          };
          state.completionVerification = {
            allCriteriaSatisfied: true,
            locallyEvaluated: true,
            ledger: ledgerCompletion,
            satisfiedCriteria: ledgerCompletion.criteria.map((criterion) => ({
              criterion: criterion.description,
              evidence: criterion.evidenceIds.join(", ")
            }))
          };
          await this.emit("ADAPTIVE_LOCAL_EVIDENCE_COMPLETED", {
            result: state.result,
            verification: state.completionVerification
          });
          continue;
        }
        if (action.completesGoal === true && verification.status === "VERIFIED") {
          const evidence = verification.message ?? `${action.capability} was locally verified`;
          const proposedResult = action.completionResult
            ? resolveRuntimeReferences(action.completionResult, lastOutcome, state.bindings)
            : { summary: evidence };
          const proposedVerification = {
            allCriteriaSatisfied: true,
            locallyEvaluated: true,
            satisfiedCriteria: (initialContext.successCriteria ?? [state.goal]).map((criterion) => ({ criterion, evidence }))
          };
          const completion = validateCompletionEvidence({
            result: proposedResult,
            verification: proposedVerification
          }, initialContext, state);
          if (completion.valid) {
            state.status = "COMPLETE";
            state.result = proposedResult;
            state.completionVerification = proposedVerification;
          } else {
            state.failedAttempts.push({ action: "COMPLETE", reason: completion.errors.join(", ") });
            await this.emit("ADAPTIVE_COMPLETION_REJECTED", { errors: completion.errors });
          }
        }
        continue;
      }

      if (action.capability === "ui.action" && progressMeasurement?.state === InteractiveConvergenceState.NO_PROGRESS) {
        if (deterministicVerifierPending) {
          if (action.nodeId) completedNodes.add(action.nodeId);
          state.semanticState.interactiveConvergence = InteractiveConvergenceState.RECOVERABLE;
          await this.emit("ADAPTIVE_DETERMINISTIC_VERIFIER_PRESERVED", {
            action,
            verifier: pendingActions[0]?.capability,
            convergenceState: InteractiveConvergenceState.RECOVERABLE
          });
          continue;
        }
        const remaining = enumerateGroundedActionCandidates(state.goal, lastPerception, exhaustedActionPairs);
        state.semanticState.interactiveConvergence = remaining.length
          ? InteractiveConvergenceState.RECOVERABLE
          : InteractiveConvergenceState.TARGET_EXHAUSTED;
        await this.emit("ADAPTIVE_DETERMINISTIC_RECOVERY_STATE", {
          convergenceState: state.semanticState.interactiveConvergence,
          remainingCandidates: remaining.length
        });
        continue;
      }
      state.failedAttempts.push({ action, verification });
      // Discarding the whole batch on one soft failure is what forces a fresh
      // model call per micro-step. Keep the tail when the remaining steps are
      // genuinely independent of the one that failed — no runtime reference to
      // its output, no declared dependency, no binding it was to produce.
      const tailIsIndependent = pendingActions.length > 0
        && Number.isInteger(action.deterministicStepIndex)
        && pendingActions.every((queued) =>
          !JSON.stringify(queued.inputs ?? {}).includes("$last")
          && !(queued.dependsOn ?? []).includes(action.nodeId)
          && (queued.requiresBindings ?? []).length === 0);
      if (tailIsIndependent) {
        await this.emit("ADAPTIVE_INDEPENDENT_BATCH_PRESERVED", {
          failedCapability: action.capability,
          remaining: pendingActions.map((queued) => queued.capability)
        });
      } else {
        pendingActions = [];
      }
      const sectionQuery = action.capability === "ui.find"
        && /TabItem$/i.test(String(action.inputs?.selector?.controlType ?? ""))
        ? action.inputs?.selector?.name ?? action.inputs?.selector?.nameContains
        : null;
      if (sectionQuery && state.recoveries < this.budgets.recoveryBudget) {
        const expectedControl = state.goal.match(/\b(?:verify|confirm)(?:\s+that)?\s+(?:its|the)?\s*["']?([^"'.]+?)["']?\s+control\s+(?:is\s+)?(?:available|visible|present|shown|exists)\b/i)?.[1]?.trim();
        state.recoveries += 1;
        state.metrics.fallbacks += 1;
        pendingActions = [{
          capability: "ui.navigateSection",
          inputs: {
            application: action.inputs?.application,
            windowId: action.inputs?.windowId,
            query: sectionQuery,
            maxTransitions: 8
          },
          subgoal: `Navigate to ${sectionQuery}`
        }];
        if (expectedControl) {
          pendingActions.push({
            capability: "ui.find",
            inputs: {
              application: action.inputs?.application,
              windowId: action.inputs?.windowId,
              selector: { nameContains: expectedControl }
            },
            subgoal: `Verify ${expectedControl} control is available`,
            completesGoal: true,
            completionResult: {
              summary: `${sectionQuery} was selected and its ${expectedControl} control was verified available.`
            }
          });
        }
        await this.emit("ADAPTIVE_FALLBACK_SELECTED", {
          from: action.capability,
          to: "ui.navigateSection",
          recovery: state.recoveries,
          reason: "inaccessible-native-tab"
        });
        continue;
      }
      const fallback = (action.fallback ?? []).find((candidate) =>
        this._validateAction(candidate, observedTargetIds).valid
      );
      if (fallback && state.recoveries < this.budgets.recoveryBudget) {
        state.recoveries += 1;
        state.metrics.fallbacks += 1;
        pendingActions = [{ ...fallback, subgoal: action.subgoal }];
        await this.emit("ADAPTIVE_FALLBACK_SELECTED", {
          from: action.capability,
          to: fallback.capability,
          recovery: state.recoveries
        });
      }
    }

    state.metrics.totalDurationMs = this.now() - startedAt;
    await this.emit("ADAPTIVE_CONTROLLER_FINISHED", {
      status: state.status,
      completionStatus: state.completionStatus ?? null,
      reason: state.reason,
      metrics: state.metrics,
      steps: state.steps,
      modelCalls: state.modelCalls,
      maxModelCalls: budgets.maxModelCalls
    });
    return state;
  }
}

export { DEFAULT_BUDGETS as INTERACTIVE_AGENT_DEFAULT_BUDGETS };
