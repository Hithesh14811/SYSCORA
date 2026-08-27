import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import { CdpBrowserAdapter } from "../../os-adapters/browser/src/cdp-browser-adapter.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { requiresClickConfirmation } from "../../packages/policy-engine/src/shell-rules.js";

test("Spotify waits for the Play control beside the requested row without a model-visible retry", async () => {
  const requests = [];
  const target = {
    targetId: "play-baby",
    source: "UIA",
    windowId: "1234",
    name: "Play",
    controlType: "ControlType.DataItem",
    boundingRect: { x: 900, y: 300, width: 48, height: 48 }
  };
  const adapter = new WindowsAdapter({
    automationHost: {
      async request(operation, params) {
        requests.push({ operation, params });
        if (operation === "ui.find") return { found: false, reason: "target-not-found" };
        if (operation === "ui.wait") return {
          matched: true,
          elapsedMs: 84,
          eventWakeups: 1,
          target
        };
        if (operation === "ui.invoke") return { performed: false, reason: "no-invoke-pattern" };
        if (operation === "pointer.click") return { performed: true, method: "SendInput", x: 924, y: 324 };
        throw new Error(`unexpected operation ${operation}`);
      }
    },
    browserAutomation: {}
  });
  adapter.runPowerShell = async () => { throw new Error("the legacy process-isolated matcher must not run"); };

  const result = await adapter._invokeSpotifyPlayButton("Baby Justin Bieber", 1000, 1234);

  assert.equal(result.invoked, true);
  assert.equal(result.name, "Play");
  assert.deepEqual(requests.map(({ operation }) => operation), ["ui.find", "ui.find", "ui.wait", "ui.invoke", "pointer.click"]);
  const wait = requests.find(({ operation }) => operation === "ui.wait");
  assert.equal(wait.params.selector.nearText, "baby justin bieber");
  assert.equal(wait.params.selector.minimumCoverage, 0.5);
  assert.deepEqual(wait.params.selector.controlTypes, ["Button", "DataItem", "ListItem", "Hyperlink"]);
});

test("Spotify search has no fixed settle delay before its grounded activation", async () => {
  const adapter = new WindowsAdapter({ automationHost: { request: async () => ({}) }, browserAutomation: {} });
  adapter.launchApplication = async () => ({ launch: { started: true } });
  adapter.waitForApplicationWindow = async () => ({ ready: true, window: { WindowHandle: 1234 } });
  adapter.openSpotifySearch = async () => ({ launch: { opened: true } });
  adapter._invokeSpotifyPlayButton = async () => ({ found: true, invoked: true, name: "Play Baby" });
  adapter.waitForUiTarget = async () => ({ matched: true, elapsedMs: 1, eventWakeups: 1 });
  adapter.readSpotifyPlayback = async () => ({ playing: true, nowPlaying: "Baby by Justin Bieber" });

  const started = Date.now();
  const result = await adapter.playSpotifyTrack("Baby Justin Bieber", { searchSettleMs: 6000 });

  assert.equal(result.playback.playing, true);
  assert.ok(Date.now() - started < 200, "a deprecated settle option must not reintroduce a blind multi-second sleep");
});

test("a persistent-host Spotify miss returns without starting the legacy PowerShell matcher", async () => {
  const requests = [];
  const adapter = new WindowsAdapter({
    automationHost: {
      async request(operation) {
        requests.push(operation);
        if (operation === "ui.find") return { found: false, reason: "target-not-found" };
        if (operation === "ui.wait") return { matched: false, reason: "ui-wait-timeout", elapsedMs: 40 };
        throw new Error(`unexpected operation ${operation}`);
      }
    },
    browserAutomation: {}
  });
  adapter.runPowerShell = async () => { throw new Error("legacy matcher must not start after a host miss"); };

  const result = await adapter._invokeSpotifyPlayButton("Baby", 6000, 1234);

  assert.equal(result.invoked, false);
  assert.equal(result.reason, "matching-track-not-found");
  assert.deepEqual(requests, ["ui.find", "ui.find", "ui.wait"]);
});

