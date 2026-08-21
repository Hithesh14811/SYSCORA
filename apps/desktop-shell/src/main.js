import { app, BrowserWindow } from "electron";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let daemonProcess = null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDaemon(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`SYSCORA daemon did not become ready on port ${port}.`);
}

function startDaemon() {
  const apiToken = process.env.SYSCORA_API_TOKEN ?? crypto.randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    SYSCORA_API_TOKEN: apiToken,
    SYSCORA_PORT: process.env.SYSCORA_PORT ?? "4317",
    // process.execPath is Electron itself. Run the daemon entrypoint as Node,
    // not as a second Electron application.
    ELECTRON_RUN_AS_NODE: "1"
  };

  const repoRoot = path.resolve(__dirname, "../../..");
  const daemonEntry = path.join(repoRoot, "apps", "daemon", "src", "server.js");

  // Preserve TLS verification while using certificates trusted by Windows,
  // including an organization’s inspected-network root certificate.
  daemonProcess = spawn(process.execPath, ["--use-system-ca", daemonEntry], {
    cwd: repoRoot,
    env,
    // stdin is a PIPE, not "ignore", and that is the shutdown channel.
    // Windows gives a killed child no catchable signal, so closing this pipe is
    // how the daemon learns to stop its long-lived PowerShell host instead of
    // orphaning it. stdout/stderr stay ignored as before.
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true
  });

  daemonProcess.on("exit", () => {
    daemonProcess = null;
  });

  return { apiToken, port: Number(env.SYSCORA_PORT) };
}

function createWindow({ port, apiToken }) {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "SYSCORA",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      // The token is handed to the preload as a launch argument, delivered
      // in-process to the renderer via contextBridge. It is never embedded in
      // the served HTML, so the unauthenticated GET / page stays credential-free.
      additionalArguments: [`--syscora-token=${apiToken}`]
    }
  });

  window.loadURL(`http://127.0.0.1:${port}`);
  return window;
}

app.whenReady().then(async () => {
  const daemon = startDaemon();
  await waitForDaemon(daemon.port);
  createWindow(daemon);
});

app.on("window-all-closed", () => {
  // `daemonProcess.kill()` alone is what orphaned a PowerShell host every time
  // the user closed this window. The default signal is SIGKILL-like on Windows
  // — the daemon dies without running any shutdown, so it never tells its
  // long-lived automation host to stop, and the host outlives its own parent.
  // 15 of them accumulated, 801 MB, oldest seven days.
  //
  // So: ask first, wait briefly, and only then insist. The daemon's SIGTERM
  // handler closes the automation host and exits.
  if (daemonProcess) {
    const child = daemonProcess;
    daemonProcess = null;
    let exited = false;
    child.once("exit", () => { exited = true; });
    try {
      // Close stdin FIRST. That is the one that actually reaches the daemon on
      // Windows; SIGTERM here is TerminateProcess and runs no cleanup at all,
      // which is why the host used to survive. Kept as the fallback below.
      child.stdin?.end();
    } catch { /* already gone */ }
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    // A daemon that will not go quietly must still not keep the app open, but
    // it gets long enough to stop its host first.
    setTimeout(() => {
      if (!exited) {
        try { child.kill(); } catch { /* already gone */ }
      }
      app.quit();
    }, 2_500);
    return;
  }
  app.quit();
});

