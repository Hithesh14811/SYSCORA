import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const cases = [
  { history: [{role:"user",text:"open notepad"},{role:"assistant",text:"Notepad is open."}], text: "now maximize it" },
  { history: [{role:"user",text:"list my running processes"},{role:"assistant",text:"There are 25 processes; the largest is Memory Compression."}], text: "which one is using the most memory?" },
  { history: [], text: "now maximize it" }
];
for (const c of cases) {
  const started = Date.now();
  const r = await rt.reasoningEngine.understandIntent(c.text, { history: c.history, knownOperations: [] });
  console.log(JSON.stringify({
    text: c.text, withHistory: c.history.length > 0, ms: Date.now()-started, ok: r.ok,
    normalizedGoal: r.data?.normalizedGoal, category: r.data?.category, reqCaps: r.data?.requiredCapabilities
  }));
}
process.exit(0);
