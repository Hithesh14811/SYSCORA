// Electron preload bridge. Runs in an isolated context (contextIsolation:true)
// before the renderer's own scripts. It reads the API token that the main
// process passed as a command-line argument and exposes ONLY that token to the
// page via contextBridge — the token travels main → renderer entirely
// in-process and is never sent over HTTP or embedded in served HTML.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

function readTokenArg() {
  const prefix = "--syscora-token=";
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

// WHERE THE ATTACHED FILE ACTUALLY IS.
//
// SYSCORA drives this machine, so a folder dropped on the composer is not a bag
// of bytes to be uploaded — it is a PLACE, and the agent already has tools that
// read, list and search places. A browser deliberately hides that: a File gives
// its name and `webkitRelativePath` and nothing that could locate it on disk, so
// without this the agent is handed "Documents/report.docx" and cannot find the
// folder it was just given.
//
// `webUtils.getPathForFile` is the sanctioned way back to the real path, and it
// is safe to expose because it answers only about files the USER chose in a
// picker or dropped on the window — it cannot be asked about a path nobody
// selected. In a plain browser this is simply absent and the composer falls back
// to sending a listing.
contextBridge.exposeInMainWorld("syscora", {
  apiToken: readTokenArg(),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  updates: Object.freeze({
    check: () => ipcRenderer.invoke("syscora:update-check"),
    download: () => ipcRenderer.invoke("syscora:update-download"),
    install: () => ipcRenderer.invoke("syscora:update-install"),
    onStatus: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, status) => listener(status);
      ipcRenderer.on("syscora:update-status", handler);
      return () => ipcRenderer.removeListener("syscora:update-status", handler);
    }
  }),
  openLegal: (documentName) => ipcRenderer.invoke("syscora:open-legal", documentName),

  // THE OVERLAY, AND THE CHAT, AND THE ONE RUN THEY BOTH FOLLOW.
  //
  // Both surfaces are ordinary renderers loaded from the same daemon, so neither
  // can resize a window, sit above other applications, or hand a session to the
  // other. All three are the main process's to do, and this is the only way to
  // ask. Every method is a request — nothing here changes anything by itself.
  //
  // Exposed to BOTH pages because the bridge is per-preload, not per-window, and
  // the chat needs `collapse` and `onAttachSession` exactly as the overlay needs
  // `expand` and `resize`. A page that never calls its half simply does not.
  overlay: Object.freeze({
    // Overlay → main: show the chat window on this run. The session id travels
    // with it because the chat has to attach to a run that is ALREADY going —
    // see the note on `attachToSession` in demo.js.
    expand: (sessionId) => ipcRenderer.invoke("syscora:overlay-expand", sessionId ?? null),
    // Chat → main: put the chat away and bring the pill back.
    collapse: () => ipcRenderer.invoke("syscora:overlay-collapse"),
    // HIDE, NEVER CLOSE. `window.close()` from the renderer DESTROYS the
    // BrowserWindow, and the shortcut that is supposed to bring the pill back
    // holds a reference to a window that no longer exists — so Escape would
    // remove SYSCORA from the machine until it was restarted. Hiding keeps the
    // window, the typed text and the running task.
    hide: () => ipcRenderer.invoke("syscora:overlay-hide"),
    // Which accelerator actually registered. Null when every candidate was
    // already taken by something else on this machine.
    shortcut: () => ipcRenderer.invoke("syscora:overlay-shortcut"),
    // The overlay window is sized to its content: one pill, or a pill with a
    // stack of running tools above it. The renderer is the only thing that knows
    // how tall that is.
    resize: (height) => ipcRenderer.invoke("syscora:overlay-resize", height),
    // A TRANSPARENT WINDOW STILL SWALLOWS CLICKS, and this one floats over every
    // other application. Outside the pill it must be as if it were not there —
    // see setIgnoreMouseEvents in main.js.
    setInteractive: (interactive) => ipcRenderer.invoke("syscora:overlay-interactive", interactive === true),
    // MOVED BY DRAGGING THE PILL, AND THE ANSWER IS ABSOLUTE EVERY TIME.
    //
    // Not `-webkit-app-region: drag`: that CSS makes the element undraggable AND
    // untypable, and a text box you cannot put the caret in is not a text box.
    // And not a running sum of deltas either — see the note in main.js on why
    // that could never have worked. `dragStart` records where the window is,
    // then every `dragMove` carries the TOTAL offset from the pointer's starting
    // position, so each message is independently correct.
    dragStart: () => ipcRenderer.invoke("syscora:overlay-drag-start"),
    dragMove: (dx, dy) => ipcRenderer.invoke("syscora:overlay-drag-move", { dx, dy }),
    dragEnd: () => ipcRenderer.invoke("syscora:overlay-drag-end"),
    // Main → chat: a run is already in flight, attach to it.
    onAttachSession: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, sessionId) => listener(sessionId);
      ipcRenderer.on("syscora:attach-session", handler);
      return () => ipcRenderer.removeListener("syscora:attach-session", handler);
    },
    // Main → overlay: the chat was collapsed or hidden, so the pill is live
    // again and should take focus.
    onRevealed: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = () => listener();
      ipcRenderer.on("syscora:overlay-revealed", handler);
      return () => ipcRenderer.removeListener("syscora:overlay-revealed", handler);
    }
  })
});
