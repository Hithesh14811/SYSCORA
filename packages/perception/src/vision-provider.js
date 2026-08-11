import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  EntityType,
  RelationshipType,
  makeEntity,
  makeRelationship
} from "./entities.js";

const DEFAULT_TTL_MS = 1_500;
const INTERACTIVE_ROLES = new Set([
  "button", "edit", "combobox", "checkbox", "radiobutton", "hyperlink",
  "listitem", "dataitem", "menuitem", "tabitem", "slider", "treeitem"
]);

function value(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
  }
  return null;
}

function normalizeBbox(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = Number(value(rect, "x", "X"));
  const y = Number(value(rect, "y", "Y"));
  const width = Number(value(rect, "width", "Width"));
  const height = Number(value(rect, "height", "Height"));
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

function normalizeRole(controlType, fallback = "text") {
  const raw = String(controlType ?? fallback).replace(/^ControlType\./i, "").trim();
  return raw ? raw.toLowerCase() : fallback;
}

function expiryTimestamp(capturedAt, ttlMs) {
  const timestamp = Date.parse(capturedAt);
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + ttlMs).toISOString();
}

function stableElementKey(element, index) {
  const bbox = element.bbox;
  const geometry = bbox ? `${bbox.x},${bbox.y},${bbox.width},${bbox.height}` : "no-bounds";
  return [element.source, element.automationId || element.text || element.role || index, geometry]
    .map((part) => String(part ?? "").toLowerCase())
    .join("|");
}

function normalizedElement(target, source, index) {
  const role = normalizeRole(value(target, "controlType", "role"), source === "OCR" ? "text" : "unknown");
  const patterns = Array.isArray(target?.supportedPatterns) ? target.supportedPatterns : [];
  const clickable = source === "UIA"
    ? INTERACTIVE_ROLES.has(role) || patterns.some((pattern) => /Invoke|Selection|Toggle|Value|ExpandCollapse/i.test(String(pattern)))
    : false;
  const element = {
    id: String(value(target, "targetId", "id") ?? `${source.toLowerCase()}-${index}`),
    targetId: String(value(target, "targetId", "id") ?? `${source.toLowerCase()}-${index}`),
    source,
    windowId: value(target, "windowId", "windowHandle"),
    role,
    text: String(value(target, "name", "text", "value") ?? ""),
    name: String(value(target, "name", "text", "value") ?? ""),
    automationId: value(target, "automationId"),
    bbox: normalizeBbox(value(target, "boundingRect", "bounds", "bbox")),
    boundingRect: normalizeBbox(value(target, "boundingRect", "bounds", "bbox")),
    controlType: value(target, "controlType", "role") ?? (source === "OCR" ? "Text" : "unknown"),
    clickable,
    enabled: value(target, "enabled") !== false,
    focused: value(target, "focused") === true,
    selected: value(target, "selected", "isSelected"),
    value: value(target, "value"),
    toggleState: value(target, "toggleState"),
    expandCollapseState: value(target, "expandCollapseState"),
    offscreen: value(target, "offscreen", "isOffscreen") === true,
    className: value(target, "className"),
    windowIdentity: value(target, "windowIdentity"),
    supportedPatterns: patterns,
    confidence: Number(value(target, "confidence") ?? (source === "OCR" ? 0.85 : 1))
  };
  element.semanticKey = stableElementKey(element, index);
  return element;
}

function elementSignature(element) {
  return JSON.stringify({
    role: element.role ?? "unknown",
    text: String(element.text ?? "").trim(),
    automationId: element.automationId ?? null,
    bbox: normalizeBbox(element.bbox ?? element.boundingRect),
    clickable: element.clickable === true,
    enabled: element.enabled !== false,
    focused: element.focused === true,
    selected: element.selected ?? null,
    value: element.value ?? null,
    toggleState: element.toggleState ?? null,
    expandCollapseState: element.expandCollapseState ?? null,
    offscreen: element.offscreen === true
  });
}

function snapshotElements(snapshot) {
  if (Array.isArray(snapshot?.elements)) return snapshot.elements;
  if (Array.isArray(snapshot?.properties?.elements)) return snapshot.properties.elements;
  return [];
}

function diffKey(element, index) {
  if (element?.semanticKey) return String(element.semanticKey);
  const bbox = normalizeBbox(element?.bbox ?? element?.boundingRect);
  return [
    element?.source ?? "unknown",
    element?.automationId || element?.text || element?.name || element?.role || index,
    bbox ? `${bbox.x},${bbox.y},${bbox.width},${bbox.height}` : "no-bounds"
  ].map((part) => String(part ?? "").toLowerCase()).join("|");
}

