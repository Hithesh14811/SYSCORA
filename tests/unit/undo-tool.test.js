// PUTTING IT BACK, AND SAYING SO ONLY WHEN THE MACHINE AGREES.
//
// The motivating defect, verbatim: a session set this user's system volume to
// 42% and could not restore it, because nothing had recorded what it was before.
// So the first case here is exactly that — move the volume, undo, and require
// the endpoint to report the ORIGINAL level.
//
// The second thing these tests are for is the shape of the answer. "I put it
// back", "I tried and could not" and "this was never reversible" are three
// different sentences, and a tool that collapses them into two is lying in one
// of the three cases.

import test from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import nodeFs from "node:fs/promises";
import nodePath from "node:path";
import nodeOs from "node:os";

// An audio endpoint that remembers. `set` and `inspect` are separate functions
// on purpose: the tool must confirm through the getter, never through the
// setter's own report of itself, and one test below makes the setter lie to
// prove that is really what happens.
function endpoint({ startAt = 42, startMuted = false, readable = true } = {}) {
  const device = { percent: startAt, muted: startMuted };
  const seen = [];
  // Flipped by the test AFTER the first change, so the volume really does move
  // and then really does refuse to move back. Setting it false from the start
  // would mean the level never left where it began, and "restored" would be
  // true by accident — which is a different test that proves nothing.
  const control = { honest: true };
  return {
    device,
    seen,
    control,
    registry: {
      get: (name) => ({
        "system.volume.inspect": {
          execute: async () => (readable
            ? { available: true, percent: device.percent, muted: device.muted, peak: 0 }
            : { available: false })
        },
        "system.volume.set": {
          execute: async (inputs) => {
            seen.push(inputs);
            if (control.honest) {
              device.percent = Number(inputs.percent);
              if (inputs.mute != null) device.muted = Boolean(inputs.mute);
            }
            // Reports success either way. A dishonest endpoint is the whole
            // point of verifying through a different call.
            return { requestedPercent: Number(inputs.percent), percent: Number(inputs.percent), muted: Boolean(inputs.mute ?? device.muted), peak: 0, applied: true };
          }
        }
      }[name] ?? null)
    }
  };
}

const adapter = {
  executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  listWindows: async () => [],
  listProcessParents: async () => new Map(),
  inspectUi: async () => ({ elements: [] }),
  captureScreen: async () => ({ captured: false }),
  readOcr: async () => ({ text: "" }),
  getDocumentsPath: () => "C:\\Docs",
  getDesktopPath: () => "C:\\Desktop",
  getDownloadsPath: () => "C:\\Downloads"
};

const toolsetOver = (registry) => buildToolset({ registry, adapter, basePath: "C:\\work" });

test("the volume goes back to what it was, confirmed by reading the endpoint", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  assert.equal(audio.device.percent, 20, "precondition: the volume actually moved");

  const undone = await toolset.execute("undo", {});
  assert.equal(audio.device.percent, 42,
    "this is the defect that motivated the whole feature — 42% was where the user had it");
  assert.match(undone.text, /Put back/);
  assert.equal(undone.raw.outcome, "REVERSED");
  assert.equal(undone.raw.evidence.verdict, "CONFIRMED");
});

// THE CHECK THAT WOULD FAIL IF `undo` GRADED ITS OWN HOMEWORK.
//
// The setter returns `applied: true` and the device never moves. Every reversal
// in this system has to survive that, because "applied" reporting on itself is
// the exact claim this codebase has caught over and over.
test("a setter that claims success while the endpoint does not move is not a reversal", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  assert.equal(audio.device.percent, 20, "precondition: it really did move away from 42");
  // From here the endpoint accepts every request and changes nothing.
  audio.control.honest = false;

  const undone = await toolset.execute("undo", {});
  assert.equal(audio.device.percent, 20, "precondition: it really did not go back");

  assert.equal(undone.raw.outcome, "COULD_NOT");
  assert.equal(undone.raw.evidence.verdict, "REFUTED");
  assert.doesNotMatch(undone.text, /Put back/,
    "the endpoint never went back to 42, so no sentence may say it did");
  assert.match(undone.text, /could not put that back/i);
});

