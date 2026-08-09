import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultCapabilityRegistry,
  normalizeVisualText,
  scoreVisualMatch
} from "../../packages/capability-registry/src/index.js";
import { createDefaultProviders } from "../../packages/perception/src/providers.js";
import { VisionProvider } from "../../packages/perception/src/vision-provider.js";

// A window the adapter can describe, capture, OCR and inspect — enough for the
// whole visual path to run without a desktop.
function fakeAdapter({
  windows = [
    { WindowHandle: 11, ProcessName: "Notepad", MainWindowTitle: "notes - Notepad", Bounds: { x: 0, y: 0, width: 800, height: 600 }, Foreground: false },
    { WindowHandle: 22, ProcessName: "Chrome", MainWindowTitle: "Docs - Chrome", Bounds: { x: 0, y: 0, width: 1200, height: 900 }, Foreground: true }
  ],
  ocrText = "File Edit View Save As",
  uiaElements = [{ targetId: "u1", name: "Text editor", controlType: "ControlType.Document", boundingRect: { x: 10, y: 40, width: 700, height: 500 }, value: "hello world", supportedPatterns: ["ValuePatternIdentifiers.Pattern"], enabled: true }]
} = {}) {
  const calls = [];
  return {
    calls,
    async listWindows() { return windows; },
    async captureScreen(args) {
      calls.push(["captureScreen", args]);
      return { captured: true, path: "C:/tmp/does-not-exist.png", bounds: { x: 0, y: 0, width: 800, height: 600 }, windowId: args.windowId, timestamp: "2026-08-08T00:00:00.000Z" };
    },
    async readOcr(args) {
      calls.push(["readOcr", args]);
      return {
        text: ocrText,
        targets: [
          { targetId: "o1", name: "Save As", boundingRect: { x: 100, y: 12, width: 60, height: 20 }, confidence: 0.85 },
          { targetId: "o2", name: "File", boundingRect: { x: 10, y: 12, width: 30, height: 20 }, confidence: 0.85 }
        ]
      };
    },
    async inspectUi(args) {
      calls.push(["inspectUi", args]);
      return { elements: uiaElements, targets: uiaElements };
    },
    async pointerAction(operation, params) {
      calls.push([`pointer.${operation}`, params]);
      return { performed: true, ...params };
    },
    async locateVisualTarget() { return { found: false, reason: "visual-target-not-found", target: null, matches: [] }; },
    async keyboardAction() { return { performed: true }; }
  };
}

test("the default perception providers include vision, so the world model can see", () => {
  const providers = createDefaultProviders(fakeAdapter(), null, { capabilityRegistry: null });
  const vision = providers.find((provider) => provider.name === "vision");
  assert.ok(vision instanceof VisionProvider, "VisionProvider must be registered by default");
});

test("vision resolves a window by application name instead of grabbing the foreground", async () => {
  const adapter = fakeAdapter();
  const provider = new VisionProvider(adapter, { capabilityRegistry: { isAvailable: () => true } });
  const raw = await provider.collect({ application: "Notepad", includeVision: true });
  assert.equal(raw.available, true);
  // Chrome is the foreground window; Notepad is the one that was asked for.
  assert.equal(raw.window.windowId, "11");
  assert.equal(raw.window.processName, "Notepad");
});

test("vision reports no window rather than the wrong one when the application is absent", async () => {
  const provider = new VisionProvider(fakeAdapter(), { capabilityRegistry: { isAvailable: () => true } });
  const raw = await provider.collect({ application: "Photoshop", includeVision: true });
  assert.equal(raw.available, false);
  assert.equal(raw.reason, "active-window-not-grounded");
});

test("screen.read returns visible text and clickable centres for every element", async () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const result = await registry.get("screen.read").execute({ application: "Notepad" });
  assert.equal(result.read, true);
  assert.equal(result.title, "notes - Notepad");
  assert.match(result.visibleText, /Save As/);

  const saveAs = result.elements.find((element) => element.text === "Save As");
  assert.ok(saveAs, "an OCR-only label must be reachable as an element");
  // 100 + 60/2, 12 + 20/2 — the point a click would actually land on.
  assert.deepEqual(saveAs.center, { x: 130, y: 22 });

  const editor = result.elements.find((element) => element.value === "hello world");
  assert.ok(editor, "UIA values must survive into the fused reading");
});

