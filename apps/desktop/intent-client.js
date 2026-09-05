// How the chat surface follows a running request.
//
// The daemon has published a live event stream at /api/intents/:id/stream since
// it was written, and this client polled /status four times a second and threw
// all of it away except the single most recent event — which it then rendered by
// REPLACING one line. So a request that made six decisions and ran a dozen steps
// showed the user one flickering sentence and then a verdict, and every reason
// the agent gave for what it was doing existed, was serialized, was sent, and
// was discarded in the browser.
//
// This reads the stream. Polling remains as the fallback for a transport that
// cannot hold a connection open, because a chat that renders nothing is worse
// than a chat that renders slowly.

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// After the stream says the run has settled, the session object itself still
// comes from /status. It is written by the same handler that published the
// settle event, so it is normally there on the first read; this bounds the case
// where it is not.
const SETTLE_READ_ATTEMPTS = 20;

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

// Parse an SSE byte stream into events. Only `data:` lines are used — the
// daemon sends no event names or ids — and a frame ends at a blank line.
async function* readEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // A frame that does not parse is a frame that cannot be rendered.
            // Skipping it keeps the rest of the run visible.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function fetchSettledSession(fetchImpl, statusUrl, deadline) {
  for (let attempt = 0; attempt < SETTLE_READ_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    const response = await fetchImpl(statusUrl);
    const json = await readJson(response);
    if (!response.ok) {
      throw new Error(payloadOf(json)?.error ?? `Runtime progress check failed (${response.status}).`);
    }
    const status = payloadOf(json);
    if (status?.session) return status.session;
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  return null;
}

// Fallback path, unchanged in behaviour from before: poll /status until the
// session appears. Used when the event stream cannot be opened at all.
async function pollForSession(fetchImpl, statusUrl, { deadline, pollIntervalMs, onProgress }) {
  while (Date.now() < deadline) {
    const response = await fetchImpl(statusUrl);
    const json = await readJson(response);
    if (!response.ok) {
      throw new Error(payloadOf(json)?.error ?? `Runtime progress check failed (${response.status}).`);
    }
    const status = payloadOf(json);
    onProgress(status);
    if (status?.session) return status.session;
    if (status?.terminal) {
      throw new Error(`Runtime ended with status ${status.status ?? "UNKNOWN"} without a session result.`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Runtime did not finish within ${Math.round((deadline - Date.now()) / 1000)} seconds.`);
}

/**
 * Resolve a submitted intent, streaming its events as they happen.
 *
 * @param {Response} response  the POST /api/intents response
 * @param {object} options
 * @param {(event: object) => void} options.onEvent  every runtime event, live
 * @param {(status: object) => void} options.onProgress  polling fallback only
 */
export async function readIntentSession(response, {
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent = () => {},
  onProgress = () => {},
  onStart = () => {}
} = {}) {
  const initialJson = await readJson(response);
  if (!response.ok) {
    const message = payloadOf(initialJson)?.error ?? `Runtime request failed (${response.status}).`;
    throw new Error(message);
  }

  const initialPayload = payloadOf(initialJson);
  // The synchronous contract (?sync=true) returns the finished session outright.
  if (initialPayload?.session) return initialPayload.session;
  if (response.status !== 202 || !initialPayload?.statusUrl) {
    throw new Error("Runtime response did not include a session or progress URL.");
  }

  const deadline = Date.now() + timeoutMs;
  const { statusUrl, streamUrl } = initialPayload;
  // The caller needs the id to be able to stop this run. It is known here and
  // nowhere else until the session comes back, which is far too late to offer a
  // stop button for.
  onStart(initialPayload.sessionId);

  let stream = null;
  try {
    const streamResponse = await fetchImpl(streamUrl, { headers: { accept: "text/event-stream" } });
    if (streamResponse.ok && streamResponse.body) stream = streamResponse;
  } catch {
    // Falls through to polling below.
  }
  if (!stream) {
    return pollForSession(fetchImpl, statusUrl, { deadline, pollIntervalMs, onProgress });
  }

  let settled = false;
  for await (const event of readEventStream(stream)) {
    if (event?.type === "SESSION_SETTLED") {
      settled = true;
      // The error carried here is the runtime failing to produce a session at
      // all, which is different from a session that finished unsuccessfully —
      // the latter has a session object and renders as a result.
      if (event.error) throw new Error(event.error);
      continue;
    }
    if (event?.type === "STREAM_END") break;
    onEvent(event);
  }

  const session = await fetchSettledSession(fetchImpl, statusUrl, deadline);
  if (session) return session;
  // The stream ended without the run settling — a dropped connection, not a
  // finished request. Poll it out rather than reporting a failure that did not
  // happen.
  if (!settled) {
    return pollForSession(fetchImpl, statusUrl, { deadline, pollIntervalMs, onProgress });
  }
  throw new Error("The runtime finished but did not return a session result.");
}

/**
 * Follow a run that is ALREADY GOING, from its id alone.
 *
 * WHY THIS IS SEPARATE FROM `readIntentSession`. That one starts from the POST
 * response, because the surface that submits a request is normally the surface
 * that watches it. The floating pill breaks that assumption: a task can be
 * started there and expanded into the chat halfway through, and the chat then
 * has an id and no response.
 *
 * THE DAEMON IS WHAT MAKES IT POSSIBLE, and nothing here is clever. Its stream
 * handler writes every event the run has already produced before it attaches the
 * subscriber (`for (const event of run.events) writeSse(...)`), so a late reader
 * gets the whole run from the beginning and then continues live. That is why a
 * handover needs no state transfer between the two windows — neither of them is
 * the source of truth, and both are readers.
 *
 * A run that has already SETTLED is not an error here: the stream replays it,
 * ends, and the session is read from /status exactly as it would have been.
 */
export async function followIntentSession(sessionId, {
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onEvent = () => {},
  onProgress = () => {}
} = {}) {
  const id = encodeURIComponent(String(sessionId ?? ""));
  if (!id) throw new Error("followIntentSession needs a session id.");
  const statusUrl = `/api/intents/${id}/status`;
  const streamUrl = `/api/intents/${id}/stream`;
  const deadline = Date.now() + timeoutMs;

  let stream = null;
  try {
    const streamResponse = await fetchImpl(streamUrl, { headers: { accept: "text/event-stream" } });
    if (streamResponse.ok && streamResponse.body) stream = streamResponse;
  } catch {
    // Falls through to polling, same as the submit path.
  }
  if (!stream) return pollForSession(fetchImpl, statusUrl, { deadline, pollIntervalMs, onProgress });

  let settled = false;
  for await (const event of readEventStream(stream)) {
    if (event?.type === "SESSION_SETTLED") {
      settled = true;
      if (event.error) throw new Error(event.error);
      continue;
    }
    if (event?.type === "STREAM_END") break;
    onEvent(event);
  }

  const session = await fetchSettledSession(fetchImpl, statusUrl, deadline);
  if (session) return session;
  if (!settled) return pollForSession(fetchImpl, statusUrl, { deadline, pollIntervalMs, onProgress });
  throw new Error("The runtime finished but did not return a session result.");
}
