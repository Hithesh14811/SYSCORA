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
    stdio: "ignore",
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
  if (daemonProcess) {
    try {
      daemonProcess.kill();
    } catch {}
  }
  app.quit();
});

