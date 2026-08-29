// THE ONE PIECE OF demo.js WITH LOGIC IN IT, RUN RATHER THAN READ.
//
// Every other check on the client is a static source check — the ids in
// demo.html against the ids demo.js looks up — because that is the failure those
// files actually have. This function is different: it PARSES the search tool's
// output back into a list of links, so it is a real parser with a real contract,
// and when the tool's output shape changed it broke silently.
//
// It broke exactly once and this is that case. `search` now answers several
// queries in one step, so its output is a sequence of sections. The parser read
// `lines.slice(1)` — skipping line 0 as "the header" — and treated every later
// line as belonging to whatever result came before it. So the second query's
// heading was rendered as a SNIPPET under the first query's last result, which
// reads as gibberish and looks like the search returned nonsense.
//
// The function is extracted from the served file rather than copied here, so
// this tests the bytes the product loads. It cannot be imported: demo.js is a
// browser module that touches `document` at the top level.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.join(here, "..", "..", "apps", "desktop", "demo.js"), "utf8")
  .replace(/\r\n/g, "\n");

// Between two markers, inclusive. Anchored on the declaration and on the
// closing brace at column 0, which is how every top-level function in that file
// ends.
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `demo.js no longer contains ${JSON.stringify(startMarker)}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `no ${JSON.stringify(endMarker)} after ${JSON.stringify(startMarker)}`);
  return source.slice(start, end + endMarker.length);
}

// The smallest DOM that this function actually uses: a tag, a class list, text,
// children, a dataset and an href. Enough to assert on what it built, and
// nothing that could make a broken parser look like it worked.
function makeDocument() {
  const node = (tag) => ({
    tagName: String(tag).toUpperCase(),
    className: "",
    children: [],
    dataset: {},
    _text: "",
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join(" ");
    },
    set textContent(value) { this._text = String(value); },
    appendChild(child) { this.children.push(child); return child; },
    prepend(child) { this.children.unshift(child); return child; },
    get classes() { return String(this.className).split(/\s+/).filter(Boolean); }
  });
  return { createElement: node };
}

const walk = (root, predicate, found = []) => {
  if (predicate(root)) found.push(root);
  for (const child of root.children ?? []) walk(child, predicate, found);
  return found;
};
const withClass = (root, name) => walk(root, (node) => node.classes?.includes(name));

const renderSearchResults = new Function(
  "document",
  [
    between("function el(", "\n}"),
    between("function domainOf(", "\n}"),
    between("const SECTION_HEAD", "const CROSS_REFERENCE = /^\\s*=\\s*(\\d+)\\.\\s+(.*)$/;"),
    between("function renderSearchResults(text) {", "\n  return wrap;\n}"),
    "return renderSearchResults;"
  ].join("\n\n")
)(makeDocument());

// Exactly what renderBatch prints: two answered queries, a page the second query
// also returned, and one query no index would answer.
const BATCH = [
  '2 results for "nvidia intern 2026 apply" (duckduckgo+yahoo+bing)',
  "",
  "1. NVIDIA 2027 Internships: Software Engineering",
  "   https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/JR2023495",
  "   Apply for the software engineering internship.",
  "2. University Recruiting at NVIDIA",
  "   https://www.nvidia.com/en-us/about-nvidia/careers/university-recruiting/",
  "",
  '2 results for "stripe intern 2026 apply" (duckduckgo+bing)',
  "",
  "3. Stripe University",
  "   https://stripe.com/jobs/university",
  "   Internships at Stripe.",
  "   = 1. NVIDIA 2027 Internships: Software Engineering",
  "",
  'No results for "palantir intern apply": duckduckgo-lite: declined the request (HTTP 202)'
].join("\n");

const SINGLE = [
  '2 results for "best laptops of 2026" (duckduckgo+yahoo)',
  "",
  "1. Best Laptops 2026",
  "   https://www.tomshardware.com/laptops/best-laptops",
  "   Our expert reviewers spend hours testing.",
  "2. The best laptops we have tested",
  "   https://www.pcmag.com/picks/best-laptops"
].join("\n");

test("a batched search renders every result as its own link", () => {
  const out = renderSearchResults(BATCH);
  const hrefs = walk(out, (node) => node.tagName === "A").map((anchor) => anchor.href);
  assert.deepEqual(hrefs, [
    "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/JR2023495",
    "https://www.nvidia.com/en-us/about-nvidia/careers/university-recruiting/",
    "https://stripe.com/jobs/university"
  ]);
});

test("a section heading is not swallowed as the previous result's snippet", () => {
  // The whole reason this file exists. Before the fix, "2 results for stripe
  // intern 2026 apply (duckduckgo+bing)" appeared as the description of NVIDIA's
  // university recruiting page.
  const out = renderSearchResults(BATCH);
  const snippets = withClass(out, "search-hit-snippet");
  // A loop over an empty list passes and proves nothing, which for a test whose
  // whole subject is "the wrong thing became a snippet" would be the worst kind
  // of green. The batch above has two real snippets and one reference line.
  assert.equal(snippets.length, 3, "the snippets themselves went missing, so this check was vacuous");
  for (const snippet of snippets) {
    assert.ok(
      !/results? for "/.test(snippet.textContent),
      `a query heading was rendered as a result snippet: ${snippet.textContent}`
    );
  }
});

test("each group is headed by the question it answers", () => {
  const out = renderSearchResults(BATCH);
  const headings = withClass(out, "search-query-head").map((node) => node.textContent);
  assert.equal(headings.length, 3, "one heading per query, including the one that found nothing");
  assert.ok(headings[0].includes("nvidia intern 2026 apply"));
  assert.ok(headings[1].includes("stripe intern 2026 apply"));
  // A query nobody could answer says so, rather than leaving a gap the reader
  // has to interpret as "found nothing" or "was never asked".
  assert.ok(headings[2].includes("palantir intern apply"));
  assert.ok(headings[2].includes("HTTP 202"));
});

test("a page more than one query returned is shown as a reference, not a second result", () => {
  const out = renderSearchResults(BATCH);
  const references = withClass(out, "search-hit-reference");
  assert.equal(references.length, 1);
  assert.match(references[0].textContent, /Also result 1: NVIDIA 2027 Internships/);
  // And it did not become a link, because it is the same page as result 1.
  assert.equal(walk(out, (node) => node.tagName === "A").length, 3);
});

test("a single-query search still renders as one flat list, exactly as before", () => {
  const out = renderSearchResults(SINGLE);
  assert.equal(withClass(out, "search-query-head").length, 0, "one query must not grow a heading");
  assert.equal(withClass(out, "search-hit").length, 2);
  const head = withClass(out, "search-sources-head")[0];
  assert.match(head.textContent, /Sources · 2/);
  assert.match(head.textContent, /duckduckgo\+yahoo/);
});

test("output that is not search results at all is shown verbatim rather than as an empty box", () => {
  const out = renderSearchResults("The search engines are refusing requests from this machine right now.");
  assert.equal(out.tagName, "PRE");
});
