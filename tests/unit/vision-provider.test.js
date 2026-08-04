import test from "node:test";
import assert from "node:assert/strict";
import { EntityType, RelationshipType } from "../../packages/perception/src/entities.js";
import {
  VisionProvider,
  diffScreenSnapshots
} from "../../packages/perception/src/vision-provider.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { InteractiveAgentController } from "../../packages/agent-runtime/src/interactive-agent-controller.js";
import { containsVisionContext } from "../../packages/reasoning-engine/src/index.js";

function availableRegistry() {
  return { isAvailable: (name) => ["screen.capture", "ocr.read", "ui.inspect"].includes(name) };
}

function fixtureAdapter() {
  const calls = { capture: 0, ocr: 0, ui: 0 };
  return {
    calls,
    async listWindows() {
      return [{
        WindowHandle: 42,
        ProcessName: "notepad",
        MainWindowTitle: "vision-fixture.txt - Notepad",
        Bounds: { x: 10, y: 20, width: 800, height: 600 },
        Foreground: true
      }];
    },
    async captureScreen() {
      calls.capture += 1;
      return {
        captured: true,
        path: "C:\\fixture\\screen.png",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        windowId: "42",
        method: "fixture",
        timestamp: "2026-08-03T10:00:00.000Z"
      };
    },
    async readOcr() {
      calls.ocr += 1;
      return {
        available: true,
        text: "Hello from pixels",
        targets: [{
          targetId: "ocr-1",
          windowId: "42",
          name: "Hello from pixels",
          controlType: "Text",
          boundingRect: { x: 40, y: 80, width: 180, height: 24 },
          confidence: 0.85
        }]
      };
    },
    async inspectUi() {
      calls.ui += 1;
      return {
        targets: [{
          targetId: "uia-save",
          source: "UIA",
          windowId: "42",
          name: "Save",
          automationId: "FileSave",
          controlType: "ControlType.Button",
          boundingRect: { x: 20, y: 30, width: 70, height: 28 },
          supportedPatterns: ["InvokePatternIdentifiers.Pattern"],
          enabled: true
        }]
      };
    }
  };
}

test("VisionProvider normalizes window, OCR, and UIA data into a screen entity graph", async () => {
  const adapter = fixtureAdapter();
  const provider = new VisionProvider(adapter, { capabilityRegistry: availableRegistry() });
  const result = await provider.perceive({ includeVision: true }, "2026-08-03T10:00:00.000Z");

  assert.ok(result.snapshot.snapshotId);
  assert.equal(result.snapshot.windowId, "42");
  assert.equal(result.snapshot.ocrText, "Hello from pixels");
  assert.equal(result.snapshot.elements.length, 3, "window + UIA + OCR are unified");
  assert.ok(result.snapshot.elements.some((element) => element.text === "vision-fixture.txt - Notepad"));
  assert.ok(result.snapshot.elements.some((element) => element.text === "Hello from pixels" && element.source === "OCR"));
  assert.ok(result.snapshot.elements.some((element) => element.text === "Save" && element.clickable));

  const snapshots = result.entities.filter((entity) => entity.type === EntityType.ScreenSnapshot);
  const elements = result.entities.filter((entity) => entity.type === EntityType.ScreenElement);
  assert.equal(snapshots.length, 1);
  assert.equal(elements.length, 3);
  assert.ok(result.entities.some((entity) => entity.type === EntityType.Window));
  assert.equal(
    result.relationships.filter((relationship) => relationship.type === RelationshipType.CONTAINS).length,
    4,
    "window contains snapshot; snapshot contains every element"
  );
});

test("VisionProvider caches expensive capture/OCR work per foreground window for its TTL", async () => {
  let now = 1_000;
  const adapter = fixtureAdapter();
  const provider = new VisionProvider(adapter, {
    capabilityRegistry: availableRegistry(),
    ttlMs: 1_500,
    clock: () => now
  });

  const first = await provider.collect({ includeVision: true });
  now += 1_000;
  const cached = await provider.collect({ includeVision: true });
  assert.equal(cached.cached, true);
  assert.equal(cached.snapshotId, first.snapshotId, "cached reads reuse the same semantic snapshot identity");
  assert.deepEqual(adapter.calls, { capture: 1, ocr: 1, ui: 1 });

  now += 600;
  await provider.collect({ includeVision: true });
  assert.deepEqual(adapter.calls, { capture: 2, ocr: 2, ui: 2 });

  await provider.collect({ includeVision: true, forceVision: true });
  assert.deepEqual(adapter.calls, { capture: 3, ocr: 3, ui: 3 }, "forced before/after captures bypass TTL");
});

