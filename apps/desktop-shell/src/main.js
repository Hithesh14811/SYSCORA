import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let daemonProcess = null;
let daemonFailure = null;
let daemonReady = false;
const { autoUpdater } = electronUpdater;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function recordStartupFailure(error) {
  const message = String(error?.stack ?? error?.message ?? error)
    .replace(/((?:bearer\s+|api[_-]?key\s*[=:]\s*))\S+/gi, "$1[REDACTED]")
    .slice(0, 16_000);
  try {
    const directory = process.env.SYSCORA_STATE_DIR || path.join(app.getPath("userData"), "state");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "startup-errors.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch { /* startup reporting must never hide the original error */ }
  return message;
}

async function waitForDaemon(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemonFailure) throw new Error(daemonFailure);
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

  if (app.isPackaged && !env.SYSCORA_STATE_DIR) {
    env.SYSCORA_STATE_DIR = path.join(app.getPath("userData"), "state");
  }

  // In development Electron reports the entrypoint directory here
  // (apps/desktop-shell/src), not the repository root. The packaged app uses
  // app.asar, which does contain the full application tree.
  const applicationRoot = app.isPackaged
    ? app.getAppPath()
    : path.resolve(__dirname, "../../..");
  const daemonEntry = path.join(applicationRoot, "apps", "daemon", "src", "server.js");
  // app.getAppPath() is the source directory in development and app.asar in a
  // package. An asar is a readable module container but not a valid OS working
  // directory, so packaged children start beside it in resources.
  const daemonCwd = app.isPackaged ? path.dirname(applicationRoot) : applicationRoot;
  daemonFailure = null;
  daemonReady = false;
  let daemonStderr = "";

  // Preserve TLS verification while using certificates trusted by Windows,
  // including an organization’s inspected-network root certificate.
  daemonProcess = spawn(process.execPath, ["--use-system-ca", daemonEntry], {
    cwd: daemonCwd,
    env,
    // stdin is a PIPE, not "ignore", and that is the shutdown channel.
    // Windows gives a killed child no catchable signal, so closing this pipe is
    // how the daemon learns to stop its long-lived PowerShell host instead of
    // orphaning it. stdout/stderr stay ignored as before.
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true
  });

  daemonProcess.stderr?.setEncoding("utf8");
  daemonProcess.stderr?.on("data", (chunk) => {
    daemonStderr = `${daemonStderr}${String(chunk)}`.slice(-8_000);
  });
  daemonProcess.on("exit", (code, signal) => {
    if (!daemonReady) {
      const detail = daemonStderr.trim().replace(/((?:bearer\s+|api[_-]?key\s*[=:]\s*))\S+/gi, "$1[REDACTED]");
      daemonFailure = `SYSCORA's local daemon exited during startup (code ${code ?? "unknown"}${signal ? `, ${signal}` : ""}).` +
        (detail ? `\n${detail}` : "");
    }
    daemonProcess = null;
  });
  daemonProcess.on("error", (error) => {
    daemonFailure = `SYSCORA could not start its local daemon: ${error?.message ?? error}`;
    daemonProcess = null;
  });

  return { apiToken, port: Number(env.SYSCORA_PORT) };
}

function createWindow({ port, apiToken }) {
  const developerToolsAllowed = !app.isPackaged || process.env.SYSCORA_ENABLE_DEVTOOLS === "1";
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 520,
    title: "SYSCORA",
    icon: path.join(__dirname, "../../desktop/icon.ico"),
    // Nothing is painted for the first frame or two and the default is white, so
    // starting the window dark is the difference between opening an application
    // and watching one boot.
    backgroundColor: "#080a0f",
    // Shown once there is something to show. A window that appears empty and
    // then fills in reads as slow even when it is not.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: developerToolsAllowed,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.js"),
      // The token is handed to the preload as a launch argument, delivered
      // in-process to the renderer via contextBridge. It is never embedded in
      // the served HTML, so the unauthenticated GET / page stays credential-free.
      additionalArguments: [`--syscora-token=${apiToken}`]
    }
  });

  window.once("ready-to-show", () => window.show());
  // The chat renderer needs no camera, microphone, geolocation, notifications,
  // MIDI, USB, serial or clipboard permission from Chromium. Agent capabilities
  // live behind the authenticated daemon instead of browser permission prompts.
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  sendLinksToTheRealBrowser(window, port);
  window.loadURL(`http://127.0.0.1:${port}`);
  return window;
}

