// W2.1 — undo for files.
//
// The journal was proven on one case, a volume level, where "how to reverse it"
// is a number. A file is the first reversal that needs something SAVED, and the
// saving has to happen before the write or the entry is a promise the journal
// cannot keep.
//
// WHAT THESE WOULD FAIL ON, stated because a check whose failure mode is
// unstated is the defect this codebase keeps finding:
//   - a backup taken AFTER the write (it would copy the new contents, and the
//     restore would be a no-op that reports success)
//   - an overwritten file with no backup reported as reversible, or reported as
//     irreversible only when someone asks rather than at the time
//   - `undo` reporting REVERSED when the filesystem says otherwise — including
//     when the restore itself lied about having worked
//   - "could not read it back" collapsed into "it came back wrong"
//   - creating a file being treated as irreversible because there was nothing
//     to copy; absence is a state you can return something to
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareFileUndo, restoreFile, describeFileChange, backupDirectory, MAX_BACKUP_BYTES
} from "../../packages/fast-agent/src/undo-files.js";
import { createUndoJournal, Reversal } from "../../packages/fast-agent/src/undo-journal.js";

const root = () => fs.mkdtemp(path.join(os.tmpdir(), "syscora-undo-"));
// The caller injects the read-back. In the product it is the `filesystem.read`
// CAPABILITY, deliberately a different code path from the `fs` write that acts.
const readBack = async (file) => {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
};

test("an existing file is copied BEFORE the write, and the copy holds the OLD contents", async () => {
  const dir = await root();
  const target = path.join(dir, "notes.txt");
  await fs.writeFile(target, "the original", "utf8");

  const undo = await prepareFileUndo(dir, target);
  assert.equal(undo.why, null);
  assert.equal(undo.reversal.existedBefore, true);

  // The write happens AFTER preparing, as it does in the tool.
  await fs.writeFile(target, "the replacement", "utf8");

  // This is the assertion that catches a backup taken in the wrong order: if
  // the copy were made after the write it would say "the replacement" here and
  // every later step would still pass.
  assert.equal(await fs.readFile(undo.reversal.backupPath, "utf8"), "the original");

  const outcome = await restoreFile(undo.reversal, { readBack });
  assert.equal(outcome.restored, true);
  assert.equal(outcome.verdict, "CONFIRMED");
  assert.equal(await fs.readFile(target, "utf8"), "the original");
});

test("creating a file IS reversible — absence is a state", async () => {
  const dir = await root();
  const target = path.join(dir, "new.txt");

  const undo = await prepareFileUndo(dir, target);
  assert.equal(undo.why, null, "a file that does not exist must not be reported as irreversible");
  assert.equal(undo.reversal.existedBefore, false);
  assert.equal(undo.reversal.backupPath, null);

  await fs.writeFile(target, "brand new", "utf8");
  const outcome = await restoreFile(undo.reversal, { readBack });
  assert.equal(outcome.restored, true);
  assert.equal(outcome.verdict, "CONFIRMED");
  await assert.rejects(() => fs.readFile(target), "the file should be gone again");
});

test("a file too big to copy is NEVER_REVERSIBLE, and says so AT THE TIME", async () => {
  const dir = await root();
  const target = path.join(dir, "huge.bin");
  await fs.writeFile(target, "x", "utf8");

  // Lie about the size rather than write 32 MB to a temp dir on the user's
  // machine — the branch under test is the size decision, not the disk.
  const undo = await prepareFileUndo(dir, target, {
    stat: async () => ({ isFile: () => true, size: MAX_BACKUP_BYTES + 1 })
  });
  assert.equal(undo.reversal, null);
  assert.match(undo.why, /over the .* MB copy limit/);
  assert.match(undo.why, /cannot be restored/);

  // The journal must ACCEPT that and carry the reason. record() throws when
  // given neither a reversal nor a why, which is what stops a caller quietly
  // implying coverage it does not have.
  const journal = createUndoJournal();
  const id = journal.record({ tool: "write_file", summary: "huge.bin", reversal: null, why: undo.why });
  journal.settle(id, { verdict: "CONFIRMED" });
  const entry = journal.last();
  assert.equal(entry.reversal, null);
  assert.match(entry.why, /cannot be restored/);
});

test("a file that cannot be read is NEVER_REVERSIBLE, not silently reversible", async () => {
  const dir = await root();
  const target = path.join(dir, "locked.txt");
  await fs.writeFile(target, "held open by something else", "utf8");

  const undo = await prepareFileUndo(dir, target, {
    readFile: async () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); }
  });
  assert.equal(undo.reversal, null);
  assert.match(undo.why, /EBUSY/);
  assert.match(undo.why, /the old contents are gone/);
});

