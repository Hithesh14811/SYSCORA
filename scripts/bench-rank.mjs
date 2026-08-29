// A/B-ING THE RANKER WITHOUT MEASURING THE RATE LIMIT.
//
//   node scripts/bench-rank.mjs
//
// `bench-search.mjs` measures the whole pipeline end to end, which is the right
// ruler for "is search good today" and the WRONG one for "is this ranking change
// better". Two runs of it minutes apart are two different sets of candidates:
// DuckDuckGo's rolling budget runs out partway, the third index drops off, and
// the difference you measure is the difference between a warm minute and a cold
// one. That is precisely why the authority signal in search-rank.js sat unproven
// for a week — every attempt to confirm it burned the allowance it needed.
//
// This asks each query ONCE, keeps the candidate pool, and then ranks that same
// pool both ways. The rankers are pure functions of the pool, so the comparison
// is exact and repeatable, and the network is paid for once rather than twice.
//
// The pool is cached on disk (--fresh to refetch), so subsequent A/Bs of a
// ranking change cost nothing at all and cannot be polluted by a bad minute.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchWeb } from "../packages/fast-agent/src/web-search.js";
import { rerank } from "../packages/fast-agent/src/search-rank.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUERY_FILE = path.join(__dirname, "..", "tests", "eval", "search-queries.json");
const POOL_FILE = path.join(__dirname, "..", "tests", "eval", "search-baselines", "candidate-pool.json");

const argv = process.argv.slice(2);
const fresh = argv.includes("--fresh");
const only = (() => {
  const at = argv.indexOf("--only");
  return at === -1 ? null : new Set(String(argv[at + 1] ?? "").split(","));
})();
// The pool is deliberately deeper than the eight that get shown: a ranking
// change that promotes the right answer from eleventh cannot be seen in a pool
// of eight, and "promote from just outside the fold" is the whole claim being
// tested.
const POOL = 16;
const SHOWN = 8;

// The same site-matching rule as bench-search.mjs. Duplicated on purpose rather
// than exported: this file must keep working if that one is rewritten, and the
// rule is four lines.
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
  const wanted = site.toLowerCase().replace(/^www\./, "");
  if (wanted.includes("/")) return full.startsWith(wanted);
  return host === wanted || host.endsWith(`.${wanted}`);
}

const matches = (url, sites) => (sites ?? []).some((site) => onSite(url, site));

function score(results, spec) {
  const firstGood = results.findIndex((result) => matches(result.url, spec.good));
  const at = (n) => (firstGood !== -1 && firstGood < n ? 1 : 0);
  return {
    hit1: at(1),
    hit3: at(3),
    hit8: at(8),
    poison3: results.slice(0, 3).some((result) => matches(result.url, spec.bad)) ? 1 : 0,
    mrr: firstGood === -1 ? 0 : 1 / (firstGood + 1)
  };
}

const specs = JSON.parse(await fs.readFile(QUERY_FILE, "utf8")).queries
  .filter((spec) => !only || only.has(spec.id));

