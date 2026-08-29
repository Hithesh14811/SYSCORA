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
  BROWSER_HEADERS,
  canonicalUrl,
  clearSearchCache,
  fuseRankings,
  parseBingHtmlResults,
  parseResults,
  parseRssResults,
  parseYahooResults,
  renderBatch,
  searchMany,
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

// ---- Yahoo ------------------------------------------------------------------
//
// A third index, and the one that rescues the queries Bing destroys. Measured
// 23 Aug 2026: asked "python asyncio TaskGroup example" Bing returned
// python.org's home page while Yahoo returned SuperFastPython and
// docs.python.org; asked about Windows reopening apps, Bing returned the
// dictionary definition of "stop" and Yahoo returned How-To Geek.

// Every outbound link goes through `r.search.yahoo.com/…/RU=<encoded>/RK=…`,
// including Yahoo's own chrome and Bing's advertising. The block below carries
// one of each, because all three had to be told apart.
const YAHOO_BODY = `
<a href="https://r.search.yahoo.com/_ylt=Aw/RV=2/RE=1/RO=10/RU=https%3a%2f%2fwww.yahoo.com/RK=2/RS=x-" id="logo">Yahoo</a>
<div class="dd lst algo algo-sr">
  <div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=Aw/RV=2/RE=1/RO=10/RU=https%3a%2f%2fsuperfastpython.com%2fasyncio-taskgroup%2f/RK=2/RS=y-">
    <div><span><span>Super Fast Python</span>https://superfastpython.com &rsaquo; asyncio-taskgroup</span></div>
    <h3 class="title">How to use asyncio.TaskGroup</h3></a></div>
</div>
<div class="dd lst algo">
  <a href="https://r.search.yahoo.com/_ylt=Aw/RV=2/RE=1/RO=10/RU=https%3a%2f%2fwww.bing.com%2faclick%3fld%3de8a8/RK=2/RS=z-">
    <h3 class="title">Laptops - Amazing Customer Reviews</h3></a>
</div>
<div class="dd lst algo">
  <a href="https://r.search.yahoo.com/_ylt=Aw/RV=2/RE=1/RO=10/RU=https%3a%2f%2fdocs.python.org%2f3%2flibrary%2fasyncio-task.html/RK=2/RS=w-">
    <span>Python</span>https://docs.python.org &rsaquo; 3 &rsaquo; library</a>
</div>`;

test("Yahoo's redirector is unwrapped, and its own chrome is not a result", () => {
  const results = parseYahooResults(YAHOO_BODY);
  const urls = results.map((result) => result.url);
  assert.ok(!urls.some((url) => /yahoo\.com/.test(url)), "the Yahoo logo link became a result");
  assert.ok(urls.includes("https://superfastpython.com/asyncio-taskgroup/"));
});

test("paid placement is not a result", () => {
  // Yahoo serves Bing's ads through the same redirector as its results. On
  // "best laptops of 2026" the entire visible top of the page was five of them.
  // An advertisement returned as the best answer is the worst thing this can do:
  // the user cannot tell, and the model certainly cannot.
  const urls = parseYahooResults(YAHOO_BODY).map((result) => result.url);
  assert.ok(!urls.some((url) => /aclick/.test(url)), "an advertisement was returned as a search result");
});

