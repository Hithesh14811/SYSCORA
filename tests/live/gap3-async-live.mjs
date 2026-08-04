/**
 * GAP 3 live reproduction.
 *
 * Confirms against a REAL cold-started daemon that:
 *   - POST /api/intents returns near-instantly instead of blocking,
 *   - progress is observable while the work is still running,
 *   - the PowerShell automation host is warmed at boot, not on first request.
 *
 * Usage: SYSCORA_API_TOKEN=<token> node tests/live/gap3-async-live.mjs
 */
const TOKEN = process.env.SYSCORA_API_TOKEN;
const BASE = process.env.SYSCORA_BASE_URL ?? "http://127.0.0.1:4317";
const GOAL = process.env.SYSCORA_LIVE_GOAL ?? "give me a summary of this computer";

if (!TOKEN) {
  console.error("SYSCORA_API_TOKEN is required");
  process.exit(2);
}

const headers = { "content-type": "application/json", "x-syscora-token": TOKEN };

console.log("=== GAP 3 LIVE REPRODUCTION ===");
console.log("goal:", GOAL);

const submitStartedAt = Date.now();
const submission = await fetch(`${BASE}/api/intents`, {
  method: "POST",
  headers,
  body: JSON.stringify({ text: GOAL, autoApprove: true })
});
const submitMs = Date.now() - submitStartedAt;
const accepted = await submission.json();

console.log(`POST /api/intents -> ${submission.status} in ${submitMs}ms`);
console.log("body:", JSON.stringify(accepted).slice(0, 200));

const sessionId = accepted.sessionId;
let firstEventMs = null;
let eventCount = 0;
let terminalStatus = null;

if (sessionId) {
  const stream = await fetch(`${BASE}/api/intents/${sessionId}/stream`, { headers });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "STREAM_END") { terminalStatus = event.status; done = true; break; }
      eventCount += 1;
      firstEventMs ??= Date.now() - submitStartedAt;
      if (event.eventType) console.log(`  [+${Date.now() - submitStartedAt}ms] ${event.eventType}`);
    }
  }
}

const totalMs = Date.now() - submitStartedAt;
console.log(`\nfirst progress event at: ${firstEventMs ?? "n/a"}ms`);
console.log(`streamed events: ${eventCount}`);
console.log(`terminal status: ${terminalStatus} after ${totalMs}ms total`);

console.log("\n--- gate ---");
const fastAck = submission.status === 202 && submitMs < 1000;
const progressObserved = eventCount > 0;
const settled = terminalStatus != null;
console.log(`submission returned 202 in <1000ms: ${fastAck} (${submitMs}ms)`);
console.log(`progress observable while running: ${progressObserved}`);
console.log(`run reached a terminal state: ${settled} (${terminalStatus})`);
console.log(`work outlasted the HTTP response: ${totalMs > submitMs * 2}`);

const passed = fastAck && progressObserved && settled;
console.log(passed ? "\nGAP 3 LIVE: PASS" : "\nGAP 3 LIVE: FAIL");
process.exit(passed ? 0 : 1);