test("an action recorded as irreversible says why, and does not claim to have tried", async () => {
  // The endpoint cannot be read, so there is no previous level to return to.
  // The journal records that at the time rather than inventing a target.
  const audio = endpoint({ readable: false });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  const before = audio.seen.length;
  const undone = await toolset.execute("undo", {});

  assert.equal(undone.raw.outcome, "NEVER_REVERSIBLE");
  assert.match(undone.text, /cannot be undone/);
  assert.match(undone.text, /could not be read before the change/);
  assert.equal(audio.seen.length, before,
    "there was nothing to go back to, so it must not have set anything and then reported on it");
});

test("with nothing on the record it says so, rather than reporting a reversal", async () => {
  const toolset = toolsetOver(endpoint().registry);
  const undone = await toolset.execute("undo", {});
  assert.ok(undone.raw.nothingToUndo);
  assert.match(undone.text, /nothing on this session's record/);
});

test("undoing twice does not put the same change back twice", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  await toolset.execute("undo", {});
  const settings = audio.seen.length;
  const again = await toolset.execute("undo", {});

  assert.ok(again.raw.nothingToUndo,
    "the entry was closed as reversed; offering it again would re-apply a level that is already current");
  assert.equal(audio.seen.length, settings, "and it must not touch the endpoint to find that out");
});

test("the most recent change is the one put back", async () => {
  const audio = endpoint({ startAt: 42 });
  const toolset = toolsetOver(audio.registry);

  await toolset.execute("volume", { percent: 20 });
  await toolset.execute("volume", { percent: 70 });
  await toolset.execute("undo", {});

  assert.equal(audio.device.percent, 20,
    "undo reverses the last step, not the whole session — 20% was the state before the last change");
});

// ---------------------------------------------------------------------------
// W2.1 — the same three answers, for FILES.
//
// These drive the real `write_file` and `edit_file` tools rather than the undo
// helpers directly, because the helpers were green while the wiring was still
// missing — which is this project's most common defect by a distance. What they
// would fail on: a tool that does not journal at all, a backup taken after the
// write, or an `undo` that reports REVERSED without reading the file back.

const realFsRegistry = () => ({
  get: (name) => ({
    "filesystem.read": {
      execute: async ({ filePath }) => ({ contents: await nodeFs.readFile(filePath, "utf8") })
    },
    "filesystem.write": {
      execute: async ({ filePath, content }) => {
        await nodeFs.writeFile(filePath, content, "utf8");
        return { written: true };
      }
    }
  }[name] ?? null)
});

test("an overwritten file goes back to what it held, confirmed by reading it", async () => {
  const work = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "syscora-undotool-"));
  const target = nodePath.join(work, "notes.txt");
  await nodeFs.writeFile(target, "what the user wrote", "utf8");
  const toolset = buildToolset({ registry: realFsRegistry(), adapter, basePath: work });

  await toolset.execute("write_file", { path: target, contents: "what the agent wrote", existing: "replace" });
  assert.equal(await nodeFs.readFile(target, "utf8"), "what the agent wrote", "precondition: it really was overwritten");

  const undone = await toolset.execute("undo", {});
  assert.equal(await nodeFs.readFile(target, "utf8"), "what the user wrote",
    "the user's original contents are the whole point of the feature");
  assert.equal(undone.raw.outcome, "REVERSED");
  assert.equal(undone.raw.evidence.verdict, "CONFIRMED");
  assert.match(undone.text, /Put back/);
});

test("a file the agent created is removed again by undo", async () => {
  const work = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "syscora-undotool-"));
  const target = nodePath.join(work, "fresh.txt");
  const toolset = buildToolset({ registry: realFsRegistry(), adapter, basePath: work });

  await toolset.execute("write_file", { path: target, contents: "brand new" });
  assert.equal(await nodeFs.readFile(target, "utf8"), "brand new");

  const undone = await toolset.execute("undo", {});
  assert.equal(undone.raw.outcome, "REVERSED");
  await assert.rejects(() => nodeFs.readFile(target), "creating a file is reversible: absence is a state");
});

