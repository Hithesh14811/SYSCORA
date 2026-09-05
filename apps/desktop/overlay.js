// THE PILL — SYSCORA as a command bar over the whole desktop.
//
// This is a second SURFACE onto the product, not a second product. It sends the
// same `POST /api/intents` the chat sends, with the same envelope and the same
// stored conversation, and follows the same event stream. What differs is what
// it CHOOSES TO SHOW, because a floating bar has no room for a transcript:
//
//   the pill      what it saw and what it is doing, streaming, above the box
//   the tool box  what is running RIGHT NOW; stacks down, leaves upwards
//   the log       everything that has run, on request, expandable
//
// WHY IT CAN HAND OVER MID-RUN. A run lives in the daemon, which replays every
// event of it to any later subscriber of `/api/intents/:id/stream`. So "expand"
// is not a transfer of state between two renderers — it is a second reader
// attaching to a stream that is already going. Nothing here has to serialise a
// conversation, and neither surface can drift from the other, because neither of
// them is the source of truth.

import { readIntentSession } from "./intent-client.js";
import { AUTO, checkAttachments, modelById, selectableModels } from "./models.js";
import { describeAttachments, prepareAttachment, prepareFolder } from "./attachments.js";
import { activeChatTitle, appendMessage, readHistory, recordTurn, startNewChat } from "./chat-store.js";
import { withApiToken } from "./api-fetch.js";
import { STATUS, pendingVerbFor, runningVerbFor } from "./status-words.js";

const bridge = globalThis.syscora?.overlay ?? null;

// EVERY /api CALL NEEDS THE TOKEN, AND THIS PAGE WAS SENDING NONE. See
// api-fetch.js: the daemon authenticates every mutating route, `demo.js` has
// always wrapped fetch to attach the header, and this file reproduced the fetch
// calls without it — so the first thing typed into the pill came back
// "Unauthorized: missing or invalid x-syscora-token header."
//
// The shell injects the token in-process; `sessionStorage` is the same fallback
// the chat uses, so a browser tab that has been through the Connect panel works
// here too.
globalThis.fetch = withApiToken(
  globalThis.fetch.bind(globalThis),
  globalThis.syscora?.apiToken ?? sessionStorage.getItem("syscora_token") ?? null
);

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const form = $("pillForm");
const input = $("pillInput");
const narration = $("narration");
const chatName = $("chatName");
const phase = $("phase");
const phaseLabel = $("phaseLabel");
const toolbox = $("toolbox");
const running = $("running");
const log = $("log");
const logList = $("logList");
const logToggle = $("logToggle");
const logClose = $("logClose");
const sendButton = $("sendButton");
const expandButton = $("expandButton");
const newChatButton = $("newChatButton");
const voiceButton = $("voiceButton");
const thinkButton = $("thinkButton");
const thinkLabel = $("thinkLabel");
const modelButton = $("modelButton");
const modelLabel = $("modelLabel");
const modelMenu = $("modelMenu");
const attachButton = $("attachButton");
const attachMenu = $("attachMenu");
const attachmentStrip = $("attachmentStrip");
const backgroundButton = $("backgroundButton");
const backgroundCount = $("backgroundCount");
const backgroundPanel = $("backgroundPanel");

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------------
// The window is transparent and floats over everything, so it must be a hole
// everywhere except the parts that are actually drawn.
// ---------------------------------------------------------------------------

// A TRANSPARENT WINDOW STILL SWALLOWS CLICKS. The shell starts this window
// ignoring the mouse entirely and forwarding moves, so the only way to be
// clickable is to ask for it back while the pointer is genuinely over something
// drawn — and to give it up the moment it leaves. Without the second half,
// SYSCORA punches a dead rectangle through whatever is underneath it.
const SOLID = ".pill-shell, .toolbox, .log";
let interactive = false;
function setInteractive(next) {
  if (next === interactive) return;
  interactive = next;
  bridge?.setInteractive(next);
}

// `pointermove` on the document, because the window forwards moves while it is
// ignoring clicks — a `mouseenter` on the pill would never fire in that state.
document.addEventListener("pointermove", (event) => {
  // While dragging, the pointer is often outside the window (it is moving), and
  // giving interactivity up mid-drag drops the rest of the gesture.
  if (dragging) return;
  const over = document.elementFromPoint(event.clientX, event.clientY);
  setInteractive(Boolean(over?.closest(SOLID)));
});
document.addEventListener("pointerleave", () => { if (!dragging) setInteractive(false); });