test("a Yahoo title is the heading, and a result without one is skipped", () => {
  const results = parseYahooResults(YAHOO_BODY);
  const found = results.find((result) => /superfastpython/.test(result.url));
  assert.equal(found.title, "How to use asyncio.TaskGroup",
    "the breadcrumb was glued onto the front of the title again");

  // The breadcrumb runs straight into the title once the tags come off —
  // "Pythonhttps://docs.python.org › 3 › libraryCoroutines and Tasks" — and
  // nothing marks where the path ends and the title begins. Guessing produces a
  // title with a URL inside it, which is worse than not returning the result:
  // another index almost always has the same page with a clean title.
  assert.ok(!results.some((result) => /docs\.python\.org/.test(result.url)),
    "a result with no heading was returned, so its title is a guess");
  for (const result of results) {
    assert.ok(!/https?:\/\//.test(result.title), `a title still has a URL in it: ${result.title}`);
  }
});

// ---- fusing what the indexes said -------------------------------------------

test("two URLs that are the same page are one vote, not two", () => {
  // Split by a trailing slash and a campaign parameter, a page two indexes agree
  // on becomes two pages with one vote each — which is precisely backwards.
  assert.equal(canonicalUrl("https://docs.python.org/3/library/asyncio-task.html"),
    canonicalUrl("http://www.docs.python.org/3/library/asyncio-task.html/?utm_source=x#tasks"));
  // Different pages must stay different: this is not a hostname comparison.
  assert.notEqual(canonicalUrl("https://a.example/one"), canonicalUrl("https://a.example/two"));
  assert.notEqual(canonicalUrl("https://a.example/p?id=1"), canonicalUrl("https://a.example/p?id=2"));
});

test("agreement between independent indexes beats one index's confidence", () => {
  // THE WHOLE POINT. Bing put the dictionary definition of "best" first for
  // "best laptops of 2026"; nobody else returned it at all. PCMag was third and
  // second for two other indexes. Rank alone cannot separate those — agreement
  // can, and it needs no blocklist and nothing to maintain.
  const fused = fuseRankings([
    { name: "bing", results: [{ title: "BEST Definition", url: "https://www.merriam-webster.com/dictionary/best", snippet: "" }] },
    { name: "duckduckgo", results: [
      { title: "x", url: "https://a.example/1", snippet: "" },
      { title: "y", url: "https://b.example/2", snippet: "" },
      { title: "PCMag laptops", url: "https://www.pcmag.com/picks/the-best-laptops", snippet: "" }
    ] },
    { name: "yahoo", results: [
      { title: "z", url: "https://c.example/3", snippet: "" },
      { title: "PCMag laptops", url: "https://www.pcmag.com/picks/the-best-laptops", snippet: "" }
    ] }
  ]);
  assert.match(fused[0].url, /pcmag/, "a page two indexes agree on lost to a page one index loved");
  assert.deepEqual(fused[0].foundBy.sort(), ["duckduckgo", "yahoo"]);
});

test("a fused result keeps the best description any index gave it", () => {
  // Yahoo returns no snippet at all. A page it shares with DuckDuckGo must carry
  // DuckDuckGo's description rather than an empty string.
  const fused = fuseRankings([
    { name: "yahoo", results: [{ title: "Short", url: "https://a.example/p", snippet: "" }] },
    { name: "duckduckgo", results: [{ title: "A longer, more useful title", url: "https://a.example/p/", snippet: "What the page says." }] }
  ]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].snippet, "What the page says.");
  assert.equal(fused[0].title, "A longer, more useful title");
});

// ---- the network behaviour, stubbed ------------------------------------------

// Routed by hostname, because the indexes now span three operators. `useCache`
// is off in every one of these: a cache shared between tests makes them pass or
// fail depending on the order they happen to run in.
const stub = (bodies) => async (url) => {
  const target = String(url);
  const which = target.includes("yahoo.com") ? "yahoo"
    : target.includes("bing.com") ? "bing"
      : target.includes("lite.duckduckgo") ? "lite"
        : "html";
  const entry = bodies[which] ?? { body: "" };
  if (entry instanceof Error) throw entry;
  return { ok: entry.status === undefined || entry.status === 200, status: entry.status ?? 200, text: async () => entry.body ?? "" };
};

const search = (query, options) => searchWeb(query, { useCache: false, ...options });

test("every index is asked, and the answer names all of them that voted", async () => {
  const found = await search("best laptop", {
    fetchImpl: stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY }, bing: { body: RSS_BODY }, yahoo: { body: YAHOO_BODY } })
  });
  assert.equal(found.ok, true);
  assert.equal(found.provider, "duckduckgo+yahoo+bing");
});

test("the indexes are asked AT ONCE, not one after another", async () => {
  // Asked in turn, the wall clock is the sum and — much worse — the first engine
  // to answer decides the result on its own. That is how a burst that
  // rate-limits DuckDuckGo silently hands every answer to the worst index.
  let inFlight = 0;
  let peak = 0;
  await search("best laptop", {
    fetchImpl: async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => (String(url).includes("bing") ? RSS_BODY : LITE_BODY) };
    }
  });
  assert.ok(peak >= 3, `only ${peak} request(s) were in flight at once — the indexes are still asked in turn`);
});

test("one index declining is not search being down", async () => {
  // The failure that made a second operator necessary: both DuckDuckGo endpoints
  // answering 202 meant search reported itself down for every query on the
  // machine, for a day.
  const found = await search("best laptop", {
    fetchImpl: async (url) => (String(url).includes("duckduckgo")
      ? { ok: true, status: 202, text: async () => "<html><body>verify</body></html>" }
      : { ok: true, status: 200, text: async () => (String(url).includes("yahoo") ? YAHOO_BODY : RSS_BODY) })
  });
  assert.equal(found.ok, true);
  assert.ok(found.results.length > 0);
  assert.ok(!found.provider.includes("duckduckgo"));
  // And it says which one went quiet: an index that declined is why a result set
  // is thinner than usual, and it is invisible otherwise.
  assert.match(found.declined.join(" "), /HTTP 202/);
});

