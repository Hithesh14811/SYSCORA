import { readIntentSession } from "./intent-client.js";

const generalIntentForm = document.getElementById("generalIntentForm");
const form = document.getElementById("intentForm");
const runProjectForm = document.getElementById("runProjectForm");
const userPathForm = document.getElementById("userPathForm");
const wingetInstallForm = document.getElementById("wingetInstallForm");
const portInspectForm = document.getElementById("portInspectForm");
const analyzePerformanceForm = document.getElementById("analyzePerformanceForm");
const notepadTypeAndSaveForm = document.getElementById("notepadTypeAndSaveForm");
const browserSearchForm = document.getElementById("browserSearchForm");
const executionSummary = document.getElementById("executionSummary");
const privilegedApproveForm = document.getElementById("privilegedApproveForm");
const privilegedExecuteForm = document.getElementById("privilegedExecuteForm");
const loadSystemSummary = document.getElementById("loadSystemSummary");
const systemSummaryOutput = document.getElementById("systemSummaryOutput");
const sessionOutput = document.getElementById("sessionOutput");
const refreshSessions = document.getElementById("refreshSessions");
const rollbackLatest = document.getElementById("rollbackLatest");
const sessionIdControl = document.getElementById("sessionIdControl");
const pauseSession = document.getElementById("pauseSession");
const resumeSession = document.getElementById("resumeSession");
const cancelSession = document.getElementById("cancelSession");

// API token bootstrap, in priority order:
//   1. Electron shell — injected in-process via a contextBridge preload.
//   2. sessionStorage — a token the user entered earlier this tab session.
//   3. The known local dev token — matches .claude/launch.json's SYSCORA_API_TOKEN,
//      so a plain browser launch doesn't need a manual paste for local dev.
//   4. The Connect panel — shown only if that token gets rejected (e.g. the
//      daemon was started with a different/random token).
// `apiToken` is mutable so a fresh connect (or a 401-triggered re-prompt) updates
// every call site, which all read it at request time.
const TOKEN_STORAGE_KEY = "syscora_token";
const DEV_FALLBACK_TOKEN = "syscora-dev-local-token-do-not-use-in-prod";
let apiToken = (window.syscora && window.syscora.apiToken)
  || sessionStorage.getItem(TOKEN_STORAGE_KEY)
  || DEV_FALLBACK_TOKEN;

const connectPanel = document.getElementById("connectPanel");
const connectForm = document.getElementById("connectForm");
const connectToken = document.getElementById("connectToken");
const connectError = document.getElementById("connectError");

function showConnectPanel(message) {
  if (message) {
    connectError.textContent = message;
    connectError.hidden = false;
  } else {
    connectError.hidden = true;
  }
  connectPanel.hidden = false;
  connectToken.focus();
}

function hideConnectPanel() {
  connectPanel.hidden = true;
  connectError.hidden = true;
}

// Called by any fetch that gets a 401: the stored token is stale or wrong, so
// drop it and re-prompt rather than silently failing.
function handleUnauthorized() {
  apiToken = null;
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  showConnectPanel("Token was rejected. Paste the current token from the daemon console.");
}

if (connectForm) {
  connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = connectToken.value.trim();
    if (!value) return;
    apiToken = value;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    connectToken.value = "";
    hideConnectPanel();
  });
}


// Centralize auth on top of fetch: every same-origin /api/ request carries the
// current token, and a 401 anywhere re-opens the Connect panel. This means the
// individual call sites below don't each need to re-check auth, and a rejected
// token is handled in one place instead of failing silently per call.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input?.url ?? "");
  const isApi = url.startsWith("/api/") || url.includes("://127.0.0.1");
  if (isApi && apiToken) {
    init = { ...init, headers: { ...(init.headers || {}), "x-syscora-token": apiToken } };
  }
  const response = await nativeFetch(input, init);
  if (isApi && response.status === 401) {
    handleUnauthorized();
  }
  return response;
};

const workspacePathInput = document.getElementById("workspacePath");
workspacePathInput.value = ".";
const runWorkspacePathInput = document.getElementById("runWorkspacePath");
runWorkspacePathInput.value = ".";
const privOperationInput = document.getElementById("privOperation");
const privScopeInput = document.getElementById("privScope");
const privTokenInput = document.getElementById("privToken");
const userPathEntry = document.getElementById("userPathEntry");
const userPathAutoApprove = document.getElementById("userPathAutoApprove");
const wingetId = document.getElementById("wingetId");
const wingetAutoApprove = document.getElementById("wingetAutoApprove");
const portNumber = document.getElementById("portNumber");
const notepadContent = document.getElementById("notepadContent");
const notepadFilename = document.getElementById("notepadFilename");
const notepadAutoApprove = document.getElementById("notepadAutoApprove");
const browserSearchQuery = document.getElementById("browserSearchQuery");
let requestCounter = 0;

function getPayload(responseJson) {
  return responseJson?.envelope?.payload ?? responseJson;
}

