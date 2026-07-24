export const InteractiveDecisionKind = Object.freeze({
  ACT: "ACT",
  OBSERVE: "OBSERVE",
  RECOVER: "RECOVER",
  COMPLETE: "COMPLETE",
  FAIL: "FAIL",
  CLARIFY: "CLARIFY"
});

const KINDS = new Set(Object.values(InteractiveDecisionKind));

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) ?? null;
}

function normalizeAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = firstObject(value.action, value.command, value.operation);
  const source = nested?.capability || nested?.name ? nested : value;
  let capability = source.capability ?? source.capabilityName ?? source.name;
  if (typeof capability !== "string" || !capability.trim()) return null;
  let inputs = firstObject(source.inputs, source.input, source.parameters, source.arguments) ?? {};
  const uiActionAlias = capability.trim().match(/^ui\.(click|invoke|select|toggle|expand|collapse|focus)$/i)?.[1];
  if (uiActionAlias) {
    capability = "ui.action";
    inputs = {
      ...inputs,
      action: uiActionAlias.toLowerCase()
    };
  }
  return {
    ...source,
    capability: capability.trim(),
    inputs
  };
}

function normalizeKind(raw, action) {
  const explicit = String(raw?.kind ?? raw?.decisionType ?? raw?.type ?? "").toUpperCase();
  if (KINDS.has(explicit)) return explicit;
  const status = String(raw?.goalStatus ?? raw?.status ?? raw?.state ?? "").toUpperCase();
  if (["COMPLETE", "COMPLETED", "DONE", "SUCCESS"].includes(status)) return InteractiveDecisionKind.COMPLETE;
  if (["FAILED", "FAIL", "ABORT"].includes(status)) return InteractiveDecisionKind.FAIL;
  if (["NEEDS_USER", "CLARIFY", "CLARIFICATION_REQUIRED"].includes(status)) return InteractiveDecisionKind.CLARIFY;
  if (["OBSERVE", "INSPECT", "PERCEIVE"].includes(status)) return InteractiveDecisionKind.OBSERVE;
  if (["RECOVER", "RETRY", "REPLAN"].includes(status)) return InteractiveDecisionKind.RECOVER;
  if (["IN_PROGRESS", "CONTINUE", "ACT"].includes(status) && action) return InteractiveDecisionKind.ACT;
  if (!status && action) return InteractiveDecisionKind.ACT;
  return null;
}

export function normalizeInteractiveDecision(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["decision must be an object"], data: null };
  }
  const envelope = firstObject(raw.decision, raw.continuation, raw.next, raw.data);
  const action = normalizeAction(firstObject(
    raw.action,
    raw.nextAction,
    raw.proposedAction,
    envelope?.action,
    envelope?.nextAction,
    (!raw.action && (raw.capability || raw.capabilityName) ? raw : null)
  ));
  const kind = normalizeKind(raw, action) ?? normalizeKind(envelope, action);
  if (!kind) {
    return { ok: false, errors: ["decision kind is missing or invalid"], data: null };
  }
  const localSteps = (raw.localSteps ?? raw.steps ?? envelope?.localSteps ?? [])
    .map(normalizeAction)
    .filter(Boolean);
  const fallback = (raw.fallback ?? raw.fallbacks ?? envelope?.fallback ?? [])
    .map(normalizeAction)
    .filter(Boolean);
  const data = {
    kind,
    ...(action ? { action } : {}),
    ...(localSteps.length ? { localSteps } : {}),
    ...(fallback.length ? { fallback } : {}),
    ...(raw.subgoal ?? envelope?.subgoal ? { subgoal: raw.subgoal ?? envelope?.subgoal } : {}),
    ...(raw.reason ?? envelope?.reason ? { reason: raw.reason ?? envelope?.reason } : {}),
    ...(raw.result ?? envelope?.result ? { result: raw.result ?? envelope?.result } : {}),
    ...(raw.verification ?? envelope?.verification ? { verification: raw.verification ?? envelope?.verification } : {}),
    ...(raw.expectedEffect ?? envelope?.expectedEffect ? { expectedEffect: raw.expectedEffect ?? envelope?.expectedEffect } : {}),
    ...(raw.userQuestion ?? raw.question ?? envelope?.userQuestion
      ? { question: raw.userQuestion ?? raw.question ?? envelope?.userQuestion }
      : {}),
    ...(raw.requestedPerception ?? envelope?.requestedPerception
      ? { requestedPerception: raw.requestedPerception ?? envelope?.requestedPerception }
      : {}),
    ...(raw.strategy ?? envelope?.strategy ? { strategy: raw.strategy ?? envelope?.strategy } : {})
  };
  const errors = [];
  if (kind === InteractiveDecisionKind.ACT && !action) errors.push("ACT requires action");
  if (kind === InteractiveDecisionKind.COMPLETE) {
    if (!data.result || typeof data.result !== "object") errors.push("COMPLETE requires result");
    if (data.verification?.allCriteriaSatisfied !== true) errors.push("COMPLETE requires verified criteria");
  }
  if (kind === InteractiveDecisionKind.CLARIFY && !data.question) errors.push("CLARIFY requires question");
  if (kind === InteractiveDecisionKind.FAIL && !data.reason) errors.push("FAIL requires reason");
  if (kind === InteractiveDecisionKind.RECOVER && !data.strategy) errors.push("RECOVER requires strategy");
  return { ok: errors.length === 0, errors, data };
}
