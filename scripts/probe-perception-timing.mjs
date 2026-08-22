// Where the seconds go when the agent looks at the screen.
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const time = async (label, fn) => {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(`${label.padEnd(18)} ${String(Date.now() - startedAt).padStart(6)}ms ${Array.isArray(result) ? `(${result.length})` : ""}`);
    return result;
  } catch (error) {
    console.log(`${label.padEnd(18)} ${String(Date.now() - startedAt).padStart(6)}ms FAILED ${error.message}`);
    return null;
  }
};

await time("host warm", () => adapter.automationHost?.warm?.());
await time("listWindows #1", () => adapter.listWindows());
const windows = await time("listWindows #2", () => adapter.listWindows());
const foreground = windows?.find((window) => window.Foreground ?? window.foreground) ?? windows?.[0];
console.log(`foreground: ${foreground?.ProcessName} ${foreground?.WindowHandle}`);
const windowId = String(foreground.WindowHandle);
const capture = await time("captureScreen", () => adapter.captureScreen({ windowId }));
await time("readOcr", () => adapter.readOcr({ path: capture.path, windowId }));
await time("inspectUi", () => adapter.inspectUi({ windowId, maxElements: 240 }));
await time("executeCommand", () => adapter.executeCommand(process.cwd(), "echo hi"));
adapter.close();
process.exit(0);
