// Measure the input engine against the machine it actually runs on.
//
// Every number this reports is taken from a live host process: how long a round
// trip costs, how long a stroke of N points really takes against the pacing it
// was asked for, and whether the pointer lands on the pixel it was sent to. None
// of that can be reasoned about from the source — the timer resolution, the
// cost of the interpreter round trip and the rounding in absolute coordinates
// are all properties of this machine.
//
// It moves the real pointer, so it parks it back where it found it and never
// presses a button outside an explicit --stroke run.
import { WindowsAutomationHostClient } from "../os-adapters/windows-host/src/client.js";
import { buildPath, flattenPath } from "../packages/fast-agent/src/stroke-path.js";

const host = new WindowsAutomationHostClient({ requestTimeoutMs: 60000 });
const time = async (label, fn) => {
  const started = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${label.padEnd(38)} ${ms.toFixed(2)} ms`);
  return { result, ms };
};

try {
  const health = await time("host.health (cold start)", () => host.request("host.health", {}, { timeoutMs: 60000 }));
  console.log("  ->", JSON.stringify(health.result));

  const warm = [];
  for (let n = 0; n < 20; n += 1) {
    const started = process.hrtime.bigint();
    await host.request("host.health", {});
    warm.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  warm.sort((a, b) => a - b);
  console.log(`round trip: median ${warm[10].toFixed(2)} ms, best ${warm[0].toFixed(2)} ms, worst ${warm[19].toFixed(2)} ms`);

  const origin = await host.request("pointer.move", { x: 400, y: 400 });
  console.log("pointer.move ->", JSON.stringify(origin));

  // Exactness across the whole desktop, including the awkward coordinates: the
  // rounding in absolute positioning is worst far from the origin.
  const probes = [[7, 11], [400, 400], [1279, 719], [1919, 1079], [1920, 1080], [2559, 1439]];
  let exact = 0;
  for (const [x, y] of probes) {
    const landed = await host.request("pointer.move", { x, y });
    if (landed.x === x && landed.y === y) exact += 1;
    else console.log(`  MISS asked ${x},${y} -> got ${landed.x},${landed.y}`);
  }
  console.log(`pointer exactness: ${exact}/${probes.length} landed on the exact pixel`);

  // Pacing accuracy. This is the number Start-Sleep could not deliver: it waits
  // for the next scheduler tick, so a 1ms request costs 15.6ms.
  for (const [points, pacing] of [[100, 1000], [400, 900], [1000, 500]]) {
    const path = [];
    for (let n = 0; n < points; n += 1) path.push(600 + n, 600);
    const started = process.hrtime.bigint();
    const result = await host.request("pointer.stroke", {
      path, button: "none", pacingMicros: pacing, settleMicros: 0
    }, { timeoutMs: 60000 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const ideal = (points * pacing) / 1000;
    console.log(
      `stroke ${String(points).padStart(4)} pts @ ${pacing}us: ${ms.toFixed(1)} ms ` +
      `(ideal ${ideal.toFixed(0)} ms, overhead ${(ms - ideal).toFixed(1)} ms, ` +
      `${(points / (ms / 1000)).toFixed(0)} points/sec) injected ${result.injectedEvents}/${result.requestedEvents}`
    );
  }

  // A batched stroke: no pacing at all, one syscall for the whole path.
  const batched = [];
  for (let n = 0; n < 2000; n += 1) batched.push(500 + (n % 400), 500 + Math.floor(n / 400));
  const batch = await time("stroke 2000 pts batched (pacing 0)", () => host.request("pointer.stroke", {
    path: batched, button: "none", pacingMicros: 0, settleMicros: 0
  }, { timeoutMs: 60000 }));
  console.log("  ->", JSON.stringify(batch.result));

  // The geometry the drawing tool will really send for a circle.
  const circle = buildPath({ shape: "circle", cx: 800, cy: 500, radius: 200 });
  console.log(`circle r=200 -> ${circle.length} points from the path builder`);
  const drawn = await time("circle r=200 delivered (no button)", () => host.request("pointer.stroke", {
    path: flattenPath(circle), button: "none", pacingMicros: 900, settleMicros: 0
  }, { timeoutMs: 60000 }));
  console.log("  ->", JSON.stringify(drawn.result));

  await host.request("pointer.move", { x: 400, y: 400 });
  // Nothing should be held down when this exits.
  await host.request("pointer.up", { button: "left" });
} catch (error) {
  console.error("PROBE FAILED:", error.message);
  process.exitCode = 1;
} finally {
  host.close();
}
