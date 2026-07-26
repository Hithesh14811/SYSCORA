import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { GeneralPlanner } from "../../packages/planner/src/index.js";
import {
  CapabilityResolutionKind,
  resolveCapabilityId
} from "../../packages/shared-types/src/capability-resolution.js";
import {
  appendEvidence,
  createEvidenceLedger,
  evaluateEvidenceLedger
} from "../../packages/shared-types/src/evidence-ledger.js";
import {
  evaluatePostcondition,
  PostconditionKind
} from "../../packages/shared-types/src/postconditions.js";
import { createGoalContract } from "../../packages/shared-types/src/goal-contract.js";
import { InteractiveAgentController } from "../../packages/agent-runtime/src/interactive-agent-controller.js";

test("capability resolution accepts only exact or structurally canonical registry identities", () => {
  const catalog = [
    { name: "filesystem.write", aliases: ["file-write"] },
    { name: "ui.action" },
    { name: "ui_action" }
  ];
  assert.equal(resolveCapabilityId("filesystem.write", catalog).kind, CapabilityResolutionKind.EXACT_MATCH);
  assert.deepEqual(
    resolveCapabilityId("FileSystem Write", catalog),
    {
      kind: CapabilityResolutionKind.CANONICAL_ALIAS,
      requestedId: "FileSystem Write",
      canonicalId: "filesystem.write",
      candidates: ["filesystem.write"]
    }
  );
  assert.equal(resolveCapabilityId("file-write", catalog).canonicalId, "filesystem.write");
  assert.equal(resolveCapabilityId("filesystem.writes", catalog).kind, CapabilityResolutionKind.UNKNOWN_CAPABILITY);
  assert.equal(resolveCapabilityId("uiaction", catalog).kind, CapabilityResolutionKind.AMBIGUOUS_CAPABILITY);
});

test("internal requirement composition retains repeated writes and verifies every final artifact across variants", () => {
  const planner = new GeneralPlanner(null, null);
  const variants = [
    "Create red.txt with content RED, create blue.txt with content BLUE, then change red.txt to CRIMSON. Verify both.",
    "Write one.json with exact content ONE; write two.json with exact content TWO; rewrite two.json to SECOND. Verify both.",
    "Create file first.md to contain Alpha. Create file second.md to contain Beta. Update first.md so its final content is Omega. Verify both."
  ];
  for (const rawText of variants) {
    const plan = planner.fallbackPlan({
      rawText,
      normalizedGoal: rawText,
      entities: { workspacePath: "C:\\tmp\\m441-variants" },
      successCriteria: ["Every requested artifact has its exact final content"]
    }, {});
    const writes = plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.write");
    const reads = plan.taskGraph.tasks.filter((task) => task.capability === "filesystem.read");
    assert.equal(writes.length, 3, rawText);
    assert.equal(reads.length, 2, rawText);
    assert.equal(new Set(reads.map((task) => path.basename(task.inputs.filePath).toLowerCase())).size, 2);
  }
});

test("typed postconditions evaluate structured state without a model declaration", () => {
  assert.equal(evaluatePostcondition({
    kind: PostconditionKind.FILE_CONTENT_EQUALS,
    expected: "Saffron-819"
  }, { contents: "Saffron-819" }).satisfied, true);
  assert.equal(evaluatePostcondition({
    kind: PostconditionKind.CONTROL_VISIBLE,
    expected: "Advanced Options"
  }, { relevantControls: [{ name: "Advanced Options" }] }).satisfied, true);
  assert.equal(evaluatePostcondition({
    kind: PostconditionKind.VALUE_TRANSFER_EQUALS,
    expected: "Saffron-819"
  }, { value: "different" }).satisfied, false);
});

test("evidence ledger maps compound criteria and verifies typed binding lineage", () => {
  const contract = {
    criteria: [
      { criterionId: "c1", description: "value extracted" },
      { criterionId: "c2", description: "value persisted" },
      { criterionId: "c3", description: "same value displayed" }
    ]
  };
  const ledger = createEvidenceLedger();
  const producer = appendEvidence(ledger, {
    criterionIds: ["c1"],
    capability: "browser.extract",
    verification: { status: "VERIFIED" },
    value: "Saffron-819",
    producedBindings: ["B1"]
  });
  appendEvidence(ledger, {
    criterionIds: ["c2"],
    capability: "filesystem.read",
    verification: { status: "VERIFIED", evidence: { contents: "Saffron-819" } },
    consumedBindings: ["B1"],
    value: "Saffron-819"
  });
  appendEvidence(ledger, {
    criterionIds: ["c3"],
    capability: "ui.verifyValue",
    verification: { status: "VERIFIED", evidence: { value: "Saffron-819" } },
    consumedBindings: ["B1"],
    value: "Saffron-819"
  });
  const result = evaluateEvidenceLedger(contract, ledger, {
    transferred: {
      bindingId: "B1",
      value: "Saffron-819",
      producerEvidenceId: producer.evidenceId
    }
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.lineage[0].verified, true);
  assert.equal(result.lineage[0].consumerEvidenceIds.length, 2);
});

test("verified local postcondition completes before an unavailable follow-up model call", async () => {
  let modelCalls = 0;
  const target = {
    targetId: "uia:harmless-mode",
    name: "Harmless Mode",
    controlType: "Button",
    supportedPatterns: ["InvokePattern"]
  };
  const capability = {
    name: "ui.action",
    description: "Act on a grounded UI control",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    execution: { modality: "UI_AUTOMATION" }
  };
  const registry = {
    get: (name) => name === capability.name ? capability : null,
    getCatalog: () => [capability]
  };
  const controller = new InteractiveAgentController({
    reasoningEngine: {
      async decideInteractiveAction() {
        modelCalls += 1;
        if (modelCalls > 1) return { ok: false, error: "provider-unavailable-after-postcondition" };
        return {
          ok: true,
          data: {
            kind: "ACT",
            action: {
              capability: "ui.action",
              inputs: { target, action: "invoke" },
              subgoal: "Select the Harmless Mode control"
            }
          }
        };
      }
    },
    capabilityRegistry: registry,
    perceive: async () => ({ relevantControls: [target] }),
    executeAction: async () => ({
      executionResult: { performed: true, target },
      observation: { relevantControls: [{ ...target, selected: true }] },
      verification: {
        status: "VERIFIED",
        message: "Harmless Mode is selected.",
        evidence: { selected: true, target }
      }
    })
  });
  const goal = 'Select the "Harmless Mode" control.';
  const result = await controller.run(goal, {
    goalContract: createGoalContract({ rawText: goal, successCriteria: [goal] }),
    successCriteria: [goal]
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(modelCalls, 0);
  assert.equal(result.metrics.totalModelCalls, 0);
});