test("a browser's whole header set is sent, because that is what the 202 was about", async () => {
  // The 202 challenge was this client's own request shape, not a rate limit: a
  // user-agent claiming to be Chrome with none of Chrome's other headers beside
  // it is a contradiction any bot check can read. Sending the full set turned
  // both endpoints from 202-and-nothing into 200-with-results, measured live.
  let sent = null;
  await search("best laptop", {
    fetchImpl: async (url, init) => {
      sent = init.headers;
      return { ok: true, status: 200, text: async () => LITE_BODY };
    }
  });
  // NOT A SPECIFIC VERSION, AND IT USED TO BE ONE.
  //
  // This asserted `/Chrome\/124/` — the exact string DuckDuckGo began answering
  // with HTTP 403 on 29 Aug 2026. So the test written to protect the header set
  // was pinning the value that broke it, and would have failed the fix rather
  // than caught the fault. A test that hard-codes something which must age
  // enforces the bug it was meant to prevent.
  //
  // The version is owned by the two tests at the end of this file, which check
  // that the user-agent and the client hints agree and that the number has not
  // been left to rot. What belongs HERE is the thing this test is named for: a
  // Chrome is claimed, and the rest of Chrome's headers are beside it.
  assert.match(sent["user-agent"], /Chrome\/\d+\./);
  for (const header of ["sec-ch-ua", "sec-fetch-mode", "sec-fetch-dest", "upgrade-insecure-requests"]) {
    assert.ok(sent[header], `${header} was dropped — this is exactly what got us refused`);
  }
});

test("a correct answer from a new index is not condemned as a challenge", async () => {
  // The challenge check used to look for DuckDuckGo's `uddg=` redirector in
  // EVERY body, which is absent from every valid Bing and Yahoo response — so
  // adding indexes without making that marker per-endpoint would have rejected
  // every result they returned.
  const found = await search("best laptop", { fetchImpl: stub({ bing: { body: BING_HTML_BODY }, yahoo: { body: YAHOO_BODY } }) });
  assert.equal(found.ok, true);
  assert.ok(found.results.length > 0);
});

test("HTTP 202 is a challenge, not an answer, and says so", async () => {
  // A challenge page carries no results and none of the words a CAPTCHA check
  // looks for. Reported as "no results" it sends the model off to rephrase a
  // query that was never the problem.
  const found = await search("ml internships", {
    fetchImpl: async () => ({ ok: true, status: 202, text: async () => "<html><head><title>DuckDuckGo</title></head><body>nothing here</body></html>" })
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /declined the request \(HTTP 202\)/);
  assert.ok(!/no results could be parsed/.test(found.reason),
    "a refusal reported as an empty result set sends the model the wrong way");
  // And it must not name a CAUSE it did not observe. This said "it is
  // rate-limiting this machine" for a fortnight; the real cause was our own
  // headers, and that sentence sent whoever read it off to wait out a limit that
  // did not exist.
  assert.ok(!/rate.?limit/i.test(found.reason), "a guess is being reported as a finding again");
});

test("a body with no result links at all is a challenge, not an empty result set", async () => {
  const found = await search("ml internships", {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html><body><h1>Please verify</h1></body></html>" })
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /declined the request/);
});

test("a CAPTCHA on one endpoint falls through to the other one of that index", async () => {
  const found = await search("ml internships", {
    fetchImpl: stub({
      lite: { body: "Our systems have detected unusual traffic from your computer network" },
      html: { body: HTML_BODY }
    })
  });
  assert.equal(found.ok, true, "it should have fallen through to the other endpoint");
  assert.equal(found.provider, "duckduckgo");
});

test("when every index fails the reason names each one", async () => {
  const found = await search("ml internships", {
    fetchImpl: stub({
      lite: { status: 429, body: "" },
      html: new Error("socket hang up"),
      bing: { status: 503, body: "" },
      yahoo: { status: 500, body: "" }
    })
  });
  assert.equal(found.ok, false);
  assert.equal(found.results.length, 0);
  // "search failed" tells the model nothing about whether to retry, rephrase, or
  // open a browser instead.
  assert.match(found.reason, /429/);
  assert.match(found.reason, /socket hang up/);
  assert.match(found.reason, /503/);
});

test("an empty query is refused without a request", async () => {
  let called = false;
  const found = await search("   ", { fetchImpl: async () => { called = true; } });
  assert.equal(found.ok, false);
  assert.equal(called, false, "an empty search must not reach the network");
});

test("searchWeb never throws, whatever the transport does", async () => {
  const found = await search("x", { fetchImpl: async () => { throw new Error("DNS exploded"); } });
  assert.equal(found.ok, false);
  assert.match(found.reason, /DNS exploded/);
});

// ---- the cache ---------------------------------------------------------------

test("a repeated search does not go back to the network", async () => {
  // The agent searches several times per question, often for overlapping things.
  // Measured at 36 searches in eleven seconds, DuckDuckGo and Yahoo both start
  // answering 202 partway through and the last queries are answered by Bing
  // ALONE — the worst index — while still looking like a success.
  clearSearchCache();
  let calls = 0;
  const fetchImpl = stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY }, bing: { body: RSS_BODY }, yahoo: { body: YAHOO_BODY } });
  const counted = async (url, init) => { calls += 1; return fetchImpl(url, init); };

  const first = await searchWeb("ml internships", { fetchImpl: counted });
  const afterFirst = calls;
  const second = await searchWeb("  ML   Internships ", { fetchImpl: counted });

  assert.ok(afterFirst > 0, "the first search did not reach the network at all");
  assert.equal(calls, afterFirst, "the repeated search went back to the network");
  assert.equal(second.cached, true, "a remembered answer must say that it is one");
  assert.equal(first.cached, undefined, "a fresh answer must not claim to be cached");
  assert.deepEqual(second.results.map((result) => result.url), first.results.map((result) => result.url));
  clearSearchCache();
});

