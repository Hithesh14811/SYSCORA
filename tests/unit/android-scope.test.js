// SIX ANDROID TOOLS IN THE SCHEMA OF A REQUEST THAT NEVER MENTIONED A PHONE.
//
// Measured live, 28 Aug 2026. The request was "search 10 internships based on my
// resume … and send those 10 internships with their links to amma on whatsapp".
// The agent's first three tool calls were `android_devices list`, then `wait`
// (20.0s), then `refresh` (22.4s) — 42 seconds of a desktop task spent looking
// for a phone, on a machine with the WhatsApp desktop app installed and open.
//
// It was not the model being stupid. `androidActive` was assigned `true` in
// beginTurn and assigned `false` in EXACTLY ZERO PLACES in the file, on a
// toolset that `_ensureToolset` builds ONCE PER PROCESS and shares across every
// conversation. The user's chat history contained "can you see my device?" and
// "can you control my phone?" — one of those flipped the switch, days earlier,
// and every request since had been carrying six Android schemas plus a
// system-prompt paragraph explaining how to use them.
//
// Three defects in one: a flag that only ever went one way, a pattern in which
// `device` — an ordinary English word — was a trigger, and unconditional prompt
// guidance for a toolbox the model should not have been given.
//
// A REAL ANDROID ADAPTER IS INJECTED HERE. Without one the registry never
// registers `android.device.list`, so the tools do not exist at all and every
// assertion below passes vacuously — which is exactly the shape of check this
// codebase keeps catching itself writing. The stub reports a device only when
// the test asks it to.
//
// Proven able to fail: restoring the one-way `state.androidActive = true` fails
// "a later unrelated turn does not inherit Android"; putting bare `device` back
// into the pattern fails "an ordinary sentence containing the word device".

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

function toolset({ devices = [] } = {}) {
  const adapter = new WindowsAdapter();
  adapter.hostRequest = async () => ({ performed: true });
  const androidAdapter = {
    isAvailable: async () => ({ available: true }),
    setupPlatformTools: async () => ({ performed: true }),
    listDevices: async () => ({ devices, count: devices.length }),
    waitForDevices: async () => ({ devices, count: devices.length, waitedMs: 0 }),
    refreshDevices: async () => ({ devices, count: devices.length, waitedMs: 0 })
  };
  return buildToolset({
    registry: createDefaultCapabilityRegistry(adapter, { androidAdapter }),
    adapter
  });
}

const androidToolCount = (kit) =>
  kit.definitions.filter((definition) => (definition.function?.name ?? "").startsWith("android_")).length;

test("the Android tools really do exist in this fixture", () => {
  // Guards every other test in this file against passing vacuously.
  const kit = toolset();
  kit.beginTurn("mirror my android screen");
  assert.ok(androidToolCount(kit) > 0, "without this the rest of the file proves nothing");
});

test("an ordinary desktop request is offered no Android tools", () => {
  const kit = toolset();
  kit.beginTurn("search 10 internships and send them to amma on whatsapp");
  assert.equal(androidToolCount(kit), 0, "a request with no phone in it must not carry Android schemas");
  assert.equal(kit.androidGuidance(), "", "and must not be told how to use adb");
});

test("an ordinary sentence containing the word device is not a phone task", () => {
  // `device` is the term that actually fired on the real machine, and it is a
  // normal English word.
  for (const request of [
    "which audio device is my output set to",
    "the device is unreadable, try again",
    "how many devices does this monitor support"
  ]) {
    const kit = toolset();
    kit.beginTurn(request);
    assert.equal(androidToolCount(kit), 0, `"${request}" must not activate Android`);
  }
});

test("a request that really is about a phone gets the Android tools", () => {
  for (const request of [
    "mirror my android screen",
    "can you control my phone?",
    "run adb devices",
    "open instagram on my phone",
    "check the connected tablet"
  ]) {
    const kit = toolset();
    kit.beginTurn(request);
    assert.ok(androidToolCount(kit) > 0, `"${request}" should activate Android`);
    assert.match(kit.androidGuidance(), /android_devices/, "and should be told how to drive it");
  }
});

test("a later unrelated turn does not inherit Android from an earlier one", () => {
  // THE ACTUAL DEFECT. One toolset, many turns, many conversations, and no
  // device ever found.
  const kit = toolset({ devices: [] });
  kit.beginTurn("can you see my device?");
  assert.ok(androidToolCount(kit) > 0, "the phone turn itself is allowed the tools");

  kit.beginTurn("search 10 internships and send them to amma on whatsapp");
  assert.equal(
    androidToolCount(kit), 0,
    "a phone mentioned in an EARLIER turn must not put Android tools in this one"
  );
  assert.equal(kit.androidGuidance(), "", "nor adb instructions");
});

test("a phone that was actually seen keeps the tools for the follow-up", async () => {
  // The case the stickiness existed to serve, now keyed on EVIDENCE rather than
  // on somebody having said the word: after a real device is found, "now send
  // it" still finds the tools.
  const kit = toolset({ devices: [{ serial: "R58M123", state: "device" }] });
  kit.beginTurn("list my android devices");
  await kit.execute("android_devices", { operation: "list", saw: "asked for devices", say: "listing" });

  kit.beginTurn("now open instagram there");
  assert.ok(
    androidToolCount(kit) > 0,
    "a device that was really connected must stay reachable for the natural follow-up"
  );
});

test("a phone that was looked for and not found leaves nothing behind", async () => {
  // The safety-critical direction, and the one the live defect took.
  const kit = toolset({ devices: [] });
  kit.beginTurn("can you see my device?");
  await kit.execute("android_devices", { operation: "list", saw: "asked for devices", say: "listing" });

  kit.beginTurn("write a poem in notepad");
  assert.equal(
    androidToolCount(kit), 0,
    "a fruitless look for a phone must not arm the next conversation"
  );
});
