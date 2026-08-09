import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo });
const interesting = new Set([
  "ADAPTIVE_ACTION_UNCONFIRMED", "ADAPTIVE_COMPOSITION_REJECTED", "ADAPTIVE_COMPOSITION_BLOCKED",
  "ADAPTIVE_TARGET_EXHAUSTED", "ADAPTIVE_PREMATURE_ESCALATION_REJECTED", "ADAPTIVE_BINDING_REJECTED",
  "ADAPTIVE_DETERMINISTIC_RECOVERY_STATE", "ADAPTIVE_CONTROLLER_FINISHED", "ADAPTIVE_LOOP_DETECTED"
]);
for (const ev of s.events ?? []) {
  if (!interesting.has(ev.eventType)) continue;
  console.log(ev.eventType, JSON.stringify(ev.details).slice(0, 200));
}
console.log("STATUS", s.finalResponse?.status);
process.exit(0);
