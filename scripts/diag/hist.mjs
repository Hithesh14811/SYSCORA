import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { OPERATION_PLANS } from "../../packages/planner/src/index.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const history = [
  { role: "user", text: "what's the volume set to right now?" },
  { role: "assistant", text: "Your volume is set to 26% and it's not muted." }
];
const s = await rt.submitIntent("bump it up to 55", { autoApprove: true, workspacePath: repo, history });
const i = s.intent ?? {};
console.log(JSON.stringify({
  status: s.finalResponse?.status,
  operation: i.operation ?? null,
  hasPlan: Boolean(i.operation && OPERATION_PLANS[i.operation]),
  entities: i.entities,
  plannerSource: s.plan?.plannerSource ?? null,
  caps: (s.events ?? []).filter(e => e.eventType === "TASK_STARTING").map(e => e.details?.capability)
}, null, 1));
console.log("MSG:", (s.finalResponse?.message ?? "").slice(0, 250));
process.exit(0);