// The window is sized to its content, and only the renderer knows how tall that
// is. Measured from the stage rather than the body so padding is included.
let lastHeight = 0;
function syncHeight() {
  const height = Math.ceil(stage.getBoundingClientRect().height) + 4;
  if (height === lastHeight) return;
  lastHeight = height;
  bridge?.resize(height);
}
new ResizeObserver(() => syncHeight()).observe(stage);

// ---------------------------------------------------------------------------
// Moving it.
//
// The whole pill is the handle, minus the controls — a 10px grip strip was the
// first attempt and nobody could hit it. And the move is ABSOLUTE: the renderer
// reports the total offset from where the gesture started and the main process
// applies it to the window position it recorded at pointerdown. Summing deltas
// across async IPC could not work; see the note in main.js.
// ---------------------------------------------------------------------------

const NOT_A_HANDLE = "button, textarea, input, select, a, .pill-menu, .log-list, .narration, .background-panel";
let dragging = false;

form.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest(NOT_A_HANDLE)) return;
  const startX = event.screenX;
  const startY = event.screenY;
  let moved = false;
  dragging = true;
  setInteractive(true);
  form.setPointerCapture(event.pointerId);

  const move = (moveEvent) => {
    const dx = moveEvent.screenX - startX;
    const dy = moveEvent.screenY - startY;
    // A click on the pill background should still put the caret in the box, so
    // a gesture only becomes a drag once it has actually travelled.
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (!moved) {
      moved = true;
      bridge?.dragStart();
      document.body.classList.add("dragging");
    }
    bridge?.dragMove(dx, dy);
  };
  const stop = () => {
    form.removeEventListener("pointermove", move);
    form.removeEventListener("pointerup", stop);
    form.removeEventListener("pointercancel", stop);
    document.body.classList.remove("dragging");
    dragging = false;
    if (moved) bridge?.dragEnd();
    else input.focus();
  };
  form.addEventListener("pointermove", move);
  form.addEventListener("pointerup", stop);
  form.addEventListener("pointercancel", stop);
});

// ---------------------------------------------------------------------------
// Composer state. The same controls the chat composer has, because they are
// properties of the MESSAGE and the message is the same one.
// ---------------------------------------------------------------------------

const THINKING = ["auto", "always", "never"];
const THINKING_LABEL = { auto: "Auto", always: "On", never: "Off" };
let thinking = "auto";
let selectedModel = AUTO;
let attachments = [];

thinkButton.addEventListener("click", () => {
  thinking = THINKING[(THINKING.indexOf(thinking) + 1) % THINKING.length];
  thinkLabel.textContent = THINKING_LABEL[thinking];
  thinkButton.dataset.on = String(thinking !== "auto");
  thinkButton.setAttribute("aria-label", `Thinking: ${thinking}`);
});

function renderModelMenu() {
  modelMenu.replaceChildren();
  const pick = (id, label, blurb) => {
    const button = el("button", null);
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-checked", String(selectedModel === id));
    button.append(document.createTextNode(label));
    if (blurb) button.append(el("em", null, blurb));
    button.addEventListener("click", () => {
      selectedModel = id;
      modelLabel.textContent = label;
      closeMenus();
    });
    modelMenu.append(button);
  };
  pick(AUTO, "Auto", "Picks the cheapest model that can do it");
  for (const model of selectableModels()) pick(model.id, model.label, model.blurb);
}

function closeMenus() {
  modelMenu.hidden = true;
  attachMenu.hidden = true;
  modelButton.setAttribute("aria-expanded", "false");
  attachButton.setAttribute("aria-expanded", "false");
}

modelButton.addEventListener("click", () => {
  const open = modelMenu.hidden;
  closeMenus();
  if (open) {
    renderModelMenu();
    modelMenu.hidden = false;
    modelButton.setAttribute("aria-expanded", "true");
  }
});

attachButton.addEventListener("click", () => {
  const open = attachMenu.hidden;
  closeMenus();
  if (open) {
    attachMenu.hidden = false;
    attachButton.setAttribute("aria-expanded", "true");
  }
});

attachMenu.addEventListener("click", (event) => {
  const pickKind = event.target.closest("[data-pick]")?.dataset.pick;
  if (!pickKind) return;
  closeMenus();
  ({ image: $("imageInput"), file: $("fileInput"), folder: $("folderInput") })[pickKind]?.click();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".model-picker, .attach")) closeMenus();
});

