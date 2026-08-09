import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const original = rt._runInteractiveController.bind(rt);
rt._runInteractiveController = async (...args) => {
  const stack = new Error("entry").stack.split("\n").slice(1, 5).join("\n");
  console.log("=== _runInteractiveController called from:\n" + stack);
  return original(...args);
};
const originalPlan = rt.generalPlanner.generatePlan.bind(rt.generalPlanner);
rt.generalPlanner.generatePlan = async (...args) => {
  const plan = await originalPlan(...args);
  console.log("=== generatePlan ->", plan?.plannerSource, JSON.stringify(plan?.taskGraph?.tasks?.map(t=>t.capability)));
  return plan;
};
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo, interactiveBudgets: { maxSteps: 2, maxModelCalls: 1 } });
console.log("STATUS:", s.finalResponse?.status);
process.exit(0);
