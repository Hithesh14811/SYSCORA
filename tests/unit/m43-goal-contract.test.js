import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createGoalContract,
  assessGoalContractPlanCoverage,
  assessGoalContractEvidence
} from "../../packages/shared-types/src/goal-contract.js";
import { GeneralPlanner } from "../../packages/planner/src/index.js";

function task(capability, inputs, completionCriteria = []) {
  return {
    taskId: crypto.randomUUID(),
    capability,
    inputs,
    completionCriteria,
    verificationCriteria: [`${capability} verified`]
  };
}

import crypto from "node:crypto";

const intent = {
  rawText: "Create contract-proof with alpha.txt as ALPHA-UPDATED and beta.txt as BETA, then verify both.",
  successCriteria: [
    "Directory contract-proof exists",
    "File alpha.txt exists with final content ALPHA-UPDATED",
    "File beta.txt exists with final content BETA",
    "Both exact file contents are verified"
  ]
};

test("GoalContract rejects a planner that drops one requested file", () => {
  const contract = createGoalContract(intent);
  const graph = {
    tasks: [
      task("filesystem.createDirectory", { directoryPath: "C:/tmp/contract-proof" }),
      task("filesystem.write", { filePath: "C:/tmp/contract-proof/alpha.txt", content: "ALPHA-UPDATED" })
    ]
  };
  const coverage = assessGoalContractPlanCoverage(contract, graph);
  assert.equal(coverage.covered, false);
  assert.ok(coverage.missingCriteria.some((criterion) => criterion.includes("beta.txt")));
});

test("GoalContract rejects a planner that changes an exact requested value", () => {
  const contract = createGoalContract(intent);
  const graph = {
    tasks: [
      task("filesystem.createDirectory", { directoryPath: "C:/tmp/contract-proof" }),
      task("filesystem.write", { filePath: "C:/tmp/contract-proof/alpha.txt", content: "ALPHA" }),
      task("filesystem.write", { filePath: "C:/tmp/contract-proof/beta.txt", content: "BETA" })
    ]
  };
  const coverage = assessGoalContractPlanCoverage(contract, graph);
  assert.equal(coverage.covered, false);
  assert.ok(coverage.missingCriteria.some((criterion) => criterion.includes("ALPHA-UPDATED")));
});

test("GoalContract rejects a mutating plan for a do-not-modify criterion", () => {
  const contract = createGoalContract({
    rawText: "Open an unknown app, inspect it, and do not change anything.",
    successCriteria: ["The app is open", "Major controls are reported"],
    constraints: ["Do not change anything"]
  });
  const graph = {
    tasks: [
      task("application.launch", { application: "Unknown App" }),
      task("ui.action", { target: { targetId: "invented" }, action: "click" })
    ]
  };
  assert.equal(assessGoalContractPlanCoverage(contract, graph).covered, false);
});

test("GoalContract rejects first-only and irrelevant successful plans", () => {
  const contract = createGoalContract(intent);
  const firstOnly = {
    tasks: [task("filesystem.createDirectory", { directoryPath: "C:/tmp/contract-proof" })]
  };
  const irrelevant = {
    tasks: [
      task("filesystem.createDirectory", { directoryPath: "C:/tmp/demo" }),
      task("filesystem.write", { filePath: "C:/tmp/demo/config.json", content: "{}" })
    ]
  };
  assert.equal(assessGoalContractPlanCoverage(contract, firstOnly).covered, false);
  assert.equal(assessGoalContractPlanCoverage(contract, irrelevant).covered, false);
});

test("independent contract evidence cannot promote partial cross-modal completion", () => {
  const contract = createGoalContract({
    rawText: "Read VALUE from a browser, save it to result.txt, and enter it into App Y.",
    successCriteria: [
      "VALUE is read from the browser",
      "result.txt contains VALUE",
      "App Y contains VALUE"
    ]
  });
  const evidence = assessGoalContractEvidence(contract, {
    taskGraph: {
      tasks: [task("browser.extract", { query: "VALUE" })]
    },
    taskResults: [{
      capability: "browser.extract",
      executionResult: { text: "VALUE" }
    }],
    verifications: [{ status: "VERIFIED", message: "Browser value extracted", evidence: { text: "VALUE" } }],
    observations: []
  });
  assert.equal(evidence.satisfied, false);
  assert.ok(evidence.satisfiedCount < evidence.totalCriteria);
});

test("GoalContract does not promote model-invented procedural preferences into user criteria", () => {
  const contract = createGoalContract({
    rawText: 'Read "source.txt" and enter it into "Destination".',
    successCriteria: ["File contents are read", "Text is entered"],
    constraints: ["Prefer an internal API before GUI automation where possible"]
  });

  assert.equal(
    contract.criteria.some((criterion) => criterion.description.includes("internal API")),
    false
  );
});

test("generic filesystem composition preserves ordered writes and final read-back for every file", () => {
  const planner = new GeneralPlanner(null, null);
  const workspacePath = "C:\\tmp\\m43-contract";
  const rawText = `Inside ${workspacePath}, create a directory named contract-proof. ` +
    "Create alpha.txt with exact content ALPHA, create beta.txt with exact content BETA, " +
    "then modify alpha.txt so its exact final content is ALPHA-UPDATED. Verify both.";
  const plan = planner.fallbackPlan({
    rawText,
    normalizedGoal: rawText,
    entities: { workspacePath },
    successCriteria: ["Both requested files have their exact final contents"]
  }, {});
  const writes = plan.taskGraph.tasks.filter((item) => item.capability === "filesystem.write");
  const reads = plan.taskGraph.tasks.filter((item) => item.capability === "filesystem.read");

  assert.deepEqual(writes.map((item) => item.inputs.content), ["ALPHA", "BETA", "ALPHA-UPDATED"]);
  assert.deepEqual(reads.map((item) => path.basename(item.inputs.filePath)).sort(), ["alpha.txt", "beta.txt"]);
  assert.equal(reads.find((item) => item.inputs.filePath.endsWith("alpha.txt")).completionCriteria[0].includes("ALPHA-UPDATED"), true);
});
