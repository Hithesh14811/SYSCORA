// THE COMPOSE CARD: THE ONE PLACE AN EMAIL CAN LEAVE THIS MACHINE.
//
// The agent drafts; a person sends. Everything about this file follows from
// that one sentence:
//
//   * every field is editable, including who it goes to and who it comes FROM,
//     because the point of showing a draft is that the reader can disagree
//     with it;
//   * the account it will send from is a picker on the card, not a setting
//     three menus away, because "which of my addresses is this going out as"
//     is part of what is being agreed to and changes per message;
//   * the button says what it will do and then reports what happened, using
//     Gmail's own message id — the same rule every tool in this codebase is
//     held to. A request that returned is not a message that was sent.
//
// The card is deliberately dumb about transport: it POSTs to /api/email/send
// and shows what comes back. The daemon owns the credential.

import { renderMarkdown } from "./markdown.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const svg = (paths, size = 16) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.8");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = paths;
  return node;
};

const ICON = {
  mail: '<rect x="3" y="5.2" width="18" height="13.6" rx="2.6"/><path d="M3.6 7l7.3 5.3a2 2 0 0 0 2.2 0L20.4 7"/>',
  send: '<path d="M12 19V5.6M5.8 11.8L12 5.4l6.2 6.4"/>',
  close: '<path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 6.8"/>',
  caret: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  bold: '<path d="M7 5h6.4a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h7.2a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M15.5 5h-5M13.5 19h-5M14.6 5l-3.4 14"/>',
  underline: '<path d="M7 4.5v6.2a5 5 0 0 0 10 0V4.5"/><path d="M5.5 19.5h13"/>',
  strike: '<path d="M4.5 12h15"/><path d="M8 8.2a3.4 3.4 0 0 1 3.6-3.2c2 0 3.4 1 3.9 2.4"/><path d="M15.6 15a3.6 3.6 0 0 1-3.8 4.2c-2.2 0-3.7-1.1-4.2-2.7"/>',
  bullets: '<path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><circle cx="5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
  numbers: '<path d="M10 6.5h9.5M10 12h9.5M10 17.5h9.5"/><path d="M4.2 5.2h1.1v3.4M4 15.4a1.3 1.3 0 1 1 2.2.9L4 18.9h2.4" stroke-width="1.5"/>',
  link: '<path d="M10.3 13.7a3.6 3.6 0 0 0 5.1 0l2.8-2.8a3.6 3.6 0 1 0-5.1-5.1l-1.3 1.3"/><path d="M13.7 10.3a3.6 3.6 0 0 0-5.1 0l-2.8 2.8a3.6 3.6 0 1 0 5.1 5.1l1.3-1.3"/>',
  clear: '<path d="M8.6 18.5h10.9"/><path d="M14.4 4.9 6.2 13.1a1.8 1.8 0 0 0 0 2.6l2 2a1.8 1.8 0 0 0 2.6 0l8.2-8.2a1.8 1.8 0 0 0 0-2.6l-2-2a1.8 1.8 0 0 0-2.6 0z"/>',
  google: '<path d="M20.6 12.2c0-.6-.05-1.2-.16-1.75H12v3.32h4.83a4.13 4.13 0 0 1-1.79 2.71v2.26h2.9c1.7-1.56 2.66-3.87 2.66-6.54z"/>' +
    '<path d="M12 21c2.4 0 4.42-.8 5.9-2.16l-2.9-2.26c-.8.54-1.83.86-3 .86-2.31 0-4.27-1.56-4.97-3.66H4.03v2.33A9 9 0 0 0 12 21z"/>' +
    '<path d="M7.03 13.78a5.4 5.4 0 0 1 0-3.45V8H4.03a9 9 0 0 0 0 8.08l3-2.3z"/>' +
    '<path d="M12 6.58c1.3 0 2.48.45 3.4 1.33l2.55-2.56C16.42 3.9 14.4 3 12 3a9 9 0 0 0-7.97 4.92l3 2.33C7.73 8.15 9.69 6.58 12 6.58z"/>'
};

/* ---- What is allowed to be in an email --------------------------------------
 *
 * THE BODY IS NOT OURS. Its first draft comes from a model that has been
 * reading web pages, documents and folders, and after that it takes whatever
 * the user pastes into it. Both are content, and both get run through this
 * before they become HTML in a message that goes to somebody else.
 *
 * An allowlist, not a blocklist: anything not named here has its tag dropped
 * and its text kept. Mail clients strip most of it anyway — this is about what
 * reaches the DOM of this window on the way, and about not sending somebody a
 * <script> because a page the agent read contained one.
 */
