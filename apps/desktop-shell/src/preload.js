// Electron preload bridge. Runs in an isolated context (contextIsolation:true)
// before the renderer's own scripts. It reads the API token that the main
// process passed as a command-line argument and exposes ONLY that token to the
// page via contextBridge — the token travels main → renderer entirely
// in-process and is never sent over HTTP or embedded in served HTML.
const { contextBridge, webUtils } = require("electron");

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
  }
});