// A folder is a PLACE, not a payload — the same rule the chat composer follows.
for (const [id, handler] of [
  ["fileInput", async (files) => Promise.all(files.map(prepareAttachment))],
  ["imageInput", async (files) => Promise.all(files.map(prepareAttachment))],
  ["folderInput", async (files) => [prepareFolder(files)]]
]) {
  $(id)?.addEventListener("change", async (event) => {
    const files = [...event.target.files ?? []];
    event.target.value = "";
    if (files.length === 0) return;
    try {
      attachments = attachments.concat((await handler(files)).filter(Boolean));
      renderAttachments();
    } catch (error) {
      note(`That attachment could not be read: ${error?.message ?? error}`, "error");
    }
  });
}

function renderAttachments() {
  attachmentStrip.replaceChildren();
  attachmentStrip.hidden = attachments.length === 0;
  attachments.forEach((attachment, index) => {
    const chip = el("span", "attachment-chip");
    chip.append(el("span", null, attachment.name ?? "attachment"));
    const remove = el("button", null, "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name ?? "attachment"}`);
    remove.addEventListener("click", () => {
      attachments = attachments.filter((_, at) => at !== index);
      renderAttachments();
    });
    chip.append(remove);
    attachmentStrip.append(chip);
  });
}

// ---------------------------------------------------------------------------
// A NEW SUBJECT. The conversation carries into the next message, so there has
// to be a way to say it should not. Shared with the chat window: both read and
// write the same stored conversation, so this starts a new one THERE too.
// ---------------------------------------------------------------------------

newChatButton.addEventListener("click", () => {
  startNewChat();
  clearNarration();
  clearTools();
  entries.length = 0;
  renderLog();
  log.hidden = true;
  logToggle.setAttribute("aria-expanded", "false");
  setState("idle");
  setPhase(null);
  showChatName();
  note("New chat.");
  input.focus();
});

// ---------------------------------------------------------------------------
// Voice. The button is real and holds its state; nothing behind it captures
// audio yet, and it says so rather than doing nothing.
// ---------------------------------------------------------------------------

voiceButton.addEventListener("click", () => {
  const on = voiceButton.getAttribute("aria-pressed") === "true";
  voiceButton.setAttribute("aria-pressed", String(!on));
  if (!on) {
    note("Voice input is not wired up yet — type it for now.", "error");
    setTimeout(() => voiceButton.setAttribute("aria-pressed", "false"), 1500);
  }
});

// ---------------------------------------------------------------------------
// WHAT IT SAW AND WHAT IT IS DOING — the narration, streaming, above the box.
//
// `saw` is what the model is working from, quoted; `say` is what it is doing
// about it. Both are already required on every tool call, and on this surface
// they are the whole of the running commentary — the pill grows upward into
// about twice its height and the newest line sits against the text box.
// ---------------------------------------------------------------------------

// Sticks to the newest line WHILE STREAMING and stops the moment the user
// scrolls away. A view that yanks itself back to the bottom while somebody is
// reading is worse than one that never moved.
let stickToBottom = true;
narration.addEventListener("scroll", () => {
  const distance = narration.scrollHeight - narration.scrollTop - narration.clientHeight;
  stickToBottom = distance < 24;
});

function clearNarration() {
  narration.replaceChildren();
  narration.hidden = true;
  stickToBottom = true;
  streaming = null;
  streamed = "";
  syncHeight();
}

function scrollIfSticking() {
  if (stickToBottom) narration.scrollTop = narration.scrollHeight;
  syncHeight();
}

// Bounded: this is a floating bar, not a transcript. The whole run is in the
// chat, one click away, and the log keeps every tool call.
function trimNarration() {
  while (narration.childElementCount > 60) narration.firstElementChild.remove();
}

function narrate(saw, say) {
  // DO NOT SAY IT AGAIN JUST BECAUSE IT ARRIVED TWICE.
  //
  // The answer reaches this surface on more than one channel: `AGENT_DELTA` as
  // it is generated, `AGENT_SAYS` when the runtime publishes it, and the settle
  // message at the end. All three carry the SAME words, and rendering each of
  // them is the "everything twice or thrice" this fixes — measured against a
  // local streaming endpoint, where the answer appeared once from the stream and
  // once again from AGENT_SAYS, character for character.
  //
  // The guard is on the TEXT rather than on the channel, because which channel
  // repeats depends on the runtime and would have to be rediscovered every time
  // that changes.
  if (!saw && alreadyStreamed(say)) return;
  const line = el("div", "narration-line");
  if (saw) line.append(el("span", "saw", saw));
  if (say) line.append(el("span", "say", say));
  if (!line.childNodes.length) return;
  // A new line of its own ENDS the answer that was streaming: whatever comes
  // next belongs after it, not appended to it.
  streaming = null;
  narration.hidden = false;
  narration.append(line);
  trimNarration();
  scrollIfSticking();
}

// THE ANSWER ARRIVES A FRAGMENT AT A TIME, AND IT IS ONE ANSWER.
//
// `AGENT_DELTA` is the model's reply as it is generated — a few characters per
// event, hundreds of them for a paragraph. The first version made a new
// narration line out of EVERY fragment, so a two-sentence answer came out as
// forty separate lines reading "I", "'m", "SYSCORA", "— the"... and then the
// whole thing appeared AGAIN when the run settled and the final message was
// added. That is the "everything twice or thrice" this fixes.
//
// So the fragments accumulate into ONE line, and what has accumulated is
// remembered so the settle can tell whether it has already been shown.
let streaming = null;
let streamed = "";

function narrateDelta(text) {
  const fragment = String(text ?? "");
  if (!fragment) return;
  if (!streaming) {
    streaming = el("div", "narration-line");
    streaming.append(el("span", "say", ""));
    narration.hidden = false;
    narration.append(streaming);
    trimNarration();
  }
  streamed += fragment;
  streaming.firstElementChild.textContent = streamed.trim();
  scrollIfSticking();
}

/** Has this text already reached the screen as a stream? */
function alreadyStreamed(text) {
  const body = String(text ?? "").trim();
  if (!body || !streamed) return false;
  const shown = streamed.trim();
  if (shown === body) return true;
  // Not ONLY equality: the settle message is sometimes the streamed answer with
  // a trailing note bolted on, and a whitespace difference is not a new answer.
  //
  // But a prefix match needs a length floor, or a genuinely different short line
  // gets swallowed — "Opening" would count as already-said against a streamed
  // "Opening Spotify and searching." A repeat worth suppressing is a whole
  // answer, and forty characters is well below the shortest of those and well
  // above any one-word status line.
  const overlap = Math.min(shown.length, body.length);
  if (overlap < 40) return false;
  return shown.startsWith(body) || body.startsWith(shown);
}

// ---------------------------------------------------------------------------
// WHAT IT IS DOING RIGHT NOW, IN ONE WORD.
//
// The border says WHETHER it is working. It cannot say whether a request is
// still on the wire, whether the model is generating, or whether a tool is
// running — and on a bar with no transcript, "connecting" and "stuck" look
// identical without this. Cleared the moment the run settles.
//
// Driven off events that have actually happened, never off a timer: the first
// version of the chat's own status line said "Thinking…" from the instant the
// request left the box, and measured against this endpoint the first byte comes
// back at 631ms and the first reasoning token at 1,430ms. For a second and a
// half that word described a request sitting on a wire.
function setPhase(label) {
  if (!label) {
    phase.hidden = true;
    phaseLabel.textContent = "";
  } else {
    phase.hidden = false;
    phaseLabel.textContent = label;
  }
  syncHeight();
}

// The conversation this belongs to, by the same title the chat window lists.
function showChatName() {
  chatName.textContent = activeChatTitle();
}

// ---------------------------------------------------------------------------
// WHAT IS RUNNING, NOW — its own box above the pill.
//
// A row appears the moment a tool starts. When it finishes it LEAVES UPWARDS and
// the box closes behind it, so the presence of the box is itself the answer to
// "is it doing something". Several at once stack downwards and clear
// independently as each completes.
// ---------------------------------------------------------------------------

const rows = new Map();
// Everything that has run this session, for the log. Kept separately from `rows`
// because a row is gone the moment its tool is.
const entries = [];

function showToolbox() {
  toolbox.hidden = false;
  syncHeight();
}

function hideToolboxIfEmpty() {
  if (rows.size > 0) return;
  toolbox.hidden = true;
  syncHeight();
}

function startTool(key, tool, preview) {
  if (!key || rows.has(key)) return;
  const row = el("div", "running-row");
  row.append(el("span", "dot"));
  row.append(el("strong", null, tool ?? "working"));
  if (preview) row.append(el("em", null, String(preview).slice(0, 80)));
  rows.set(key, row);
  running.append(row);
  entries.push({ key, tool: tool ?? "working", preview: preview ?? "", ok: null, output: "", at: Date.now() });
  showToolbox();
}

// GONE THE MOMENT IT IS DONE, upwards, and the next takes its place. The row is
// removed only after the animation, or the stack would jump before it moved.
function finishTool(key, { ok = true, output = "" } = {}) {
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry) {
    entry.ok = ok !== false;
    entry.output = String(output ?? "");
    entry.doneAt = Date.now();
  }
  renderLog();
  const row = rows.get(key);
  if (!row) return;
  rows.delete(key);
  row.classList.add("leaving");
  const drop = () => {
    row.remove();
    hideToolboxIfEmpty();
    syncHeight();
  };
  row.addEventListener("animationend", drop, { once: true });
  // A row whose animation never fires — the window hidden mid-run — must still
  // go, or the box stays open over an empty stack forever.
  setTimeout(drop, 400);
}

