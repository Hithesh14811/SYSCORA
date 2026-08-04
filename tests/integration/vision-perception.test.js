import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import { VisionProvider } from "../../packages/perception/src/vision-provider.js";
import { PerceptionEngine, EntityType } from "../../packages/perception/src/index.js";
import { SemanticState } from "../../packages/semantic-state/src/index.js";

const onWindows = process.platform === "win32";

test("real known-window capture is OCR/UIA-normalized and persisted", {
  skip: onWindows ? false : "Windows-only visual perception test",
  timeout: 45_000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-vision-integration-"));
  const marker = "SYSCORA VISION PROOF 12345";
  const windowTitle = `SYSCORA Vision Fixture ${Date.now()}`;
  const adapter = new WindowsAdapter();
  const fixtureScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$form=New-Object System.Windows.Forms.Form",
    `$form.Text='${windowTitle}'`,
    "$form.Width=720",
    "$form.Height=260",
    "$form.BackColor=[Drawing.Color]::White",
    "$label=New-Object System.Windows.Forms.Label",
    `$label.Text='${marker}'`,
    "$label.AutoSize=$true",
    "$label.Location=New-Object Drawing.Point(35,70)",
    "$label.Font=New-Object Drawing.Font('Arial',26,[Drawing.FontStyle]::Bold)",
    "$form.Controls.Add($label)",
    "$form.StartPosition='CenterScreen'",
    "$form.TopMost=$true",
    "[void]$form.ShowDialog()"
  ].join(";");
  const fixtureProcess = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-Command", fixtureScript
  ], { stdio: "ignore", windowsHide: false });
  const semanticState = new SemanticState(path.join(root, "semantic"));
  const registry = { isAvailable: (name) => ["screen.capture", "ocr.read", "ui.inspect"].includes(name) };
  const vision = new VisionProvider(adapter, { capabilityRegistry: registry, ttlMs: 1_500 });
  const engine = new PerceptionEngine({ semanticState, providers: [vision] });

  try {
    let fixtureWindow = null;
    const deadline = Date.now() + 8_000;
    while (!fixtureWindow && Date.now() < deadline) {
      const windows = await adapter.listWindows();
      fixtureWindow = windows.find((candidate) =>
        String(candidate.MainWindowTitle ?? candidate.title ?? "") === windowTitle
      ) ?? null;
      if (!fixtureWindow) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fixtureWindow, "the controlled visual fixture produced a grounded window");

    const captured = await engine.captureVisionSnapshot({
      groundedWindow: fixtureWindow,
      windowId: String(fixtureWindow.WindowHandle ?? fixtureWindow.windowId),
      application: fixtureWindow.ProcessName ?? fixtureWindow.processName
    }, { force: true });
    assert.ok(captured.snapshot, "a real screen snapshot was captured");
    assert.ok(captured.snapshot.elements.length > 0, "the snapshot has visual/accessibility elements");
    assert.match(captured.snapshot.pixelHash ?? "", /^[a-f0-9]{64}$/, "captured pixels have a durable fingerprint");
    assert.match(captured.snapshot.ocrText, /SYSCORA\s+VISION\s+PROOF\s+12345/i, "Windows OCR read the known pixel text");
    const searchable = `${captured.snapshot.title} ${captured.snapshot.ocrText} ${captured.snapshot.elements.map((element) => element.text).join(" ")}`;
    assert.match(searchable, /SYSCORA Vision Fixture/i);

    const persistedSnapshots = await semanticState.queryEntities({ type: EntityType.ScreenSnapshot });
    const persistedElements = await semanticState.queryEntities({ type: EntityType.ScreenElement });
    assert.equal(persistedSnapshots.length, 1);
    assert.ok(persistedElements.length > 0);
    assert.equal(persistedSnapshots[0].properties.snapshotId, captured.snapshot.snapshotId);
    const plannerSubgraph = await engine.getRelevantSubgraph({
      rawText: "inspect the visible SYSCORA vision fixture",
      category: "APPLICATION"
    }, { budget: 25 });
    assert.ok(
      plannerSubgraph.entities.some((entity) => entity.type === EntityType.ScreenSnapshot),
      "the model planner can query the persisted visual snapshot"
    );
  } finally {
    try { fixtureProcess.kill(); } catch { /* already exited */ }
    adapter.automationHost?.close?.();
    await semanticState.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
