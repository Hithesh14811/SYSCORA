import test from "node:test";
import assert from "node:assert/strict";
import { correlateLaunchWindow, WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const window = (windowId, processId, processName, title, foreground = false) => ({
  WindowHandle: windowId,
  Id: processId,
  ProcessName: processName,
  MainWindowTitle: title,
  Foreground: foreground,
  Bounds: { x: 0, y: 0, width: 800, height: 600 }
});

test("grounds a delayed new window by launch PID despite title mismatch", () => {
  const result = correlateLaunchWindow({
    application: "Friendly Display Name",
    beforeWindows: [window(1, 10, "explorer", "Desktop", true)],
    afterWindows: [
      window(1, 10, "explorer", "Desktop"),
      window(2, 42, "oddhost", "Untitled", true)
    ],
    launch: { processId: 42 }
  });
  assert.equal(result.grounded, true);
  assert.equal(result.window.WindowHandle, 2);
  assert.ok(result.signals.includes("launched-pid"));
});

test("grounds Settings-style process/window mismatch using new HWND plus title identity", () => {
  const result = correlateLaunchWindow({
    application: "Windows Settings",
    beforeWindows: [window(1, 10, "explorer", "Desktop", true)],
    afterWindows: [
      window(1, 10, "explorer", "Desktop"),
      window(3, 99, "ApplicationFrameHost", "Windows Settings", true)
    ],
    launch: { processId: 77 }
  });
  assert.equal(result.grounded, true);
  assert.equal(result.window.ProcessName, "ApplicationFrameHost");
  assert.ok(result.signals.includes("title-similarity"));
});

test("grounds existing-instance activation without requiring a new HWND", () => {
  const existing = window(8, 88, "sampleapp", "Sample App");
  const result = correlateLaunchWindow({
    application: "Sample App",
    beforeWindows: [window(1, 10, "explorer", "Desktop", true), existing],
    afterWindows: [window(1, 10, "explorer", "Desktop"), { ...existing, Foreground: true }],
    launch: {}
  });
  assert.equal(result.grounded, true);
  assert.equal(result.window.WindowHandle, 8);
  assert.ok(result.signals.includes("foreground-transition"));
});

test("does not ground an unrelated unchanged window", () => {
  const result = correlateLaunchWindow({
    application: "Missing App",
    beforeWindows: [window(1, 10, "explorer", "Desktop", true)],
    afterWindows: [window(1, 10, "explorer", "Desktop", true)],
    launch: {}
  });
  assert.equal(result.grounded, false);
});

test("stale UIA target is refreshed and retried once before model recovery", async () => {
  const requests = [];
  const host = {
    async request(operation, params) {
      requests.push({ operation, params });
      if (operation === "ui.action" && requests.filter((request) => request.operation === "ui.action").length === 1) {
        return { performed: false, reason: "stale-target" };
      }
      if (operation === "ui.find") {
        return {
          found: true,
          target: {
            targetId: "fresh",
            source: "UIA",
            windowId: "20",
            automationId: "apply",
            name: "Apply",
            controlType: "ControlType.Button"
          }
        };
      }
      return { performed: true, method: "InvokePattern" };
    }
  };
  const adapter = new WindowsAdapter({ automationHost: host, browserAutomation: {} });
  const result = await adapter.performUiAction({
    application: "Example",
    target: {
      targetId: "stale",
      source: "UIA",
      windowId: "10",
      automationId: "apply",
      name: "Apply",
      controlType: "ControlType.Button"
    },
    action: "invoke"
  });
  assert.equal(result.performed, true);
  assert.equal(result.deterministicRecovery.succeeded, true);
  assert.deepEqual(requests.map((request) => request.operation), ["ui.action", "ui.find", "ui.action"]);
});
