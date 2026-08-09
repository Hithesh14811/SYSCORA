import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const text = process.argv.slice(2).join(" ") || "list the running processes";
const t0 = Date.now();
const session = await rt.submitIntent(text, { autoApprove: false, workspacePath: repo });
console.log(`TOTAL ${Date.now()-t0}ms  status=${session.finalResponse?.status}`);
let prev = Date.parse(session.events?.[0]?.timestamp ?? new Date().toISOString());
for (const ev of session.events ?? []) {
  const at = Date.parse(ev.timestamp);
  const delta = at - prev; prev = at;
  console.log(`${String(delta).padStart(7)}ms  ${ev.eventType}`);
}
console.log("\nANSWER:", (session.finalResponse?.message ?? "").slice(0, 300));
process.exit(0);
