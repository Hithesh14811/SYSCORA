import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const text = process.argv.slice(2).join(" ") || "which processes are using the most memory";
const session = await rt.submitIntent(text, { autoApprove: false, workspacePath: repo });
console.log("STATUS", session.finalResponse?.status);
for (const ev of session.events ?? []) {
  if (ev.eventType === "ADAPTIVE_DECIDED") {
    const d = ev.details?.decision ?? {};
    console.log("DECIDED", d.kind, JSON.stringify(d.action ?? d.localSteps ?? {}).slice(0, 500));
  }
  if (ev.eventType.startsWith("ADAPTIVE_BINDING")) console.log(ev.eventType, JSON.stringify(ev.details).slice(0,300));
}
process.exit(0);
