// MEASURING SEARCH, SO "BETTER" IS A NUMBER.
//
// The failure that made this necessary: on 23 Aug 2026 a search for "best
// laptops of 2026" returned four dictionary definitions of the word "best", and
// nothing anywhere in the system noticed — the request had succeeded, ten
// results had come back, every receipt was honest. The pipeline had no idea what
// a GOOD result was, so it could not tell a good day from a bad one, and neither
// could anyone reading the code.
//
// This is the ruler. Against a fixed set of queries with known-good and
// known-wrong destinations, it reports:
//
//   hit@1 / hit@3 / hit@8  did a site that answers the question appear that high
//   poison@3               did a KNOWN WRONG TURN appear in the top three
//   MRR                    how far down the first good result was
//   ms                     wall clock, because a better answer that takes ten
//                          seconds is not better for an agent that searches four
//                          times a question
//
// poison@3 is the one that matters most and the one a conventional benchmark
// leaves out. Recall alone would have scored that laptops query respectably —
// Best Buy was in there somewhere. What was actually wrong was that the top of
// the list was rubbish, and the model believed it.
//
// USAGE
//   node scripts/bench-search.mjs                 measure the current pipeline
//   node scripts/bench-search.mjs --save NAME     record it as a baseline
//   node scripts/bench-search.mjs --against NAME  and print the difference
//   node scripts/bench-search.mjs --only ID,ID    just these queries
//   node scripts/bench-search.mjs --repeat 3      median of N runs per query
//
// The engines are live, so two runs minutes apart are not identical. --repeat
// takes a median; without it, treat a difference under about five points as
// noise rather than as a result.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchWeb } from "../packages/fast-agent/src/web-search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERY_FILE = path.join(__dirname, "..", "tests", "eval", "search-queries.json");
const BASELINE_DIR = path.join(__dirname, "..", "tests", "eval", "search-baselines");

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : (argv[at + 1] ?? true);
};

const LIMIT = Number(flag("limit") ?? 8);
const REPEAT = Math.max(1, Number(flag("repeat") ?? 1));
// `--read` used to let the reranker fetch candidate pages. It was measured over
// twelve queries twice, never helped, and doubled the latency — see the table in
// search-rank.js. The flag is answered rather than ignored, so that an old
// command line does not quietly measure something other than what it asks for.
if (argv.includes("--read")) {
  console.log("\n  --read does nothing now: page reading was measured and removed. See search-rank.js.");
}

// A result belongs to a site if its hostname IS that site or a subdomain of it.
// Plain `includes` would count "notamazon.com" as amazon.com, and would count a
// site named in a query string as a hit on the page it was named on.
function onSite(url, site) {
  let host;
  let full;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    full = `${host}${parsed.pathname}`.toLowerCase();
  } catch {
    return false;
  }
  // An entry may name a path — "docker.com/pricing", "linkedin.com/jobs" — when
  // the site as a whole is fine and one section of it is the wrong turn.
  const wanted = site.toLowerCase().replace(/^www\./, "");
  if (wanted.includes("/")) return full.startsWith(wanted);
  return host === wanted || host.endsWith(`.${wanted}`);
}

const matches = (url, sites) => sites.some((site) => onSite(url, site));

function scoreOne(results, spec) {
  const ranks = results.map((result, index) => ({
    index,
    good: matches(result.url, spec.good ?? []),
    bad: matches(result.url, spec.bad ?? [])
  }));
  const firstGood = ranks.find((entry) => entry.good)?.index ?? null;
  const at = (n) => (firstGood !== null && firstGood < n ? 1 : 0);
  return {
    hit1: at(1),
    hit3: at(3),
    hit8: at(8),
    // A known wrong turn in the top three. The model reads the top of the list
    // and believes it, so this is where a bad result does its damage.
    poison3: ranks.slice(0, 3).some((entry) => entry.bad) ? 1 : 0,
    mrr: firstGood === null ? 0 : 1 / (firstGood + 1),
    returned: results.length
  };
}

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function runQuery(spec) {
  const runs = [];
  for (let attempt = 0; attempt < REPEAT; attempt += 1) {
    const startedAt = Date.now();
    // Uncached on purpose: this measures the ENGINES, and a cache hit would
    // measure web-search.js remembering its own previous answer.
    const found = await searchWeb(spec.query, { limit: LIMIT, useCache: false });
    const ms = Date.now() - startedAt;
    runs.push({
      ...scoreOne(found.ok ? found.results : [], spec),
      ms,
      ok: found.ok,
      provider: found.provider,
      reason: found.reason,
      results: found.results
    });
  }
  // The median run, so one engine hiccup does not become the measurement.
  const best = runs[Math.floor(runs.length / 2)];
  return {
    id: spec.id,
    query: spec.query,
    ...best,
    hit1: median(runs.map((run) => run.hit1)),
    hit3: median(runs.map((run) => run.hit3)),
    hit8: median(runs.map((run) => run.hit8)),
    poison3: median(runs.map((run) => run.poison3)),
    mrr: median(runs.map((run) => run.mrr)),
    ms: Math.round(median(runs.map((run) => run.ms)))
  };
}