/** Deterministic, model-free evidence of what changed between two screen captures. */
export function diffScreenSnapshots(before, after) {
  const beforeElements = snapshotElements(before);
  const afterElements = snapshotElements(after);
  const beforeMap = new Map(beforeElements.map((element, index) => [diffKey(element, index), element]));
  const afterMap = new Map(afterElements.map((element, index) => [diffKey(element, index), element]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, element] of afterMap) {
    if (!beforeMap.has(key)) added.push(element);
    else if (elementSignature(beforeMap.get(key)) !== elementSignature(element)) {
      changed.push({ key, before: beforeMap.get(key), after: element });
    }
  }
  for (const [key, element] of beforeMap) {
    if (!afterMap.has(key)) removed.push(element);
  }

  const beforeText = String(before?.ocrText ?? before?.properties?.ocrText ?? "").trim();
  const afterText = String(after?.ocrText ?? after?.properties?.ocrText ?? "").trim();
  const textChanged = beforeText !== afterText;
  const beforePixels = before?.pixelHash ?? before?.properties?.pixelHash ?? null;
  const afterPixels = after?.pixelHash ?? after?.properties?.pixelHash ?? null;
  const pixelsChanged = Boolean(beforePixels && afterPixels && beforePixels !== afterPixels);
  const windowChanged = String(before?.windowId ?? before?.properties?.windowId ?? "") !==
    String(after?.windowId ?? after?.properties?.windowId ?? "");

  return {
    changed: windowChanged || pixelsChanged || textChanged || added.length > 0 || removed.length > 0 || changed.length > 0,
    windowChanged,
    pixelsChanged,
    textChanged,
    added,
    removed,
    changedElements: changed,
    beforeCount: beforeElements.length,
    afterCount: afterElements.length
  };
}

/**
 * Read-only visual perception backed by the same adapter operations exposed as
 * screen.capture, ocr.read and ui.inspect capabilities. Perception checks those
 * capabilities before collecting so an unavailable/disabled visual surface is
 * never used implicitly.
 */
export class VisionProvider {
  constructor(adapter, { capabilityRegistry = null, ttlMs = DEFAULT_TTL_MS, clock = () => Date.now() } = {}) {
    this.name = "vision";
    this.adapter = adapter;
    this.capabilityRegistry = capabilityRegistry;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.cache = new Map();
  }

  confidence() { return 0.9; }
  freshness() { return "current"; }
  cost() { return 8; }
  supportedEntities() { return [EntityType.Window, EntityType.ScreenSnapshot, EntityType.ScreenElement]; }

  _capabilityAvailable(name) {
    if (!this.capabilityRegistry) return false;
    if (typeof this.capabilityRegistry.isAvailable === "function") {
      return this.capabilityRegistry.isAvailable(name, { platform: process.platform });
    }
    return Boolean(this.capabilityRegistry.get?.(name));
  }

  async _resolveWindow(request = {}) {
    const supplied = request.groundedWindow ?? request.foregroundWindow ?? request.window ?? null;
    const suppliedId = value(request, "windowId") ?? value(supplied, "windowId", "WindowHandle");
    const application = value(request, "application") ?? value(supplied, "processName", "ProcessName");
    const title = value(supplied, "title", "MainWindowTitle");
    if (suppliedId) {
      return {
        windowId: String(suppliedId),
        processName: application ? String(application) : null,
        title: title ? String(title) : null,
        bounds: normalizeBbox(value(supplied, "bounds", "Bounds")),
        foreground: value(supplied, "foreground", "Foreground") === true
      };
    }
    const describe = (window) => ({
      windowId: String(value(window, "windowId", "WindowHandle")),
      processName: value(window, "processName", "ProcessName"),
      title: value(window, "title", "MainWindowTitle"),
      bounds: normalizeBbox(value(window, "bounds", "Bounds")),
      foreground: value(window, "foreground", "Foreground") === true
    });

    // An application NAME is a window identifier, and ignoring it was silently
    // wrong rather than merely incomplete: asked to look at Notepad, this
    // resolved the foreground window instead and returned a confident, fully
    // grounded reading — of the wrong application. Every consumer then compared
    // Notepad's expected text against another program's screen. A capture of the
    // wrong window is worse than no capture, because it looks like evidence.
    if (application) {
      const windows = await this.adapter?.listWindows?.();
      if (!Array.isArray(windows) || windows.length === 0) return null;
      const needle = String(application).toLowerCase().replace(/\.exe$/, "");
      const named = windows.map(describe).filter((window) =>
        String(window.processName ?? "").toLowerCase().replace(/\.exe$/, "") === needle ||
        String(window.processName ?? "").toLowerCase().includes(needle) ||
        String(window.title ?? "").toLowerCase().includes(needle)
      );
      // NOT EVERY WINDOW A PROCESS OWNS IS A WINDOW.
      //
      // Windows 11 Notepad keeps a handful of invisible `Pop-upHost` shells
      // alongside its real documents — thirteen enumerated windows for three
      // open files, seven of them zero-sized helpers. Taking the first name
      // match landed on one of those, the capture failed because there is
      // nothing there to capture, and the agent was told "the screen could not
      // be read" while the document sat open in front of it. It then relaunched
      // the application and tried again, repeatedly.
      //
      // A window with no area cannot be looked at or clicked, so it is not a
      // candidate. Among the rest, prefer the one in front, then the largest —
      // which is the document, never the helper.
      const usable = named.filter((window) =>
        Number(window.bounds?.width ?? 0) > 10 && Number(window.bounds?.height ?? 0) > 10);
      const candidates = usable.length > 0 ? usable : named;
      return candidates.find((window) => window.foreground)
        ?? [...candidates].sort((left, right) =>
          (right.bounds?.width ?? 0) * (right.bounds?.height ?? 0) -
          (left.bounds?.width ?? 0) * (left.bounds?.height ?? 0))[0]
        ?? null;
    }

    // Nothing was named, so this is "look at whatever I am looking at". Ask the
    // OS for that one window rather than describing every window on the desktop
    // and then discarding all but one of them.
    const direct = await this.adapter?.getForegroundWindow?.();
    if (direct) return describe(direct);
    const windows = await this.adapter?.listWindows?.();
    if (!Array.isArray(windows) || windows.length === 0) return null;
    return windows.map(describe).find((window) => window.foreground) ?? null;
  }

