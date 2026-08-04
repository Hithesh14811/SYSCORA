const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function payloadOf(json) {
  return json?.envelope?.payload ?? json;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error(`Runtime returned an invalid response (${response.status}).`);
  }
}

// Resolve both supported daemon contracts: the legacy synchronous response and
// the default 202 response, whose status URL eventually exposes the full session.
// fetchImpl defaults at call time so the desktop token-injecting fetch wrapper is
// used for every authenticated poll.
export async function readIntentSession(response, {
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = () => {}
} = {}) {
  const initialJson = await readJson(response);
  if (!response.ok) {
    const message = payloadOf(initialJson)?.error ?? `Runtime request failed (${response.status}).`;
    throw new Error(message);
  }

  const initialPayload = payloadOf(initialJson);
  if (initialPayload?.session) return initialPayload.session;
  if (response.status !== 202 || !initialPayload?.statusUrl) {
    throw new Error("Runtime response did not include a session or progress URL.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusResponse = await fetchImpl(initialPayload.statusUrl);
    const statusJson = await readJson(statusResponse);
    if (!statusResponse.ok) {
      const message = payloadOf(statusJson)?.error ?? `Runtime progress check failed (${statusResponse.status}).`;
      throw new Error(message);
    }

    const status = payloadOf(statusJson);
    onProgress(status);
    if (status?.terminal) {
      if (status.session) return status.session;
      throw new Error(`Runtime ended with status ${status.status ?? "UNKNOWN"} without a session result.`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`Runtime did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}
