import { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
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
// Set once the app is genuinely going down, so the chat's close handler stops
// intercepting and hiding instead. Without it `app.quit()` is cancelled by the
// same `preventDefault` that makes the close button mean "collapse".
let quitting = false;
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

// THE PILL: WHAT SYSCORA IS WHEN IT IS NOT A CHAT WINDOW.
//
// Opening an agent that drives your whole desktop into a 1200x800 chat window is
// the wrong shape for what it does. Almost every request is one sentence — the
// measured median is four steps and eighteen seconds — and for that the surface
// should be a text box floating over whatever you are already working in, not an
// application you switch to.
//
// SO THERE ARE TWO WINDOWS AND ONE RUN. The pill and the chat are separate
// renderers, and they are not two conversations: a run lives in the DAEMON, which
// publishes it at `/api/intents/:id/stream` and replays every event to a late
// subscriber. So "expand" is not a handover of state, it is a second reader
// attaching to the same stream — which is why a task started in the pill can be
// watched, mid-flight, in the chat. See `attachToSession` in demo.js.
//
// Doing it the other way — one window that changes shape — was considered and
// rejected: `frame` and `transparent` are construction-time only in Electron, so
// a single window would have to be frameless ALWAYS, and the existing chat would
// lose its native title bar to a feature that is not about the chat.
const OVERLAY_WIDTH = 720;
const OVERLAY_MIN_HEIGHT = 92;
let overlayWindow = null;
let chatWindow = null;

function createOverlayWindow({ port, apiToken }) {
  const developerToolsAllowed = !app.isPackaged || process.env.SYSCORA_ENABLE_DEVTOOLS === "1";
  const overlay = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    // FRAMELESS AND TRANSPARENT, because the window is not the UI — the pill
    // drawn inside it is, and everything around that pill has to show the
    // desktop underneath.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    // It floats over full-screen applications too. "screen-saver" is the level
    // above ordinary always-on-top; below it, a maximised browser covers the one
    // control the user is trying to reach.
    alwaysOnTop: true,
    // Not a second entry in the taskbar or the Alt-Tab list. There is one
    // SYSCORA, and this is the part of it that is always there.
    skipTaskbar: true,
    // Taking focus on show would steal the caret from whatever the user is
    // typing in. It is shown by a shortcut and focused only when they ask.
    focusable: true,
    show: false,
    title: "SYSCORA",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: developerToolsAllowed,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--syscora-token=${apiToken}`]
    }
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  // Follow the user onto other virtual desktops. A control that exists only on
  // desktop 1 is one they have to go and find.
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // OUTSIDE THE PILL, THIS WINDOW IS NOT THERE.
  //
  // A transparent window still swallows every click that lands on it, and this
  // one is 720px wide and floats above everything — so without this it would
  // punch a dead rectangle through whatever is underneath. `forward: true` keeps
  // mouse MOVE events coming so the renderer can still see the pointer approach
  // the pill and ask for interactivity back.
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.session.setPermissionCheckHandler(() => false);
  overlay.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  overlay.webContents.on("will-attach-webview", (event) => event.preventDefault());
  sendLinksToTheRealBrowser(overlay, port);
  overlay.loadURL(`http://127.0.0.1:${port}/overlay.html`);
  overlay.once("ready-to-show", () => {
    positionOverlayNearBottom(overlay);
    overlay.show();
  });
  return overlay;
}

// Bottom centre, above the taskbar — where a command bar belongs and where it
// covers the least of what is usually being worked on. The user drags it
// wherever they like from there; this is only the first position.
function positionOverlayNearBottom(overlay) {
  try {
    const display = screen.getPrimaryDisplay();
    const area = display.workArea;
    const [width, height] = overlay.getSize();
    overlay.setPosition(
      Math.round(area.x + (area.width - width) / 2),
      Math.round(area.y + area.height - height - 72)
    );
  } catch { /* a default position is better than a failed start */ }
}

function showChatWindow(sessionId) {
  if (!chatWindow || chatWindow.isDestroyed()) return;
  // The session id goes first: the renderer has to be listening before it is
  // shown, or a run that settles quickly is attached to after it has finished.
  if (sessionId) chatWindow.webContents.send("syscora:attach-session", sessionId);
  chatWindow.show();
  chatWindow.focus();
  overlayWindow?.hide();
}

function showOverlayWindow({ focus = true } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.show();
  if (focus) overlayWindow.focus();
  overlayWindow.webContents.send("syscora:overlay-revealed");
}

function setupOverlayBridge() {
  ipcMain.handle("syscora:overlay-expand", (_event, sessionId) => {
    showChatWindow(typeof sessionId === "string" && sessionId ? sessionId : null);
    return true;
  });
  ipcMain.handle("syscora:overlay-collapse", () => {
    chatWindow?.hide();
    showOverlayWindow();
    return true;
  });
  // Escape, and anything else that means "not now". Hides; never destroys —
  // see the note on `hide` in the preload.
  // Which key actually took. The renderer shows it, because a shortcut nobody
  // can discover is a shortcut nobody uses — and which one it is depends on what
  // else on the machine had already claimed the others.
  ipcMain.handle("syscora:overlay-shortcut", () => overlayShortcut);
  ipcMain.handle("syscora:overlay-hide", () => {
    overlayWindow?.hide();
    return true;
  });
  ipcMain.handle("syscora:overlay-resize", (_event, height) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    const wanted = Math.round(Number(height));
    if (!Number.isFinite(wanted)) return false;
    // Bounded at both ends. A renderer bug that asks for 20,000px must not
    // produce a window taller than the screen, and one that asks for 0 must not
    // make the pill vanish with no way to get it back.
    const maxHeight = Math.max(OVERLAY_MIN_HEIGHT, screen.getPrimaryDisplay().workArea.height - 80);
    const clamped = Math.max(OVERLAY_MIN_HEIGHT, Math.min(maxHeight, wanted));
    const [x, y] = overlayWindow.getPosition();
    const [, current] = overlayWindow.getSize();
    if (current === clamped) return true;
    // GROWS UPWARDS. The pill is anchored to its BOTTOM edge, so a stack of
    // running tools appearing above it must not push the text box down the
    // screen and out from under the user's pointer.
    overlayWindow.setBounds({ x, y: y + (current - clamped), width: OVERLAY_WIDTH, height: clamped });
    return true;
  });
  ipcMain.handle("syscora:overlay-interactive", (_event, interactive) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return true;
  });
  // DRAGGING IS ABSOLUTE, NOT A SUM OF DELTAS.
  //
  // The first version sent one `moveBy(dx, dy)` per `pointermove` and added them
  // up here. It did not work, and it could not: each move is a separate async
  // `invoke`, the window is moving underneath the pointer while they are in
  // flight, and a single dropped or reordered message leaves the window
  // permanently offset from the cursor. Worse, the renderer computes the next
  // delta from a screen position it read BEFORE the previous move landed, so the
  // error compounds — which is exactly the "it just doesn't come" the user saw.
  //
  // Now the renderer says where the pointer STARTED and where it is NOW, and the
  // main process — which is the only thing that knows the true window position —
  // computes the answer from the origin it recorded at pointerdown. Every message
  // is independently correct, so losing one costs nothing and the next is still
  // right.
  let dragOrigin = null;
  ipcMain.handle("syscora:overlay-drag-start", () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    const [x, y] = overlayWindow.getPosition();
    dragOrigin = { x, y };
    return true;
  });
  ipcMain.handle("syscora:overlay-drag-move", (_event, delta) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !dragOrigin) return false;
    const dx = Math.round(Number(delta?.dx));
    const dy = Math.round(Number(delta?.dy));
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    // KEPT ON A SCREEN. A window dragged off the edge of the desktop cannot be
    // dragged back, and this one has no title bar for Windows to rescue it by.
    // A strip of it always stays reachable.
    const area = screen.getDisplayNearestPoint({ x: dragOrigin.x + dx, y: dragOrigin.y + dy }).workArea;
    const [width, height] = overlayWindow.getSize();
    const x = Math.min(Math.max(dragOrigin.x + dx, area.x - width + 120), area.x + area.width - 120);
    const y = Math.min(Math.max(dragOrigin.y + dy, area.y), area.y + area.height - 40);
    overlayWindow.setPosition(Math.round(x), Math.round(y));
    return true;
  });
  ipcMain.handle("syscora:overlay-drag-end", () => {
    dragOrigin = null;
    return true;
  });
}