test("screen.read is read-only, so an informational goal may use it", () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const capability = registry.get("screen.read");
  assert.equal(capability.permissionModel.type, "READ");
  assert.equal(capability.risk.level, "LOW");
});

test("visual matching tolerates the ways OCR mangles a label", () => {
  assert.equal(scoreVisualMatch(normalizeVisualText("Save"), normalizeVisualText("Save")), 1);
  // Letter-spaced UI fonts OCR as doubled spaces.
  assert.ok(scoreVisualMatch(normalizeVisualText("Sign in"), normalizeVisualText("Sign  in")) >= 0.9);
  // A truncated menu item keeps its ellipsis.
  assert.ok(scoreVisualMatch(normalizeVisualText("Save As"), normalizeVisualText("Save As…")) >= 0.8);
  // A different label that merely shares a word is not a match.
  assert.equal(scoreVisualMatch(normalizeVisualText("Save file"), normalizeVisualText("Open recent")), 0);
});

test("vision.locate falls back to fuzzy matching and names what it could see", async () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const hit = await registry.get("vision.locate").execute({ application: "Notepad", query: "Save" });
  assert.equal(hit.found, true);
  assert.equal(hit.matchedText, "Save As");

  const miss = await registry.get("vision.locate").execute({ application: "Notepad", query: "Publish to production" });
  assert.equal(miss.found, false);
  assert.ok(miss.visibleCandidates.includes("Save As"), "a miss must report what was actually on screen");
});

test("pointer.clickAt refuses a coordinate that is not inside a live window", async () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  await assert.rejects(
    () => registry.get("pointer.clickAt").execute({ application: "Notepad", x: 9000, y: 9000 }),
    /outside/
  );
});

test("pointer.clickAt clicks an in-window coordinate on the named window", async () => {
  const adapter = fakeAdapter();
  const registry = createDefaultCapabilityRegistry(adapter, {});
  const result = await registry.get("pointer.clickAt").execute({ application: "Notepad", x: 130, y: 22 });
  assert.equal(result.performed, true);
  assert.equal(result.window.windowId, "11");
  const click = adapter.calls.find(([name]) => name === "pointer.click");
  assert.deepEqual([click[1].x, click[1].y, click[1].windowId], [130, 22, "11"]);
});

test("pointer.wheel parks the cursor over the window and sends one event per notch", async () => {
  const adapter = fakeAdapter();
  const registry = createDefaultCapabilityRegistry(adapter, {});
  const result = await registry.get("pointer.wheel").execute({ application: "Notepad", notches: -3, speed: "fast" });
  assert.equal(result.performed, true);
  assert.equal(result.delivered, 3);
  assert.equal(result.direction, "down");

  const moves = adapter.calls.filter(([name]) => name === "pointer.move");
  assert.equal(moves.length, 1, "the pointer must be placed before scrolling");
  // Centre of the 800x600 Notepad window.
  assert.deepEqual([moves[0][1].x, moves[0][1].y], [400, 300]);

  const wheels = adapter.calls.filter(([name]) => name === "pointer.wheel");
  assert.equal(wheels.length, 3, "each notch is a real wheel event, not one clamped burst");
  assert.ok(wheels.every(([, params]) => params.delta === -120));
});

test("pointer.wheel still accepts a legacy raw delta", async () => {
  const adapter = fakeAdapter();
  const registry = createDefaultCapabilityRegistry(adapter, {});
  const result = await registry.get("pointer.wheel").execute({ application: "Notepad", delta: -240, speed: "fast" });
  assert.equal(result.delivered, 2);
});

test("pointer.wheel can perceive fresh UI throughout a slow scroll", async () => {
  const adapter = fakeAdapter({ ocrText: "Start of page" });
  let frame = 0;
  adapter.readOcr = async (args) => {
    adapter.calls.push(["readOcr", args]);
    frame += 1;
    const text = frame >= 3 ? "Start of page Destination setting" : `Start of page section ${frame}`;
    return { text, targets: [{ targetId: `o${frame}`, name: text, boundingRect: { x: 10, y: 12, width: 200, height: 20 }, confidence: 0.9 }] };
  };
  const registry = createDefaultCapabilityRegistry(adapter, {});
  const result = await registry.get("pointer.wheel").execute({
    application: "Notepad", notches: -8, speed: "fast", observe: true, observeEvery: 1,
    untilText: "Destination setting"
  });

  assert.equal(result.stoppedOnText, true);
  assert.equal(result.delivered, 2, "scrolling stops immediately after the requested text is perceived");
  assert.equal(result.frames.length, 3, "one initial and one post-motion perception per delivered notch");
  assert.match(result.frames.at(-1).visibleText, /Destination setting/);
});

