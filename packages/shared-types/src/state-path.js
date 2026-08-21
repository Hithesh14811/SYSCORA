import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * WHERE SYSCORA'S WORKING STATE LIVES.
 *
 * This module exists because of a measured defect, not for tidiness. The repo
 * sits at C:\Users\hithe\OneDrive\Documents\SYSCORA, and every path in the
 * codebase joined `.syscora` onto it — so 2.07 GB of databases, rewritten on
 * every agent turn, sat inside a OneDrive-synced folder. OneDrive does not read
 * .gitignore. Measured on an idle machine, OneDrive.Sync.Service plus OneDrive
 * held ~24% of a core continuously with nothing happening, and far more during
 * turns. The user asked this product twice why their machine felt slow.
 *
 * `.syscora/` also holds API keys in plaintext. Uploading it was never right.
 *
 * RESOLUTION ORDER, highest first:
 *
 *   1. SYSCORA_STATE_DIR — an absolute path. The override for tests, for
 *      probes, and for anyone running from an unusual place.
 *   2. <basePath>/.syscora-path — a one-line pointer FILE (not a directory)
 *      holding the real location. This is what redirects the installed product,
 *      and it is a file rather than an env var deliberately: an env var has to
 *      be set in every shell, every npm script, the Electron shell and the
 *      scheduled tasks, and the one place it is forgotten silently gets a
 *      SECOND, empty state directory — which looks exactly like data loss.
 *   3. <basePath>/.syscora — what every caller did before this module existed.
 *
 * Rule 3 is what keeps ~40 tests working unchanged: they pass their own temp
 * root as basePath, have no pointer file, and stay isolated from each other and
 * from the real installation. A machine-global default would have collided all
 * of them in one directory.
 */

export const STATE_POINTER_FILENAME = ".syscora-path";
export const LEGACY_STATE_DIRNAME = ".syscora";

/**
 * The default location for a fresh install: %LOCALAPPDATA%\SYSCORA on Windows,
 * ~/.local/state/syscora elsewhere. Not used unless something asks for it —
 * resolveStateDir never silently relocates an existing installation, because
 * moving a user's state without being asked is indistinguishable from losing it.
 */
export function defaultStateDir() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA
      ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "SYSCORA");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(base, "syscora");
}

/**
 * Read the pointer file, or null if there isn't a usable one.
 *
 * A pointer naming a path that does not exist is NOT silently ignored: that is
 * the shape of a half-finished migration, and falling back to the old directory
 * would quietly split the user's state across two places. It warns on stderr and
 * still falls back, matching how a malformed config.json is handled — refusing
 * to boot over one bad line is worse, but going quiet about it is what let a
 * mispasted API key take the whole product off its model with no symptom.
 */
export function readStatePointer(basePath) {
  const pointerFile = path.join(basePath, STATE_POINTER_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(pointerFile, "utf8");
  } catch {
    return null; // no pointer is the normal case, not an error
  }
  const target = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!target) {
    process.emitWarning(`${pointerFile} is empty; using ${LEGACY_STATE_DIRNAME} beside it.`);
    return null;
  }
  const resolved = path.isAbsolute(target) ? target : path.resolve(basePath, target);
  if (!fs.existsSync(resolved)) {
    process.emitWarning(
      `${pointerFile} points at ${resolved}, which does not exist. `
      + `Falling back to ${path.join(basePath, LEGACY_STATE_DIRNAME)} — `
      + "if a migration was interrupted, state is now split across two places."
    );
    return null;
  }
  return resolved;
}

/**
 * The one place `.syscora` is resolved. Every caller that used to write
 * `path.join(basePath, ".syscora")` calls this instead.
 */
export function resolveStateDir(basePath = process.cwd()) {
  const fromEnv = process.env.SYSCORA_STATE_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return readStatePointer(basePath) ?? path.join(basePath, LEGACY_STATE_DIRNAME);
}

/** A named file or directory inside the state directory. */
export function stateFile(basePath, ...segments) {
  return path.join(resolveStateDir(basePath), ...segments);
}

/**
 * Is this path inside a cloud-synced tree? Used to WARN, never to relocate.
 *
 * Deliberately shape-based rather than a list of vendor folder names: it looks
 * for a sync-root marker any of them leave behind, then falls back to the small
 * set of names that actually appear on Windows. A list of names alone is the
 * "guard that enumerates phrasings" mistake — one more vendor and it is wrong
 * again — but a marker check alone misses OneDrive Personal, which does not
 * always leave one.
 */
export function cloudSyncedRoot(target) {
  const markers = [".dropbox", ".dropbox.cache", "desktop.ini"];
  const names = ["onedrive", "dropbox", "google drive", "googledrive", "icloud drive", "box sync"];
  let dir = path.resolve(target);
  for (;;) {
    const base = path.basename(dir).toLowerCase();
    if (names.some((n) => base === n || base.startsWith(`${n} -`))) return dir;
    for (const marker of markers) {
      if (marker === "desktop.ini") continue; // too common to mean anything alone
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
