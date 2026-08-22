// One request, fully instrumented: every event with its wall-clock offset, plus
// the model-call count and the prompt sizes the reasoning boundary actually
// sent. Answers "where did the time go" without guessing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";

const text = process.argv.slice(2).join(" ") || "how much free disk space do I have";
const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-diag-"));
await fs.mkdir(path.join(base, ".syscora"), { recursive: true });
await fs.copyFile(
  path.join(process.cwd(), ".syscora", "config.json"),
  path.join(base, ".syscora", "config.json")
);
const runtime = createRuntime(base);
console.log("provider:", runtime.reasoningEngine.modelProvider.capabilities().name);

const provider = runtime.reasoningEngine.modelProvider;
const calls = [];
const inner = provider.generateStructured.bind(provider);
provider.generateStructured = async (prompt, schema, options) => {
  const startedAt = Date.now();
  try {
    return await inner(prompt, schema, options);
  } finally {
    calls.push({ chars: String(prompt).length, ms: Date.now() - startedAt });
  }
};

const t0 = Date.now();
runtime.onSessionEvent = (_id, event) => {
  const d = event.details ?? {};
  const one = (value, max = 300) => JSON.stringify(value ?? null).replace(/\\n/g, " ").slice(0, max);
  const extra = event.eventType === "AGENT_SAYS" ? ` "${String(d.text).slice(0, 70)}"`
    : event.eventType === "ADAPTIVE_ACTION_STARTING" ? ` ${d.action?.capability} ${one(d.action?.inputs, 90)}`
    : event.eventType === "ADAPTIVE_ACTION_VERIFIED" ? ` ${d.capability} -> ${d.verification?.status} ${String(d.resultPreview ?? "").slice(0, 60).replace(/\n/g, " ")}`
    : /REJECTED|BLOCKED|EXHAUSTED|DETECTED|FAILED|UNCERTAIN|DEFERRED/.test(String(event.eventType)) ? ` ${one(d, 400)}`
    : event.eventType === "ADAPTIVE_DECIDED" ? ` ok=${d.ok} ${one(d.decision, 200)}`
    : "";
  console.log(`${String(Date.now() - t0).padStart(7)}ms  ${event.eventType}${extra}`);
};

const session = await runtime.submitIntent(text, { autoApprove: false, workspacePath: base });
console.log("\n--- result ---");
console.log("status:", session.finalResponse?.status);
console.log("message:", String(session.finalResponse?.message ?? "").slice(0, 400));
console.log("\ntotal:", Date.now() - t0, "ms");
console.log("model calls:", calls.length, "| total model ms:", calls.reduce((a, c) => a + c.ms, 0));
for (const [i, c] of calls.entries()) console.log(`  call ${i + 1}: ${c.chars} chars, ${c.ms}ms`);
await fs.rm(base, { recursive: true, force: true });