test("keyboard.type fails when the text is not in the window afterwards", async () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const verification = await registry.get("keyboard.type").verify(
    { structuredState: { performed: true, method: "clipboard-paste", windowId: "11" } },
    { windowId: "11", text: "text that never arrived" }
  );
  assert.equal(verification.status, "FAILED");
  assert.match(verification.message, /hello world/, "the failure must say what the window actually shows");
});

test("keyboard.type verifies against what the window actually contains", async () => {
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const verification = await registry.get("keyboard.type").verify(
    { structuredState: { performed: true, method: "clipboard-paste", windowId: "11" } },
    { windowId: "11", text: "hello world" }
  );
  assert.equal(verification.status, "VERIFIED");
});

test("keyboard.type says it cannot tell when nothing can be read back", async () => {
  const adapter = fakeAdapter({ uiaElements: [], ocrText: "" });
  const registry = createDefaultCapabilityRegistry(adapter, {});
  const verification = await registry.get("keyboard.type").verify(
    { structuredState: { performed: true, method: "sendkeys", windowId: "11" } },
    { windowId: "11", text: "secret" }
  );
  assert.equal(verification.status, "PARTIALLY_VERIFIED");
  assert.match(verification.message, /could not be read back/);
});

test("a session stays on the window it grounded even when the model names only an app", async () => {
  const { AgentRuntime } = await import("../../packages/agent-runtime/src/index.js");
  const pin = AgentRuntime.prototype._pinActionToGroundedWindow;
  const grounded = { WindowHandle: 11, ProcessName: "Notepad", MainWindowTitle: "notes - Notepad" };
  const context = { currentPerception: { groundedWindow: grounded } };

  // Three Notepad windows are open; "Notepad" alone cannot say which.
  const pinned = pin.call({}, { capability: "keyboard.type", inputs: { application: "Notepad", text: "hi" } }, context);
  assert.equal(pinned.inputs.windowId, "11");
  assert.equal(pinned.inputs.application, "Notepad", "the application name is kept, not replaced");

  // A session-pinned launch result wins over a later ambient perception of a
  // different document from the same application.
  const sessionPinned = pin.call({},
    { capability: "keyboard.type", inputs: { application: "Notepad", text: "hi" } },
    {
      groundedWindow: { WindowHandle: 22, ProcessName: "Notepad", MainWindowTitle: "new document - Notepad" },
      currentPerception: { groundedWindow: grounded }
    }
  );
  assert.equal(sessionPinned.inputs.windowId, "22");

  // An explicit window the model chose is authoritative and must not be rewritten.
  const explicit = pin.call({}, { capability: "keyboard.type", inputs: { application: "Notepad", windowId: "99" } }, context);
  assert.equal(explicit.inputs.windowId, "99");

  // A different application must never be pinned to this window.
  const other = pin.call({}, { capability: "keyboard.type", inputs: { application: "Chrome" } }, context);
  assert.equal(other.inputs.windowId, undefined);

  // Nothing grounded yet: leave the action exactly as the model wrote it.
  const ungrounded = pin.call({}, { capability: "keyboard.type", inputs: { application: "Notepad" } }, {});
  assert.equal(ungrounded.inputs.windowId, undefined);
});

test("the catalog shown to the model keeps capability aliases", async () => {
  const { InteractiveAgentController } = await import("../../packages/agent-runtime/src/index.js");
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const catalog = controller._catalog("open notepad and type hello");

  const typing = catalog.find((entry) => entry.name === "keyboard.type");
  assert.ok(typing, "keyboard.type must be offered for a typing goal");
  assert.ok(
    typing.aliases.includes("keyboard.typeText"),
    "aliases must reach the model's catalog or alias resolution can never fire"
  );

  // The resolver the decision path uses must now accept the synonym.
  const { resolveCapabilityId, CapabilityResolutionKind } =
    await import("../../packages/shared-types/src/capability-resolution.js");
  const resolved = resolveCapabilityId("keyboard.typeText", catalog);
  assert.equal(resolved.kind, CapabilityResolutionKind.CANONICAL_ALIAS);
  assert.equal(resolved.canonicalId, "keyboard.type");
});