const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL",
  "P", "DIV", "BR", "SPAN", "A", "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "PRE",
  "H1", "H2", "H3", "H4"
]);

const safeHref = (raw) => {
  const href = String(raw ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
};

function sanitizeInto(html) {
  const source = document.createElement("div");
  source.innerHTML = String(html ?? "");
  const clean = document.createElement("div");

  const copy = (from, to) => {
    for (const node of [...from.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(node.nodeValue));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (!ALLOWED_TAGS.has(node.tagName)) {
        // Keep the words, drop the wrapper. A <script> has no words worth
        // keeping and its text content is code, so it goes entirely.
        if (node.tagName !== "SCRIPT" && node.tagName !== "STYLE") copy(node, to);
        continue;
      }
      const kept = document.createElement(node.tagName.toLowerCase());
      if (node.tagName === "A") {
        const href = safeHref(node.getAttribute("href"));
        // A link with no usable scheme becomes plain text rather than a dead
        // or dangerous anchor.
        if (!href) { copy(node, to); continue; }
        kept.setAttribute("href", href);
        kept.setAttribute("target", "_blank");
        kept.setAttribute("rel", "noopener noreferrer");
      }
      copy(node, kept);
      to.appendChild(kept);
    }
  };

  copy(source, clean);
  return clean.innerHTML;
}

/** Good enough for the plain-text alternative part of a message. */
function textOf(node) {
  const clone = node.cloneNode(true);
  for (const item of clone.querySelectorAll("li")) item.prepend(document.createTextNode("• "));
  for (const brk of clone.querySelectorAll("br")) brk.replaceWith(document.createTextNode("\n"));
  for (const block of clone.querySelectorAll("p, div, li, blockquote, h1, h2, h3, h4")) {
    block.append(document.createTextNode("\n"));
  }
  return (clone.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** A single address, drawn as a removable chip. */
function recipientChip(address, onRemove) {
  const chip = el("span", "mail-chip");
  chip.appendChild(el("span", "mail-chip-text", address));
  const remove = el("button", "mail-chip-remove");
  remove.type = "button";
  remove.title = `Remove ${address}`;
  remove.setAttribute("aria-label", `Remove ${address}`);
  remove.appendChild(svg(ICON.close, 11));
  remove.addEventListener("click", onRemove);
  chip.appendChild(remove);
  return chip;
}

/**
 * An address field: chips plus a free-text input that commits on comma, Enter,
 * Tab or blur.
 *
 * Committing on BLUR is the one that matters. A half-typed address left in the
 * box when the user reaches for Send is the classic way a mail composer sends
 * to fewer people than the sender believed it would.
 */
function addressField(labelText, initial, { optional = false } = {}) {
  const row = el("div", "mail-row");
  const label = el("label", "mail-label", labelText);
  const box = el("div", "mail-field mail-addresses");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mail-input";
  input.placeholder = optional ? "Add a copy…" : "name@example.com";
  input.setAttribute("aria-label", labelText);

  const addresses = [];
  const draw = () => {
    for (const chip of [...box.querySelectorAll(".mail-chip")]) chip.remove();
    addresses.forEach((address, index) => {
      box.insertBefore(recipientChip(address, () => {
        addresses.splice(index, 1);
        draw();
      }), input);
    });
  };
  const commit = () => {
    const raw = input.value.trim().replace(/[,;]+$/, "").trim();
    if (!raw) return;
    for (const part of raw.split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)) {
      if (!addresses.includes(part)) addresses.push(part);
    }
    input.value = "";
    draw();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === "Tab") {
      if (event.key !== "Tab" || input.value.trim()) event.preventDefault();
      commit();
      return;
    }
    // Backspace on an empty box takes back the last chip, which is what every
    // address field does and what a hand reaches for without thinking.
    if (event.key === "Backspace" && !input.value && addresses.length) {
      addresses.pop();
      draw();
    }
  });
  input.addEventListener("blur", commit);

  box.appendChild(input);
  row.append(label, box);
  for (const address of initial ?? []) if (address) addresses.push(address);
  draw();

  return { row, input, commit, values: () => { commit(); return addresses.slice(); } };
}

