import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const re = rt.reasoningEngine;
const catalog = rt.capabilityRegistry.getCatalog().map((c) => ({
  name: c.name, description: c.description,
  inputs: Object.fromEntries(Object.entries(c.inputSchema?.properties ?? {}).map(([k, v]) => [k, { type: v.type }])),
  requiredInputs: c.inputSchema?.required ?? []
}));
console.log("catalog entries:", catalog.length, "| chars:", JSON.stringify(catalog).length);
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const r = await re.decideInteractiveAction({
    goal: "Open notepad and write a C++ program that prints a star pyramid",
    availableCapabilities: catalog,
    reasoningPhase: i === 0 ? "INITIAL_STRATEGY" : "RECOVERY",
    remainingBudgets: { modelCalls: 5, steps: 20 },
    recentActions: [], observations: []
  });
  console.log(`call ${i}: ${Date.now() - t}ms ok=${r.ok} ${r.ok ? r.data?.kind : r.error}`);
}
process.exit(0);