function setupAutoUpdates(window) {
  const send = (state, detail = {}) => {
    if (!window.isDestroyed()) window.webContents.send("syscora:update-status", { state, ...detail });
  };
  if (!app.isPackaged || process.env.SYSCORA_DISABLE_UPDATES === "1") {
    send("disabled", { reason: app.isPackaged ? "disabled-by-policy" : "development-build" });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on("checking-for-update", () => send("checking"));
  autoUpdater.on("update-not-available", (info) => send("current", { version: info?.version ?? app.getVersion() }));
  autoUpdater.on("update-available", (info) => send("available", { version: info?.version ?? null }));
  autoUpdater.on("download-progress", (progress) => send("downloading", { percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)) }));
  autoUpdater.on("update-downloaded", (info) => send("ready", { version: info?.version ?? null }));
  autoUpdater.on("error", (error) => send("error", { message: String(error?.message ?? error).slice(0, 300) }));

  ipcMain.handle("syscora:update-check", async () => {
    const result = await autoUpdater.checkForUpdates();
    return { available: result?.isUpdateAvailable === true, version: result?.updateInfo?.version ?? null };
  });
  ipcMain.handle("syscora:update-download", async () => {
    await autoUpdater.downloadUpdate();
    return { downloaded: true };
  });
  ipcMain.handle("syscora:update-install", () => {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { installing: true };
  });

  // Delay the first network request until onboarding and daemon startup have
  // settled, then check twice daily. A failed check is surfaced but never
  // affects normal agent work.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 12 * 60 * 60 * 1000).unref?.();
}

function setupLegalDocuments() {
  const documents = new Map([
    ["privacy", "PRIVACY.md"],
    ["terms", "TERMS.md"],
    ["security", "SECURITY.md"],
    ["support", "SUPPORT.md"]
  ]);
  ipcMain.handle("syscora:open-legal", async (_event, documentName) => {
    const filename = documents.get(documentName);
    if (!filename) throw new Error("Unknown legal document.");
    const root = app.isPackaged
      ? path.join(process.resourcesPath, "legal")
      : path.resolve(__dirname, "../../..");
    const result = await shell.openPath(path.join(root, filename));
    if (result) throw new Error(result);
    return { opened: true };
  });
}

// A LINK IN AN ANSWER HAS TO GO SOMEWHERE, AND IT MUST NOT BE HERE.
//
// The agent answers research questions with URLs, and the renderer turns them
// into real `<a target="_blank">` links — but nothing in this process had ever
// been told what to do with one, and the two defaults are both wrong:
//
//   * `target="_blank"` reaches Electron's window-open path, and a window opened
//     that way INHERITS this window's webPreferences — including the preload
//     that exposes the daemon's API token to the page. That would hand a
//     stranger's website a credential that drives this machine. It is the
//     reason this is a security fix and not a convenience one.
//   * a plain click navigates THIS window, so the chat surface is replaced by
//     the web page and the conversation is gone, with no back button on a
//     window that has no menu bar.
//
// Both now do the same thing: hand the URL to the browser the user actually
// uses, and leave the application where it was. Only http(s) — a `file:` link in
// an answer opening something on this machine with one click is not a thing this
// window should be able to do, and the agent has tools for that anyway.
function sendLinksToTheRealBrowser(window, port) {
  const isOurOwnPage = (url) => {
    try {
      const target = new URL(url);
      return target.hostname === "127.0.0.1" && target.port === String(port);
    } catch {
      return false;
    }
  };
  const openOutside = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => { /* no browser, nothing to do */ });
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isOurOwnPage(url)) return;
    event.preventDefault();
    openOutside(url);
  });
}

// NO MENU BAR. `File Edit View Window Help` above the conversation is Electron's
// default, not a decision, and it is the first thing that says "this is a web
// page in a wrapper" — no chat application on this desktop has one.
//
// It carries the reload and devtools accelerators, though, so they are put back
// explicitly: losing Ctrl+R while developing is a bad trade for a tidy window,
// and a user who presses F12 by accident gets nothing, which is correct.
function removeMenuBarKeepingItsShortcuts(window) {
  const developerToolsAllowed = !app.isPackaged || process.env.SYSCORA_ENABLE_DEVTOOLS === "1";
  Menu.setApplicationMenu(null);
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key ?? "").toLowerCase();
    if (developerToolsAllowed && (input.control || input.meta) && key === "r") {
      window.webContents.reload();
      event.preventDefault();
    }
    if (key === "f12" || ((input.control || input.meta) && input.shift && key === "i")) {
      if (developerToolsAllowed) window.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

app.whenReady().then(async () => {
  setupLegalDocuments();
  const daemon = startDaemon();
  await waitForDaemon(daemon.port);
  daemonReady = true;
  const window = createWindow(daemon);
  removeMenuBarKeepingItsShortcuts(window);
  setupAutoUpdates(window);
}).catch((error) => {
  const diagnostic = recordStartupFailure(error);
  console.error(diagnostic);
  dialog.showErrorBox("SYSCORA could not start", String(error?.message ?? error));
  app.quit();
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

