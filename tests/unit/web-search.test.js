// Searching used to mean driving the controlled browser. Measured live on
// 22 Aug 2026 on a request to find internships: Google answered with a CAPTCHA,
// then four more page loads got the signed-out LinkedIn marketing page — six
// navigations and tens of thousands of tokens of page chrome, for ten links.
//
// These are against STUBBED responses, so the suite never depends on
// DuckDuckGo being up or on this machine having a network. The markup below is
// copied from the real endpoints, including the details that broke the first
// two versions of the parser.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBingHtmlResults,
  parseResults,
  parseRssResults,
  renderResults,
  searchWeb,
  unwrapBingClick,
  unwrapRedirect
} from "../../packages/fast-agent/src/web-search.js";

const redirect = (url) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc123`;

// The html endpoint. Note class BEFORE href, and a second image-only anchor per
// result — that second anchor is what shifted every snippet by one row when
// snippets were zipped on by index.
const HTML_BODY = `
<div class="results">
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${redirect("https://internshala.com/internships/")}">Machine Learning Internships &amp; Jobs</a>
    </h2>
    <div class="result__extras">
      <span class="result__icon"><a rel="nofollow" href="${redirect("https://internshala.com/internships/")}"><img class="result__icon__img" width="16"></a></span>
    </div>
    <a class="result__snippet" href="#">Apply for 130+ machine learning internships on Internshala.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${redirect("https://in.linkedin.com/jobs/ml-internship-jobs")}">ML Internship Jobs in India</a>
    </h2>
    <a class="result__snippet" href="#">Today's top 1,000+ Machine Learning Internship jobs in India.</a>
  </div>
</div>`;

// The lite endpoint. `class='result-link'` in SINGLE quotes is what made the
// first parser silently match nothing here, so every lite search fell through.
const LITE_BODY = `
<table>
  <tr><td>1.&nbsp;</td><td>
    <a rel="nofollow" href="${redirect("https://in.prosple.com/ml-internships-india")}" class='result-link'>Machine Learning Internships in India</a>
  </td></tr>
  <tr><td class='result-snippet'>Find open Machine Learning Internships in India from top employers.</td></tr>
  <tr><td>2.&nbsp;</td><td>
    <a rel="nofollow" href="${redirect("https://internshala.com/internships/")}" class='result-link'>Internshala Machine Learning</a>
  </td></tr>
  <tr><td class='result-snippet'>130 machine learning internships.</td></tr>
</table>`;

test("the redirector is unwrapped to the page the user would actually visit", () => {
  assert.equal(unwrapRedirect(redirect("https://example.com/a?b=1")), "https://example.com/a?b=1");
  assert.equal(unwrapRedirect("//example.com/x"), "https://example.com/x");
  assert.equal(unwrapRedirect("https://plain.example/"), "https://plain.example/");
});

test("the html endpoint parses, and titles do not swallow the URL and snippet", () => {
  const results = parseResults(HTML_BODY);
  assert.equal(results.length, 2);
  // The first parser matched a whole result BLOCK with a trailing lookahead,
  // which backtracks: the lazy title group grew past its own </a> so every
  // title came back with the URL and snippet glued on.
  assert.equal(results[0].title, "Machine Learning Internships & Jobs");
  assert.equal(results[0].url, "https://internshala.com/internships/");
  assert.ok(!results[0].title.includes("internshala.com"), "the title swallowed the URL again");
  assert.ok(!results[0].title.includes("Apply for"), "the title swallowed the snippet again");
});

test("the lite endpoint parses despite single-quoted class attributes", () => {
  const results = parseResults(LITE_BODY);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Machine Learning Internships in India");
  assert.equal(results[1].url, "https://internshala.com/internships/");
});

test("each snippet belongs to its own result", () => {
  const results = parseResults(HTML_BODY);
  assert.match(results[0].snippet, /Internshala/);
  assert.match(results[1].snippet, /1,000\+/);
  // A snippet under the wrong result is worse than none: it is a confident,
  // specific, wrong statement about a link the user may click.
  assert.ok(!results[1].snippet.includes("Apply for 130"), "the snippets are shifted by one again");
});

test("an image-only anchor does not become a result", () => {
  const results = parseResults(HTML_BODY);
  assert.equal(results.length, 2, "the icon anchor was counted as a third result");
});

test("duplicate URLs collapse", () => {
  const results = parseResults(HTML_BODY + HTML_BODY);
  assert.equal(results.length, 2);
});

test("the limit is honoured", () => {
  assert.equal(parseResults(HTML_BODY, { limit: 1 }).length, 1);
});

// ---- Bing, which is what actually answers ------------------------------------
//
// On 23 Aug 2026 BOTH DuckDuckGo endpoints answered every query from this
// machine with HTTP 202 and a challenge page, so search was down completely.
// One operator is not a capability; these cover the second one.

// Copied from the real feed, including the `<image>` block — which carries a
// `<title>` and a `<link>` of its own and became an eleventh "result" the first
// time this was parsed by matching tags rather than items.
const RSS_BODY = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
  <title>Bing: best laptop 2026</title>
  <link>http://www.bing.com:80/search?q=best+laptop+2026</link>
  <image><url>http://www.bing.com:80/s/a/rsslogo.gif</url><title>best laptop 2026</title><link>http://www.bing.com:80/search?q=best+laptop+2026</link></image>
  <item><title>Best Laptops 2026: benchmarked picks</title><link>https://www.tomshardware.com/laptops/best-laptops</link><description>Our expert reviewers spend hours testing &amp; comparing products.</description></item>
  <item><title><![CDATA[Best laptops 2026: Premium, budget & gaming]]></title><link>https://www.pcworld.com/best-laptops</link><description><![CDATA[Picks for every budget.]]></description></item>
</channel></rss>`;

