// SEARCHING WITHOUT DRIVING A BROWSER.
//
// Every lookup used to go through the controlled Chromium: launch it, navigate,
// wait for the DOM, serialise the page. For a search that is the wrong tool at
// every step. Measured live on 22 Aug 2026, a request to find internships:
// Google answered the controlled browser with a CAPTCHA page ("Our systems have
// detected unusual traffic from your computer network"), and the run then spent
// four more page loads on LinkedIn getting the signed-out marketing view. Six
// navigations, tens of thousands of tokens of page chrome, to obtain a list of
// ten links.
//
// A search engine's results are a LIST, and a list can be fetched over HTTP in
// one round trip and returned as ten titles with ten URLs. That is what this is.
//
// WHEN THE BROWSER IS STILL THE RIGHT ANSWER, and the tool description says so
// rather than leaving the model to discover it: anything behind a login,
// anything that needs clicking or typing, and reading a specific page in full.
// Search finds the page; the browser is for when you have to BE on it.
//
// NO API KEY. A key would mean another credential in the state directory and an
// account to keep funded, for a capability that has to work on a fresh install
// with nothing configured. DuckDuckGo's HTML endpoint needs neither.

const ENDPOINTS = [
  // Lite first: same results, a fraction of the markup, so less to parse and
  // less to go wrong.
  { name: "duckduckgo-lite", url: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
  { name: "duckduckgo-html", url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` }
];

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " "
};
const decode = (value) => String(value ?? "")
  .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity)
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

const stripTags = (html) => decode(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * DuckDuckGo wraps outbound links in a redirector. The real destination is in
 * the `uddg` parameter; showing the redirector instead would give the model a
 * URL it cannot reason about and the user a link they cannot read.
 */
export function unwrapRedirect(href) {
  const raw = String(href ?? "");
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { /* fall through to the raw href */ }
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

/**
 * Pull results out of a DuckDuckGo response.
 *
 * Deliberately tolerant: both endpoints change their markup from time to time,
 * and the failure this must never produce is a confident empty list. When the
 * shape is not recognised, `results` comes back empty and the caller reports
 * that the page could not be parsed — which is a different thing from "nothing
 * matched", and the difference matters to whoever reads the answer.
 */
export function parseResults(html, { limit = 10 } = {}) {
  const text = String(html ?? "");
  const results = [];
  const seen = new Set();

  const push = (href, title, snippet) => {
    const url = unwrapRedirect(href);
    if (!/^https?:\/\//i.test(url)) return;
    // DuckDuckGo's own pages are navigation, not results.
    if (/^https?:\/\/(duckduckgo\.com|lite\.duckduckgo\.com|html\.duckduckgo\.com)/i.test(url)) return;
    if (seen.has(url)) return;
    const cleanTitle = stripTags(title);
    if (!cleanTitle) return;
    seen.add(url);
    results.push({ title: cleanTitle, url, snippet: stripTags(snippet).slice(0, 320) });
  };

  // ONE ANCHOR AT A TIME, WITH NO LOOKAHEAD.
  //
  // The first version of this matched a result BLOCK — title, then everything
  // up to the next result — in a single expression ending in a lookahead. That
  // backtracks: to make the lookahead succeed the engine is free to grow the
  // lazy title group past the real `</a>` to a later one, so every title came
  // back with the URL and the whole snippet glued onto it. In isolation the same
  // expression was correct, which is exactly what made it worth measuring
  // instead of reading.
  //
  // Both endpoints wrap every outbound result in DuckDuckGo's `uddg=`
  // redirector, and nothing else on the page uses it. So that is the anchor to
  // look for — no classes, no block structure, nothing that changes when they
  // restyle. (The lite endpoint writes `class='result-link'` in SINGLE quotes,
  // which is why the class-based version silently matched nothing there and
  // every lite search fell through to the slower endpoint.)
  const anchor = /<a\b[^>]*href=["']([^"']*uddg=[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...text.matchAll(anchor)];

  // A SNIPPET BELONGS TO THE ANCHOR ABOVE IT, NOT TO ITS OWN POSITION IN A LIST.
  //
  // Collecting every snippet on the page and zipping them onto the results by
  // index put the wrong description under every row: the page carries sponsored
  // rows whose link is filtered out but whose snippet still counted, so
  // everything shifted by one and LinkedIn was described as Jobrapido. A
  // snippet under the wrong result is worse than no snippet at all — it is a
  // confident, specific, wrong statement about a link the user may click.
  //
  // So each snippet is taken only from the markup BETWEEN this anchor and the
  // next one. Nothing found there means no snippet, which is honest and still
  // leaves a title and a URL.
  for (const [position, match] of anchors.entries()) {
    if (results.length >= limit) break;
    const here = unwrapRedirect(match[1]);
    // The window ends at the next anchor pointing SOMEWHERE ELSE, not simply at
    // the next anchor. The html endpoint emits a second, image-only anchor to
    // the same URL between the title and its snippet, so stopping at "the next
    // anchor" closed the window before the snippet and the first result always
    // came back with none.
    let next = text.length;
    for (let ahead = position + 1; ahead < anchors.length; ahead += 1) {
      if (unwrapRedirect(anchors[ahead][1]) !== here) { next = anchors[ahead].index; break; }
    }
    const from = match.index + match[0].length;
    const between = text.slice(from, Math.min(next, from + 4000));
    const snippet = /class=["'][^"']*result[-_]+snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(between)?.[1] ?? "";
    push(match[1], match[2], snippet);
  }

  return results;
}

/**
 * Run a search. Returns `{ ok, query, results, provider, reason }`.
 *
 * Never throws: a failed search is a result the model reads and works around,
 * exactly like a non-zero exit code, and the whole point of this file is that
 * it can say "the engine refused" rather than silently returning nothing.
 */
export async function searchWeb(query, { limit = 10, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return { ok: false, query: trimmed, results: [], provider: null, reason: "No search terms were given." };

  const failures = [];
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchImpl(endpoint.url(trimmed), {
        headers: {
          // A default Node user-agent is refused outright by every search
          // engine. This is the same string the controlled browser sends.
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = response.ok ? await response.text() : "";
      // "RATE LIMITED" AND "NOTHING MATCHED" ARE DIFFERENT ANSWERS.
      //
      // They lead the model to different recoveries — wait or open a browser
      // versus rephrase the query — so collapsing them into "no results" sends
      // it the wrong way. Observed here: after repeated automated searches from
      // one address, DuckDuckGo answers HTTP 202 with a challenge page carrying
      // no results and none of the words this used to look for, and the search
      // reported "no results could be parsed" for a query that had worked
      // minutes earlier.
      //
      // 202 is the tell: a search engine that means "here are your results"
      // answers 200. Anything else, or a page whose <title> is a challenge, or
      // a body with no result links in it at all, is the engine declining.
      const challenged = response.status === 202
        || /detected unusual traffic|are you a robot|<title>\s*captcha/i.test(body)
        || (body.length > 0 && !/uddg=/.test(body));
      if (!response.ok) { failures.push(`${endpoint.name}: HTTP ${response.status}`); continue; }
      if (challenged) {
        failures.push(`${endpoint.name}: declined the request (HTTP ${response.status}) — it is rate-limiting this machine`);
        continue;
      }
      const results = parseResults(body, { limit });
      if (results.length === 0) { failures.push(`${endpoint.name}: answered, but no results could be parsed`); continue; }
      return { ok: true, query: trimmed, results, provider: endpoint.name, reason: null };
    } catch (error) {
      failures.push(`${endpoint.name}: ${String(error?.message ?? error).slice(0, 80)}`);
    }
  }

  return {
    ok: false,
    query: trimmed,
    results: [],
    provider: null,
    // Every endpoint's own words, because "search failed" tells the model
    // nothing about whether to retry, rephrase, or open a browser instead.
    reason: failures.join("; ")
  };
}

/** How the results are shown to the model and, through it, to the user. */
export function renderResults({ query, results, provider }) {
  const lines = [`${results.length} result${results.length === 1 ? "" : "s"} for "${query}" (${provider})`, ""];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  }
  return lines.join("\n");
}

// Exported for the toolset's own use; kept here so the escaping rule lives with
// the parsing it belongs to.
export { stripTags };
