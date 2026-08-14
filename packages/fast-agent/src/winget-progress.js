// Where winget's install has actually got to.
//
// The obvious way to draw a progress bar for `winget install` is to read the
// progress bar winget prints. That does not work, and it is worth writing down
// why so nobody spends an afternoon on it again: winget only draws its bar when
// its output is a console. Run through a pipe — which is how anything that
// captures output runs it — and the bar is suppressed entirely. The whole
// captured output of a 180 MB install is five lines:
//
//   Found Canva [Canva.Canva] Version 1.123.1
//   Downloading https://desktop-release.canva.com/Canva%20Setup%201.123.1.exe
//   Successfully verified installer hash
//   Starting package install...
//   Successfully installed
//
// Forty seconds pass between lines two and three and nothing says so. Giving the
// child a real console instead would mean a pseudo-terminal, which is a native
// dependency, and it would still only recover numbers that are available another
// way.
//
// Because those five lines do contain the two facts that matter. The URL is
// printed before the download starts, so one HEAD request gives the exact total.
// And winget writes the installer into a known directory under TEMP, so the
// bytes on disk are the bytes downloaded. Polling that file against that total
// is a real measurement of the real download — not an estimate, and not winget's
// own bar recovered by a trick.
//
// Nothing here invents a number. No URL, or a server that will not answer a HEAD
// with a length, means the total is unknown, and an unknown total is reported as
// unknown so the bar runs indeterminate rather than lying about how far along it
// is.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The directory winget downloads into, named in its own diagnostic log:
// "Downloading to path: C:\Users\<user>\AppData\Local\Temp\WinGet\<file>".
const WINGET_TEMP = path.join(os.tmpdir(), "WinGet");

// The lines winget DOES print through a pipe, which is what makes this possible.
const DOWNLOADING = /^\s*Downloading\s+(\S+)\s*$/im;
const VERIFYING = /Successfully verified installer hash|Verifying installer hash/i;
const INSTALLING = /Starting package install|Starting package (?:upgrade|uninstall)/i;

export function isWingetInstall(command) {
  return /(^|[\s;|])winget\s+(install|upgrade|download|add)\b/i.test(String(command ?? ""));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

// Total bytes for the URL winget just said it was fetching. A HEAD is the
// cheapest question that answers it, and it is the same URL and the same server
// the download is already going to.
async function contentLength(url, { signal } = {}) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal });
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

async function sizesIn(directory) {
  const sizes = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return sizes;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        for (const [nested, size] of await sizesIn(full)) sizes.set(nested, size);
      } else {
        sizes.set(full, (await fs.stat(full)).size);
      }
    } catch {
      // A file winget is mid-way through replacing is not an error; the next
      // poll will see it.
    }
  }
  return sizes;
}

/**
 * Watch one `winget install` and report where it has got to.
 *
 * @param {object} options
 * @param {(progress: {percent: number|null, label: string, phase: string}) => void} options.onProgress
 * @returns {{note: (chunk: string) => void, stop: () => void}}
 *   `note` takes winget's own output as it arrives; `stop` must be called when
 *   the command exits, or the poll outlives it.
 */
export function createWingetWatcher({
  onProgress,
  tempDir = WINGET_TEMP,
  intervalMs = 500,
  readDirectory = sizesIn,
  measure = contentLength
} = {}) {
  let phase = null;
  let total = null;
  let timer = null;
  let stopped = false;
  let lastPercent = null;
  let lastBytes = null;
  // What was already in the directory before this install started. Leftovers
  // from an earlier download must not be counted as this one's progress.
  let baseline = new Map();
  const baselineReady = readDirectory(tempDir).then((sizes) => { baseline = sizes; }).catch(() => {});

  const report = (progress) => {
    if (stopped) return;
    try { onProgress(progress); } catch { /* watching must not break the install */ }
  };

  const setPhase = (next) => {
    if (phase === next) return;
    phase = next;
    lastPercent = null;
    lastBytes = null;
    report({ percent: null, label: "", phase });
  };

  const poll = async () => {
    await baselineReady;
    if (stopped) return;
    const sizes = await readDirectory(tempDir);
    // The file this install is writing: the one that is new, or that has grown
    // since we started. The largest such file is the installer; anything else in
    // there is a manifest or an index.
    let downloaded = 0;
    for (const [file, size] of sizes) {
      const before = baseline.get(file);
      const grown = before == null ? size : size - before;
      if (grown > downloaded) downloaded = grown;
    }
    if (downloaded <= 0) return;
    if (total) {
      const percent = Math.max(0, Math.min(99, Math.round((downloaded / total) * 100)));
      // Only when it moved. A bar redrawn at the same number is noise on the
      // same channel the model's own words travel on.
      if (percent === lastPercent) return;
      lastPercent = percent;
      report({ percent, label: `${formatBytes(downloaded)} of ${formatBytes(total)}`, phase: phase ?? "Downloading" });
      return;
    }
    // No total. Say the bytes, which are measured, and leave the percentage
    // unknown, which it is.
    if (lastBytes != null && downloaded - lastBytes < 256 * 1024) return;
    lastBytes = downloaded;
    report({ percent: null, label: `${formatBytes(downloaded)} downloaded`, phase: phase ?? "Downloading" });
  };

  return {
    note(chunk) {
      const text = String(chunk ?? "");
      if (!text) return;
      // Order matters: the later phases win, because one chunk can carry the end
      // of the download and the start of the install together.
      const url = DOWNLOADING.exec(text)?.[1];
      if (url && /^https?:\/\//i.test(url)) {
        setPhase("Downloading");
        if (!timer) timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
        measure(url).then((length) => { if (length && !total) total = length; }).catch(() => {});
      }
      if (VERIFYING.test(text)) {
        if (timer) { clearInterval(timer); timer = null; }
        if (total) report({ percent: 100, label: `${formatBytes(total)} downloaded`, phase: "Downloading" });
        setPhase("Verifying");
      }
      if (INSTALLING.test(text)) {
        if (timer) { clearInterval(timer); timer = null; }
        setPhase("Installing");
      }
    },
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    }
  };
}
