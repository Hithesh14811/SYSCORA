// SYSCORA demo chat surface. A friendly, investor-facing view over the SAME
// runtime the developer console uses: it POSTs natural language to /api/intents
// and renders the returned session's events as understandable steps, surfaces
// approval, and shows a plain-language result. No runtime bypass — every action
// flows through the canonical pipeline. Raw JSON is only shown in debug mode.

const TOKEN_STORAGE_KEY = "syscora_token";
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
const autoApprove = document.getElementById("autoApprove");

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
if (!apiToken) showConnect();

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
debugToggle.addEventListener("change", () => { debug = debugToggle.checked; document.body.classList.toggle("debug", debug); });

// ---- Friendly rendering of the canonical session -----------------------------

// Map a raw event to a human line. Unknown/internal events return null (hidden
// unless debug mode). This is presentation only — the runtime is authoritative.
function humanizeEvent(ev) {
  const t = ev.eventType;
  const d = ev.details ?? {};
  switch (t) {
    case "INTENT_RECEIVED": return { icon: "•", text: "Understanding your request…" };
    case "INTENT_CLASSIFIED": return { icon: "•", text: `Understood: ${d.normalizedGoal ?? "request"}` };
    case "CONTEXT_COLLECTED": return { icon: "•", text: "Inspecting relevant system state…" };
    case "PLAN_GENERATED": {
      const tasks = d.taskGraph?.tasks ?? [];
      return { icon: "•", text: "Creating a plan…", plan: tasks.map((x) => x.goal || x.capability) };
    }
    case "RISK_ASSESSED": return { icon: "•", text: `Assessed risk: ${d.overallRisk ?? "?"}` };
    case "TASK_STARTING": return { icon: "▶", text: `Working: ${d.goal || d.capability || "step"}` };
    case "TASK_EXECUTED": return { icon: "✓", text: `Ran: ${d.capability || "step"}` };
    case "VERIFICATION_COMPLETED": return { icon: "✓", text: `Verified: ${d.message || d.capability || "step"}` };
    case "VERIFICATION_FAILED": return { icon: "✗", text: `Verification failed: ${d.message || "step"}` };
    case "FAILURE_DIAGNOSED": return { icon: "⚠", text: `Diagnosed problem: ${d.rootCause || d.category || "issue"}` };
    case "RECOVERY_DECIDED": return { icon: "↻", text: `Recovery: ${d.action}` };
    case "STARTING_REPLANNING": return { icon: "↻", text: `Re-planning (attempt ${d.attempt})…` };
    case "REPLAN_APPROVAL_REQUIRED": return { icon: "⏸", text: "The new plan needs your approval." };
    case "ROLLING_BACK": return { icon: "↩", text: "Rolling back changes…" };
    case "FINAL_VERIFICATION_COMPLETED": return { icon: "•", text: `Goal check: ${d.status ?? ""}` };
    default: return null;
  }
}