function clearTools() {
  rows.clear();
  running.replaceChildren();
  toolbox.hidden = true;
  syncHeight();
}

// ---------------------------------------------------------------------------
// EVERYTHING THAT HAS RUN, on request. Each row expands to its own output.
// ---------------------------------------------------------------------------

function renderLog() {
  if (log.hidden) return;
  logList.replaceChildren();
  if (entries.length === 0) {
    logList.append(el("div", "log-empty", "Nothing has run yet."));
    syncHeight();
    return;
  }
  for (const entry of [...entries].reverse()) {
    const item = el("details", "log-item");
    const summary = el("summary");
    summary.append(el("span", `log-dot ${entry.ok === null ? "busy" : entry.ok ? "ok" : "bad"}`));
    summary.append(el("strong", null, entry.tool));
    if (entry.preview) summary.append(el("em", null, String(entry.preview).slice(0, 60)));
    item.append(summary);
    item.append(el("pre", "log-output", entry.output || (entry.ok === null ? "still running…" : "(no output)")));
    // The window has to grow when a row is opened, and shrink when it is closed.
    item.addEventListener("toggle", () => syncHeight());
    logList.append(item);
  }
  syncHeight();
}

logToggle.addEventListener("click", () => {
  const open = log.hidden;
  log.hidden = !open;
  logToggle.setAttribute("aria-expanded", String(open));
  renderLog();
  syncHeight();
});

