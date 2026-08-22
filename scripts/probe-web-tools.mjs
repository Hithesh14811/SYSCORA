// Does the web route actually work, against a real browser and a real page?
//
// The unit tests prove the wiring with a stubbed browser, which is exactly the
// Mock-provider trap this codebase has been caught by before: everything passes
// and nothing has been driven. This launches the real controlled Chromium,
// against a page served from this process so the probe does not depend on the
// network or on somebody else's markup, and exercises the tools the model is
// actually offered: open, read, type-and-submit, click.
//
//   node scripts/probe-web-tools.mjs

import http from "node:http";
import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

// A page with the things that have historically gone wrong on it: a search box
// whose only name is its placeholder, a framework-style controlled input, a
// heading that contains the words of a link without being the link, and a
// result whose label is longer than the query.
const PAGE = `<!doctype html><html><head><title>Probe Home</title></head><body>
  <h1>Search results for Headlines</h1>
  <form action="/results" method="get">
    <input name="q" placeholder="Search the archive" />
    <button type="submit">Go</button>
  </form>
  <ul>
    <li><a href="/song">Headlines &mdash; Drake, Song</a></li>
    <li><a href="/episode">Headlines &mdash; Top Hits Unpacked, Episode</a></li>
  </ul>
</body></html>`;

const RESULTS = `<!doctype html><html><head><title>Probe Results</title></head><body>
  <h1>Results</h1><p id="echo">You searched for: QUERY</p>
  <a href="/song">Open the song</a>
</body></html>`;

const SONG = `<!doctype html><html><head><title>Probe Song</title></head><body>
  <h1>Drake &mdash; Headlines</h1><p>Playing now.</p></body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/results") return response.end(RESULTS.replace("QUERY", url.searchParams.get("q") ?? "(nothing)"));
  if (url.pathname === "/song") return response.end(SONG);
  return response.end(PAGE);
});

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ").slice(0, 600)}` : ""}`);
};

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`Probe page at ${origin}\n`);

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });

const run = async (tool, args) => {
  const started = Date.now();
  const result = await toolset.execute(tool, args);
  return { ...result, ms: Date.now() - started };
};

try {
  const opened = await run("web_open", { url: origin });
  check("web_open reads the page through the DOM",
    opened.ok && /Probe Home/.test(opened.text) && /Search results for Headlines/.test(opened.text),
    `${opened.ms}ms\n${opened.text.slice(0, 400)}`);
  check("it lists the page's real controls, by name",
    /"Go"/.test(opened.text) && /Top Hits Unpacked/.test(opened.text),
    opened.text.slice(0, 500));
  check("a DOM read is faster than a screen capture would be (< 3s)", opened.ms < 3000, `${opened.ms}ms`);

  // A search box whose only name is its placeholder — the case `find` could
  // never match, because an empty input has no innerText.
  const typed = await run("web_type", { text: "Headlines", into: "Search the archive", submit: true });
  check("typing into a field named only by its placeholder lands and submits",
    typed.ok && /Pressed Enter/.test(typed.text), `${typed.ms}ms\n${typed.text}`);

  const afterSearch = await run("web_read", {});
  check("the search actually ran — the page carries the query it was given",
    afterSearch.ok && /You searched for: Headlines/.test(afterSearch.text),
    afterSearch.text.slice(0, 300));

  await run("web_open", { url: origin });
  // Two links answer to "Headlines" and a heading contains it. The clickable
  // one must win, and the label it matched must be reported.
  const clicked = await run("web_click", { text: "Headlines Drake Song" });
  check("clicking picks an actionable element, not the heading that contains the words",
    clicked.ok && /Drake/.test(clicked.text), clicked.text);
  const landed = await run("web_read", {});
  check("the click navigated to the link it named",
    landed.ok && /Probe Song/.test(landed.text), landed.text.slice(0, 300));

  const missing = await run("web_click", { text: "Checkout" });
  check("a label that is not there lists what is, instead of failing blind",
    !missing.ok && /clickable/i.test(missing.text), missing.text.slice(0, 400));
} catch (error) {
  check("the probe ran to completion", false, error?.stack ?? String(error));
} finally {
  adapter.browserAutomation?.close?.();
  server.close();
}

const failed = results.filter((entry) => !entry.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