/* ---- The editor -------------------------------------------------------------
 *
 * A CONTENTEDITABLE, NOT A TEXTAREA. "Why would anyone use this instead of
 * Gmail if they can't make a word bold" is the right question, and a textarea
 * has no answer to it.
 *
 * `document.execCommand` is deprecated and is still the only thing every
 * browser implements for this. The replacement (the Highlight and EditContext
 * APIs) does not cover lists or inline formatting, and hand-rolling selection
 * surgery over ranges is how a composer ends up eating people's text. This
 * window is Chromium, execCommand works, and everything it produces is
 * sanitised before it becomes a message — see sanitizeInto.
 */
const COMMANDS = [
  { command: "bold", icon: ICON.bold, label: "Bold", keys: "Ctrl+B" },
  { command: "italic", icon: ICON.italic, label: "Italic", keys: "Ctrl+I" },
  { command: "underline", icon: ICON.underline, label: "Underline", keys: "Ctrl+U" },
  { command: "strikeThrough", icon: ICON.strike, label: "Strikethrough" },
  { separator: true },
  { command: "insertUnorderedList", icon: ICON.bullets, label: "Bulleted list" },
  { command: "insertOrderedList", icon: ICON.numbers, label: "Numbered list" },
  { separator: true },
  { command: "createLink", icon: ICON.link, label: "Link", keys: "Ctrl+K" },
  { command: "removeFormat", icon: ICON.clear, label: "Clear formatting" }
];

function buildEditor(initialBody) {
  const wrap = el("div", "mail-compose");
  const bar = el("div", "mail-toolbar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Formatting");

  const editor = el("div", "mail-message");
  editor.contentEditable = "true";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("aria-label", "Message");
  // Paragraphs rather than bare <div>s, which is what mail clients expect and
  // what makes the plain-text alternative come out with blank lines in it.
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older engines */ }

  // THE AGENT'S DRAFT ARRIVES AS TEXT AND IS SHOWN AS FORMATTING. The model
  // writes markdown whether or not anyone asked it to, so "**Tuesday**" becomes
  // bold here instead of reaching the recipient as asterisks — through the same
  // renderer the chat uses, then through the sanitiser, because that text came
  // from a model that had been reading somebody else's pages.
  editor.innerHTML = sanitizeInto(renderMarkdown(initialBody ?? ""));

  const buttons = [];
  for (const entry of COMMANDS) {
    if (entry.separator) {
      bar.appendChild(el("span", "mail-toolbar-sep"));
      continue;
    }
    const button = el("button", "mail-tool");
    button.type = "button";
    button.dataset.command = entry.command;
    button.title = entry.keys ? `${entry.label} (${entry.keys})` : entry.label;
    button.setAttribute("aria-label", entry.label);
    button.appendChild(svg(entry.icon, 16));
    // MOUSEDOWN, NOT CLICK. A click moves focus to the button first, which
    // collapses the selection in the editor — so the very first thing every
    // one of these buttons would do is throw away the text it was meant to
    // act on. Preventing the default on mousedown keeps the selection.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      apply(entry.command);
    });
    buttons.push(button);
    bar.appendChild(button);
  }

  const linkRow = el("div", "mail-link-row");
  linkRow.hidden = true;
  const linkInput = document.createElement("input");
  linkInput.type = "url";
  linkInput.className = "mail-input mail-link-input";
  linkInput.placeholder = "https://…";
  linkInput.setAttribute("aria-label", "Link address");
  const linkApply = el("button", "mail-link-apply", "Link");
  linkApply.type = "button";
  const linkCancel = el("button", "mail-link-cancel");
  linkCancel.type = "button";
  linkCancel.setAttribute("aria-label", "Cancel");
  linkCancel.appendChild(svg(ICON.close, 12));
  linkRow.append(linkInput, linkApply, linkCancel);

  // The selection the link is for, remembered while the URL is being typed —
  // focus moves to the input, which is exactly when the selection is lost.
  let savedRange = null;
  const closeLink = () => {
    linkRow.hidden = true;
    linkInput.value = "";
    savedRange = null;
    editor.focus();
  };
  const commitLink = () => {
    const href = safeHref(linkInput.value);
    if (!href) { linkInput.classList.add("bad"); return; }
    linkInput.classList.remove("bad");
    editor.focus();
    if (savedRange) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
    document.execCommand("createLink", false, href);
    // execCommand cannot set attributes, and a link that opens inside this
    // window would replace the conversation with a web page.
    for (const anchor of editor.querySelectorAll('a:not([rel])')) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
    closeLink();
    refreshState();
  };
  linkApply.addEventListener("click", commitLink);
  linkCancel.addEventListener("click", closeLink);
  linkInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commitLink(); }
    if (event.key === "Escape") { event.preventDefault(); closeLink(); }
  });

  function apply(command) {
    if (command === "createLink") {
      const selection = window.getSelection();
      if (!selection.rangeCount || selection.isCollapsed) {
        // Nothing selected means nothing to link. Say so on the button rather
        // than silently doing nothing, which reads as a broken control.
        bar.querySelector('[data-command="createLink"]')?.classList.add("nudge");
        setTimeout(() => bar.querySelector('[data-command="createLink"]')?.classList.remove("nudge"), 700);
        return;
      }
      savedRange = selection.getRangeAt(0).cloneRange();
      linkRow.hidden = false;
      linkInput.focus();
      return;
    }
    editor.focus();
    document.execCommand(command, false, null);
    refreshState();
  }

  /** Which buttons are "on" for wherever the caret is now. */
  function refreshState() {
    for (const button of buttons) {
      const command = button.dataset.command;
      if (command === "createLink" || command === "removeFormat") continue;
      let on = false;
      try { on = document.queryCommandState(command); } catch { on = false; }
      button.classList.toggle("on", on);
    }
  }

  editor.addEventListener("keyup", refreshState);
  editor.addEventListener("mouseup", refreshState);
  editor.addEventListener("focus", refreshState);

  editor.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "k") { event.preventDefault(); apply("createLink"); }
    // b/i/u are handled by the engine itself; this only keeps the buttons in
    // step with what it did.
    if (["b", "i", "u"].includes(key)) setTimeout(refreshState, 0);
  });

  // PASTE IS CONTENT TOO. Whatever is on the clipboard came from somewhere
  // else — a web page, another mail, a document — and goes through the same
  // allowlist as the model's draft rather than straight into the DOM.
  editor.addEventListener("paste", (event) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    const html = clipboard.getData("text/html");
    const plain = clipboard.getData("text/plain");
    if (html) {
      document.execCommand("insertHTML", false, sanitizeInto(html));
    } else {
      document.execCommand("insertText", false, plain);
    }
  });

  wrap.append(bar, editor, linkRow);
  return {
    wrap,
    editor,
    html: () => sanitizeInto(editor.innerHTML),
    text: () => textOf(editor),
    isEmpty: () => textOf(editor).length === 0
  };
}