test("an edit goes back, and it is the file that says so", async () => {
  const work = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "syscora-undotool-"));
  const target = nodePath.join(work, "config.ini");
  await nodeFs.writeFile(target, "name=demo\nmode=slow\nretries=3\n", "utf8");
  const toolset = buildToolset({ registry: realFsRegistry(), adapter, basePath: work });

  await toolset.execute("edit_file", { path: target, old: "mode=slow", new: "mode=fast" });
  assert.match(await nodeFs.readFile(target, "utf8"), /mode=fast/, "precondition: the edit landed");

  const undone = await toolset.execute("undo", {});
  assert.equal(await nodeFs.readFile(target, "utf8"), "name=demo\nmode=slow\nretries=3\n");
  assert.equal(undone.raw.outcome, "REVERSED");
  assert.equal(undone.raw.evidence.verdict, "CONFIRMED");
});

// THE CHECK THAT WOULD FAIL IF `undo` GRADED ITS OWN HOMEWORK, FOR FILES.
//
// The read-back capability lies: it always returns the CURRENT text rather than
// what is on disk. So the restore runs, the filesystem disagrees, and undo must
// not say "Put back". This is the file twin of the dishonest-endpoint test above.
test("a restore contradicted by the file is not a reversal", async () => {
  const work = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "syscora-undotool-"));
  const target = nodePath.join(work, "notes.txt");
  await nodeFs.writeFile(target, "the original", "utf8");

  let lieOnRead = false;
  const registry = {
    get: (name) => ({
      "filesystem.read": {
        execute: async ({ filePath }) => (lieOnRead
          ? { contents: "not what is on disk" }
          : { contents: await nodeFs.readFile(filePath, "utf8") })
      },
      "filesystem.write": {
        execute: async ({ filePath, content }) => {
          await nodeFs.writeFile(filePath, content, "utf8");
          return { written: true };
        }
      }
    }[name] ?? null)
  };
  const toolset = buildToolset({ registry, adapter, basePath: work });
  await toolset.execute("write_file", { path: target, contents: "the replacement", existing: "replace" });
  lieOnRead = true;

  const undone = await toolset.execute("undo", {});
  assert.equal(undone.raw.outcome, "COULD_NOT");
  assert.equal(undone.raw.evidence.verdict, "REFUTED");
  assert.doesNotMatch(undone.text, /Put back/,
    "the read-back disagreed, so no sentence may claim the file was restored");
});

test("a write that was REFUTED leaves nothing to undo", async () => {
  const work = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "syscora-undotool-"));
  const target = nodePath.join(work, "notes.txt");
  await nodeFs.writeFile(target, "the original", "utf8");
  // The write silently does nothing, so the read-back contradicts it.
  const registry = {
    get: (name) => ({
      "filesystem.read": {
        execute: async ({ filePath }) => ({ contents: await nodeFs.readFile(filePath, "utf8") })
      },
      "filesystem.write": { execute: async () => ({ written: true }) }
    }[name] ?? null)
  };
  const toolset = buildToolset({ registry, adapter, basePath: work });
  await toolset.execute("write_file", { path: target, contents: "never arrives", existing: "replace" });

  const undone = await toolset.execute("undo", {});
  assert.ok(undone.raw.nothingToUndo,
    "the write did not happen, so offering to reverse it would overwrite a file nobody changed");
  assert.equal(await nodeFs.readFile(target, "utf8"), "the original");
});

// ---------------------------------------------------------------------------
// W2.2, PARTIAL AND SAID SO.
//
// A send journalled NOTHING, so `undo` answered "there is nothing on this
// session's record to put back" about a message that had just gone to another
// person. True of the journal, false about the world — and it is the failure
// docs/trust-and-triggers.md names outright: a journal that omits the
// irreversible entries implies a coverage it does not have, because silence
// reads as "nothing happened".
//
// These pin the HONEST answer. They do NOT test un-sending, which is not built:
// nothing here can drive WhatsApp's delete-for-everyone and prove the message is
// gone from the conversation over a separate raw-UIA pass. The last test below
// is the one that would fail the day somebody records a `message` reversal
// without building the thing that carries it out.

