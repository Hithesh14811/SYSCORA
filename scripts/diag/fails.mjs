import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const s = await rt.submitIntent(process.argv.slice(2).join(" "), { autoApprove: true, workspacePath: repo });
const st = s.interactiveController ?? {};
console.log("status:", st.status, "reason:", st.reason, "steps:", st.steps, "unconfirmed:", st.unconfirmedAttempts ?? 0);
console.log("failedAttempts:", (st.failedAttempts ?? []).length);
for (const f of st.failedAttempts ?? []) {
  console.log("  -", typeof f.action === "string" ? f.action : f.action?.capability, "::",
    String(f.reason ?? f.verification?.status + " " + f.verification?.message).slice(0, 130));
}
process.exit(0);
