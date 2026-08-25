// SYSCORA chat surface.
//
// A turn is a TRANSCRIPT, not a verdict. The runtime narrates what it is
// deciding, every step it takes runs in front of you with its output, and the
// answer arrives at the end of that — the way you would watch someone work
// rather than being handed a receipt.
//
// What this replaced: a spinner showing one line that was overwritten four times
// a second, then a green "✓ Done" badge over a paragraph. Every reason the agent
// gave for what it was doing was computed, serialized and sent, and thrown away
// here. Nothing about the runtime needed to change for this; the events were
// always on the wire.
//
// No runtime bypass — every action flows through the canonical pipeline, and
// this file only renders what the pipeline reports.

import { readIntentSession } from "./intent-client.js";
// THE MODEL WRITES MARKDOWN AND THIS FILE WAS SHOWING THE ASTERISKS. Every
// answer went on screen through `textContent`, so headings, numbered steps,
// bold names and code blocks all arrived as one wall of characters. See
// markdown.js — it escapes before it builds, because this text comes from a
// model that reads other people's pages.
import { setMarkdown } from "./markdown.js";
// Which model answers, and what the user attached. Both are decided in the
// composer and neither may be guessed at send time — see models.js for why
// "Auto" is a router with a stated reason rather than a silent default.
import { AUTO, MODELS, checkAttachments, selectableModels } from "./models.js";
import { describeAttachments, prepareAttachment, prepareFolder } from "./attachments.js";
// The compose card. The agent drafts; a person sends — see the note at the top
// of email-card.js and the one in apps/daemon/src/gmail.js.
import { emailCard, sealReplayedDraft } from "./email-card.js";
import { fileCard, sealReplayedFile } from "./file-card.js";

const TOKEN_STORAGE_KEY = "syscora_token";
// A KNOWN TOKEN IS NOT A TOKEN.
//
// This used to fall back to a fixed string that the dev launch configuration
// also set as the daemon's real SYSCORA_API_TOKEN — so on any machine started
// that way, the credential guarding an API that can run commands, type into
// windows and delete files was a constant published in this file. Anything able
// to reach 127.0.0.1 could drive the agent with it.
//
// The Electron shell injects the real token in-process (window.syscora), and a
// plain browser gets the Connect panel, which is one paste from the line the
// daemon prints on startup.
let apiToken = (window.syscora && window.syscora.apiToken)
  || sessionStorage.getItem(TOKEN_STORAGE_KEY)
  || null;

const connectPanel = document.getElementById("connectPanel");
const connectForm = document.getElementById("connectForm");
const connectToken = document.getElementById("connectToken");
const connectError = document.getElementById("connectError");
const chatLog = document.getElementById("feed");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const debugToggle = document.getElementById("debugToggle");
const suggestions = document.getElementById("suggestions");
const healthDot = document.getElementById("healthDot");
const healthLabel = document.getElementById("healthLabel");
const healthPill = document.getElementById("healthPill");

function showConnect(message) {
  if (message) { connectError.textContent = message; connectError.hidden = false; }
  else connectError.hidden = true;
  connectPanel.hidden = false;
  connectToken.focus();
}
function hideConnect() { connectPanel.hidden = true; connectError.hidden = true; }
function handleUnauthorized() {
  apiToken = null;
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  showConnect("Token was rejected. Paste the current token from the daemon console.");
}

// Ask for it before the first request rather than after one fails.
if (!apiToken) showConnect();

connectForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = connectToken.value.trim();
  if (!v) return;
  apiToken = v;
  sessionStorage.setItem(TOKEN_STORAGE_KEY, v);
  connectToken.value = "";
  hideConnect();
});

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input?.url ?? "");
  const isApi = url.startsWith("/api/") || url.includes("://127.0.0.1");
  if (isApi && apiToken) init = { ...init, headers: { ...(init.headers || {}), "x-syscora-token": apiToken } };
  const res = await nativeFetch(input, init);
  if (isApi && res.status === 401) handleUnauthorized();
  return res;
};

let debug = false;
debugToggle.addEventListener("change", () => {
  debug = debugToggle.checked;
  document.body.classList.toggle("debug", debug);
});

// ---- Is the daemon actually there? ------------------------------------------

// A network failure and a request that ran and went wrong are different
// problems with different fixes, and telling them apart is the difference
// between "start the daemon" and an hour spent debugging the agent. The browser
// reports an unreachable origin as a TypeError from fetch itself.
function isDaemonUnreachable(error) {
  return error instanceof TypeError
    || /failed to fetch|networkerror|load failed|connection refused/i.test(String(error?.message ?? ""));
}

let daemonReachable = null;
function setDaemonReachable(reachable) {
  if (reachable === daemonReachable) return;
  daemonReachable = reachable;
  healthDot?.classList.toggle("offline", !reachable);
  if (healthLabel) healthLabel.textContent = reachable ? "Ready" : "Daemon not running";
  // The sidebar footer reads the SAME verdict. It is not a second check: two
  // places polling the daemon separately is how you get one of them saying
  // "Ready" while the other says "Not connected", and this product's whole
  // argument is that what it shows you is what it observed.
  const sideStatus = document.getElementById("sideStatus");
  if (sideStatus) {
    sideStatus.textContent = reachable ? "Connected" : "Daemon not running";
    sideStatus.classList.toggle("offline", !reachable);
  }
  // The reading lives in a menu now, so the BAD one has to come out of it. A
  // permanent green "Ready" was noise every day and easy to miss on the one day
  // it mattered; this is the reverse.
  if (healthPill) {
    healthPill.hidden = reachable !== false;
    healthPill.textContent = "Not connected";
    healthPill.title = "The SYSCORA daemon is not answering. Start it with npm run mvp:ui.";
  }
}

async function checkHealth() {
  try {
    const response = await nativeFetch("/api/health", { cache: "no-store" });
    setDaemonReachable(response.ok);
  } catch {
    setDaemonReachable(false);
  }
}
checkHealth();
setInterval(checkHealth, 5000);

// ---- Small DOM helpers -------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function scrollToEnd() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addBubble(role, node) {
  const wrap = el("div", `bubble ${role}`);
  wrap.appendChild(node);
  chatLog.appendChild(wrap);
  scrollToEnd();
  return wrap;
}

function textNode(text) {
  return el("div", null, text);
}

/**
 * Are these two passages the same thing said twice?
 *
 * Word overlap against the SMALLER of the two, not against the union, so a
 * paraphrase that adds a closing sentence — the exact shape the loop's wrap-up
 * produces — still counts as a repeat of the shorter one. Case and punctuation
 * go, because they are what a rewording changes first.
 *
 * BOTH NUMBERS BELOW WERE MEASURED, NOT PICKED. Scored against real pairs out
 * of live transcripts:
 *
 *   the two Jira wrap-up paragraphs        0.60   61/53 words   duplicate
 *   the two email-draft wrap-ups           0.79   42/44 words   duplicate
 *   two long reports on different subjects 0.20   30 words      different
 *   an answer and the next step after it   0.15   33 words      different
 *   "Opening the detailed guide" / "…the
 *    implementation guide"                 0.55   11 words      different
 *
 * The length gate does most of the work and is the reason this is safe. That
 * last row is the trap: two SHORT lines about one task overlap heavily and are
 * different facts, and suppressing one would delete a step from the transcript.
 * Sequential narration is short; a wrap-up repeated is long. Thirty distinct
 * words excludes the whole short band, and 0.58 then sits in open space — the
 * nearest long false positive scores 0.20.
 *
 * A false positive here silently drops something the model said, so the margin
 * matters more than the catch rate. Anything closer than this should be left
 * on screen.
 */
function nearlyTheSame(left, right) {
  const words = (value) => new Set(String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const a = words(left);
  const b = words(right);
  if (Math.min(a.size, b.size) < 30) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.58;
}

/* ---- What you can do to a message that has already been sent ----------------
 *
 * Copy, and — on your own messages — edit. Editing REWINDS: the turn being
 * edited and every turn after it are removed from the transcript and from the
 * stored chat, the model's history is rebuilt from what is left, and the new
 * wording is sent as if it had been typed the first time. That is what makes it
 * an edit rather than a second question about the same thing, and it is the
 * behaviour every chat surface has.
 *
 * The actions are drawn under the message and only appear on hover or keyboard
 * focus: a row of buttons under every line of a long transcript is noise, and
 * one that only exists on hover is invisible to a keyboard, which is why the
 * CSS keys off `:focus-within` too.
 */

/** Say what happened on the button itself, then put it back the way it was. */
function flashAction(button, state, word) {
  if (!button) return;
  const label = button.querySelector(".msg-action-label");
  const was = label?.textContent;
  button.classList.add(state);
  if (label) label.textContent = word;
  setTimeout(() => {
    button.classList.remove(state);
    if (label && was != null) label.textContent = was;
  }, 1500);
}

async function copyText(value, button) {
  const text = String(value ?? "");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard permission can be refused, and in that case saying "Copied"
    // would be exactly the kind of unearned success claim this project does not
    // make. The fallback is the oldest one there is and it works offline.
    const staging = document.createElement("textarea");
    staging.value = text;
    staging.setAttribute("readonly", "");
    staging.style.position = "fixed";
    staging.style.opacity = "0";
    document.body.appendChild(staging);
    staging.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    staging.remove();
    if (!ok) {
      flashAction(button, "failed", "Couldn't copy");
      return false;
    }
  }
  flashAction(button, "done", "Copied");
  return true;
}

function actionButton(label, iconName, onClick) {
  const button = el("button", "msg-action");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(svgIcon(iconName));
  button.appendChild(el("span", "msg-action-label", label));
  button.addEventListener("click", onClick);
  return button;
}

/** The row of actions under a message. `onEdit` is omitted for the assistant. */
function messageActions({ getText, onEdit = null }) {
  const row = el("div", "msg-actions");
  row.appendChild(actionButton("Copy", "copy", (event) => {
    copyText(getText(), event.currentTarget);
  }));
  if (onEdit) row.appendChild(actionButton("Edit", "pencil", onEdit));
  return row;
}

// The user's own words, with the attached file's contents taken back out.
// describeAttachments appends a fenced, labelled block per document; this is
// its inverse, used only for what is DISPLAYED. The model still receives the
// whole thing.
// FOLDER, NOT JUST FILE.
//
// This matched `Attached file:` only, and describeAttachments() also emits
// `--- Attached folder: NAME ---` … `--- end of NAME ---`. So attaching a
// folder put its entire manifest — the path, the file count, and up to forty
// lines of `BotStorm/app/page.tsx` — into the user's OWN bubble, above the two
// words they had typed, and into the stored chat, and into the chat's title.
// The model needs that block; the person who attached the folder already knows
// what is in it and wants to see the folder's name.
function stripAttachmentBlocks(text) {
  return String(text ?? "")
    .replace(/\n\n--- Attached (?:file|folder): [\s\S]*?--- end of .*? ---/g, "")
    .trim();
}

// Search results, parsed back out of the block the tool rendered and drawn as
// links. The shape is fixed by renderResults() in web-search.js:
//
//   1. Title
//      https://url
//      snippet
//
// Anything that does not match that shape falls through to plain text, so a
// change to the tool's rendering degrades to what it used to be rather than
// showing nothing.

// The site a result is on, which is most of how anyone decides whether to trust
// it. A bare URL buries it in front of a query string nobody reads.
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function renderSearchResults(text) {
  const wrap = el("div", "step-output search-results");
  const lines = text.split("\n");
  const header = lines[0]?.trim();
  const hits = [];
  let current = null;
  for (const line of lines.slice(1)) {
    const title = /^\s*\d+\.\s+(.*)$/.exec(line);
    const url = /^\s*(https?:\/\/\S+)\s*$/.exec(line);
    if (title) {
      current = el("div", "search-hit");
      current.dataset.title = title[1];
      hits.push(current);
    } else if (url && current) {
      // The title becomes the link once its URL is known — the anchor needs an
      // href, and the href arrives on the line after the title.
      const anchor = el("a", "search-hit-title", current.dataset.title ?? url[1]);
      anchor.href = url[1];
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      current.prepend(anchor);
      const domain = domainOf(url[1]);
      const badge = el("span", "search-hit-domain");
      // The site's initial in a tile, rather than its favicon. A favicon means a
      // request per result to somebody else's server from a surface that has
      // just told the user everything stays on this machine.
      badge.appendChild(el("span", "search-hit-favicon", domain.slice(0, 1).toUpperCase()));
      badge.appendChild(el("span", null, domain));
      current.appendChild(badge);
    } else if (line.trim() && current) {
      current.appendChild(el("div", "search-hit-snippet", line.trim()));
    }
  }
  // Nothing recognised: show what was actually returned rather than an empty box.
  if (hits.length === 0) return el("pre", "step-output", text.trim());

  // "Sources", the way every assistant that searches labels them — the count is
  // the useful part of the header line, the engine's name is not.
  const count = el("div", "search-sources-head");
  count.appendChild(el("span", null, `Sources · ${hits.length}`));
  if (header) count.appendChild(el("span", "search-provider", header.replace(/^\d+\s+results?\s+for\s+/i, "")));
  wrap.appendChild(count);
  for (const hit of hits) wrap.appendChild(hit);
  return wrap;
}

// ---- Naming things the way a person would -----------------------------------

// A capability identifier is an internal name. `pointer.clickAt` is what the
// runtime calls it; "Clicked" is what happened. The identifier is still shown
// beside it in monospace, because seeing the actual tool is the point — this is
// the label, not a replacement.
const VERB = [
  [/^command\.run$|^developer\.command\.run$/, "Ran"],
  [/^screen\.(read|capture)$|^ocr\./, "Looked at the screen"],
  [/^ui\.(inspect|find|extract|resolveTarget|verifyValue)$/, "Inspected the window"],
  [/^ui\.action$/, "Used a control"],
  [/^pointer\.(click|clickAt)$/, "Clicked"],
  [/^pointer\.wheel$/, "Scrolled"],
  [/^pointer\.(drag|move)$/, "Moved the pointer"],
  [/^keyboard\.type$/, "Typed"],
  [/^keyboard\.press$/, "Pressed a key"],
  [/^clipboard\./, "Used the clipboard"],
  [/^window\./, "Adjusted a window"],
  [/^application\.launch$|^process\.launch$/, "Opened"],
  [/^application\.close$/, "Closed"],
  [/^filesystem\.(read|list|search)$/, "Read from disk"],
  [/^filesystem\.(write|createDirectory|delete)$/, "Wrote to disk"],
  [/^browser\.(navigate|launch|connect)$/, "Opened a page"],
  [/^browser\.(read|extract|find|inspect|currentState|research|search)$/, "Read the page"],
  [/^browser\./, "Used the browser"],
  [/^system\./, "Checked the system"],
  [/^package\./, "Checked packages"],
  [/^spotify\./, "Used Spotify"]
];

// The agent loop's tools are already named the way a person would name them, so
// these are just the past tense.
// A TOOL MISSING FROM HERE IS RENDERED "Ran a step".
//
// Which is worse than it sounds: the transcript exists so the user can follow
// what is happening, and four of the loop's verbs — including the two that draw
// and the one that does everything at once — showed up as an anonymous row.
// Every entry the loop adds needs a line here.
const TOOL_VERB = {
  run: "Ran",
  screen: "Looked at the screen",
  click: "Clicked",
  type: "Typed",
  key: "Pressed",
  scroll: "Scrolled",
  drag: "Dragged",
  draw: "Drew",
  move_mouse: "Moved the pointer",
  launch: "Opened",
  new_document: "Started a new document",
  open_url: "Opened a page",
  windows: "Listed the windows",
  focus: "Focused a window",
  window_state: "Adjusted a window",
  close_app: "Closed",
  read_file: "Read a file",
  write_file: "Wrote a file",
  edit_file: "Edited a file",
  clipboard: "Used the clipboard",
  play_music: "Played",
  volume: "Set the volume",
  search: "Searched the web",
  web_open: "Opened a page",
  web_read: "Read the page",
  web_click: "Clicked on the page",
  web_type: "Typed on the page",
  web_scroll: "Scrolled the page",
  batch: "Ran several steps",
  wait: "Waited",
  github: "Read a repository",
  capability: "Used a saved capability",
  // "Prepared", never "Sent". The row is the transcript's record of what the
  // tool did, and this tool draws a card — see email_draft in tools.js.
  email_draft: "Prepared an email"
};

function verbFor(capability) {
  const name = String(capability ?? "");
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  for (const [pattern, verb] of VERB) if (pattern.test(name)) return verb;
  return "Ran a step";
}

// WHAT IT IS DOING, IN THE PRESENT TENSE, WHILE IT IS DOING IT.
//
// Every row used to be written in the past tense the moment it opened — a search
// that had not answered yet said "Searched the web", which is the same class of
// claim as reporting a message sent while it sits in a box. The row is rewritten
// to the past tense in finishStep, when it has actually finished.
const TOOL_VERB_RUNNING = {
  search: "Searching the web",
  web_open: "Reading the page",
  web_read: "Reading the page",
  run: "Running",
  screen: "Looking at the screen",
  read_file: "Reading the file",
  write_file: "Writing the file",
  launch: "Opening",
  github: "Reading the repository",
  capability: "Using a saved capability",
  email_draft: "Writing an email"
};