  async collect(request = {}) {
    if (request.includeVision !== true && !request.windowId && !request.groundedWindow && !request.foregroundWindow) {
      return { available: false, reason: "vision-not-requested" };
    }
    for (const name of ["screen.capture", "ocr.read", "ui.inspect"]) {
      if (!this._capabilityAvailable(name)) return { available: false, reason: `capability-unavailable:${name}` };
    }
    if (!this.adapter?.captureScreen || !this.adapter?.readOcr || !this.adapter?.inspectUi) {
      return { available: false, reason: "visual-adapter-unavailable" };
    }

    const window = await this._resolveWindow(request);
    if (!window?.windowId) return { available: false, reason: "active-window-not-grounded" };
    const cached = this.cache.get(window.windowId);
    if (request.forceVision !== true && cached && cached.expiresAt > this.clock()) {
      return { ...cached.raw, cached: true };
    }

    // Looking at a window is three separate operations, and only two of them
    // depend on each other: OCR needs the PNG, the accessibility tree needs
    // nothing. Awaiting the capture before starting the UIA inspection made
    // every look cost their sum — measured on this machine at 1.5s + 1.8s —
    // when the wall-clock cost is the slower of the two chains. Perception runs
    // before and after every action, so this is a per-step tax, not a one-off.
    const visual = (async () => {
      const capture = await this.adapter.captureScreen({
        windowId: window.windowId,
        application: window.processName ?? request.application,
        ...(request.capturePath ? { path: request.capturePath } : {})
      });
      if (!capture?.captured || !capture.path) return { capture, ocr: null, pixelHash: null };
      const bounds = normalizeBbox(capture.bounds ?? window.bounds) ?? { x: 0, y: 0, width: 0, height: 0 };
      const [ocr, pixelHash] = await Promise.all([
        this.adapter.readOcr({
          path: capture.path,
          windowId: window.windowId,
          originX: bounds.x,
          originY: bounds.y
        }),
        fs.readFile(capture.path)
          .then((bytes) => crypto.createHash("sha256").update(bytes).digest("hex"))
          // The OCR/UIA snapshot still has value when the image cannot be re-read.
          .catch(() => null)
      ]);
      return { capture, ocr, pixelHash };
    })();
    const [{ capture, ocr, pixelHash }, ui] = await Promise.all([
      visual,
      this.adapter.inspectUi({
        application: window.processName ?? request.application,
        windowId: window.windowId,
        maxElements: request.maxElements ?? 240
      }).catch(() => null)
    ]);
    // A window that cannot be captured — protected content, a minimized window,
    // a secure desktop — is very often still readable through UI Automation.
    // Reporting the whole reading as unavailable threw that away and left the
    // agent blind to a window it could in fact see most of.
    if ((!capture?.captured || !capture.path) && !ui) {
      return { available: false, reason: capture?.reason ?? "screen-capture-failed", window, capture };
    }
    const capturedAt = capture?.timestamp ?? new Date(this.clock()).toISOString();
    const raw = {
      available: true,
      snapshotId: `screen-${window.windowId}-${crypto.randomUUID()}`,
      window,
      capture,
      pixelHash,
      ocr,
      ui,
      capturedAt,
      cached: false
    };
    this.cache.set(window.windowId, { expiresAt: this.clock() + this.ttlMs, raw });
    return raw;
  }

