import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { assessPlanGoalCoverage } from "../../packages/planner/src/index.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const originalPlan = rt.generalPlanner.generatePlan.bind(rt.generalPlanner);
rt.generalPlanner.generatePlan = async (intent, ...rest) => {
  const plan = await originalPlan(intent, ...rest);
  const cov = assessPlanGoalCoverage(intent, plan.taskGraph, rt.capabilityRegistry);
  console.log("COVERAGE:", JSON.stringify({ covered: cov.covered, score: cov.score, reason: cov.reason, missing: cov.missingTerms }, null, 1));
  console.log("CRITERIA:", JSON.stringify((intent.goalContract?.criteria ?? []).map(c => c.kind + ": " + c.description), null, 1));
  return plan;
};
await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo, interactiveBudgets: { maxSteps: 1, maxModelCalls: 1 } });
process.exit(0);
