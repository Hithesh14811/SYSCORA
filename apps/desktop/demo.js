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

const TOKEN_STORAGE_KEY = "syscora_token";
// Matches .claude/launch.json's SYSCORA_API_TOKEN, so a plain browser launch
// doesn't need a manual paste for local dev. The Connect panel below only
// appears if this gets rejected (e.g. the daemon used a different token).
const DEV_FALLBACK_TOKEN = "syscora-dev-local-token-do-not-use-in-prod";
let apiToken = (window.syscora && window.syscora.apiToken)
  || sessionStorage.getItem(TOKEN_STORAGE_KEY)
  || DEV_FALLBACK_TOKEN;

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
const TOOL_VERB = {
  run: "Ran",
  screen: "Looked at the screen",
  click: "Clicked",
  type: "Typed",
  key: "Pressed",
  scroll: "Scrolled",
  move_mouse: "Moved the pointer",
  launch: "Opened",
  open_url: "Opened a page",
  windows: "Listed the windows",
  focus: "Focused a window",
  window_state: "Adjusted a window",
  read_file: "Read a file",
  write_file: "Wrote a file",
  clipboard: "Used the clipboard",
  play_music: "Played",
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
    this.status = el("div", "turn-status", "Thinking…");
    this.root.appendChild(this.status);
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

  // The model talking, one token at a time. This is the first thing on screen
  // and it arrives while the tools it is describing are already running — the
  // whole reason the loop streams at all.
  streamDelta(text) {
    this.clearStatus();
    this.sawNarration = true;
    if (!this.streamNode) {
      const block = el("div", "agent-says streaming");
      this.streamBlock = block;
      this.streamNode = el("p", null, "");
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
    if (text) block.appendChild(el("p", null, text));
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
    const step = el("div", "step running");
    const head = el("div", "step-head");
    head.appendChild(el("span", "step-icon", "▸"));
    head.appendChild(el("span", "step-verb", subgoal || verbFor(capability)));
    head.appendChild(el("code", "step-tool", capability));
    const arg = explicitArg || argSummary(capability, inputs);
    if (arg) head.appendChild(el("code", "step-arg", arg));
    step.appendChild(head);
    this.root.appendChild(step);
    this.pendingSteps.push({ key, capability, node: step, head });
    scrollToEnd();
    return step;
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

  append(node) {
    this.root.appendChild(node);
    scrollToEnd();
    return node;
  }
}

// ---- Events → the turn -------------------------------------------------------

// Phases the runtime passes through before the model has said anything. They
// share the one transient status line; none of them is worth a permanent row.
const PHASE_STATUS = {
  INTENT_RECEIVED: "Thinking…",
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
    if (debug) turn.append(el("pre", "debug-only rawjson", JSON.stringify(session, null, 2)));
    return;
  }

  // Stopping is the user getting what they asked for, not a failure. Labelling
  // it "Didn't work" in red tells them something went wrong when nothing did.
  if (fr.status === "CANCELLED") {
    turn.append(el("div", "agent-answer", message));
  } else if (GOOD_STATUS.has(fr.status)) {
    turn.append(el("div", "agent-answer", message));
  } else {
    const card = el("div", "result-card bad");
    card.appendChild(el("div", "badge", fr.status === "PARTIALLY_COMPLETED" ? "Partly done" : "Didn't work"));
    card.appendChild(el("p", null, message));
    turn.append(card);
  }

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
const conversation = [];
function remember(role, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;
  conversation.push({ role, text: trimmed });
  if (conversation.length > 24) conversation.splice(0, conversation.length - 24);
}

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
async function submit(text) {
  if (runningSessionId) return;
  document.querySelector(".welcome")?.remove();
  addBubble("user", textNode(text));
  // Captured BEFORE this turn is appended: history means the turns before this
  // one, and including the current message would duplicate it in the prompt.
  const history = conversation.slice();
  remember("user", text);
  const turn = new Turn();

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
      onEvent: (event) => handleEvent(turn, event),
      // Only reached when the event stream could not be opened at all.
      onProgress: (status) => {
        const type = status?.latestEvent?.eventType;
        if (PHASE_STATUS[type]) turn.setStatus(PHASE_STATUS[type]);
      }
    });
    renderFinal(turn, session);
    remember("assistant", replyTextOf(session));
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

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (runningSessionId) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  submit(text);
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
