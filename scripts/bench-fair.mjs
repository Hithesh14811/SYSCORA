// The fair comparison: the SAME circle, in the SAME place, one engine at a time,
// with the canvas cleared between runs.
//
// Two earlier attempts at this were invalid and both are worth recording,
// because both produced a confident-looking number that meant nothing. The
// first resolved Paint by application name at each step, so the window that was
// set up and the window that was drawn into were different ones and pyautogui
// was issuing input at a window that never had focus. The second put each
// circle at a different horizontal offset to fit them side by side, and the
// offsets pushed circles off the canvas, so "ink" was measuring a region that
// was partly outside the paper.
//
// Everything is pinned to one windowId, the window is activated before each
// engine runs, and every circle is drawn at the centre of the canvas.
import fs from "node:fs/promises";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import { WindowsAutomationHostClient } from "../os-adapters/windows-host/src/client.js";
import { buildPath, flattenPath } from "../packages/fast-agent/src/stroke-path.js";
import { screenSignature, changedFraction, gridRegion } from "../packages/fast-agent/src/screen-signature.js";

const host = new WindowsAutomationHostClient({ requestTimeoutMs: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encode = (flat) => Buffer.from(Int32Array.from(flat).buffer).toString("base64");
const python = (args) => new Promise((resolve) => {
  const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  child.on("exit", () => resolve(out.trim()));
});

try {
  await host.request("host.health", {}, { timeoutMs: 60000 });

  const before = new Set((await host.request("window.enumerate", {})).windows
    .filter((w) => /mspaint/i.test(w.processName)).map((w) => String(w.windowId)));
  spawn("mspaint.exe", [], { detached: true, stdio: "ignore" }).unref();
  await sleep(5000);
  const mine = (await host.request("window.enumerate", {})).windows
    .filter((w) => /mspaint/i.test(w.processName) && !before.has(String(w.windowId)));
  if (mine.length === 0) throw new Error("the new Paint window could not be identified");
  const windowId = String(mine[0].windowId);
  const ownPid = mine[0].processId;

  await host.request("window.state", { windowId, state: "maximize" });
  await sleep(1500);
  const bounds = (await host.request("window.resolve", { windowId })).window.bounds;
  const pencil = await host.request("ui.find", { windowId, name: "Pencil" }, { timeoutMs: 20000 });
  const rect = (pencil?.target ?? pencil?.matches?.[0])?.boundingRect;
  if (!rect) throw new Error("Pencil tool not found");
  await host.request("pointer.click", { windowId, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  await sleep(800);

  const circle = buildPath({
    shape: "circle",
    cx: Math.round(bounds.x + bounds.width / 2),
    cy: Math.round(bounds.y + bounds.height / 2 + 30),
    radius: 230
  });
  const region = gridRegion({
    bounds,
    from: { x: Math.min(...circle.map((p) => p.x)), y: Math.min(...circle.map((p) => p.y)) },
    to: { x: Math.max(...circle.map((p) => p.x)), y: Math.max(...circle.map((p) => p.y)) }
  });
  console.log(`Paint pid ${ownPid} window ${windowId}, ${bounds.width}x${bounds.height}, pencil selected`);
  console.log(`circle: ${circle.length} points, radius 230, at the centre of the canvas\n`);

  const shot = async (label) => {
    const path = nodePath.join(process.cwd(), `fair-${label}.png`);
    const s = await host.request("screen.capture", { windowId, path }, { timeoutMs: 25000 });
    return { cells: screenSignature(await fs.readFile(s.path)), path: s.path };
  };
  const clear = async () => {
    for (let n = 0; n < 5; n += 1) {
      await host.request("keyboard.press", { windowId, keys: "^z", chord: "ctrl+z" });
      await sleep(200);
    }
    await sleep(500);
  };

  const blank = await shot("blank");
  const results = [];

  await fs.writeFile("bench-points.json", JSON.stringify(circle.map((p) => [p.x, p.y])));
  for (const pace of [0.0, 0.002, 0.008, 0.02]) {
    await host.request("window.activate", { windowId });
    await sleep(400);
    const line = await python(["scripts/bench-pyautogui-draw.py", "bench-points.json", String(pace)]);
    await sleep(700);
    const after = await shot(`py-${String(pace * 1000).replace(".", "_")}ms`);
    const ink = changedFraction(blank.cells, after.cells, { region });
    results.push({ who: `pyautogui @ ${(pace * 1000).toFixed(0)}ms/pt`, line, ink, path: after.path });
    await clear();
  }

  await host.request("window.activate", { windowId });
  await sleep(400);
  const t0 = process.hrtime.bigint();
  const stroke = await host.request("pointer.stroke", {
    windowId, pathBase64: encode(flattenPath(circle)), button: "left", pacingMicros: 250
  }, { timeoutMs: 60000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  await sleep(800);
  const syscora = await shot("syscora");
  results.push({
    who: "SYSCORA",
    line: `SYSCORA   : ${stroke.points} points delivered in ${ms.toFixed(0)}ms wall (${(stroke.points / (ms / 1000)).toFixed(0)} points/sec), accepted ${stroke.injectedEvents}/${stroke.requestedEvents}`,
    ink: changedFraction(blank.cells, syscora.cells, { region }),
    path: syscora.path
  });

  console.log("");
  for (const r of results) {
    console.log(`${r.who.padEnd(24)} ink ${(r.ink * 100).toFixed(2).padStart(6)}%   ${r.path.split("\\").pop()}`);
    console.log(`  ${r.line}`);
  }
  console.log(`\nPaint pid ${ownPid} was opened by this benchmark.`);
} catch (error) {
  console.error("FAIR BENCH FAILED:", error.message);
  try { await host.request("pointer.up", { button: "left" }); } catch { /* gone */ }
  process.exitCode = 1;
} finally {
  host.close();
}