// Bing's results page. The title anchor is inside the <h2>; the other anchors in
// the block are deep links and a favicon, and taking "the first anchor in the
// block" picked those up instead.
const BING_HTML_BODY = `
<ol id="b_results">
  <li class="b_algo" data-id iid=SERP.5346>
    <div class="tptt"><a href="https://www.tomshardware.com"><img class="rms_img"></a></div>
    <h2><a href="https://www.tomshardware.com/laptops/best-laptops" h="ID=SERP,5000.1">Best Laptops 2026: benchmarked picks</a></h2>
    <p class="b_lineclamp2">Our expert reviewers spend hours testing and comparing products.</p>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly93d3cucGN3b3JsZC5jb20vYmVzdC1sYXB0b3Bz&amp;ntb=1">Best laptops 2026 &amp; buying advice</a></h2>
    <p>Picks for every budget.</p>
  </li>
</ol>`;

test("an RSS feed of results parses to titles, URLs and snippets", () => {
  const results = parseRssResults(RSS_BODY);
  assert.equal(results.length, 2, "the channel's own <image> block became a result again");
  assert.equal(results[0].title, "Best Laptops 2026: benchmarked picks");
  assert.equal(results[0].url, "https://www.tomshardware.com/laptops/best-laptops");
  assert.match(results[0].snippet, /testing & comparing/, "entities were left escaped");
  // Bing switches between escaped text and CDATA depending on the query.
  assert.equal(results[1].title, "Best laptops 2026: Premium, budget & gaming");
  assert.equal(results[1].snippet, "Picks for every budget.");
});

test("Bing's results page parses, and the title anchor is the one in the heading", () => {
  const results = parseBingHtmlResults(BING_HTML_BODY);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Best Laptops 2026: benchmarked picks");
  assert.equal(results[0].url, "https://www.tomshardware.com/laptops/best-laptops");
  assert.match(results[0].snippet, /expert reviewers/);
});

test("Bing's click tracker is unwrapped to the page the user would actually visit", () => {
  // A tracker URL is useless to both the model and the user: it names bing.com,
  // so nothing can be reasoned about the source, and it expires.
  assert.equal(parseBingHtmlResults(BING_HTML_BODY)[1].url, "https://www.pcworld.com/best-laptops");
  assert.equal(unwrapBingClick("https://plain.example/x"), "https://plain.example/x");
});

// ---- the network behaviour, stubbed ----------------------------------------

// Routed by hostname, because the endpoint list now spans two operators and
// "everything that is not lite" is no longer one thing.
const stub = (bodies) => async (url) => {
  const target = String(url);
  const which = target.includes("bing.com") ? (bodies.bing === undefined ? "html" : "bing")
    : target.includes("lite.duckduckgo") ? "lite"
    : "html";
  const entry = bodies[which];
  if (entry instanceof Error) throw entry;
  return { ok: entry.status === undefined || entry.status === 200, status: entry.status ?? 200, text: async () => entry.body ?? "" };
};

test("one engine declining is not search being down", async () => {
  // The failure that made a second operator necessary: both DuckDuckGo
  // endpoints answering 202 meant search reported itself down for every query
  // on the machine, for a day.
  const found = await searchWeb("best laptop", {
    fetchImpl: async (url) => (String(url).includes("duckduckgo")
      ? { ok: true, status: 202, text: async () => "<html><body>verify</body></html>" }
      : { ok: true, status: 200, text: async () => RSS_BODY })
  });
  assert.equal(found.ok, true);
  assert.equal(found.provider, "bing-rss");
  assert.equal(found.results.length, 2);
});

