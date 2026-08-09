import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const text = process.argv.slice(2).join(" ") || "list the running processes";
const session = await rt.submitIntent(text, { autoApprove: false, workspacePath: repo });
console.log("STATUS", session.finalResponse?.status);
console.log("CRITERIA", JSON.stringify(session.intent?.successCriteria));
for (const ev of session.events ?? []) {
  if (["ADAPTIVE_COMPLETION_REJECTED","ADAPTIVE_BINDING_REJECTED","ADAPTIVE_PREMATURE_ESCALATION_REJECTED"].includes(ev.eventType)) {
    console.log(ev.eventType, JSON.stringify(ev.details).slice(0, 700));
  }
}
process.exit(0);