// ---- What a tool LOOKS like --------------------------------------------------
//
// These were emoji — 🌐, 📄, 📁 — and emoji are the fastest way to make a
// professional surface look like a hobby project: they are colour pictures from
// a system font, at a different size and weight from everything around them,
// and they cannot be tinted to say whether the step worked. These are line
// icons on the same 24-unit grid as every other icon in this window, drawn in
// `currentColor` so the row's state colours them.
const ICON_PATHS = {
  terminal: '<path d="M5 7.5l4.2 4.5L5 16.5"/><path d="M12.4 16.6h6.4"/>',
  globe: '<circle cx="12" cy="12" r="8.3"/><path d="M3.7 12h16.6"/><path d="M12 3.7c2.1 2.3 3.2 5.2 3.2 8.3S14.1 18 12 20.3C9.9 18 8.8 15.1 8.8 12S9.9 6 12 3.7z"/>',
  file: '<path d="M13.6 3.4H7.2A2.7 2.7 0 0 0 4.5 6.1v11.8a2.7 2.7 0 0 0 2.7 2.7h9.6a2.7 2.7 0 0 0 2.7-2.7V9z"/><path d="M13.6 3.4V9h5.9"/>',
  pencil: '<path d="M16.4 4.6l3 3L9.2 17.8l-4 1 1-4z"/><path d="M14.3 6.7l3 3"/>',
  folder: '<path d="M3.8 7.6a2.3 2.3 0 0 1 2.3-2.3h3l2 2.4h6.9a2.3 2.3 0 0 1 2.3 2.3v6.7a2.3 2.3 0 0 1-2.3 2.3H6.1a2.3 2.3 0 0 1-2.3-2.3z"/>',
  search: '<circle cx="10.9" cy="10.9" r="6.3"/><path d="M15.6 15.6l4.4 4.4"/>',
  screen: '<rect x="3.2" y="4.4" width="17.6" height="12.4" rx="2.4"/><path d="M8.8 20.2h6.4M12 16.8v3.4"/>',
  pointer: '<path d="M6.4 4.2l12.2 6.6-5.3 1.5-2 5.1z"/>',
  keyboard: '<rect x="2.8" y="6.4" width="18.4" height="11.2" rx="2.4"/><path d="M6.6 10h.01M9.9 10h.01M13.2 10h.01M16.5 10h.01M8.4 14h7.2"/>',
  window: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.6"/><path d="M3.2 9.1h17.6"/>',
  music: '<path d="M9.4 18.1V6.4l9.2-1.8v11.5"/><circle cx="6.9" cy="18.1" r="2.5"/><circle cx="16.1" cy="16.1" r="2.5"/>',
  volume: '<path d="M11.5 5.2L6.9 9H3.8v6h3.1l4.6 3.8z"/><path d="M15.6 9.4a3.7 3.7 0 0 1 0 5.2M18.3 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  clock: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.3V12l3.1 1.9"/>',
  git: '<path d="M12 3.2a8.8 8.8 0 0 0-2.8 17.1c.4.1.6-.2.6-.5v-1.8c-2.4.5-3-1.2-3-1.2-.4-1-1-1.3-1-1.3-.8-.6.1-.6.1-.6.9.1 1.4.9 1.4.9.8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.2-1.9-.2-3.9-1-3.9-4.3 0-.9.3-1.7.9-2.3-.1-.2-.4-1.1.1-2.3 0 0 .7-.2 2.4.9a8.3 8.3 0 0 1 4.4 0c1.7-1.1 2.4-.9 2.4-.9.5 1.2.2 2.1.1 2.3.6.6.9 1.4.9 2.3 0 3.3-2 4.1-3.9 4.3.3.3.6.8.6 1.7v2.5c0 .3.2.6.6.5A8.8 8.8 0 0 0 12 3.2z"/>',
  spark: '<path d="M12 3.4l1.9 5.1 5.1 1.9-5.1 1.9L12 17.4l-1.9-5.1L5 10.4l5.1-1.9z"/><path d="M18.4 15.6l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  layers: '<path d="M12 3.6l8.4 4.2-8.4 4.2-8.4-4.2z"/><path d="M3.6 12.2l8.4 4.2 8.4-4.2"/><path d="M3.6 16.4l8.4 4.2 8.4-4.2"/>',
  image: '<rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.8"/><circle cx="8.7" cy="10" r="1.6"/><path d="M3.6 16.6l4.2-4a2 2 0 0 1 2.7 0l6.1 5.8M14.4 14l1.6-1.5a2 2 0 0 1 2.7 0l1.9 1.7"/>',
  close: '<path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/>',
  copy: '<rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.6"/><path d="M15.4 5.6a2.6 2.6 0 0 0-2.6-2.6H6.2a2.6 2.6 0 0 0-2.6 2.6v6.6a2.6 2.6 0 0 0 2.6 2.6"/>',
  send: '<path d="M12 19V5.6M5.8 11.8L12 5.4l6.2 6.4"/>',
  mail: '<rect x="3" y="5.2" width="18" height="13.6" rx="2.6"/><path d="M3.6 7l7.3 5.3a2 2 0 0 0 2.2 0L20.4 7"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 6.8"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  warn: '<path d="M12 4.4l8.4 14.6H3.6z"/><path d="M12 10v3.6M12 16.6h.01"/>',
  hourglass: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.6V12l2.8 1.7"/>',
  // The five verbs a chat has. `pin` is drawn filled by CSS when the chat is
  // pinned — an outline and a fill of the same shape is how every list says
  // "this one is", and it needs no second icon.
  download: '<path d="M12 4v11M7.4 10.4L12 15l4.6-4.6"/><path d="M4.6 18.4h14.8"/>',
  pin: '<path d="M12 14.2v6.2"/><path d="M9 3.6h6l-.8 5.2 2.6 2.6H7.2l2.6-2.6z"/>',
  archive: '<rect x="3.2" y="4.4" width="17.6" height="4.2" rx="1.4"/><path d="M5 8.6v9a2.2 2.2 0 0 0 2.2 2.2h9.6A2.2 2.2 0 0 0 19 17.6v-9"/><path d="M10 12.4h4"/>',
  report: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.8v5M12 16.2h.01"/>',
  // Filled, unlike everything else here: three 1.7px rings at this size are
  // three smudges. `fill="currentColor"` is set on the paths themselves so the
  // shared svgIcon() stroke settings do not have to know about it.
  dots: '<circle cx="5.5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  delete: '<path d="M4.6 6.6h14.8"/><path d="M9.4 6.6V4.8a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8"/><path d="M6.6 6.6l.9 12a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.9-12"/>',
  cog: '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 0 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3.4a1.9 1.9 0 0 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A1.9 1.9 0 1 1 7.3 4.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3.6a1.9 1.9 0 0 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 0 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z"/>'
};

// Both naming generations map into the same set: the agent loop's short names
// and the older dotted capability ids. A tool with no entry gets the cog, which
// is honest — it says "a step ran" without pretending to describe it.
const TOOL_ICON = {
  run: "terminal", batch: "layers", wait: "clock",
  search: "search",
  web_open: "globe", web_read: "globe", web_click: "globe", web_type: "globe",
  web_scroll: "globe", open_url: "globe",
  github: "git", capability: "spark",
  read_file: "file", write_file: "file", edit_file: "pencil", new_document: "file",
  clipboard: "file",
  screen: "screen",
  click: "pointer", move_mouse: "pointer", drag: "pointer", scroll: "pointer",
  type: "keyboard", key: "keyboard",
  draw: "pencil",
  launch: "window", close_app: "window", windows: "window", focus: "window", window_state: "window",
  play_music: "music", volume: "volume",
  email_draft: "mail"
};

const TOOL_ICON_PATTERNS = [
  [/^command\.run$|^developer\.command\.run$/, "terminal"],
  [/^screen\.|^ocr\./, "screen"],
  [/^ui\./, "window"],
  [/^pointer\./, "pointer"],
  [/^keyboard\./, "keyboard"],
  [/^clipboard\./, "file"],
  [/^window\./, "window"],
  [/^application\.|^process\./, "window"],
  [/^filesystem\.(read|list|search)$/, "file"],
  [/^filesystem\./, "folder"],
  [/^browser\.(search|research)$/, "search"],
  [/^browser\./, "globe"],
  [/^system\.|^package\./, "cog"],
  [/^spotify\./, "music"]
];

function iconNameFor(capability) {
  const name = String(capability ?? "");
  if (TOOL_ICON[name]) return TOOL_ICON[name];
  for (const [pattern, icon] of TOOL_ICON_PATTERNS) if (pattern.test(name)) return icon;
  return "cog";
}

/** One 24-grid line icon, as an <svg>. `name` must be a key of ICON_PATHS. */
function svgIcon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  // innerHTML on an SVG element is namespace-correct in every browser this
  // ships in, and these strings are constants in this file — never input.
  svg.innerHTML = ICON_PATHS[name] ?? ICON_PATHS.cog;
  return svg;
}

// The outcome, drawn rather than typed. `✓` and `✗` came from whatever font the
// system offered and sat on a different baseline from the text beside them.
const STATE_ICON = { ok: "M4.8 12.6l4.6 4.6 9.8-10.4", bad: "M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" };

function stateIcon(state) {
  const wrap = el("span", `step-state ${state}`);
  if (state === "ok" || state === "bad") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<path d="${STATE_ICON[state]}"/>`;
    wrap.appendChild(svg);
  }
  // `unknown` is a drawn dot: the run ended without this step reporting, and
  // that is a third state, not a failure. See settle().
  return wrap;
}

/** Put a step's outcome marker in place, replacing whatever was there. */
function setStepState(head, state) {
  if (!head) return;
  head.querySelector(".step-state")?.remove();
  head.appendChild(stateIcon(state));
}

function runningVerbFor(capability) {
  return TOOL_VERB_RUNNING[String(capability ?? "")] ?? verbFor(capability);
}

// BEFORE IT RUNS IS A THIRD TENSE, AND IT IS NOT "RUNNING".
//
// A pending row is drawn while the model is still WRITING the call — nothing has
// touched the machine, so "Writing the file" would be the same class of claim as
// a message reported sent while it sits in a box. These say what is actually
// happening, which is that the model is composing something.
const TOOL_VERB_PENDING = {
  write_file: "Composing the file",
  edit_file: "Composing the edit",
  new_document: "Composing the document",
  email_draft: "Composing the email",
  run: "Composing the command",
  type: "Composing the text",
  draw: "Composing the strokes",
  batch: "Composing several steps"
};

function pendingVerbFor(capability) {
  return TOOL_VERB_PENDING[String(capability ?? "")] ?? "Preparing";
}

/** How much of the call has been written so far. Bytes of JSON, said plainly. */
function sizeSoFar(bytes) {
  const size = Number(bytes) || 0;
  return size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} bytes`;
}

// The one argument worth showing next to the tool name. A command line is the
// whole story; a click is a coordinate; a type is the text. Anything else falls
// back to the first short string argument, and to nothing at all rather than a
// wall of JSON.
function argSummary(capability, inputs) {
  const i = inputs ?? {};
  if (i.command) return String(i.command);
  if (i.text) return JSON.stringify(String(i.text).slice(0, 120));
  if (i.url) return String(i.url);
  if (i.query) return String(i.query);
  if (i.application) return String(i.application);
  if (i.path || i.directoryPath) return String(i.path ?? i.directoryPath);
  if (i.keys) return String(i.keys);
  if (Number.isFinite(i.x) && Number.isFinite(i.y)) return `(${i.x}, ${i.y})`;
  if (i.notches != null) return `${i.notches} notches`;
  const firstString = Object.entries(i)
    .find(([, value]) => typeof value === "string" && value.length > 0 && value.length < 80);
  return firstString ? String(firstString[1]) : "";
}

// One line of the plan. The model names the first step and usually leaves the
// rest unnamed, so falling back to the capability alone renders a plan reading
// "command.run, command.run, command.run" — five identical lines describing
// five different commands. The argument is what distinguishes them.
function planLabel(step) {
  if (typeof step === "string") return step;
  const capability = step?.capability ?? "";
  const arg = argSummary(capability, step?.inputs);
  if (step?.label) return arg && !String(step.label).includes(arg) ? `${step.label} — ${arg}` : String(step.label);
  return arg ? `${verbFor(capability)}: ${arg}` : (capability || "a step");
}

