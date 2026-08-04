/**
 * GAP 2 live reproduction.
 *
 * Drives the EXACT command from the original live audit through a real daemon
 * and asserts it no longer dies on `max-model-calls` before the type and
 * screenshot clauses are attempted.
 *
 * Run with the daemon already listening:
 *   SYSCORA_API_TOKEN=<token> node tests/live/gap2-notepad-live.mjs
 */
const TOKEN = process.env.SYSCORA_API_TOKEN;
const BASE = process.env.SYSCORA_BASE_URL ?? "http://127.0.0.1:4317";
const GOAL = "Open Notepad and type 'hello from syscora test' then take a screenshot";

if (!TOKEN) {
  console.error("SYSCORA_API_TOKEN is required");
  process.exit(2);
}

async function post(pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-syscora-token": TOKEN },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, text };
  }
}

const startedAt = Date.now();
const result = await post("/api/intents", { text: GOAL, autoApprove: true });
const elapsedMs = Date.now() - startedAt;

const body = result.json ?? {};
const session = body.session ?? body;
const final = session.finalResponse ?? {};
// Session events are { eventId, eventType, timestamp, details }.
const events = session.events ?? [];

const eventTypes = events.map((event) => event.eventType);
const detailsFor = (name) => events.find((event) => event.eventType === name)?.details ?? null;
const attemptedCapabilities = events
  .filter((event) => event.eventType === "ADAPTIVE_ACTION_STARTING")
  .map((event) => event.details?.action?.capability)
  .filter(Boolean);
const finishedEvent = detailsFor("ADAPTIVE_CONTROLLER_FINISHED");
const budgetEvent = detailsFor("ADAPTIVE_SESSION_BUDGET_RESOLVED");

console.log("=== GAP 2 LIVE REPRODUCTION ===");
console.log("goal:", GOAL);
console.log("http status:", result.status, "| elapsed:", elapsedMs, "ms");
console.log("final status:", final.status);
console.log("final message:", String(final.message ?? "").slice(0, 300));
console.log("session budget event:", JSON.stringify(budgetEvent ?? null));
console.log("controller finished:", JSON.stringify(finishedEvent ?? null));
console.log("attempted capabilities:", attemptedCapabilities.join(", ") || "(none)");
console.log("deterministic resolution events:",
  eventTypes.filter((type) => String(type).startsWith("ADAPTIVE_DETERMINISTIC")).join(", ") || "(none)");
console.log("warnings:", JSON.stringify(final.warnings ?? null));

const acceptableStatus = ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(final.status);
const typeAttempted = attemptedCapabilities.some((name) => /^(keyboard\.type|ui\.action)$/.test(name));
const screenshotAttempted = attemptedCapabilities.includes("screen.capture");
const oldFailure = finishedEvent?.reason === "max-model-calls" && final.status === "FAILED";

console.log("\n--- gate ---");
console.log("status is COMPLETED or COMPLETED_WITH_WARNINGS:", acceptableStatus);
console.log("type clause attempted:", typeAttempted);
console.log("screenshot clause attempted:", screenshotAttempted);
console.log("old max-model-calls hard failure:", oldFailure);

const passed = acceptableStatus && typeAttempted && screenshotAttempted && !oldFailure;
console.log(passed ? "\nGAP 2 LIVE: PASS" : "\nGAP 2 LIVE: FAIL");
if (!passed) {
  console.log("\nfull event trace:");
  for (const event of events) {
    console.log("  -", event.eventType, JSON.stringify(event.details ?? {}).slice(0, 200));
  }
}
process.exit(passed ? 0 : 1);
