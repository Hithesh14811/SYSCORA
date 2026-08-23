// DECIDING WHICH RESULTS ARE ACTUALLY ABOUT THE QUESTION.
//
// Fusing several engines' rankings (see web-search.js) fixed recall and made
// poisoning WORSE, which is a result worth stating plainly. Measured 23 Aug 2026
// over twelve queries: hit@8 went 67% → 92% and MRR 0.67 → 0.81, while poison@3
// — a known wrong turn in the top three — went 17% → 33%.
//
// The reason is structural. Reciprocal Rank Fusion scores a page by the ranks it
// was given, and a page ONE engine put first scores exactly the same as a page a
// different engine put first. So when Bing answers "best laptops of 2026" with
// the dictionary definition of "best", fusion cannot tell that apart from
// PCMag's laptop roundup: both are somebody's rank 1. Agreement lifts the good
// results, and nothing pushes the bad one down.
//
// What pushes it down is READING IT. "BEST Definition & Meaning" is not about
// laptops and does not mention 2026, and that is knowable from the title and the
// engine's own snippet without fetching anything.
//
// THE ORDER OF SPENDING, WHICH IS THE WHOLE DESIGN
//
//   1. Consensus is free. Two independent indexes agreeing is strong evidence
//      and it is already computed.
//   2. Lexical relevance is nearly free. Title and snippet are in hand; scoring
//      them costs microseconds and no network.
//   3. Reading the page costs ~500ms and someone else's bandwidth. So it is
//      spent ONLY on candidates that have neither of the first two — a result
//      one engine returned whose title and snippet do not obviously answer the
//      question. That is usually one or two per search, not eight.
//
// This is the part a hosted search API cannot do at its price point. Tavily,
// OpenAI and Anthropic sell search as an API and must answer any client in one
// round trip for well under a cent; they cannot fetch candidate pages per query
// to check them. We are in-process on the user's machine, where bandwidth is
// free and the only thing that costs real money is model tokens.

// Words that appear in almost every English document carry no information about
// which document is wanted. Deliberately short: a stoplist that grows starts
// eating the words that matter — "how" and "vs" and "not" are the whole question
// in "how to stop windows 11" and "postgres vs mysql".
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "to", "was", "were", "will", "with", "i", "my",
  "me", "can", "do", "does", "did", "you", "your"
]);

/**
 * A document's terms.
 *
 * Numbers are KEPT and never stopped. "2026", "11", "17" are the most
 * discriminative tokens in half the queries this sees — "windows 11" and
 * "windows 10" are different questions, and "iphone 17" is the whole point.
 */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    // Keep digits attached to letters: "v24", "17pro" and "j-1" are single terms
    // and splitting them loses the query.
    .split(/[^a-z0-9+#.]+/)
    .map((term) => term.replace(/^[.]+|[.]+$/g, ""))
    .filter((term) => term.length > 0 && term.length < 40);
}

/**
 * The terms of a query that are worth matching on.
 *
 * Light plural folding only. Real stemming would collapse "windows" to "window",
 * which is wrong here in the way that matters — the operating system and a pane
 * of glass are not the same term, and this index is full of both.
 */
export function queryTerms(query) {
  const terms = tokenize(query).filter((term) => !STOPWORDS.has(term));
  return [...new Set(terms)];
}

// "laptops" in the query should match "laptop" on the page, and vice versa. A
// term matches a document if the document contains it or its singular/plural.
function variantsOf(term) {
  const variants = new Set([term]);
  if (term.length > 3) {
    if (term.endsWith("ies")) variants.add(`${term.slice(0, -3)}y`);
    else if (term.endsWith("es")) variants.add(term.slice(0, -2));
    if (term.endsWith("s")) variants.add(term.slice(0, -1));
    else {
      variants.add(`${term}s`);
      variants.add(`${term}es`);
    }
  }
  return [...variants];
}

/**
 * How rare each query term is ACROSS THE CANDIDATES THIS SEARCH RETURNED.
 *
 * Not a global corpus statistic — a local one, and it is better than a global
 * one for this job. Asked "best laptops of 2026", every candidate's title
 * contains "best", so "best" tells us nothing about which of them to prefer,
 * while "laptops" separates the reviews from the dictionaries. Computed from the
 * result set itself, that falls out automatically and needs no corpus to ship,
 * keep current, or be wrong about a new word.
 */
export function inverseFrequencies(terms, documents) {
  const total = Math.max(1, documents.length);
  const idf = new Map();
  for (const term of terms) {
    const variants = variantsOf(term);
    const seenIn = documents.filter((document) => variants.some((variant) => document.includes(variant))).length;
    // Smoothed, and floored above zero so that a term every candidate shares
    // still counts for a little rather than dropping out of the query entirely.
    idf.set(term, Math.log((total + 1) / (seenIn + 1)) + 0.35);
  }
  return idf;
}

// Term frequency, saturating. The tenth mention of a word does not make a page
// ten times more relevant — it usually means the page is long. This is BM25's
// saturation with k1 = 1.2, which is the value everyone uses because it works.
const saturate = (count) => (count * 2.2) / (count + 1.2);

function countTerm(haystackTerms, term) {
  const variants = variantsOf(term);
  let count = 0;
  for (const candidate of haystackTerms) if (variants.includes(candidate)) count += 1;
  return count;
}

/**
 * How well one candidate answers the query, from 0 to 1.
 *
 * Fields are weighted: a term in the TITLE is much stronger evidence than the
 * same term buried in a page, because a title is what the page claims to be
 * about. The URL counts a little — "/dictionary/best" and
 * "/picks/the-best-laptops" both say what they are.
 *
 * Returns a fraction of the total available weight, so it is comparable between
 * queries of different lengths.
 */
export function relevanceOf({ title = "", snippet = "", url = "", text = "" }, terms, idf) {
  if (terms.length === 0) return 1;
  const fields = [
    { terms: tokenize(title), weight: 3 },
    { terms: tokenize(snippet), weight: 1.5 },
    // The path only. The hostname would score "python.org" full marks for the
    // term "python" on every page it serves, including its download page.
    { terms: tokenize(String(url).replace(/^https?:\/\/[^/]+/i, "")), weight: 1 },
    { terms: tokenize(text).slice(0, 4000), weight: 1.2 }
  ].filter((field) => field.terms.length > 0);

  let score = 0;
  let available = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 1;
    available += weight * fields.reduce((total, field) => total + field.weight, 0);
    for (const field of fields) {
      const count = countTerm(field.terms, term);
      if (count > 0) score += weight * field.weight * (saturate(count) / 2.2);
    }
  }
  return available > 0 ? Math.min(1, score / available) : 0;
}

