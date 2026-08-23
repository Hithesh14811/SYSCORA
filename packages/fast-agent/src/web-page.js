// READING A PAGE WITHOUT DRIVING A BROWSER.
//
// The companion to web-search.js, and the same argument one step further along.
// Search stopped launching Chromium to obtain a list of links; this stops it
// launching Chromium to obtain the words on a page.
//
// Opening a page used to mean: spawn a separate Chromium with a fresh profile,
// wait for CDP, navigate, poll until the DOM settles, then serialise the body
// and every control on it. Several seconds, a browser process left running, a
// window on the user's screen, and — because that profile is signed in to
// nothing — the signed-out view of the page anyway. For "read this article and
// tell me what it says", every one of those costs buys nothing.
//
// An HTTP GET and a readability pass gets the same words in about a fifth of a
// second, with no process and no window.
//
// WHAT THIS CANNOT DO, which is why the browser is still there and web_open
// still falls back to it: a page whose content is written by JavaScript arrives
// here as an empty shell, and nothing can be clicked, typed into or scrolled.
// The caller decides by MEASURING what came back — see `readable` — rather than
// by guessing from the URL which sites are single-page applications, because
// that guess is wrong the week after it is written.

// The same header set the search endpoints needed, and for the same reason: a
// user-agent claiming to be Chrome with none of Chrome's other headers beside it
// is a contradiction, and a large share of the web answers that contradiction
// with a 403 that reads exactly like the page being gone. See web-search.js,
// where this cost a day.
import { BROWSER_HEADERS } from "./web-search.js";

// A page is text, not a download. 4 MB of HTML is already far past anything
// worth reading and well past what a model can be given.
const MAX_BYTES = 4 * 1024 * 1024;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/"
};

export function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    })
    .replace(/&#(\d+);/g, (whole, decimal) => {
      const code = Number(decimal);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    })
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

// Everything that is markup rather than reading matter. `script` and `style`
// first and by name: their CONTENTS are not tags, so stripping tags alone leaves
// the whole of a site's JavaScript in the text — which on a modern page is
// ninety-odd per cent of the bytes and reads as line noise.
const NON_CONTENT = /<(script|style|noscript|template|svg|iframe|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Page furniture. A nav bar and a cookie footer are on every page of a site and
// are never the answer to the question the page was opened for.
const FURNITURE = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Tags that end a line of reading. Without these every paragraph on the page
// runs into the next one and the text arrives as a single unbroken sentence.
const BLOCK_TAG = /<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|td|th|dt|dd)\b[^>]*>/gi;

/** The document's title, or an empty string. */
export function titleOf(html) {
  return decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""))?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The reading matter of a page.
 *
 * Deliberately a stripper rather than a DOM: there is no parser here, so there
 * is nothing to keep up to date and nothing that can throw on malformed markup —
 * and malformed markup is the normal case on the open web.
 */
export function extractText(html) {
  const stripped = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(NON_CONTENT, " ")
    .replace(FURNITURE, " ")
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped)
    // ONE BLOCK, ONE LINE, AND NO BLANK ONES.
    //
    // Every block tag became a newline above, so a paragraph is already a line
    // and the structure worth keeping is kept. Blank lines on top of that carry
    // nothing: they come from the empty layout <div>s a page is built out of,
    // not from anything an author wrote, and a long article has thousands of
    // them — each one paid for as a token by whoever reads the page.
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/**
 * The links on the page, absolute, deduplicated, in document order.
 *
 * These are what makes a fetched page navigable: "read this, then follow the
 * one about pricing" needs the second URL, and without them the model's only
 * move is to search again for a page it is already looking at.
 */
export function extractLinks(html, baseUrl, { limit = 60 } = {}) {
  const links = [];
  const seen = new Set();
  const body = String(html ?? "").replace(NON_CONTENT, " ");
  for (const match of body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= limit) break;
    const label = decodeEntities(match[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    // An unlabelled link is an icon or a spacer. There is nothing to say about
    // it and nothing a model could ask for it by.
    if (!label || label.length > 120) continue;
    let href;
    try {
      href = new URL(decodeEntities(match[1]), baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href)) continue;
    const key = `${label.toLowerCase()}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label, href });
  }
  return links;
}

/**
 * A page's own idea of how much of it is reading matter.
 *
 * This is the measurement web_open decides on. A server-rendered article comes
 * back with thousands of characters; a single-page application comes back with a
 * `<div id="root">` and a script tag, and needs the real browser. Judging by
 * what ARRIVED rather than by a list of known SPA domains is the whole point —
 * a domain list is wrong the week after it is written, and wrong silently.
 */
export function readable(text, { minChars = 400 } = {}) {
  return String(text ?? "").replace(/\s+/g, " ").trim().length >= minChars;
}

/**
 * Fetch and read one page. Returns `{ ok, url, title, text, links, status, reason }`.
 *
 * Never throws, for the same reason searchWeb does not: a page that could not be
 * read is a result the caller works around, and the caller has a browser to fall
 * back to.
 */
export async function fetchPage(url, { timeoutMs = 15000, fetchImpl = fetch, maxBytes = MAX_BYTES } = {}) {
  const target = String(url ?? "").trim();
  const fail = (reason, extra = {}) => ({ ok: false, url: target, title: "", text: "", links: [], reason, ...extra });
  if (!/^https?:\/\//i.test(target)) return fail("Only http(s) URLs can be read.");

  let response;
  try {
    response = await fetchImpl(target, {
      redirect: "follow",
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return fail(String(error?.message ?? error).slice(0, 160));
  }

  if (!response.ok) {
    // The status is the diagnosis and the recovery depends on it: 404 means the
    // URL is wrong, 403 means this reader is being refused and the browser may
    // still work, 5xx means try later. Collapsing them into "could not read"
    // throws all three away.
    return fail(`the site answered HTTP ${response.status}`, { status: response.status });
  }

  const type = String(response.headers?.get?.("content-type") ?? "");
  // A PDF or an image is not a page. Saying which it is lets the caller send it
  // somewhere that can read it instead of showing the model binary.
  if (type && !/text\/html|application\/xhtml|text\/plain|application\/xml|\+xml/i.test(type)) {
    return fail(`that URL is ${type.split(";")[0].trim()}, not a web page`, { status: response.status, contentType: type });
  }

  let html;
  try {
    html = await response.text();
  } catch (error) {
    return fail(String(error?.message ?? error).slice(0, 160), { status: response.status });
  }
  if (html.length > maxBytes) html = html.slice(0, maxBytes);

  // WHERE IT ENDED UP, NOT WHERE IT WAS SENT. A redirect is the ordinary way a
  // site moves you to a login wall or a regional edition, and reporting the
  // requested URL for a page that is actually somewhere else is the same class
  // of mistake as reporting a message sent that was never sent.
  const landed = String(response.url || target);
  const text = extractText(html);
  return {
    ok: true,
    url: landed,
    requestedUrl: target,
    status: response.status,
    title: titleOf(html),
    text,
    links: extractLinks(html, landed),
    readable: readable(text),
    reason: null
  };
}