// ONE KEY TO MAKE IT GO AWAY, AND THE SAME KEY TO BRING IT BACK.
//
// Registered globally, so it works while the user is in another application —
// which is the only time it matters, because that is where they are when the
// pill is in the way. Failure is not fatal: another application may already own
// the combination, and a shell that refuses to start over a hotkey clash would
// be worse than one without the hotkey.
// A LIST, NOT ONE KEY, BECAUSE A HOTKEY CLASH IS SILENT.
//
// `globalShortcut.register` returns false when another application already owns
// the combination — it does not throw, and nothing on screen says so. A single
// hard-coded accelerator therefore fails in exactly the way the user cannot
// diagnose: the key does nothing and there is no error anywhere.
//
// So it tries in order and keeps the first that takes. Ctrl+Shift+Space is the
// one to aim for (it is what most command bars use and Windows itself does not
// claim it); the rest are progressively less likely to be contested. Whichever
// wins is printed, because a shortcut nobody can discover is a shortcut nobody
// uses. `SYSCORA_OVERLAY_SHORTCUT` overrides the whole list.
const OVERLAY_SHORTCUTS = [
  "CommandOrControl+Shift+Space",
  "CommandOrControl+Alt+Space",
  "CommandOrControl+Shift+K",
  "Alt+Shift+S"
];