function riskWord(level) {
  return { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" }[level] ?? (level ?? "Unknown");
}

function addBubble(role, node) {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;
  wrap.appendChild(node);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return wrap;
}

function textNode(text) { const p = document.createElement("div"); p.textContent = text; return p; }

// Render the activity feed for a session response.
function renderSession(session) {
  const fr0 = session.finalResponse ?? {};
  // Conversational reply (greeting, "what model are you", capability question):
  // no actions were taken, so skip the activity feed and just show the answer.
  if (fr0.status === "ANSWERED") {
    addBubble("assistant", textNode(fr0.message || "…"));
    if (debug) {
      const pre = document.createElement("pre");
      pre.className = "debug-only rawjson";
      pre.textContent = JSON.stringify(session, null, 2);
      addBubble("assistant", pre);
    }
    return;
  }

  // A known read-only request is a factual chat turn. It still ran through the
  // typed runtime, but the user needs the answer, not an internal trace.
  const compactReply = session.plan?.plannerSource === "DIRECT_OPERATION"
    && fr0.status !== "AWAITING_APPROVAL";
  if (compactReply) {
    renderResult(session);
    if (debug) {
      const pre = document.createElement("pre");
      pre.className = "debug-only rawjson";
      pre.textContent = JSON.stringify(session, null, 2);
      addBubble("assistant", pre);
    }
    return;
  }

  const activity = document.createElement("div");
  activity.className = "activity";

  for (const ev of session.events ?? []) {
    const h = humanizeEvent(ev);
    if (!h) {
      if (debug) {
        const raw = document.createElement("div");
        raw.className = "step debug-only";
        raw.textContent = `[${ev.eventType}] ${JSON.stringify(ev.details ?? {})}`;
        activity.appendChild(raw);
      }
      continue;
    }
    const step = document.createElement("div");
    step.className = "step";
    step.innerHTML = `<span class="ico">${h.icon}</span><span>${escapeHtml(h.text)}</span>`;
    activity.appendChild(step);
    if (h.plan && h.plan.length) {
      const ol = document.createElement("ol");
      ol.className = "plan";
      for (const p of h.plan) { const li = document.createElement("li"); li.textContent = p; ol.appendChild(li); }
      activity.appendChild(ol);
    }
  }
  addBubble("assistant", activity);

  const fr = session.finalResponse ?? {};
  if (fr.status === "AWAITING_APPROVAL") {
    renderApproval(session);
  } else {
    renderResult(session);
  }

  if (debug) {
    const pre = document.createElement("pre");
    pre.className = "debug-only rawjson";
    pre.textContent = JSON.stringify(session, null, 2);
    addBubble("assistant", pre);
  }
}

// Approval card — WHAT / WHY / RISK / WHAT CHANGES, then Approve / Reject.
function renderApproval(session) {
  const fr = session.finalResponse ?? {};
  const ia = fr.informedApproval ?? {};
  const card = document.createElement("div");
  card.className = "approval-card";
  const what = (ia.whatItDoes && ia.whatItDoes.length) ? ia.whatItDoes.join(" ") : (fr.reason || "SYSCORA wants to perform an action.");
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
  const wrap = addBubble("assistant", card);
  card.querySelector(".approve").addEventListener("click", async () => {
    wrap.remove();
    await resume(session.sessionId, true);
  });
  card.querySelector(".reject").addEventListener("click", () => {
    wrap.remove();
    addBubble("assistant", textNode("Okay — I won't do that. No changes were made."));
  });
}

function renderResult(session) {
  const fr = session.finalResponse ?? {};
  const ok = ["COMPLETED", "COMPLETED_WITH_WARNINGS", "ROLLED_BACK", "VERIFIED"].includes(fr.status);
  const card = document.createElement("div");
  card.className = `result-card ${ok ? "ok" : "bad"}`;
  const summary = fr.summary?.summary || fr.summary?.text || fr.message || (ok ? "Done." : "The request could not be completed.");
  const changes = (session.observations ?? [])
    .flatMap((o) => Array.isArray(o?.detectedChanges) ? o.detectedChanges : [])
    .filter((v, i, a) => v && a.indexOf(v) === i);
  card.innerHTML = `
    <div class="badge">${ok ? "✓ Done" : "✗ " + (fr.status ?? "Failed")}</div>
    <p>${escapeHtml(summary)}</p>
    ${changes.length ? `<p class="muted">Changed: ${escapeHtml(changes.join(", "))}</p>` : ""}
  `;
  addBubble("assistant", card);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getPayload(json) { return json?.envelope?.payload ?? json; }

// A neutral, non-templated placeholder shown for the brief moment before the
// model's OWN natural acknowledgement arrives. The acknowledgement text itself is
// always generated by the LLM (fetched in parallel below) — never a hardcoded or
// keyword-derived string — so this placeholder carries no assumptions about the
// request. Presentation only; the runtime is authoritative.
function acknowledgement() {
  return "…";
}

let reqId = 0;
async function submit(text) {
  addBubble("user", textNode(text));
  const thinking = addBubble("assistant", textNode(acknowledgement(text)));
  // The acknowledgement is an independent LLM request. Do not await it before
  // submitting the work: both requests start together, so model latency never
  // delays opening an app or a safe typed UI workflow.
  void fetch("/api/intents/acknowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: { protocolVersion: "1.0.0", type: "intent_acknowledgement_request", requestId: `ack-${reqId++}`, payload: { text } }, text })
  }).then(async (response) => {
    if (!response.ok || !thinking.isConnected) return;
    const json = await response.json();
    const reply = getPayload(json).acknowledgement ?? json.acknowledgement;
    if (reply?.message && thinking.isConnected) thinking.replaceChildren(textNode(reply.message));
  }).catch(() => {});
  try {
    const res = await fetch("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope: { protocolVersion: "1.0.0", type: "intent_request", requestId: `demo-${reqId++}`, payload: { text, autoApprove: Boolean(autoApprove?.checked) } },
        text,
        autoApprove: Boolean(autoApprove?.checked)
      })
    });
    thinking.remove();
    if (!res.ok) {
      addBubble("assistant", textNode(`SYSCORA encountered a problem (${res.status}). Please try again.`));
      return;
    }
    const json = await res.json();
    const session = getPayload(json).session ?? json.session;
    if (!session) { addBubble("assistant", textNode("No response from the runtime.")); return; }
    renderSession(session);
  } catch (err) {
    thinking.remove();
    addBubble("assistant", textNode(`SYSCORA encountered a problem while performing this step. ${debug ? err.message : ""}`));
  }
}

async function resume(sessionId, approve) {
  const thinking = addBubble("assistant", textNode(approve ? "Approved — continuing…" : "Cancelling…"));
  try {
    const path = approve
      ? `/api/sessions/${encodeURIComponent(sessionId)}/resume`
      : `/api/sessions/${encodeURIComponent(sessionId)}/cancel`;
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoApprove: approve })
    });
    thinking.remove();
    if (!res.ok) { addBubble("assistant", textNode(`Could not continue (${res.status}).`)); return; }
    const json = await res.json();
    const session = getPayload(json).session ?? json.session;
    if (session) renderSession(session);
  } catch (err) {
    thinking.remove();
    addBubble("assistant", textNode(`Problem continuing: ${debug ? err.message : "please retry."}`));
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  submit(text);
});

suggestions.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-text]");
  if (!btn) return;
  const text = btn.getAttribute("data-text");
  chatInput.value = text;
  chatInput.focus();
  // A suggested prompt is a one-click demo: populate the input AND submit it
  // through the exact same chat path a typed request uses (no bypass).
  submit(text);
});