function riskWord(level) {
  return { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" }[level] ?? (level ?? "Unknown");
}

// ---- The live turn -----------------------------------------------------------

// One of these owns everything rendered for a single request. It is append-only
// on purpose: a line that was true when it was written stays on screen, because
// a transcript that rewrites itself is not a transcript.
class Turn {
  constructor() {
    this.root = el("div", "turn");
    chatLog.appendChild(this.root);
    // "CONNECTING", NOT "THINKING", UNTIL SOMETHING IS ACTUALLY THINKING.
    //
    // This line used to read "Thinking…" from the instant the request left the
    // box. Measured against the configured endpoint on 21 Aug 2026
    // (`node scripts/probe-reasoning-stream.mjs`): the first byte comes back at
    // 631ms and the first reasoning token at 1,430ms. So for the first second
    // and a half the word "thinking" described a request sitting on a wire — and
    // on a slow or dead connection it described nothing at all, which is exactly
    // when the user most needs to be able to tell the difference between a model
    // that is working and a network that is not.
    this.status = el("div", "turn-status", "Connecting…");
    this.root.appendChild(this.status);
    // Alive until settle(). See startWorking().
    this.working = null;
    this.startWorking();
    this.thinking = null;
    this.reasoning = "";
    this.pendingSteps = [];
    // Rows for calls the model is still WRITING, keyed by their index in the
    // turn. Not the same thing as `pendingSteps`, which is calls that have
    // started running. See streamingStep.
    this.streamingSteps = new Map();
    this.streamingRoundOver = false;
    this.sawNarration = false;
    // The last observation drawn, so an identical one is not drawn again — see
    // the note in say().
    this.lastObserved = null;
    // The adaptive loop executes each of its actions THROUGH the task graph, so
    // one action emits both ADAPTIVE_ACTION_* and TASK_* — the same step under
    // two names, at two levels. Rendering both drew every tool call twice: once
    // with its argument and result, and again as a bare "Ran command.run".
    // The static route emits only TASK_*, so it still renders; once an adaptive
    // action has been seen, TASK_* is understood as its inner execution.
    this.usesAdaptiveSteps = false;
    scrollToEnd();
  }

  // The single transient line. It says what the runtime is doing before the
  // model has said anything itself, and disappears the moment it has.
  setStatus(text) {
    this.working?.say(text);
    if (!this.status) return;
    this.status.textContent = text;
    scrollToEnd();
  }

  clearStatus() {
    this.status?.remove();
    this.status = null;
  }

  // ONE OBJECT THAT SAYS THE MACHINE IS ALIVE, AND STOPS WHEN IT IS NOT.
  //
  // The transient status line above is removed the moment the model says
  // anything, which is usually two seconds in — so for the remaining fifty
  // seconds of a real run nothing on screen was moving, and a run that had
  // stalled looked exactly like a run that was working. This is deliberately
  // NOT that line: it belongs to the whole turn, it carries the elapsed time,
  // and it is removed in settle(), which is the one place a run genuinely ends.
  //
  // "8 seconds, reading the screen" is worth something; a spinner is not. The
  // seconds are the part people actually use — they are how you tell thinking
  // from stuck.
  startWorking() {
    const wrap = el("div", "working");
    const ball = el("div", "glass-ball");
    ball.setAttribute("aria-hidden", "true");
    // THREE LAYERS, NOT TWO PSEUDO-ELEMENTS. The film on the rim, the refracted
    // core, and the fixed highlight each move on their own cycle — the core has
    // to turn independently of the film or the whole thing reads as one object
    // spinning, which is what the old marble looked like. Pseudo-elements only
    // give you two, and the third is the one that sells it. See PASS 13.
    for (const layer of ["orb-film", "orb-core", "orb-core-2", "orb-gloss"]) ball.appendChild(el("span", layer));
    // THE SAME WORD AS THE STATUS LINE, so the two are never on screen saying
    // different things. They said "Connecting…" and "Working…" one under the
    // other for the first second and a half of every request; the status line
    // is now hidden while this row exists (see `.turn:has(.working)` in
    // demo.css) and this is the one that speaks.
    const label = el("span", "working-label", "Connecting…");
    const time = el("span", "working-time", "");
    wrap.append(ball, label, time);
    // Announced once, politely: a live region that re-reads every tick would
    // talk over the answer it is waiting for.
    wrap.setAttribute("role", "status");
    this.root.appendChild(wrap);

    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      time.textContent = seconds >= 1 ? `${seconds}s` : "";
    };
    // A run that somehow never settles must not leave an interval running for
    // the life of the window. Ten minutes is far past every measured run.
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 600_000) return this.working?.stop();
      tick();
    }, 1000);

    this.working = {
      // IT HAS TO BE THE LAST THING, NOT THE FIRST. Appended when the turn is
      // created, it stayed where it was put while steps and text piled up
      // underneath — so on a real run the one live object on screen was a
      // screenful above the work it was describing, and scrolled out of sight
      // entirely. Moved to the end after every append; appendChild on a node
      // that is already in the tree MOVES it, so this costs nothing.
      wrap,
      // Guarded: streamDelta sets this on every token, and writing the same
      // string back into the DOM a hundred times a second is churn for nothing.
      say: (text) => { if (text && label.textContent !== text) label.textContent = text; },
      // IT STAYS, STOPPED. The row used to be removed the moment a run settled,
      // so the one object that had been on screen for the whole turn vanished at
      // the exact moment the answer arrived — the transcript twitched, and the
      // thing that had been telling you it was alive left no trace that it had
      // ever run. It is now frozen in place: the sphere stops turning, the
      // word goes, and the time it took stays, because how long it took is a
      // fact about the turn and the only part of this row worth keeping.
      //
      // The NEXT message builds its own Turn and its own row, so a new sphere
      // starts from the beginning without anything having to reset this one.
      stop: () => {
        clearInterval(timer);
        tick();
        wrap.classList.add("done");
        // Removed rather than left saying "Working…" next to a finished answer,
        // which is the small lie that reads as a stuck interface.
        label.remove();
        // No longer a live region: it has nothing left to announce, and a status
        // role on a settled row makes screen readers re-read it.
        wrap.removeAttribute("role");
        this.working = null;
      }
    };
  }

  // THE MODEL'S OWN REASONING, STREAMED, BEHIND A DISCLOSURE ARROW.
  //
  // Only ever fed from AGENT_REASONING — the endpoint's `reasoning_content`
  // channel, which is separate from the answer all the way down. Nothing here
  // paraphrases or invents: if the model sends no reasoning, no block appears,
  // because a "thinking" panel with made-up contents is worse than none.
  //
  // Collapsed by default and grey, like every other chat surface, because this
  // is scratch work and the answer is what the user came for.
  // A TURN THINKS MORE THAN ONCE, AND EVERY ROUND NEEDS ITS OWN BOX.
  //
  // The box was created once and then reused for the whole turn. So the second
  // round of thinking — after the first tool has run, which is where most of a
  // task's reasoning happens — was appended to a block that had already been
  // SEALED: collapsed, greyed, labelled "Thought for a moment", and sitting a
  // screenful above at the top of the turn. Live, 25 Aug 2026: the row read
  // "Thinking… 59s" beside a turning sphere with nothing on screen to open, for
  // a minute, which is indistinguishable from a dead connection. The model was
  // in fact thinking the whole time and every word of it was being written into
  // a collapsed box nobody could see was growing.
  streamReasoning(text) {
    if (!text) return;
    // The first reasoning token is the moment thinking genuinely starts. Before
    // it, the status line says "Connecting…" and means it.
    this.setStatus("Thinking…");
    // A sealed box is a finished thought. The next token belongs to a new one.
    if (this.thinking?.classList.contains("done")) this.thinking = null;
    if (!this.thinking) {
      const box = el("details", "thinking-box");
      const summary = el("summary", "thinking-summary", "Thinking");
      box.appendChild(summary);
      this.thinkingBody = el("div", "thinking-body");
      box.appendChild(this.thinkingBody);
      this.root.appendChild(box);
      this.keepWorkingLast();
      this.thinking = box;
      this.reasoning = "";
    }
    this.reasoning += text;
    this.thinkingBody.textContent = this.reasoning;
    // Follow the stream only while it is open; scrolling a collapsed block
    // yanks the page around for something nobody is looking at.
    if (this.thinking.open) scrollToEnd();
  }

  // Thinking is over the moment the answer starts, or the moment a tool call
  // does. The block stays on screen — it is a transcript, not a spinner — but it
  // stops claiming to be live, and the next round gets a box of its own.
  sealReasoning() {
    if (!this.thinking) return;
    this.thinking.classList.add("done");
    const summary = this.thinking.querySelector(".thinking-summary");
    if (summary) summary.textContent = "Thought for a moment";
  }

  // The model talking, one token at a time. This is the first thing on screen
  // and it arrives while the tools it is describing are already running — the
  // whole reason the loop streams at all.
  //
  // IT IS FORMATTED AS IT ARRIVES, NOT REFLOWED AT THE END.
  //
  // This used to append to `textContent` and parse once, in _closeStream. Ask
  // for a script and you watched a minute of unindented grey text with ``` in
  // the middle of it, and then the whole reply jumped as it re-laid itself out.
  // The original reason was flicker — an unterminated fence parses as a
  // paragraph until its closing fence arrives — and renderMarkdownStreaming
  // removes that reason by closing the open fence itself. See markdown.js.
  streamDelta(text) {
    this.clearStatus();
    // Not "Thinking…" — the answer is arriving, and it is on screen underneath.
    this.setStatus("Writing…");
    this.sealReasoning();
    this.sawNarration = true;
    if (!this.streamNode) {
      const block = el("div", "agent-says streaming");
      this.streamBlock = block;
      // Both classes: `md` carries the spacing and the code-block styling, and
      // `md-streaming` only marks it as still arriving (the caret, and nothing
      // else). The raw text is kept in a field rather than read back off the
      // node, because the node no longer holds the source once it is parsed.
      this.streamNode = el("div", "md md-streaming", "");
      this.streamText = "";
      block.appendChild(this.streamNode);
      this.root.appendChild(block);
      this.keepWorkingLast();
    }
    this.streamText += text;
    this._paintStream();
  }

  // ONE PAINT PER FRAME, NOT ONE PER TOKEN.
  //
  // The endpoint delivers around 107 tokens a second and re-parsing a long
  // answer that often is work nobody sees. Coalescing on rAF also means the
  // browser never lays out a half-written line: what is painted is whatever had
  // arrived when the frame came round.
  _paintStream() {
    if (!this.streamNode || this.streamPaint) return;
    this.streamPaint = requestAnimationFrame(() => {
      this.streamPaint = null;
      if (!this.streamNode) return;
      setMarkdown(this.streamNode, this.streamText, { streaming: true });
      scrollToEnd();
    });
  }

  // Close the streaming block. The complete message arrives separately once the
  // model finishes its turn; when it matches what was already streamed there is
  // nothing left to draw.
  _closeStream(finalText) {
    if (!this.streamNode) return false;
    // A frame that fires after this would repaint a node that is no longer the
    // live one, and would do it from `streamText` belonging to the next turn.
    if (this.streamPaint) { cancelAnimationFrame(this.streamPaint); this.streamPaint = null; }
    const streamed = String(this.streamText ?? "").trim();
    this.streamBlock?.classList.remove("streaming");
    // The last paint may have been mid-fence, with a closing fence this file
    // supplied. Now the text is genuinely complete, so it is parsed as written.
    if (streamed) {
      setMarkdown(this.streamNode, streamed);
      this.streamNode.classList.remove("md-streaming");
    }
    if (!streamed) this.streamBlock?.remove();
    this.streamNode = null;
    this.streamBlock = null;
    this.streamText = "";
    return Boolean(streamed) && streamed === String(finalText ?? "").trim();
  }

  // The model's own words.
  say(text, { detail = null, steps = [], observed = null } = {}) {
    this.clearStatus();
    this.throttleNode = null;
    this.sawNarration = true;
    // THE SAME PARAGRAPH, REWORDED, IS STILL THE SAME PARAGRAPH.
    //
    // The loop asks twice near the end of a run — once through the
    // looksUnfinished nudge, once when it asks for the answer outright — and a
    // model that has nothing new to add answers both. Live, 25 Aug 2026: "I
    // searched this machine and found no Jira installation… the draft is still
    // on screen, unsent" was printed, then printed again as a paraphrase four
    // lines below itself, then a third time inside the Partly-done card.
    //
    // The exact-match guard below (`_closeStream`) never saw these because they
    // were not exact. Word overlap does, and it is deliberately blind to short
    // lines: "Done." following "Done." is two real steps reporting, not a
    // repetition worth suppressing.
    if (text && nearlyTheSame(text, this.lastSaid) && !detail && !observed && steps.length <= 1) {
      this.lastSaid = text;
      this._closeStream(text);
      return;
    }
    this.lastSaid = text;
    if (this._closeStream(text) && !detail && !observed && steps.length <= 1) return;
    const block = el("div", "agent-says");
    // What it just read, before what it intends to do about it. This ordering is
    // the point: the observation is the evidence for the action, and a reader
    // should be able to disagree with the second line on the strength of the
    // first.
    //
    // THE SAME OBSERVATION IS NOT WORTH SAYING TWICE. When one turn issues
    // several tool calls, each carries the model's `saw` field, and the model
    // quite reasonably repeats itself — nothing new has been observed between
    // two searches issued together. A live transcript, 24 Aug 2026, printed
    // "The user asked me to find tech internships that sponsor J-1 visas…"
    // verbatim before each of two searches, and the same CETUSA sentence twice
    // more further down. Suppressed only when it is IDENTICAL to the one above
    // it: a genuinely new observation, even a similar one, still gets said.
    if (observed && observed !== this.lastObserved) {
      block.appendChild(el("p", "agent-observed", observed));
    }
    if (observed) this.lastObserved = observed;
    // The answer is the one place structure matters most, so it is the one
    // place markdown is rendered rather than shown.
    if (text) setMarkdown(block.appendChild(el("div", "md")), text);
    if (detail) block.appendChild(el("p", "agent-detail", detail));
    if (steps.length > 1) {
      const list = el("ol", "plan");
      for (const step of steps) list.appendChild(el("li", null, planLabel(step)));
      block.appendChild(list);
    }
    this.root.appendChild(block);
    this.keepWorkingLast();
    scrollToEnd();
  }

  note(text) {
    this.throttleNode = null;
    this.root.appendChild(el("div", "turn-note", text));
    this.keepWorkingLast();
    scrollToEnd();
  }

  // Being rate-limited produces one event per retry, and rendering each as its
  // own line filled the transcript with the same sentence three and four times
  // between every step — which reads as the app having broken rather than as one
  // wait. Collapse them into a single line that counts up.
  throttled(waitMs) {
    this.throttleMs = (this.throttleNode ? this.throttleMs : 0) + (Number(waitMs) || 0);
    if (!this.throttleNode) {
      this.throttleNode = el("div", "turn-note", "");
      this.root.appendChild(this.throttleNode);
      this.keepWorkingLast();
    }
    this.throttleNode.textContent =
      `Waiting on the model provider's rate limit — ${(this.throttleMs / 1000).toFixed(1)}s so far.`;
    scrollToEnd();
  }

  // THE ROW APPEARS WHILE THE CALL IS BEING WRITTEN, NOT WHEN IT RUNS.
  //
  // A tool call is streamed like everything else, but the loop only hands it
  // over once the whole turn has arrived — so between "I'll build the three
  // files" and the first row of the write, the screen showed nothing at all.
  // For `run` that gap is a fraction of a second. For `write_file` the argument
  // IS the file, so the gap is however long the file takes to generate: 59
  // seconds, measured live on 25 Aug 2026, with a timer ticking beside a sphere
  // and no row on screen to say what it was ticking for.
  //
  // What this row may say is limited on purpose. The call has not run, so it
  // claims nothing about the machine — only what the MODEL is doing, which is
  // the one thing we have direct evidence of, and how much of it there is so
  // far. It is replaced by the real row in startStep below.
  streamingStep({ index, callId, tool, bytes }) {
    this.clearStatus();
    // The live row said "Thinking…" through all of this, left over from the last
    // reasoning token, and nothing was thinking — it was writing a file. The
    // word beside the sphere is the only thing a lot of people read.
    this.setStatus(pendingVerbFor(tool));
    // A new round of calls follows a round that has already started executing.
    // Anything still pending from the last one was never claimed — a call whose
    // arguments failed to parse, or a run that stopped at its step budget — and
    // leaving it on screen would show a step that is never going to happen.
    if (this.streamingRoundOver) this._dropPendingRows();
    this.streamingRoundOver = false;

    let row = this.streamingSteps.get(index);
    if (!row) {
      const node = el("div", `step pending tool-${String(tool ?? "").replace(/[^a-z_]/gi, "")}`);
      const head = el("div", "step-head");
      const chip = el("span", "step-icon");
      chip.appendChild(svgIcon(iconNameFor(tool)));
      head.append(chip, el("span", "step-verb", pendingVerbFor(tool)), el("code", "step-tool", tool));
      const size = el("span", "step-pending-size", "");
      head.appendChild(size);
      node.appendChild(head);
      this.root.appendChild(node);
      this.keepWorkingLast();
      row = { node, size, tool, callId };
      this.streamingSteps.set(index, row);
    }
    row.callId = callId ?? row.callId;
    // Only once there is enough of it for the number to mean anything — "12 B
    // so far" beside a file is noise, and a counter that starts at zero and
    // stays there for a second reads as stuck.
    row.size.textContent = bytes > 400 ? `${sizeSoFar(bytes)} so far` : "";
    scrollToEnd();
  }

  /** Every pending row that no tool call ever claimed. */
  _dropPendingRows() {
    for (const row of this.streamingSteps.values()) row.node.remove();
    this.streamingSteps.clear();
  }

  /**
   * The pending row this call was being written into, if there is one. Matched
   * on the tool NAME rather than the call id: the id is present in the stream
   * for the endpoints measured here, but it is optional in the wire format and
   * a row that fails to match would be left orphaned on screen.
   */
  _claimPendingRow(capability) {
    for (const [index, row] of this.streamingSteps) {
      if (row.tool !== capability) continue;
      this.streamingSteps.delete(index);
      return row.node;
    }
    return null;
  }

  // A tool call, rendered the moment it starts and resolved in place when it
  // finishes. `key` is whatever the runtime will quote back on completion.
  startStep({ key, capability, inputs, subgoal, arg: explicitArg }) {
    this.clearStatus();
    this.throttleNode = null;
    this._closeStream(null);
    // Whatever is still pending belongs to the round now executing; the next
    // TOOL_STREAMING starts a fresh one. See streamingStep.
    this.streamingRoundOver = true;
    // A tool call ends the round of thinking that produced it, so the next
    // reasoning token opens a box of its own rather than growing a sealed one.
    this.sealReasoning();
    // A STEP IS A SUMMARY THAT CAN BE OPENED, NOT A WALL THAT IS ALWAYS OPEN.
    //
    // Every command's full output, every screen reading and every page dump was
    // printed in the transcript at full height. Reading back a conversation
    // meant scrolling past thousands of lines of PowerShell to find the two
    // sentences that mattered. The evidence still has to be THERE — that is the
    // whole argument of this product — but it does not have to be in the way.
    //
    // <details> rather than a click handler: the browser gives keyboard access,
    // find-in-page that opens the section containing a hit, and correct
    // semantics for a screen reader, none of which a div and an onclick do.
    const step = el("details", `step running tool-${String(capability ?? "").replace(/[^a-z_]/gi, "")}`);
    const head = document.createElement("summary");
    head.className = "step-head";
    // The tool's own icon, in a chip that stays for the life of the row. The
    // OUTCOME is a separate marker at the other end (see setStepState), because
    // overwriting the picture of what ran with a tick throws away the one thing
    // that makes a stack of ten rows scannable.
    const chip = el("span", "step-icon");
    chip.appendChild(svgIcon(iconNameFor(capability)));
    head.appendChild(chip);
    head.appendChild(el("span", "step-verb", subgoal || runningVerbFor(capability)));
    head.appendChild(el("code", "step-tool", capability));
    const arg = explicitArg || argSummary(capability, inputs);
    if (arg) head.appendChild(el("code", "step-arg", arg));
    // Drawn by CSS from the open/closed state, so it can never disagree with it.
    head.appendChild(el("span", "step-chevron", ""));
    step.appendChild(head);
    // OPEN WHILE IT RUNS, CLOSED ONCE IT WORKED.
    //
    // Closed-always would hide the progress bar of a `winget install` that runs
    // for a minute, and "is this downloading or hung" is the one thing a person
    // watching an install wants to know. So it is open while there is something
    // to watch and collapses itself when it succeeds. A step that FAILED stays
    // open — see finishStep — because that output is the reason to look.
    step.open = true;
    // IN THE PLACE THE PENDING ROW WAS STANDING, not underneath it. A turn that
    // asked for three files draws three pending rows as it writes them, and
    // appending the real rows below would give the reader six rows for three
    // steps and no way to tell which was which.
    const placeholder = this._claimPendingRow(capability);
    if (placeholder) placeholder.replaceWith(step); else this.root.appendChild(step);
    this.keepWorkingLast();
    this.pendingSteps.push({ key, capability, node: step, head });
    scrollToEnd();
    return step;
  }

  // A LONG COMMAND, SHOWN MOVING.
  //
  // `winget install` runs for the better part of a minute and printed its byte
  // count the whole way; the transcript showed a spinner. There was nothing on
  // screen to tell a download in progress from a hung command, which is the one
  // thing a person watching an install wants to know.
  //
  // The bar is drawn INSIDE the step it belongs to, under the command line, so
  // it reads as "this is how far that has got" rather than as a separate event.
  // It is created on the first report rather than on every step, because most
  // steps never have one.
  progressStep({ key, capability, percent, label, phase }) {
    const pending = this.pendingSteps.find((step) => (key != null && step.key === key))
      ?? this.pendingSteps.find((step) => step.capability === capability);
    if (!pending) return;
    if (!pending.progress) {
      const wrap = el("div", "step-progress");
      const track = el("div", "progress-track");
      const fill = el("div", "progress-fill");
      track.appendChild(fill);
      const text = el("div", "progress-label", "");
      wrap.appendChild(track);
      wrap.appendChild(text);
      pending.node.appendChild(wrap);
      pending.progress = { wrap, track, fill, text };
    }
    const { fill, track, text } = pending.progress;
    const known = Number.isFinite(Number(percent));
    // A phase with no measurable percentage — "Verifying" — is honest as an
    // indeterminate bar. Claiming a number nobody reported would be a lie about
    // how far along it is, and this row exists to be believed.
    track.classList.toggle("indeterminate", !known);
    if (known) fill.style.width = `${Math.max(0, Math.min(100, Number(percent)))}%`;
    text.textContent = [phase, label].filter(Boolean).join(" — ")
      || (known ? `${Math.round(Number(percent))}%` : "Working…");
    scrollToEnd();
  }

  // Match a completion to the row it belongs to. Prefer the exact key the
  // runtime quoted; fall back to the oldest unresolved row for that capability,
  // then to the oldest unresolved row at all — a completion with no row is worse
  // than a completion on an approximate row, because it vanishes.
  _takeStep(key, capability) {
    let index = this.pendingSteps.findIndex((step) => key != null && step.key === key);
    if (index === -1) index = this.pendingSteps.findIndex((step) => step.capability === capability);
    if (index === -1) index = 0;
    return this.pendingSteps.splice(index, 1)[0] ?? null;
  }

  finishStep({ key, capability, ok, message, preview, durationMs }) {
    const pending = this._takeStep(key, capability);
    // The command's own output is a better answer than the bar that was
    // standing in for it, so the bar goes when the output arrives.
    pending?.progress?.wrap?.remove();
    const step = pending?.node ?? this.startStep({ key, capability, inputs: {} });
    const head = pending?.head ?? step.querySelector(".step-head");
    step.classList.remove("running");
    step.classList.add(ok ? "ok" : "bad");
    setStepState(head, ok ? "ok" : "bad");
    // Present tense to past, now that it genuinely IS past. A row left saying
    // "Searching the web" beside a tick is a small lie that reads as a stuck UI.
    const verb = head?.querySelector(".step-verb");
    if (verb && verb.textContent === runningVerbFor(capability)) verb.textContent = verbFor(capability);
    if (Number.isFinite(durationMs) && durationMs >= 1000) {
      head?.appendChild(el("span", "step-time", `${(durationMs / 1000).toFixed(1)}s`));
    }
    // The output. This is the part that makes a step believable, so it is shown
    // rather than summarized away — trimmed, and scrollable when it is long.
    const body = preview || (ok ? null : message);

    // WHAT IT FOUND, WITHOUT HAVING TO OPEN ANYTHING.
    //
    // A step that succeeded collapses (below), so a settled row said only which
    // tool ran and with what — the ANSWER, which is the whole reason the row is
    // in the transcript, needed a click. Ten collapsed rows in a research turn
    // meant ten clicks to learn anything, so nobody clicked, so the evidence
    // this product is built on went unread.
    //
    // One line, in the head, beside the argument: `git version 2.45.0`,
    // `31 files`, `HTTP 200, 5,945 bytes`. The full output is still one click
    // away and a FAILED step still opens itself, because that output is the
    // reason the reader is there.
    const firstLine = String(body ?? "").split("\n").map((line) => line.trim()).find(Boolean);
    if (ok && firstLine && head) {
      head.appendChild(el("span", "step-result", firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine));
    }
    if (body && capability === "search" && ok) {
      // A SEARCH RESULT IS A LINK, AND A LINK IS FOR CLICKING.
      //
      // Rendered as a <pre> like a command's stdout, ten results are ten lines
      // of unclickable text and the user has to retype a URL to follow one.
      step.appendChild(renderSearchResults(String(body)));
    } else if (body) {
      const out = el("pre", "step-output", String(body).trim());
      step.appendChild(out);
    } else if (!ok && message) {
      step.appendChild(el("div", "step-error", message));
    }
    // Collapse what worked; leave open what did not. A failed step's output is
    // the reason the reader is here.
    if (step.tagName === "DETAILS") step.open = !ok;
    scrollToEnd();
  }

  // Anything still running when the turn ends did not report a result. Say that
  // rather than leaving a spinner on screen forever.
  settle() {
    this.clearStatus();
    // The one place a run really ends — every path to a finished turn comes
    // through here, including the failures.
    this.working?.stop();
    this._closeStream(null);
    // A call the model was still writing when the run ended never became a step
    // and never will. It is not an "unknown" outcome — nothing was attempted —
    // so the row goes rather than being marked.
    this._dropPendingRows();
    for (const pending of this.pendingSteps) {
      pending.node.classList.remove("running");
      pending.node.classList.add("unknown");
      setStepState(pending.head, "unknown");
    }
    this.pendingSteps = [];
  }

  // ONE CLICK, IN THE PLACE THEY ARE ALREADY LOOKING.
  //
  // Only for the handful of things that cannot be undone — deleting files,
  // uninstalling, stopping a service, restarting the machine. It shows the exact
  // command rather than a description of it, because the command is what is
  // being agreed to, and because "delete some files" and
  // `Remove-Item -Recurse C:\Users\me\Documents` are not the same sentence.
  askApproval(details) {
    this.clearStatus();
    this._closeStream(null);
    const card = el("div", "approval-card");
    card.appendChild(el("h3", null, `Can I ${details.summary ?? "do this"}?`));
    if (details.reason) card.appendChild(el("p", "what", `${details.reason[0].toUpperCase()}${details.reason.slice(1)}.`));
    if (details.detail) card.appendChild(el("pre", "step-output", String(details.detail)));
    const actions = el("div", "actions");
    const approve = el("button", "approve", "Allow");
    const reject = el("button", "secondary", "Don't");
    actions.appendChild(approve);
    actions.appendChild(reject);
    card.appendChild(actions);
    const answer = async (approved) => {
      approve.disabled = true;
      reject.disabled = true;
      await respondToApproval(details.approvalId, approved);
    };
    approve.addEventListener("click", () => answer(true));
    reject.addEventListener("click", () => answer(false));
    this.approvals = this.approvals ?? new Map();
    this.approvals.set(details.approvalId, card);
    this.root.appendChild(card);
    this.keepWorkingLast();
    scrollToEnd();
  }

  // Answered, or timed out, or the run ended. Either way the buttons stop being
  // live and the card says what was decided, because it stays in the transcript.
  settleApproval(approvalId, approved) {
    const card = this.approvals?.get(approvalId);
    if (!card) return;
    this.approvals.delete(approvalId);
    card.querySelector(".actions")?.remove();
    card.classList.add(approved ? "approved" : "rejected");
    card.appendChild(el("p", "agent-detail", approved ? "You allowed this." : "You said no — it was not run."));
    scrollToEnd();
  }

  append(node) {
    this.root.appendChild(node);
    this.keepWorkingLast();
    scrollToEnd();
    return node;
  }

  /** Keep the live indicator at the bottom of the turn as it grows. */
  // IT IS KEPT LAST BY CSS NOW, NOT BY MOVING IT.
  //
  // This used to `appendChild` the working row after every step, which is a
  // MOVE — the browser removes the node and re-inserts it, and re-inserting a
  // node restarts every CSS animation on it and on its children. So on a run
  // that fires four tool calls in six seconds the sphere jumped back to frame
  // one four times and looked broken. It was the fix for a real problem (the one
  // live object on screen ending up a screenful above the work it described),
  // but the problem is layout, and layout is not a job for the DOM: `.working`
  // carries `order: 99` in a flex column, so it is always drawn last without
  // ever being touched. See PASS 15.
  //
  // Kept as a method rather than deleted at its six call sites: those calls are
  // the record of every place that used to disturb it, and this is where the
  // reason lives.
  keepWorkingLast() { /* CSS `order` does it — see the note above */ }
}