logClose.addEventListener("click", () => {
  log.hidden = true;
  logToggle.setAttribute("aria-expanded", "false");
  syncHeight();
});

// ---------------------------------------------------------------------------
// Background work. A deferred command outlives the request that started it, so
// it must not sit in the running stack where it would never clear.
// ---------------------------------------------------------------------------

const backgroundJobs = new Map();

function renderBackground() {
  const jobs = [...backgroundJobs.values()];
  backgroundButton.hidden = jobs.length === 0;
  backgroundCount.textContent = String(jobs.length);
  if (jobs.length === 0) {
    backgroundPanel.hidden = true;
    backgroundButton.setAttribute("aria-expanded", "false");
  }
  backgroundPanel.replaceChildren();
  for (const job of jobs) {
    const line = el("div", "job");
    line.append(el("strong", null, job.label ?? "background job"));
    if (job.detail) line.append(el("em", null, job.detail));
    backgroundPanel.append(line);
  }
  syncHeight();
}

backgroundButton.addEventListener("click", () => {
  const open = backgroundPanel.hidden;
  backgroundPanel.hidden = !open;
  backgroundButton.setAttribute("aria-expanded", String(open));
  syncHeight();
});

// ---------------------------------------------------------------------------
// A short notice, in the narration area. Anything long says so and offers the
// chat, rather than being cut in half on a floating bar.
// ---------------------------------------------------------------------------

const NOTE_LIMIT = 260;

function note(text, kind = "reply") {
  const body = String(text ?? "").trim();
  if (!body) return;
  narration.hidden = false;
  const line = el("div", `narration-line note ${kind === "error" ? "bad" : ""}`.trim());
  if (body.length <= NOTE_LIMIT) {
    line.append(el("span", "say", body));
  } else {
    line.append(el("span", "say", `${body.slice(0, NOTE_LIMIT).trimEnd()}… `));
    const more = el("button", "inline-link", "Read it all");
    more.type = "button";
    more.addEventListener("click", () => expand());
    line.append(more);
  }
  narration.append(line);
  if (stickToBottom) narration.scrollTop = narration.scrollHeight;
  syncHeight();
}

