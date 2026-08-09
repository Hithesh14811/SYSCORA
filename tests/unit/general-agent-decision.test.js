import test from "node:test";
import assert from "node:assert/strict";

import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { GeneralPlanner, OPERATION_PLANS } from "../../packages/planner/src/index.js";
import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import { CdpBrowserAdapter } from "../../os-adapters/browser/src/cdp-browser-adapter.js";

function decision(data, inspect = null) {
  return {
    async understandIntent(text, context) {
      inspect?.(text, context);
      return { ok: true, data };
    }
  };
}

test("natural language is decided by the model before application-specific fallback parsing", async () => {
  let calls = 0;
  const engine = new IntentEngine(decision({
    normalizedGoal: "Use a general command tool",
    category: "SYSTEM",
    entities: { command: "Get-Date" },
    requiredCapabilities: ["command.run"],
    successCriteria: ["The command result is reported"],
    confidence: 0.95
  }, () => { calls += 1; }));

  const intent = await engine.classify("open spotify and play a song");
  assert.equal(calls, 1);
  assert.equal(intent.operation, undefined);
  assert.deepEqual(intent.requiredCapabilities, ["command.run"]);
});

test("a model decision can preserve a real multi-capability goal instead of collapsing it to one route", async () => {
  const engine = new IntentEngine(decision({
    normalizedGoal: "Inspect a project, run its tests, and open the report",
    category: "DEVELOPER",
    entities: { workspacePath: "C:\\project", command: "npm test", application: "notepad" },
    requiredCapabilities: ["project.inspect", "command.run", "application.launch"],
    successCriteria: ["Project inspected", "Tests completed", "Report opened"],
    confidence: 0.93
  }));

  const intent = await engine.classify("inspect this project, run its tests, then open the report");
  assert.equal(intent.operation, undefined);
  assert.deepEqual(intent.requiredCapabilities, ["project.inspect", "command.run", "application.launch"]);
  assert.equal(intent.successCriteria.length, 3);
});

test("an exact multi-capability model decision compiles without a second model call", async () => {
  let planningCalls = 0;
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const planner = new GeneralPlanner({
    hasModel: () => true,
    isModelHealthy: async () => true,
    composeTaskGraph: async () => { planningCalls += 1; throw new Error("must not be called"); }
  }, registry);
  const plan = await planner.generatePlan({
    rawText: "play one track and queue another",
    normalizedGoal: "Play Tum Hi Ho Bandhu and queue Attention",
    entities: { query: "Tum Hi Ho Bandhu", queueQuery: "Attention" },
    requiredCapabilities: ["spotify.track.play", "spotify.track.queue"],
    successCriteria: ["Requested track is playing", "Queued track is in the queue"]
  }, []);
  assert.equal(planningCalls, 0);
  assert.equal(plan.plannerSource, "MODEL_DECISION_COMPILED");
  assert.deepEqual(plan.taskGraph.tasks.map((task) => task.capability), ["spotify.track.play", "spotify.track.queue"]);
  assert.equal(plan.taskGraph.tasks[1].inputs.query, "Attention");
});

test("an emotional check-in is a first-class conversational turn", async () => {
  const engine = new IntentEngine(decision({
    normalizedGoal: "Respond supportively",
    category: "CONVERSATION",
    directAnswer: "I'm sorry today feels heavy. I'm here with you—want to tell me what happened?",
    answerableWithoutInspecting: true,
    entities: {},
    requiredCapabilities: [],
    successCriteria: ["The user receives a supportive response"],
    confidence: 0.98
  }));

  const intent = await engine.classify("i am feeling low today");
  assert.equal(intent.category, "CONVERSATION");
  assert.match(intent.directAnswer, /here with you/i);
  assert.deepEqual(intent.requiredCapabilities, []);
});

test("provider-outage small talk cannot be mistaken for a Windows action", async () => {
  const engine = new IntentEngine({
    async understandIntent() { return { ok: false, error: "HTTP 503" }; }
  });
  const intent = await engine.classify("tell me a short joke");
  assert.equal(intent.modelDecisionStatus, "UNAVAILABLE");
  assert.deepEqual(intent.requiredCapabilities, []);
  const runtimeShape = Object.create(AgentRuntime.prototype);
  assert.equal(runtimeShape._looksConversational("tell me a short joke"), true);
  assert.equal(runtimeShape._looksConversational("open calculator and do 99 x 1124"), false);
});

test("conversation history is passed to the deciding model for contextual follow-ups", async () => {
  const history = [
    { role: "user", text: "Search flights to Dubai" },
    { role: "assistant", text: "I can open a browser search for that." }
  ];
  const engine = new IntentEngine(decision({
    normalizedGoal: "Open a browser search for flights to Dubai",
    category: "BROWSER",
    operation: "browser.search",
    entities: { query: "flights to Dubai" },
    requiredCapabilities: ["browser.search"],
    successCriteria: ["The flight search is open"],
    confidence: 0.96
  }, (_text, context) => assert.deepEqual(context.history, history)));

  const intent = await engine.classify("proceed with that", { history });
  assert.equal(intent.operation, "browser.search");
  assert.equal(intent.entities.query, "flights to Dubai");
});