test("a failed search is not remembered", async () => {
  // Caching a refusal would pin the worst ten minutes of the day in place, and a
  // burst is exactly when that would happen.
  clearSearchCache();
  let calls = 0;
  const refuse = async () => { calls += 1; return { ok: false, status: 503, text: async () => "" }; };
  const found = await searchWeb("ml internships", { fetchImpl: refuse });
  assert.equal(found.ok, false);
  const after = calls;
  await searchWeb("ml internships", { fetchImpl: refuse });
  assert.ok(calls > after, "a failed search was cached, so retrying it can never recover");
  clearSearchCache();
});

test("results render with the title, the URL and the snippet on separate lines", () => {
  const text = renderBatch([{ ok: true, query: "ml", provider: "duckduckgo", results: parseResults(LITE_BODY) }]);
  assert.match(text, /2 results for "ml"/);
  assert.match(text, /1\. Machine Learning Internships in India/);
  assert.match(text, /https:\/\/in\.prosple\.com/);
});


// THE HEADERS THAT GOT US BLOCKED, TWICE.
//
// Measured 29 Aug 2026 against lite.duckduckgo.com, one query, five header sets:
//
//   Chrome 124 + matching sec-ch-ua   403     <- what this file was sending
//   Chrome 141 UA alone               202     <- the original contradiction
//   Chrome 141 + matching sec-ch-ua   200  RESULTS
//
// Nothing reported the 403: searchWeb returned eight results and no errors,
// having silently lost both DuckDuckGo endpoints and answered from Bing alone.
// With one engine there is no consensus left, and "how to change a tyre"
// returned a percent-change calculator and a dictionary definition of "change".
//
// The version is now built from one constant so the user-agent and the client
// hints cannot drift apart -- that drift is what earns the 202, and keeping two
// string literals in step was somebody remembering to.
test("the user-agent and the client hints name the same Chrome version", () => {
  const ua = BROWSER_HEADERS["user-agent"];
  const hints = BROWSER_HEADERS["sec-ch-ua"];
  const uaVersion = /Chrome\/(\d+)\./.exec(ua)?.[1];
  assert.ok(uaVersion, `no Chrome version in the user-agent: ${ua}`);
  // Every version named in sec-ch-ua except the deliberate "Not?A_Brand" decoy,
  // which is part of the real header and carries a nonsense version on purpose.
  const hinted = [...hints.matchAll(/"([^"]+)";v="(\d+)"/g)]
    .filter(([, brand]) => !/not.?a.?brand/i.test(brand))
    .map(([, , version]) => version);
  assert.ok(hinted.length > 0, `no brand versions in sec-ch-ua: ${hints}`);
  for (const version of hinted) {
    assert.equal(
      version, uaVersion,
      `sec-ch-ua says Chrome ${version} while the user-agent says ${uaVersion} — that contradiction is what returns HTTP 202`
    );
  }
});