// The answer travels on its own route, straight to the loop that is waiting for
// it. A failure here is not worth surfacing: the agent times the question out on
// its own and treats silence as no.
async function respondToApproval(approvalId, approved) {
  if (!runningSessionId) return;
  try {
    await fetch(`/api/intents/${encodeURIComponent(runningSessionId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId, approved })
    });
  } catch { /* the question times out by itself */ }
}

// ---- Events → the turn -------------------------------------------------------

// Phases the runtime passes through before the model has said anything. They
// share the one transient status line; none of them is worth a permanent row.
const PHASE_STATUS = {
  INTENT_RECEIVED: "Connecting…",
  INTENT_CLASSIFIED: "Working out what you meant…",
  CAPABILITY_CATALOG_REFRESHED: "Checking what I can do…",
  CONTEXT_COLLECTED: "Looking at the current state…",
  ADAPTIVE_CONTROLLER_STARTED: "Getting started…",
  ADAPTIVE_PERCEIVED: "Looking at the screen…",
  STARTING_REPLANNING: "Rethinking the approach…"
};

// Events that exist only for the person watching right now. They are dropped
// before a turn is saved — see the note where `streamed` is filled — and both
// the runtime and the daemon keep them out of their own buffers for the same
// reason.
const TRANSIENT_EVENTS = new Set(["TOOL_PROGRESS", "TOOL_STREAMING"]);

function handleEvent(turn, event) {
  const type = event?.eventType ?? event?.type;
  const d = event?.details ?? {};

  if (debug && type) {
    turn.append(el("div", "raw debug-only", `[${type}] ${JSON.stringify(d).slice(0, 400)}`));
  }

  // The model, in its own words. This is the event this whole surface exists for.
  if (type === "AGENT_DELTA") {
    if (d.text) turn.streamDelta(d.text);
    return;
  }
  // The model's reasoning, on its own channel. Never merged into the answer.
  if (type === "AGENT_REASONING") {
    if (d.text) turn.streamReasoning(d.text);
    return;
  }
  if (type === "AGENT_SAYS") {
    if (d.text || d.observed) {
      turn.say(d.text ?? "", { detail: d.detail, steps: d.steps ?? [], observed: d.observed });
    }
    return;
  }

  // The model is writing a tool call. Nothing has run yet — this only puts a row
  // on screen so that a call whose argument takes a minute to generate is not a
  // minute of blank transcript. See streamingStep.
  if (type === "TOOL_STREAMING") {
    if (d.tool) turn.streamingStep({ index: d.index ?? 0, callId: d.callId, tool: d.tool, bytes: d.bytes ?? 0 });
    return;
  }
  // The agent loop: one row per tool call, opened the moment it starts.
  if (type === "TOOL_STARTED") {
    turn.usesAdaptiveSteps = true;
    turn.startStep({ key: d.callId, capability: d.tool, inputs: d.args, arg: d.preview });
    return;
  }
  // How far through it is, for the calls long enough that the question arises.
  // Drawn on the row that is already open, underneath the command it belongs to.
  if (type === "TOOL_PROGRESS") {
    turn.progressStep({ key: d.callId, capability: d.tool, percent: d.percent, label: d.label, phase: d.phase });
    return;
  }
  if (type === "TOOL_FINISHED") {
    turn.finishStep({
      key: d.callId,
      capability: d.tool,
      ok: d.ok !== false,
      preview: d.output,
      durationMs: d.durationMs
    });
    // A tool whose result is something to USE rather than something to read.
    // The step row above still says what ran and what it returned; this is the
    // object itself, drawn under it. See `uiCard` in fast-agent/src/tools.js.
    if (d.card?.kind === "email-draft" && d.ok !== false) {
      turn.append(emailCard(d.card, { onSent: noteMailWasSent }));
    }
    // A document is a THING, not a path in a sentence. See file-card.js.
    if (d.card?.kind === "file" && d.ok !== false) turn.append(fileCard(d.card));
    return;
  }
  // The agent is about to do something it cannot take back, and has stopped to
  // ask. The command is shown verbatim, because that is the thing being agreed
  // to — a summary of a delete is not a delete.
  if (type === "APPROVAL_REQUIRED") {
    return turn.askApproval(d);
  }
  if (type === "APPROVAL_RESOLVED") {
    return turn.settleApproval(d.approvalId, d.approved);
  }
  if (type === "AGENT_ERROR") {
    return turn.note(`Model call failed: ${d.reason ?? "unknown"} — retrying or stopping.`);
  }
  if (type === "AGENT_THROTTLED") {
    return turn.throttled(d.waitMs);
  }

  // Adaptive loop: one row per action, opened here and closed below.
  if (type === "ADAPTIVE_ACTION_STARTING") {
    turn.usesAdaptiveSteps = true;
    turn.startStep({
      key: d.step,
      capability: d.action?.capability,
      inputs: d.action?.inputs,
      subgoal: d.action?.subgoal
    });
    return;
  }
  if (type === "ADAPTIVE_ACTION_VERIFIED") {
    const status = d.verification?.status;
    turn.finishStep({
      key: d.step,
      capability: d.capability,
      // UNCONFIRMED is not FAILED. The step ran and nothing independent proved
      // what it changed, which is an ordinary outcome for a GUI click and must
      // not be drawn as an error.
      ok: status !== "FAILED",
      message: d.verification?.message,
      preview: d.resultPreview,
      durationMs: d.durationMs
    });
    return;
  }

  // Static task-graph path: the same two-phase shape under different names.
  // Suppressed once the adaptive loop is driving, because there these are the
  // inner execution of a step already on screen.
  if (type === "TASK_STARTING" || type === "TASK_EXECUTED" || type === "TASK_FAILED" || type === "TASK_PRECONDITIONS_FAILED") {
    if (turn.usesAdaptiveSteps) return;
    if (type === "TASK_STARTING") {
      turn.startStep({ key: d.taskId, capability: d.capability, inputs: d.inputs, subgoal: d.goal });
    } else if (type === "TASK_EXECUTED") {
      turn.finishStep({ key: d.taskId, capability: d.capability, ok: true });
    } else {
      turn.finishStep({ key: d.taskId, capability: d.capability, ok: false, message: d.error ?? d.reason });
    }
    return;
  }

  if (type === "PLAN_GENERATED") {
    const tasks = d.taskGraph?.tasks ?? [];
    if (tasks.length) {
      turn.say("Here's the plan.", { steps: tasks.map((task) => task.goal || task.capability) });
    }
    return;
  }

  // Things worth saying out loud because they change what happens next.
  if (type === "REPLAN_APPROVAL_REQUIRED") return turn.note("The new plan needs your approval.");
  if (type === "ROLLING_BACK") return turn.note("Rolling back the changes I made.");
  if (type === "ADAPTIVE_LOOP_DETECTED") return turn.note("That repeated with no effect — trying something else.");
  if (type === "VERIFICATION_FAILED") return turn.note(`That didn't work: ${d.message ?? "the check failed"}`);
  if (type === "FAILURE_DIAGNOSED") return turn.note(`Diagnosed: ${d.rootCause || d.category || "a problem"}`);

  if (PHASE_STATUS[type]) turn.setStatus(PHASE_STATUS[type]);
}

// ---- Final rendering ---------------------------------------------------------

const GOOD_STATUS = new Set(["COMPLETED", "COMPLETED_WITH_WARNINGS", "ANSWERED", "ROLLED_BACK", "VERIFIED"]);

// What the request cost, on one line under it. Not a dashboard: the numbers that
// answer "was that expensive, and why" — how many decisions it made, how long it
// took, and how many tokens those decisions cost. Every one of these was already
// being measured and none of it was ever shown.
function renderCost(turn, metrics) {
  if (!metrics) return;
  const parts = [];
  if (metrics.steps) parts.push(`${metrics.steps} step${metrics.steps === 1 ? "" : "s"}`);
  if (metrics.toolCalls) parts.push(`${metrics.toolCalls} tool call${metrics.toolCalls === 1 ? "" : "s"}`);
  if (Number.isFinite(metrics.elapsedMs) && metrics.elapsedMs > 0) parts.push(`${(metrics.elapsedMs / 1000).toFixed(1)}s`);
  const tokens = (Number(metrics.tokensIn) || 0) + (Number(metrics.tokensOut) || 0);
  // Providers do not all report usage. A missing number is left out rather than
  // shown as a zero that looks like a measurement.
  if (tokens > 0) {
    // MOST OF "IN" WAS NEVER PAID FOR AT FULL PRICE. The endpoint serves the
    // system prompt and the tool schema from its prefix cache — measured at
    // 8,320 of 8,613 tokens on every step after the first — and a cached token
    // costs about a tenth of a fresh one. Showing one big number made every
    // GUI task look ruinous; the number that matters is the fresh one.
    const cached = Number(metrics.tokensCached) || 0;
    const fresh = Number(metrics.tokensFresh) || Math.max(0, (Number(metrics.tokensIn) || 0) - cached);
    parts.push(cached > 0
      ? `${tokens.toLocaleString()} tokens (${fresh.toLocaleString()} new in, ` +
        `${cached.toLocaleString()} cached, ${(Number(metrics.tokensOut) || 0).toLocaleString()} out)`
      : `${tokens.toLocaleString()} tokens (${(Number(metrics.tokensIn) || 0).toLocaleString()} in, ${(Number(metrics.tokensOut) || 0).toLocaleString()} out)`);
  }
  if (parts.length) turn.append(el("div", "turn-cost", parts.join(" · ")));
}

function renderFinal(turn, session) {
  turn.settle();
  const fr = session.finalResponse ?? {};

  if (fr.status === "AWAITING_APPROVAL") {
    renderApproval(turn, session);
    return;
  }

  const message = fr.summary?.summary || fr.summary?.text || fr.message
    || (GOOD_STATUS.has(fr.status) ? "Done." : "I couldn't complete that.");

  // A successful answer is just the assistant talking. It does not need a badge:
  // the transcript above it already shows what happened, and a green "✓ Done"
  // stamped over every reply is how a status indicator stops carrying
  // information. Only a result that did NOT go well is labelled, because that is
  // the case where the label tells you something.
  // In the agent loop the closing message IS the model's last sentence, which is
  // already on screen — it streamed there while the last tool was running.
  // Printing it a second time as an "answer" is the receipt this surface exists
  // to avoid.
  const said = String(turn.lastSaid ?? "").trim();
  const closing = String(message).trim();
  if (closing === said) {
    renderCost(turn, fr.metrics);
    // This is the COMMON exit in the agent loop, not an edge case — the closing
    // message is usually the sentence that already streamed. Copy has to be
    // here too, or it would be missing from most answers.
    attachAnswerActions(turn);
    if (debug) turn.append(el("pre", "debug-only rawjson", JSON.stringify(session, null, 2)));
    return;
  }

  // NEARLY the same is still the same paragraph twice.
  //
  // The exact-match check above catches the common case and misses the one that
  // looks worst: a run that stops early has its own sentence WRAPPED — the
  // model's closing words, then the runtime's "I stopped before finishing that."
  // So the card printed the whole paragraph again, three lines under itself, the
  // second copy differing only in a tail nobody reads twice. Measured on a real
  // partly-done run: 62 words repeated verbatim.
  //
  // Only the tail is new, so only the tail is drawn. Below a floor it is not
  // worth a card at all — a badge over four words is a label, not an answer.
  const extra = said && closing.startsWith(said) ? closing.slice(said.length).trim() : null;
  const message2 = extra !== null ? extra : closing;
  // A paraphrase of what is already on screen, with no wrap-up tail to salvage.
  // Only for runs that went WELL: a "Partly done" or "Didn't work" badge is
  // information the narration above it does not carry, so that card is drawn
  // even when its sentence is a repeat.
  if (extra === null && GOOD_STATUS.has(fr.status) && nearlyTheSame(closing, said)) {
    renderCost(turn, fr.metrics);
    attachAnswerActions(turn);
    if (debug) turn.append(el("pre", "debug-only rawjson", JSON.stringify(session, null, 2)));
    return;
  }
  if (extra !== null && extra.length < 12) {
    renderCost(turn, fr.metrics);
    attachAnswerActions(turn);
    if (debug) turn.append(el("pre", "debug-only rawjson", JSON.stringify(session, null, 2)));
    return;
  }

  // Stopping is the user getting what they asked for, not a failure. Labelling
  // it "Didn't work" in red tells them something went wrong when nothing did.
  //
  // DECLINED is the same argument for the same reason: the user was asked
  // whether to send something irreversible and said no. That is the safety
  // feature working exactly as designed. It used to arrive here as COMPLETED —
  // a green tick over the sentence "it was not sent" — and it must not land in
  // the red branch now either, or refusing turns into something that looks like
  // a fault the user caused.
  if (fr.status === "CANCELLED" || fr.status === "DECLINED") {
    turn.append(el("div", "agent-answer", message2));
  } else if (GOOD_STATUS.has(fr.status)) {
    turn.append(el("div", "agent-answer", message2));
  } else {
    // PARTLY DONE IS NOT DIDN'T WORK, AND IT MUST NOT BE THE SAME RED BOX.
    //
    // Three verdict states, never two — the rule this project keeps relearning —
    // and the surface was collapsing two of them into one. A run that did most
    // of the work and stopped at a ceiling was drawn in the same alarm colour as
    // a run that failed outright, so "I got you 90% of the way" and "nothing
    // happened" looked identical at a glance.
    const partial = fr.status === "PARTIALLY_COMPLETED";
    const card = el("div", `result-card ${partial ? "partial" : "bad"}`);
    card.appendChild(el("div", "badge", partial ? "Partly done" : "Didn't work"));
    card.appendChild(el("p", null, message2));
    turn.append(card);
  }

  renderCost(turn, fr.metrics);
  attachAnswerActions(turn);

  if (debug) {
    const pre = el("pre", "debug-only rawjson", JSON.stringify(session, null, 2));
    turn.append(pre);
  }
}

/**
 * Copy, under the answer.
 *
 * It copies what the assistant SAID — its narration and its final answer — and
 * not the tool rows, because the tool rows are the receipt for the answer and
 * nobody pastes a receipt into a document. Appended once: renderFinal has two
 * exits and replaying a stored chat runs through it again.
 */
function attachAnswerActions(turn) {
  if (!turn?.root || turn.root.querySelector(":scope > .msg-actions")) return;
  const said = () => [...turn.root.querySelectorAll(".agent-says, .agent-answer, .result-card p")]
    .map((node) => node.innerText.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!said()) return;
  turn.append(messageActions({ getText: said }));
}

// Approval card — WHAT / WHY / RISK / WHAT CHANGES, then Approve / Reject.
function renderApproval(turn, session) {
  const fr = session.finalResponse ?? {};
  const ia = fr.informedApproval ?? {};
  const card = el("div", "approval-card");
  const what = (ia.whatItDoes && ia.whatItDoes.length)
    ? ia.whatItDoes.join(" ")
    : (fr.reason || "SYSCORA wants to perform an action.");
  card.innerHTML = `
    <h3>Approval required</h3>
    <p class="what">${escapeHtml(what)}</p>
    <ul class="detail">
      <li><strong>Risk:</strong> ${riskWord(fr.confirmationLevel === "ELEVATE" ? "HIGH" : (session.riskAssessment?.overallRisk))}</li>
      ${ia.blastRadius ? `<li><strong>Scope:</strong> ${escapeHtml(String(ia.blastRadius))}</li>` : ""}
      ${ia.reversibility ? `<li><strong>Reversible:</strong> ${escapeHtml(String(ia.reversibility))}</li>` : ""}
      ${fr.confirmationLevel ? `<li><strong>Control:</strong> ${escapeHtml(String(fr.confirmationLevel))}</li>` : ""}
    </ul>
    <div class="actions">
      <button class="approve">Approve</button>
      <button class="reject secondary">Reject</button>
    </div>`;
  turn.append(card);
  card.querySelector(".approve").addEventListener("click", async () => {
    card.remove();
    await resume(session.sessionId, true);
  });
  card.querySelector(".reject").addEventListener("click", () => {
    card.remove();
    turn.append(el("div", "agent-answer", "Okay — I won't do that. No changes were made."));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getPayload(json) { return json?.envelope?.payload ?? json; }

// ---- Conversation memory -----------------------------------------------------

// The conversation so far, oldest first. SYSCORA used to treat every message as
// a first message: "open Notepad" then "now maximize it" classified the second
// one with no idea what "it" was, so the most ordinary thing anyone does in a
// chat did not work. The client owns this transcript and sends it with each
// request; the daemon bounds and forwards it.
//
// Only what was actually SAID goes in here — the user's words and the reply they
// saw. Internal events, plans and evidence stay out: they are large, they are
// already in the session, and they are not what a follow-up refers to.
// CHATS ------------------------------------------------------------------------
//
// More than one conversation, kept between sessions, with a list to move between
// them — the shape every assistant has, and the reason a long-running piece of
// work does not have to share a thread with "is python installed".
//
// There is NO ACCOUNT SYSTEM yet, so "your chats" means the chats in this
// browser profile or this desktop application, on this machine. That is a real
// limitation and the panel says so rather than implying a sync that does not
// exist. Everything below is deliberately one small module over localStorage: it
// is the whole of the persistence, so moving it to the daemon later is one file
// and the shape it already stores.
//
// A chat holds two things:
//   `conversation` — the {role, text} pairs sent to the daemon as history. This
//     is what makes "now maximize it" resolve three messages later.
//   `turns` — the EVENTS each turn streamed, so re-opening a chat replays the
//     transcript through the same renderers that drew it live, tool rows and
//     all, rather than showing a flattened summary of what once happened.
const CHATS_KEY = "syscora_chats";
const ACTIVE_CHAT_KEY = "syscora_active_chat";
const LEGACY_CONVERSATION_KEY = "syscora_conversation";
// Bounds, because localStorage is a few megabytes and a screen reading is a few
// thousand characters. Old chats fall off the end rather than the store failing.
const MAX_CHATS = 25;
const MAX_TURNS_PER_CHAT = 40;
const MAX_STORED_OUTPUT = 1200;

const newId = () => `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveChats(list) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(list.slice(0, MAX_CHATS)));
  } catch {
    // Out of room. Drop the oldest half and try once more; losing the oldest
    // chats is much better than silently losing the one being written.
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(list.slice(0, Math.ceil(list.length / 2))));
    } catch { /* storage is unavailable entirely; the session still works */ }
  }
}

let chats = loadChats();
let activeChatId = localStorage.getItem(ACTIVE_CHAT_KEY);

// One-time carry-over from when there was a single conversation.
if (chats.length === 0) {
  let legacy = [];
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_CONVERSATION_KEY) ?? "[]");
    if (Array.isArray(saved)) legacy = saved;
  } catch { /* nothing to carry over */ }
  chats = [{
    id: newId(),
    title: titleFrom(legacy.find((entry) => entry.role === "user")?.text) || "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    conversation: legacy.slice(-24),
    turns: []
  }];
  localStorage.removeItem(LEGACY_CONVERSATION_KEY);
  saveChats(chats);
}
if (!chats.some((chat) => chat.id === activeChatId)) activeChatId = chats[0].id;

function activeChat() {
  return chats.find((chat) => chat.id === activeChatId) ?? chats[0];
}

// The chat's name, taken from the first thing asked in it — which is what the
// chat is about far more reliably than anything that could be generated for it.
function titleFrom(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 44 ? `${clean.slice(0, 43)}…` : clean;
}

// The live history for the CURRENT chat. Mutated in place rather than replaced,
// because everything that reads it holds this same array.
const conversation = activeChat().conversation.slice(-24);

function touchActiveChat() {
  const chat = activeChat();
  chat.conversation = conversation.slice(-24);
  chat.updatedAt = Date.now();
  // Most recent first, which is the order the list is read in.
  chats.sort((left, right) => right.updatedAt - left.updatedAt);
  saveChats(chats);
  localStorage.setItem(ACTIVE_CHAT_KEY, chat.id);
}

function remember(role, text, shown = null) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  conversation.push({ role, text: trimmed });
  if (conversation.length > 24) conversation.splice(0, conversation.length - 24);
  const chat = activeChat();
  // The TITLE comes from what was shown, never from what was sent. They are the
  // same string for a typed message and wildly different for one carrying an
  // attachment, and a chat called "--- Attached folder: BotStorm ---" is
  // useless in a list of chats.
  const naming = String(shown ?? trimmed).trim() || trimmed;
  if (role === "user" && (!chat.title || chat.title === "New chat")) chat.title = titleFrom(naming);
  touchActiveChat();
  renderChatList();
}

/**
 * The agent could not tell whether the user had pressed Send.
 *
 * Live, 25 Aug 2026: told "anyways the email is sent so its fine", the agent
 * had to hedge — "if you've pressed Send, you're all set; if not, it's still
 * waiting" — because the card and the conversation were two different worlds.
 * The card knew perfectly well: it had Gmail's message id. Nothing carried that
 * back. It is also the missing half of the rule that stops the agent chasing a
 * send it cannot perform: "once the email is sent, do X" is answerable the
 * moment the send is a fact the agent can see.
 *
 * Written in the user's voice because it IS something the user did, at the
 * point in the conversation where they did it. It never reaches the transcript
 * — the card already flipped to "Sent" on screen, and a second announcement of
 * the same event is noise — only the history the next turn is given.
 *
 * NOT content, and therefore not an injection risk: this sentence is built here
 * from our own send receipt, never from anything that was read.
 */
function noteMailWasSent(receipt) {
  const to = (receipt?.to ?? []).join(", ");
  conversation.push({
    role: "user",
    text: `(I pressed Send on the draft: the email to ${to} has now been sent from ${receipt?.from}. ` +
      "Anything I asked you to do once it was sent can go ahead.)"
  });
  if (conversation.length > 24) conversation.splice(0, conversation.length - 24);
  touchActiveChat();
}

// The events of one finished turn, so it can be drawn again exactly as it was.
// Tool output is clipped for storage only — a screen reading is thousands of
// characters and twenty of them would fill the store on their own.
// The body a turn actually sent, and the reply it got, kept so the conversation
// can be REBUILT when a message is edited and the chat re-runs from that point.
// Clipped, because an attached resume is forty thousand characters and forty of
// those would not fit in localStorage. The clip is only ever read after a
// rewind, and the attachment block it belongs to names the file's path, so the
// agent can still go and read the rest.
const MAX_STORED_SENT = 12000;
const MAX_STORED_REPLY = 4000;

const clipStored = (value, limit) => {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n… [clipped when this chat was saved]` : text;
};

function recordTurn(userText, events, session, attachments = [], sent = null, reply = null, id = null) {
  const chat = activeChat();
  chat.turns.push({
    // Stable across the splice that trims a chat to MAX_TURNS_PER_CHAT, which a
    // positional index would not be — and an edit that rewinds to the wrong
    // turn would silently throw away the wrong half of a conversation. Minted
    // by submit() before the request goes out, so the Edit button on a running
    // turn already knows which turn it will become.
    id: id ?? newId(),
    user: userText,
    sent: clipStored(sent ?? userText, MAX_STORED_SENT),
    reply: clipStored(reply ?? "", MAX_STORED_REPLY),
    // NAMES ONLY. What was attached is part of what was said, so a replayed
    // chat has to show it — but a stored data URL for every screenshot would
    // fill localStorage in an afternoon, so the picture is not kept.
    attachments: attachments.map((file) => ({ kind: file.kind, name: file.name })),
    at: Date.now(),
    events: events.map((event) => {
      const details = { ...(event.details ?? {}) };
      if (typeof details.output === "string" && details.output.length > MAX_STORED_OUTPUT) {
        details.output = `${details.output.slice(0, MAX_STORED_OUTPUT)}\n… [clipped when this chat was saved]`;
      }
      return { type: event.type ?? event.eventType, details };
    }),
    session: session ? { finalResponse: session.finalResponse ?? null } : null
  });
  if (chat.turns.length > MAX_TURNS_PER_CHAT) {
    chat.turns.splice(0, chat.turns.length - MAX_TURNS_PER_CHAT);
  }
  touchActiveChat();
  return chat.turns[chat.turns.length - 1];
}

/**
 * The model's view of a chat, rebuilt from the turns that are LEFT.
 *
 * Needed by the edit-and-re-run path: `conversation` is appended to as things
 * happen and has no idea which turn any entry came from, so rewinding it by
 * counting backwards is guesswork — a turn that failed contributed one entry,
 * a turn that answered contributed two, and getting it wrong leaves the model
 * answering with half of a conversation the user has just deleted.
 */
function historyFromTurns(turns) {
  const history = [];
  for (const turn of turns) {
    const asked = String(turn.sent ?? turn.user ?? "").trim();
    if (asked) history.push({ role: "user", text: asked });
    const answered = String(turn.reply ?? "").trim();
    if (answered) history.push({ role: "assistant", text: answered });
  }
  return history;
}

// ---- The chats panel ---------------------------------------------------------

const chatsPanel = document.getElementById("chatsPanel");
const chatsBackdrop = document.getElementById("chatsBackdrop");
const chatListEl = document.getElementById("chatList");
// Both of these were removed from the top bar when the rail stopped being
// hideable — see openChatsPanel. The lookups stay, and every use of them is
// already optional, so nothing here has to know whether they exist.
const chatsButton = document.getElementById("chatsButton");
const newChatButton = document.getElementById("newChatButton");
const railToggle = document.getElementById("railToggle");

function whenLabel(at) {
  const ms = Date.now() - Number(at ?? 0);
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(Number(at)).toLocaleDateString();
}

// WHEN, IN THE WORDS PEOPLE USE. A column of "2h ago" tells you how long, which
// is not the question — "was that this morning or last week" is.
function bucketOf(at) {
  const then = new Date(at ?? 0);
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (then.getTime() >= midnight) return "Today";
  if (then.getTime() >= midnight - 86_400_000) return "Yesterday";
  if (then.getTime() >= midnight - 7 * 86_400_000) return "Previous 7 days";
  if (then.getTime() >= midnight - 30 * 86_400_000) return "Previous 30 days";
  return "Older";
}

const chatSearch = document.getElementById("chatSearch");
// Matches the TITLE only. Searching the transcripts would mean holding every
// stored turn of every chat in memory on each keystroke, and the title is the
// first thing that was asked — which is what people actually remember.
let chatFilter = "";
chatSearch?.addEventListener("input", () => {
  chatFilter = chatSearch.value.trim().toLowerCase();
  renderChatList();
});

// THE FIELD IS FOLDED AWAY UNTIL IT IS ASKED FOR, and closing it has to CLEAR
// it. A hidden control that is still filtering is a list that has silently lost
// rows for a reason nobody can see — which is the same class of defect as a
// check with an empty needle: the state is real and the evidence for it is not
// on screen.
const chatSearchWrap = chatSearch?.closest(".chat-search") ?? null;
function openChatSearch(open) {
  if (!chatSearchWrap || !chatSearch) return;
  chatSearchWrap.hidden = !open;
  for (const control of [document.getElementById("chatsSearchToggle"), document.getElementById("chatsSearchItem")]) {
    control?.setAttribute("aria-expanded", String(open));
    control?.classList.toggle("active", open);
  }
  if (open) {
    chatSearch.focus();
  } else if (chatFilter) {
    chatSearch.value = "";
    chatFilter = "";
    renderChatList();
  }
}
const toggleChatSearch = () => openChatSearch(chatSearchWrap?.hidden !== false);
document.getElementById("chatsSearchToggle")?.addEventListener("click", toggleChatSearch);
document.getElementById("chatsSearchItem")?.addEventListener("click", toggleChatSearch);
// Escape closes it from inside, which is where your hands already are.
chatSearch?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.stopPropagation(); openChatSearch(false); }
});

function renderChatList() {
  if (!chatListEl) return;
  chatListEl.textContent = "";
  let listed = chats.filter((chat) => chat.turns.length > 0 || chat.id === activeChatId);
  if (chatFilter) {
    listed = listed.filter((chat) => String(chat.title ?? "").toLowerCase().includes(chatFilter));
  }
  if (listed.length === 0) {
    chatListEl.appendChild(el("li", "empty", chatFilter ? `Nothing matching “${chatSearch.value.trim()}”.` : "No chats yet."));
    return;
  }
  // PINNED FIRST, ARCHIVED LAST, EVERYTHING ELSE BY DAY.
  //
  // Sorted HERE rather than by reordering `chats`, because that array's order is
  // owned by touchActiveChat (most-recent-first) and two things deciding one
  // order is two things that can disagree. A stable sort keeps the recency
  // ordering inside each band for free.
  const band = (chat) => (chat.pinned ? 0 : chat.archived ? 2 : 1);
  listed = [...listed].sort((left, right) => band(left) - band(right));

  let bucket = null;
  for (const chat of listed) {
    const label = chat.pinned ? "Pinned" : chat.archived ? "Archived" : bucketOf(chat.updatedAt);
    if (label !== bucket) {
      bucket = label;
      const heading = el("li", "chat-group", label);
      heading.setAttribute("aria-hidden", "true");
      chatListEl.appendChild(heading);
    }
    const row = el("li", chat.id === activeChatId ? "active" : null);
    if (chat.pinned) row.classList.add("pinned");
    const open = el("button", "chat-open");
    open.type = "button";
    open.appendChild(el("span", "chat-title", chat.title || "New chat"));
    open.appendChild(el("span", "chat-when", whenLabel(chat.updatedAt)));
    open.addEventListener("click", () => switchToChat(chat.id));
    row.appendChild(open);

    // TWO CONTROLS, NOT A DELETE BUTTON. The × that used to sit here was the
    // only thing you could do to a chat from the rail, and it was the one
    // irreversible thing — a single mis-click away, on hover, on every row.
    // Pinning is the frequent verb so it keeps its own button; everything else
    // is behind the ⋯, with Delete at the bottom of it.
    const pin = el("button", "icon-button chat-pin");
    pin.type = "button";
    pin.appendChild(svgIcon("pin"));
    pin.setAttribute("aria-pressed", String(Boolean(chat.pinned)));
    pin.title = chat.pinned ? "Unpin this chat" : "Pin this chat";
    pin.setAttribute("aria-label", pin.title);
    pin.addEventListener("click", (event) => { event.stopPropagation(); pinChat(chat.id); });
    row.appendChild(pin);

    const more = el("button", "icon-button chat-more");
    more.type = "button";
    more.appendChild(svgIcon("dots"));
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.title = "More";
    more.setAttribute("aria-label", `More for ${chat.title || "New chat"}`);
    more.addEventListener("click", (event) => { event.stopPropagation(); openChatMenu(more, chat.id); });
    row.appendChild(more);

    chatListEl.appendChild(row);
  }
}

// DOCKED, NOT DROPPED OVER THE TOP.
//
// It used to slide over the conversation with a backdrop, which is a phone
// pattern on a 24-inch screen: it darkened the thing you were reading to show
// you a list, and you had to dismiss it to get back. Every desktop assistant
// docks this, so the sidebar is now a COLUMN — the chat pane narrows to make
// room for it and nothing is covered. On a narrow window there is no room to
// narrow, so it goes back to overlaying, which is what the backdrop is for.
const SIDEBAR_KEY = "syscora_sidebar";
const NARROW = () => window.matchMedia("(max-width: 900px)").matches;

// COLLAPSED IS NOT HIDDEN, AND THAT IS THE WHOLE CHANGE.
//
// The rail used to have two states, "there" and "gone", and the control for
// getting it back lived in a strip above the conversation — so closing it took
// away the list AND the new-chat button AND the search, and left a header whose
// only remaining job was to hold the button that undid that. Now it collapses to
// a column of icons that never leaves: the mark, new chat, search, and you at
// the bottom. Nothing becomes unreachable, so nothing else has to hold a spare
// copy of it, which is why the top bar's left half could go.
function openChatsPanel(open) {
  // Never hidden. The rules that keyed off `[hidden]` collapsed it to zero
  // width, which is exactly what must not happen any more.
  chatsPanel.hidden = false;
  // The backdrop belongs to the overlay mode only, and only when EXPANDED — a
  // 60px rail covers nothing worth greying the conversation out for.
  chatsBackdrop.hidden = !open || !NARROW();
  document.body.classList.toggle("sidebar-open", open);
  document.body.classList.toggle("rail-collapsed", !open);
  chatsButton?.setAttribute("aria-expanded", String(open));
  // The mark is only a button while it is the only way back.
  railToggle?.setAttribute("aria-hidden", String(open));
  railToggle?.setAttribute("tabindex", open ? "-1" : "0");
  // Collapsing takes the search field's own row away with it, and a field you
  // cannot see must not still be filtering — same rule as closing it by hand.
  if (!open) openChatSearch(false);
  // Remembered, because a sidebar that closes itself every time you open the
  // application is one you stop using.
  try { localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  renderChatList();
}

// PICKING A CHAT USED TO CLOSE THE SIDEBAR, AND THAT WAS RIGHT WHEN CLOSED MEANT
// "stop covering the conversation". It does not mean that any more: closing now
// collapses the rail to icons, which on a wide window would throw away the list
// you are working through every single time you open something from it. So the
// dismissal is only for the case it was written for — the narrow window, where
// the expanded rail really is sitting on top of what you are about to read.
function dismissRailOverlay() {
  if (NARROW() && document.body.classList.contains("sidebar-open")) openChatsPanel(false);
}

// A run is bound to the transcript it is streaming into, so it must finish (or
// be stopped) before the transcript can be swapped underneath it.
function busyWithRun() {
  if (!runningSessionId) return false;
  dismissRailOverlay();
  addBubble("syscora", textNode(
    "I'm in the middle of a request — stop it first, then start or open another chat."
  ));
  return true;
}

function showWelcome() {
  chatLog.textContent = "";
  const welcome = el("div", "welcome");
  welcome.appendChild(el("h2", null, "What would you like SYSCORA to do?"));
  welcome.appendChild(el("p", "muted",
    "Ask naturally. SYSCORA can answer, inspect, and act while keeping you updated in the same conversation."));
  // THE STARTERS COME BACK WITH IT. They live in the markup, so they were on
  // the first screen after a launch and on no screen ever again — pressing
  // "New chat" gave you a barer page than opening the application did. The
  // ORIGINAL node is re-inserted rather than rebuilt, because the one click
  // handler in this file is bound to that element.
  if (suggestions) welcome.appendChild(suggestions);
  chatLog.appendChild(welcome);
}

/**
 * What was attached, drawn under the message it was attached to.
 *
 * ONE function for the live send and for the replay of a stored chat, so a
 * re-opened conversation cannot show something different from what was on
 * screen when it happened. Returns null when there is nothing to draw.
 */
function attachmentChips(attachments) {
  if (!attachments?.length) return null;
  const list = el("div", "bubble-attachments");
  for (const file of attachments) {
    // The picture, in the message it was sent with. A filename in a chip is
    // not a record of what was attached — three screenshots from the same
    // afternoon have three indistinguishable names. A stored turn has no data
    // URL (they are far too big to keep), so it falls through to the chip.
    if (file.kind === "image" && file.dataUrl) {
      const thumb = el("img", "bubble-thumb");
      thumb.src = file.dataUrl;
      thumb.alt = file.name;
      thumb.title = file.name;
      list.appendChild(thumb);
      continue;
    }
    const chip = el("span", `bubble-attachment ${file.kind === "folder" ? "folder" : ""}`);
    chip.appendChild(svgIcon({ folder: "folder", image: "image" }[file.kind] ?? "file"));
    chip.appendChild(el("span", null, file.name));
    list.appendChild(chip);
  }
  return list;
}

/**
 * Copy and Edit, under one of the user's own messages.
 *
 * `sent` is the body that actually went to the model — the typed words plus the
 * fenced attachment blocks. Editing keeps those blocks and replaces only the
 * words, so re-running an edited question does not silently drop the folder it
 * was asked about.
 */
function attachUserActions(bubble, { id, user, sent, attachments = [] }) {
  if (!bubble) return;
  bubble.dataset.turnId = id;
  bubble.appendChild(messageActions({
    getText: () => user,
    onEdit: () => beginEdit(bubble, { id, user, sent, attachments })
  }));
}

/** The blocks describeAttachments() added, recovered from the body it built. */
function attachmentBlocksOf(sent) {
  const at = String(sent ?? "").indexOf("\n\n--- Attached ");
  return at === -1 ? "" : String(sent).slice(at);
}

function beginEdit(bubble, turn) {
  if (busyWithRun()) {
    showComposerError("I'm in the middle of a request — stop it first, then edit that message.");
    return;
  }
  if (bubble.querySelector(".msg-edit")) return;

  const box = el("div", "msg-edit");
  const field = document.createElement("textarea");
  field.className = "msg-edit-field";
  field.value = turn.user ?? "";
  field.rows = Math.min(10, Math.max(1, String(turn.user ?? "").split("\n").length));
  const actions = el("div", "msg-edit-actions");
  const cancel = el("button", "msg-edit-cancel", "Cancel");
  cancel.type = "button";
  const confirm = el("button", "msg-edit-send", "Send");
  confirm.type = "button";
  actions.append(cancel, confirm);
  box.append(field, actions);

  // Everything the bubble normally shows is hidden rather than removed, so
  // Cancel is a single class toggle and cannot lose the original message.
  bubble.classList.add("editing");
  bubble.appendChild(box);
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 260)}px`;
  };
  grow();
  field.addEventListener("input", grow);

  const close = () => {
    bubble.classList.remove("editing");
    box.remove();
  };
  cancel.addEventListener("click", close);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); confirm.click(); }
  });
  confirm.addEventListener("click", () => {
    const edited = field.value.trim();
    if (!edited && !turn.attachments?.length) return;
    close();
    rewindAndResend(turn, edited);
  });
}

/**
 * Drop this turn and everything after it, then ask again with the new wording.
 *
 * The three things that have to move together, which is why they are in one
 * function: the STORED turns, the model's HISTORY (rebuilt from what survives,
 * never guessed at by counting backwards), and the transcript on screen.
 */
function rewindAndResend(turn, edited) {
  const chat = activeChat();
  const index = chat.turns.findIndex((stored) => stored.id === turn.id);
  // -1 means the turn is still running or never got recorded; either way the
  // right cut is "everything from the end of the stored chat", because this
  // bubble is the newest thing on screen.
  chat.turns.splice(index === -1 ? chat.turns.length : index);
  conversation.splice(0, conversation.length, ...historyFromTurns(chat.turns).slice(-24));
  // A chat is named after its FIRST message. Rewinding past that message left
  // the sidebar showing the name of a question that is no longer in the chat;
  // clearing it lets the edited message name it, which remember() does.
  if (chat.turns.length === 0) chat.title = "New chat";
  touchActiveChat();
  renderChatList();
  renderStoredChat(chat, { resumed: false });
  const body = `${edited}${attachmentBlocksOf(turn.sent)}`;
  submit(body, { attachments: turn.attachments ?? [], display: edited });
}

// Draw a stored chat back onto the screen, through the SAME renderers that drew
// it live. Storing the events rather than a summary is what makes this possible:
// the tool rows, the narration and the final answer come back as they were.
function renderStoredChat(chat, { resumed = true } = {}) {
  chatLog.textContent = "";
  if (chat.turns.length === 0) {
    showWelcome();
    return;
  }
  for (const stored of chat.turns) {
    // A message can be nothing but an attachment — you drop a folder and press
    // send — so the bubble is drawn when there is EITHER text or something
    // attached, not only when there are words.
    if (stored.user || stored.attachments?.length) {
      const bubble = addBubble("user", textNode(stored.user ?? ""));
      const chips = attachmentChips(stored.attachments);
      if (chips) bubble?.appendChild?.(chips);
      attachUserActions(bubble, {
        id: stored.id,
        user: stored.user ?? "",
        sent: stored.sent ?? stored.user ?? "",
        attachments: stored.attachments ?? []
      });
    }
    const turn = new Turn();
    for (const event of stored.events ?? []) {
      try {
        handleEvent(turn, event);
      } catch { /* one unreplayable event must not lose the rest of the chat */ }
    }
    if (stored.session) renderFinal(turn, stored.session);
    else turn.settle();
    // A card from a finished run has nothing left to answer.
    for (const button of turn.root.querySelectorAll(".approval-card button")) button.disabled = true;
    // …and a draft replayed out of storage must not be sendable, or re-opening
    // a chat hands back a live Send button on a message that may already have
    // gone. See sealReplayedDraft().
    for (const card of turn.root.querySelectorAll(".mail-card")) sealReplayedDraft(card);
    // A file card from an earlier session names a file THIS daemon has no
    // record of creating, so Open would be refused — correctly, and confusingly.
    // The path stays, and it says why.
    for (const card of turn.root.querySelectorAll(".file-card")) sealReplayedFile(card);
  }
  // THE "Carrying on from here" RULE IS GONE.
  //
  // It was meant to mark the seam between a chat as you left it and what you do
  // next, and it was already guarded against printing after an edit. It still
  // read as a line about nothing: the seam is the bottom of the transcript,
  // which is where you already are, and after a finished run it sits directly
  // under the answer looking like part of it. Removed rather than made
  // conditional — a divider you have to explain is not doing its job.
  //
  // `resumed` stays in the signature because two callers pass it and one of
  // them (the edit rewind) means something different by it.
  void resumed;
  scrollToEnd();
}

function switchToChat(id) {
  if (busyWithRun()) return;
  const target = chats.find((chat) => chat.id === id);
  if (!target || id === activeChatId) {
    dismissRailOverlay();
    return;
  }
  activeChatId = id;
  localStorage.setItem(ACTIVE_CHAT_KEY, id);
  // In place: everything that sends history holds this array.
  conversation.splice(0, conversation.length, ...(target.conversation ?? []).slice(-24));
  renderStoredChat(target);
  dismissRailOverlay();
  renderChatList();
}

function startNewChat() {
  if (busyWithRun()) return;
  // An untouched "New chat" is not worth a second one.
  const current = activeChat();
  if (current && current.turns.length === 0) {
    dismissRailOverlay();
    showWelcome();
    return;
  }
  const chat = { id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), conversation: [], turns: [] };
  chats.unshift(chat);
  if (chats.length > MAX_CHATS) chats.length = MAX_CHATS;
  activeChatId = chat.id;
  localStorage.setItem(ACTIVE_CHAT_KEY, chat.id);
  conversation.splice(0, conversation.length);
  saveChats(chats);
  showWelcome();
  dismissRailOverlay();
  renderChatList();
}

function deleteChat(id) {
  if (busyWithRun()) return;
  chats = chats.filter((chat) => chat.id !== id);
  if (chats.length === 0) {
    chats = [{ id: newId(), title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), conversation: [], turns: [] }];
  }
  saveChats(chats);
  if (id === activeChatId) {
    activeChatId = chats[0].id;
    localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
    conversation.splice(0, conversation.length, ...(chats[0].conversation ?? []).slice(-24));
    renderStoredChat(chats[0]);
  }
  renderChatList();
}

// ---- What you can do to a chat -------------------------------------------
//
// ONE DEFINITION, TWO MENUS. These items are offered from the ⋯ in the corner of
// the window (acting on the chat you are reading) and from the ⋯ on each row of
// the rail (acting on that row). Writing them out twice is how the two stop
// agreeing about what "Delete" does — and this list contains two irreversible
// verbs, so that is not a cosmetic risk.

const chatById = (id) => chats.find((chat) => chat.id === id) ?? null;

function pinChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  chat.pinned = !chat.pinned;
  saveChats(chats);
  renderChatList();
}

// ARCHIVED IS FILED, NOT DELETED. It leaves Recents and it goes under its own
// heading at the bottom of the same list — because moving something out of
// sight and losing it are the same thing to the person looking for it, and the
// row directly below this one in the menu is the one that really removes it.
function archiveChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  chat.archived = !chat.archived;
  saveChats(chats);
  renderChatList();
}

// PRINT, RATHER THAN A PDF LIBRARY. The browser and Electron both put "Save as
// PDF" in this dialog, so the file you get is a real PDF made by the same engine
// that drew the conversation — with none of the megabyte of dependency a
// generator would add to a product that currently ships zero of them.
//
// It has to be the chat that is ON SCREEN: print() prints the document, not a
// data structure, so a row that is not the open one is opened first. Doing it
// the other way round would hand you a PDF of a different conversation, which is
// the sort of quiet wrong answer this whole product exists not to give.
function downloadChatPdf(id) {
  if (id !== activeChatId) {
    if (busyWithRun()) return;
    switchToChat(id);
  }
  const chat = chatById(id);
  const title = document.title;
  // The print engine takes the document's title as the suggested filename.
  document.title = `${(chat?.title ?? "SYSCORA chat").replace(/[\\/:*?"<>|]/g, " ").trim() || "SYSCORA chat"} — SYSCORA`;
  // RESTORED ON A TIMER AS WELL AS ON THE EVENT. `afterprint` fires on cancel
  // too, so the event is normally enough — but if it never arrives, the window
  // is left permanently named after one conversation, and there is nothing on
  // screen to explain why. Caught in testing with print() stubbed out: the title
  // stayed changed and nothing ever put it back.
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    document.title = title;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  setTimeout(restore, 60_000);
  // After a repaint, so a chat that was just switched to is actually drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

// A REPORT IS A FILE YOU CAN ACTUALLY SEND. There is no server to report to —
// there are no accounts and nothing phones home — so the honest version of this
// verb is: write down everything someone would need to diagnose it, and hand it
// to you. Plain text, so you can read it before you send it, which matters
// because a transcript of this product contains what is on your screen.
function reportChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  const lines = [
    `SYSCORA — conversation report`,
    `chat: ${chat.title ?? "untitled"}`,
    `id: ${chat.id}`,
    `started: ${new Date(chat.createdAt ?? Date.now()).toISOString()}`,
    `turns: ${chat.turns?.length ?? 0}`,
    `agent: ${navigator.userAgent}`,
    "",
    "Read this before sending it — it contains what was on your screen.",
    "=".repeat(60),
    ""
  ];
  for (const turn of chat.turns ?? []) {
    lines.push(`[${new Date(turn.at ?? 0).toISOString()}] you: ${turn.user ?? ""}`);
    for (const event of turn.events ?? []) {
      const details = event.details ?? {};
      if (!details.tool && !details.capability) continue;
      lines.push(`    · ${details.tool ?? details.capability}${details.preview ? ` — ${details.preview}` : ""}`);
    }
    if (turn.reply) lines.push(`  syscora: ${turn.reply}`);
    lines.push("");
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `syscora-report-${stamp}.txt`;
  link.click();
  // Revoked on a timer rather than immediately: Chromium starts the download
  // asynchronously and a URL revoked in the same tick can lose the race.
  setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
}

/**
 * The five rows, built fresh for one chat.
 *
 * Labels change with the chat's own state — "Pin" against "Unpin" — because a
 * menu that says Pin on something already pinned is a menu that is lying about
 * what the click will do.
 */
function chatActionItems(id) {
  const chat = chatById(id);
  if (!chat) return [];
  return [
    ["download", "Download chat as PDF", () => downloadChatPdf(id)],
    ["pin", chat.pinned ? "Unpin chat" : "Pin chat", () => pinChat(id)],
    ["archive", chat.archived ? "Move out of archive" : "Archive", () => archiveChat(id)],
    ["report", "Report a problem", () => reportChat(id)],
    // Last, and marked, because it is the one that cannot be undone. `undo`
    // covers files and messages; it has never covered this.
    ["delete", "Delete", () => deleteChat(id), "danger"]
  ].map(([icon, label, run, tone]) => {
    const item = el("button", `menu-item${tone ? ` ${tone}` : ""}`);
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.appendChild(svgIcon(icon));
    item.appendChild(el("span", null, label));
    item.addEventListener("click", () => {
      closeChatMenu();
      openMoreMenu(false);
      run();
    });
    return item;
  });
}

// ---- The row menu, one of it ---------------------------------------------

const chatMenu = document.getElementById("chatMenu");
let chatMenuAnchor = null;

function closeChatMenu() {
  if (!chatMenu) return;
  chatMenu.hidden = true;
  chatMenuAnchor?.setAttribute("aria-expanded", "false");
  chatMenuAnchor = null;
}

function openChatMenu(anchor, id) {
  if (!chatMenu) return;
  if (chatMenuAnchor === anchor && !chatMenu.hidden) return closeChatMenu();
  closeChatMenu();
  chatMenu.textContent = "";
  for (const item of chatActionItems(id)) chatMenu.appendChild(item);
  chatMenu.hidden = false;
  chatMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  // Measured after it is shown, because a hidden element has no size — and
  // flipped up when there is no room below, which on a rail of twenty-five
  // chats is most of them.
  const box = anchor.getBoundingClientRect();
  const menu = chatMenu.getBoundingClientRect();
  const below = window.innerHeight - box.bottom;
  chatMenu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.width - 8))}px`;
  chatMenu.style.top = below >= menu.height + 8
    ? `${box.bottom + 4}px`
    : `${Math.max(8, box.top - menu.height - 4)}px`;
}

document.addEventListener("click", (event) => {
  if (chatMenu?.hidden === false && !chatMenu.contains(event.target) && event.target !== chatMenuAnchor
      && !chatMenuAnchor?.contains(event.target)) {
    closeChatMenu();
  }
}, true);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeChatMenu(); });
// A menu pinned to a row that has moved is a menu pointing at the wrong chat.
window.addEventListener("resize", closeChatMenu);
document.getElementById("chatList")?.addEventListener("scroll", closeChatMenu);

// The rail's mark is the way back out of the collapsed state, and only then.
railToggle?.addEventListener("click", () => {
  if (document.body.classList.contains("rail-collapsed")) openChatsPanel(true);
});

chatsButton?.addEventListener("click", () => openChatsPanel(chatsPanel.hidden));
document.getElementById("chatsClose")?.addEventListener("click", () => openChatsPanel(false));
chatsBackdrop?.addEventListener("click", () => openChatsPanel(false));
// Restore the last state. Docked and open is the default on a window with room
// for it — the list is the first thing a returning user wants.
openChatsPanel((() => {
  try {
    const remembered = localStorage.getItem(SIDEBAR_KEY);
    if (remembered !== null) return remembered === "1";
  } catch { /* private mode */ }
  return !NARROW();
})());
// A window that shrinks past the docking width has to hand the backdrop back,
// or the sidebar overlays the conversation with nothing to dismiss it.
window.addEventListener("resize", () => {
  if (!chatsPanel.hidden) chatsBackdrop.hidden = !NARROW();
});
newChatButton?.addEventListener("click", startNewChat);
document.getElementById("panelNewChat")?.addEventListener("click", startNewChat);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && NARROW() && document.body.classList.contains("sidebar-open")) openChatsPanel(false);
});

// What the user was actually told, which is the only part of a turn a follow-up
// can refer to. A failure is recorded too — "why did that not work?" is a
// perfectly ordinary next message.
function replyTextOf(session) {
  const fr = session?.finalResponse ?? {};
  return fr.summary?.summary || fr.summary?.text || fr.message || fr.status || "";
}

// ---- Submitting --------------------------------------------------------------

// ---- Running / stopping ------------------------------------------------------

// While a request runs the send button becomes a stop button. One control: when
// it is working, "send another" is never what you want and "stop" always is.
const sendButton = document.getElementById("sendButton");
let runningSessionId = null;

// Both states are drawn, not typed. `textContent = "↑"` rendered whatever glyph
// the system font happened to have for an arrow — a different weight and a
// different baseline from every other control in the row.
const SEND_GLYPH = `<svg class="icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
  fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 19V5.6M5.8 11.8L12 5.4l6.2 6.4" /></svg>`;
const STOP_GLYPH = `<svg class="icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
  <rect x="6.5" y="6.5" width="11" height="11" rx="2.4" /></svg>`;

function setRunning(sessionId) {
  runningSessionId = sessionId;
  const running = sessionId !== null;
  sendButton.classList.toggle("stopping", running);
  sendButton.innerHTML = running ? STOP_GLYPH : SEND_GLYPH;
  sendButton.setAttribute("aria-label", running ? "Stop" : "Send message");
  sendButton.title = running ? "Stop" : "Send (Enter)";
}

async function stopRunning() {
  if (!runningSessionId) return;
  const sessionId = runningSessionId;
  // Optimistic: the button must respond to the press, not to the round trip.
  // The run settles on its own and renders whatever it had actually done.
  setRunning(null);
  try {
    await fetch(`/api/intents/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  } catch { /* the run settles regardless; nothing here is worth surfacing */ }
}

let reqId = 0;
async function submit(text, { attachments = [], routing = null, display = null } = {}) {
  if (runningSessionId) return;
  document.querySelector(".welcome")?.remove();
  // WHAT IS SENT AND WHAT IS SHOWN ARE NOT THE SAME THING.
  //
  // An attached document travels as its extracted text, which for a resume is
  // forty thousand characters. Putting that in the user's own bubble would bury
  // the question they actually asked under the file they attached. The bubble
  // shows what they typed and NAMES the attachments; the model gets both.
  //
  // ONE value, used everywhere the message is SHOWN — the bubble, the stored
  // chat that is replayed when it is re-opened, and the chat's title in the
  // sidebar. Those last two were reading `text`, so a folder's manifest came
  // back on reload and named the conversation after `--- Attached folder…`.
  const shown = display ?? stripAttachmentBlocks(text);
  const bubble = addBubble("user", textNode(shown));
  const chips = attachmentChips(attachments);
  if (chips) bubble?.appendChild?.(chips);
  // Which model was chosen and why, kept beside the request it applies to.
  if (routing) bubble?.appendChild?.(el("div", "bubble-routing", routing));
  // Copy and Edit. The turn does not exist in storage yet — recordTurn() runs
  // when it finishes — so the id is minted here and handed to recordTurn, which
  // is also what lets the actions work on a turn that never completed.
  const turnId = newId();
  attachUserActions(bubble, { id: turnId, user: shown, sent: text, attachments });
  // Captured BEFORE this turn is appended: history means the turns before this
  // one, and including the current message would duplicate it in the prompt.
  const history = conversation.slice();
  // The model gets the whole body; the sidebar gets the words the user typed —
  // or, when they typed none and simply dropped a folder in, its name.
  remember("user", text, shown || attachments.map((file) => file.name).join(", "));
  const turn = new Turn();
  // Kept so this turn can be drawn again when the chat is re-opened. Progress
  // events are skipped: a percentage that finished an hour ago is noise, and
  // they are by far the most numerous thing on the wire.
  const streamed = [];

  try {
    const res = await fetch("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope: {
          protocolVersion: "1.0.0",
          type: "intent_request",
          requestId: `demo-${reqId++}`,
          // A request is an instruction. The agent loop has no approval gate;
          // this only matters on the offline route, where it stops that route
          // asking a question the user has already answered by asking.
          payload: { text, history, autoApprove: true }
        },
        text,
        history,
        autoApprove: true
      })
    });
    const session = await readIntentSession(res, {
      onStart: (sessionId) => setRunning(sessionId),
      onEvent: (event) => {
        // A TRANSCRIPT IS THE RECORD, NOT THE TICKS. `streamed` is what a saved
        // chat is rebuilt from. TOOL_PROGRESS is a bar that moved; TOOL_STREAMING
        // is a byte count climbing while the model writes a call — a large
        // `write_file` is a couple of hundred of them, every one superseded by
        // the next and all of them by the TOOL_STARTED that follows. Neither is
        // worth keeping, and a replayed "3.2 KB so far" means nothing at all.
        if (!TRANSIENT_EVENTS.has(event.type ?? event.eventType)) streamed.push(event);
        handleEvent(turn, event);
      },
      // Only reached when the event stream could not be opened at all.
      onProgress: (status) => {
        const type = status?.latestEvent?.eventType;
        if (PHASE_STATUS[type]) turn.setStatus(PHASE_STATUS[type]);
      }
    });
    renderFinal(turn, session);
    remember("assistant", replyTextOf(session));
    recordTurn(shown, streamed, session, attachments, text, replyTextOf(session), turnId);
  } catch (err) {
    turn.settle();
    // "Worth trying again" was the whole diagnosis, and the real reason — the
    // daemon was not running — was thrown away unless developer mode happened
    // to be on. Retrying a request whose server is gone does not work, so the
    // one advice given was the one thing that could not help. Say what
    // happened, in every mode: it is one line, and it is the difference between
    // starting the daemon and debugging the agent.
    if (isDaemonUnreachable(err)) {
      setDaemonReachable(false);
      turn.append(el("div", "agent-answer",
        "I can't reach the SYSCORA daemon — it isn't running, or it restarted on a different port. " +
        "Start it with `npm run mvp:ui`, reload this page, and send that again. Nothing was changed."));
    } else {
      turn.append(el("div", "agent-answer", `Something went wrong while running that: ${err.message}`));
    }
    // A turn that failed is still part of the conversation — "why did that not
    // work?" is an ordinary next message, and it needs the turn to be there.
    recordTurn(shown, streamed, null, attachments, text, null, turnId);
  } finally {
    setRunning(null);
  }
}

async function resume(sessionId, approve) {
  const turn = new Turn();
  turn.setStatus(approve ? "Approved — continuing…" : "Cancelling…");
  try {
    const path = approve
      ? `/api/sessions/${encodeURIComponent(sessionId)}/resume`
      : `/api/sessions/${encodeURIComponent(sessionId)}/cancel`;
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoApprove: approve })
    });
    if (!res.ok) {
      turn.settle();
      turn.append(el("div", "agent-answer", `I couldn't continue (${res.status}).`));
      return;
    }
    const json = await res.json();
    const session = getPayload(json).session ?? json.session;
    for (const event of session?.events ?? []) handleEvent(turn, event);
    if (session) renderFinal(turn, session);
  } catch (err) {
    turn.settle();
    turn.append(el("div", "agent-answer", `I couldn't continue: ${debug ? err.message : "please retry."}`));
  }
}

// Stopping is handled on the BUTTON's click, not the form's submit.
//
// The textarea is `required`, so a click with an empty box triggers the
// browser's own validation — "Please fill out this field." — and the submit
// event never fires. Live, that meant the stop button visibly did nothing: the
// user pressed stop, got a validation bubble about the message they had not
// typed, and the request carried on running.
sendButton.addEventListener("click", (event) => {
  if (!runningSessionId) return;
  event.preventDefault();
  stopRunning();
});


/* ===========================================================================
   THE COMPOSER: attachments and model choice
   ===========================================================================*/

const fileInput = document.getElementById("fileInput");
const imageInput = document.getElementById("imageInput");
const folderInput = document.getElementById("folderInput");
const attachButton = document.getElementById("attachButton");
const attachMenu = document.getElementById("attachMenu");
const attachmentStrip = document.getElementById("attachmentStrip");
const modelSelect = document.getElementById("modelSelect");
const modelHint = document.getElementById("modelHint");

let attachedFiles = [];

// ---- The "+" menu ------------------------------------------------------------
//
// WHY A MENU AND NOT A BUTTON. `webkitdirectory` is a property of the <input>,
// not of the click, so "pick a file" and "pick a folder" are two different
// inputs and the choice has to be made BEFORE the dialog opens. A single paperclip
// could therefore never offer a folder — which is the attachment that matters
// most here, because SYSCORA runs on the machine the folder is on.

const PICKERS = { file: fileInput, image: imageInput, folder: folderInput };

// ONE MENU AT A TIME. Both of the composer's menus open upward from the same
// row, so with no exclusion the second one was drawn ON TOP of the first and
// the pair read as one unreadable stack of half-rows. Opening either closes the
// other; the two openers are declared far apart in this file, so each guards
// with `typeof` rather than depending on the order they are evaluated in.
function closeOtherComposerMenus(except) {
  if (except !== "attach" && typeof openAttachMenu === "function") openAttachMenu(false);
  if (except !== "model" && typeof openModelMenu === "function") openModelMenu(false);
}

function openAttachMenu(open) {
  if (!attachMenu || !attachButton) return;
  if (open) closeOtherComposerMenus("attach");
  attachMenu.hidden = !open;
  attachButton.setAttribute("aria-expanded", String(open));
  attachButton.classList.toggle("open", open);
}

attachButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  openAttachMenu(attachMenu.hidden);
});

attachMenu?.addEventListener("click", (event) => {
  const choice = event.target.closest("button[data-pick]")?.dataset.pick;
  if (!choice) return;
  openAttachMenu(false);
  // Cleared first, because picking the SAME file twice in a row fires no change
  // event otherwise — the value has not changed, so the browser has nothing to
  // report, and the attachment silently does not appear.
  const input = PICKERS[choice];
  if (!input) return;
  input.value = "";
  input.click();
});

// ---- The "⋯" menu ------------------------------------------------------------
//
// Developer mode used to be a checkbox in the top bar of a product for people
// who do not read JSON. Same switch, same id, one click further away.
const moreButton = document.getElementById("moreButton");
const moreMenu = document.getElementById("moreMenu");

function openMoreMenu(open) {
  if (!moreMenu || !moreButton) return;
  // Rebuilt on every open, not once at start-up: the labels read the chat's own
  // state ("Pin" against "Unpin") and the chat you are looking at changes under
  // this menu all day. A menu built once says Pin on something already pinned.
  const actions = document.getElementById("moreChatActions");
  if (open && actions) {
    actions.textContent = "";
    for (const item of chatActionItems(activeChatId)) actions.appendChild(item);
  }
  moreMenu.hidden = !open;
  moreButton.setAttribute("aria-expanded", String(open));
  moreButton.classList.toggle("open", open);
}

// WHICH MAILBOX THIS APPLICATION CAN SEND FROM.
//
// Read when the menu is opened rather than on a timer: it changes about once
// ever, and a poll for it would be a request every few seconds for the life of
// the window. Failing quietly is right here — an unreachable daemon already has
// its own pill in the top bar, and this row simply stays hidden.
const mailAccounts = document.getElementById("mailAccounts");

async function refreshMailAccount() {
  if (!mailAccounts) return;
  let status;
  try {
    status = await (await fetch("/api/email/status")).json();
  } catch {
    mailAccounts.hidden = true;
    return;
  }
  const list = status.accounts ?? [];
  mailAccounts.hidden = list.length === 0;
  mailAccounts.textContent = "";
  if (list.length === 0) return;
  mailAccounts.appendChild(el("div", "more-mail-head", list.length === 1 ? "Gmail" : `Gmail · ${list.length} accounts`));
  for (const entry of list) {
    const row = el("div", "more-mail-row");
    const text = el("span", "more-mail-text");
    text.appendChild(el("span", "more-mail-address", entry.address));
    // Which one a draft starts on. Worth saying, because it is the difference
    // between "this is connected" and "this is the one it will use".
    if (entry.address === status.address && list.length > 1) {
      text.appendChild(el("em", null, "default"));
    }
    const remove = el("button", "more-mail-disconnect", "Disconnect");
    remove.type = "button";
    remove.setAttribute("aria-label", `Disconnect ${entry.address}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await fetch("/api/email/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // ONE ACCOUNT, NAMED. Without the address this endpoint forgets every
          // account, which is a very different thing to have done by accident.
          body: JSON.stringify({ address: entry.address })
        });
      } catch { /* the list refreshes below either way */ }
      await refreshMailAccount();
    });
    row.append(text, remove);
    mailAccounts.appendChild(row);
  }
}

moreButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = moreMenu.hidden;
  openMoreMenu(opening);
  if (opening) refreshMailAccount();
});
// Clicks INSIDE it must not close it: the one thing in there is a checkbox, and
// a menu that shuts the moment you tick something is a menu that fights you.
moreMenu?.addEventListener("click", (event) => event.stopPropagation());

// Anywhere else, and Escape. A menu that only closes by choosing something is a
// menu you cannot back out of.
document.addEventListener("click", () => { openAttachMenu(false); openMoreMenu(false); openModelMenu(false); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (attachMenu && !attachMenu.hidden) openAttachMenu(false);
  if (moreMenu && !moreMenu.hidden) openMoreMenu(false);
  if (modelMenu && !modelMenu.hidden) openModelMenu(false);
});

// Auto first, because it is the right answer for almost every request and the
// only one that can pick a model able to read what has been attached.
function fillModelPicker() {
  if (!modelSelect) return;
  const auto = document.createElement("option");
  auto.value = AUTO;
  auto.textContent = "Auto";
  modelSelect.appendChild(auto);
  for (const model of selectableModels()) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    modelSelect.appendChild(option);
  }
  // Remembered per machine. A model choice that resets every launch is one
  // nobody bothers to make.
  const remembered = localStorage.getItem("syscora_model");
  modelSelect.value = remembered && [AUTO, ...MODELS.map((m) => m.id)].includes(remembered) ? remembered : AUTO;
  buildModelMenu();
  describeModelChoice();
}

// THE MENU DRAWN IN FRONT OF THE NATIVE ONE.
//
// The <select> stays and stays authoritative — everything else in this file
// reads `modelSelect.value` — so this only ever sets that value and dispatches
// the `change` the rest of the code is already listening for. If this JavaScript
// failed to run entirely, the native control underneath would still work.
const modelButton = document.getElementById("modelButton");
const modelButtonLabel = document.getElementById("modelButtonLabel");
const modelMenu = document.getElementById("modelMenu");

function labelForModel(id) {
  return id === AUTO ? "Auto" : (MODELS.find((entry) => entry.id === id)?.label ?? id);
}

function openModelMenu(open) {
  if (!modelMenu || !modelButton) return;
  if (open) closeOtherComposerMenus("model");
  modelMenu.hidden = !open;
  modelButton.setAttribute("aria-expanded", String(open));
  modelButton.classList.toggle("open", open);
}

function buildModelMenu() {
  if (!modelMenu) return;
  modelMenu.textContent = "";
  const entries = [
    { id: AUTO, label: "Auto", blurb: MODELS.length > 1 ? "Picks the cheapest model that can do the job" : "Chooses for you" },
    ...selectableModels().map((model) => ({ id: model.id, label: model.label, blurb: model.blurb }))
  ];
  for (const entry of entries) {
    const item = el("button", "model-menu-item");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.dataset.model = entry.id;
    const text = el("span", "model-menu-text");
    text.appendChild(el("strong", null, entry.label));
    if (entry.blurb) text.appendChild(el("em", null, entry.blurb));
    const tick = el("span", "model-menu-tick");
    tick.appendChild(svgIcon("check"));
    item.append(tick, text);
    modelMenu.appendChild(item);
  }
  syncModelButton();
}

function syncModelButton() {
  if (modelButtonLabel) modelButtonLabel.textContent = labelForModel(modelSelect?.value ?? AUTO);
  for (const item of modelMenu?.querySelectorAll(".model-menu-item") ?? []) {
    const chosen = item.dataset.model === modelSelect?.value;
    item.classList.toggle("chosen", chosen);
    item.setAttribute("aria-checked", String(chosen));
  }
}

modelButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  openModelMenu(modelMenu.hidden);
});
modelMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
  const id = event.target.closest(".model-menu-item")?.dataset.model;
  if (!id || !modelSelect) return;
  modelSelect.value = id;
  // The one line that keeps the rest of the file working unchanged.
  modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  openModelMenu(false);
});

function describeModelChoice() {
  if (!modelHint) return;
  const chosen = modelSelect.value;
  if (chosen === AUTO) {
    modelHint.textContent = MODELS.length > 1
      ? "picks the cheapest model that can do the job"
      : "";
    modelHint.classList.remove("error");
    return;
  }
  const model = MODELS.find((entry) => entry.id === chosen);
  modelHint.textContent = model?.blurb ?? "";
  modelHint.classList.remove("error");
}

function showComposerError(message) {
  if (!modelHint) return;
  modelHint.textContent = message;
  modelHint.classList.add("error");
}

const humanBytes = (bytes) => {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

// The one line under each chip: what will actually be SENT for this attachment.
// Not decoration — an attached PDF travels as extracted text and an image
// travels as pixels to a model that may not be able to look at them, and the
// user is entitled to know which before they press send rather than after.
function attachmentNote(file) {
  if (file.kind === "pending") return "reading…";
  if (file.kind === "rejected") return file.error;
  if (file.kind === "image") return `image · ${humanBytes(file.bytes)}`;
  if (file.kind === "folder") {
    return `${file.fileCount.toLocaleString()} file${file.fileCount === 1 ? "" : "s"} · ` +
      (file.path ? "SYSCORA can open it where it is" : "listing only");
  }
  return `${file.extractedBy} · ${file.text.length.toLocaleString()} characters` +
    (file.truncated ? " (clipped)" : "");
}

function renderAttachments() {
  if (!attachmentStrip) return;
  attachmentStrip.textContent = "";
  attachmentStrip.hidden = attachedFiles.length === 0;
  for (const [index, file] of attachedFiles.entries()) {
    const chip = el("div", `attachment-chip ${file.kind}`);

    // AN IMAGE IS SHOWN, NOT NAMED. "screenshot-2026-08-23.png" tells you
    // nothing about which screenshot it is, and the whole reason for attaching a
    // picture is that the picture is the content.
    if (file.kind === "image" && file.dataUrl) {
      const thumb = el("img", "attachment-thumb");
      thumb.src = file.dataUrl;
      thumb.alt = file.name;
      chip.appendChild(thumb);
    } else {
      const icon = el("span", "attachment-icon");
      icon.appendChild(svgIcon({ folder: "folder", rejected: "warn", pending: "hourglass" }[file.kind] ?? "file"));
      chip.appendChild(icon);
    }

    const meta = el("div", "attachment-meta");
    meta.appendChild(el("span", "attachment-name", file.name));
    meta.appendChild(el("span", "attachment-note", attachmentNote(file)));
    chip.appendChild(meta);

    const remove = el("button", "attachment-remove");
    remove.appendChild(svgIcon("close"));
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.title = `Remove ${file.name}`;
    remove.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      renderAttachments();
      // Removing the image that could not be read has to clear the refusal it
      // caused, or the composer goes on refusing a send that is now fine.
      revalidateAttachments();
    });
    chip.appendChild(remove);
    attachmentStrip.appendChild(chip);
  }
}

function clearAttachments() {
  attachedFiles = [];
  for (const input of Object.values(PICKERS)) if (input) input.value = "";
  renderAttachments();
  describeModelChoice();
}

// Whether what is attached can be sent to the model that is selected, said as
// soon as it is attached rather than when send is pressed. Called from every
// path that changes either side of that question.
function revalidateAttachments() {
  const usable = attachedFiles.filter((file) => file.kind !== "rejected" && file.kind !== "pending");
  if (!usable.length) return describeModelChoice();
  const verdict = checkAttachments(modelSelect.value, usable);
  if (!verdict.ok) return showComposerError(verdict.reason);
  if (verdict.reason && modelSelect.value === AUTO) {
    modelHint.textContent = verdict.reason;
    modelHint.classList.remove("error");
    return;
  }
  return describeModelChoice();
}

async function acceptFiles(files) {
  for (const file of files) {
    // The chip appears BEFORE the file is read. Extracting a large PDF is a
    // round trip to the daemon, and without this the composer sits still for a
    // second after the dialog closes and looks as if the pick did not take.
    const chip = { name: file.name, kind: "pending", bytes: file.size };
    attachedFiles.push(chip);
    renderAttachments();
    let prepared;
    try {
      prepared = await prepareAttachment(file);
    } catch (error) {
      prepared = { name: file.name, kind: "rejected", error: `${file.name} could not be read: ${error?.message ?? error}` };
    }
    // By identity, not by index: another file finishing first, or the user
    // removing a chip while this one was being read, moves everything along —
    // and writing to a stale index overwrites somebody else's attachment.
    const at = attachedFiles.indexOf(chip);
    if (at >= 0) attachedFiles[at] = prepared;
    renderAttachments();
  }
  // Say immediately whether the current model can take what was just attached,
  // rather than waiting for the user to press send and be refused.
  revalidateAttachments();
}

// A FOLDER IS ONE ATTACHMENT, NOT SIX HUNDRED.
//
// The folder picker hands over every file inside it, individually. Treated as
// files that is somebody's whole project directory attached one chip at a time,
// megabytes of node_modules read into the page to answer a question about one
// file in it. What the user chose was a PLACE — so it is shown as one chip with
// the folder's name on it, exactly as the picker was labelled.
function acceptFolder(files) {
  const folder = prepareFolder(files);
  if (!folder) return;
  attachedFiles.push(folder);
  renderAttachments();
  revalidateAttachments();
}

if (fileInput) fileInput.addEventListener("change", () => acceptFiles([...fileInput.files]));
if (imageInput) imageInput.addEventListener("change", () => acceptFiles([...imageInput.files]));
if (folderInput) folderInput.addEventListener("change", () => acceptFolder([...folderInput.files]));
if (modelSelect) modelSelect.addEventListener("change", () => {
  syncModelButton();
  localStorage.setItem("syscora_model", modelSelect.value);
  // Not describeModelChoice(): switching models with an image already attached
  // has to re-run the capability check, or a refusal stays on screen after the
  // user has fixed it — or worse, disappears when they have not.
  revalidateAttachments();
});

// Drag and drop onto the whole conversation, because that is where people aim.
for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    document.body.classList.toggle("dragging", eventName === "dragover");
    if (eventName !== "drop") return;
    document.body.classList.remove("dragging");
    // A DROPPED FOLDER IS A FOLDER. `dataTransfer.files` lists a dropped
    // directory as a single entry with an empty type and no readable bytes, so
    // sending it through acceptFiles produced "not a file type this can read"
    // for something the user had every reason to expect would work. The
    // filesystem entry API is the only thing that can tell the two apart.
    const items = [...(event.dataTransfer.items ?? [])];
    const droppedDirectory = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
    if (droppedDirectory) return acceptDroppedDirectories(items);
    acceptFiles([...event.dataTransfer.files]);
  });
}

// Walk a dropped directory into the same shape the folder picker produces, so
// choosing a folder and dropping one end up at exactly one code path.
//
// BOUNDED, because somebody will drop C:\ on it. The walk stops at a file count
// and a depth rather than running until the tab dies, and prepareFolder is
// already honest about a listing being incomplete.
const MAX_WALKED_FILES = 5000;
const MAX_WALKED_DEPTH = 12;

async function acceptDroppedDirectories(items) {
  const collected = [];
  const loose = [];

  const walk = async (entry, prefix, depth) => {
    if (collected.length >= MAX_WALKED_FILES || depth > MAX_WALKED_DEPTH) return;
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (!file) return;
      // The picker sets webkitRelativePath and a dropped entry does not —
      // everything downstream reads it to work out the folder's own name.
      Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}${file.name}`, configurable: true });
      collected.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    const inside = `${prefix}${entry.name}/`;
    const reader = entry.createReader();
    // readEntries hands back at most a hundred at a time and signals the end
    // with an EMPTY batch, so a single call reads a hundred files and silently
    // stops — which on a real project directory looks like most of it vanishing.
    for (;;) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const child of batch) await walk(child, inside, depth + 1);
    }
  };

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) await walk(entry, "", 0);
    else if (entry?.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) loose.push(file);
    }
  }
  if (collected.length) acceptFolder(collected);
  // A drop can be a folder AND some files beside it. Each goes where it belongs.
  if (loose.length) acceptFiles(loose);
}
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dragging");
});