  normalize(raw, { now = new Date().toISOString() } = {}) {
    if (!raw?.available || !raw.window?.windowId) {
      return { entities: [], relationships: [], snapshot: null, reason: raw?.reason ?? "vision-unavailable" };
    }
    const capturedAt = raw.capturedAt ?? now;
    const snapshotId = raw.snapshotId ?? `screen-${raw.window.windowId}-${crypto.randomUUID()}`;
    const uiaTargets = raw.ui?.targets ?? raw.ui?.elements ?? [];
    const ocrTargets = raw.ocr?.targets ?? [];
    const elements = [
      normalizedElement({
        targetId: `window-${raw.window.windowId}`,
        windowId: raw.window.windowId,
        name: raw.window.title ?? raw.window.processName ?? "",
        controlType: "Window",
        boundingRect: raw.window.bounds ?? raw.capture?.bounds,
        enabled: true,
        confidence: 1
      }, "WINDOW", 0),
      ...uiaTargets.map((target, index) => normalizedElement(target, "UIA", index)),
      ...ocrTargets.map((target, index) => normalizedElement(target, "OCR", index))
    ];
    const windowEntity = makeEntity(EntityType.Window, [raw.window.windowId], {
      windowId: raw.window.windowId,
      processName: raw.window.processName ?? null,
      title: raw.window.title ?? null,
      bounds: raw.window.bounds ?? normalizeBbox(raw.capture?.bounds),
      foreground: raw.window.foreground === true
    }, { now: capturedAt, provenance: "perception:vision" });
    const snapshot = {
      snapshotId,
      windowId: raw.window.windowId,
      application: raw.window.processName ?? null,
      title: raw.window.title ?? null,
      capturedAt,
      capturePath: raw.capture?.path ?? null,
      captureMethod: raw.capture?.method ?? null,
      pixelHash: raw.pixelHash ?? null,
      ocrText: String(raw.ocr?.text ?? ""),
      elements,
      cached: raw.cached === true
    };
    const snapshotEntity = makeEntity(EntityType.ScreenSnapshot, [snapshotId], snapshot, {
      now: capturedAt,
      staleAfter: expiryTimestamp(capturedAt, this.ttlMs),
      provenance: "perception:vision"
    });
    const entities = [windowEntity, snapshotEntity];
    const relationships = [
      makeRelationship(windowEntity.id, RelationshipType.CONTAINS, snapshotEntity.id, { capturedAt }, { now: capturedAt, provenance: "perception:vision" })
    ];
    elements.forEach((element, index) => {
      const elementEntity = makeEntity(EntityType.ScreenElement, [snapshotId, element.semanticKey || index], {
        ...element,
        snapshotId,
        windowId: snapshot.windowId,
        capturedAt
      }, {
        now: capturedAt,
        staleAfter: expiryTimestamp(capturedAt, this.ttlMs),
        confidence: element.confidence,
        provenance: `perception:vision:${element.source.toLowerCase()}`
      });
      entities.push(elementEntity);
      relationships.push(makeRelationship(snapshotEntity.id, RelationshipType.CONTAINS, elementEntity.id, {
        source: element.source,
        index
      }, { now: capturedAt, confidence: element.confidence, provenance: "perception:vision" }));
    });
    return { entities, relationships, snapshot };
  }

  async perceive(request = {}, now = new Date().toISOString()) {
    const raw = await this.collect(request);
    return this.normalize(raw, { now, request });
  }
}

/**
 * Capture one fused screen snapshot straight from an adapter, without a
 * PerceptionEngine or a world model behind it.
 *
 * The capability-availability check a VisionProvider normally performs exists so
 * that PERCEPTION never implicitly uses a visual surface the installation has
 * disabled. This path is for a caller that has already decided to look — the
 * runtime taking before/after evidence around its own action — and that must not
 * be blinded because SemanticState is unavailable. It shares VisionProvider's
 * collect/normalize so the snapshot is byte-identical in shape to the persisted
 * one, and therefore directly comparable with diffScreenSnapshots.
 */
export async function captureScreenSnapshotViaAdapter(adapter, request = {}, { now = new Date().toISOString() } = {}) {
  if (!adapter) return null;
  const provider = new VisionProvider(adapter, {
    capabilityRegistry: { isAvailable: () => true },
    ttlMs: DEFAULT_TTL_MS
  });
  const raw = await provider.collect({ ...request, includeVision: true, forceVision: request.force === true });
  const { snapshot } = provider.normalize(raw, { now });
  return snapshot ?? null;
}

export { DEFAULT_TTL_MS as VISION_SNAPSHOT_TTL_MS };
