import fs from "node:fs";
import path from "node:path";

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolve every existing component of a path through symlinks, junctions and
 * Windows reparse points. A not-yet-created leaf is reconstructed beneath the
 * nearest existing real parent, which is the boundary that matters for a write.
 */
export function canonicalizePath(candidate, { allowMissing = true } = {}) {
  const raw = String(candidate ?? "").trim();
  if (!raw) throw new TypeError("A non-empty filesystem path is required.");

  const resolved = path.resolve(raw);
  try {
    return path.resolve(fs.realpathSync.native(resolved));
  } catch (error) {
    if (!allowMissing) throw error;
  }

  const missing = [];
  let existing = resolved;
  for (;;) {
    try {
      const realParent = fs.realpathSync.native(existing);
      return path.resolve(realParent, ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`No existing parent could be resolved for ${resolved}.`);
      }
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * A containment decision made on real paths rather than lexical strings.
 * Existing roots are required so a misspelled or removed workspace cannot
 * silently become a new authority boundary.
 */
export function isCanonicalPathInside(candidate, root, { allowMissingCandidate = true } = {}) {
  try {
    const canonicalRoot = canonicalizePath(root, { allowMissing: false });
    const canonicalCandidate = canonicalizePath(candidate, { allowMissing: allowMissingCandidate });
    const relative = path.relative(comparable(canonicalRoot), comparable(canonicalCandidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function isCanonicalPathInsideAny(candidate, roots, options) {
  return Array.isArray(roots) && roots.some((root) => isCanonicalPathInside(candidate, root, options));
}

