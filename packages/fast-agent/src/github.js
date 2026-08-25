// READING A REPOSITORY WITHOUT DOWNLOADING IT.
//
// Live, 24 Aug 2026: the user pasted a GitHub URL and the agent ran `git clone`
// and read the files off disk. That was the RATIONAL choice, because both of the
// machine-readable doors were shut, measured the same day:
//
//   github.com/nodejs/node                      200  text/html         583,751 bytes
//   api.github.com/repos/nodejs/node            200  application/json    5,945 bytes
//   raw.githubusercontent.com/.../README.md     200  text/plain         41,700 bytes
//
//   1. web-page.js refuses JSON. Its content-type gate allows html/xhtml/plain/
//      xml only, so `web_open("https://api.github.com/...")` answers "that URL is
//      application/json, not a web page". The API was unreachable from the tool
//      layer at all.
//   2. The HTML page is useless. Through this project's own reader,
//      github.com/sindresorhus/slugify yields 6,503 characters that begin "Skip
//      to content / You signed in with another tab or window" — GitHub's
//      furniture, and not one line of the repository.
//
// So the fix is not a browser and not a clone: it is the two hosts GitHub
// publishes for machines. One request returns the whole file tree; raw.github-
// usercontent.com returns a file's exact bytes as text/plain.
//
// WHY ITS OWN FETCH RATHER THAN WIDENING THE GATE IN web-page.js. Letting
// web_open read arbitrary JSON would put minified API payloads from anywhere
// into the conversation. This knows the two hosts it talks to and nothing else.

import { resolveStateDir } from "../../shared-types/src/state-path.js";
import fs from "node:fs/promises";
import path from "node:path";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

// 60 requests an hour unauthenticated, per IP — measured (x-ratelimit-remaining
// went 59, 58 on consecutive calls). A token raises it to 5,000, and the state
// directory is where every other credential this product holds already lives.
const TOKEN_FILE = "github-token";

// A file is read to be understood, not stored. Past this the model is being
// handed a minified bundle it cannot use and paying for every character.
export const MAX_FILE_CHARS = 120_000;
// The tree of a large repository is tens of thousands of paths. This is the same
// argument, and the same shape, as the folder listing in the composer.
export const MAX_TREE_ENTRIES = 200;

// Generated, vendored or cached — never what somebody wrote. Kept in step with
// MACHINERY in apps/desktop/attachments.js; the two lists solve the same problem
// at opposite ends of the product.
const MACHINERY = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.tox|site-packages|dist|build|target|coverage|\.next|\.nuxt|\.parcel-cache|\.gradle|\.idea|vendor|Pods|\.yarn)(\/|$)/i;

/**
 * Pull owner/repo/ref/path out of anything a person is likely to paste.
 *
 * A `/blob/` URL naming one file is the most common paste of all, and it must
 * land on that file rather than on the repository's front page.
 *
 * @returns {{owner: string, repo: string, ref: string|null, path: string|null, kind: string}|null}
 */
export function parseRepoReference(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // A bare `owner/repo`, which is how people say it out loud.
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  if (bare && !raw.includes("://") && !raw.includes(" ")) {
    return { owner: bare[1], repo: bare[2], ref: null, path: null, kind: "repo" };
  }

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "github.com" && host !== "raw.githubusercontent.com") return null;

  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");

  // raw.githubusercontent.com/owner/repo/ref/path…
  if (host === "raw.githubusercontent.com") {
    return parts.length > 3
      ? { owner, repo, ref: parts[2], path: parts.slice(3).join("/"), kind: "file" }
      : { owner, repo, ref: parts[2] ?? null, path: null, kind: "repo" };
  }

  const section = parts[2];
  if (!section) return { owner, repo, ref: null, path: null, kind: "repo" };

  // /blob/<ref>/<path> is one file; /tree/<ref>/<path> is one directory.
  if ((section === "blob" || section === "tree") && parts.length >= 4) {
    const ref = parts[3];
    const rest = parts.slice(4).join("/");
    return {
      owner,
      repo,
      ref,
      path: rest || null,
      kind: section === "blob" && rest ? "file" : "tree"
    };
  }
  // Anything else — /pull/12, /issues, /releases — is still a repository
  // reference, and answering about the repository is better than refusing.
  return { owner, repo, ref: null, path: null, kind: "repo" };
}

