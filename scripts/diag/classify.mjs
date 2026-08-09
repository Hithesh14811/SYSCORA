import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import path from "node:path";
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "..");
const rt = createRuntime(repo);
const texts = process.argv.slice(2).length ? process.argv.slice(2) : [
  "hi", "explain what RAM is in one sentence",
  "which processes are using the most memory", "how much free disk space do I have"
];
for (const t of texts) {
  const started = Date.now();
  try {
    const r = await rt.reasoningEngine.understandIntent(t, { knownOperations: [] });
    const d = r.data ?? {};
    console.log(JSON.stringify({
      text: t, ms: Date.now()-started, ok: r.ok, error: r.error,
      category: d.category, operation: d.operation,
      answerable: d.answerableWithoutInspecting,
      directAnswer: (d.directAnswer||"").slice(0,90),
      reqCaps: d.requiredCapabilities, demoted: d.conversationDemotedReason
    }));
  } catch (e) { console.log(JSON.stringify({text:t, ms:Date.now()-started, threw:e.message})); }
}
process.exit(0);