test("a decision the model wrote wrongly is re-asked, not fatal", async () => {
  const { InteractiveAgentController } = await import("../../packages/agent-runtime/src/index.js");
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  let calls = 0;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: {
      async decideInteractiveAction() {
        calls += 1;
        // The model answered; the answer was malformed. That is recoverable.
        return { ok: false, error: "localSteps[0] uses unknown capability: nope.nope", recoverable: true };
      }
    },
    perceive: async () => ({ windows: [], relevantControls: [] }),
    executeAction: async () => assert.fail("nothing valid was ever proposed"),
    budgets: { maxMalformedProposals: 3, maxModelCalls: 20, maxElapsedTime: 20000 }
  });

  const result = await controller.run("open notepad and type hello");
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "max-malformed-proposals");
  assert.equal(calls, 3, "the loop must re-ask up to its malformed-proposal budget");
});

test("a provider that never answered ends the run instead of re-asking", async () => {
  const { InteractiveAgentController } = await import("../../packages/agent-runtime/src/index.js");
  const registry = createDefaultCapabilityRegistry(fakeAdapter(), {});
  let calls = 0;
  const controller = new InteractiveAgentController({
    capabilityRegistry: registry,
    reasoningEngine: {
      async decideInteractiveAction() {
        calls += 1;
        return { ok: false, error: "provider-unhealthy", recoverable: false };
      }
    },
    perceive: async () => ({ windows: [], relevantControls: [] }),
    executeAction: async () => assert.fail("nothing was proposed"),
    budgets: { maxMalformedProposals: 3, maxModelCalls: 20, maxElapsedTime: 20000 }
  });

  const result = await controller.run("open notepad and type hello");
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "provider-unhealthy");
  assert.equal(calls, 1, "an unreachable provider must not be asked again in the same loop");
});

test("a reasoning call cannot outlive the session budget that asked for it", async () => {
  const { ReasoningEngine } = await import("../../packages/reasoning-engine/src/index.js");
  const attempts = [];
  const engine = new ReasoningEngine({
    minTimeoutMs: 0,
    modelProvider: {
      async generateStructured(prompt, schema, options) {
        attempts.push(options.timeoutMs);
        // Answer, but wrongly, so the repair loop wants another attempt.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { nonsense: true };
      }
    }
  });

  const result = await engine._reasonStructured(
    "decide",
    { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
    // Less budget than the provider takes, so the repair attempt finds the
    // deadline already gone.
    { timeoutMs: 70000, budgetMs: 30, skipHealthGate: true }
  );

  assert.equal(result.ok, false);
  assert.equal(result.recoverable, false, "an exhausted budget is not worth re-asking inside the same loop");
  assert.equal(attempts.length, 1, "no attempt may start after the budget is spent");
  // The 70s per-call timeout must have been clamped to the 30ms budget.
  assert.ok(attempts[0] <= 30, `expected the budget to cap the request, got ${attempts[0]}ms`);
});

test("without a budget a reasoning call keeps its configured timeout", async () => {
  const { ReasoningEngine } = await import("../../packages/reasoning-engine/src/index.js");
  const attempts = [];
  const engine = new ReasoningEngine({
    minTimeoutMs: 0,
    modelProvider: {
      async generateStructured(prompt, schema, options) {
        attempts.push(options.timeoutMs);
        return { kind: "ACT" };
      }
    }
  });
  const result = await engine._reasonStructured(
    "decide",
    { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] },
    { timeoutMs: 70000, skipHealthGate: true }
  );
  assert.equal(result.ok, true);
  assert.equal(attempts[0], 70000);
});

