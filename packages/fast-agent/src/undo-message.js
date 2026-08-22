// UN-SENDING A MESSAGE.
//
// The journal has carried "a sent message cannot be unsent from here" since the
// day it was written, and that sentence was honest but it was not the answer.
// This is the answer: drive WhatsApp's own "delete for everyone", and then prove
// the message is GONE from the conversation.
//
// FIVE THINGS HAVE BURNED THIS CODEBASE ON THIS EXACT ACTION AND ALL FIVE ARE
// LIVE IN THE PATH BELOW:
//
//   1. an empty input box is not evidence of a send — WhatsApp publishes
//      value="\n" when the box is empty, so every "is it empty" check passed
//      vacuously. Nothing here reads the input box at all; the CONVERSATION is
//      the only thing that answers whether a message exists.
//   2. message text is HIDDEN from the control view (IsControlElement=false).
//      A condition-filtered RAW-view pass is the only thing that sees it — see
//      Get-HiddenTextTargets in os-adapters/windows-host/restore-host.ps1.
//   3. a synthetic click is the least reliable way to press a control:
//      reproduced 3/3 that a click delivered after another window held the
//      foreground is swallowed whole. Named pressable controls go through UIA
//      InvokePattern (~27ms) instead.
//   4. a WebView2 app is TWO unrelated top-level windows. Input goes to the
//      FRAME; reads come from the CONTENT window. Activating the content window
//      is not activating the application, and Windows reports total success
//      while every keystroke is discarded.
//   5. the working window can slide back to the frame, after which every reading
//      returns the same three caption buttons and looks like a broken tool.
//
// THE WINDOW IS NOT A CONSTANT, IT IS A MENU ITEM.
//
// WhatsApp's deletion window has changed at least twice, differs by platform,
// and is not published anywhere this code can read. So this does not hardcode
// one and compare clocks. The app itself is asked: if "Delete for everyone" is
// not among the options the message offers, the window has closed — which is
// both the truth and the only version of it that cannot go stale. The journal's
// own `expiresAt` stays as a cheap hint for the sentence shown to the user; this
// is what decides the outcome.
//
// AND THE VERIFICATION DOES NOT SHARE A PATH WITH THE DELETION. The delete is
// driven through menu invocation; the proof is a raw-view text pass over the
// conversation. evidence() refuses a receipt whose `method` equals its
// `actedVia`, so that separation is enforced at construction rather than
// remembered.

/** What the menu item is called, across the phrasings WhatsApp has shipped. */
const DELETE_FOR_EVERYONE = /^\s*delete for everyone\s*$/i;
/** The first menu, which only opens the delete dialog — not itself destructive. */
const DELETE_ENTRY = /^\s*delete(?:\s+message)?\s*$/i;

/**
 * The descriptor that makes a send reversible, built at the moment it is sent.
 *
 * Returns the same `{ reversal, why }` shape as prepareFileUndo, so the journal
 * treats both identically and the irreversible case is STATED rather than
 * implied by silence.
 */
export function prepareMessageUndo({ text, application, windowId } = {}) {
  const body = String(text ?? "").trim();
  // A CHECK WITH AN EMPTY NEEDLE IS NOT A CHECK. Without the text there is
  // nothing to find in the conversation and nothing to prove gone afterwards, so
  // an undo recorded here would be a promise with no way to keep it.
  if (!body) {
    return {
      reversal: null,
      why: "I did not capture the text of that message, so I cannot find it again to delete it. "
        + "If you want it gone, use \"delete for everyone\" in the app."
    };
  }
  if (!application) {
    return {
      reversal: null,
      why: "I could not tell which application that was sent from, so I cannot go back to the right "
        + "conversation to delete it."
    };
  }
  return {
    reversal: { kind: "message", text: body, application, windowId: windowId ?? null },
    why: null
  };
}

/**
 * Delete the message for everyone, and prove it is gone.
 *
 * Every capability is injected. That is not only for tests: it keeps this file
 * free of any opinion about how a window is focused or a menu is invoked, which
 * is what lets the WebView2 handling live in one place instead of two.
 *
 * @returns {{restored: boolean, windowClosed: boolean, observed: string,
 *            method: string, actedVia: string|null, verdict: string}}
 */