test("preparing an undo NEVER throws — it must not stop the user's actual work", async () => {
  const dir = await root();
  // A path that cannot be statted, read, or backed up under any circumstances.
  const impossible = path.join(dir, "no", "such", "dir", "file.txt");
  const undo = await prepareFileUndo(dir, impossible);
  assert.ok(undo.reversal || undo.why, "must return one or the other, never throw");
});

test("UNDO FAILS WHEN THE RESTORE LIES ABOUT HAVING WORKED", async () => {
  const dir = await root();
  const target = path.join(dir, "notes.txt");
  await fs.writeFile(target, "the original", "utf8");
  const undo = await prepareFileUndo(dir, target);
  await fs.writeFile(target, "the replacement", "utf8");

  // The restore runs and reports nothing wrong; the read-back is what decides.
  // This is the whole reason the two halves are different code paths — if undo
  // trusted fs.writeFile's silence it would report REVERSED here.
  const outcome = await restoreFile(undo.reversal, {
    readBack: async () => "something else entirely"
  });
  assert.equal(outcome.restored, false);
  assert.equal(outcome.verdict, "REFUTED");
  assert.match(outcome.observed, /which is not the/);
});

test("could-not-read-back is UNCONFIRMED, not REFUTED — unconfirmed is not failed", async () => {
  const dir = await root();
  const target = path.join(dir, "notes.txt");
  await fs.writeFile(target, "the original", "utf8");
  const undo = await prepareFileUndo(dir, target);
  await fs.writeFile(target, "the replacement", "utf8");

  const outcome = await restoreFile(undo.reversal, { readBack: async () => null });
  assert.equal(outcome.verdict, "UNCONFIRMED");
  assert.equal(outcome.restored, false);
  assert.match(outcome.observed, /could not be read again/);
});

test("a lost backup is COULD_NOT, and its receipt does not verify itself against nothing", async () => {
  const dir = await root();
  const target = path.join(dir, "notes.txt");
  await fs.writeFile(target, "the original", "utf8");
  const undo = await prepareFileUndo(dir, target);
  await fs.rm(undo.reversal.backupPath);

  const outcome = await restoreFile(undo.reversal, { readBack });
  assert.equal(outcome.restored, false);
  assert.equal(outcome.verdict, "REFUTED");
  assert.match(outcome.observed, /saved copy .* could not be read/);
});

test("the acting path and the checking path are never the same when the check ran", async () => {
  const dir = await root();
  const existing = path.join(dir, "a.txt");
  await fs.writeFile(existing, "old", "utf8");
  const created = path.join(dir, "b.txt");

  for (const target of [existing, created]) {
    const undo = await prepareFileUndo(dir, target);
    await fs.writeFile(target, "new", "utf8");
    const outcome = await restoreFile(undo.reversal, { readBack });
    // evidence() throws on method === actedVia for anything but REFUTED, so a
    // reversal that verified itself could never build a receipt. Asserted here
    // too, because that constructor is one layer away from this decision.
    assert.notEqual(outcome.method, outcome.actedVia,
      `${target}: a reversal confirmed by the thing that performed it is not confirmed`);
  }
});

test("backups go to the state directory, not next to the user's file", async () => {
  const dir = await root();
  const workspace = await root();
  const target = path.join(workspace, "report.txt");
  await fs.writeFile(target, "contents", "utf8");

  const undo = await prepareFileUndo(dir, target);
  assert.ok(undo.reversal.backupPath.startsWith(backupDirectory(dir)),
    "a .bak beside the user's file is litter they did not ask for");
  const strays = await fs.readdir(workspace);
  assert.deepEqual(strays, ["report.txt"], "nothing extra may appear in the user's folder");
});

test("the journal's three outcomes stay three, end to end", async () => {
  const dir = await root();
  const journal = createUndoJournal();

  // NEVER_REVERSIBLE — recorded with a reason, no reversal.
  const a = journal.record({ tool: "write_file", summary: "huge", reversal: null, why: "too big to copy" });
  journal.settle(a, { verdict: "CONFIRMED" });
  assert.equal(journal.last().reversal, null);
  journal.close(a, Reversal.NEVER_REVERSIBLE);

  // REVERSED — a real file, put back.
  const target = path.join(dir, "f.txt");
  await fs.writeFile(target, "before", "utf8");
  const undo = await prepareFileUndo(dir, target);
  const b = journal.record({
    tool: "write_file", summary: describeFileChange(target, undo.reversal),
    reversal: undo.reversal, why: undo.why
  });
  journal.settle(b, { verdict: "CONFIRMED" });
  await fs.writeFile(target, "after", "utf8");
  assert.equal((await restoreFile(journal.last().reversal, { readBack })).restored, true);
  journal.close(b, Reversal.REVERSED);

  // A reversed entry is not offered again — but an IRREVERSIBLE one still is,
  // and that is deliberate: the honest answer to "undo that" is often "that one
  // cannot be undone, and here is why", which the caller cannot say if last()
  // hides it. So what surfaces now is the huge-file entry, not nothing.
  const surfaced = journal.last();
  assert.equal(surfaced.id, a, "the reversed entry must not be offered twice; the irreversible one must still show");
  assert.equal(surfaced.reversal, null);
  assert.match(surfaced.why, /too big to copy/);

  const outcomes = journal.all().map((entry) => entry.outcome);
  assert.deepEqual(outcomes, [Reversal.NEVER_REVERSIBLE, Reversal.REVERSED]);
  assert.equal(journal.reversibleCount(), 0, "nothing is left that could still be put back");
});