test("the deciding model supplies exact composed WhatsApp draft text to the bounded tool", async () => {
  const message = "Hi Amma, could you please let me know where you are and how long you expect to take? I’m quite worried about you.";
  const engine = new IntentEngine(decision({
    normalizedGoal: "Draft a polite unsent WhatsApp message to Amma",
    category: "APPLICATION",
    operation: "whatsapp.message.draft",
    entities: { contact: "Amma", message, send: false },
    constraints: ["DO_NOT_SEND"],
    requiredCapabilities: ["whatsapp.message.draft"],
    successCriteria: ["The exact draft is visible", "No message is sent"],
    confidence: 0.99
  }));

  const intent = await engine.classify("draft a very polite WhatsApp message to Amma asking where she is; do not send");
  assert.equal(intent.operation, "whatsapp.message.draft");
  assert.equal(intent.entities.message, message);
  assert.equal(intent.entities.send, false);
});

test("the bounded outage fallback completes the whole calculator outcome in one task", async () => {
  const intent = await new IntentEngine(null).classify("open calculator and do 99 x 1124");
  assert.equal(intent.operation, "calculator.evaluate");
  assert.equal(intent.entities.expression, "99*1124");
  assert.equal(intent.entities.expectedResult, "111276");
  const tasks = OPERATION_PLANS[intent.operation](intent.entities);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].capability, "calculator.evaluate");
});

test("a model-selected calculator tool receives normalized verified arguments", async () => {
  const engine = new IntentEngine(decision({
    normalizedGoal: "Calculate 99 x 1124",
    category: "APPLICATION",
    operation: "calculator.evaluate",
    entities: { expression: "99 x 1124" },
    requiredCapabilities: ["calculator.evaluate"],
    successCriteria: ["Show the result"],
    confidence: 0.98
  }));
  const intent = await engine.classify("open calculator and do 99 x 1124");
  assert.equal(intent.operation, "calculator.evaluate");
  assert.equal(intent.entities.expression, "99*1124");
  assert.equal(intent.entities.expectedResult, "111276");
});

test("WinGet reinstall is a typed atomic outcome with independent installed-state verification", () => {
  const tasks = OPERATION_PLANS["package.winget.reinstall"]({ id: "Spotify.Spotify" });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].capability, "package.winget.reinstall");
  assert.equal(tasks[0].inputs.id, "Spotify.Spotify");

  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const capability = registry.get("package.winget.reinstall");
  assert.equal(capability.lifecycleStatus, "VERIFIED");
  assert.deepEqual(capability.inputSchema.required, ["id"]);
  assert.equal(typeof capability.verify, "function");
});

test("the reported Spotify reinstall wording has a complete bounded outage route", async () => {
  const intent = await new IntentEngine(null).classify("delete spotify and reinstall it");
  assert.equal(intent.operation, "package.winget.reinstall");
  assert.equal(intent.entities.id, "Spotify.Spotify");
});

test("transient provider failures half-open after cooldown instead of disabling the model forever", async () => {
  const provider = { healthCheck: async () => ({ ok: true }) };
  const reasoning = new ReasoningEngine({ modelProvider: provider });
  let now = 100;
  reasoning._nowMs = () => now;
  reasoning._recordLiveOutcome(false);
  reasoning._recordLiveOutcome(false);
  assert.equal(await reasoning.isModelHealthy(), false);

  now += ReasoningEngine.PROVIDER_RECOVERY_COOLDOWN_MS + 1;
  assert.equal(await reasoning.isModelHealthy(), true);
  assert.equal(reasoning._liveFailures, ReasoningEngine.UNHEALTHY_AFTER_LIVE_FAILURES - 1);
});

test("a failed acknowledgement cannot poison the core model health circuit", async () => {
  const reasoning = new ReasoningEngine({
    modelProvider: { async generateStructured() { throw new Error("HTTP 503"); } }
  });
  const result = await reasoning.acknowledgeAction("open calculator");
  assert.equal(result.ok, false);
  assert.equal(reasoning._liveFailures, 0);
});

test("ordinary browser playback is ephemeral read-like state, not a high-risk persistent write", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const capability = registry.get("browser.media.play");
  assert.equal(capability.permissionModel.type, "READ");
  assert.equal(capability.riskMetadata.level, "LOW");
});

test("browser media perception includes current YouTube ad surfaces", async () => {
  const browser = new CdpBrowserAdapter();
  let expression = "";
  browser._evaluate = async (value) => { expression = value; return { found: false }; };
  await browser.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
  assert.match(expression, /ytp-ad-player-overlay/);
  assert.match(expression, /blockedByPage/);
});