// Pasting a screenshot is how people share one.
chatInput?.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) { event.preventDefault(); acceptFiles(files); }
});

fillModelPicker();

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (runningSessionId) return;
  const text = chatInput.value.trim();
  // A file still being read is not an attachment yet. Sending while one is
  // pending would drop it silently — the model would answer about a document it
  // was never given, which is the exact failure this product exists to prevent.
  if (attachedFiles.some((file) => file.kind === "pending")) {
    showComposerError("Still reading an attachment — one moment.");
    return;
  }
  const attachments = attachedFiles.filter((file) => file.kind !== "rejected");
  if (!text && !attachments.length) return;

  // REFUSE BEFORE SENDING, NOT AFTER.
  //
  // If the chosen model cannot read what is attached, the request must stop
  // here with a sentence naming the way out. Sending it anyway means the model
  // answers confidently about a file it never saw, which is the failure this
  // whole product exists to make impossible.
  const verdict = checkAttachments(modelSelect.value, attachments);
  if (!verdict.ok) {
    showComposerError(verdict.reason);
    return;
  }

  // Documents travel as extracted TEXT, fenced and labelled, so the model can
  // tell the user's words from the file's contents.
  const body = `${text}${describeAttachments(attachments)}`;
  chatInput.value = "";
  // Back to one line, through the same function that grew it — a second place
  // that decides the composer's height is a second place that can be wrong.
  growComposer();
  // `display: text` rather than trusting stripAttachmentBlocks() to undo what
  // describeAttachments() just did. The words the user typed are RIGHT HERE;
  // recovering them by regex from the body is a round trip that only has to be
  // wrong once — and it was, for folders, for as long as folders have existed.
  submit(body, { attachments, model: verdict.model ?? null, routing: verdict.reason ?? null, display: text });
  clearAttachments();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