let overlayShortcut = null;

function registerOverlayShortcut() {
  const wanted = process.env.SYSCORA_OVERLAY_SHORTCUT
    ? [process.env.SYSCORA_OVERLAY_SHORTCUT]
    : OVERLAY_SHORTCUTS;
  const toggle = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else showOverlayWindow();
  };
  for (const accelerator of wanted) {
    try {
      if (globalShortcut.register(accelerator, toggle)) {
        overlayShortcut = accelerator;
        console.log(`SYSCORA overlay shortcut: ${accelerator}`);
        return accelerator;
      }
    } catch { /* an accelerator this build cannot parse is simply skipped */ }
  }
  // Not fatal. The pill is still reachable — it is on screen unless it has been
  // hidden, and Escape hides it — but the user needs to know the key is gone.
  console.warn(
    `SYSCORA could not register an overlay shortcut; every candidate is taken (${wanted.join(", ")}). ` +
    "Set SYSCORA_OVERLAY_SHORTCUT to one that is free."
  );
  return null;
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
  chatWindow = window;
  removeMenuBarKeepingItsShortcuts(window);
  setupAutoUpdates(window);

  // CLOSING THE CHAT PUTS IT AWAY; IT DOES NOT END THE SESSION.
  //
  // The chat is one of two views onto the same product and the pill is the other,
  // so its close button means "collapse", exactly as the collapse control does.
  // Destroying it would throw away the loaded conversation and every later expand
  // would pay a full page load. The app is quit from the pill, or from the tray
  // of the OS.
  window.on("close", (event) => {
    if (quitting || !overlayWindow || overlayWindow.isDestroyed()) return;
    event.preventDefault();
    window.hide();
    showOverlayWindow();
  });

  setupOverlayBridge();
  try {
    overlayWindow = createOverlayWindow(daemon);
    removeMenuBarKeepingItsShortcuts(overlayWindow);
    registerOverlayShortcut();
    // THE PILL IS WHAT OPENS, NOT THE CHAT. See createOverlayWindow.
    window.once("ready-to-show", () => window.hide());
  } catch (error) {
    // AND IF IT CANNOT, THE PRODUCT STILL OPENS. A failed overlay must degrade
    // to the surface that existed before it, not to a machine with nothing on
    // screen and a daemon running behind it.
    recordStartupFailure(error);
    overlayWindow = null;
    window.show();
  }
}).catch((error) => {
  const diagnostic = recordStartupFailure(error);
  console.error(diagnostic);
  dialog.showErrorBox("SYSCORA could not start", String(error?.message ?? error));
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  // A global accelerator outlives the window that registered it. Released here
  // so a restart can take it back rather than logging that somebody else holds
  // it — which, after one crash, would be this same application's ghost.
  try { globalShortcut.unregisterAll(); } catch { /* going down anyway */ }
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