// ONE FETCH PER QUERY, REUSED FOR EVERY ARM.
async function poolFor(specs) {
  if (!fresh) {
    try {
      const cached = JSON.parse(await fs.readFile(POOL_FILE, "utf8"));
      const have = new Map(cached.pools.map((entry) => [entry.id, entry]));
      if (specs.every((spec) => have.has(spec.id))) {
        console.log(`candidate pool: from ${path.relative(process.cwd(), POOL_FILE)}, fetched ${cached.at}`);
        return have;
      }
      console.log("candidate pool: cached file does not cover these queries — refetching.");
    } catch { /* no pool yet */ }
  }

  const pools = [];
  for (const spec of specs) {
    // With the authority signal OFF, so the stored pool is not already shaped by
    // one of the arms. Only the ORDER differs between arms; the members do not.
    const wasSet = process.env.SYSCORA_SEARCH_AUTHORITY;
    delete process.env.SYSCORA_SEARCH_AUTHORITY;
    const found = await searchWeb(spec.query, { limit: POOL, useCache: false });
    if (wasSet !== undefined) process.env.SYSCORA_SEARCH_AUTHORITY = wasSet;
    pools.push({
      id: spec.id,
      provider: found.provider,
      ok: found.ok,
      reason: found.reason,
      // Every field the ranker reads travels with the candidate, so re-ranking
      // from the file is identical to re-ranking from the network.
      results: (found.results ?? []).map((result) => ({
        title: result.title, url: result.url, snippet: result.snippet,
        score: result.score, foundBy: result.foundBy, bestRank: result.bestRank
      }))
    });
    const indexes = String(found.provider ?? "").split("+").filter(Boolean).length;
    console.log(`  fetched ${spec.id.padEnd(28)} ${String(found.results?.length ?? 0).padStart(2)} candidates ` +
      `from ${indexes} index${indexes === 1 ? "" : "es"}${indexes < 2 ? "   <- thin, consensus is weak here" : ""}`);
  }
  await fs.mkdir(path.dirname(POOL_FILE), { recursive: true });
  await fs.writeFile(POOL_FILE, JSON.stringify({ at: new Date().toISOString(), pools }, null, 1));
  return new Map(pools.map((entry) => [entry.id, entry]));
}

const pool = await poolFor(specs);

function arm(label, authority) {
  const rows = specs.map((spec) => {
    const candidates = pool.get(spec.id)?.results ?? [];
    if (authority) process.env.SYSCORA_SEARCH_AUTHORITY = "1";
    else delete process.env.SYSCORA_SEARCH_AUTHORITY;
    const ranked = rerank(spec.query, candidates).slice(0, SHOWN);
    return { id: spec.id, top: ranked[0]?.url ?? "(nothing)", ...score(ranked, spec) };
  });
  const mean = (pick) => rows.reduce((total, row) => total + pick(row), 0) / (rows.length || 1);
  return {
    label,
    rows,
    hit1: mean((row) => row.hit1),
    hit3: mean((row) => row.hit3),
    hit8: mean((row) => row.hit8),
    poison3: mean((row) => row.poison3),
    mrr: mean((row) => row.mrr)
  };
}

const off = arm("authority OFF", false);
const on = arm("authority ON", true);
delete process.env.SYSCORA_SEARCH_AUTHORITY;

const pct = (value) => `${(value * 100).toFixed(0)}%`.padStart(5);
console.log(`\n${specs.length} queries, one candidate pool of ${POOL}, top ${SHOWN} scored.\n`);
console.log("                  hit@1  hit@3  hit@8  poison@3   MRR");
for (const result of [off, on]) {
  console.log(`  ${result.label.padEnd(14)} ${pct(result.hit1)} ${pct(result.hit3)} ${pct(result.hit8)} ` +
    `   ${pct(result.poison3)}   ${result.mrr.toFixed(3)}`);
}

// PER QUERY, BECAUSE AN AVERAGE HIDES THE TRADE.
//
// A signal that fixes two queries and breaks two others averages to nothing and
// is not nothing: it is a change that has to be argued about. Only the rows that
// MOVED are printed, so the interesting cases are the whole output.
console.log("\nwhere the two disagree:");
let moved = 0;
for (const [index, row] of off.rows.entries()) {
  const other = on.rows[index];
  if (row.top === other.top && row.mrr === other.mrr) continue;
  moved += 1;
  const direction = other.mrr > row.mrr ? "BETTER" : other.mrr < row.mrr ? "WORSE " : "same  ";
  console.log(`  ${direction} ${row.id}`);
  console.log(`     off: ${row.top}`);
  console.log(`     on:  ${other.top}`);
}
if (moved === 0) console.log("  nothing moved — the signal changed no ranking in this pool.");
