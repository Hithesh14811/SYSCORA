import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { OPERATION_PLANS } from "../../packages/planner/src/index.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const history = [
  { role: "user", text: "do i have vlc installed?" },
  { role: "assistant", text: "No, VLC is not installed on your computer." }
];
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const r = await rt.reasoningEngine.understandIntent("what about chrome?", { history, knownOperations: Object.keys(OPERATION_PLANS) });
  console.log(`try ${i}: ${Date.now()-t}ms ok=${r.ok} ${r.ok ? `op=${r.data?.operation} goal="${r.data?.normalizedGoal}"` : "ERR " + r.error}`);
}
process.exit(0);
