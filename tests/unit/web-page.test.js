// Reading a page used to mean spawning a second Chromium, waiting for CDP,
// navigating, polling until the DOM settled and serialising everything —
// several seconds, a process left behind and a window on the user's screen, for
// the words in an article. See web-page.js.
//
// These are against STUBBED responses, so the suite never depends on a network
// or on any particular site being up. The markup below carries the things that
// actually break strippers: script bodies, entity-escaped text, relative hrefs
// and a single-page application's empty shell.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities,
  extractLinks,
  extractText,
  fetchPage,
  readable,
  titleOf
} from "../../packages/fast-agent/src/web-page.js";

const ARTICLE = `<!doctype html><html><head>
  <title>How to boil an egg &amp; not cry</title>
  <style>.a{color:red}</style>
  <script>var tracking = {"user":"x"}; if (1 < 2) { console.log("<p>not text</p>"); }</script>
</head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <article>
    <h1>How to boil an egg</h1>
    <p>Put the egg in the water.</p>
    <p>Wait for six minutes &mdash; or seven if you like them firm.</p>
    <p>See also <a href="/eggs/poached">our poaching guide</a> and
       <a href="https://example.org/timers">a timer</a>.</p>
  </article>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

// What a framework-rendered application sends before its JavaScript runs. There
// is nothing here to read, and no amount of re-fetching will change that.
const SPA_SHELL = `<!doctype html><html><head><title>Dashboard</title></head>
  <body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

test("script and style bodies are not reading matter", () => {
  const text = extractText(ARTICLE);
  // Their CONTENTS are not tags, so stripping tags alone leaves a site's whole
  // JavaScript in the text — on a modern page, most of the bytes.
  assert.ok(!text.includes("tracking"), "the script body survived");
  assert.ok(!text.includes("color:red"), "the stylesheet survived");
  assert.ok(!text.includes("not text"), "markup inside a string in a script survived");
});

test("the words of the page come through, with entities decoded", () => {
  const text = extractText(ARTICLE);
  assert.match(text, /Put the egg in the water\./);
  assert.match(text, /Wait for six minutes/);
  assert.equal(titleOf(ARTICLE), "How to boil an egg & not cry");
});

test("paragraphs stay separate lines rather than running together", () => {
  const text = extractText(ARTICLE);
  // Without a newline for every block tag the whole page arrives as one
  // unbroken sentence, which is unreadable and costs the same tokens.
  assert.ok(!/water\.\s*Wait/.test(text.replace(/\n/g, "@")), "the paragraphs ran together");
  assert.match(text, /water\.\n/);
});

test("a page is not padded out by the empty layout tags it is built from", () => {
  // A long article carries thousands of empty <div>s, and every blank line they
  // produce is a token paid for by whoever reads the page.
  const text = extractText("<div></div><div></div><p>One</p><div></div><div></div><p>Two</p>");
  assert.equal(text, "One\nTwo");
});

test("links come back absolute, labelled and deduplicated", () => {
  const links = extractLinks(ARTICLE, "https://kitchen.example/recipes/eggs");
  const byLabel = new Map(links.map((link) => [link.label, link.href]));
  // A relative href is useless to a model that has to open it next.
  assert.equal(byLabel.get("our poaching guide"), "https://kitchen.example/eggs/poached");
  assert.equal(byLabel.get("a timer"), "https://example.org/timers");
  assert.equal(new Set(links.map((link) => link.href)).size, links.length);
});

test("an unlabelled link is not a link anyone can ask for", () => {
  const links = extractLinks('<a href="/x"><img src="i.png"></a><a href="/y">Real</a>', "https://e.example");
  assert.equal(links.length, 1);
  assert.equal(links[0].label, "Real");
});

test("readability is measured, not guessed from the domain", () => {
  // A list of sites believed to need a browser is wrong the week after it is
  // written, and wrong silently. What ARRIVED is the only honest test.
  assert.equal(readable(extractText(SPA_SHELL)), false);
  assert.equal(readable(extractText(ARTICLE) + "x".repeat(400)), true);
});

test("entities that are not entities are left alone", () => {
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("100 &widget; 200"), "100 &widget; 200");
});

// ---- the network behaviour, stubbed ------------------------------------------

const respond = ({ status = 200, body = "", type = "text/html", url = "https://e.example/p" }) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: { get: (name) => (name.toLowerCase() === "content-type" ? type : null) },
  text: async () => body
});

test("a fetched page reports where it LANDED, not where it was sent", async () => {
  // A redirect to a login wall or a regional edition is the ordinary case, and
  // reporting the requested URL for a page that is somewhere else is the same
  // mistake as reporting a message sent that was never sent.
  const page = await fetchPage("https://e.example/p", {
    fetchImpl: async () => respond({ body: ARTICLE, url: "https://e.example/en/p" })
  });
  assert.equal(page.ok, true);
  assert.equal(page.url, "https://e.example/en/p");
  assert.equal(page.requestedUrl, "https://e.example/p");
});

test("an HTTP error names the status, because the recovery depends on it", async () => {
  // 404 means the URL is wrong, 403 means this reader is refused and a browser
  // may still work, 5xx means try later. "Could not read" throws all three away.
  const page = await fetchPage("https://e.example/gone", {
    fetchImpl: async () => respond({ status: 404, body: "" })
  });
  assert.equal(page.ok, false);
  assert.equal(page.status, 404);
  assert.match(page.reason, /404/);
});

test("a PDF is not a web page, and says which it is", async () => {
  const page = await fetchPage("https://e.example/report.pdf", {
    fetchImpl: async () => respond({ type: "application/pdf", body: "%PDF-1.4" })
  });
  assert.equal(page.ok, false);
  assert.match(page.reason, /application\/pdf/);
});

test("an application shell is fetched successfully and is still not readable", async () => {
  // This is the case the browser fallback exists for, and it must be reported
  // as "nothing to read here" rather than as a failed request.
  const page = await fetchPage("https://e.example/app", {
    fetchImpl: async () => respond({ body: SPA_SHELL })
  });
  assert.equal(page.ok, true);
  assert.equal(page.readable, false);
});

test("fetchPage never throws, whatever the transport does", async () => {
  const page = await fetchPage("https://e.example/p", {
    fetchImpl: async () => { throw new Error("socket hang up"); }
  });
  assert.equal(page.ok, false);
  assert.match(page.reason, /socket hang up/);
});

test("a non-http URL is refused without a request", async () => {
  let called = false;
  const page = await fetchPage("file:///C:/Windows/System32/config/SAM", {
    fetchImpl: async () => { called = true; }
  });
  assert.equal(page.ok, false);
  assert.equal(called, false, "a file:// URL must never reach the fetcher");
});
