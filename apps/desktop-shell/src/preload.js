// Electron preload bridge. Runs in an isolated context (contextIsolation:true)
// before the renderer's own scripts. It reads the API token that the main
// process passed as a command-line argument and exposes ONLY that token to the
// page via contextBridge — the token travels main → renderer entirely
// in-process and is never sent over HTTP or embedded in served HTML.
const { contextBridge } = require("electron");

function readTokenArg() {
  const prefix = "--syscora-token=";
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

contextBridge.exposeInMainWorld("syscora", {
  apiToken: readTokenArg()
});