/**
 * The card.
 *
 * `draft` is what the agent proposed: { to, cc, subject, body }. Nothing here
 * trusts it — it is the starting contents of a form.
 */
export function emailCard(draft, { fetchImpl = fetch, onSent = null } = {}) {
  const card = el("div", "mail-card");

  // ---- the head: which account this goes out as -----------------------------
  const head = el("div", "mail-head");
  const account = el("button", "mail-account");
  account.type = "button";
  account.setAttribute("aria-haspopup", "menu");
  account.setAttribute("aria-expanded", "false");
  account.appendChild(svg(ICON.mail, 17));
  const whoText = el("span", "mail-account-text", "Checking your accounts…");
  account.appendChild(whoText);
  const caret = svg(ICON.caret, 12);
  caret.classList.add("mail-account-caret");
  account.appendChild(caret);
  const accountMenu = el("div", "mail-account-menu");
  accountMenu.setAttribute("role", "menu");
  accountMenu.hidden = true;
  const accountWrap = el("div", "mail-account-wrap");
  accountWrap.append(account, accountMenu);

  const state = el("span", "mail-state", "Draft");
  head.append(accountWrap, state);
  card.appendChild(head);

  const body = el("div", "mail-body");
  card.appendChild(body);

  const to = addressField("To", draft.to);
  const cc = addressField("Cc", draft.cc, { optional: true });
  cc.row.classList.add("mail-optional");
  if (!draft.cc?.length) cc.row.hidden = true;
  // BLIND COPIES. The field is identical to Cc — the difference is entirely in
  // what the SERVER does with it (see buildMessage in apps/daemon/src/gmail.js),
  // and deliberately so: a second kind of address field here would be a second
  // place for the parsing and the chips to drift.
  const bcc = addressField("Bcc", draft.bcc, { optional: true });
  bcc.row.classList.add("mail-optional");
  if (!draft.bcc?.length) bcc.row.hidden = true;

  const subjectRow = el("div", "mail-row");
  subjectRow.appendChild(el("label", "mail-label", "Subject"));
  const subject = document.createElement("input");
  subject.type = "text";
  subject.className = "mail-field mail-input mail-subject";
  subject.value = draft.subject ?? "";
  subject.setAttribute("aria-label", "Subject");
  subjectRow.appendChild(subject);

  const compose = buildEditor(draft.body);

  // ONE TOGGLE PER FIELD, built the same way, so a third one would be a line.
  // They hide themselves once their field is showing — a button that reveals
  // something already on screen is a button that does nothing.
  const revealToggle = (label, field) => {
    const button = el("button", "mail-cc-toggle", label);
    button.type = "button";
    button.addEventListener("click", () => {
      field.row.hidden = false;
      button.hidden = true;
      field.input.focus();
    });
    if (!field.row.hidden) button.hidden = true;
    return button;
  };
  const ccToggle = revealToggle("Cc", cc);
  const bccToggle = revealToggle("Bcc", bcc);

  body.append(to.row, cc.row, bcc.row, subjectRow, compose.wrap);

  // ---- the foot: the one button that does something irreversible ------------
  const foot = el("div", "mail-foot");
  const note = el("div", "mail-note");
  const actions = el("div", "mail-actions");
  const send = el("button", "mail-send");
  send.type = "button";
  send.appendChild(svg(ICON.send, 15));
  send.appendChild(el("span", null, "Send"));
  actions.append(ccToggle, bccToggle, send);
  foot.append(note, actions);
  card.appendChild(foot);

  // ---- which accounts are there? --------------------------------------------

  let status = { configured: false, connected: false, accounts: [], address: null };
  // What this card will send as. Held per CARD, not per application: two drafts
  // in one conversation can legitimately go out from two different addresses,
  // and making the choice global would silently change the older one.
  let sendingAs = null;

  const setNote = (text, kind = "") => {
    note.textContent = text ?? "";
    note.className = `mail-note ${kind}`;
  };

  const openAccountMenu = (open) => {
    accountMenu.hidden = !open;
    account.setAttribute("aria-expanded", String(open));
    account.classList.toggle("open", open);
  };
  account.addEventListener("click", (event) => {
    event.stopPropagation();
    if (card.classList.contains("sent") || card.classList.contains("archived")) return;
    if (!status.accounts?.length && status.configured) { startSignIn(account); return; }
    openAccountMenu(accountMenu.hidden);
  });
  document.addEventListener("click", () => openAccountMenu(false));
  accountMenu.addEventListener("click", (event) => event.stopPropagation());

  function buildAccountMenu() {
    accountMenu.textContent = "";
    for (const entry of status.accounts ?? []) {
      const item = el("button", `mail-account-item${entry.address === sendingAs ? " chosen" : ""}`);
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      const tick = el("span", "mail-account-tick");
      tick.appendChild(svg(ICON.check, 12));
      item.append(tick, el("span", "mail-account-address", entry.address));
      item.addEventListener("click", () => {
        sendingAs = entry.address;
        openAccountMenu(false);
        applyStatus();
      });
      accountMenu.appendChild(item);
    }
    const add = el("button", "mail-account-item mail-account-add");
    add.type = "button";
    const plus = el("span", "mail-account-tick");
    plus.appendChild(svg(ICON.plus, 12));
    add.append(plus, el("span", "mail-account-address", "Add another account"));
    add.addEventListener("click", () => {
      openAccountMenu(false);
      startSignIn(add);
    });
    accountMenu.appendChild(add);
  }

  async function refreshStatus() {
    try {
      const response = await fetchImpl("/api/email/status");
      status = await response.json();
    } catch {
      status = { configured: false, connected: false, accounts: [], address: null, offline: true };
    }
    // Keep whatever this card was already set to, unless that account has gone.
    const known = (status.accounts ?? []).some((entry) => entry.address === sendingAs);
    if (!known) sendingAs = status.address ?? status.accounts?.[0]?.address ?? null;
    applyStatus();
    return status;
  }

  function applyStatus() {
    // THE STATUS CHECK OUTLIVES THE CARD IT WAS STARTED FOR. `refreshStatus` is
    // a round trip; a card replayed out of storage is sealed synchronously the
    // moment it is built, so the reply lands afterwards and overwrote the
    // "from an earlier session" note with a live one. Measured, not reasoned
    // about: the note read as a setup instruction on an archived draft.
    if (card.classList.contains("archived") || card.classList.contains("sent")) return;
    // Only one of these can be true, and each has a different next step. A card
    // that just says "can't send" sends the user looking in the wrong place.
    card.querySelector(".mail-connect")?.remove();
    buildAccountMenu();
    if (sendingAs) {
      whoText.textContent = sendingAs;
      account.title = "Choose which account this goes out from";
      account.classList.remove("mail-account-flat");
      send.disabled = false;
      if (!note.classList.contains("bad") && !note.classList.contains("ok")) setNote("");
      return;
    }
    send.disabled = true;
    account.classList.add("mail-account-flat");
    if (status.offline) {
      whoText.textContent = "Can't reach SYSCORA";
      setNote("The daemon isn't running, so this draft can't be sent from here yet.", "bad");
      return;
    }
    if (!status.configured) {
      whoText.textContent = "Gmail isn't set up for this build";
      setNote(status.setup ?? "No Google client is configured.", "bad");
      return;
    }
    whoText.textContent = "No account connected";
    setNote(status.signInError ?? "Connect a Google account once, and SYSCORA can send this and every draft after it.");
    const button = el("button", "mail-connect");
    button.type = "button";
    button.appendChild(svg(ICON.google, 15));
    button.appendChild(el("span", null, "Sign in with Google"));
    button.addEventListener("click", () => startSignIn(button));
    actions.insertBefore(button, send);
  }

  async function startSignIn(button) {
    button.disabled = true;
    const before = new Set((status.accounts ?? []).map((entry) => entry.address));
    setNote("Opening Google…");
    try {
      const response = await fetchImpl("/api/email/connect", { method: "POST" });
      const json = await response.json();
      if (!response.ok || !json.url) throw new Error(json.error ?? "Could not start the sign-in.");
      // Opened by the CLIENT: in the desktop shell this goes through the
      // window-open handler, which refuses to open a window that would inherit
      // this one's preload and hands the URL to the real browser instead.
      window.open(json.url, "_blank", "noopener");
      setNote("Finish signing in in your browser — this card will notice when you're done.");
      // The sign-in finishes minutes later in a window this page does not own,
      // so the only honest way to learn the outcome is to keep asking.
      const until = Date.now() + 300_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const next = await refreshStatus();
        // The NEW one, not just "any". Adding a second account while a first is
        // already connected would otherwise look like an instant success and
        // leave the card still sending as the old address.
        const added = (next.accounts ?? []).find((entry) => !before.has(entry.address));
        if (added) {
          sendingAs = added.address;
          applyStatus();
          setNote(`Connected ${added.address}.`, "ok");
          return;
        }
        if (next.signInError) { setNote(next.signInError, "bad"); return; }
      }
      setNote("The sign-in wasn't finished. Try again when you're ready.", "bad");
    } catch (error) {
      setNote(error?.message ?? String(error), "bad");
    } finally {
      button.disabled = false;
    }
  }

  // ---- sending --------------------------------------------------------------

  send.addEventListener("click", async () => {
    const recipients = to.values();
    if (recipients.length === 0) {
      setNote("Add at least one recipient.", "bad");
      to.input.focus();
      return;
    }
    if (compose.isEmpty()) {
      setNote("The message is empty.", "bad");
      compose.editor.focus();
      return;
    }
    send.disabled = true;
    card.classList.add("sending");
    state.textContent = "Sending…";
    setNote("");
    try {
      const response = await fetchImpl("/api/email/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: sendingAs,
          to: recipients,
          cc: cc.values(),
          bcc: bcc.values(),
          subject: subject.value,
          html: compose.html(),
          text: compose.text()
        })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.ok) throw new Error(json.error ?? `The server answered ${response.status}.`);
      // GMAIL'S OWN ID, or this does not say sent. The card is the last thing
      // between a draft and somebody's inbox; it does not get to guess.
      sealAsSent(json);
    } catch (error) {
      card.classList.remove("sending");
      state.textContent = "Draft";
      send.disabled = false;
      setNote(error?.message ?? String(error), "bad");
    }
  });

  /**
   * What was sent, frozen. The fields stop being editable because there is
   * nothing left to edit — the message is gone — and a card that still looks
   * like a form invites a second send nobody meant.
   */
  function sealAsSent(receipt) {
    card.classList.remove("sending");
    card.classList.add("sent");
    state.textContent = "Sent";
    state.classList.add("ok");
    send.remove();
    ccToggle.remove();
    bccToggle.remove();
    // An empty Bcc row on a sent card is a row about nothing; a filled one is
    // the only record the sender has of who got a blind copy, so it stays.
    if (bcc.values().length === 0) bcc.row.hidden = true;
    if (cc.values().length === 0) cc.row.hidden = true;
    compose.wrap.querySelector(".mail-toolbar")?.remove();
    compose.editor.contentEditable = "false";
    for (const field of card.querySelectorAll("input, textarea")) {
      field.readOnly = true;
      field.tabIndex = -1;
    }
    for (const remove of card.querySelectorAll(".mail-chip-remove")) remove.remove();
    account.disabled = true;
    caret.remove();
    whoText.textContent = `Sent from ${receipt.from}`;
    // THE EVIDENCE IS STILL REQUIRED; IT IS NO LONGER RECITED.
    //
    // Nothing about the rule has changed — sealAsSent is only reachable from a
    // response carrying Gmail's own message id, and the send path still refuses
    // to report success without one. But `1a034c396c0d4ed4` means nothing to
    // the person who pressed the button, and printing it made a finished action
    // look like a debug log. The pill says Sent, the head says which account it
    // went from, and the id is on the pill for anyone who needs to match it
    // against Gmail. Failures still say everything they can, in words.
    state.title = `Gmail message id: ${receipt.id}`;
    setNote("");
    // Tell the conversation what the user just did. Last, and guarded: a throw
    // in a listener must not leave a card that sent an email looking like one
    // that failed to.
    try { onSent?.(receipt); } catch { /* the mail went either way */ }
  }

  refreshStatus();
  return card;
}

