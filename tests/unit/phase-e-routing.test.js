import test from "node:test";
import assert from "node:assert/strict";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { TaskGraphScheduler } from "../../packages/task-graph-scheduler/src/index.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

// A reasoning double that stands in for a REAL remote model. It deliberately
// has no own `modelProvider` property, so IntentEngine treats its answer as
// authoritative LLM-first routing — the exact condition under which the live
// campaign misrouted a website goal into application.launch.
function modelChoosing(operation, entities = {}) {
  return {
    understandIntent: async (text) => ({
      ok: true,
      data: {
        operation,
        entities,
        normalizedGoal: text,
        category: "APPLICATION",
        successCriteria: ["Operation completed and verified"],
        confidence: 0.9
      }
    })
  };
}

test("a model that routes a web destination into application.launch is corrected to a browser capability", async () => {
  // Two different sites and several paraphrases: the correction must come from
  // outcome classification, not from one memorized sentence.
  const cases = [
    { text: "Play a YouTube video", application: "youtube" },
    { text: "play some lofi beats on youtube", application: "YouTube" },
    { text: "watch the latest SpaceX launch on YouTube", application: "youtube" },
    { text: "open youtube", application: "youtube" }
  ];
  for (const { text, application } of cases) {
    const intent = await new IntentEngine(modelChoosing("application.launch", { application }))
      .classify(text);
    assert.match(
      String(intent.operation),
      /^browser\./,
      `${text}: a website outcome must not be planned as a desktop application launch (got ${intent.operation})`
    );
    assert.equal(intent.category, "BROWSER", text);
    assert.equal(intent.routingOverride?.from, "application.launch", text);
  }
});

test("a research goal on a different domain is also rerouted away from application.launch", async () => {
  const intent = await new IntentEngine(modelChoosing("application.launch", { application: "google flights" }))
    .classify("Find the cheapest flight to Tokyo next month. Do not book anything.");
  assert.equal(intent.operation, "browser.research");
  assert.ok(intent.constraints.includes("NO_BOOKING"));
  assert.equal(intent.routingOverride?.from, "application.launch");
});

test("a genuine installed-application goal keeps the model's application.launch route", async () => {
  for (const text of ["Open Calculator", "launch notepad please", "start Spotify"]) {
    const intent = await new IntentEngine(modelChoosing("application.launch", { application: "calculator" }))
      .classify(text);
    assert.equal(intent.operation, "application.launch", text);
    assert.equal(intent.routingOverride, undefined, text);
  }
});

test("application launch resolves a real target and never blind-launches an unresolved literal", async () => {
  const scripts = [];
  const adapter = new WindowsAdapter();
  adapter.runPowerShell = async (script) => {
    scripts.push(script);
    // Resolution stage reports that nothing matched this name.
    return { stdout: JSON.stringify({ resolved: false, candidates: [] }), stderr: "", exitCode: 0 };
  };
  adapter.listWindows = async () => [];

  const result = await adapter.launchApplication("youtube");
  assert.equal(result.launch?.started, false);
  assert.equal(result.failureCategory, "APPLICATION_NOT_INSTALLED");
  assert.equal(result.resolution?.resolved, false);
  assert.ok(
    scripts.every((script) => !/Start-Process/.test(script)),
    "an unresolved application name must never reach Start-Process"
  );
});

test("port inspection reports an indeterminate probe instead of a false 'not listening'", async () => {
  const adapter = new WindowsAdapter();
  // A genuinely broken probe: no usable stdout and a nonzero host exit code.
  adapter.runPowerShell = async () => ({ stdout: "", stderr: "powershell failed", exitCode: 1 });
  const broken = await adapter.inspectPort(3000);
  assert.equal(broken.status, "INDETERMINATE");
  assert.equal(broken.listening, null);

  // A working probe that finds nothing is a real, verifiable answer even when
  // the host process reports a nonzero exit code.
  adapter.runPowerShell = async () => ({
    stdout: JSON.stringify({ ok: true, connections: [] }),
    stderr: "",
    exitCode: 1
  });
  const empty = await adapter.inspectPort(3000);
  assert.equal(empty.status, "NOT_LISTENING");
  assert.equal(empty.listening, false);
  assert.equal(empty.probe.ok, true);
});

