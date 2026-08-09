import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const history = [
  { role: "user", text: "do i have vlc installed?" },
  { role: "assistant", text: "No, VLC is not installed on your computer. A search of all 209 installed applications for \"VLC media player\" returned zero matches." }
];
const i = await rt.intentEngine.classify("what about chrome?", { history, workspacePath: repo });
console.log(JSON.stringify({ category: i.category, operation: i.operation ?? null, normalizedGoal: i.normalizedGoal, entities: i.entities, caps: i.requiredCapabilities, directAnswer: (i.directAnswer||"").slice(0,80) }, null, 1));
process.exit(0);