test("the impersonated Chrome is not an ancient one", () => {
  // Chrome 124 is what started returning 403. This does not chase the real
  // release train -- it just fails loudly if the number is left to rot again,
  // which is the actual defect: a hard-coded version nobody revisits.
  const version = Number(/Chrome\/(\d+)\./.exec(BROWSER_HEADERS["user-agent"])?.[1] ?? 0);
  assert.ok(
    version >= 140,
    `Chrome ${version} is stale; 124 was being answered with HTTP 403. Bump CHROME_VERSION in web-search.js.`
  );
});

// BATCHING, WHICH IS ABOUT MODEL TOKENS AND NOT ABOUT HTTP.
//
// See the note above searchMany in web-search.js. Prefix caching on this
// endpoint is quantised into 8,192-token blocks, so a step re-buys its tail
// block — about 4,000 tokens — before it fetches anything, while a result set
// costs about 700. Twenty searches issued one at a time is 140,000 tokens of
// ASKING, and that is exactly how a live request for fifteen internships hit its
// ceiling on 29 Aug 2026 with nothing to show for it.

test("several queries are asked at once, and come back in the order they were asked", async () => {
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push(String(url));
    return stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY }, bing: { body: RSS_BODY }, yahoo: { body: YAHOO_BODY } })(url, options);
  };
  const found = await searchMany(["first question", "second question", "third question"], { useCache: false, fetchImpl });

  assert.equal(found.length, 3);
  assert.deepEqual(found.map((one) => one.query), ["first question", "second question", "third question"]);
  for (const one of found) assert.equal(one.ok, true, one.reason ?? "");
  // Every index, for every query — the batch must not quietly ask fewer.
  assert.ok(asked.some((url) => url.includes("first+question") || url.includes("first%20question")));
  assert.ok(asked.some((url) => url.includes("third+question") || url.includes("third%20question")));
});

test("the same question twice in one batch is one request, not two", async () => {
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests += 1;
    return stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY }, bing: { body: RSS_BODY }, yahoo: { body: YAHOO_BODY } })(url, options);
  };
  // Differing only in case and spacing, which is how a model writes the same
  // question twice inside one burst.
  const found = await searchMany(["ml internships", "ML  Internships", "ml internships"], { useCache: false, fetchImpl });
  assert.equal(found.length, 1, "three spellings of one question are one search");
  const single = requests;

  requests = 0;
  await searchMany(["ml internships"], { useCache: false, fetchImpl });
  assert.equal(requests, single, "the deduplicated batch cost exactly what one query costs");
});

test("one query failing does not take the rest of the batch with it", async () => {
  // The generic `batch` tool stops at the first failure, which is right for a
  // menu path and wrong for independent research: a question nobody could
  // answer must not cancel the seven that were answered.
  const fetchImpl = async (url, options) => {
    if (String(url).includes("doomed")) throw new Error("DNS exploded");
    return stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY }, bing: { body: RSS_BODY }, yahoo: { body: YAHOO_BODY } })(url, options);
  };
  const found = await searchMany(["doomed query", "ml internships"], { useCache: false, fetchImpl });
  assert.equal(found.length, 2);
  assert.equal(found[0].ok, false);
  assert.equal(found[1].ok, true, "the second query was answered despite the first one failing");
});

test("a page several queries all return is printed once, and cross-referenced after that", async () => {
  const page = { title: "Internshala", url: "https://internshala.com/internships/", snippet: "Machine learning internships" };
  const other = { title: "Somewhere else", url: "https://example.com/jobs", snippet: "Jobs" };
  const text = renderBatch([
    { ok: true, query: "one", provider: "duckduckgo", results: [page, other] },
    { ok: true, query: "two", provider: "duckduckgo", results: [page] }
  ]);

  // The URL itself appears once. The second sighting is a reference to the
  // number the first one was given, which is what makes it cheap AND readable.
  assert.equal(text.split("https://internshala.com/internships/").length - 1, 1);
  assert.match(text, /= 1\. Internshala/);
  // Numbering runs across the whole batch, so "3" means one thing in the reply.
  assert.match(text, /2\. Somewhere else/);
});

test("a batch says which queries came back empty instead of leaving a gap", async () => {
  const text = renderBatch([
    { ok: true, query: "answered", provider: "duckduckgo", results: [{ title: "A page", url: "https://example.com/", snippet: "" }] },
    { ok: false, query: "refused", results: [], reason: "duckduckgo-lite: declined the request (HTTP 202)" }
  ]);
  assert.match(text, /No results for "refused": duckduckgo-lite: declined/);
  assert.match(text, /1\. A page/);
});
