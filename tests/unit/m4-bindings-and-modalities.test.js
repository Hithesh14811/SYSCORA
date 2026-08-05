import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskInputs, collectInputReferences } from "../../packages/agent-runtime/src/input-bindings.js";
import {
  ExecutionModality,
  createInteractionTarget,
  validateInteractionTarget
} from "../../packages/shared-types/src/execution.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";

test("runtime references bind actual prior output and record provenance", () => {
  const taskResults = new Map([["find", { target: { source: "UIA", windowId: "42", name: "Save" } }]]);
  const template = {
    target: "$task.find.output.target",
    literal: "unchanged"
  };
  assert.deepEqual(collectInputReferences(template), ["$task.find.output.target"]);
  const resolved = resolveTaskInputs(template, { taskResults });
  assert.equal(resolved.inputs.target.name, "Save");
  assert.equal(resolved.inputs.literal, "unchanged");
  assert.deepEqual(resolved.provenance[0], {
    reference: "$task.find.output.target", kind: "task", id: "find", path: "output.target"
  });
});

test("missing runtime references fail closed", () => {
  assert.throws(
    () => resolveTaskInputs({ target: "$task.missing.target" }),
    /Unresolved runtime reference/
  );
});

test("unified visual targets require fresh confidence and bounds", () => {
  const target = createInteractionTarget({
    source: "OCR", windowId: "w1", name: "Settings",
    bounds: { x: 10, y: 20, width: 80, height: 20 }, confidence: 0.9,
    observationId: "screen-1",
    expectedForegroundWindowId: "w1",
    windowIdentity: {
      windowId: "w1", processId: 7, processName: "sample", title: "Sample",
      className: "SampleWindow", bounds: { x: 0, y: 0, width: 800, height: 600 },
      displayId: "DISPLAY1", dpi: 96
    }
  });
  assert.equal(validateInteractionTarget(target).valid, true);
  assert.equal(validateInteractionTarget({ ...target, confidence: 0.2 }).valid, false);
  assert.equal(validateInteractionTarget({ ...target, observationId: null }).valid, false);
});

test("general M4 primitives are planner-visible with modality metadata", () => {
  const adapter = {
    listWindows: async () => [],
    manageWindow: async () => ({}),
    findUiTarget: async () => ({}),
    performUiAction: async () => ({}),
    captureScreen: async () => ({}),
    pointerAction: async () => ({}),
    keyboardAction: async () => ({}),
    clipboardAction: async () => ({})
  };
  const registry = createDefaultCapabilityRegistry(adapter);
  for (const name of ["window.enumerate", "ui.find", "ui.action", "screen.capture", "pointer.click"]) {
    assert.equal(registry.has(name), true, name);
    assert.ok(registry.getCatalog().find((cap) => cap.name === name)?.execution?.modalities?.length);
  }
  assert.equal(
    registry.get("ui.find").execution.preferredModality,
    ExecutionModality.UI_AUTOMATION
  );
});

test("target resolver audits UIA to visual fallback and unified action consumes it", async () => {
  const calls = [];
  const observedWindow = {
    WindowHandle: "w1", Id: 7, ProcessName: "sample", MainWindowTitle: "Sample",
    ClassName: "SampleWindow", Bounds: { x: 0, y: 0, width: 800, height: 600 },
    DisplayId: "DISPLAY1", Dpi: 96, Foreground: true
  };
  const adapter = {
    listWindows: async () => [observedWindow],
    manageWindow: async () => ({}),
    findUiTarget: async () => ({ found: false, reason: "target-not-found" }),
    locateVisualTarget: async () => ({
      found: true,
      target: createInteractionTarget({
        source: "OCR", windowId: "w1", name: "File",
        bounds: { x: 10, y: 10, width: 40, height: 20 }, confidence: 0.9,
        observationId: "screen-1",
        expectedForegroundWindowId: "w1",
        windowIdentity: {
          windowId: "w1", processId: 7, processName: "sample", title: "Sample",
          className: "SampleWindow", bounds: observedWindow.Bounds,
          displayId: "DISPLAY1", dpi: 96
        }
      })
    }),
    performUiAction: async () => ({}),
    captureScreen: async () => ({}),
    readOcr: async () => ({}),
    pointerAction: async (_operation, args) => { calls.push(args); return { performed: true }; },
    keyboardAction: async () => ({}),
    clipboardAction: async () => ({})
  };
  const registry = createDefaultCapabilityRegistry(adapter);
  const resolved = await registry.get("ui.resolveTarget").execute({
    windowId: "w1", selector: { automationId: "missing" }, visualQuery: "File"
  });
  assert.equal(resolved.target.source, "OCR");
  assert.deepEqual(resolved.fallbacks[0], {
    from: "UI_AUTOMATION", to: "VISION_GUI", reason: "target-not-found"
  });
  const action = await registry.get("ui.action").execute({
    target: resolved.target, action: "click"
  });
  assert.equal(action.performed, true);
  assert.deepEqual(calls[0], { windowId: "w1", x: 30, y: 20, button: "left" });
});

for (const [label, mutate] of [
  ["window bounds", (window) => ({ ...window, Bounds: { ...window.Bounds, x: 40 } })],
  ["display", (window) => ({ ...window, DisplayId: "DISPLAY2" })],
  ["DPI", (window) => ({ ...window, Dpi: 144 })],
  ["foreground window", (window) => ({ ...window, Foreground: false })]
]) {
  test(`coordinate action rejects changed ${label} before pointer input`, async () => {
    let pointerCalls = 0;
    const original = {
      WindowHandle: "w1", Id: 7, ProcessName: "sample", MainWindowTitle: "Sample",
      ClassName: "SampleWindow", Bounds: { x: 0, y: 0, width: 800, height: 600 },
      DisplayId: "DISPLAY1", Dpi: 96, Foreground: true
    };
    const adapter = {
      listWindows: async () => [mutate(original)],
      pointerAction: async () => { pointerCalls += 1; return { performed: true }; }
    };
    const registry = createDefaultCapabilityRegistry(adapter);
    const target = createInteractionTarget({
      source: "COORDINATE", windowId: "w1", name: "Search",
      bounds: { x: 10, y: 10, width: 40, height: 20 }, confidence: 0.95,
      observationId: "screen-1", expectedForegroundWindowId: "w1",
      windowIdentity: {
        windowId: "w1", processId: 7, processName: "sample", title: "Sample",
        className: "SampleWindow", bounds: original.Bounds, displayId: "DISPLAY1", dpi: 96
      }
    });

    await assert.rejects(
      registry.get("pointer.click").execute({ target }),
      /STALE_OBSERVATION|FOREGROUND_MISMATCH/
    );
    assert.equal(pointerCalls, 0);
  });
}
