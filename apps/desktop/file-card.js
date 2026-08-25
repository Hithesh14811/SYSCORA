// THE FILE, AS AN OBJECT YOU CAN CLICK.
//
// A run that produced a document ended with a sentence containing a path. The
// user's complaint, 25 Aug 2026: "chatgpt would have done it directly in seconds
// and given a direct file to click and open". They are right, and it is the same
// argument as the email card next door — when the outcome of a turn is a THING
// rather than a paragraph, the transcript should hold the thing.
//
// The buttons do not open anything themselves. They POST to the daemon, which
// will only open a path it has seen a tool report creating; see `openableFiles`
// in apps/daemon/src/server.js. A card is not a licence to open files.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const ICONS = {
  pdf: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M8.4 16.4v-3.6h1.3a1.1 1.1 0 0 1 0 2.2H8.4"/><path d="M12.9 16.4v-3.6h1a1.6 1.6 0 0 1 1.6 1.8 1.6 1.6 0 0 1-1.6 1.8z"/>',
  docx: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M8 12.6l1.2 3.8 1.3-2.8 1.3 2.8 1.2-3.8"/>',
  xlsx: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M8.6 12.8l4 3.8M12.6 12.8l-4 3.8"/>',
  csv: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M7.6 13.4h8M7.6 16.2h8M11 11.6v6.4"/>',
  html: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M9.4 12.8L7.6 14.6l1.8 1.8M13.4 12.8l1.8 1.8-1.8 1.8"/>',
  text: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/><path d="M8 12.6h6M8 15.4h6M8 18h3.6"/>',
  open: '<path d="M14.4 4.6h5v5"/><path d="M19.4 4.6L11 13"/><path d="M18.4 13.6v4.6a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2h4.6"/>',
  folder: '<path d="M3.8 7.6a2.3 2.3 0 0 1 2.3-2.3h3l2 2.4h6.9a2.3 2.3 0 0 1 2.3 2.3v6.7a2.3 2.3 0 0 1-2.3 2.3H6.1a2.3 2.3 0 0 1-2.3-2.3z"/>',
  copy: '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.6"/><path d="M15.4 5.6a2.6 2.6 0 0 0-2.6-2.6H6.2a2.6 2.6 0 0 0-2.6 2.6v6.6a2.6 2.6 0 0 0 2.6 2.6"/>',
  check: '<path d="M4.8 12.6l4.6 4.6L19 6.8"/>'
};

function svg(name, size = 16) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.7");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  // Constants in this file, never anything a model wrote.
  node.innerHTML = ICONS[name] ?? ICONS.text;
  return node;
}

const iconFor = (format) => (ICONS[String(format ?? "").toLowerCase()] ? String(format).toLowerCase() : "text");

const sizeOf = (bytes) => {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} bytes`;
};

/**
 * The card for one file a tool produced. `card` is the `uiCard` from
 * create_document: { path, name, format, bytes, pages, words }.
 */
export function fileCard(card, { fetchImpl = fetch } = {}) {
  const root = el("div", "file-card");

  const chip = el("div", `file-icon fmt-${iconFor(card.format)}`);
  chip.appendChild(svg(iconFor(card.format), 22));

  const body = el("div", "file-body");
  body.appendChild(el("div", "file-name", card.name ?? "Document"));
  // What is IN it, not just how big it is. "3 pages · 1,240 words" is the line
  // that tells someone whether the thing they asked for actually got written;
  // a byte count on its own tells them nothing they can check.
  const facts = [
    String(card.format ?? "").toUpperCase(),
    card.pages ? `${card.pages} page${card.pages === 1 ? "" : "s"}` : null,
    card.words ? `${Number(card.words).toLocaleString()} words` : null,
    sizeOf(card.bytes)
  ].filter(Boolean);
  body.appendChild(el("div", "file-facts", facts.join(" · ")));
  // The folder, because "where did it go" is the other half of the question and
  // the answer must not be a path the reader has to reconstruct from a sentence.
  const folder = String(card.path ?? "").replace(/[\\/][^\\/]*$/, "");
  if (folder) body.appendChild(el("div", "file-path", folder));

  const actions = el("div", "file-actions");
  const note = el("div", "file-note", "");

  const button = (label, icon, handler, className = "") => {
    const control = el("button", `file-button ${className}`.trim());
    control.type = "button";
    control.append(svg(icon), el("span", null, label));
    control.addEventListener("click", handler);
    return control;
  };

  let noteTimer = null;
  const say = (text, tone = "") => {
    clearTimeout(noteTimer);
    note.textContent = text;
    note.className = `file-note ${tone}`.trim();
    if (text) noteTimer = setTimeout(() => { note.textContent = ""; note.className = "file-note"; }, 3200);
  };

  const ask = async (reveal, control) => {
    control.disabled = true;
    try {
      const response = await fetchImpl("/api/files/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: card.path, reveal })
      });
      const json = await response.json().catch(() => ({}));
      // The SERVER's answer, not the request having returned. A 403 here means
      // the daemon has no record of this file being one it made, and saying
      // "opened" over that would be the same lie every tool in this codebase is
      // structured to prevent.
      if (!response.ok || !json.ok) throw new Error(json.error ?? `The daemon answered ${response.status}.`);
      say(reveal ? "Showing it in Explorer." : "Opening it.", "ok");
    } catch (error) {
      say(error?.message ?? String(error), "bad");
    } finally {
      control.disabled = false;
    }
  };

  const open = button("Open", "open", () => ask(false, open), "primary");
  const show = button("Show in folder", "folder", () => ask(true, show));
  const copy = button("Copy path", "copy", async () => {
    try {
      await navigator.clipboard.writeText(card.path);
      say("Path copied.", "ok");
    } catch {
      say("Could not reach the clipboard.", "bad");
    }
  });
  actions.append(open, show, copy);

  root.append(chip, body, actions, note);
  return root;
}

/**
 * A card rebuilt from a saved transcript. The file may have been moved, renamed
 * or deleted since — the buttons still work, and the daemon says so if it is
 * gone — but a card replayed into a NEW session is one this daemon never
 * recorded, so Open would be refused with a message about a file it did not
 * create. That reads as a bug. It says what it is instead.
 */
export function sealReplayedFile(card) {
  for (const button of card.querySelectorAll(".file-button")) {
    if (button.querySelector("span")?.textContent === "Copy path") continue;
    button.disabled = true;
  }
  card.classList.add("replayed");
  const note = card.querySelector(".file-note");
  if (note) note.textContent = "From an earlier conversation — open it from the folder above.";
  return card;
}
