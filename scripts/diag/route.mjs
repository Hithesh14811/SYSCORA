import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { OPERATION_PLANS } from "../../packages/planner/src/index.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const session = await rt.submitIntent(process.argv.slice(2).join(" "), {
  autoApprove: true, workspacePath: repo, interactiveBudgets: { maxSteps: 2, maxModelCalls: 1 }
});
const i = session.intent ?? {};
console.log(JSON.stringify({
  status: session.finalResponse?.status,
  category: i.category,
  operation: i.operation ?? null,
  hasDirectOperationPlan: Boolean(i.operation && OPERATION_PLANS[i.operation]),
  provenance: i.operationProvenance,
  plannerSource: session.plan?.plannerSource ?? null,
  enteredLoop: (session.events ?? []).some(e => e.eventType === "ADAPTIVE_CONTROLLER_STARTED"),
  planGenerated: (session.events ?? []).some(e => e.eventType === "PLAN_GENERATED")
}));
process.exit(0);
