// Ranking search results by what they are actually about.
//
// The failure this exists to prevent, observed live on 23 Aug 2026: asked for
// "best laptops of 2026", an engine returned four dictionary definitions of the
// word "best" and the agent believed them. Asked "how to stop windows 11 from
// reopening apps after restart", the definition of "stop". Asked "where can i
// buy the chepest iphone 17pro", Canva and the definition of "can".
//
// Fusing several engines fixed recall and made this WORSE — Reciprocal Rank
// Fusion cannot tell one engine's rank 1 from another's, so the dictionary and
// the laptop roundup arrived tied. What separates them is that one of them is
// not about laptops, which is knowable from its own title.

import test from "node:test";
import assert from "node:assert/strict";
import {
  inverseFrequencies,
  queryTerms,
  relevanceOf,
  rerank,
  bestPassages,
  tokenize
} from "../../packages/fast-agent/src/search-rank.js";

test("numbers survive tokenisation, because they are usually the question", () => {
  // "windows 11" and "windows 10" are different questions; "iphone 17" is the
  // whole point. A tokeniser that drops digits loses half these queries.
  assert.deepEqual(queryTerms("windows 11 reopening apps"), ["windows", "11", "reopening", "apps"]);
  assert.ok(tokenize("Node.js v24 release").includes("v24"));
  assert.ok(queryTerms("best laptops of 2026").includes("2026"));
});

test("the stoplist does not eat the question", () => {
  // "how", "vs" and "not" ARE the query in "how to stop windows 11" and
  // "postgres vs mysql". A stoplist that grows starts removing the point.
  const terms = queryTerms("how to stop windows 11 from reopening apps");
  assert.ok(terms.includes("how"), "'how' is the question, not a stopword");
  assert.ok(terms.includes("stop"));
  assert.ok(queryTerms("postgres vs mysql").includes("vs"));
});

test("term rarity is computed from this search's own candidates", () => {
  // Asked "best laptops of 2026", every candidate says "best" — so "best" says
  // nothing about which one to prefer, while "laptops" separates the reviews
  // from the dictionaries. That falls out of a LOCAL statistic and needs no
  // corpus to ship, keep current, or be wrong about a new word.
  const terms = queryTerms("best laptops 2026");
  const documents = [
    "the best laptops we've tested pcmag",
    "best laptops of 2026 top picks cnet",
    "best definition & meaning merriam-webster",
    "best | english meaning cambridge dictionary"
  ];
  const idf = inverseFrequencies(terms, documents);
  assert.ok(idf.get("laptops") > idf.get("best"),
    "a term every candidate shares must count for less than one that separates them");
});

test("a dictionary entry does not answer a question about laptops", () => {
  const terms = queryTerms("best laptops 2026");
  const documents = [
    "the best laptops we've tested pcmag",
    "best definition & meaning merriam-webster"
  ];
  const idf = inverseFrequencies(terms, documents);
  const roundup = relevanceOf({
    title: "The Best Laptops We've Tested (August 2026) - PCMag",
    snippet: "Whether you want a simple budget PC or a productivity workhorse.",
    url: "https://www.pcmag.com/picks/the-best-laptops"
  }, terms, idf);
  const dictionary = relevanceOf({
    title: "BEST Definition & Meaning - Merriam-Webster",
    snippet: "In the best of all possible worlds, no one would be without food.",
    url: "https://www.merriam-webster.com/dictionary/best"
  }, terms, idf);
  assert.ok(roundup > dictionary * 2, `the roundup scored ${roundup} and the dictionary ${dictionary}`);
});

test("the hostname does not count as relevance, only the path", () => {
  // Otherwise python.org scores full marks for the term "python" on every page
  // it serves, including its download page — which is exactly the result Bing
  // returned for "python asyncio TaskGroup example".
  const terms = queryTerms("python asyncio taskgroup example");
  const idf = inverseFrequencies(terms, ["python downloads", "asyncio taskgroup example"]);
  const home = relevanceOf({ title: "Welcome to Python.org", snippet: "", url: "https://www.python.org/" }, terms, idf);
  const article = relevanceOf({
    title: "How to use asyncio.TaskGroup", snippet: "", url: "https://superfastpython.com/asyncio-taskgroup/"
  }, terms, idf);
  assert.ok(article > home, `the article scored ${article} and the home page ${home}`);
});

