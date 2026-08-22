// Draw with a real pencil, in a real Paint window, and measure what landed.
//
// Pixels are the only ground truth for a drawing — OCR of a canvas with a circle
// on it and OCR of an empty canvas say the same nothing. So this captures the
// canvas before and after, decodes both, and reports how much of the drawn area
// changed and whether the shape is where it was asked for.
//
// It drives the machine: it opens Paint, selects the pencil and draws. Run it
// only when you mean to.
import fs from "node:fs/promises";
import { WindowsAutomationHostClient } from "../os-adapters/windows-host/src/client.js";
import { buildPath, flattenPath, pathLength } from "../packages/fast-agent/src/stroke-path.js";
import { screenSignature, changedFraction, gridRegion, VISIBLE_CHANGE } from "../packages/fast-agent/src/screen-signature.js";

const host = new WindowsAutomationHostClient({ requestTimeoutMs: 60000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encode = (flat) => Buffer.from(Int32Array.from(flat).buffer).toString("base64");

const look = async (windowId) => {
  const path = `${process.env.TEMP}\\syscora-m4\\probe-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const capture = await host.request("screen.capture", { windowId: String(windowId), path }, { timeoutMs: 20000 });
  if (!capture?.captured) return null;
  const cells = screenSignature(await fs.readFile(capture.path));
  return cells ? { cells, bounds: capture.bounds } : null;
};

try {
  await host.request("host.health", {}, { timeoutMs: 60000 });

  // Paint, maximised, so the canvas is large and predictable.
  const { spawn } = await import("node:child_process");
  spawn("mspaint.exe", [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  await sleep(4000);

  const resolved = await host.request("window.wait", { application: "mspaint", timeoutMs: 15000 });
  if (!resolved.found) throw new Error("Paint did not open");
  const windowId = String(resolved.window.windowId);
  await host.request("window.state", { windowId, state: "maximize" });
  await sleep(1200);
  const window = await host.request("window.resolve", { windowId });
  const bounds = window.window?.bounds ?? resolved.window.bounds;
  console.log(`Paint window ${windowId} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);

  // Select the pencil by its accessible name, so this is testing the drawing and
  // not a guess about where a toolbar button sits.
  const pencil = await host.request("ui.find", { windowId, name: "Pencil" }, { timeoutMs: 20000 });
  const target = pencil?.target ?? pencil?.matches?.[0];
  if (!target?.boundingRect) throw new Error(`Could not find the Pencil tool: ${JSON.stringify(pencil).slice(0, 300)}`);
  const rect = target.boundingRect;
  await host.request("pointer.click", {
    windowId,
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2)
  });
  await sleep(600);
  console.log(`Pencil selected at ${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)}`);

  // A circle safely inside the canvas: below the ribbon, above the status bar.
  const cx = Math.round(bounds.x + bounds.width / 2);
  const cy = Math.round(bounds.y + bounds.height / 2 + 60);
  const radius = Math.round(Math.min(bounds.width, bounds.height) / 5);
  const circle = buildPath({ shape: "circle", cx, cy, radius });
  const flat = flattenPath(circle);

  const before = await look(windowId);
  const started = process.hrtime.bigint();
  const result = await host.request("pointer.stroke", {
    windowId, pathBase64: encode(flat), button: "left", pacingMicros: 250
  }, { timeoutMs: 60000 });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  await sleep(500);
  const after = await look(windowId);

  console.log("");
  console.log(`circle: centre ${cx},${cy} radius ${radius}`);
  console.log(`  points delivered      ${result.points} (path length ${Math.round(pathLength(circle))}px)`);
  console.log(`  events accepted       ${result.injectedEvents}/${result.requestedEvents}`);
  console.log(`  landed on exact pixel ${result.exact}`);
  console.log(`  pointer ended at      ${result.endX},${result.endY} (started at ${circle[0].x},${circle[0].y})`);
  console.log(`  host time             ${result.durationMs}ms`);
  console.log(`  wall time             ${wallMs.toFixed(1)}ms  (${(result.points / (wallMs / 1000)).toFixed(0)} points/sec)`);

  const undo = await host.request("ui.find", { windowId, name: "Undo" }, { timeoutMs: 20000 });
  const undoTarget = undo?.target ?? undo?.matches?.[0];
  console.log(`  application has something to undo: ${undoTarget ? undoTarget.enabled !== false : "unknown"}`);

  if (before && after) {
    const region = gridRegion({
      bounds: before.bounds,
      from: { x: cx - radius, y: cy - radius },
      to: { x: cx + radius, y: cy + radius }
    });
    const changed = changedFraction(before.cells, after.cells, { region });
    console.log(`  pixels changed inside the circle's box: ${(changed * 100).toFixed(2)}% ` +
      `(threshold for "something was drawn" is ${(VISIBLE_CHANGE * 100).toFixed(2)}%)`);
    console.log(`  VERDICT: ${changed >= VISIBLE_CHANGE ? "DREW" : "NOTHING DREW"}`);
  } else {
    console.log("  pixels: could not capture the window, so this run proves nothing about what appeared");
  }

  // A second figure that lifts the pen: two strokes, one call.
  const strokes = [
    buildPath({ shape: "line", fromX: cx - 300, fromY: cy + radius + 60, toX: cx - 100, toY: cy + radius + 60 }),
    buildPath({ shape: "arc", cx: cx + 150, cy: cy + radius + 60, radius: 70, startDegrees: 180, sweepDegrees: 180 })
  ];
  const multi = await host.request("pointer.stroke", {
    windowId, pathsBase64: strokes.map((path) => encode(flattenPath(path))), button: "left", pacingMicros: 250
  }, { timeoutMs: 60000 });
  console.log("");
  console.log(`two strokes in one call: ${multi.strokes} strokes, ${multi.points} points, ${multi.durationMs}ms, ` +
    `accepted ${multi.injectedEvents}/${multi.requestedEvents}`);

  await host.request("pointer.up", { button: "left" });
  console.log("\nPaint has been left open with the drawing on screen; close it without saving.");
} catch (error) {
  console.error("LIVE DRAW PROBE FAILED:", error.message);
  try { await host.request("pointer.up", { button: "left" }); } catch { /* host already gone */ }
  process.exitCode = 1;
} finally {
  host.close();
}
