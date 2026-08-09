import test from "node:test";
import assert from "node:assert/strict";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { GeneralPlanner, PlanValidator } from "../../packages/planner/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

let modelDecisions = 0;
const decidingReasoning = {
  async understandIntent(text, context) {
    modelDecisions += 1;
    // Deterministic test oracle standing in for a remote model response. The
    // outer IntentEngine must still consult this decision before routing.
    const parsed = await new IntentEngine(null).classify(text, context);
    return { ok: true, data: parsed };
  }
};

test("the model selects calculator evaluation and it compiles to one typed task", async () => {
  const before = modelDecisions;
  const intent = await new IntentEngine(decidingReasoning).classify("open calculator and do the math 39 x 17");
  assert.equal(modelDecisions, before + 1);
  assert.equal(intent.operation, "calculator.evaluate");
  assert.equal(intent.entities.expression, "39*17");
  assert.equal(intent.entities.expectedResult, "663");

  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["calculator.evaluate"]);
  assert.deepEqual(new PlanValidator(registry).validatePlan(plan.taskGraph), { valid: true, errors: [] });
});

test("the model resolves a Spotify queue continuation from conversation context", async () => {
  const before = modelDecisions;
  const intent = await new IntentEngine(decidingReasoning).classify("now add cry for me to queue", {
    history: [
      { role: "user", text: "play Dracula on Spotify" },
      { role: "assistant", text: "Dracula is playing in Spotify." }
    ]
  });
  assert.equal(modelDecisions, before + 1);
  assert.equal(intent.operation, "spotify.track.queue");
  assert.equal(intent.entities.query, "cry for me");

  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["spotify.track.queue"]);
  assert.equal(registry.get("spotify.track.queue").permissionModel.type, "READ");
});

test("the model routes an explicit unsent WhatsApp request to the bounded draft capability", async () => {
  const before = modelDecisions;
  const intent = await new IntentEngine(decidingReasoning).classify(
    "open whatsapp and types a message to Amma saying hi where are you, do not send it, just type and stop"
  );
  assert.equal(modelDecisions, before + 1);
  assert.equal(intent.operation, "whatsapp.message.draft");
  assert.deepEqual(
    { contact: intent.entities.contact, message: intent.entities.message, send: intent.entities.send },
    { contact: "Amma", message: "hi where are you", send: false }
  );
  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["whatsapp.message.draft"]);
  assert.equal(registry.get("whatsapp.message.draft").permissionModel.type, "READ");
});

test("the model routes a creator-latest request to channel-first YouTube playback", async () => {
  const before = modelDecisions;
  const intent = await new IntentEngine(decidingReasoning).classify(
    "play ashish chanchlani's latest video on youtube"
  );
  assert.equal(modelDecisions, before + 1);
  assert.equal(intent.operation, "browser.youtube.latest");
  assert.equal(intent.entities.creator, "ashish chanchlani");
  assert.ok(intent.constraints.includes("REJECT_OPTIONAL_COOKIES"));

  const registry = createDefaultCapabilityRegistry({});
  const plan = await new GeneralPlanner(null, registry).generatePlan(intent, []);
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["browser.youtube.latest"]);
  assert.equal(registry.get("browser.youtube.latest").permissionModel.type, "READ");
});

test("Calculator enters the whole expression in one foreground keyboard action", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  const keyboard = [];
  adapter.launchApplication = async () => ({ windowIdentity: { windowId: "42" } });
  adapter.keyboardAction = async (operation, inputs) => { keyboard.push({ operation, inputs }); return { performed: true }; };
  adapter.inspectUi = async () => ({ elements: [{ name: "Display is 663" }] });
  const result = await adapter.calculateWithUi("39*17", "663");
  assert.equal(result.matched, true);
  assert.equal(keyboard.length, 1);
  assert.deepEqual(keyboard[0], { operation: "press", inputs: { application: "calculator", windowId: "42", keys: "{ESC}39*17{ENTER}" } });
});

test("Calculator verification accepts the locale thousands separator", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  adapter.launchApplication = async () => ({ windowIdentity: { windowId: "42" } });
  adapter.keyboardAction = async () => ({ performed: true });
  adapter.inspectUi = async () => ({ elements: [{ name: "Display is 111,276" }] });
  const result = await adapter.calculateWithUi("99*1124", "111276");
  assert.equal(result.matched, true);
  assert.equal(result.visibleResult, "Display is 111,276");
});

test("WhatsApp draft workflow never emits a send key after typing the message", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  const actions = [];
  adapter.launchApplication = async () => ({ windowIdentity: { windowId: "84" } });
  adapter.manageWindow = async (operation, inputs) => { actions.push({ kind: "window", operation, inputs }); return { performed: true }; };
  adapter.pointerAction = async (operation, inputs) => { actions.push({ kind: "pointer", operation, inputs }); return { performed: true }; };
  adapter.keyboardAction = async (operation, inputs) => { actions.push({ kind: "keyboard", operation, inputs }); return { performed: true }; };
  let screenRead = 0;
  const target = (name, y) => ({ name, boundingRect: { x: 100, y, width: 180, height: 30 } });
  adapter._readApplicationOcr = async () => {
    screenRead += 1;
    if (screenRead === 1) return { readable: true, text: "Search or start a new chat", targets: [target("Search or start a new chat", 100)] };
    if (screenRead === 2) return { readable: true, text: "Amma", targets: [target("Amma", 180)] };
    if (screenRead === 3) return { readable: true, text: "Amma Type a message", targets: [target("Type a message", 600)] };
    return { readable: true, text: "Amma hi where are you", targets: [] };
  };
  const result = await adapter.draftWhatsAppMessage("Amma", "hi where are you");
  assert.equal(result.drafted, true);
  assert.equal(result.sent, false);
  assert.equal(result.sendInvoked, false);
  const keyboard = actions.filter((action) => action.kind === "keyboard");
  assert.equal(keyboard.at(-1).operation, "type");
  assert.equal(keyboard.at(-1).inputs.text, "hi where are you");
});

test("WhatsApp opens an already-visible chat without requiring a textual search control", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  const actions = [];
  adapter.launchApplication = async () => ({ windowIdentity: { windowId: "84" } });
  adapter.manageWindow = async () => ({ performed: true });
  adapter.pointerAction = async (operation, inputs) => { actions.push({ kind: "pointer", operation, inputs }); return { performed: true }; };
  adapter.keyboardAction = async (operation, inputs) => { actions.push({ kind: "keyboard", operation, inputs }); return { performed: true }; };
  let screenRead = 0;
  const target = (name, y) => ({ name, boundingRect: { x: 100, y, width: 180, height: 30 } });
  adapter._readApplicationOcr = async () => {
    screenRead += 1;
    if (screenRead === 1) return { readable: true, text: "Chats Amma", targets: [target("Amma", 180)] };
    if (screenRead === 2) return { readable: true, text: "Amma Type a message", targets: [target("Type a message", 600)] };
    return { readable: true, text: "Amma polite draft", targets: [] };
  };
  const result = await adapter.draftWhatsAppMessage("Amma", "polite draft");
  assert.equal(result.drafted, true);
  assert.equal(result.sent, false);
  assert.equal(actions.some((action) => action.kind === "keyboard" && action.inputs.keys === "^f"), false);
  assert.equal(actions.at(-1).inputs.text, "polite draft");
});
