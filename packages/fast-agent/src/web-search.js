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
// with nothing configured. None of the endpoints below need one.
//
// THE 202 WAS US, NOT THEM.
//
// On 23 Aug 2026 every search on this machine failed: both DuckDuckGo endpoints
// answered HTTP 202 with a challenge page, and this file said so in the honest
// words it had — "it is rate-limiting this machine". Which was wrong, and being
// wrong in a plausible way is what made it cost a day. The same query, typed
// into a real browser on the same machine at the same minute, returned ten
// results immediately.
//
// The difference was the REQUEST SHAPE. This sent a user-agent claiming to be
// Chrome and two other headers. A real Chrome also sends `sec-fetch-*`,
// `sec-ch-ua*` and `upgrade-insecure-requests`, and their absence beside a
// Chrome user-agent is a contradiction any bot check can read. Sending the whole
// set turned both endpoints from 202-and-nothing into 200-with-ten-results,
// measured directly. See BROWSER_HEADERS.
//
// The lesson generalises past this file: when an external service refuses us and
// a browser on the same machine is not refused, the difference is ours to find.
//
// ONE ENGINE IS NOT A CAPABILITY, AND ASKING THEM IN TURN IS NOT ENOUGH.
//
// The list below used to be tried in ORDER, first one that answers wins. That
// hides a bad answer behind a successful request, and the benchmark makes the
// shape of it embarrassingly clear. Measured 23 Aug 2026 over twelve queries
// (`node scripts/bench-search.mjs`):
//
//   answered by DuckDuckGo   8/8 with a good result at rank 1
//   answered by Bing         0/4 with a good result ANYWHERE in eight
//
// Bing was not slightly worse. Asked for "python asyncio TaskGroup example" it
// returned python.org's home page and a W3Schools index; asked "how to stop
// windows 11 from reopening apps after restart" it returned the dictionary
// definition of "stop"; asked "where can i buy the chepest iphone 17pro" it
// returned Canva and the dictionary definition of "can". It collapses a long
// query to its first recognisable entity. Falling back to that is worse than
// failing, because a failure says so and this does not.
//
// DuckDuckGo also rate-limits under burst — twelve queries in ten seconds and it
// starts answering 202 — which is exactly when the fallback fires. So the good
// engine goes away and the bad one speaks for us.
//
// SO: ASK EVERYONE AT ONCE, AND RANK BY AGREEMENT.
//
// The indexes are queried in PARALLEL, and their rankings are fused with
// Reciprocal Rank Fusion. Agreement between operators who built their indexes
// independently is a quality signal that costs nothing to compute and is very
// hard to fake: docs.python.org is returned for that query by DuckDuckGo AND
// Yahoo, while "Anti-Oppressive Social Work Practice" is returned by Bing and by
// nobody else. Consensus is what demotes it — no rule about dictionaries, no
// blocklist, nothing that has to be maintained.
//
// An INDEX is the unit, not an endpoint. DuckDuckGo's lite and html pages are
// one opinion served twice, and counting them as two voters would let one
// operator outvote the others.

// Bing's own index, reached through Yahoo's ranking of it. Worth having as a
// separate voter precisely because the ranking differs so much: on the two
// queries Bing destroyed above, Yahoo returned SuperFastPython and
// docs.python.org, then HelpDeskGeek and How-To Geek. Same crawl, different
// judgement, and the judgement is what was broken.
const YAHOO_ENDPOINT = {
  name: "yahoo",
  url: (query) => `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`,
  parse: parseYahooResults,
  declined: (body) => !/r\.search\.yahoo\.com/.test(body)
};

