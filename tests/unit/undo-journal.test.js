// THE JOURNAL HAS TO BE HONEST ABOUT WHAT IT CANNOT DO.
//
// Its absence has already cost this user twice: a session left the system volume
// at 42% with no record of the previous value, and another killed OneDrive and
// failed to restart it. Both reported honestly. Neither could be reversed,
// because what was needed to reverse them was never written down.
//
// The failure mode of a journal is not "it forgot an entry" — it is "it kept an
// entry that implied it could put something back when it could not". So these
// tests push hardest on the irreversible and expired paths.

import test from "node:test";
import assert from "node:assert/strict";
import { Reversal, createUndoJournal, timeLeft } from "../../packages/fast-agent/src/undo-journal.js";

const CONFIRMED_RECEIPT = { observed: "the endpoint reports 20%", method: "audio.endpoint:get", verdict: "CONFIRMED" };
const REFUTED_RECEIPT = { observed: "the endpoint reports 42%", method: "audio.endpoint:get", verdict: "REFUTED" };
const UNCONFIRMED_RECEIPT = { observed: "the endpoint could not be metered", method: "audio.endpoint:get", verdict: "UNCONFIRMED" };

const volumeEntry = (journal, from = 42) => journal.record({
  tool: "volume",
  summary: `system volume ${from}% → 20%`,
  reversal: { kind: "volume", percent: from, muted: false }
});

test("an action that has not reported back yet is not offered for undo", () => {
  const journal = createUndoJournal();
  volumeEntry(journal);
  assert.equal(journal.last(), null,
    "the entry is written BEFORE the action; offering to reverse it before it happened would undo nothing");
});

test("a settled action is the one offered", () => {
  const journal = createUndoJournal();
  const id = volumeEntry(journal);
  journal.settle(id, CONFIRMED_RECEIPT);
  assert.equal(journal.last().reversal.percent, 42);
});

// UNCONFIRMED IS NOT FAILED, and here it matters more than anywhere: an action
// nobody could verify is precisely the one most worth being able to reverse.
test("an unverifiable action stays undoable; a refuted one does not", () => {
  const unsure = createUndoJournal();
  journal_settle(unsure, UNCONFIRMED_RECEIPT);
  assert.ok(unsure.last(), "we could not confirm it moved, so we must assume it might have");

  const refuted = createUndoJournal();
  journal_settle(refuted, REFUTED_RECEIPT);
  assert.equal(refuted.last(), null,
    "the machine said it did not happen, so there is nothing to put back");

  function journal_settle(journal, receipt) {
    const id = volumeEntry(journal);
    journal.settle(id, receipt);
  }
});

// THE ONE THIS FILE EXISTS FOR.
test("an action with nothing to reverse it must say why, and refuses to be recorded silently", () => {
  const journal = createUndoJournal();
  assert.throws(
    () => journal.record({ tool: "send_message", summary: "sent a message" }),
    /recorded no reversal and no reason/,
    "an entry that is silent about being irreversible implies a coverage the journal does not have"
  );
});

test("an irreversible action is kept and returned, not hidden", () => {
  const journal = createUndoJournal();
  const id = journal.record({
    tool: "run",
    summary: "stopped the OneDrive process",
    why: "a stopped process cannot be restored to what it was doing; it can only be started again"
  });
  journal.settle(id, CONFIRMED_RECEIPT);
  const last = journal.last();
  assert.ok(last, "hiding it would make `undo` say 'nothing to put back', which is a different and false sentence");
  assert.equal(last.reversal, null);
  assert.match(last.why, /cannot be restored/);
  assert.equal(journal.reversibleCount(), 0,
    "it is on the record, and it still does not count as something that can be put back");
});

test("a reversal with a window expires, and expired reads differently from irreversible", () => {
  let clock = 1_000_000;
  const journal = createUndoJournal({ now: () => clock });
  const id = journal.record({
    tool: "click",
    summary: 'sent "channa mereya" to Amma',
    reversal: { kind: "whatsapp-delete-for-everyone" },
    windowMs: 60_000
  });
  journal.settle(id, CONFIRMED_RECEIPT);

  assert.equal(journal.last().expired, false);
  assert.equal(journal.reversibleCount(), 1);

  clock += 61_000;
  const stale = journal.last();
  assert.equal(stale.expired, true, "the window closed");
  assert.ok(stale.reversal, "it WAS reversible — that is what makes 'too late' the right sentence rather than 'never'");
  assert.equal(journal.reversibleCount(), 0);
});

test("something already put back is not offered a second time", () => {
  const journal = createUndoJournal();
  const id = volumeEntry(journal);
  journal.settle(id, CONFIRMED_RECEIPT);
  journal.close(id, Reversal.REVERSED);
  assert.equal(journal.last(), null,
    "undoing twice would set the volume back to a value that is already current, and report it as a change");
});

test("a failed reversal stays on the record and can be tried again", () => {
  const journal = createUndoJournal();
  const id = volumeEntry(journal);
  journal.settle(id, CONFIRMED_RECEIPT);
  journal.close(id, Reversal.COULD_NOT);
  assert.ok(journal.last(), "giving up after one failed attempt would strand the user at a level they did not choose");
});

test("the most recent undoable action is the one returned, not the oldest", () => {
  const journal = createUndoJournal();
  const first = volumeEntry(journal, 42);
  journal.settle(first, CONFIRMED_RECEIPT);
  const second = volumeEntry(journal, 20);
  journal.settle(second, CONFIRMED_RECEIPT);
  assert.equal(journal.last().reversal.percent, 20);
});

test("time left is said in words a person can act on", () => {
  const at = 1_000_000;
  assert.equal(timeLeft({ expiresAt: at + 240_000 }, at), "about 4 minutes");
  assert.equal(timeLeft({ expiresAt: at + 65_000 }, at), "about a minute");
  assert.equal(timeLeft({ expiresAt: at + 5_000 }, at), "about 5 seconds");
  assert.equal(timeLeft({ expiresAt: at - 1 }, at), "no longer possible");
  assert.equal(timeLeft({ expiresAt: null }, at), null,
    "null means it does not expire, and must not be rendered as a countdown");
});