// ---------------------------------------------------------------------------
// Running one request.
// ---------------------------------------------------------------------------

let sessionId = null;
let stopping = false;

const setState = (state) => { form.dataset.state = state; };

function setRunning(id) {
  sessionId = id;
  const busy = Boolean(id);
  sendButton.dataset.mode = busy ? "stop" : "send";
  sendButton.setAttribute("aria-label", busy ? "Stop" : "Send");
  setState(busy ? "working" : "idle");
}

async function stop() {
  if (!sessionId || stopping) return;
  stopping = true;
  try {
    await fetch(`/api/intents/${encodeURIComponent(sessionId)}/stop`, { method: "POST" });
  } catch { /* the run settles on its own either way */ }
  stopping = false;
}

// EXPANDING IS NOT A HANDOVER. The chat attaches to the SAME session on the
// daemon, which replays it from the beginning, and reads the SAME stored
// conversation — so the window that opens is on the same thread, mid-flight.
//
// ONE WRITER PER RUN, THOUGH. Once the chat has attached to a session it writes
// the full transcript for it, so the pill must not also write its own thinner
// copy or the exchange appears twice in the chat. Remembered by session id
// rather than as a flag: expanding during one run says nothing about the next.
let handedOver = null;

function expand() {
  if (sessionId) handedOver = sessionId;
  bridge?.expand(sessionId);
}

expandButton.addEventListener("click", () => expand());
bridge?.onRevealed(() => { input.focus(); syncHeight(); });

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  syncHeight();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
  // Escape puts it away without losing what was typed. HIDES, never closes:
  // `window.close()` destroys the window, and the shortcut meant to bring it
  // back would then hold a reference to nothing.
  if (event.key === "Escape") bridge?.hide();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sessionId) {
    await stop();
    return;
  }
  const text = input.value.trim();
  if (!text && attachments.length === 0) return;

  // AN IMAGE MUST NEVER BE SENT QUIETLY TO A MODEL THAT CANNOT SEE IT. The same
  // check the chat composer makes: refuse and say what to do.
  const verdict = checkAttachments(selectedModel, attachments);
  if (verdict.ok === false) {
    note(verdict.reason ?? "That attachment cannot be used with the selected model.", "error");
    return;
  }

  clearNarration();
  clearTools();
  input.value = "";
  input.style.height = "auto";

  const described = describeAttachments(attachments);
  const body = text ? (described ? `${text}\n\n${described}` : text) : described;
  // What the USER said, for the chat transcript and its title — never the body
  // with the attachment listing bolted on. Same rule as `rememberInChat`.
  const shownText = text || attachments.map((file) => file.name).join(", ");
  const workspaceRoots = [...new Set(attachments
    .filter((attachment) => attachment?.kind === "folder" && attachment.path)
    .map((attachment) => attachment.path))];
  attachments = [];
  renderAttachments();

  setPhase(STATUS.CONNECTING);
  // THE SAME CONVERSATION THE CHAT WINDOW IS ON. Read fresh from the shared
  // store, so a follow-up typed here continues what was said there.
  const history = readHistory();
  appendMessage("user", body, text);
  narrate(null, text || "Working on it.");

  try {
    const response = await fetch("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope: {
          protocolVersion: "1.0.0",
          type: "intent_request",
          requestId: `overlay-${Date.now()}`,
          payload: { text: body }
        },
        text: body,
        history,
        // The pill has no room for the safety controls, so it must not quietly
        // grant more than the chat's own default would.
        approvalMode: "balanced",
        developerMode: false,
        shellExecutionMode: "none",
        workspaceRoots,
        thinking
      })
    });

    let currentSession = null;
    const session = await readIntentSession(response, {
      onStart: (id) => { currentSession = id; setRunning(id); setPhase(STATUS.CONNECTING); },
      onEvent: (streamEvent) => handleStreamEvent(streamEvent)
    });

    clearTools();
    const status = session?.finalResponse?.status ?? session?.currentState ?? null;
    const message = session?.finalResponse?.message ?? "";
    const good = status === "COMPLETED" || status === "ANSWERED" || status === "DECLINED";
    setState(good ? "done" : "error");
    if (message) {
      // The chat's copy of the conversation gets the whole answer either way —
      // it is what the model is sent as history next time.
      appendMessage("assistant", message);
      // The TRANSCRIPT only if the chat did not attach to this run. See
      // `handedOver`: two writers for one exchange is two of it in the chat.
      if (handedOver !== currentSession) recordTurn(shownText, message);
      // BUT THE SCREEN DOES NOT GET IT TWICE. On an ordinary answer this is the
      // same text that just finished streaming into the line above, and adding
      // it again is exactly the duplication this used to produce.
      if (!alreadyStreamed(message)) note(message, good ? "reply" : "error");
      else if (!good) setState("error");
    }
    // Back to breathing after a moment. A bar that stays green stops meaning
    // anything.
    setTimeout(() => { if (!sessionId) setState("idle"); }, 4000);
  } catch (error) {
    clearTools();
    setState("error");
    note(`That did not run: ${error?.message ?? error}`, "error");
  } finally {
    setRunning(null);
    setPhase(null);
    // The title is minted from the first message of an untitled chat, so it is
    // only knowable after the exchange has been written.
    showChatName();
  }
});

