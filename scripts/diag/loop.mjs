import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const started = Date.now();
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo });
console.log(`STATUS ${s.finalResponse?.status}  ${Math.round((Date.now()-started)/1000)}s  route=${s.plan?.plannerSource ?? "loop"}  reason=${s.finalResponse?.reason ?? ""}`);
for (const ev of s.events ?? []) {
  const d = ev.details ?? {};
  if (ev.eventType === "ADAPTIVE_DECIDED") {
    const dec = d.decision ?? {};
    console.log(`  DECIDE ${dec.kind ?? dec.error ?? "?"} :: ${JSON.stringify(dec.action?.capability ?? dec.localSteps?.map(x=>x.capability) ?? dec.reason ?? "").slice(0,140)}`);
  }
  if (ev.eventType === "TASK_STARTING") console.log(`  RUN    ${d.capability}`);
  if (ev.eventType === "VERIFICATION_FAILED") console.log(`  VFAIL  ${String(d.message).slice(0,110)}`);
  if (ev.eventType === "ADAPTIVE_COMPLETION_REJECTED") console.log(`  CREJ   ${JSON.stringify(d.errors).slice(0,160)}`);
  if (ev.eventType === "ADAPTIVE_LOOP_DETECTED") console.log(`  LOOP   repeated x${d.repeatCount}`);
  if (ev.eventType === "ADAPTIVE_TARGET_EXHAUSTED") console.log(`  EXHAUST ${d.pairKey}`);
  if (ev.eventType === "ADAPTIVE_CONTROLLER_FINISHED") console.log(`  END    ${d.status} ${d.reason ?? ""} steps=${d.steps} calls=${d.modelCalls}/${d.maxModelCalls}`);
  if (ev.eventType === "ERROR_OCCURRED") console.log(`  ERROR  ${d.error}`);
}
console.log("ANSWER:", (s.finalResponse?.message ?? "").replace(/\s+/g," ").slice(0,400));
process.exit(0);