function addSummaryRow(title, value) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<strong>${title}</strong><span>${value}</span>`;
  executionSummary.appendChild(row);
}

function renderSessionResult(response) {
  executionSummary.innerHTML = "";
  const session = getPayload(response).session;
  addSummaryRow("Understanding", session.plan?.goal ?? "Set project environment variable");
  addSummaryRow("Plan", session.plan?.summary ?? "No plan summary");
  addSummaryRow("Risk", session.riskAssessment?.overallRisk ?? "UNKNOWN");
  addSummaryRow("Policy", session.policyDecision?.reason ?? "UNKNOWN");
  addSummaryRow("Result", session.finalResponse?.status ?? "UNKNOWN");
  if (session.finalResponse?.message) {
    addSummaryRow("Details", session.finalResponse.message);
  }
}

async function loadSessions() {
  const response = await fetch("/api/sessions", {
    headers: { "x-syscora-token": apiToken }
  });
  const json = await response.json();
  sessionOutput.textContent = JSON.stringify(getPayload(json), null, 2);
}

async function controlSession(command, payload = {}) {
  const sessionId = sessionIdControl.value.trim();
  if (!sessionId) {
    addSummaryRow("Session Control", "Enter a Session ID first.");
    return;
  }
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: `session_${command}_request`,
      timestamp: new Date().toISOString(),
      payload
    }
  };
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const payloadResponse = getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Session Control", payloadResponse.session?.finalResponse?.status ?? "UNKNOWN");
  if (payloadResponse.session?.finalResponse?.reason) {
    addSummaryRow("Reason", payloadResponse.session.finalResponse.reason);
  }
  if (payloadResponse.session?.finalResponse?.message) {
    addSummaryRow("Details", payloadResponse.session.finalResponse.message);
  }
  await loadSessions();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Executing...");

  const payload = {
    workspacePath: document.getElementById("workspacePath").value,
    key: document.getElementById("envKey").value,
    value: document.getElementById("envValue").value,
    autoApprove: document.getElementById("autoApprove").checked
  };
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "set_env_intent_request",
      timestamp: new Date().toISOString(),
      payload
    }
  };

  try {
    const response = await fetch("/api/intents/set-env", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-syscora-token": apiToken
      },
      body: JSON.stringify(requestEnvelope)
    });
    const json = await response.json();
    renderSessionResult(json);
    await loadSessions();
  } catch (error) {
    executionSummary.innerHTML = "";
    addSummaryRow("Error", error instanceof Error ? error.message : "Unknown error");
  }
});

runProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Running developer workflow...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "run_project_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        workspacePath: document.getElementById("runWorkspacePath").value,
        autoApprove: document.getElementById("runAutoApprove").checked
      }
    }
  };
  try {
    const response = await fetch("/api/intents/run-project", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-syscora-token": apiToken
      },
      body: JSON.stringify(requestEnvelope)
    });
    const json = await response.json();
    renderSessionResult(json);
    await loadSessions();
  } catch (error) {
    executionSummary.innerHTML = "";
    addSummaryRow("Run Workflow Error", error instanceof Error ? error.message : "Unknown error");
  }
});

userPathForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Updating user PATH...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "add_user_path_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        entry: userPathEntry.value,
        autoApprove: userPathAutoApprove.checked
      }
    }
  };
  const response = await fetch("/api/intents/add-user-path", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  renderSessionResult(json);
  await loadSessions();
});

wingetInstallForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Running WinGet install...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "winget_install_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        id: wingetId.value,
        autoApprove: wingetAutoApprove.checked
      }
    }
  };
  const response = await fetch("/api/intents/winget-install", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  renderSessionResult(json);
  await loadSessions();
});

portInspectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Inspecting port...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "inspect_port_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        port: Number(portNumber.value)
      }
    }
  };
  const response = await fetch("/api/intents/inspect-port", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const summary = getPayload(json).summary ?? getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Port", String(summary.port));
  addSummaryRow("Listeners", String((summary.connections ?? []).length));
});

privilegedApproveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Privileged Approval", "Requesting approval token...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "privileged_approve_request",
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: "privileged_ui",
        operation: privOperationInput.value,
        scope: privScopeInput.value,
        approved: true
      }
    }
  };
  const response = await fetch("/api/privileged/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const payload = getPayload(json).approval ?? getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Privileged Approval", payload.approved ? "APPROVED" : "DENIED");
  if (payload.token) {
    privTokenInput.value = payload.token;
    addSummaryRow("Token", payload.token);
  }
  if (payload.reason) {
    addSummaryRow("Reason", payload.reason);
  }
});

privilegedExecuteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Privileged Helper", "Executing scoped helper...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "privileged_execute_request",
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: "privileged_ui",
        operation: privOperationInput.value,
        scope: privScopeInput.value,
        token: privTokenInput.value
      }
    }
  };
  const response = await fetch("/api/privileged/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const payload = getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Privileged Helper Exit Code", String(payload.exitCode ?? payload.execution?.exitCode ?? "UNKNOWN"));
  if (payload.result?.reason) {
    addSummaryRow("Reason", payload.result.reason);
  }
  if (payload.result?.stdout) {
    addSummaryRow("Output", payload.result.stdout);
  }
});

refreshSessions.addEventListener("click", () => {
  loadSessions().catch((error) => {
    sessionOutput.textContent = `Failed to load sessions: ${error.message}`;
  });
});

rollbackLatest.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/sessions/latest/rollback", {
      method: "POST",
      headers: { "x-syscora-token": apiToken }
    });
    const json = await response.json();
    const payloadResponse = getPayload(json);
    executionSummary.innerHTML = "";
    addSummaryRow("Rollback", payloadResponse.session?.finalResponse?.status ?? "UNKNOWN");
    if (payloadResponse.session?.finalResponse?.message) {
      addSummaryRow("Details", payloadResponse.session.finalResponse.message);
    }
    await loadSessions();
  } catch (error) {
    executionSummary.innerHTML = "";
    addSummaryRow("Rollback Error", error instanceof Error ? error.message : "Unknown error");
  }
});

pauseSession.addEventListener("click", () => {
  controlSession("pause", { reason: "Paused from frontend control." }).catch((error) => {
    executionSummary.innerHTML = "";
    addSummaryRow("Pause Error", error instanceof Error ? error.message : "Unknown error");
  });
});

resumeSession.addEventListener("click", () => {
  controlSession("resume", { autoApprove: true }).catch((error) => {
    executionSummary.innerHTML = "";
    addSummaryRow("Resume Error", error instanceof Error ? error.message : "Unknown error");
  });
});

cancelSession.addEventListener("click", () => {
  controlSession("cancel", { reason: "Cancelled from frontend control." }).catch((error) => {
    executionSummary.innerHTML = "";
    addSummaryRow("Cancel Error", error instanceof Error ? error.message : "Unknown error");
  });
});

loadSessions().catch(() => {
  sessionOutput.textContent = "No sessions found yet.";
});

loadSystemSummary.addEventListener("click", async () => {
  const response = await fetch("/api/system/summary", {
    headers: { "x-syscora-token": apiToken }
  });
  const json = await response.json();
  const payload = getPayload(json).summary ?? getPayload(json);
  systemSummaryOutput.textContent = JSON.stringify(payload, null, 2);
});

analyzePerformanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Analyzing system performance...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "analyze_performance_intent_request",
      timestamp: new Date().toISOString(),
      payload: {}
    }
  };
  const response = await fetch("/api/intents/analyze-performance", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const analysis = getPayload(json).analysis ?? getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Memory Pressure", analysis.memoryPressure ? "YES" : "NO");
  addSummaryRow("Free Memory (GB)", String(analysis.freeMemoryGb));
  addSummaryRow("Total Memory (GB)", String(analysis.totalMemoryGb));
  addSummaryRow("Summary", analysis.summary);
  if (analysis.topMemoryProcesses?.length) {
    addSummaryRow("Top Processes", JSON.stringify(analysis.topMemoryProcesses, null, 2));
  }
});

notepadTypeAndSaveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Running notepad workflow...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "notepad_type_and_save_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        content: notepadContent.value,
        filename: notepadFilename.value,
        autoApprove: notepadAutoApprove.checked
      }
    }
  };
  try {
    const response = await fetch("/api/intents/notepad-type-and-save", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-syscora-token": apiToken
      },
      body: JSON.stringify(requestEnvelope)
    });
    const json = await response.json();
    renderSessionResult(json);
    await loadSessions();
  } catch (error) {
    executionSummary.innerHTML = "";
    addSummaryRow("Notepad Workflow Error", error instanceof Error ? error.message : "Unknown error");
  }
});

browserSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Opening Edge and searching...");
  requestCounter += 1;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "browser_search_intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        query: browserSearchQuery.value
      }
    }
  };
  const response = await fetch("/api/intents/browser-search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-syscora-token": apiToken
    },
    body: JSON.stringify(requestEnvelope)
  });
  const json = await response.json();
  const result = getPayload(json).result ?? getPayload(json);
  executionSummary.innerHTML = "";
  addSummaryRow("Query", result.query);
  addSummaryRow("URL", result.url);
});

generalIntentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  executionSummary.innerHTML = "";
  addSummaryRow("Status", "Processing request...");
  requestCounter += 1;
  const text = document.getElementById("generalIntentText").value.trim();
  const autoApprove = document.getElementById("generalIntentAutoApprove").checked;
  const requestEnvelope = {
    envelope: {
      protocolVersion: "0.1.0",
      requestId: `web_${requestCounter}`,
      type: "intent_request",
      timestamp: new Date().toISOString(),
      payload: {
        text,
        autoApprove
      }
    }
  };
  try {
    const response = await fetch("/api/intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-syscora-token": apiToken
      },
      body: JSON.stringify(requestEnvelope)
    });
    const session = await readIntentSession(response);
    renderSessionResult({ session });
    await loadSessions();
  } catch (error) {
    executionSummary.innerHTML = "";
    addSummaryRow("Error", error instanceof Error ? error.message : "Unknown error");
  }
});
