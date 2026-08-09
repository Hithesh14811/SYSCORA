import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const text = process.argv.slice(2).join(" ");
const session = await rt.submitIntent(text, { autoApprove: true, workspacePath: repo });
console.log("STATUS:", session.finalResponse?.status, "| route:", session.plan?.plannerSource ?? "loop");
console.log("OPERATION:", session.intent?.operation ?? "(none)");
console.log("CAPS:", JSON.stringify(session.intent?.requiredCapabilities));
for (const ev of session.events ?? []) {
  if (["ADAPTIVE_DECIDED","TASK_STARTING","TASK_EXECUTED","VERIFICATION_FAILED","ERROR_OCCURRED","PLAN_GENERATED","ADAPTIVE_ACTION_STARTING"].includes(ev.eventType)) {
    const d = ev.details ?? {};
    const brief = d.decision ? JSON.stringify(d.decision).slice(0,320)
      : d.taskGraph ? JSON.stringify(d.taskGraph.tasks?.map(t=>({c:t.capability,i:t.inputs}))).slice(0,320)
      : JSON.stringify(d).slice(0,260);
    console.log(ev.eventType, brief);
  }
}
console.log("\nMESSAGE:", (session.finalResponse?.message ?? "").slice(0,400));
process.exit(0);
