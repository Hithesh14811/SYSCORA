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
import { describeAttachments, prepareAttachment } from "./attachments.js";

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

// The user's own words, with the attached file's contents taken back out.
// describeAttachments appends a fenced, labelled block per document; this is
// its inverse, used only for what is DISPLAYED. The model still receives the
// whole thing.
function stripAttachmentBlocks(text) {
  return String(text ?? "")
    .replace(/\n\n--- Attached file: [\s\S]*?--- end of .*? ---/g, "")
    .trim();
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
  web_open: "Opened a page",
  web_read: "Read the page",
  web_click: "Clicked on the page",
  web_type: "Typed on the page",
  web_scroll: "Scrolled the page",
  batch: "Ran several steps",
  wait: "Waited"
};

function verbFor(capability) {
  const name = String(capability ?? "");
  if (TOOL_VERB[name]) return TOOL_VERB[name];
  for (const [pattern, verb] of VERB) if (pattern.test(name)) return verb;
  return "Ran a step";
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
    this.thinking = null;
    this.reasoning = "";
    this.pendingSteps = [];
    this.sawNarration = false;
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
    if (!this.status) return;
    this.status.textContent = text;
    scrollToEnd();
  }

  clearStatus() {
    this.status?.remove();
    this.status = null;
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
  streamReasoning(text) {
    if (!text) return;
    // The first reasoning token is the moment thinking genuinely starts. Before
    // it, the status line says "Connecting…" and means it.
    this.setStatus("Thinking…");
    if (!this.thinking) {
      const box = el("details", "thinking-box");
      const summary = el("summary", "thinking-summary", "Thinking");
      box.appendChild(summary);
      this.thinkingBody = el("div", "thinking-body");
      box.appendChild(this.thinkingBody);
      this.root.appendChild(box);
      this.thinking = box;
    }
    this.reasoning += text;
    this.thinkingBody.textContent = this.reasoning;
    // Follow the stream only while it is open; scrolling a collapsed block
    // yanks the page around for something nobody is looking at.
    if (this.thinking.open) scrollToEnd();
  }

  // Thinking is over the moment the answer starts. The block stays on screen —
  // it is a transcript, not a spinner — but it stops claiming to be live.
  sealReasoning() {
    if (!this.thinking) return;
    this.thinking.classList.add("done");
    const summary = this.thinking.querySelector(".thinking-summary");
    if (summary) summary.textContent = "Thought for a moment";
  }

  // The model talking, one token at a time. This is the first thing on screen
  // and it arrives while the tools it is describing are already running — the
  // whole reason the loop streams at all.
  streamDelta(text) {
    this.clearStatus();
    this.sealReasoning();
    this.sawNarration = true;
    if (!this.streamNode) {
      const block = el("div", "agent-says streaming");
      this.streamBlock = block;
      // A div, not a p: half-finished markdown is shown as plain text WHILE it
      // streams — re-parsing on every chunk makes headings and lists flicker in
      // and out as their syntax completes — and is rendered once at the end.
      this.streamNode = el("div", "md-stream", "");
      block.appendChild(this.streamNode);
      this.root.appendChild(block);
    }
    this.streamNode.textContent += text;
    scrollToEnd();
  }

  // Close the streaming block. The complete message arrives separately once the
  // model finishes its turn; when it matches what was already streamed there is
  // nothing left to draw.
  _closeStream(finalText) {
    if (!this.streamNode) return false;
    const streamed = this.streamNode.textContent.trim();
    this.streamBlock?.classList.remove("streaming");
    // The turn is over, so the text is complete and can be parsed. Until this
    // point it was deliberately literal.
    if (streamed) {
      setMarkdown(this.streamNode, streamed);
      this.streamNode.classList.remove("md-stream");
      this.streamNode.classList.add("md");
    }
    if (!streamed) this.streamBlock?.remove();
    this.streamNode = null;
    this.streamBlock = null;
    return Boolean(streamed) && streamed === String(finalText ?? "").trim();
  }

  // The model's own words.
  say(text, { detail = null, steps = [], observed = null } = {}) {
    this.clearStatus();
    this.throttleNode = null;
    this.sawNarration = true;
    this.lastSaid = text;
    if (this._closeStream(text) && !detail && !observed && steps.length <= 1) return;
    const block = el("div", "agent-says");
    // What it just read, before what it intends to do about it. This ordering is
    // the point: the observation is the evidence for the action, and a reader
    // should be able to disagree with the second line on the strength of the
    // first.
    if (observed) block.appendChild(el("p", "agent-observed", observed));
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
    scrollToEnd();
  }

  note(text) {
    this.throttleNode = null;
    this.root.appendChild(el("div", "turn-note", text));
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
    }
    this.throttleNode.textContent =
      `Waiting on the model provider's rate limit — ${(this.throttleMs / 1000).toFixed(1)}s so far.`;
    scrollToEnd();
  }

  // A tool call, rendered the moment it starts and resolved in place when it
  // finishes. `key` is whatever the runtime will quote back on completion.
  startStep({ key, capability, inputs, subgoal, arg: explicitArg }) {
    this.clearStatus();
    this.throttleNode = null;
    this._closeStream(null);
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
    const step = el("details", "step running");
    const head = document.createElement("summary");
    head.className = "step-head";
    head.appendChild(el("span", "step-icon", "▸"));
    head.appendChild(el("span", "step-verb", subgoal || verbFor(capability)));
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
    this.root.appendChild(step);
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
    const icon = head?.querySelector(".step-icon");
    if (icon) icon.textContent = ok ? "✓" : "✗";
    if (Number.isFinite(durationMs) && durationMs >= 1000) {
      head?.appendChild(el("span", "step-time", `${(durationMs / 1000).toFixed(1)}s`));
    }
    // The output. This is the part that makes a step believable, so it is shown
    // rather than summarized away — trimmed, and scrollable when it is long.
    const body = preview || (ok ? null : message);
    if (body) {
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
    this._closeStream(null);
    for (const pending of this.pendingSteps) {
      pending.node.classList.remove("running");
      pending.node.classList.add("unknown");
      const icon = pending.head?.querySelector(".step-icon");
      if (icon) icon.textContent = "·";
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
    scrollToEnd();
    return node;
  }
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
  if (String(message).trim() === String(turn.lastSaid ?? "").trim()) {
    renderCost(turn, fr.metrics);
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
    turn.append(el("div", "agent-answer", message));
  } else if (GOOD_STATUS.has(fr.status)) {
    turn.append(el("div", "agent-answer", message));
  } else {
    const card = el("div", "result-card bad");
    card.appendChild(el("div", "badge", fr.status === "PARTIALLY_COMPLETED" ? "Partly done" : "Didn't work"));
    card.appendChild(el("p", null, message));
    turn.append(card);
  }

  renderCost(turn, fr.metrics);

  if (debug) {
    const pre = el("pre", "debug-only rawjson", JSON.stringify(session, null, 2));
    turn.append(pre);
  }
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

function remember(role, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  conversation.push({ role, text: trimmed });
  if (conversation.length > 24) conversation.splice(0, conversation.length - 24);
  const chat = activeChat();
  if (role === "user" && (!chat.title || chat.title === "New chat")) chat.title = titleFrom(trimmed);
  touchActiveChat();
  renderChatList();
}

// The events of one finished turn, so it can be drawn again exactly as it was.
// Tool output is clipped for storage only — a screen reading is thousands of
// characters and twenty of them would fill the store on their own.
function recordTurn(userText, events, session) {
  const chat = activeChat();
  chat.turns.push({
    user: userText,
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
}

// ---- The chats panel ---------------------------------------------------------

const chatsPanel = document.getElementById("chatsPanel");
const chatsBackdrop = document.getElementById("chatsBackdrop");
const chatListEl = document.getElementById("chatList");
const chatsButton = document.getElementById("chatsButton");
const newChatButton = document.getElementById("newChatButton");

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

function renderChatList() {
  if (!chatListEl) return;
  chatListEl.textContent = "";
  const listed = chats.filter((chat) => chat.turns.length > 0 || chat.id === activeChatId);
  if (listed.length === 0) {
    chatListEl.appendChild(el("li", "empty", "No chats yet."));
    return;
  }
  for (const chat of listed) {
    const row = el("li", chat.id === activeChatId ? "active" : null);
    const open = el("button", "chat-open");
    open.type = "button";
    open.appendChild(el("span", "chat-title", chat.title || "New chat"));
    open.appendChild(el("span", "chat-when", whenLabel(chat.updatedAt)));
    open.addEventListener("click", () => switchToChat(chat.id));
    const remove = el("button", "icon-button chat-delete", "✕");
    remove.type = "button";
    remove.title = "Delete this chat";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    row.appendChild(open);
    row.appendChild(remove);
    chatListEl.appendChild(row);
  }
}

function openChatsPanel(open) {
  chatsPanel.hidden = !open;
  chatsBackdrop.hidden = !open;
  if (open) renderChatList();
}

// A run is bound to the transcript it is streaming into, so it must finish (or
// be stopped) before the transcript can be swapped underneath it.
function busyWithRun() {
  if (!runningSessionId) return false;
  openChatsPanel(false);
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
  chatLog.appendChild(welcome);
}

// Draw a stored chat back onto the screen, through the SAME renderers that drew
// it live. Storing the events rather than a summary is what makes this possible:
// the tool rows, the narration and the final answer come back as they were.
function renderStoredChat(chat) {
  chatLog.textContent = "";
  if (chat.turns.length === 0) {
    showWelcome();
    return;
  }
  for (const stored of chat.turns) {
    if (stored.user) addBubble("user", textNode(stored.user));
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
  }
  const mark = el("div", "chat-resumed");
  mark.appendChild(el("span", null, "Carrying on from here"));
  chatLog.appendChild(mark);
  scrollToEnd();
}

function switchToChat(id) {
  if (busyWithRun()) return;
  const target = chats.find((chat) => chat.id === id);
  if (!target || id === activeChatId) {
    openChatsPanel(false);
    return;
  }
  activeChatId = id;
  localStorage.setItem(ACTIVE_CHAT_KEY, id);
  // In place: everything that sends history holds this array.
  conversation.splice(0, conversation.length, ...(target.conversation ?? []).slice(-24));
  renderStoredChat(target);
  openChatsPanel(false);
  renderChatList();
}

function startNewChat() {
  if (busyWithRun()) return;
  // An untouched "New chat" is not worth a second one.
  const current = activeChat();
  if (current && current.turns.length === 0) {
    openChatsPanel(false);
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
  openChatsPanel(false);
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

chatsButton?.addEventListener("click", () => openChatsPanel(chatsPanel.hidden));
document.getElementById("chatsClose")?.addEventListener("click", () => openChatsPanel(false));
chatsBackdrop?.addEventListener("click", () => openChatsPanel(false));
newChatButton?.addEventListener("click", startNewChat);
document.getElementById("panelNewChat")?.addEventListener("click", startNewChat);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !chatsPanel.hidden) openChatsPanel(false);
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

function setRunning(sessionId) {
  runningSessionId = sessionId;
  const running = sessionId !== null;
  sendButton.classList.toggle("stopping", running);
  sendButton.textContent = running ? "■" : "↑";
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
  const bubble = addBubble("user", textNode(display ?? stripAttachmentBlocks(text)));
  if (attachments.length) {
    const list = el("div", "bubble-attachments");
    for (const file of attachments) {
      list.appendChild(el("span", "bubble-attachment",
        `${file.kind === "image" ? "🖼" : "📄"} ${file.name}`));
    }
    bubble?.appendChild?.(list);
  }
  // Which model was chosen and why, kept beside the request it applies to.
  if (routing) bubble?.appendChild?.(el("div", "bubble-routing", routing));
  // Captured BEFORE this turn is appended: history means the turns before this
  // one, and including the current message would duplicate it in the prompt.
  const history = conversation.slice();
  remember("user", text);
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
        if ((event.type ?? event.eventType) !== "TOOL_PROGRESS") streamed.push(event);
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
    recordTurn(text, streamed, session);
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
    recordTurn(text, streamed, null);
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
const attachButton = document.getElementById("attachButton");
const attachmentStrip = document.getElementById("attachmentStrip");
const modelSelect = document.getElementById("modelSelect");
const modelHint = document.getElementById("modelHint");

let attachedFiles = [];

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
  describeModelChoice();
}

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

function renderAttachments() {
  if (!attachmentStrip) return;
  attachmentStrip.textContent = "";
  attachmentStrip.hidden = attachedFiles.length === 0;
  for (const [index, file] of attachedFiles.entries()) {
    const chip = el("div", `attachment-chip${file.kind === "rejected" ? " bad" : ""}`);
    chip.appendChild(el("span", "attachment-icon", file.kind === "image" ? "🖼" : file.kind === "rejected" ? "⚠" : "📄"));
    const meta = el("div", "attachment-meta");
    meta.appendChild(el("span", "attachment-name", file.name));
    // What actually happens to it, said plainly: a PDF becomes text before it
    // travels, and the user should know that is what was sent.
    meta.appendChild(el("span", "attachment-note",
      file.kind === "rejected" ? file.error
        : file.kind === "image" ? "sent as an image"
        : `${file.extractedBy}, ${file.text.length.toLocaleString()} characters`));
    chip.appendChild(meta);
    const remove = el("button", "attachment-remove", "✕");
    remove.type = "button";
    remove.title = `Remove ${file.name}`;
    remove.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      renderAttachments();
      describeModelChoice();
    });
    chip.appendChild(remove);
    attachmentStrip.appendChild(chip);
  }
}

function clearAttachments() {
  attachedFiles = [];
  if (fileInput) fileInput.value = "";
  renderAttachments();
  describeModelChoice();
}

async function acceptFiles(files) {
  for (const file of files) {
    const chip = { name: file.name, kind: "pending", bytes: file.size };
    attachedFiles.push(chip);
    renderAttachments();
    let prepared;
    try {
      prepared = await prepareAttachment(file);
    } catch (error) {
      prepared = { name: file.name, kind: "rejected", error: `${file.name} could not be read: ${error?.message ?? error}` };
    }
    const at = attachedFiles.indexOf(chip);
    if (at >= 0) attachedFiles[at] = prepared;
    renderAttachments();
  }
  // Say immediately whether the current model can take what was just attached,
  // rather than waiting for the user to press send and be refused.
  const usable = attachedFiles.filter((file) => file.kind !== "rejected");
  const verdict = checkAttachments(modelSelect.value, usable);
  if (!verdict.ok) showComposerError(verdict.reason);
  else if (verdict.reason && modelSelect.value === AUTO && usable.length) {
    modelHint.textContent = verdict.reason;
    modelHint.classList.remove("error");
  } else describeModelChoice();
}

if (attachButton) attachButton.addEventListener("click", () => fileInput.click());
if (fileInput) fileInput.addEventListener("change", () => acceptFiles([...fileInput.files]));
if (modelSelect) modelSelect.addEventListener("change", () => {
  localStorage.setItem("syscora_model", modelSelect.value);
  describeModelChoice();
});

// Drag and drop onto the whole conversation, because that is where people aim.
for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    document.body.classList.toggle("dragging", eventName === "dragover");
    if (eventName === "drop") acceptFiles([...event.dataTransfer.files]);
  });
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
  chatInput.style.height = "auto";
  submit(body, { attachments, model: verdict.model ?? null, routing: verdict.reason ?? null });
  clearAttachments();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
});

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
