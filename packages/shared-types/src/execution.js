import crypto from "node:crypto";

export const ExecutionModality = Object.freeze({
  INTERNAL: "INTERNAL",
  OS_API: "OS_API",
  CLI: "CLI",
  BROWSER_DOM: "BROWSER_DOM",
  UI_AUTOMATION: "UI_AUTOMATION",
  VISION_GUI: "VISION_GUI"
});

export const TargetSource = Object.freeze({
  UIA: "UIA",
  DOM: "DOM",
  OCR: "OCR",
  VISION: "VISION",
  COORDINATE: "COORDINATE"
});

const SOURCES = new Set(Object.values(TargetSource));

export function createInteractionTarget(value = {}) {
  const source = String(value.source ?? "").toUpperCase();
  if (!SOURCES.has(source)) throw new Error(`Unsupported target source: ${source || "missing"}`);
  const rect = value.boundingRect ?? value.bounds ?? null;
  const normalizedRect = rect && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rect[key])))
    ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Number(rect[key])]))
    : null;
  const confidence = Math.max(0, Math.min(1, Number(value.confidence ?? 0)));
  return {
    targetId: value.targetId ?? crypto.randomUUID(),
    source,
    windowId: value.windowId != null ? String(value.windowId) : null,
    automationId: value.automationId ?? null,
    name: value.name ?? null,
    controlType: value.controlType ?? null,
    className: value.className ?? null,
    selector: value.selector ?? null,
    boundingRect: normalizedRect,
    relativeCoordinates: value.relativeCoordinates ?? null,
    confidence,
    observedAt: value.observedAt ?? new Date().toISOString(),
    evidence: value.evidence ?? null
  };
}

export function validateInteractionTarget(target, { minVisualConfidence = 0.75 } = {}) {
  if (!target || typeof target !== "object") return { valid: false, errors: ["target is required"] };
  const errors = [];
  if (!SOURCES.has(target.source)) errors.push("target.source is invalid");
  if (!target.windowId) errors.push("target.windowId is required");
  if (["OCR", "VISION", "COORDINATE"].includes(target.source)) {
    if (!target.boundingRect) errors.push("visual/coordinate target requires boundingRect");
    if (Number(target.confidence) < minVisualConfidence) errors.push("visual target confidence is below threshold");
  }
  if (target.source === "UIA" && !target.automationId && !target.name && !target.selector) {
    errors.push("UIA target requires an accessible selector");
  }
  return { valid: errors.length === 0, errors };
}

export function modalityProfile(modality, overrides = {}) {
  if (!Object.values(ExecutionModality).includes(modality)) throw new Error(`Unknown modality ${modality}`);
  const defaults = {
    INTERNAL: { reliability: 0.98, latencyMs: 20, observability: 0.95 },
    OS_API: { reliability: 0.95, latencyMs: 50, observability: 0.9 },
    CLI: { reliability: 0.9, latencyMs: 400, observability: 0.9 },
    BROWSER_DOM: { reliability: 0.9, latencyMs: 150, observability: 0.95 },
    UI_AUTOMATION: { reliability: 0.82, latencyMs: 120, observability: 0.8 },
    VISION_GUI: { reliability: 0.68, latencyMs: 800, observability: 0.6 }
  }[modality];
  return { modality, ...defaults, ...overrides };
}
