// Live routing probe.
//
// Submits a fixed set of READ-ONLY requests through the real runtime and the
// configured model, and reports how each one was routed and how it ended. This
// is the before/after measurement for routing changes: it answers "does the
// request reach a route that can serve it, and does it end honestly?", which
// isolated unit tests cannot.
//
// Every request here is read-only by construction — nothing installs, writes,
// deletes, launches, or navigates. Add new probes to PROBES only if they stay
// read-only, because this script runs unattended against the real machine.
//
//   node scripts/live-routing-probe.js
//   node scripts/live-routing-probe.js --only chat
//   node scripts/live-routing-probe.js --out baseline.json

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";

const PROBES = [
  { id: "chat-greeting", group: "chat", text: "hi" },
  { id: "chat-capabilities", group: "chat", text: "what can you do" },
  { id: "chat-identity", group: "chat", text: "who are you" },
  { id: "chat-general", group: "chat", text: "explain what RAM is in one sentence" },

  { id: "typed-system", group: "typed", text: "inspect this system" },

  { id: "read-processes", group: "read", text: "list the running processes" },
  { id: "read-top-memory", group: "read", text: "which processes are using the most memory" },
  { id: "read-installed", group: "read", text: "list the applications installed on this computer" },
  { id: "read-tree", group: "read", text: "show me the folder structure of this project" },
  { id: "read-slow", group: "read", text: "why is my computer running slow" },
  { id: "read-disk", group: "read", text: "how much free disk space do I have" }
];

function parseArgs(argv) {
  const args = { only: null, out: null, timeoutMs: 120000 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--only") args.only = argv[i + 1];
    if (argv[i] === "--out") args.out = argv[i + 1];
    if (argv[i] === "--timeout") args.timeoutMs = Number(argv[i + 1]);
  }
  return args;
}

// How the request was served. Derived from the session rather than guessed, so
// a routing change shows up here as a different route, not just a different
// message.
function routeOf(session) {
  const events = session?.events ?? [];
  const types = new Set(events.map((e) => e.eventType));
  if (types.has("CONVERSATIONAL_REPLY")) {
    // Distinguish "the classifier recognised a conversation and answered" from
    // "planning found nothing and we fell back to talking". Both produce a
    // reply; only the first is the fast path.
    const reply = events.find((e) => e.eventType === "CONVERSATIONAL_REPLY");
    return reply?.details?.source === "INTENT_CLASSIFICATION" ? "CHAT_FAST" : "CHAT_FALLBACK";
  }
  if (session?.finalResponse?.interactive || types.has("INTERACTIVE_REASONING_FAILED")) return "ADAPTIVE_LOOP";
  if (session?.plan?.plannerSource) return session.plan.plannerSource;
  if (types.has("PLAN_EMPTY_NEEDS_CLARIFICATION")) return "NO_ROUTE";
  return "UNKNOWN";
}

// A result is only useful if it actually addresses the request. "Failed safely"
// and "asked a clarifying question" are honest, but they are not answers, so
// they are counted separately from served requests.
function verdictOf(session) {
  const status = session?.finalResponse?.status ?? session?.currentState ?? "UNKNOWN";
  if (["ANSWERED", "COMPLETED"].includes(status)) return "SERVED";
  if (["PARTIALLY_COMPLETED", "INCONCLUSIVE"].includes(status)) return "PARTIAL";
  if (["NEEDS_CLARIFICATION", "AWAITING_APPROVAL"].includes(status)) return "DEFLECTED";
  return "FAILED";
}

async function main() {
  const args = parseArgs(process.argv);
  const probes = args.only ? PROBES.filter((p) => p.group === args.only || p.id === args.only) : PROBES;

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-probe-"));
  const workspace = path.join(tempRoot, "ws");
  await fs.mkdir(workspace, { recursive: true });

  // createRuntime(basePath) resolves BOTH the state directory and the model
  // config from basePath. Running against a bare temp directory therefore finds
  // no .syscora/config.json and silently falls back to the Mock provider, which
  // answers every prompt with a canned intent fixture — so the probe measures
  // nothing real while appearing to work. Copy the repo's model config into the
  // temp root so the probe exercises the configured model, while sessions,
  // audit, and memory still land in throwaway state.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
  const sourceConfig = path.join(repoRoot, ".syscora", "config.json");
  await fs.mkdir(path.join(tempRoot, ".syscora"), { recursive: true });
  try {
    await fs.copyFile(sourceConfig, path.join(tempRoot, ".syscora", "config.json"));
  } catch {
    console.error(
      `WARNING: could not read ${sourceConfig}. The probe will run against the Mock provider ` +
      `and its results will not reflect real model behaviour.`
    );
  }
  // Give the project-shaped probes something real to look at.
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "probe-workspace", version: "1.0.0" }, null, 2));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "index.js"), "export const answer = 42;\n");

  const runtime = createRuntime(tempRoot);
  // Fail loudly rather than reporting mock behaviour as if it were real.
  const providerNames = JSON.stringify(runtime.reasoningEngine?.modelProvider?.capabilities?.() ?? {});
  const usingRealModel = !/"providers":\[\{"name":"mock"/.test(providerNames);
  console.log(`model provider: ${usingRealModel ? "REAL" : "MOCK (results are not meaningful)"}\n`);

  const results = [];

  for (const probe of probes) {
    const startedAt = Date.now();
    let session = null;
    let error = null;
    try {
      session = await Promise.race([
        // autoApprove stays OFF: a probe must never authorize a consequential
        // action, and every probe here is read-only anyway.
        runtime.submitIntent(probe.text, { autoApprove: false, workspacePath: workspace }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`probe timed out after ${args.timeoutMs}ms`)), args.timeoutMs))
      ]);
    } catch (e) {
      error = e.message;
    }
    const elapsedMs = Date.now() - startedAt;
    const record = {
      id: probe.id,
      group: probe.group,
      text: probe.text,
      elapsedMs,
      error,
      route: error ? "THREW" : routeOf(session),
      verdict: error ? "FAILED" : verdictOf(session),
      status: session?.finalResponse?.status ?? session?.currentState ?? null,
      message: (session?.finalResponse?.message ?? "").slice(0, 220),
      modelCalls: session?.interactiveController?.metrics?.modelCalls ?? null
    };
    results.push(record);
    console.log(
      `${record.verdict.padEnd(9)} ${record.route.padEnd(22)} ${String(elapsedMs).padStart(6)}ms  ${probe.id}\n` +
      `          ${record.message.replace(/\s+/g, " ").slice(0, 150)}\n`
    );
  }

  const summary = {
    served: results.filter((r) => r.verdict === "SERVED").length,
    partial: results.filter((r) => r.verdict === "PARTIAL").length,
    deflected: results.filter((r) => r.verdict === "DEFLECTED").length,
    failed: results.filter((r) => r.verdict === "FAILED").length,
    total: results.length,
    medianMs: results.map((r) => r.elapsedMs).sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0
  };
  console.log("SUMMARY", JSON.stringify(summary));

  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify({ summary, results }, null, 2));
    console.log(`wrote ${args.out}`);
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  // The runtime keeps handles open (SQLite, warm host); the probe's work is done.
  process.exit(0);
}

main();