/**
 * A draft replayed from a stored chat, made unsendable.
 *
 * A TRANSCRIPT IS A RECORD, NOT A LIVE OBJECT. Re-opening a conversation
 * re-runs every event through the same renderers — which is what makes the tool
 * rows and the answer come back exactly as they were — and that would hand back
 * a working Send button on a draft from last week. Press it and a second copy
 * of the message goes out, with nothing on screen having said it was the same
 * one. The same argument, and the same treatment, as the approval cards a
 * finished run leaves behind.
 *
 * The draft stays readable, because reading what was drafted is the point of
 * having it in the transcript. Editing the message that produced it is how you
 * get a live card back.
 */
export function sealReplayedDraft(card) {
  if (!card || card.classList.contains("sent")) return;
  card.classList.add("archived");
  card.querySelector(".mail-send")?.remove();
  card.querySelector(".mail-connect")?.remove();
  // querySelectorAll, NOT querySelector. There are two of these now — Cc and
  // Bcc — and the singular form removed the first and left a live "Bcc" button
  // on a card replayed out of storage, which is a control that reopens a field
  // on a draft that can no longer be sent.
  for (const toggle of card.querySelectorAll(".mail-cc-toggle")) toggle.remove();
  card.querySelector(".mail-toolbar")?.remove();
  card.querySelector(".mail-link-row")?.remove();
  card.querySelector(".mail-account-caret")?.remove();
  const editor = card.querySelector(".mail-message");
  if (editor) editor.contentEditable = "false";
  const account = card.querySelector(".mail-account");
  if (account) account.disabled = true;
  for (const field of card.querySelectorAll("input, textarea")) {
    field.readOnly = true;
    field.tabIndex = -1;
  }
  for (const remove of card.querySelectorAll(".mail-chip-remove")) remove.remove();
  const state = card.querySelector(".mail-state");
  if (state) state.textContent = "Draft";
  const note = card.querySelector(".mail-note");
  if (note) {
    note.className = "mail-note";
    note.textContent = "From an earlier session. Edit the message above to draft it again.";
  }
  const text = card.querySelector(".mail-account-text");
  if (text) text.textContent = "Draft";
}
