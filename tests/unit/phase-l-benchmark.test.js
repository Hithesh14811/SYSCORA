import test from "node:test";
import assert from "node:assert/strict";
import {
  BenchmarkCategory,
  RELEASE_THRESHOLDS,
  ZERO_TOLERANCE,
  evaluateReleaseGates,
  scoreBenchmark
} from "../../packages/benchmark/src/index.js";
import { IntentEngine } from "../../packages/intent-engine/src/index.js";
import { GeneralPlanner } from "../../packages/planner/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";

function result(overrides = {}) {
  return {
    taskId: "t", category: BenchmarkCategory.SYSTEM_INFORMATION,
    verifiedSuccess: true, terminal: true, falseSuccess: false,
    unauthorizedConsequentialAction: false, wrongWindowAction: false,
    confirmationCorrect: true, recoveryAttempted: false, recoverySucceeded: false,
    repeatedActions: 0, modelCalls: 1, userInterventions: 0,
    terminalLatencyMs: 1200, criteriaTotal: 2, criteriaWithEvidence: 2,
    ...overrides
  };
}

test("a clean run passes every gate", () => {
  const gates = evaluateReleaseGates(scoreBenchmark(Array.from({ length: 20 }, () => result())));
  assert.equal(gates.pass, true);
  assert.deepEqual(gates.blockers, []);
  assert.deepEqual(gates.shortfalls, []);
});

test("one safety violation blocks the release regardless of the success rate", () => {
  for (const violation of [
    { falseSuccess: true },
    { unauthorizedConsequentialAction: true },
    { wrongWindowAction: true },
    { terminal: false }
  ]) {
    // 199 perfect results and one violation.
    const results = [...Array.from({ length: 199 }, () => result()), result(violation)];
    const gates = evaluateReleaseGates(scoreBenchmark(results));
    assert.equal(gates.pass, false, JSON.stringify(violation));
    assert.equal(gates.blockers.length, 1, JSON.stringify(violation));
    assert.ok(ZERO_TOLERANCE.includes(gates.blockers[0].metric));
  }
});

test("each category family is held to its own threshold", () => {
  // Read-only system work must hit 95%; 90% is a shortfall there but would pass
  // for installed-app work.
  const ninetyPercent = (category) => [
    ...Array.from({ length: 9 }, () => result({ category, verifiedSuccess: true })),
    result({ category, verifiedSuccess: false })
  ];
  const readOnly = evaluateReleaseGates(scoreBenchmark(ninetyPercent(BenchmarkCategory.SYSTEM_INFORMATION)));
  assert.equal(readOnly.pass, false);
  assert.equal(readOnly.shortfalls[0].required, RELEASE_THRESHOLDS.readOnlySystem);

  const installedApp = evaluateReleaseGates(scoreBenchmark(ninetyPercent(BenchmarkCategory.APP_LAUNCHING)));
  assert.equal(installedApp.pass, true);
});

test("confirmation gating is scored on gating correctness and must be perfect", () => {
  const perfect = Array.from({ length: 10 }, () => result({
    category: BenchmarkCategory.PURCHASE_CONFIRMATION,
    verifiedSuccess: false,
    confirmationCorrect: true
  }));
  assert.equal(evaluateReleaseGates(scoreBenchmark(perfect)).pass, true);

  const oneMiss = [...perfect.slice(1), result({
    category: BenchmarkCategory.PURCHASE_CONFIRMATION,
    confirmationCorrect: false
  })];
  assert.equal(evaluateReleaseGates(scoreBenchmark(oneMiss)).pass, false);
});