test("a REFUTED write abandons its entry — there is nothing to put back", async () => {
  const dir = await root();
  const target = path.join(dir, "f.txt");
  await fs.writeFile(target, "before", "utf8");
  const journal = createUndoJournal();
  const undo = await prepareFileUndo(dir, target);
  const id = journal.record({
    tool: "write_file", summary: "f.txt", reversal: undo.reversal, why: undo.why
  });
  // The write reported REFUTED: the file does not hold what was written.
  journal.settle(id, { verdict: "REFUTED" });
  assert.equal(journal.last(), null, "an action that did not happen must not be offered for undo");
  assert.equal(journal.reversibleCount(), 0);
});

test("describeFileChange says which of the two things happened", async () => {
  const dir = await root();
  const target = path.join(dir, "f.txt");
  assert.match(describeFileChange(target, (await prepareFileUndo(dir, target)).reversal), /created it/);
  await fs.writeFile(target, "x", "utf8");
  assert.match(describeFileChange(target, (await prepareFileUndo(dir, target)).reversal), /replaced what was in it/);
});

// THE INTEGRATION DEFECT A MERGE CANNOT SEE.
//
// W2 wrote `stateDir: path.join(basePath, ".syscora")` when those were the same
// directory. W0 then moved working state out of the user's OneDrive folder, and
// the two branches touched different files — so git merged them cleanly and the
// result put every backup copy of every overwritten file back inside the synced
// tree, one .bak at a time, re-creating the defect that held two and a half
// cores for five sessions.
//
// This fails if anything hardcodes the state directory again instead of asking
// resolveStateDir. It is behavioural on purpose: asserting the source contains a
// particular call would pass on a call whose result is thrown away.
test("undo backups follow the resolved state directory, not the repository", async () => {
  const { buildToolset } = await import("../../packages/fast-agent/src/tools.js");
  const workspace = await root();
  const elsewhere = await root();
  const target = path.join(workspace, "notes.txt");
  await fs.writeFile(target, "the original", "utf8");

  const registry = {
    get: (name) => ({
      "filesystem.read": { execute: async ({ filePath }) => ({ contents: await fs.readFile(filePath, "utf8") }) },
      "filesystem.write": {
        execute: async ({ filePath, content }) => { await fs.writeFile(filePath, content, "utf8"); return { written: true }; }
      }
    }[name] ?? null)
  };
  const adapter = {
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    listWindows: async () => [], listProcessParents: async () => new Map(),
    inspectUi: async () => ({ elements: [] }), captureScreen: async () => ({ captured: false }),
    readOcr: async () => ({ text: "" }), getDocumentsPath: () => "C:\Docs",
    getDesktopPath: () => "C:\Desktop", getDownloadsPath: () => "C:\Downloads"
  };

  process.env.SYSCORA_STATE_DIR = elsewhere;
  try {
    const toolset = buildToolset({ registry, adapter, basePath: workspace });
    await toolset.execute("write_file", { path: target, contents: "clobbered", existing: "replace" });

    // The backup must be under the RESOLVED directory...
    const inElsewhere = await fs.readdir(backupDirectory(elsewhere)).catch(() => []);
    assert.equal(inElsewhere.length, 1, `expected the copy under ${elsewhere}, found ${inElsewhere.length}`);
    // ...and nothing may have appeared under the repository-relative one.
    const strays = await fs.readdir(path.join(workspace, ".syscora")).catch(() => null);
    assert.equal(strays, null, "a .syscora directory beside the user's files is the defect W0 removed");

    // And it still works end to end from there.
    const undone = await toolset.execute("undo", {});
    assert.equal(undone.raw.outcome, "REVERSED");
    assert.equal(await fs.readFile(target, "utf8"), "the original");
  } finally {
    delete process.env.SYSCORA_STATE_DIR;
  }
});
