// Autonomous-execution enhancements — behavioral tests for:
//   1. LLM-first intent routing (real remote model chooses the operation; the
//      deterministic regex extractors are the offline fallback only).
//   2. Model-generated natural acknowledgement (never a hardcoded template).
//   3. Narrowed approval scope — approval is required ONLY for delete /
//      edit-existing-file / non-WinGet(browser) install; everything else is
//      autonomous.
//
// Offline + deterministic: a scripted in-memory model provider stands in for a
// real remote model (it declares capabilities().remote = true), so no network
// and no API credits. Windows-only mutation checks use a temp dir.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { PolicyEngine } from "../../packages/policy-engine/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

// A scripted provider that LOOKS like a real remote model (remote:true) so the
// IntentEngine treats it as authoritative for LLM-first routing. Each call to
// generateStructured returns the next queued response.
class ScriptedRemoteProvider {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
    this.name = "scripted-remote";
  }
  capabilities() { return { name: this.name, structured: true, text: true, remote: true }; }
  async healthCheck() { return { ok: true }; }
  async health() { return { ok: true }; }
  usage() { return { calls: this.calls.length, tokensIn: 0, tokensOut: 0, costUsd: 0 }; }
  async generateStructured(prompt, schema) {
    this.calls.push(prompt);
    return this.responses.shift() ?? {};
  }
}

// ---- 1. LLM-first routing ----------------------------------------------------

test("LLM-first: a healthy remote model chooses the operation (no keyword match needed)", async () => {
  // The model returns an operation that the regex extractors would NOT produce
  // for this phrasing, proving the LLM — not a keyword matcher — decided.
  const provider = new ScriptedRemoteProvider([{
    normalizedGoal: "Play Blinding Lights in Spotify",
    category: "APPLICATION",
    operation: "spotify.track.play",
    entities: { query: "Blinding Lights" },
    successCriteria: ["Spotify is playing Blinding Lights"],
    requiredContext: [], requiredCapabilities: ["spotify.track.play"],
    confidence: 0.95
  }]);
  const reasoning = new ReasoningEngine({ modelProvider: provider });
  const intent = await new IntentEngine(reasoning).classify("could you put on that weeknd tune for me");
  assert.equal(intent.operation, "spotify.track.play", "the model's chosen operation is used");
  assert.equal(intent.entities.query, "Blinding Lights");
  assert.ok(provider.calls.length >= 1, "the model WAS consulted first");
});

test("LLM-first: an unknown model operation is ignored (falls to structured merge)", async () => {
  const provider = new ScriptedRemoteProvider([{
    normalizedGoal: "Do a made-up thing",
    category: "SYSTEM",
    operation: "not.a.real.operation",
    entities: {},
    successCriteria: ["done"], requiredContext: [], requiredCapabilities: [],
    confidence: 0.9
  }]);
  const reasoning = new ReasoningEngine({ modelProvider: provider });
  const intent = await new IntentEngine(reasoning).classify("please do the thing");
  assert.notEqual(intent.operation, "not.a.real.operation", "a hallucinated operation is never trusted");
});

test("offline fallback: with no model, the deterministic Spotify extractor still routes", async () => {
  const intent = await new IntentEngine(null).classify('open spotify and play "Cry For Me"');
  assert.equal(intent.operation, "spotify.track.play", "regex extractor is the offline fallback");
  assert.equal(intent.entities.query, "Cry For Me");
});

// ---- 2. Natural, model-generated acknowledgement -----------------------------

test("acknowledgeAction: returns model text, not a hardcoded template", async () => {
  const provider = new ScriptedRemoteProvider([{ reply: "Sure — putting that track on now." }]);
  const reasoning = new ReasoningEngine({ modelProvider: provider });
  const ack = await reasoning.acknowledgeAction('play "Cry For Me" on Spotify');
  assert.equal(ack.ok, true);
  assert.equal(ack.source, "model");
  assert.equal(ack.text, "Sure — putting that track on now.");
});

test("acknowledgeAction: never fabricates a canned acknowledgement when no model is present", async () => {
  const reasoning = new ReasoningEngine({ modelProvider: null });
  const ack = await reasoning.acknowledgeAction("open notepad");
  assert.equal(ack.ok, false);
  assert.equal(ack.source, "unavailable");
  assert.equal(ack.text, null);
});

// ---- 3. Narrowed approval scope (via _classifyPlanApproval) ------------------

function runtimeWithAdapter(adapter) {
  const registry = createDefaultCapabilityRegistry(adapter);
  return new AgentRuntime({
    capabilityRegistry: registry,
    riskEngine: new RiskEngine({ capabilityRegistry: registry }),
    policyEngine: new PolicyEngine(),
    adapter,
    // Minimal stores omitted — _classifyPlanApproval only reads the plan + adapter.
    sessionStore: { save: async () => {}, get: async () => null, list: async () => [] },
    auditRepository: { append: async () => {} }
  });
}

const planOf = (capability, inputs) => ({ taskGraph: { tasks: [{ capability, inputs }] } });

test("approval: deleting a file requires approval", async () => {
  const runtime = runtimeWithAdapter(new WindowsAdapter());
  const result = await runtime._classifyPlanApproval(planOf("filesystem.delete", { filePath: "C:/whatever.txt" }));
  assert.equal(result.requiresApproval, true);
});

test("approval: writing a NEW file is autonomous", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-approval-"));
  try {
    const runtime = runtimeWithAdapter(new WindowsAdapter());
    const target = path.join(base, "brand-new.txt"); // does not exist
    const result = await runtime._classifyPlanApproval(planOf("filesystem.write", { filePath: target, content: "hi" }));
    assert.equal(result.requiresApproval, false, "creating a new file proceeds autonomously");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("approval: editing an EXISTING file requires approval", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-approval-"));
  try {
    const target = path.join(base, "exists.txt");
    await fs.writeFile(target, "original");
    const runtime = runtimeWithAdapter(new WindowsAdapter());
    const result = await runtime._classifyPlanApproval(planOf("filesystem.write", { filePath: target, content: "changed" }));
    assert.equal(result.requiresApproval, true, "overwriting an existing file is an edit → approval");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("approval: a WinGet install requires explicit approval", async () => {
  const runtime = runtimeWithAdapter(new WindowsAdapter());
  const result = await runtime._classifyPlanApproval(planOf("package.winget.install", { id: "VideoLAN.VLC" }));
  assert.equal(result.requiresApproval, true, "software installation must not proceed autonomously");
});

test("approval: a read-only inspection is autonomous", async () => {
  const runtime = runtimeWithAdapter(new WindowsAdapter());
  const result = await runtime._classifyPlanApproval(planOf("system.inspect", {}));
  assert.equal(result.requiresApproval, false);
});
