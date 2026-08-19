// IS COLLAPSING OLD SCREEN READINGS STILL WORTH IT?
//
//   node scripts/probe-history-cost.mjs "read my last two whatsapp messages"
//
// The loop rewrites earlier tool results to keep the conversation small — a
// superseded screen reading goes from ~3,000 tokens to about 25. That was
// measured as the single largest saving in the product, and the measurement
// counted every input token at the same price.
//
// It is not the same price. This endpoint serves the longest identical PREFIX of
// a request from cache at roughly a tenth of the cost, and editing a message in
// the MIDDLE of the conversation moves the prefix from that point on — so every
// token after the edit becomes a fresh, full-price token again on every step
// that follows. The collapse saves tokens and spends cache, and which of those
// is bigger is not something to reason about from first principles.
//
// So: the same request, twice, once with the collapse on and once off, and the
// only number that decides it is what was BILLED at full rate.
//
// THE DEFAULT IS NOW OFF, so the flag inverted: `SYSCORA_COLLAPSE_HISTORY=1`
// turns the collapse ON, where `SYSCORA_KEEP_HISTORY=1` used to turn it off.
// Both paths are still in the loop — the reversal was made on three paired runs,
// which is enough to move a default and not enough to delete a code path.
//
// A caveat this cannot remove: two live runs of a GUI task are never identical —
// the machine is in a different state and the model makes different choices.
// Run it a few times before believing a small difference. A large one is real.

import { spawn } from "node:child_process";

const request = process.argv.slice(2).join(" ")
  || "what are the last two messages in my whatsapp chat with amma";

function runOnce(collapse) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/probe-fast-agent.mjs", request], {
      cwd: process.cwd(),
      env: { ...process.env, ...(collapse ? { SYSCORA_COLLAPSE_HISTORY: "1" } : {}) }
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      const metrics = /metrics: (\{.*\})/.exec(output);
      const status = /^(COMPLETED|PARTIALLY_COMPLETED|FAILED|CANCELLED)/m.exec(output);
      resolve({
        metrics: metrics ? JSON.parse(metrics[1]) : null,
        status: status?.[1] ?? "?"
      });
    });
  });
}

const show = (label, run) => {
  if (!run.metrics) {
    console.log(`${label.padEnd(22)} no metrics — the run did not finish cleanly (${run.status})`);
    return null;
  }
  const { steps, elapsedMs, tokensIn, tokensOut, tokensCached, tokensFresh } = run.metrics;
  const fresh = tokensFresh ?? Math.max(0, tokensIn - (tokensCached ?? 0));
  console.log(
    `${label.padEnd(22)} ${String(steps).padStart(2)} steps  ${String(Math.round(elapsedMs / 1000)).padStart(3)}s  ` +
    `sent ${String(tokensIn).padStart(7)}  cached ${String(tokensCached ?? 0).padStart(7)}  ` +
    `FRESH ${String(fresh).padStart(7)}  out ${String(tokensOut).padStart(5)}  ${run.status}`
  );
  return fresh;
};

console.log(`> ${request}\n`);
console.log("Two live runs. `FRESH` is the input actually billed at full rate.\n");

const collapsed = await runOnce(true);
const intact = await runOnce(false);

const freshCollapsed = show("collapse readings", collapsed);
const freshIntact = show("keep history (default)", intact);

console.log("");
if (freshCollapsed == null || freshIntact == null) {
  console.log("One of the runs did not produce metrics, so there is nothing to compare.");
} else if (freshCollapsed === freshIntact) {
  console.log("Identical billable input — this task is too short for the difference to show.");
} else {
  const cheaper = freshCollapsed < freshIntact ? "COLLAPSING" : "KEEPING HISTORY";
  const saving = Math.abs(freshCollapsed - freshIntact);
  const share = ((saving / Math.max(freshCollapsed, freshIntact)) * 100).toFixed(0);
  console.log(`${cheaper} is cheaper on this run: ${saving.toLocaleString()} fewer billed tokens (${share}%).`);
  console.log("Run it again before acting on it — a GUI task varies by more than this between runs.");
}
process.exit(0);
