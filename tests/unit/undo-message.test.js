import test from "node:test";
import assert from "node:assert/strict";
import { prepareMessageUndo, unsendMessage } from "../../packages/fast-agent/src/undo-message.js";

// A fake WhatsApp. It holds a conversation and a menu, and — importantly — it
// can be told to LIE: to report a successful deletion while leaving the message
// exactly where it was. That is not a hypothetical. Every serious defect on this
// action has been an operation reporting success about itself, and a reversal
// that trusted `ok: true` would inherit the whole family.
function fakeWhatsApp({
  conversation = ["You: on my way", "Amma: ok"],
  options = ["Reply", "Copy", "Delete"],
  deleteOptions = ["Delete for me", "Delete for everyone", "Cancel"],
  focusFails = false,
  deleteLies = false,
  menuFails = false
} = {}) {
  const state = { conversation: [...conversation], deletedCalls: [] };
  return {
    state,
    focusApplication: async () => (focusFails ? { ok: false, reason: "the window did not come forward" } : { ok: true }),
    readConversation: async () => [...state.conversation],
    openMessageMenu: async () => (menuFails
      ? { ok: false, reason: "no options control under that message" }
      : { ok: true, items: options }),
    chooseMenuItem: async (_target, label) => {
      state.deletedCalls.push(label);
      if (/^delete(?:\s+message)?$/i.test(label)) return { ok: true, items: deleteOptions };
      if (/^delete for everyone$/i.test(label)) {
        // The lie: it says it worked and changes nothing.
        if (!deleteLies) {
          state.conversation = state.conversation.filter((line) => !line.includes("on my way"));
        }
        return { ok: true };
      }
      return { ok: false, reason: `unexpected item ${label}` };
    }
  };
}

const entry = { kind: "message", text: "on my way", application: "WhatsApp", windowId: 1 };

test("inside the window, the message is deleted and proved gone", async () => {
  const app = fakeWhatsApp();
  const result = await unsendMessage(entry, app);

  assert.equal(result.restored, true);
  assert.equal(result.verdict, "CONFIRMED");
  assert.equal(result.windowClosed, false);
  assert.match(result.observed, /no longer in the conversation/);
  assert.deepEqual(app.state.deletedCalls, ["Delete", "Delete for everyone"]);
  // The proof must come from a different capability than the deletion, or it
  // proves nothing. evidence() enforces this at construction; this pins it here
  // too, because the pairing is the whole design and not an implementation note.
  assert.notEqual(result.method, result.actedVia);
});

// THE ONE THE BRIEF ASKS FOR BY NAME.
test("undo fails when the deletion lies about having worked", async () => {
  const app = fakeWhatsApp({ deleteLies: true });
  const result = await unsendMessage(entry, app);

  assert.equal(result.restored, false, "a menu reporting success is not a deleted message");
  assert.equal(result.verdict, "REFUTED");
  assert.match(result.observed, /still in the conversation/);
  // It really did press the thing — this is not a failure to act, it is a
  // failure that ACTING was checked. Those look identical from `ok: true`.
  assert.ok(app.state.deletedCalls.includes("Delete for everyone"));
});

test("when the app does not offer it, the absence is reported and NOT explained", async () => {
  const app = fakeWhatsApp({ deleteOptions: ["Delete for me", "Cancel"] });
  const result = await unsendMessage(entry, app);

  assert.equal(result.windowClosed, true);
  assert.equal(result.restored, false);
  assert.equal(result.verdict, "UNCONFIRMED", "not being allowed to is not the same as being contradicted");
  assert.match(result.observed, /did not offer "Delete for everyone"/);
  assert.match(result.observed, /Delete for me, Cancel/, "say what it DID offer, so the user can act");
  // MEASURED 22 AUG 2026: a message sent SECONDS earlier into the user's own
  // "Message yourself" chat is offered only "Delete for me" — a self-chat has no
  // everyone, and no window has closed. Claiming expiry there would be a
  // confident invention, so the sentence may name the possibilities and must not
  // assert one of them.
  assert.doesNotMatch(result.observed, /that time has passed|has expired|too late/i,
    "at least two things produce this absence; asserting one of them is a guess");
  assert.match(result.observed, /only you in it/, "the self-chat case has to be one of the reasons offered");
});