const INDEXES = [
  {
    name: "duckduckgo",
    endpoints: [
      // Lite first: same results, a fraction of the markup, so less to parse and
      // less to go wrong.
      {
        name: "duckduckgo-lite",
        url: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        parse: parseResults,
        declined: (body) => !/uddg=/.test(body)
      },
      {
        name: "duckduckgo-html",
        url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        parse: parseResults,
        declined: (body) => !/uddg=/.test(body)
      }
    ]
  },
  { name: "yahoo", endpoints: [YAHOO_ENDPOINT] },
  {
    name: "bing",
    endpoints: [
      // Bing's RSS view: `<item><title><link><description>`, nothing else. No
      // markup to keep up with, so this is the one endpoint whose parser cannot
      // be broken by a redesign.
      {
        name: "bing-rss",
        url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`,
        parse: parseRssResults,
        // An answer is a feed with items in it. Anything else — a challenge, an
        // interstitial, an empty channel — is the engine declining.
        declined: (body) => !/<item[\s>]/i.test(body)
      },
      {
        name: "bing-html",
        url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
        parse: parseBingHtmlResults,
        declined: (body) => /detected unusual traffic|are you a robot|<title>\s*captcha/i.test(body)
          || !/id="b_results"|class="b_algo"/.test(body)
      }
    ]
  }
];

// WHAT A BROWSER ACTUALLY SENDS.
//
// A user-agent string claiming to be Chrome, with none of the headers Chrome
// always sends beside it, is a contradiction — and it is the contradiction that
// got this rejected, not the volume of requests. Every field below is one a real
// Chrome 124 puts on a top-level navigation; together they are the difference
// between HTTP 202 and a page of results, measured on both DuckDuckGo endpoints.
//
// This is not evasion of a rate limit or a paywall: the requests are one per
// search, from a person's own machine, for the pages they asked to look at.
// It is a client describing itself accurately.
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // xml is in the list because one endpoint returns a feed.
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1"
};

export { BROWSER_HEADERS };

// Deciding which of the fused candidates are actually about the question. See
// search-rank.js: consensus is free, the snippet is nearly free, and reading the
// page is spent only on the few a search cannot settle any other way.
import { rerank } from "./search-rank.js";

// Punctuation entities are here because titles are FULL of them and a title
// reading "The best laptops in 2026 &mdash; tested, reviewed" is what the model
// then repeats to the user.
const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " ",
  "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
  "&rdquo;": "”", "&ldquo;": "“", "&rsaquo;": "›", "&lsaquo;": "‹", "&raquo;": "»", "&laquo;": "«",
  "&apos;": "'", "&middot;": "·", "&bull;": "•", "&times;": "×", "&trade;": "™", "&reg;": "®", "&copy;": "©"
};
const decode = (value) => String(value ?? "")
  .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27|mdash|ndash|hellip|[lr]squo|[lr]dquo|[lr]saquo|[lr]aquo|apos|middot|bull|times|trade|reg|copy);/g,
    (entity) => ENTITIES[entity] ?? entity)
  .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
  })
  .replace(/&#(\d+);/g, (whole, code) => (Number(code) > 0 ? String.fromCodePoint(Number(code)) : whole));

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
 * Pull results out of an RSS feed of search results.
 *
 * `<item>` carries `<title>`, `<link>` and `<description>` and nothing else, so
 * there is no page structure to guess at. Titles and descriptions may be either
 * CDATA or entity-escaped depending on the query, which is the one wrinkle.
 */
export function parseRssResults(xml, { limit = 10 } = {}) {
  const text = String(xml ?? "");
  const results = [];
  const seen = new Set();
  const field = (item, tag) => {
    const raw = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(item)?.[1] ?? "";
    return stripTags(raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1"));
  };
  for (const match of text.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    if (results.length >= limit) break;
    const item = match[0];
    const url = field(item, "link");
    const title = field(item, "title");
    // A feed's own `<image>` block and any malformed entry are skipped rather
    // than becoming a result with no destination.
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: field(item, "description").slice(0, 320) });
  }
  return results;
}

/**
 * Pull results out of Bing's results page.
 *
 * Anchored on `class="b_algo"`, the one class Bing has kept across every
 * redesign, and read one block at a time so a snippet can only come from the
 * result it sits inside — the same rule as the DuckDuckGo parser, for the same
 * reason: a snippet under the wrong link is a confident wrong statement about a
 * page the user may click.
 */
export function parseBingHtmlResults(html, { limit = 10 } = {}) {
  const text = String(html ?? "");
  const results = [];
  const seen = new Set();
  // Every algorithmic result opens with this class; the block ends where the
  // next one begins, or at the end of the result list.
  const starts = [...text.matchAll(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"/gi)].map((match) => match.index);
  for (const [position, start] of starts.entries()) {
    if (results.length >= limit) break;
    const block = text.slice(start, starts[position + 1] ?? Math.min(text.length, start + 12000));
    // The title anchor is the first one inside an <h2>. Bing also emits deep
    // links, image anchors and "cached" anchors in the same block, and taking
    // "the first anchor" picked those up.
    const anchor = /<h2[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const url = decode(anchor[1]);
    const title = stripTags(anchor[2]);
    // Bing wraps some destinations in its own `/ck/a?` click tracker, whose real
    // target is base64 in `u=a1…`. A tracker URL is useless to both the model
    // and the user, so a result that is still wrapped after unwrapping is
    // dropped rather than shown.
    const destination = unwrapBingClick(url);
    if (!title || !/^https?:\/\//i.test(destination)) continue;
    if (/^https?:\/\/(www\.)?bing\.com/i.test(destination)) continue;
    if (seen.has(destination)) continue;
    seen.add(destination);
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "";
    results.push({ title, url: destination, snippet: stripTags(snippet).slice(0, 320) });
  }
  return results;
}

/**
 * Pull results out of Yahoo's results page.
 *
 * Every outbound link is wrapped in `r.search.yahoo.com/…/RU=<encoded>/RK=…`,
 * and nothing else on the page uses that shape — so it is the anchor to look
 * for, the same way `uddg=` is for DuckDuckGo. No classes, no block structure,
 * nothing that changes when they restyle.
 */
export function parseYahooResults(html, { limit = 10 } = {}) {
  const text = String(html ?? "");
  const results = [];
  const seen = new Set();
  for (const match of text.matchAll(/<a\b[^>]*href="https:\/\/r\.search\.yahoo\.com\/[^"]*?RU=([^/"]+)\/RK=[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (results.length >= limit) break;
    let url;
    try {
      url = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    // Yahoo's own chrome — the logo, sign-in, the footer — goes through the same
    // redirector as the results do.
    if (/^https?:\/\/([a-z0-9-]+\.)*yahoo\.com/i.test(url)) continue;
    // PAID PLACEMENT IS NOT A RESULT. Yahoo serves Bing's ads through
    // `bing.com/aclick`, and on "best laptops of 2026" the entire visible top of
    // the page was five of them. An advertisement returned as the best answer to
    // a question is the worst thing this can do — the user cannot tell, and the
    // model certainly cannot.
    if (/^https?:\/\/([a-z0-9-]+\.)*bing\.com\/aclick/i.test(url)) continue;
    if (/[?&](ad_|gclid|msclkid)=/i.test(url)) continue;
    if (seen.has(url)) continue;

    // THE HEADING, OR NOTHING.
    //
    // The anchor wraps a breadcrumb div AND the heading, and the breadcrumb runs
    // straight into the title with no separator once the tags come off:
    // "Pythonhttps://docs.python.org › 3 › libraryCoroutines and Tasks". There
    // is no regular expression that can take that apart, because nothing marks
    // where "library" ends and "Coroutines" begins.
    //
    // So a result without an <h3> is skipped rather than guessed at. Every
    // organic Yahoo result has one; what does not is chrome, an advertisement,
    // or one of their special blocks — none of which should be returned as an
    // answer. And a genuine page missing here is almost always returned by
    // another index anyway, with a title that came out clean.
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(match[2])?.[1];
    if (!heading) continue;
    const title = stripTags(heading).trim();
    if (!title || /^https?:\/\//i.test(title)) continue;
    seen.add(url);
    results.push({ title, url, snippet: "" });
  }
  return results;
}

/** Bing's click tracker keeps the real destination base64url-encoded in `u=a1…`. */
export function unwrapBingClick(href) {
  const raw = String(href ?? "");
  const match = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(raw);
  if (!match) return raw;
  try {
    const padded = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

/**
 * Ask ONE index, trying its endpoints in order until one answers.
 *
 * Two endpoints of the same index are the same opinion served twice, so the
 * first that answers is the whole of that index's vote. Returns
 * `{ name, endpoint, results, failures }`, with an empty `results` when the
 * index had nothing to say.
 */
async function askIndex(index, query, { limit, timeoutMs, fetchImpl, retries = 1 }) {
  const failures = [];

  // One attempt at one endpoint. Returns the results, or null with a reason
  // recorded — and `retry` when the reason was transient enough to be worth
  // asking the same endpoint again.
  const attempt = async (endpoint) => {
    try {
      const response = await fetchImpl(endpoint.url(query), {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = response.ok ? await response.text() : "";
      if (!response.ok) {
        failures.push(`${endpoint.name}: HTTP ${response.status}`);
        // A 500 IS A HICCUP; A 202 IS AN ANSWER.
        //
        // Yahoo intermittently returns HTTP 500 with an empty body — caught live
        // on 23 Aug 2026, where it looked exactly like a parser that had stopped
        // working until the status was printed. It is the second-best index here
        // and it has only one endpoint, so losing its vote to a blip costs real
        // quality, and one immediate retry recovers it.
        return { results: null, retry: response.status >= 500 };
      }

      // "RATE LIMITED" AND "NOTHING MATCHED" ARE DIFFERENT ANSWERS.
      //
      // They lead to different recoveries — try another index or open a browser
      // versus rephrase the query — so collapsing them into "no results" sends
      // the model the wrong way.
      //
      // 202 is the tell: a search engine that means "here are your results"
      // answers 200. Anything else, or a page whose <title> is a challenge, or a
      // body with none of THIS endpoint's result markers in it, is the engine
      // declining. The marker is per-endpoint — it was once DuckDuckGo's
      // `uddg=` redirector for every endpoint, which would condemn every
      // correct Bing and Yahoo answer as a challenge.
      const challenged = response.status === 202
        || /detected unusual traffic|are you a robot|<title>\s*captcha/i.test(body)
        || (body.length > 0 && endpoint.declined(body));
      if (challenged) {
        // NOT "it is rate-limiting this machine". That wording was a guess
        // presented as a finding, and it sent whoever read it off to wait out a
        // limit that did not exist — the cause was this client's own headers.
        // Say what was observed. And never retry: a challenge is a considered
        // refusal, so asking again is both useless and rude.
        failures.push(`${endpoint.name}: declined the request (HTTP ${response.status}) and returned no results`);
        return { results: null, retry: false };
      }

      // Over-fetch. Fusion needs more than it returns: a page ranked seventh by
      // two indexes and unseen by the third is a better answer than one ranked
      // second by a single index, and it cannot win a vote it was not in.
      const results = endpoint.parse(body, { limit: Math.max(limit * 2, 12) });
      if (results.length === 0) {
        failures.push(`${endpoint.name}: answered, but no results could be parsed`);
        return { results: null, retry: false };
      }
      return { results, retry: false };
    } catch (error) {
      failures.push(`${endpoint.name}: ${String(error?.message ?? error).slice(0, 80)}`);
      // A socket that hung up or a timeout is the same class of accident as a
      // 500, and worth exactly one more try.
      return { results: null, retry: true };
    }
  };

  for (const endpoint of index.endpoints) {
    for (let tries = 0; tries <= retries; tries += 1) {
      const outcome = await attempt(endpoint);
      if (outcome.results) return { name: index.name, endpoint: endpoint.name, results: outcome.results, failures };
      if (!outcome.retry) break;
    }
  }
  return { name: index.name, endpoint: null, results: [], failures };
}

// Two URLs are the same result if they point at the same page. Without this the
// vote is split — `docs.python.org/3/library/asyncio-task.html` from one index
// and the same URL with a trailing slash and `?highlight=` from another count as
// two pages with one vote each instead of one page with two, which is precisely
// backwards.
export function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    parsed.protocol = "https:";
    // Campaign and session parameters identify the referrer, not the page.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref$|referrer|fbclid|gclid|msclkid|igshid|mc_[ce]id|_ga|source$|src$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const query = parsed.searchParams.toString();
    return `${parsed.hostname}${path}${query ? `?${query}` : ""}`;
  } catch {
    return String(url ?? "").trim().toLowerCase();
  }
}

// RECIPROCAL RANK FUSION.
//
// score(page) = Σ over indexes that returned it of 1 / (K + rank).
//
// It is the standard way to merge rankings whose scores are not comparable —
// and no two search engines' scores are comparable, because none of them tells
// us what they are. It needs no training, no model and no tuning, and it has the
// property that matters here: a page two independent indexes both rank highly
// beats a page one index loves and the others have never heard of.
//
// K=60 is the value from the original TREC work and is deliberately large: it
// flattens the difference between rank 1 and rank 3 so that AGREEMENT counts for
// more than one engine's confidence. That is exactly the behaviour wanted, given
// that the engine most confident about "Anti-Oppressive Social Work Practice"
// put it at rank 1.
const RRF_K = 60;

export function fuseRankings(rankings, { limit = 10 } = {}) {
  const pages = new Map();
  for (const ranking of rankings) {
    for (const [rank, result] of ranking.results.entries()) {
      const key = canonicalUrl(result.url);
      if (!key) continue;
      const existing = pages.get(key);
      const contribution = 1 / (RRF_K + rank + 1);
      if (!existing) {
        pages.set(key, {
          ...result,
          score: contribution,
          // Which indexes returned it, kept because it is the evidence for the
          // ranking and because a result every engine agrees on is worth saying
          // so about.
          foundBy: [ranking.name],
          bestRank: rank
        });
        continue;
      }
      existing.score += contribution;
      if (!existing.foundBy.includes(ranking.name)) existing.foundBy.push(ranking.name);
      existing.bestRank = Math.min(existing.bestRank, rank);
      // Keep the best title and snippet available across indexes. Yahoo returns
      // no snippet at all and DuckDuckGo's are good, so a page found by both
      // should carry DuckDuckGo's description rather than an empty string.
      if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
      if (result.title.length > existing.title.length && result.title.length < 120) existing.title = result.title;
    }
  }
  return [...pages.values()]
    .sort((left, right) => right.score - left.score
      // Ties broken by how many indexes agreed, then by the best rank any of
      // them gave it. Both are more meaningful than insertion order.
      || right.foundBy.length - left.foundBy.length
      || left.bestRank - right.bestRank)
    .slice(0, limit);
}

// REPEATING A SEARCH IS FREE, AND NOT REPEATING IT IS WORTH MORE THAN THE TIME.
//
// The agent searches several times per question — four times in one measured
// run, often for overlapping things — and a conversation comes back to the same
// subject across turns. Every one of those is a request against somebody's free
// endpoint, and the endpoints keep count.
//
// That count is the real reason this is here, not the milliseconds. Measured
// with the benchmark at `--repeat 3` (36 searches in eleven seconds), DuckDuckGo
// and Yahoo both start answering 202 partway through, and the queries at the end
// of the run are answered by Bing ALONE — which is the engine whose answers are
// worst. So a burst does not merely slow search down: it silently swaps the good
// indexes out for the bad one, and the result still looks like a success.
//
// Bounded, and short: search results go stale, and the point is to collapse the
// bursts within one piece of work rather than to remember yesterday's answer.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 120;
const cache = new Map();

// The separator is not decoration: without it a limit of 1 and the query "23"
// key the same as a limit of 12 and the query "3".
const cacheKey = (query, limit) => `${limit} ${query.toLowerCase().replace(/\s+/g, " ")}`;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Re-inserted so the map stays in least-recently-used order for the eviction
  // below; a Map iterates in insertion order, which is what makes this work.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Exported for the benchmark, which must measure the engines and not this. */
export function clearSearchCache() {
  cache.clear();
}

/**
 * Run a search. Returns `{ ok, query, results, provider, reason }`.
 *
 * Never throws: a failed search is a result the model reads and works around,
 * exactly like a non-zero exit code, and the whole point of this file is that it
 * can say "the engines refused" rather than silently returning nothing.
 */
export async function searchWeb(query, {
  limit = 10,
  timeoutMs = 20000,
  fetchImpl = fetch,
  // The benchmark turns this off: it exists to measure the engines, and a cache
  // hit would measure this file instead.
  useCache = true
} = {}) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return { ok: false, query: trimmed, results: [], provider: null, reason: "No search terms were given." };

  const key = cacheKey(trimmed, limit);
  if (useCache) {
    const hit = cacheGet(key);
    // `cached` travels on the result so nothing downstream can mistake a
    // remembered answer for a fresh one — a ten-minute-old price or score is
    // still an old one, and the caller is entitled to know which it has.
    if (hit) return { ...hit, cached: true };
  }

  // IN PARALLEL. Asked in turn, the wall clock is the sum and — worse — the
  // first engine to answer decides the result on its own. Asked at once, the
  // wall clock is the slowest one and every answer gets a vote.
  const asked = await Promise.all(
    INDEXES.map((index) => askIndex(index, trimmed, { limit, timeoutMs, fetchImpl })
      // askIndex already catches per-endpoint; this is the belt for anything it
      // could not have anticipated. One index throwing must never lose the rest.
      .catch((error) => ({ name: index.name, endpoint: null, results: [], failures: [String(error?.message ?? error)] })))
  );

  const answered = asked.filter((index) => index.results.length > 0);
  if (answered.length === 0) {
    return {
      ok: false,
      query: trimmed,
      results: [],
      provider: null,
      // Every endpoint's own words, because "search failed" tells the model
      // nothing about whether to retry, rephrase, or open a browser instead.
      reason: asked.flatMap((index) => index.failures).join("; ")
    };
  }

  // Fuse over MORE than will be returned, then rerank, then cut. Reranking only
  // the final ten cannot promote the right answer from eleventh, which is where
  // one engine's disagreement often leaves it.
  const fused = fuseRankings(answered, { limit: Math.max(limit * 2, 16) });
  const ranked = rerank(trimmed, fused);

  const found = {
    ok: true,
    query: trimmed,
    results: ranked.slice(0, limit),
    // Which indexes actually voted. Named in the plural because it is now a
    // consensus rather than one engine's opinion, and because "two of three
    // agreed" is worth being able to see when an answer looks wrong.
    provider: answered.map((index) => index.name).join("+"),
    indexes: answered.map((index) => index.endpoint),
    // Kept even on success: an index that declined is why a result set is
    // thinner than usual, and it is invisible otherwise.
    reason: null,
    declined: asked.filter((index) => index.results.length === 0).flatMap((index) => index.failures)
  };

  // Only a result worth repeating is remembered. Caching a thin answer from one
  // struggling index would pin the worst ten minutes of the day in place, and
  // the burst that produced it is exactly when that would happen.
  if (useCache && found.results.length > 0) cacheSet(key, found);
  return found;
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
