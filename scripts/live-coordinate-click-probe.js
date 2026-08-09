// Live proof that a coordinate produced by SYSCORA's current screen reading can
// be used to click the exact intended control and that the resulting UI state is
// independently observable. Calculator is used because pressing 7 is harmless
// and gives an unambiguous visible postcondition.

import { spawn } from "node:child_process";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter, {});
const before = await adapter.listWindows().catch(() => []);
const priorPids = new Set(before.map((window) => window.Id ?? window.processId).filter(Boolean));
let launchedPid = null;

function textOf(element) {
  return String(element?.text ?? element?.name ?? element?.value ?? "").trim();
}

try {
  await adapter.automationHost?.warm?.();
  const launch = await adapter.launchApplication("calculator");
  if (!launch?.window) throw new Error(`Calculator did not produce a grounded window (${launch?.grounding?.readinessState ?? "unknown"})`);
  launchedPid = launch.window.Id ?? launch.window.processId ?? null;
  // Packaged Windows apps expose both an ApplicationFrameHost top-level window
  // and a CoreWindow owned by the app. Launch correlation correctly identifies
  // the app process, while UI Automation may expose its actionable descendants
  // only through the frame. Try every live Calculator window and act only after
  // one of them independently grounds the requested button.
  const liveCandidates = (await adapter.listWindows())
    .filter((window) => /calculator/i.test(`${window.ProcessName ?? ""} ${window.MainWindowTitle ?? ""}`))
    .sort((left, right) =>
      Number(right.Bounds?.width ?? 0) * Number(right.Bounds?.height ?? 0) -
      Number(left.Bounds?.width ?? 0) * Number(left.Bounds?.height ?? 0));
  const uniqueCandidates = [...new Map(
    [launch.window, ...liveCandidates].map((window) => [String(window.WindowHandle ?? window.windowId), window])
  ).values()];
  let windowId = null;
  let reading = null;
  let seven = null;
  for (const candidate of uniqueCandidates) {
    const candidateId = String(candidate.WindowHandle ?? candidate.windowId);
    const candidateReading = await registry.get("screen.read").execute({ windowId: candidateId, maxElements: 400 });
    const candidateSeven = (candidateReading?.elements ?? [])
      .filter((element) => Number.isFinite(element?.center?.x) && Number.isFinite(element?.center?.y))
      .map((element) => ({ element, label: textOf(element) }))
      .sort((left, right) => {
        const score = ({ element, label }) =>
          (/^seven$/i.test(label) ? 30 : /^7$/.test(label) ? 20 : /seven|num7/i.test(`${label} ${element.automationId ?? ""}`) ? 10 : 0) +
          (element.source === "UIA" ? 3 : 0);
        return score(right) - score(left);
      })[0];
    const found = candidateSeven && (/^7$|^seven$/i.test(candidateSeven.label) || /seven|num7/i.test(`${candidateSeven.label} ${candidateSeven.element.automationId ?? ""}`));
    if (found) {
      windowId = candidateId;
      reading = candidateReading;
      seven = candidateSeven;
      break;
    }
  }
  if (!seven) {
    const labels = uniqueCandidates.map((candidate) =>
      `${candidate.ProcessName}/${candidate.WindowHandle}: ${candidate.MainWindowTitle}`
    ).join("; ");
    throw new Error(`The 7 button was not grounded in any Calculator window. Candidates: ${labels}`);
  }

  const { x, y } = seven.element.center;
  const click = await registry.get("pointer.clickAt").execute({ windowId, x, y });
  if (click?.performed !== true) throw new Error(`Coordinate click was not delivered: ${click?.reason ?? "unknown"}`);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await registry.get("screen.read").execute({ windowId, maxElements: 400 });
  const visible = `${after?.visibleText ?? ""} ${(after?.elements ?? []).map(textOf).join(" ")}`;
  const displayShowsSeven = (after?.elements ?? []).some((element) => {
    const label = textOf(element);
    const semantics = `${element.controlType ?? ""} ${element.automationId ?? ""} ${element.name ?? ""}`;
    return /^7$/.test(label) && /text|display|result|name/i.test(semantics);
  }) || /\b7\b/.test(visible);
  if (!displayShowsSeven) throw new Error("The click landed, but Calculator did not visibly show 7 afterwards");

  console.log(`PASS exact coordinate click: grounded "${seven.label}" at ${x},${y}, clicked it, and independently observed 7 in Calculator.`);
} finally {
  // Only stop a process that did not exist before this probe. Never close a
  // Calculator (or shared application host) that belonged to the user.
  if (launchedPid && !priorPids.has(launchedPid)) {
    await new Promise((resolve) => {
      const child = spawn("taskkill", ["/PID", String(launchedPid), "/T", "/F"], { stdio: "ignore", shell: false });
      child.on("close", resolve);
      child.on("error", resolve);
    });
  }
  adapter.close();
}
