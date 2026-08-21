// PUTTING A FILE BACK.
//
// The journal proved itself on one case — a volume level — where "how to
// reverse it" is a number. A file is the first case where the reversal needs
// something SAVED, and that changes the shape: the backup has to exist before
// the write, or the entry is a promise the journal cannot keep.
//
// THE THREE CASES, AND ALL THREE ARE REAL:
//
//   the file existed and was copied      restore the copy
//   the file did not exist               delete it again; absence is a state
//                                        you can return something to
//   the file existed and could NOT be
//   copied (locked, unreadable, huge)    NEVER_REVERSIBLE, said AT THE TIME
//
// The third is why this file exists rather than a `fs.copyFile` call inline at
// the write site. `docs/trust-and-triggers.md`: an entry that is silent about
// being irreversible is worse than no entry, because it implies a coverage the
// journal does not have. The caller cannot decide that after the fact — by then
// the only copy is gone — so the decision is made here, before the write, and
// the reason is carried into the journal with it.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// A backup is only worth taking if it can be taken quickly and kept cheaply.
// Above this the honest answer is that we did not save a copy, which the user
// can act on, rather than a copy that made the write take a minute.
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

export function backupDirectory(stateDir) {
  return path.join(stateDir, "undo-backups");
}

/**
 * Take the copy that makes a write reversible, BEFORE the write.
 *
 * Returns a descriptor to hand to `journal.record()` — never throws, because a
 * failure to prepare an undo must not stop the user's actual work. It becomes
 * `{ reversal: null, why }`, which the journal accepts precisely so the
 * irreversible case can be stated rather than hidden.
 */
export async function prepareFileUndo(stateDir, filePath, { readFile = fs.readFile, stat = fs.stat } = {}) {
  const absolute = path.resolve(filePath);

  let size = null;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      return { reversal: null, why: `${absolute} is not a regular file, so there is nothing to copy.` };
    }
    size = info.size;
  } catch {
    // ABSENCE IS A STATE, AND IT IS REVERSIBLE.
    //
    // The obvious reading — "no file, so no backup, so no undo" — is wrong and
    // would make the commonest case (creating a new file) the one case undo
    // could not help with. Putting it back means deleting it again.
    return {
      reversal: { kind: "file", filePath: absolute, backupPath: null, existedBefore: false },
      why: null
    };
  }

  if (size > MAX_BACKUP_BYTES) {
    return {
      reversal: null,
      why: `${absolute} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${(MAX_BACKUP_BYTES / 1024 / 1024)} MB `
        + "copy limit, so no copy was taken and the old contents cannot be restored."
    };
  }

  let contents;
  try {
    contents = await readFile(absolute);
  } catch (error) {
    // Locked by another application, or permission denied. Said now, while it
    // is still true and still useful, rather than discovered at undo time.
    return {
      reversal: null,
      why: `${absolute} could not be copied before the write (${error?.code ?? error?.message ?? "unreadable"}), `
        + "so the old contents are gone.",
      existedBefore: true
    };
  }

  const backupPath = path.join(
    backupDirectory(stateDir),
    `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${path.extname(absolute) || ".bak"}`
  );
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, contents);
  } catch (error) {
    return {
      reversal: null,
      why: `a copy of ${absolute} could not be saved (${error?.code ?? error?.message ?? "write failed"}), `
        + "so the old contents cannot be restored.",
      existedBefore: true
    };
  }

  return {
    reversal: { kind: "file", filePath: absolute, backupPath, existedBefore: true, bytes: size },
    why: null
  };
}