test("a screen reading is taken once per step, but never reused after acting", async () => {
  const { AgentRuntime } = await import("../../packages/agent-runtime/src/index.js");
  const adapter = fakeAdapter();
  const runtime = Object.create(AgentRuntime.prototype);
  runtime.adapter = adapter;
  runtime.perception = null; // exercise the direct-adapter path

  const captures = () => adapter.calls.filter(([name]) => name === "captureScreen").length;

  await runtime._captureScreenEvidence({ windowId: "11" });
  assert.equal(captures(), 1);

  // The controller's "before" reading for the same window in the same step.
  await runtime._captureScreenEvidence({ windowId: "11", phase: "before", force: true });
  assert.equal(captures(), 1, "the before-reading must reuse the reading just taken");

  // The "after" reading is what proves the action did something. Never cached.
  await runtime._captureScreenEvidence({ windowId: "11", phase: "after", force: true });
  assert.equal(captures(), 2, "the after-reading must be a genuinely fresh look");

  // A different window is a different picture.
  await runtime._captureScreenEvidence({ windowId: "22" });
  assert.equal(captures(), 3);
});

test("the automation host can be warmed, and a host that will not start is not fatal", async () => {
  const { WindowsAutomationHostClient } = await import("../../os-adapters/windows-host/src/client.js");

  const healthy = new WindowsAutomationHostClient();
  const asked = [];
  healthy.start = () => {};
  healthy.request = async (operation) => { asked.push(operation); return { ok: true }; };
  assert.equal(await healthy.warm(), true);
  assert.deepEqual(asked, ["host.health"], "warming must actually round-trip, not just spawn");

  const broken = new WindowsAutomationHostClient();
  broken.start = () => { throw new Error("powershell is missing"); };
  assert.equal(await broken.warm(), false, "a host that cannot start must report it, not throw");
});

test("a postcondition that cannot be checked does not discard an action's evidence", async () => {
  const { evaluatePostcondition } = await import("../../packages/shared-types/src/postconditions.js");

  // What a model actually writes most of the time: a sentence, not a predicate.
  const prose = evaluatePostcondition(
    { description: "Visible text includes 'Ultron online' and the status bar shows 13 characters" },
    { executionResult: { visibleText: "Ultron online" } }
  );
  assert.equal(prose.satisfied, false);
  assert.equal(prose.evaluated, false, "an uncheckable predicate must not masquerade as a failed one");

  const unsupported = evaluatePostcondition({ kind: "VIBES_MATCH", expected: "good" }, {});
  assert.equal(unsupported.evaluated, false);

  // A real predicate that genuinely does not hold stays a refutation.
  const violated = evaluatePostcondition(
    { kind: "TEXT_CONTAINS", path: "executionResult.visibleText", expected: "Jarvis" },
    { executionResult: { visibleText: "Ultron online" } }
  );
  assert.equal(violated.satisfied, false);
  assert.equal(violated.evaluated, true);

  const held = evaluatePostcondition(
    { kind: "TEXT_CONTAINS", path: "executionResult.visibleText", expected: "Ultron" },
    { executionResult: { visibleText: "Ultron online" } }
  );
  assert.deepEqual([held.satisfied, held.evaluated], [true, true]);

  // The controller's gate: only an evaluated-and-failed predicate wipes evidence.
  const wipes = (result) => result?.evaluated === true && !result.satisfied;
  assert.equal(wipes(prose), false, "prose must not erase evidence");
  assert.equal(wipes(unsupported), false);
  assert.equal(wipes(violated), true, "a genuine violation must still erase evidence");
  assert.equal(wipes(held), false);
});

test("compacting a screen reading keeps the text, not just the bookkeeping", async () => {
  const { compactObservationForModel } =
    await import("../../packages/agent-runtime/src/interactive-agent-controller.js");

  // A realistic screen.read: a modest transcript and a very large element list.
  const reading = {
    read: true,
    windowId: "1772940",
    title: "notes - Notepad",
    visibleText: "Ultron aka Jarvis is ready sir. Ln 1, Col 32 31 characters",
    elements: Array.from({ length: 240 }, (_, index) => ({
      targetId: `element-${index}`,
      text: `control number ${index} with a reasonably long accessible name`,
      bounds: { x: index, y: index, width: 100, height: 20 },
      center: { x: index + 50, y: index + 10 }
    }))
  };

  const compacted = compactObservationForModel(reading);
  assert.ok(compacted.truncated, "an oversized reading must still be compacted");
  assert.equal(compacted.visibleText, reading.visibleText, "the screen text is the one field that must survive");
  assert.equal(compacted.title, "notes - Notepad");
  assert.ok(!compacted.elements, "the element list is what made it oversized");
});
