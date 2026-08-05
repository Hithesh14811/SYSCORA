import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

process.env.SYSCORA_MODEL_PROVIDER = "mock";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "AWAITING_APPROVAL", "AWAITING_USER_INPUT", "TIMED_OUT"]);
const results = [];
const only = new Set(String(process.env.SYSCORA_LIVE_ONLY ?? "").split(",").map((value) => value.trim()).filter(Boolean));

async function runIntent(label, prompt, { timeoutMs = 90_000, exact = "COMPLETED", inspectDesktopInput = false } = {}) {
  if (only.size > 0 && !only.has(label)) return null;
  console.error(`[live] ${label} starting (${timeoutMs}ms deadline)`);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-phase-b-live-"));
  const runtime = createRuntime(base);
  const desktopInput = [];
  if (inspectDesktopInput) {
    for (const method of ["keyboardAction", "mouseAction", "performUiAction"]) {
      if (typeof runtime.adapter?.[method] !== "function") continue;
      const original = runtime.adapter[method].bind(runtime.adapter);
      runtime.adapter[method] = async (...args) => {
        desktopInput.push({ method, args });
        return original(...args);
      };
    }
  }
  try {
    const beforeWindows = inspectDesktopInput ? await runtime.adapter.listWindows() : [];
    const started = Date.now();
    const session = await runtime.submitIntent(prompt, {
      workspacePath: base,
      autoApprove: true,
      maxElapsedTime: timeoutMs
    });
    console.error(`[live] ${label} returned ${session.finalResponse?.status ?? "NO_STATUS"}`);
    const status = session.finalResponse?.status;
    assert.ok(TERMINAL.has(status), `${label} did not reach a terminal state: ${status}`);
    if (exact && status !== exact) {
      console.error(`${label} diagnostic:`, JSON.stringify({
        status,
        finalResponse: session.finalResponse,
        tasks: session.plan?.taskGraph?.tasks,
        taskResults: session.taskResults,
        events: session.events?.slice(-12)
      }, null, 2));
    }
    if (exact) assert.equal(status, exact, `${label} expected ${exact}, got ${status}`);
    const capabilities = (session.plan?.taskGraph?.tasks ?? []).map((task) => task.capability);
    if (inspectDesktopInput) {
      if (capabilities.length === 0) {
        console.error("flight diagnostic:", JSON.stringify({ status, finalResponse: session.finalResponse, events: session.events?.slice(-8) }, null, 2));
      }
      assert.deepEqual(capabilities, ["browser.research"], "flight research must use only its read-only semantic browser tool");
      assert.deepEqual(desktopInput, [], "flight research must never emit desktop keyboard, pointer, or UIA actions");
      assert.ok(session.intent?.constraints?.includes("NO_BOOKING"), "NO_BOOKING constraint must survive classification");
      assert.ok(!capabilities.some((name) => /click|type|select|submit|book|purchase|pay/i.test(name)), "transactional browser actions are forbidden");
      const afterWindows = await runtime.adapter.listWindows();
      results.push({ label, status, elapsedMs: Date.now() - started, capabilities, desktopInputCount: 0, beforeWindowCount: beforeWindows.length, afterWindowCount: afterWindows.length });
    } else {
      results.push({ label, status, elapsedMs: Date.now() - started, capabilities });
    }
    return session;
  } finally {
    runtime.adapter?.close?.();
    await fs.rm(base, { recursive: true, force: true });
  }
}

await runIntent(
  "flight-no-booking",
  "Find the cheapest flight from Delhi to Mumbai next Friday, but do not book, reserve, purchase, pay, or submit anything.",
  { timeoutMs: 45_000, exact: null, inspectDesktopInput: true }
);
await runIntent("youtube-playback", "Play a lofi focus video on YouTube", { timeoutMs: 90_000 });
await runIntent("calculator", "Launch Calculator", { timeoutMs: 30_000 });
await runIntent("system-information", "Tell me about this computer and what development tools are installed", { timeoutMs: 60_000 });
await runIntent("port-3000", "What process is listening on port 3000?", { timeoutMs: 30_000 });
await runIntent("spotify-compound", "Play Good For You on Spotify and queue Billie Jean", { timeoutMs: 120_000 });

console.log(JSON.stringify({ passed: true, results }, null, 2));