test("VisionProvider fails closed when the visual capability set is not grounded", async () => {
  const adapter = fixtureAdapter();
  const provider = new VisionProvider(adapter, {
    capabilityRegistry: { isAvailable: (name) => name !== "ocr.read" }
  });
  const result = await provider.perceive({ includeVision: true });
  assert.equal(result.snapshot, null);
  assert.equal(result.reason, "capability-unavailable:ocr.read");
  assert.deepEqual(adapter.calls, { capture: 0, ocr: 0, ui: 0 });
});

test("reasoning detects persisted screen/OCR state as vision-consent data", () => {
  assert.equal(containsVisionContext({ type: EntityType.ScreenSnapshot, properties: {} }), true);
  assert.equal(containsVisionContext({ currentState: { screenSnapshot: { ocrText: "visible text" } } }), true);
  assert.equal(containsVisionContext({ relevantControls: [{ source: "UIA", name: "Save" }] }), false);
});

test("diffScreenSnapshots reports deterministic visual changes without volatile target ids", () => {
  const before = {
    windowId: "42",
    pixelHash: "pixels-before",
    ocrText: "Ready",
    elements: [{
      targetId: "volatile-before",
      source: "UIA",
      role: "button",
      text: "Submit",
      automationId: "submit",
      bbox: { x: 10, y: 10, width: 80, height: 30 },
      enabled: true
    }]
  };
  const unchanged = {
    ...before,
    elements: [{ ...before.elements[0], targetId: "volatile-after" }]
  };
  assert.equal(diffScreenSnapshots(before, unchanged).changed, false);

  const after = {
    ...unchanged,
    pixelHash: "pixels-after",
    ocrText: "Submitted",
    elements: [
      { ...unchanged.elements[0], enabled: false },
      { source: "OCR", role: "text", text: "Submitted", bbox: { x: 10, y: 50, width: 100, height: 20 } }
    ]
  };
  const diff = diffScreenSnapshots(before, after);
  assert.equal(diff.changed, true);
  assert.equal(diff.pixelsChanged, true);
  assert.equal(diff.textChanged, true);
  assert.equal(diff.changedElements.length, 1);
  assert.equal(diff.added.length, 1);
});

test("interactive UI actions capture durable before/after snapshots and use their diff as progress evidence", async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    name: "ui.action",
    version: "1.0.0",
    description: "test UI action",
    inputSchema: {
      type: "object",
      properties: { target: { type: "object" }, action: { type: "string" } },
      required: ["target", "action"]
    },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: "LOW" },
    permissions: [],
    reversibility: "NOT_REQUIRED",
    preconditions: () => true,
    execute: async () => ({ performed: true }),
    observe: async (result) => ({ structuredState: result }),
    verify: async () => ({ status: "PARTIALLY_VERIFIED" }),
    rollback: null,
    timeout: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: "VERIFIED"
  });
  const target = {
    targetId: "submit",
    source: "UIA",
    windowId: "42",
    automationId: "submit",
    name: "Submit",
    controlType: "ControlType.Button",
    supportedPatterns: ["InvokePatternIdentifiers.Pattern"]
  };
  const phases = [];
  let modelCalls = 0;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: { async decideInteractiveAction() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          ok: true,
          data: {
            goalStatus: "IN_PROGRESS",
            action: { capability: "ui.action", inputs: { target, action: "invoke" } }
          }
        };
      }
      return {
        ok: true,
        data: {
          goalStatus: "COMPLETE",
          result: { summary: "Submit was clicked" },
          verification: {
            allCriteriaSatisfied: true,
            satisfiedCriteria: [{ criterion: "Submit is clicked", evidence: "The durable screen snapshot changed after invoking Submit." }]
          }
        }
      };
    } },
    perceive: async () => ({ relevantControls: [target] }),
    captureScreenSnapshot: async ({ phase }) => {
      phases.push(phase);
      return {
        snapshotId: `snapshot-${phases.length}`,
        windowId: "42",
        ocrText: phase === "before" ? "Ready" : "Submitted",
        elements: [{ source: "UIA", automationId: "submit", role: "button", text: "Submit", bbox: { x: 1, y: 1, width: 10, height: 10 } }]
      };
    },
    executeAction: async () => ({
      executionResult: { performed: true, target },
      observation: { structuredState: { performed: true, target } },
      verification: { status: "PARTIALLY_VERIFIED", confidence: 0.8 }
    })
  });

  const result = await controller.run('click the "Submit" button', { successCriteria: ["Submit is clicked"] });
  assert.equal(result.status, "COMPLETE");
  assert.equal(phases.length, result.recentActions.length * 2);
  assert.ok(phases.every((phase, index) => phase === (index % 2 === 0 ? "before" : "after")));
  assert.ok(result.recentActions.every((action) => action.screenDiff.changed === true));
  assert.ok(result.recentActions.every((action) => action.progressMeasurement.evidence === "durable-screen-snapshot-diff"));
});