// ---------------------------------------------------------------------------
// The event stream.
// ---------------------------------------------------------------------------

function handleStreamEvent(event) {
  const type = event?.eventType ?? event?.type;
  const detail = event?.details ?? {};

  // The model's own words, as they arrive.
  if (type === "AGENT_DELTA") {
    setPhase(STATUS.WRITING);
    narrateDelta(detail.text);
    return;
  }
  // The model deliberating, on its own channel. Never merged into the answer —
  // a settle that took reasoning for an answer would publish the scratch work.
  if (type === "AGENT_REASONING") {
    setPhase(STATUS.THINKING);
    return;
  }
  // The model is still WRITING the call — nothing has touched the machine yet,
  // which is a different tense from running it. See TOOL_VERB_PENDING.
  if (type === "TOOL_STREAMING") {
    if (detail.tool) setPhase(pendingVerbFor(detail.tool));
    return;
  }
  // `saw` and `say` travel WITH the tool call, which is why they reach the
  // screen before the work does. This is the running commentary on the pill.
  if (type === "AGENT_SAYS") {
    if (detail.text || detail.observed) narrate(detail.observed, detail.text);
    return;
  }
  if (type === "TOOL_STARTED") {
    setPhase(runningVerbFor(detail.tool));
    const args = detail.args ?? {};
    if (args.saw || args.say) narrate(args.saw, args.say);
    startTool(detail.callId ?? detail.tool, detail.tool, detail.preview);
    return;
  }
  if (type === "TOOL_FINISHED") {
    finishTool(detail.callId ?? detail.tool, { ok: detail.ok !== false, output: detail.output });
    // The phase must not keep naming a tool that has finished. Whatever else is
    // still in the stack takes over; if nothing is, the model is deciding again.
    const stillRunning = entries.find((entry) => entry.ok === null);
    setPhase(stillRunning ? runningVerbFor(stillRunning.tool) : STATUS.THINKING);
    // A deferred command keeps going after the run that started it. It leaves
    // the stack and becomes a count on the side.
    if (detail.card?.kind === "job" || detail.deferred === true) {
      backgroundJobs.set(detail.callId ?? detail.tool, {
        label: detail.tool ?? "job",
        detail: String(detail.output ?? "").slice(0, 60)
      });
      renderBackground();
    }
    return;
  }
  // The agent stopped to ask about something it cannot take back. There is no
  // room to render an approval card here and no honest way to shrink one, so the
  // chat is opened on it — the decision belongs where the command can be read.
  if (type === "APPROVAL_REQUIRED") {
    setPhase(STATUS.APPROVAL);
    expand();
  }
}

// ---------------------------------------------------------------------------

renderModelMenu();
modelLabel.textContent = modelById(selectedModel)?.label ?? "Auto";
setState("idle");
showChatName();
// SAY WHICH KEY HIDES IT. The accelerator is chosen at startup from a list —
// whichever was not already claimed by something else — so it is not a constant
// anybody could have read off this file.
void (async () => {
  const key = await bridge?.shortcut?.();
  if (key) input.title = `${key} hides and shows SYSCORA · Esc hides it`;
})();
syncHeight();
input.focus();

// Nothing here should be reachable without the shell; a plain browser tab gets a
// working text box and no window management, which is the honest degradation.
if (!bridge) document.documentElement.style.background = "#0a0d13";