test("a browser's whole header set is sent, because that is what the 202 was about", async () => {
  // The 202 challenge was this client's own request shape, not a rate limit: a
  // user-agent claiming to be Chrome with none of Chrome's other headers beside
  // it is a contradiction any bot check can read. Sending the full set turned
  // both endpoints from 202-and-nothing into 200-with-results, measured live.
  let sent = null;
  await searchWeb("best laptop", {
    fetchImpl: async (url, init) => {
      sent = init.headers;
      return { ok: true, status: 200, text: async () => LITE_BODY };
    }
  });
  assert.match(sent["user-agent"], /Chrome\/124/);
  for (const header of ["sec-ch-ua", "sec-fetch-mode", "sec-fetch-dest", "upgrade-insecure-requests"]) {
    assert.ok(sent[header], `${header} was dropped — this is exactly what got us refused`);
  }
});

test("a correct Bing answer is not condemned as a challenge", async () => {
  // The challenge check used to look for DuckDuckGo's `uddg=` redirector in
  // EVERY body, which is absent from every valid Bing response — so switching
  // engines without making that marker per-endpoint would have rejected every
  // result the new endpoints returned.
  const found = await searchWeb("best laptop", {
    fetchImpl: stub({ bing: { body: BING_HTML_BODY }, lite: { body: LITE_BODY }, html: { body: HTML_BODY } })
  });
  assert.equal(found.ok, true);
  assert.ok(found.results.length > 0);
});

test("a search returns results and names which engine answered", async () => {
  const found = await searchWeb("ml internships", { fetchImpl: stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY } }) });
  assert.equal(found.ok, true);
  assert.equal(found.provider, "duckduckgo-lite", "lite is tried first — same results, far less markup");
  assert.equal(found.results.length, 2);
});

test("HTTP 202 is a challenge, not an answer, and says so", async () => {
  // A challenge page carries no results and none of the words a CAPTCHA check
  // looks for. Reported as "no results" it sends the model off to rephrase a
  // query that was never the problem.
  const found = await searchWeb("ml internships", {
    fetchImpl: async () => ({ ok: true, status: 202, text: async () => "<html><head><title>DuckDuckGo</title></head><body>nothing here</body></html>" })
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /declined the request \(HTTP 202\)/);
  assert.ok(!/no results could be parsed/.test(found.reason),
    "a refusal reported as an empty result set sends the model the wrong way");
  // And it must not name a CAUSE it did not observe. This said "it is
  // rate-limiting this machine" for a fortnight; the real cause was our own
  // headers, and that sentence sent whoever read it off to wait out a limit
  // that did not exist.
  assert.ok(!/rate.?limit/i.test(found.reason), "a guess is being reported as a finding again");
});

test("a body with no result links at all is a challenge, not an empty result set", async () => {
  const found = await searchWeb("ml internships", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html><body><h1>Please verify</h1></body></html>" })
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /declined the request/);
});

test("a CAPTCHA is not 'no results' — it falls through and says so", async () => {
  const found = await searchWeb("ml internships", {
    fetchImpl: stub({
      lite: { body: "Our systems have detected unusual traffic from your computer network" },
      html: { body: HTML_BODY }
    })
  });
  assert.equal(found.ok, true, "it should have fallen through to the other endpoint");
  assert.equal(found.provider, "duckduckgo-html");
});

test("when every endpoint fails the reason names each one", async () => {
  const found = await searchWeb("ml internships", {
    fetchImpl: stub({ lite: { status: 429, body: "" }, html: new Error("socket hang up") })
  });
  assert.equal(found.ok, false);
  assert.equal(found.results.length, 0);
  // "search failed" tells the model nothing about whether to retry, rephrase,
  // or open a browser instead.
  assert.match(found.reason, /429/);
  assert.match(found.reason, /socket hang up/);
});

test("an empty query is refused without a request", async () => {
  let called = false;
  const found = await searchWeb("   ", { fetchImpl: async () => { called = true; } });
  assert.equal(found.ok, false);
  assert.equal(called, false, "an empty search must not reach the network");
});

test("searchWeb never throws, whatever the transport does", async () => {
  const found = await searchWeb("x", { fetchImpl: async () => { throw new Error("DNS exploded"); } });
  assert.equal(found.ok, false);
  assert.match(found.reason, /DNS exploded/);
});

test("results render with the title, the URL and the snippet on separate lines", () => {
  const text = renderResults({ query: "ml", provider: "duckduckgo-lite", results: parseResults(LITE_BODY) });
  assert.match(text, /2 results for "ml"/);
  assert.match(text, /1\. Machine Learning Internships in India/);
  assert.match(text, /https:\/\/in\.prosple\.com/);
});
