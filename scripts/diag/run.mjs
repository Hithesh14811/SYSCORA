import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const started = Date.now();
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo });
const caps = [];
for (const ev of s.events ?? []) {
  if (ev.eventType === "TASK_STARTING" && ev.details?.capability) caps.push(ev.details.capability);
}
const counted = caps.reduce((acc, c) => (acc[c] = (acc[c] ?? 0) + 1, acc), {});
console.log(`STATUS  ${s.finalResponse?.status}   ${Math.round((Date.now()-started)/1000)}s   route=${s.plan?.plannerSource ?? "loop"}`);
console.log(`CAPS    ${JSON.stringify(counted)}`);
console.log(`ANSWER  ${(s.finalResponse?.message ?? "").replace(/\s+/g," ").slice(0,500)}`);
process.exit(0);
