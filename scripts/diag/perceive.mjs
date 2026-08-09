import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo });
let n = 0;
for (const ev of s.events ?? []) {
  if (ev.eventType !== "ADAPTIVE_PERCEIVED") continue;
  const p = ev.details?.summary ?? {};
  const controls = p.relevantControls ?? [];
  n++;
  const w = p.groundedWindow ?? {};
  console.log(`\n--- perception ${n}: window=${JSON.stringify(w.title ?? w.MainWindowTitle ?? null)} controls=${controls.length}`);
  if (controls.length) console.log(controls.slice(0, 45).map((c) => `${String(c.controlType).replace("ControlType.", "")}:${c.name}`).join(" | ").slice(0, 1500));
}
console.log("\nSTATUS", s.finalResponse?.status);
console.log("MSG", String(s.finalResponse?.message).replace(/\s+/g," ").slice(0, 300));
process.exit(0);