/**
 * Carry out a file reversal and say what the FILESYSTEM says afterwards.
 *
 * Returns `{ restored, verdict, observed, actedVia, method }`. The two halves
 * are deliberately different code paths:
 *
 *   act    node's `fs.writeFile` / `fs.rm`, straight to disk
 *   check  the `filesystem.read` CAPABILITY, injected by the caller
 *
 * That is the inverse of the pairing `write_file` uses (capability writes, fs
 * reads back), which is the point — a bug living in either layer cannot hide in
 * both directions. `evidence()` refuses a receipt whose method equals its
 * actedVia, so the separation is enforced at construction, not just intended.
 *
 * THE VERDICT IS DECIDED HERE BECAUSE THIS IS WHERE THE KNOWLEDGE IS, and it
 * has three values rather than two. "The file came back wrong" and "the file
 * could not be read at all" are the same `restored: false` to a caller and must
 * not become the same sentence to a user: the first is the machine contradicting
 * us, the second is us losing sight of it. Unconfirmed is not failed.
 */
export async function restoreFile(reversal, { readBack }) {
  const { filePath, backupPath, existedBefore } = reversal;

  if (!existedBefore) {
    // Put it back to not existing. `force` so a file already gone is success,
    // not an error — the desired state is what matters, not who removed it.
    try {
      await fs.rm(filePath, { force: true });
    } catch (error) {
      // The layer reporting its OWN failure. evidence() allows method ===
      // actedVia only for REFUTED, and this is exactly that case: a capability
      // saying it did not work has nothing to gain by lying.
      return {
        restored: false, verdict: "REFUTED",
        observed: `${filePath} could not be removed (${error?.code ?? error?.message}), so it is still there`,
        actedVia: "fs.rm", method: "fs.rm"
      };
    }
    const after = await readBack(filePath);
    const gone = after == null;
    return {
      restored: gone,
      verdict: gone ? "CONFIRMED" : "REFUTED",
      observed: gone
        ? `${filePath} is gone, which is how it was before — it did not exist`
        : `${filePath} still reads back with ${after.length} characters after being removed`,
      actedVia: "fs.rm", method: "filesystem.read"
    };
  }

  let expected;
  try {
    expected = await fs.readFile(backupPath, "utf8");
  } catch (error) {
    // The backup is what the whole entry rested on. Losing it is COULD_NOT —
    // it should have been possible — and never NEVER_REVERSIBLE, which would
    // claim the journal knew all along.
    return {
      restored: false, verdict: "REFUTED",
      observed: `the saved copy at ${backupPath} could not be read (${error?.code ?? error?.message})`,
      actedVia: "fs.readFile", method: "fs.readFile"
    };
  }

  try {
    await fs.writeFile(filePath, expected, "utf8");
  } catch (error) {
    return {
      restored: false, verdict: "REFUTED",
      observed: `${filePath} could not be written back (${error?.code ?? error?.message})`,
      actedVia: "fs.writeFile", method: "fs.writeFile"
    };
  }

  // THE CHECK IS THE CONTENTS, NOT THE WRITE'S OPINION OF ITSELF. A byte count
  // matches on a file of the right length holding the wrong thing, which is the
  // defect class this codebase keeps finding; comparing the text is barely more
  // expensive and cannot pass that way.
  const after = await readBack(filePath);
  if (after == null) {
    return {
      restored: false, verdict: "UNCONFIRMED",
      observed: `${filePath} was written back from the saved copy, but could not be read again to check it`,
      actedVia: "fs.writeFile", method: "filesystem.read"
    };
  }
  const same = after === expected;
  return {
    restored: same,
    verdict: same ? "CONFIRMED" : "REFUTED",
    observed: same
      ? `${filePath} reads back as the ${expected.length} characters it held before the change`
      : `${filePath} reads back as ${after.length} characters, which is not the ${expected.length} saved`,
    actedVia: "fs.writeFile", method: "filesystem.read"
  };
}

/** A sentence for the journal entry, so the user sees what would come back. */
export function describeFileChange(filePath, reversal) {
  if (!reversal) return `wrote ${filePath}`;
  return reversal.existedBefore
    ? `${filePath} → replaced what was in it (${reversal.bytes} bytes saved)`
    : `${filePath} → created it`;
}
