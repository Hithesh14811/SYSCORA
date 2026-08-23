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
import { parseResults, renderResults, searchWeb, unwrapRedirect } from "../../packages/fast-agent/src/web-search.js";

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

// ---- the network behaviour, stubbed ----------------------------------------

const stub = (bodies) => async (url) => {
  const which = String(url).includes("lite.duckduckgo") ? "lite" : "html";
  const entry = bodies[which];
  if (entry instanceof Error) throw entry;
  return { ok: entry.status === undefined || entry.status === 200, status: entry.status ?? 200, text: async () => entry.body ?? "" };
};

test("a search returns results and names which engine answered", async () => {
  const found = await searchWeb("ml internships", { fetchImpl: stub({ lite: { body: LITE_BODY }, html: { body: HTML_BODY } }) });
  assert.equal(found.ok, true);
  assert.equal(found.provider, "duckduckgo-lite", "lite is tried first — same results, far less markup");
  assert.equal(found.results.length, 2);
});

test("HTTP 202 is a challenge, not an answer, and says so", async () => {
  // Observed live: after repeated automated searches from one address,
  // DuckDuckGo answers 202 with a challenge page carrying no results and none
  // of the words a CAPTCHA check looks for. Reported as "no results" it sends
  // the model off to rephrase a query that was never the problem.
  const found = await searchWeb("ml internships", {
    fetchImpl: async () => ({ ok: true, status: 202, text: async () => "<html><head><title>DuckDuckGo</title></head><body>nothing here</body></html>" })
  });
  assert.equal(found.ok, false);
  assert.match(found.reason, /rate-limiting this machine/);
  assert.ok(!/no results could be parsed/.test(found.reason),
    "a rate limit reported as an empty result set sends the model the wrong way");
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