// READING CANDIDATE PAGES TO RERANK THEM WAS BUILT, MEASURED, AND REMOVED.
//
// It is the obvious next idea and it is the thing a paid search API cannot
// afford to do, so it looked like the whole advantage. It was written twice and
// measured both times, twelve queries × two runs, against the ranking that only
// reads titles and snippets:
//
//                        hit@1   hit@3   hit@8   poison@3   latency
//   titles and snippets    79%     88%     96%        0%      942ms
//   + reading, promoting   63%     75%     83%        8%     1895ms
//   + reading, burying     79%     88%     88%       13%     1754ms
//
// It never once helped, and it doubled the latency. The reason is worth keeping
// because it is not obvious: a long page matches query terms BY ACCIDENT. Fifty
// kilobytes of navigation, related-searches blocks, tag clouds and advertising
// will contain "laptops" and "2026" somewhere whatever the page is about — so
// reading a page mostly adds noise, and the pages selected for reading were by
// construction the doubtful ones. Restricting the read to demotion only did not
// rescue it either.
//
// What was already doing the work: consensus between independent indexes, plus a
// title, a snippet and a URL scored with frequencies computed from this search's
// own candidates. All of it free, all of it instant.
//
// DO NOT ADD IT BACK WITHOUT RUNNING `node scripts/bench-search.mjs --repeat 3`
// FIRST. It is a plausible idea that costs a second of latency and pays nothing.

/**
 * Re-order fused results by what they are actually about.
 *
 * Returns the results re-ordered, each carrying `relevance` and `support`, so
 * that WHY a result is where it is stays inspectable rather than becoming a
 * number nobody can argue with.
 */
export function rerank(query, results) {
  const terms = queryTerms(query);
  if (terms.length === 0 || results.length === 0) return results;

  // The local corpus: what every candidate says about itself. Cheap, and it is
  // what makes "best" count for less than "laptops" on this particular query.
  const documents = results.map((result) => `${result.title} ${result.snippet ?? ""} ${result.url}`.toLowerCase());
  const idf = inverseFrequencies(terms, documents);

  const scored = results.map((result) => ({
    ...result,
    support: result.foundBy?.length ?? 1,
    relevance: relevanceOf(result, terms, idf)
  }));

  // The fused score, tilted by how well each candidate answers the question.
  // MULTIPLICATIVE rather than additive, so relevance modulates the engines'
  // opinion instead of overruling it — the engines know about authority,
  // freshness and popularity, none of which any amount of word matching here can
  // see. The 0.45 floor is what stops a page with a terse title being buried for
  // saying little about itself.
  return [...scored].sort((left, right) =>
    (right.score * (0.45 + right.relevance)) - (left.score * (0.45 + left.relevance)));
}

/**
 * The parts of a page that answer the question.
 *
 * WHY THIS EXISTS. Watched live on 23 Aug 2026, a price comparison cost five
 * tool calls and 59,980 tokens: search, then web_open four times, each a fresh
 * round trip through the model with the whole prompt behind it. The pages
 * themselves were 15,000 tokens apiece of navigation, footers and cookie notices
 * wrapped around two sentences that mattered.
 *
 * Returning the matching passages instead turns that into one round trip and a
 * few hundred tokens a page — cheaper in the currency that actually costs money
 * here, which is model tokens and not HTTP.
 */
export function bestPassages(text, terms, idf, { count = 2, chars = 320 } = {}) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 40);
  if (lines.length === 0) return [];

  const scoredLines = lines.map((line, index) => {
    const lineTerms = tokenize(line);
    let score = 0;
    for (const term of terms) {
      const found = countTerm(lineTerms, term);
      if (found > 0) score += (idf.get(term) ?? 1) * saturate(found);
    }
    // Per word, so a long paragraph does not win merely by containing more
    // words than a sentence that answers the question outright.
    return { index, line, score: score / Math.sqrt(Math.max(8, lineTerms.length)) };
  });

  const picked = [];
  for (const candidate of [...scoredLines].sort((left, right) => right.score - left.score)) {
    if (picked.length >= count || candidate.score <= 0) break;
    // Not two passages from the same paragraph — they say the same thing twice
    // and the second one is paid for.
    if (picked.some((chosen) => Math.abs(chosen.index - candidate.index) < 2)) continue;
    picked.push(candidate);
  }

  return picked
    .sort((left, right) => left.index - right.index)
    .map((chosen) => (chosen.line.length > chars ? `${chosen.line.slice(0, chars).trimEnd()}…` : chosen.line));
}