test("near and role resolve duplicate desktop labels in one click without an extra UI scan", async () => {
  const clicked = [];
  const elements = [
    { role: "button", text: "Play", clickable: true, bounds: { x: 800, y: 700, width: 50, height: 40 } },
    { role: "text", text: "Baby", clickable: false, bounds: { x: 580, y: 300, width: 180, height: 40 } },
    { role: "dataitem", text: "Play", clickable: true, bounds: { x: 900, y: 300, width: 50, height: 40 } }
  ];
  const capabilities = {
    "screen.read": async () => ({
      read: true,
      windowId: "9",
      application: "Spotify",
      title: "Spotify",
      visibleText: "Baby",
      elements
    }),
    "pointer.clickAt": async (inputs) => {
      clicked.push(inputs);
      return { performed: true, x: inputs.x, y: inputs.y };
    }
  };
  const adapter = {
    focusedElement: async () => null,
    invokeControl: async () => ({ performed: false, reason: "not-a-button" }),
    waitForUiDelta: async () => { throw new Error("click must not add a post-action tree scan"); }
  };
  const registry = { get: (name) => capabilities[name] ? { execute: capabilities[name] } : null };
  const toolset = buildToolset({ registry, adapter, basePath: "C:\\work" });

  await toolset.execute("screen", { application: "Spotify" });
  const result = await toolset.execute("click", { text: "Play", near: "Baby", role: "dataitem" });

  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].x, 925);
  assert.equal(clicked[0].y, 320);
  assert.equal(result.raw.label, "Play");
  assert.doesNotMatch(result.text, /interface changed immediately/i);
});

test("Share opens an intermediate menu; the actual Send boundary still asks", () => {
  assert.equal(requiresClickConfirmation("Share").confirm, false);
  assert.equal(requiresClickConfirmation("Send").confirm, true);
  assert.equal(requiresClickConfirmation("Publish").confirm, true);
});

test("browser state-change wait returns on the first observed mutation", async () => {
  const adapter = new CdpBrowserAdapter();
  let reads = 0;
  adapter.currentState = async () => {
    reads += 1;
    return {
      url: "https://example.com/",
      title: "Example",
      readyState: "complete",
      uiVersion: reads > 1 ? 1 : 0
    };
  };

  const result = await adapter.wait({
    condition: "state.change",
    value: JSON.stringify({
      url: "https://example.com/",
      title: "Example",
      readyState: "complete",
      uiVersion: 0
    }),
    timeoutMs: 1000
  });

  assert.equal(result.matched, true);
  assert.equal(result.state.uiVersion, 1);
  assert.equal(reads, 2);
});

test("a URL requested in Brave is bound to Brave instead of the default browser", async () => {
  const adapter = new WindowsAdapter({ automationHost: false, browserAutomation: {} });
  let script = "";
  adapter.resolveApplicationTarget = async () => ({
    resolved: true,
    kind: "app-path",
    target: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  });
  adapter.runPowerShell = async (value) => {
    script = value;
    return { exitCode: 0, stdout: JSON.stringify({ opened: true, processId: 42 }), stderr: "" };
  };

  const result = await adapter.openUrlInApplication("https://www.youtube.com/watch?v=abc", "Brave");

  assert.equal(result.opened, true);
  assert.equal(result.processId, 42);
  assert.match(script, /brave\.exe/);
  assert.match(script, /youtube\.com\/watch\?v=abc/);
});

test("the Windows host absorbs transient clipboard contention locally", () => {
  const host = fs.readFileSync(new URL("../../os-adapters/windows-host/restore-host.ps1", import.meta.url), "utf8");
  assert.match(host, /function Invoke-ClipboardWithRetry/);
  assert.match(host, /for \(\$attempt=0; \$attempt -lt 6; \$attempt\+\+\)/);
  assert.match(host, /"clipboard\.read" \{ return Invoke-ClipboardWithRetry 'read' \}/);
  assert.match(host, /"clipboard\.write" \{ return Invoke-ClipboardWithRetry 'write'/);
});
