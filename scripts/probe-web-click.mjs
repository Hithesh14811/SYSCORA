// DOES THE CONTROLLED BROWSER KNOW WHERE IT IS, AND DOES IT CLICK WHAT IT WAS ASKED FOR?
//
//   node scripts/probe-web-click.mjs
//
// Two live checks against a real Chromium, on a local page so it costs no
// network and cannot be changed by anyone else:
//
//   1. LOCALE. The browser used to launch with no language, no locale and no
//      timezone, so every site geolocated it by IP. Measured 28 Aug 2026: a New
//      York → Seattle flight search opened on "Mysuru" with prices in rupees,
//      twice, and the agent could not win by driving the form correctly because
//      the page was answering a different question.
//
//   2. RANKING. `findBest` scored by coverage alone — how many of the requested
//      words appear in a candidate, with no penalty for the candidate carrying
//      extra words. Asked for "New York, USA City in New York State" it clicked
//      "Niagara Falls, New York, USA". A wrong click on a web page NAVIGATES, so
//      that mistake moved the whole task somewhere else.
//
// Nothing here clicks anything or touches the network.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CdpBrowserAdapter, BROWSER_LOCALE, BROWSER_TIMEZONE } from "../os-adapters/browser/src/cdp-browser-adapter.js";

// THE WRAPPER IS THE POINT OF THIS PAGE.
//
// A first version of this probe held only the three options, and it PASSED WITH
// THE BUG PUT BACK: with those three alone, coverage-only ranking also picks the
// right row, because the exact option has both the best coverage and the longest
// label. A check that cannot fail is not a check — so the page now contains the
// shape that actually beats coverage: a clickable ANCESTOR whose text is every
// option at once. It has perfect recall (it contains every requested word) and
// it is the longest label on the page, so it wins under the old rule and loses
// under F1, which is the whole difference being tested.
const PAGE = `<!doctype html><meta charset="utf-8"><body>
<div role="option" id="wrapper">
<ul>
  <li role="option">New York, USA City in New York State</li>
  <li role="option">Niagara Falls, New York, USA</li>
  <li role="option">John F. Kennedy International Airport JFK</li>
</ul>
</div>
<div id="env"></div>
<script>
document.getElementById('env').textContent = JSON.stringify({
  language: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
});
</script></body>`;

const file = path.join(os.tmpdir(), "syscora-web-click-probe.html");
fs.writeFileSync(file, PAGE, "utf8");
const url = new URL(`file://${file.replace(/\\/g, "/")}`).href;

const browser = new CdpBrowserAdapter();
let failures = 0;
try {
  console.log("CONFIGURED");
  console.log(`  locale    ${BROWSER_LOCALE}`);
  console.log(`  timezone  ${BROWSER_TIMEZONE}`);
  console.log("");

  await browser.launch({ url, headless: true });
  // The page writes its own environment into the DOM on load.
  await new Promise((resolve) => setTimeout(resolve, 700));

  const reported = await browser._evaluate("document.getElementById('env').textContent");
  console.log("WHAT THE PAGE ITSELF REPORTS");
  console.log(`  ${reported}`);
  let seen = {};
  try { seen = JSON.parse(reported); } catch { /* printed above either way */ }
  // The language is the half we can set deterministically; the timezone override
  // is best-effort and a Chromium that ignores it still leaves a usable browser.
  const languageOk = String(seen.language ?? "").toLowerCase().startsWith(BROWSER_LOCALE.slice(0, 2).toLowerCase());
  console.log(`  language matches the configured locale: ${languageOk ? "YES" : "NO"}`);
  console.log(`  timezone matches: ${seen.timeZone === BROWSER_TIMEZONE ? "YES" : `NO (${seen.timeZone})`}`);
  if (!languageOk) failures += 1;
  console.log("");

  const wanted = "New York, USA City in New York State";
  const hit = await browser.findBest({
    selector: 'a,button,[role="button"],[role="option"],li',
    text: wanted,
    minCoverage: 0.5
  });
  console.log("RANKING");
  console.log(`  asked for   ${JSON.stringify(wanted)}`);
  console.log(`  picked      ${JSON.stringify(hit.target?.name)}  (score ${Number(hit.matchScore ?? 0).toFixed(3)})`);
  console.log(`  runner-up   ${JSON.stringify(hit.runnerUp?.name ?? null)}  (score ${Number(hit.runnerUp?.score ?? 0).toFixed(3)})`);
  for (const option of hit.alternatives ?? []) console.log(`    ${option.score}  ${option.name}`);
  const right = hit.target?.name === wanted;
  console.log(`  ${right ? "PASS" : "FAIL"} — ${right ? "the exact option won" : "picked the wrong row"}`);
  if (!right) failures += 1;
} finally {
  browser.close();
  fs.rmSync(file, { force: true });
}

console.log("");
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