function messagingToolset({ boxAfter = "" } = {}) {
  const registry = {
    get: (name) => ({
      "keyboard.press": { execute: async () => ({ performed: true }) },
      "keyboard.type": { execute: async () => ({ performed: true }) }
    }[name] ?? null)
  };
  const messagingAdapter = {
    ...adapter,
    // The message box, read back through UIA after Enter. Empty means the text
    // left it, which is what the send check reads as CONFIRMED.
    getFocusedElement: async () => ({ value: boxAfter, name: "Type a message" }),
    focusedElement: async () => ({ value: boxAfter, name: "Type a message" }),
    getForegroundWindow: async () => ({ windowId: 1, title: "WhatsApp", application: "WhatsApp" }),
    listWindows: async () => [{ windowId: 1, title: "WhatsApp", application: "WhatsApp" }]
  };
  const toolset = buildToolset({
    registry,
    adapter: messagingAdapter,
    basePath: "C:\work",
    // The approval card is answered yes: the question here is what the journal
    // records once a send has been authorised, not whether it asks.
    askPermission: async () => ({ approved: true })
  });
  // The generic action boundary and the send-specific approval card are
  // intentionally separate fail-closed gates. This fixture approves both so
  // these tests can reach the journal semantics they exist to verify.
  toolset.setConfirmer(async () => true);
  return toolset;
}

test("after a send, undo says the message cannot be unsent — not 'nothing to undo'", async () => {
  const toolset = messagingToolset();
  await toolset.execute("type", { text: "on my way" });
  await toolset.execute("key", { keys: "enter", application: "WhatsApp" });

  const undone = await toolset.execute("undo", {});
  assert.ok(!undone.raw.nothingToUndo,
    "silence about an irreversible action reads as 'nothing happened', which is the failure this prevents");
  assert.equal(undone.raw.outcome, "NEVER_REVERSIBLE");
  assert.match(undone.text, /cannot be undone/i);
  // The reason has to be ACTIONABLE. "Do it in the app now rather than later"
  // is the difference between a refusal and help.
  assert.match(undone.raw.entry.why, /delete for everyone/i);
  assert.match(undone.raw.entry.why, /limited time/i);
});

test("undo after a send never claims to have put anything back", async () => {
  const toolset = messagingToolset();
  await toolset.execute("type", { text: "on my way" });
  await toolset.execute("key", { keys: "enter", application: "WhatsApp" });
  const undone = await toolset.execute("undo", {});
  assert.doesNotMatch(undone.text, /Put back/,
    "no sentence may imply the message was retrieved");
  assert.notEqual(undone.raw.outcome, "REVERSED");
});

test("a keystroke that is NOT a send journals nothing", async () => {
  const toolset = messagingToolset();
  // ctrl+s in a messaging window is not a send and must not fill the journal
  // with entries the user would then be offered.
  await toolset.execute("key", { keys: "ctrl+s", application: "WhatsApp" });
  const undone = await toolset.execute("undo", {});
  assert.ok(undone.raw.nothingToUndo, "only the gated send is irreversible; ordinary keys are not");
});

test("no message reversal may be recorded until something can carry it out", async () => {
  const toolset = messagingToolset();
  await toolset.execute("type", { text: "on my way" });
  await toolset.execute("key", { keys: "enter", application: "WhatsApp" });
  const undone = await toolset.execute("undo", {});
  // THE GUARD AGAINST A HALF-BUILT W2.2. The journal supports windowMs and a
  // typed reversal; the moment a `message` reversal is recorded, `undo` will
  // try to execute it. This fails if that happens before the executor exists,
  // rather than letting undo promise an unsend it cannot deliver.
  assert.equal(undone.raw.entry.reversal, null,
    "recording a reversal nothing can perform makes undo promise an unsend it will then fail");
  assert.equal(undone.raw.entry.expiresAt, null,
    "an expiry on an entry with no reversal implies a window that leads nowhere");
});