test("singular and plural are the same term", () => {
  const terms = queryTerms("best laptops");
  const idf = inverseFrequencies(terms, ["best laptop reviews"]);
  assert.ok(relevanceOf({ title: "The best laptop of the year", snippet: "", url: "" }, terms, idf) > 0.3);
});

test("reranking demotes the wrong turn without demoting the terse title", () => {
  const results = [
    { title: "BEST Definition & Meaning - Merriam-Webster", snippet: "superlative of good", url: "https://www.merriam-webster.com/dictionary/best", score: 0.0164, foundBy: ["bing"] },
    { title: "The Best Laptops We've Tested (2026) - PCMag", snippet: "budget PC or productivity workhorse", url: "https://www.pcmag.com/picks/the-best-laptops", score: 0.0164, foundBy: ["duckduckgo"] }
  ];
  const ranked = rerank("best laptops of 2026", results);
  assert.match(ranked[0].url, /pcmag/, "the dictionary is still winning the tie");
  // The evidence for the ordering travels with it, so a ranking that looks wrong
  // can be argued with rather than just disbelieved.
  assert.ok(ranked[0].relevance > ranked[1].relevance);
  assert.equal(ranked[0].support, 1);
});

test("the engines' opinion is modulated, never overruled", () => {
  // They know about authority, freshness and popularity, none of which word
  // matching here can see. A page every engine ranks first with a terse title
  // must not be thrown out by a page nobody ranked that repeats the query.
  const results = [
    { title: "Premalu", snippet: "", url: "https://www.imdb.com/title/tt123/", score: 0.049, foundBy: ["duckduckgo", "yahoo", "bing"] },
    { title: "Premalu 2024 movie streaming where to watch online free", snippet: "premalu 2024 streaming watch", url: "https://spam.example/premalu-2024-streaming-watch", score: 0.0125, foundBy: ["bing"] }
  ];
  const ranked = rerank("Premalu 2024 movie streaming where to watch", results);
  assert.match(ranked[0].url, /imdb/, "keyword stuffing beat three engines agreeing");
});

test("an empty query changes nothing rather than throwing", () => {
  const results = [{ title: "a", snippet: "", url: "https://a.example/", score: 1, foundBy: ["bing"] }];
  assert.deepEqual(rerank("", results), results);
  assert.deepEqual(rerank("best", []), []);
});

// ---- passages ---------------------------------------------------------------

test("the passages returned are the ones that answer the question", () => {
  const terms = queryTerms("iphone 17 pro price india");
  const idf = inverseFrequencies(terms, ["iphone 17 pro price india"]);
  const page = [
    "Skip to content. Sign in. Your account. Help and support. Track your order.",
    "The iPhone 17 Pro is available in India at a starting price of Rs 1,34,900 for the 256 GB model.",
    "Subscribe to our newsletter for the latest offers and deals delivered weekly.",
    "Returns are accepted within thirty days of delivery for unopened items only."
  ].join("\n");
  const passages = bestPassages(page, terms, idf, { count: 1 });
  assert.equal(passages.length, 1);
  assert.match(passages[0], /1,34,900/);
});

test("two passages never come from the same paragraph", () => {
  // They say the same thing twice, and the second one is paid for.
  const terms = queryTerms("taskgroup");
  const idf = inverseFrequencies(terms, ["taskgroup"]);
  const page = [
    "A TaskGroup holds a group of tasks and waits for all of them to finish.",
    "The TaskGroup is entered with async with and exited when every task is done.",
    "Unrelated filler text that goes on for a while and mentions nothing at all.",
    "Padding padding padding padding padding padding padding padding padding.",
    "Another TaskGroup paragraph much further down the page than the first two."
  ].join("\n");
  const passages = bestPassages(page, terms, idf, { count: 2 });
  assert.equal(passages.length, 2);
  assert.notEqual(passages[0], passages[1]);
});

test("a page with nothing relevant yields no passages rather than its first line", () => {
  const terms = queryTerms("quantum error correction");
  const idf = inverseFrequencies(terms, ["quantum error correction"]);
  const page = "Cookie preferences. We use cookies to improve your experience on this website.";
  assert.deepEqual(bestPassages(page, terms, idf), []);
});
