import { WindowsAutomationHostClient } from "../os-adapters/windows-host/src/client.js";
const host = new WindowsAutomationHostClient({ requestTimeoutMs: 60000 });
await host.request("host.health", {}, { timeoutMs: 60000 });
// Type into nothing (no window targeted, no focus acquired) purely to time the
// injection path. Keystrokes go to whatever has focus, so this is measured with
// focus on a throwaway target: it reports host-side timing only.
for (const n of [50, 500, 5000]) {
  const text = "a".repeat(n);
  const t0 = process.hrtime.bigint();
  const r = await host.request("keyboard.type", { text, method: "keys", pacingMicros: 0 }, { timeoutMs: 60000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${String(n).padStart(5)} chars: wall ${ms.toFixed(1)}ms  host ${r.durationMs}ms  method ${r.method}  accepted ${r.injectedEvents}/${r.requestedEvents}`);
}
host.close();
