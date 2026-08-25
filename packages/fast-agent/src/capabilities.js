// A CAPABILITY THE AGENT WROTE FOR ITSELF.
//
// The user's proposal, in their words: "if it needs a tool it doesn't have, let
// it create one, save it, and reuse it later — it should never be able to modify
// the source or delete a tool, only add."
//
// WHY THIS IS DATA AND NOT CODE.
//
// The obvious reading — the model writes JavaScript and we run it — buys the
// most power and costs the most of everything else: a sandbox, a review step, a
// story for what generated code does when it hits a CONFIRM gate, and a new
// execution surface in a product that ships zero runtime dependencies and whose
// supply-chain surface is currently nothing. A saved capability here is
// therefore a DESCRIPTION of an HTTPS GET and how to read the answer. It cannot
// execute anything, so there is nothing to sandbox.
//
// WHY IT IS NOT A TOOL IN THE SCHEMA. Measured 24 Aug 2026 with
// `node scripts/measure-prompt-cost.mjs`: 33 tools are 5,397 tokens of schema,
// about 163 tokens each, and that is re-sent on EVERY step of EVERY request
// forever — and a changed schema moves the endpoint's cached prefix, which is
// worth roughly 10x on input price. Ten self-authored tools would be +1,600
// tokens a step whether or not anybody used them. So saved capabilities are
// dispatched through ONE tool whose description never grows, and are advertised
// to the model as one line each, only once any exist. A user who never saves one
// pays nothing at all.
//
// ADDITIVE ONLY, as asked. save() creates and updates. There is no delete, on
// purpose: the files are plain JSON in the user's own state directory and
// removing one is theirs to do, in Explorer, like a note or a skill.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../shared-types/src/state-path.js";

export const MAX_CAPABILITIES_SHOWN = 10;
export const MAX_RESPONSE_CHARS = 20_000;
// A capability that keeps failing is worse than none: it costs a round trip and
// then the work has to be done anyway. Reported, never deleted — see save().
export const UNRELIABLE_BELOW = 0.6;
export const JUDGE_AFTER_RUNS = 4;

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

export function capabilitiesDirectory(basePath) {
  return path.join(resolveStateDir(basePath), "capabilities");
}

/**
 * Is this a capability that can be saved, and if not, exactly why?
 *
 * Refusals are sentences rather than codes because the model reads them and has
 * to be able to fix the thing it just wrote.
 */
export function validateCapability(candidate) {
  const problems = [];
  const record = candidate && typeof candidate === "object" ? candidate : {};

  if (!ID.test(String(record.id ?? ""))) {
    problems.push("id must be lower-case letters, digits and hyphens (it becomes a file name)");
  }
  if (!String(record.title ?? "").trim()) problems.push("title is required — it is what you will see later");
  if (!String(record.when ?? "").trim()) {
    problems.push("`when` is required: one line saying what request this is for, or you will never find it again");
  }

  let url;
  try {
    url = new URL(String(record.url ?? ""));
  } catch {
    problems.push("url must be an absolute URL with a {placeholder} for each parameter");
  }
  // HTTPS ONLY, GET ONLY.
  //
  // A POST can send the user's data somewhere and belongs in the CONFIRM table
  // in shell-rules.js, not in a JSON file the agent writes for itself. http://
  // is refused because a capability is saved once and replayed for months, and
  // the moment it is replayed on a different network it is somebody else's.
  if (url && url.protocol !== "https:") problems.push("only https:// is allowed");
  if (record.method && String(record.method).toUpperCase() !== "GET") {
    problems.push("only GET is allowed — anything that sends data needs a person, not a saved file");
  }
  // NO CREDENTIALS. Not "do not put a key here" as advice — a saved file is
  // read back into the transcript, and this project has already leaked a live
  // key that way once.
  const asText = JSON.stringify(record);
  if (/"(authorization|api[_-]?key|token|secret|password)"\s*:/i.test(asText)) {
    problems.push("a capability may not carry a credential; use a tool that has one, or ask the user");
  }

  const placeholders = new Set();
  for (const match of String(record.url ?? "").matchAll(PLACEHOLDER)) placeholders.add(match[1]);
  const declared = new Set((Array.isArray(record.parameters) ? record.parameters : [])
    .map((parameter) => String(parameter?.name ?? "")).filter(Boolean));
  for (const name of placeholders) {
    if (!declared.has(name)) problems.push(`the url uses {${name}} but no parameter declares it`);
  }
  for (const name of declared) {
    if (!placeholders.has(name)) problems.push(`parameter "${name}" is declared but never used in the url`);
  }

  return { ok: problems.length === 0, problems, host: url?.hostname ?? null };
}