// THE COMPOSER GROWS WITH WHAT IS BEING WRITTEN.
//
// This function existed and did nothing, and the reason is worth writing down
// because it is invisible in both files on their own. `#chatInput` carries
// `flex: 1` from the generation where `.chat-bar` was a flex ROW and the
// textarea sat beside the send button. A later pass turned the composer into a
// COLUMN and nobody revisited the item. `flex: 1` is `flex-basis: 0%`, and on a
// flex item the basis REPLACES `height` on the main axis — which had just
// become the vertical one. So the height set here was computed, applied, and
// then ignored by layout: measured live, inline `height: 160px` against a
// computed `41.25px`. The user typed a paragraph, the box stayed one line tall,
// and the text scrolled away above the caret.
//
// The fix is `flex: 0 0 auto` in demo.css. The cap lives there too, as
// `max-height`, so there is ONE number: this sets the natural height and CSS
// clamps it. A hard-coded ceiling here is how the two drifted apart before.
function growComposer() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}
chatInput.addEventListener("input", growComposer);
// A paste fires `input` too, but not until after the default action — and the
// pasted text is what makes the box jump three lines, so it is the case that
// most needs to be right.
chatInput.addEventListener("paste", () => requestAnimationFrame(growComposer));
// Narrowing the window rewraps the text, which changes how many lines it is.
window.addEventListener("resize", growComposer);

suggestions.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-text]");
  if (!btn) return;
  const text = btn.getAttribute("data-text");
  // A suggested prompt is a one-click demo: it goes through the exact same chat
  // path a typed request uses (no bypass).
  submit(text);
});

// ---- Opening on what you were last doing --------------------------------------
//
// A reload used to land on an empty welcome screen with the conversation still
// silently in memory: the agent remembered the thread and the user could not see
// it. Now the transcript comes back with it.
renderChatList();
if (activeChat().turns.length > 0) renderStoredChat(activeChat());