async function readToken(basePath) {
  try {
    const file = path.join(resolveStateDir(basePath), TOKEN_FILE);
    const token = (await fs.readFile(file, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * One request, with the rate limit read off the response rather than guessed at.
 *
 * WHAT THE LIMIT MUST SAY. "Could not read the repository" is the wrong answer
 * to "you have used your 60 requests this hour" — it sends the agent looking for
 * a different route when the only useful thing is a time. So the headers are
 * read and the reset is reported as a clock time.
 */
async function request(url, { token, fetchImpl = fetch, timeoutMs = 15000, accept, retries = 1 }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      headers: {
        // GitHub refuses requests with no user agent.
        "user-agent": "SYSCORA",
        accept,
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 160) };
  }

  const remaining = Number(response.headers?.get?.("x-ratelimit-remaining") ?? NaN);
  const resetAt = Number(response.headers?.get?.("x-ratelimit-reset") ?? NaN);

  if (response.status === 403 || response.status === 429) {
    if (Number.isFinite(remaining) && remaining <= 0) {
      const when = Number.isFinite(resetAt)
        ? new Date(resetAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "shortly";
      return {
        ok: false,
        status: response.status,
        rateLimited: true,
        reason: `GitHub's rate limit for this machine is used up${token ? "" : " (60 requests an hour without a token)"} ` +
          `and resets at ${when}. Nothing is wrong with the repository.`
      };
    }
    return { ok: false, status: response.status, reason: "GitHub refused this request (403)." };
  }
  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      reason: token
        ? "no such repository, or the token cannot see it"
        : "no such repository — or it is private, and this has no GitHub token"
    };
  }
  // A GATEWAY BLIP IS NOT A BROKEN REPOSITORY. Measured 24 Aug 2026 while
  // building this: api.github.com answered 504 to /repos and /readme for several
  // minutes while raw.githubusercontent.com served every request, then recovered
  // on its own. Reporting that as "could not read the repository" sends the
  // agent looking for another route to a repository that is perfectly fine.
  // One retry, because two failures a second apart is a real outage and a third
  // attempt only spends the rate limit.
  if (response.status >= 500 && retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return request(url, { token, fetchImpl, timeoutMs, accept, retries: retries - 1 });
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: response.status >= 500
        ? `GitHub itself is having trouble (HTTP ${response.status}, twice). The repository is probably fine — try again shortly.`
        : `GitHub answered HTTP ${response.status}`
    };
  }

  const body = await response.text().catch(() => "");
  return { ok: true, status: response.status, body, remaining, url: String(response.url || url) };
}

const asJson = (body) => { try { return JSON.parse(body); } catch { return null; } };

/** Description, language, default branch — the things that say what a repo IS. */
export async function readRepository(reference, options = {}) {
  const token = options.token ?? await readToken(options.basePath);
  const result = await request(`${API}/repos/${reference.owner}/${reference.repo}`, {
    ...options, token, accept: "application/vnd.github+json"
  });
  if (!result.ok) return result;
  const data = asJson(result.body);
  if (!data) return { ok: false, reason: "GitHub's answer was not readable JSON" };
  return {
    ok: true,
    remaining: result.remaining,
    repository: {
      fullName: data.full_name,
      description: data.description ?? null,
      language: data.language ?? null,
      defaultBranch: data.default_branch ?? "main",
      stars: data.stargazers_count ?? null,
      license: data.license?.spdx_id ?? null,
      topics: Array.isArray(data.topics) ? data.topics.slice(0, 8) : [],
      updatedAt: data.pushed_at ?? data.updated_at ?? null,
      archived: Boolean(data.archived),
      homepage: data.homepage || null
    }
  };
}

