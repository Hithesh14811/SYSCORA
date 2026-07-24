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

const DEFAULT_BUDGETS = Object.freeze({
  maxSteps: 24,
  maxModelCalls: 8,
  maxElapsedTime: 120000,
  maxRepeatedActions: 2,
  maxFailedActions: 5,
  recoveryBudget: 4
});

const TERMINAL = new Set(["COMPLETE", "FAILED", "NEEDS_USER"]);
const SUCCESS = new Set(["VERIFIED", "PARTIALLY_VERIFIED"]);
const MAX_MODEL_OBSERVATION_BYTES = 4_000;

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

function stateFingerprint(perception) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(sanitizeInteractiveState(perception ?? {})))
    .digest("hex")
    .slice(0, 16);
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
  if (value.startsWith("$binding.")) return bindings?.[value.slice("$binding.".length)]?.value;
  return value;
}

function normalizeBoundValue(value, normalization) {
  const text = typeof value === "string" ? value.trim() : value;
  if (normalization === "version") return String(text ?? "").match(/\b\d+(?:\.\d+){1,3}\b/)?.[0] ?? null;
  if (normalization === "trim") return String(text ?? "").trim();
  return text;
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

export function chooseMechanicalContinuation(goal, perception) {
  const controls = Array.isArray(perception?.relevantControls) ? perception.relevantControls : [];
  const tokens = String(goal ?? "").toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((token) =>
    !["open", "tell", "whether", "determine", "current", "state", "status", "settings", "application"].includes(token)
  ) ?? [];
  const actionable = controls.map((control) => {
    const semantics = `${control.name ?? ""} ${control.automationId ?? ""}`.toLowerCase();
    const score = tokens.reduce((total, token) => total + (semantics.includes(token) ? 1 : 0), 0);
    const patterns = control.supportedPatterns ?? [];
    const action = patterns.some((pattern) => /SelectionItem/i.test(pattern)) ? "select"
      : patterns.some((pattern) => /Invoke/i.test(pattern)) ? "invoke" : null;
    return { control, score, action };
  }).filter((candidate) => candidate.action && candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (actionable[0] && (!actionable[1] || actionable[0].score > actionable[1].score)) {
    return {
      capability: "ui.action",
      inputs: { target: actionable[0].control, action: actionable[0].action },
      subgoal: `Navigate through ${actionable[0].control.name}`,
      mechanicallySelected: true
    };
  }
  const openNavigation = controls.filter((control) =>
    /^(open|expand) navigation$/i.test(String(control.name ?? "")) &&
    (control.supportedPatterns ?? []).some((pattern) => /Invoke/i.test(pattern))
  );
  if (openNavigation.length === 1) {
    return {
      capability: "ui.action",
      inputs: { target: openNavigation[0], action: "invoke" },
      subgoal: "Expose application navigation",
      mechanicallySelected: true
    };
  }
  return null;
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
    executeAction,
    onEvent = null,
    budgets = {},
    now = () => Date.now()
  } = {}) {
    this.reasoningEngine = reasoningEngine;
    this.capabilityRegistry = capabilityRegistry;
    this.perceive = perceive;
    this.executeAction = executeAction;
    this.onEvent = onEvent;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
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
    return { valid: errors.length === 0, errors };
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
      failedAttempts: [],
      modelCalls: 0,
      steps: 0,
      recoveries: 0,
      metrics: { firstActionMs: null, uiActions: 0, localActions: 0, retries: 0, fallbacks: 0, recoveryCalls: 0, modelLatencyMs: 0 },
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
    let pendingActions = [];
    let lastPerception = null;
    let lastOutcome = null;
    const completedNodes = new Set();
    await this.emit("ADAPTIVE_CONTROLLER_STARTED", { goal: state.goal, budgets: this.budgets });

    const initialStrategy = buildBrowserCompositionStrategy(state.goal)
      ?? buildGuiToInternalStrategy(state.goal)
      ?? buildInternalToGuiTransferStrategy(state.goal)
      ?? buildCrossModalTransferStrategy(state.goal)
      ?? buildExplicitApplicationLaunchStrategy(state.goal);
    if (initialStrategy) {
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
      if (localCompletion.status === "COMPLETE" && state.recentActions.some((entry) => entry.succeeded)) {
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
          const patterns = groundedTarget.supportedPatterns ?? [];
          const verb = patterns.some((pattern) => /SelectionItem/i.test(pattern))
            ? "select"
            : patterns.some((pattern) => /Invoke/i.test(pattern))
              ? "invoke"
              : "click";
          pendingActions = [{
            capability: "ui.action",
            inputs: {
              application: groundedTarget.windowIdentity?.processName,
              windowId: groundedTarget.windowId,
              target: groundedTarget,
              action: verb
            },
            subgoal: `Interact with grounded ${groundedTarget.name ?? "target"}`,
            mechanicallySelected: true
          }];
          await this.emit("ADAPTIVE_GROUNDED_ACTION_CHAINED", {
            from: priorAction.action.capability,
            targetId: groundedTarget.targetId,
            action: verb
          });
        }
      }

      if (pendingActions.length === 0) {
        const mechanical = state.failedAttempts.length === 0
          ? chooseMechanicalContinuation(state.goal, lastPerception)
          : null;
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
        const decision = await this.reasoningEngine.decideInteractiveAction({
          reasoningPhase: state.modelCalls === 0 ? "INITIAL_STRATEGY" : "RECOVERY",
          goal: state.goal,
          completedSubgoals: state.completedSubgoals,
          currentState: lastPerception,
          semanticState: state.semanticState,
          bindings: state.bindings,
          recentActions: state.recentActions.slice(-8),
          recentObservations: state.recentModelObservations.slice(-8),
          failedAttempts: state.failedAttempts.slice(-6),
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
        const proposedActions = [data.action, ...(data.localSteps ?? [])].filter(Boolean).map((action, index) => ({
          ...action,
          subgoal: action.subgoal ?? data.subgoal,
          expectedEffect: action.expectedEffect ?? data.expectedEffect,
          verification: action.verification ?? data.verification,
          fallback: index === 0 ? (data.fallback ?? []) : (action.fallback ?? [])
        })).filter((action, index, actions) => {
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
      const action = {
        ...queuedAction,
        inputs: resolveRuntimeReferences(queuedAction.inputs ?? {}, lastOutcome, state.bindings)
      };
      const observedTargetIds = collectTargetIds([lastPerception, ...state.recentObservations]);
      const validation = this._validateAction(action, observedTargetIds);
      if (!validation.valid) {
        state.failedAttempts.push({ action, reason: validation.errors.join(", ") });
        pendingActions = [];
        await this.emit("ADAPTIVE_ACTION_REJECTED", { action, errors: validation.errors });
        continue;
      }
      const signature = actionSignature(action, fingerprint);
      const repeatCount = (repetitions.get(signature) ?? 0) + 1;
      repetitions.set(signature, repeatCount);
      if (repeatCount > this.budgets.maxRepeatedActions) {
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
      const verification = outcome?.verification ?? {};
      const succeeded = SUCCESS.has(verification.status);
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
        verification
      });
      state.recentObservations.push(outcome?.observation ?? outcome?.executionResult ?? outcome);
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
          state.bindings[bindingSpec.name] = {
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
      }
      state.transitionContracts = evaluateTransitionContracts(state.recentActions, state.bindings);
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
        if (action.completesGoal === true && verification.status === "VERIFIED") {
          const evidence = verification.message ?? `${action.capability} was locally verified`;
          const proposedResult = action.completionResult ?? { summary: evidence };
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

      state.failedAttempts.push({ action, verification });
      pendingActions = [];
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
      reason: state.reason,
      metrics: state.metrics,
      steps: state.steps,
      modelCalls: state.modelCalls
    });
    return state;
  }
}

export { DEFAULT_BUDGETS as INTERACTIVE_AGENT_DEFAULT_BUDGETS };
