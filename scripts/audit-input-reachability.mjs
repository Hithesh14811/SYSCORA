// Is the new input engine the one that actually runs?
//
// This codebase has repeatedly built something correct and left it unreachable —
// a capability registered under a name nothing calls, a tool the model is never
// offered, a host operation with no caller. So this asks the question from the
// outside: build the REAL toolset over the REAL registry with the REAL adapter,
// and check what a model would actually be handed and where each verb lands.
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { buildToolset } from "../packages/fast-agent/src/tools.js";

const calls = [];
const adapter = new WindowsAdapter();
// Intercept at the host boundary: whatever reaches here is what reaches Windows.
adapter.hostRequest = async (operation, params) => {
  calls.push({ operation, params });
  if (operation === "window.enumerate") {
    return { windows: [{ windowId: "7", processName: "mspaint", title: "Paint", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, foreground: true }] };
  }
  if (operation === "window.resolve") {
    return { window: { windowId: "7", processName: "mspaint", bounds: { x: 0, y: 0, width: 1920, height: 1080 } } };
  }
  if (operation === "ui.inspect") return { elements: [{ name: "Undo", enabled: false }] };
  return { performed: true, x: params?.x, y: params?.y, points: 10, injectedEvents: 10, requestedEvents: 10, strokes: 1, durationMs: 5 };
};

const registry = createDefaultCapabilityRegistry(adapter);
const toolset = buildToolset({ registry, adapter });

const names = toolset.definitions.map((d) => d.function?.name ?? d.name);
console.log("Tools the model is offered:");
console.log("  " + names.join(", "));
console.log("");

const expect = (label, ok, detail = "") => console.log(`${ok ? "  OK  " : "  FAIL"} ${label}${detail ? `  ${detail}` : ""}`);

console.log("REACHABILITY");
expect("`draw` is in the model's toolset", names.includes("draw"));
expect("`drag` is in the model's toolset", names.includes("drag"));
expect("`pointer.stroke` is a registered capability", Boolean(registry.get("pointer.stroke")));
expect("`pointer.clickAt` is a registered capability", Boolean(registry.get("pointer.clickAt")));
console.log("");

console.log("WHERE EACH VERB ACTUALLY LANDS");
const track = async (label, fn) => {
  calls.length = 0;
  try { await fn(); } catch (error) { console.log(`  FAIL ${label}: ${error.message}`); return; }
  const ops = calls.map((c) => c.operation);
  const stroke = calls.find((c) => c.operation === "pointer.stroke");
  console.log(`  ${label.padEnd(34)} -> ${ops.join(", ") || "(nothing reached the host)"}`);
  if (stroke) {
    const encoded = stroke.params.pathsBase64 ?? [];
    const points = encoded.reduce((total, e) => total + Buffer.from(e, "base64").length / 8, 0);
    console.log(`  ${"".padEnd(34)}    ${encoded.length} path(s), ${points} points, pacing ${stroke.params.pacingMicros}us, base64 transport`);
  }
};

await track("draw circle", () => toolset.execute("draw", { shape: "circle", cx: 500, cy: 500, radius: 120, application: "mspaint" }));
await track("draw two strokes", () => toolset.execute("draw", {
  strokes: [{ shape: "line", fromX: 10, fromY: 10, toX: 90, toY: 10 }, { shape: "line", fromX: 10, fromY: 40, toX: 90, toY: 40 }],
  application: "mspaint"
}));
await track("drag", () => toolset.execute("drag", { fromX: 100, fromY: 100, toX: 400, toY: 400, application: "mspaint" }));
await track("click", () => toolset.execute("click", { x: 300, y: 300, application: "mspaint" }));
await track("double click", () => toolset.execute("click", { x: 300, y: 300, doubleClick: true, application: "mspaint" }));
await track("scroll", () => toolset.execute("scroll", { notches: -3, application: "mspaint" }));
await track("move_mouse", () => toolset.execute("move_mouse", { x: 12, y: 34 }));
await track("type", () => toolset.execute("type", { text: "a{b}c+d", application: "mspaint" }));
await track("key", () => toolset.execute("key", { keys: "ctrl+s", application: "mspaint" }));

console.log("");
console.log("DOUBLE CLICK IS ONE HOST CALL, NOT TWO");
calls.length = 0;
await toolset.execute("click", { x: 5, y: 5, doubleClick: true, application: "mspaint" });
const clicks = calls.filter((c) => c.operation === "pointer.click");
expect("one pointer.click carrying clicks:2", clicks.length === 1 && clicks[0].params.clicks === 2,
  `(${clicks.length} call(s), clicks=${clicks[0]?.params.clicks})`);

console.log("");
console.log("A KEY PRESS CARRIES THE CHORD SPELLING");
calls.length = 0;
await toolset.execute("key", { keys: "ctrl+shift+escape", application: "mspaint" });
const press = calls.find((c) => c.operation === "keyboard.press");
expect("chord travels alongside SendKeys notation", press?.params.chord === "ctrl+shift+escape",
  `chord=${JSON.stringify(press?.params.chord)} keys=${JSON.stringify(press?.params.keys)}`);