// The route to the choice is two "Delete" presses, not one: the first puts
// WhatsApp into a selection mode whose bottom bar carries the second.
test("it walks through a selection step to reach the real choice", async () => {
  const state = { pressed: [] };
  const app = {
    focusApplication: async () => ({ ok: true }),
    readConversation: async () => (state.deleted ? ["Amma: ok"] : ["You: on my way", "Amma: ok"]),
    openMessageMenu: async () => ({ ok: true, items: ["Reply", "Copy", "Delete"] }),
    chooseMenuItem: async (_t, label) => {
      state.pressed.push(label);
      // First Delete -> the selection bar. Second Delete -> the modal.
      if (label === "Delete" && state.pressed.filter((p) => p === "Delete").length === 1) {
        return { ok: true, items: ["Cancel delete", "Delete"] };
      }
      if (label === "Delete") return { ok: true, items: ["Cancel", "Delete for me", "Delete for everyone"] };
      if (label === "Delete for everyone") { state.deleted = true; return { ok: true }; }
      return { ok: false, reason: `unexpected ${label}` };
    }
  };
  const result = await unsendMessage(entry, app);

  assert.deepEqual(state.pressed, ["Delete", "Delete", "Delete for everyone"]);
  assert.equal(result.restored, true);
  assert.equal(result.verdict, "CONFIRMED");
});

// A MESSAGE THAT WAS NEVER THERE MUST NOT READ AS A SUCCESSFUL DELETION.
//
// This is the empty-input-box defect in its other form: if the check is only
// "is it absent afterwards", then absent-all-along passes it vacuously.
test("a message that is not in the conversation is not silently reported as deleted", async () => {
  const app = fakeWhatsApp({ conversation: ["Amma: ok"] });
  const result = await unsendMessage(entry, app);

  assert.equal(result.restored, false);
  assert.match(result.observed, /could not find/i);
  assert.deepEqual(app.state.deletedCalls, [], "nothing may be pressed when the target was never found");
});

test("a window that will not come forward is reported as that, not as a deletion", async () => {
  const app = fakeWhatsApp({ focusFails: true });
  const result = await unsendMessage(entry, app);

  assert.equal(result.restored, false);
  assert.match(result.observed, /could not bring WhatsApp to the front/);
  assert.deepEqual(app.state.deletedCalls, []);
});

test("no options control under the message is COULD_NOT, and presses nothing", async () => {
  const app = fakeWhatsApp({ menuFails: true });
  const result = await unsendMessage(entry, app);

  assert.equal(result.restored, false);
  assert.equal(result.windowClosed, false, "a missing control is not evidence the window expired");
  assert.match(result.observed, /could not open the options/);
});

// The journal refuses an entry that is silent about being irreversible, so the
// preparer has to decide at send time and say why.
test("a send whose text was never captured records why it cannot be undone", () => {
  for (const [args, pattern] of [
    [{ text: "", application: "WhatsApp" }, /did not capture the text/],
    [{ text: "   ", application: "WhatsApp" }, /did not capture the text/],
    [{ text: "hello", application: null }, /which application/]
  ]) {
    const prepared = prepareMessageUndo(args);
    assert.equal(prepared.reversal, null);
    assert.match(prepared.why, pattern);
  }
});

test("a captured send records a typed reversal, never a sentence", () => {
  const prepared = prepareMessageUndo({ text: "  on my way  ", application: "WhatsApp", windowId: 7 });
  assert.equal(prepared.why, null);
  assert.deepEqual(prepared.reversal, { kind: "message", text: "on my way", application: "WhatsApp", windowId: 7 });
});
