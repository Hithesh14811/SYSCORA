// One real request through the real runtime, narrated as the chat surface sees
// it. Pass the request as an argument; it defaults to a read-only one.
//
//   node scripts/probe-fast-agent.mjs "what is my disk space"
//   node scripts/probe-fast-agent.mjs --approve "send X to Y on whatsapp"
//
// WITHOUT --approve, an irreversible action's card goes unanswered and is
// refused after two minutes — which is correct for a headless probe, and means
// the send tasks cannot be measured end to end from here. --approve answers yes
// and PRINTS THE CARD IT ANSWERED, so what was authorised is on the record.
import { createRuntime } from "../apps/daemon/src/runtime-factory.js";

const argv = process.argv.slice(2);
const approve = argv.includes("--approve");
const request = argv.filter((arg) => arg !== "--approve").join(" ")
  || "how much free disk space do I have on C?";
const runtime = createRuntime(process.cwd());

const startedAt = Date.now();
let firstOutputAt = null;
const at = () => `${String(Date.now() - startedAt).padStart(6)}ms`;

runtime.onSessionEvent = (_sessionId, event) => {
  const details = event.details ?? {};
  if (firstOutputAt === null) firstOutputAt = Date.now();
  switch (event.eventType) {
    case "APPROVAL_REQUIRED":
      process.stdout.write(`\n[${at()}] APPROVAL ASKED: ${details.summary}\n` +
        `      rule: ${details.rule} — ${details.reason}\n      ${details.detail ?? ""}\n`);
      if (approve) {
        process.stdout.write(`[${at()}] answering YES (--approve)\n`);
        runtime.resolveApproval?.(details.approvalId, true);
      } else {
        process.stdout.write(`[${at()}] not answering — run with --approve to allow this\n`);
      }
      break;
    case "AGENT_DELTA":
      process.stdout.write(details.text ?? event.text ?? "");
      break;
    case "AGENT_SAYS":
      if (details.observed) process.stdout.write(`\n[${at()}] SAW:  ${details.observed}\n`);
      if (details.text) process.stdout.write(`${details.observed ? "" : `\n[${at()}] `}SAYS: ${details.text}\n`);
      break;
    case "TOOL_STARTED":
      process.stdout.write(`[${at()}] → ${details.tool} ${details.preview ?? ""}\n`);
      break;
    case "TOOL_FINISHED":
      process.stdout.write(`[${at()}] ${details.ok ? "✓" : "✗"} ${details.tool} (${details.durationMs}ms)\n` +
        `${String(details.output ?? "").split("\n").slice(0, 6).map((line) => `      ${line}`).join("\n")}\n`);
      break;
    case "AGENT_THROTTLED":
      process.stdout.write(`[${at()}] THROTTLED waiting ${details.waitMs}ms (spacing now ${details.spacingMs}ms)\n`);
      break;
    case "AGENT_DONE":
      process.stdout.write(`[${at()}] DONE ${details.status} — ${details.steps} model calls, ${details.toolCalls} tools\n`);
      break;
    default:
      process.stdout.write(`[${at()}] ${event.eventType}\n`);
  }
};

console.log(`> ${request}\n`);
const session = await runtime.submitIntent(request, { workspacePath: process.cwd(), history: [] });
console.log("\n=== final ===");
console.log(session.finalResponse?.status, "|", session.finalResponse?.message);
console.log("metrics:", JSON.stringify(session.finalResponse?.metrics));
// WHAT WAS SENT IS NOT WHAT WAS BILLED. The endpoint serves the fixed prefix
// from its cache at roughly a tenth of the price, so a run whose `tokensIn`
// looks alarming may have paid full rate for a small fraction of it. Quoting the
// raw number is how this project convinced itself its GUI tasks were an order of
// magnitude more expensive than they are.
{
  const metrics = session.finalResponse?.metrics ?? {};
  const cached = Number(metrics.tokensCached) || 0;
  const fresh = Number(metrics.tokensFresh) || Math.max(0, (Number(metrics.tokensIn) || 0) - cached);
  if (cached > 0) {
    const share = ((cached / (Number(metrics.tokensIn) || 1)) * 100).toFixed(1);
    console.log(`billable input: ${fresh.toLocaleString()} fresh + ${cached.toLocaleString()} cached (${share}% of input served from cache)`);
  } else {
    console.log("billable input: no cache hits reported — every input token was paid for at full rate");
  }
}
console.log(`time to first output: ${firstOutputAt - startedAt}ms | total: ${Date.now() - startedAt}ms`);
process.exit(0);