/**
 * The whole file list in ONE request.
 *
 * Filtered the way the composer filters an attached folder, and for the same
 * reason: an alphabetical listing of a real project is `.git` object hashes and
 * `node_modules` until it runs out of room, and never reaches a file anybody
 * wrote. What is left out is COUNTED AND NAMED — a listing that quietly omits
 * things reads as a complete listing.
 */
export async function readTree(reference, options = {}) {
  const token = options.token ?? await readToken(options.basePath);
  const ref = reference.ref ?? options.defaultBranch ?? "HEAD";
  const result = await request(
    `${API}/repos/${reference.owner}/${reference.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { ...options, token, accept: "application/vnd.github+json" }
  );
  if (!result.ok) return result;
  const data = asJson(result.body);
  if (!Array.isArray(data?.tree)) return { ok: false, reason: "GitHub returned no file tree for that branch" };

  const files = data.tree.filter((entry) => entry.type === "blob");
  const skipped = files.filter((entry) => MACHINERY.test(entry.path));
  const everythingIsMachinery = skipped.length === files.length;
  const content = everythingIsMachinery ? files : files.filter((entry) => !MACHINERY.test(entry.path));
  const depth = (entry) => entry.path.split("/").length;
  const ranked = [...content].sort((left, right) => depth(left) - depth(right) || left.path.localeCompare(right.path));

  const kinds = new Map();
  for (const entry of content) {
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(entry.path)?.[1]?.toLowerCase();
    if (extension) kinds.set(extension, (kinds.get(extension) ?? 0) + 1);
  }

  return {
    ok: true,
    remaining: result.remaining,
    ref,
    fileCount: files.length,
    // GitHub says so itself when the repository is too large for one request,
    // and a truncated tree presented as a whole one is a lie about the project.
    truncated: Boolean(data.truncated),
    entries: ranked.slice(0, MAX_TREE_ENTRIES).map((entry) => ({ path: entry.path, bytes: entry.size ?? 0 })),
    omitted: Math.max(0, ranked.length - MAX_TREE_ENTRIES),
    machinery: everythingIsMachinery ? 0 : skipped.length,
    mostly: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([extension, count]) => ({ extension, count }))
  };
}

/** One file's exact bytes, as text. No HTML, no API quota — raw is not the API. */
export async function readFile(reference, options = {}) {
  const ref = reference.ref ?? options.defaultBranch ?? "HEAD";
  const token = options.token ?? await readToken(options.basePath);
  const url = `${RAW}/${reference.owner}/${reference.repo}/${encodeURIComponent(ref)}/` +
    String(reference.path ?? "").split("/").map(encodeURIComponent).join("/");
  const result = await request(url, { ...options, token, accept: "text/plain" });
  if (!result.ok) {
    return result.status === 404
      ? { ok: false, status: 404, reason: `there is no ${reference.path} on ${ref} in that repository` }
      : result;
  }
  const whole = result.body ?? "";
  // A minified bundle or a lockfile is not readable and not worth paying for.
  // Said explicitly, because silence here reads as "the file is this short".
  const text = whole.slice(0, MAX_FILE_CHARS);
  return { ok: true, ref, path: reference.path, text, truncated: whole.length > text.length, bytes: whole.length };
}

/** The README, whatever it is called and wherever it is. */
export async function readReadme(reference, options = {}) {
  const token = options.token ?? await readToken(options.basePath);
  const result = await request(`${API}/repos/${reference.owner}/${reference.repo}/readme`, {
    ...options, token, accept: "application/vnd.github.raw"
  });
  if (!result.ok) return result;
  const body = result.body ?? "";
  // `accept: raw` normally returns the file itself; some proxies answer with the
  // JSON envelope anyway, and base64 in the transcript helps nobody.
  const envelope = body.trimStart().startsWith("{") ? asJson(body) : null;
  const text = envelope?.content && envelope.encoding === "base64"
    ? Buffer.from(envelope.content, "base64").toString("utf8")
    : body;
  const clipped = text.slice(0, MAX_FILE_CHARS);
  return { ok: true, text: clipped, truncated: text.length > clipped.length, remaining: result.remaining };
}