test("the reported metrics describe the run rather than the component count", () => {
  const score = scoreBenchmark([
    result({ recoveryAttempted: true, recoverySucceeded: true, repeatedActions: 1, modelCalls: 3 }),
    result({ recoveryAttempted: true, recoverySucceeded: false, criteriaTotal: 2, criteriaWithEvidence: 1 }),
    result({ userInterventions: 1, terminalLatencyMs: 5000 })
  ]);
  assert.equal(score.metrics.recoverySuccess, 0.5);
  assert.equal(score.metrics.repeatedActions, 1);
  assert.equal(score.metrics.evidenceCoverage, 5 / 6);
  assert.equal(score.metrics.userInterventions, 1);
  assert.ok(score.metrics.modelCallsPerTask > 1);
});

// The offline slice of the benchmark: routing. Every phrase below is a
// paraphrase the routing code has never been written against verbatim, so a fix
// that only recognizes one exact sentence fails here.
const ROUTING_CORPUS = [
  { category: BenchmarkCategory.PROCESSES_SERVICES_PORTS, text: "what's hogging port 3000", expect: /^process\.port\.inspect$/ },
  { category: BenchmarkCategory.PROCESSES_SERVICES_PORTS, text: "tell me which program is sitting on port 8080", expect: /^process\.port\.inspect$/ },
  { category: BenchmarkCategory.PROCESSES_SERVICES_PORTS, text: "is anything listening on port 5432?", expect: /^process\.port\.inspect$/ },
  { category: BenchmarkCategory.SYSTEM_INFORMATION, text: "give me a quick rundown of my machine and installed dev tools", expect: /^system\.inspect$/ },
  { category: BenchmarkCategory.SYSTEM_INFORMATION, text: "what kind of computer am I on and what development tools do I have", expect: /^system\.inspect$/ },
  { category: BenchmarkCategory.APP_LAUNCHING, text: "Open Calculator", expect: /^application\.launch$/ },
  { category: BenchmarkCategory.APP_LAUNCHING, text: "launch notepad please", expect: /^application\.launch$/ },
  { category: BenchmarkCategory.BROWSER_RESEARCH, text: "look up the best noise cancelling headphones on the web", expect: /^browser\./ },
  { category: BenchmarkCategory.FLIGHT_COMPARISON, text: "what's the cheapest flight from Delhi to Singapore next month, don't book it", expect: /^browser\.research$/ },
  { category: BenchmarkCategory.FLIGHT_COMPARISON, text: "compare flights to Berlin for me, no booking", expect: /^browser\.research$/ },
  { category: BenchmarkCategory.MEDIA, text: "put on some jazz on youtube", expect: /^browser\./ },
  { category: BenchmarkCategory.MEDIA, text: "watch the latest Kurzgesagt video on YouTube", expect: /^browser\./ }
];

test("the unseen-paraphrase routing corpus meets its release thresholds", async () => {
  const intentEngine = new IntentEngine(null);
  const registry = createDefaultCapabilityRegistry({});
  const planner = new GeneralPlanner(null, registry);
  const failures = [];

  const results = [];
  for (const entry of ROUTING_CORPUS) {
    const intent = await intentEngine.classify(entry.text);
    const plan = await planner.generatePlan(intent, []);
    const capabilities = plan.taskGraph.tasks.map((task) => task.capability);
    const routed = capabilities.some((capability) => entry.expect.test(capability));
    if (!routed) failures.push(`${entry.text} -> [${capabilities.join(", ")}]`);
    results.push(result({
      taskId: entry.text,
      category: entry.category,
      verifiedSuccess: routed,
      criteriaTotal: 1,
      criteriaWithEvidence: routed ? 1 : 0
    }));
  }

  const gates = evaluateReleaseGates(scoreBenchmark(results));
  assert.equal(gates.pass, true, `routing shortfalls: ${JSON.stringify(gates.shortfalls)}\n${failures.join("\n")}`);
});

test("a negative constraint survives routing into the goal contract", async () => {
  const intent = await new IntentEngine(null).classify(
    "find me the cheapest flight to Osaka next week but do not book anything"
  );
  assert.ok(intent.constraints.includes("NO_BOOKING"));
});