export async function unsendMessage(reversal, {
  focusApplication,
  readConversation,
  openMessageMenu,
  chooseMenuItem
} = {}) {
  const needle = String(reversal?.text ?? "").trim();
  if (!needle) {
    return could("the journal entry carried no message text, so there was nothing to look for", null);
  }
  const target = { application: reversal.application, windowId: reversal.windowId ?? null };

  // TRAP 4 AND 5. Focus the APPLICATION, not whichever of its two windows was
  // read last. Everything after this assumes input reaches it, and Windows will
  // cheerfully report success while discarding every event if it does not.
  const focused = await focusApplication(target).catch((error) => ({ ok: false, reason: error?.message }));
  if (!focused?.ok) {
    return could(`I could not bring ${reversal.application} to the front (${focused?.reason ?? "no reason given"})`, null);
  }

  // BEFORE, so "it is not there now" means something. A message that was already
  // gone would otherwise read as a successful deletion — the same vacuous pass
  // as an empty input box.
  const before = await readConversation(target).catch(() => null);
  if (!Array.isArray(before)) {
    return could("I could not read the conversation, so I could not tell whether the message was still there", null);
  }
  if (!before.some((line) => String(line).includes(needle))) {
    return could(
      `I could not find "${clip(needle)}" in the conversation, so I did not delete anything — `
      + "it may have scrolled out of view, or already be gone",
      null
    );
  }

  // TRAP 2 and 3: the bubble is found over the raw view, and its menu is opened
  // by invoking a named control rather than by a synthetic click.
  const menu = await openMessageMenu(target, needle).catch((error) => ({ ok: false, reason: error?.message }));
  if (!menu?.ok) {
    return could(`I could not open the options for that message (${menu?.reason ?? "no reason given"})`, null);
  }
  const items = (menu.items ?? []).map((item) => String(item ?? ""));

  // GETTING TO THE CHOICE TAKES MORE THAN ONE "Delete", AND THE COUNT IS NOT
  // FIXED. Measured against WhatsApp on Windows, 22 Aug 2026: the message menu's
  // "Delete" does NOT open a confirm dialog — it puts the app into a SELECTION
  // MODE whose bottom bar carries "Cancel delete" and a second "Delete", and it
  // is that one which opens the modal titled "Delete message?". A build that
  // goes straight to the modal is equally plausible, so this walks toward the
  // choice rather than assuming a depth, and stops as soon as it is offered.
  let options = items;
  for (let hop = 0; hop < 3; hop += 1) {
    if (options.some((item) => DELETE_FOR_EVERYONE.test(item))) break;
    const next = options.find((item) => DELETE_ENTRY.test(item));
    if (!next) break;
    const opened = await chooseMenuItem(target, next).catch((error) => ({ ok: false, reason: error?.message }));
    if (!opened?.ok) {
      return could(`I opened the message's menu but could not choose ${JSON.stringify(next)} ` +
        `(${opened?.reason ?? "no reason given"})`, null);
    }
    options = (opened.items ?? []).map((item) => String(item ?? ""));
  }

  // THE APP ANSWERING "not available", IN THE ONLY WAY IT EVER SAYS SO.
  //
  // REPORT THE ABSENCE, DO NOT EXPLAIN IT. The first version of this said the
  // time had passed, which is one of at least two reasons and would have been a
  // confident lie about the other. Measured 22 Aug 2026 against the user's own
  // "Message yourself" chat: a message sent SECONDS earlier was offered only
  // "Cancel" and "Delete for me" — not because any window had closed, but
  // because a self-chat has no everyone. Asserting expiry there would be exactly
  // the kind of plausible-sounding invention this codebase exists to prevent.
  const forEveryone = options.find((item) => DELETE_FOR_EVERYONE.test(item));
  if (!forEveryone) {
    return {
      restored: false,
      windowClosed: true,
      observed: "the app did not offer \"Delete for everyone\" for that message, so I did not delete it. "
        + `What it offered was: ${options.join(", ") || "nothing"}. `
        + "WhatsApp withdraws that option once too long has passed since sending, and never offers it at all "
        + "in a chat with only you in it",
      method: "uia.menu.options",
      actedVia: null,
      verdict: "UNCONFIRMED"
    };
  }

  const deleted = await chooseMenuItem(target, forEveryone)
    .catch((error) => ({ ok: false, reason: error?.message }));
  if (!deleted?.ok) {
    return could(`I chose "Delete for everyone" and it did not take (${deleted?.reason ?? "no reason given"})`, "uia.invoke.menu");
  }

  // AND NOW THE ONLY THING THAT SETTLES IT.
  //
  // `deleted.ok` is the menu telling us about itself, which is exactly the class
  // of claim this project keeps catching: a send that reported success while the
  // text sat in a search box, a track "playing" that never started. The
  // conversation is read again, over the raw view, and if the message is still
  // there then it was not deleted whatever the menu said.
  const after = await readConversation(target).catch(() => null);
  if (!Array.isArray(after)) {
    return {
      restored: false,
      windowClosed: false,
      observed: "I chose \"Delete for everyone\" but could not read the conversation back, so I cannot tell "
        + "you whether the message actually went",
      method: "uia.rawview.conversation",
      actedVia: "uia.invoke.menu",
      verdict: "UNCONFIRMED"
    };
  }
  const stillThere = after.some((line) => String(line).includes(needle));
  return {
    restored: !stillThere,
    windowClosed: false,
    observed: stillThere
      ? `"${clip(needle)}" is still in the conversation after the delete, so it did not go through`
      : `"${clip(needle)}" is no longer in the conversation, read back over the raw view`,
    method: "uia.rawview.conversation",
    actedVia: "uia.invoke.menu",
    verdict: stillThere ? "REFUTED" : "CONFIRMED"
  };
}

/** An attempt that should have worked and did not. Never NEVER_REVERSIBLE. */
function could(observed, actedVia) {
  return {
    restored: false,
    windowClosed: false,
    observed,
    method: "uia.rawview.conversation",
    actedVia,
    verdict: "UNCONFIRMED"
  };
}

function clip(value, max = 60) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