// The scheduler treats a nonzero exit code as authoritative failure. A
// non-mutating capability may declare that its command output is a PROBE it
// interprets itself; that declaration must survive a nonzero exit code without
// ever letting a mutating capability claim the same exemption.
function probeCapability({ name, mutates, contract, verifyStatus = "VERIFIED" }) {
  return {
    name,
    version: "1.0.0",
    description: `probe capability ${name}`,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    requiredContext: [],
    riskMetadata: { level: "LOW" },
    reversibility: "NOT_REQUIRED",
    ...(contract ? { observationContract: { commandResult: contract } } : {}),
    ...(mutates
      ? {
          stateMutations: ["filesystem"],
          permissionModel: { scope: ["WORKSPACE"], type: "WRITE" },
          riskMetadata: { level: "MEDIUM" }
        }
      : {}),
    preconditions: () => true,
    execute: async () => ({ answer: "observed", commandResult: { exitCode: 1, stdout: "ok" } }),
    observe: async (result) => ({
      observationId: "obs", source: name, timestamp: new Date().toISOString(),
      structuredState: result, detectedChanges: [], confidence: 1, trustLevel: "SYSTEM_TRUSTED"
    }),
    verify: async (observation) => ({
      status: verifyStatus,
      message: "domain state read",
      evidence: { answer: observation.structuredState.answer },
      confidence: 1
    }),
    rollback: null,
    timeout: 5000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    lifecycleStatus: "VERIFIED"
  };
}

async function runOne(capability) {
  const registry = new CapabilityRegistry();
  registry.register(capability);
  const scheduler = new TaskGraphScheduler({ capabilityRegistry: registry });
  const task = { taskId: "t1", capability: capability.name, inputs: {}, dependencies: [], timeout: 5000 };
  scheduler.initialize({ tasks: [task] });
  const { verification } = await scheduler.executeTask(task);
  return verification;
}

test("a declared read-only probe keeps its own verified answer despite a nonzero exit code", async () => {
  const verification = await runOne(probeCapability({ name: "probe.read", mutates: false, contract: "PROBE" }));
  assert.equal(verification.status, "VERIFIED");
  assert.equal(verification.evidence.exitCode ?? verification.commandExitCode, 1);
});

test("an undeclared capability still fails on a nonzero exit code", async () => {
  const verification = await runOne(probeCapability({ name: "probe.undeclared", mutates: false }));
  assert.equal(verification.status, "FAILED");
});

test("a mutating capability cannot claim the probe exemption", async () => {
  const verification = await runOne(probeCapability({ name: "probe.write", mutates: true, contract: "PROBE" }));
  assert.equal(verification.status, "FAILED");
});

test("a probe whose own verification is not VERIFIED still fails on a nonzero exit code", async () => {
  const verification = await runOne(
    probeCapability({ name: "probe.partial", mutates: false, contract: "PROBE", verifyStatus: "PARTIALLY_VERIFIED" })
  );
  assert.equal(verification.status, "FAILED");
});

test("an application registered only by its executable file name still resolves", async () => {
  // App Paths and Get-Command register browsers as "msedge.exe" while users and
  // models say "msedge". Reporting a present application as absent would send
  // the prerequisite workflow off to install something already installed.
  const probed = [];
  const adapter = new WindowsAdapter();
  adapter.runPowerShell = async (script) => {
    probed.push(script);
    const suffixed = /App Paths\' \+ 'msedge\.exe'/.test(script) || /msedge\.exe/.test(script);
    return {
      stdout: JSON.stringify({ ok: true, resolved: suffixed, kind: suffixed ? "app-path" : null, target: suffixed ? "C:\Edge\msedge.exe" : null }),
      stderr: "",
      exitCode: 0
    };
  };
  const resolution = await adapter.resolveApplicationTarget("msedge", "msedge");
  assert.equal(resolution.resolved, true);
  assert.ok(probed.some((script) => /msedge\.exe/.test(script)), "the .exe spelling must be probed");
});