const safeId = (id) => String(id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 50).toLowerCase();

export function capabilityPath(basePath, id) {
  return path.join(capabilitiesDirectory(basePath), `${safeId(id)}.json`);
}

/** Every saved capability, worst-formed ones skipped rather than fatal. */
export async function listCapabilities(basePath) {
  let names;
  try {
    names = await fs.readdir(capabilitiesDirectory(basePath));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(capabilitiesDirectory(basePath), name), "utf8"));
      // A file the user edited into nonsense must not take the whole list down
      // with it — they are invited to edit these, so this will happen.
      if (validateCapability(record).ok) found.push(record);
    } catch { /* unreadable or not JSON: skip it */ }
  }
  return found.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export async function readCapability(basePath, id) {
  try {
    const record = JSON.parse(await fs.readFile(capabilityPath(basePath, id), "utf8"));
    return validateCapability(record).ok ? record : null;
  } catch {
    return null;
  }
}

/** Create or update. There is deliberately no delete — see the header. */
export async function saveCapability(basePath, candidate) {
  const check = validateCapability(candidate);
  if (!check.ok) return { ok: false, problems: check.problems };

  const existing = await readCapability(basePath, candidate.id);
  const record = {
    ...candidate,
    method: "GET",
    // PINNED AT SAVE TIME. The host is what makes this capability what it is, and
    // a parameter must never be able to move it — see fillTemplate().
    host: check.host,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    runs: existing?.runs ?? 0,
    failures: existing?.failures ?? 0
  };
  await fs.mkdir(capabilitiesDirectory(basePath), { recursive: true });
  await fs.writeFile(capabilityPath(basePath, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { ok: true, capability: record, replaced: Boolean(existing) };
}

async function recordOutcome(basePath, capability, worked) {
  const record = {
    ...capability,
    runs: (capability.runs ?? 0) + 1,
    failures: (capability.failures ?? 0) + (worked ? 0 : 1)
  };
  await fs.writeFile(capabilityPath(basePath, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8")
    .catch(() => { /* the run already happened; failing to write the tally must not undo it */ });
  return record;
}

/**
 * Substitute the arguments, and refuse if the result has moved host.
 *
 * THIS IS THE WHOLE SECURITY MODEL. A capability is saved once and replayed for
 * months, and between those two moments the agent reads web pages, chat messages
 * and documents written by other people. `{repo}` filled with
 * `../../evil.com/x` or `x?next=https://evil.com` is exactly the shape
 * content-boundary.js exists to catch, one layer down: what it READ must not be
 * able to redirect what it DOES.
 */
export function fillTemplate(capability, args = {}) {
  const missing = [];
  const filled = String(capability.url).replace(PLACEHOLDER, (whole, name) => {
    const value = args[name];
    if (value === undefined || value === null || String(value) === "") {
      missing.push(name);
      return whole;
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length) return { ok: false, reason: `missing ${missing.join(", ")}` };

  let url;
  try {
    url = new URL(filled);
  } catch {
    return { ok: false, reason: "the filled-in url is not a valid url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "the filled-in url is not https" };
  if (url.hostname !== capability.host) {
    return {
      ok: false,
      reason: `this capability is for ${capability.host} and the arguments pointed it at ${url.hostname} — refused`
    };
  }
  return { ok: true, url: url.toString() };
}

const dig = (value, dotted) => String(dotted).split(".").reduce(
  (current, key) => (current === null || current === undefined ? undefined : current[key]),
  value
);

/** Pull out the fields the capability said it wanted; whole text if it said none. */
export function renderResponse(capability, body, contentType = "") {
  const fields = Array.isArray(capability.render) ? capability.render.filter(Boolean) : [];
  const isJson = /json/i.test(contentType) || body.trimStart().startsWith("{") || body.trimStart().startsWith("[");
  if (!fields.length || !isJson) return body.slice(0, MAX_RESPONSE_CHARS);

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return body.slice(0, MAX_RESPONSE_CHARS);
  }
  const rows = (Array.isArray(data) ? data.slice(0, 25) : [data]).map((item) => fields
    .map((field) => {
      const value = dig(item, field);
      if (value === undefined || value === null) return null;
      return `${field}: ${typeof value === "object" ? JSON.stringify(value).slice(0, 200) : String(value)}`;
    })
    .filter(Boolean)
    .join(" · "));
  const rendered = rows.filter(Boolean).join("\n");
  // A render that selects nothing has told the model nothing, and the raw body
  // is more useful than an empty string pretending to be an answer.
  return (rendered || body).slice(0, MAX_RESPONSE_CHARS);
}

/** Call one. Returns what came back plus the tally, never throwing on a bad answer. */
export async function runCapability(basePath, id, args = {}, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const capability = await readCapability(basePath, id);
  if (!capability) return { ok: false, reason: `there is no saved capability called "${id}"` };

  const target = fillTemplate(capability, args);
  if (!target.ok) return { ok: false, capability, reason: target.reason };

  let response;
  try {
    response = await fetchImpl(target.url, {
      redirect: "follow",
      headers: { "user-agent": "SYSCORA", accept: capability.accept || "application/json, text/plain" },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    await recordOutcome(basePath, capability, false);
    return { ok: false, capability, url: target.url, reason: String(error?.message ?? error).slice(0, 160) };
  }

  // A REDIRECT IS A HOST CHANGE TOO. `redirect: "follow"` is convenient and it
  // is also the other way off the pinned host, so where it LANDED is checked,
  // not where it was sent — the same distinction web-page.js makes about which
  // URL it reports.
  let landed;
  try {
    landed = new URL(String(response.url || target.url));
  } catch {
    landed = null;
  }
  if (landed && landed.hostname !== capability.host) {
    await recordOutcome(basePath, capability, false);
    return {
      ok: false, capability, url: target.url,
      reason: `it redirected to ${landed.hostname}, which is not ${capability.host} — nothing was read`
    };
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    const tally = await recordOutcome(basePath, capability, false);
    return { ok: false, capability: tally, url: target.url, status: response.status, reason: `answered HTTP ${response.status}` };
  }
  const tally = await recordOutcome(basePath, capability, true);
  return {
    ok: true,
    capability: tally,
    url: target.url,
    status: response.status,
    text: renderResponse(capability, body, response.headers?.get?.("content-type") ?? ""),
    bytes: body.length
  };
}

/**
 * The one line each saved capability gets in front of the model.
 *
 * This is the whole discovery mechanism, and it is why the dispatcher tool's
 * description never has to grow. Bounded, and empty when nothing is saved — so
 * this costs nothing until the user has actually taught it something.
 */
export function describeCapabilities(capabilities) {
  if (!capabilities.length) return "";
  const lines = capabilities.slice(0, MAX_CAPABILITIES_SHOWN).map((capability) => {
    const parameters = (capability.parameters ?? []).map((parameter) => parameter.name).join(", ");
    const runs = capability.runs ?? 0;
    const failures = capability.failures ?? 0;
    // Said out loud rather than hidden: a capability that keeps failing costs a
    // round trip and then the work has to be done anyway. Never deleted here —
    // these files are the user's.
    const unreliable = runs >= JUDGE_AFTER_RUNS && (runs - failures) / runs < UNRELIABLE_BELOW
      ? " [unreliable lately — prefer another route]"
      : "";
    return `- ${capability.id}(${parameters}) — ${capability.when}${unreliable}`;
  });
  const more = capabilities.length > MAX_CAPABILITIES_SHOWN
    ? `\n(${capabilities.length - MAX_CAPABILITIES_SHOWN} more; they are in ${"`.syscora/capabilities`"}.)`
    : "";
  return `Capabilities saved on this machine, callable with capability({action:"run", id, arguments}):\n${lines.join("\n")}${more}`;
}