function summarise(rows) {
  const mean = (pick) => rows.reduce((total, row) => total + pick(row), 0) / (rows.length || 1);
  return {
    queries: rows.length,
    answered: rows.filter((row) => row.ok).length,
    hit1: mean((row) => row.hit1),
    hit3: mean((row) => row.hit3),
    hit8: mean((row) => row.hit8),
    poison3: mean((row) => row.poison3),
    mrr: mean((row) => row.mrr),
    msMedian: Math.round(median(rows.map((row) => row.ms))),
    msTotal: rows.reduce((total, row) => total + row.ms, 0)
  };
}

const pct = (value) => `${(value * 100).toFixed(0)}%`;

function printRows(rows) {
  console.log("");
  console.log("  id                      hit@1 hit@3 hit@8  poison@3   MRR    ms   engine");
  console.log("  " + "-".repeat(84));
  for (const row of rows) {
    const tick = (value) => (value ? " ✓  " : " ·  ");
    const poison = row.poison3 ? "  POISON " : "    ok   ";
    console.log(
      `  ${row.id.padEnd(22)}${tick(row.hit1)}  ${tick(row.hit3)}  ${tick(row.hit8)} ${poison} ` +
      `${row.mrr.toFixed(2)}  ${String(row.ms).padStart(5)}   ${row.ok ? (row.provider ?? "") : "FAILED"}`
    );
    if (!row.ok) console.log(`      ${String(row.reason ?? "").slice(0, 100)}`);
    // The top three, because a number that says "poison" is worth being able to
    // look at. This is the line that turns a red cell into a diagnosis.
    if (row.poison3 || !row.hit3) {
      for (const result of (row.results ?? []).slice(0, 3)) {
        console.log(`      · ${result.title.slice(0, 58).padEnd(58)} ${result.url.slice(0, 46)}`);
      }
    }
  }
}

function printSummary(label, summary) {
  console.log("");
  console.log(`  ${label}`);
  console.log(`    answered      ${summary.answered}/${summary.queries}`);
  console.log(`    hit@1         ${pct(summary.hit1)}`);
  console.log(`    hit@3         ${pct(summary.hit3)}`);
  console.log(`    hit@8         ${pct(summary.hit8)}`);
  console.log(`    poison@3      ${pct(summary.poison3)}   (lower is better — a known wrong turn in the top three)`);
  console.log(`    MRR           ${summary.mrr.toFixed(3)}`);
  console.log(`    latency       ${summary.msMedian}ms median, ${(summary.msTotal / 1000).toFixed(1)}s total`);
}

function printDelta(now, before) {
  const line = (name, current, previous, higherIsBetter = true) => {
    const change = current - previous;
    const better = higherIsBetter ? change > 0 : change < 0;
    const arrow = Math.abs(change) < 1e-9 ? "  =" : better ? "  ▲" : "  ▼";
    console.log(`    ${name.padEnd(14)}${pct(previous)} → ${pct(current)}${arrow} ${change >= 0 ? "+" : ""}${(change * 100).toFixed(0)}pt`);
  };
  console.log("");
  console.log("  Against the baseline");
  line("hit@1", now.hit1, before.hit1);
  line("hit@3", now.hit3, before.hit3);
  line("hit@8", now.hit8, before.hit8);
  line("poison@3", now.poison3, before.poison3, false);
  console.log(`    ${"MRR".padEnd(14)}${before.mrr.toFixed(3)} → ${now.mrr.toFixed(3)}`);
  console.log(`    ${"latency".padEnd(14)}${before.msMedian}ms → ${now.msMedian}ms`);
  console.log("");
  console.log("  The engines are live, so treat anything under about 5 points as noise.");
  console.log("  Re-run with --repeat 3 before believing a small difference.");
}

async function main() {
  const spec = JSON.parse(await fs.readFile(QUERY_FILE, "utf8"));
  const only = flag("only");
  const wanted = only && only !== true ? new Set(String(only).split(",")) : null;
  const queries = spec.queries.filter((query) => !wanted || wanted.has(query.id));

  console.log(`\nSearching for ${queries.length} queries, ${REPEAT} run(s) each, top ${LIMIT}.`);

  const rows = [];
  for (const query of queries) {
    process.stdout.write(`  ${query.id} … `);
    const row = await runQuery(query);
    rows.push(row);
    process.stdout.write(`${row.ok ? `${row.returned} results` : "FAILED"} in ${row.ms}ms\n`);
  }

  printRows(rows);
  const summary = summarise(rows);
  printSummary("This run", summary);

  const against = flag("against");
  if (against && against !== true) {
    const file = path.join(BASELINE_DIR, `${against}.json`);
    try {
      const before = JSON.parse(await fs.readFile(file, "utf8"));
      printDelta(summary, before.summary);
    } catch {
      console.log(`\n  No baseline named "${against}" in tests/eval/search-baselines.`);
    }
  }

  const save = flag("save");
  if (save && save !== true) {
    await fs.mkdir(BASELINE_DIR, { recursive: true });
    const file = path.join(BASELINE_DIR, `${save}.json`);
    await fs.writeFile(file, JSON.stringify({
      savedAt: new Date().toISOString(),
      limit: LIMIT,
      repeat: REPEAT,
      summary,
      // Per query too: an average that moved is a question, and the per-query
      // rows are where the answer is.
      rows: rows.map(({ results, ...rest }) => rest)
    }, null, 2));
    console.log(`\n  Saved as ${path.relative(process.cwd(), file)}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
