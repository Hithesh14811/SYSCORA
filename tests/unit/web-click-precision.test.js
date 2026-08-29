// "NEW YORK, USA" CLICKED "NIAGARA FALLS, NEW YORK, USA". TWICE.
//
// Measured live, 28 Aug 2026, on Google Flights. `findBest` scored candidates by
// COVERAGE ALONE — how many of the requested words appear in the candidate, with
// no penalty whatever for the candidate carrying extra words of its own. So a
// row that happens to repeat your words plus some of its own scored as well as
// the row you asked for, and the tie-break preferred the LONGER label, which is
// precisely the wrong way round.
//
// A wrong click on a web page NAVIGATES. The second one took the run to a
// Mysuru→Hyderabad search and it never recovered: 335,558 tokens, no flight.
//
// Two fixes, both held here:
//   - score by F1 (precision AND recall), so extra words cost something;
//   - REFUSE a close call and name the candidates, the way desktop `click`
//     already does, instead of silently picking one and navigating.

import test from "node:test";
import assert from "node:assert/strict";

// The scoring is written as a string of JS inside an _evaluate call, so it is
// exercised here the way the page runs it: same algorithm, real candidates.
function scoreCandidates(requested, labels) {
  const tokens = (value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((x) => x.length >= 2) || [];
  const wanted = [...new Set(tokens(requested))];
  const scored = labels.map((label) => {
    const actual = new Set(tokens(label));
    const hits = wanted.filter((token) => actual.has(token)).length;
    const recall = wanted.length ? hits / wanted.length : 0;
    const precision = actual.size ? hits / actual.size : 0;
    const score = (recall + precision) ? (2 * recall * precision) / (recall + precision) : 0;
    return { label, recall, score };
  });
  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
  return scored;
}

const NEW_YORK = "New York, USA City in New York State";
const PAGE = [
  "New York, USA City in New York State",
  "Niagara Falls, New York, USA",
  "John F. Kennedy International Airport JFK",
  "Newark Liberty International Airport EWR"
];

test("the exact option beats a longer one that merely contains the words", () => {
  const ranked = scoreCandidates(NEW_YORK, PAGE);
  assert.equal(
    ranked[0].label, NEW_YORK,
    `asked for ${JSON.stringify(NEW_YORK)} and the top match was ${JSON.stringify(ranked[0].label)}`
  );
});

test("the old coverage-only score is what got this wrong", () => {
  // The defect, reproduced: under recall alone, "Niagara Falls, New York, USA"
  // is a legitimate 0.5 and clears the 0.5 floor the tool used. Precision is
  // what separates them — it carries two words nobody asked for.
  const ranked = scoreCandidates(NEW_YORK, PAGE);
  const niagara = ranked.find((row) => row.label.startsWith("Niagara"));
  assert.ok(niagara.recall >= 0.5, "recall alone would have let it through the old 0.5 floor");
  assert.ok(
    niagara.score < ranked[0].score,
    "and F1 must rank it below the option that was actually asked for"
  );
});

test("a container swallowing every option cannot win", () => {
  // The other shape of the same bug: a wrapper whose innerText is the whole
  // dropdown contains every requested word, so it scored a perfect recall of 1.0
  // and then won the tie-break for being longest.
  const wrapper = PAGE.join(" ");
  const ranked = scoreCandidates(NEW_YORK, [...PAGE, wrapper]);
  assert.equal(ranked[0].label, NEW_YORK, "the wrapper must not outrank the real option");
});

test("shorter wins a genuine tie", () => {
  const ranked = scoreCandidates("Sign in", ["Sign in", "Sign in to your account to continue"]);
  assert.equal(ranked[0].label, "Sign in");
});

// ---- the refusal --------------------------------------------------------

// Mirrors the margin rule in web_click: two candidates within 0.15 of each other
// are a question, not a coin toss.
const wouldRefuse = (ranked) => {
  const best = ranked[0];
  const runnerUp = ranked[1];
  return Boolean(runnerUp && (best.score - runnerUp.score) < 0.15 && runnerUp.label !== best.label);
};

test("two genuinely similar rows are refused rather than guessed", () => {
  // A real one, from Spotify's share menu. Both carry every requested word and
  // exactly one word of their own, so they score identically — and they do
  // completely different things. "Play" vs "Play all" is NOT this case: F1
  // separates those cleanly and refusing there would make the refusal the new
  // problem.
  const ranked = scoreCandidates("Copy link", ["Copy link to Song", "Copy link to Album"]);
  assert.ok(
    wouldRefuse(ranked),
    `two equally-good, differently-acting rows must be handed back: ${JSON.stringify(ranked.slice(0, 2))}`
  );
});

test("an exact label is not refused just because a longer variant exists", () => {
  // The counter-case to the one above, and the reason the margin is on SCORE
  // rather than on label similarity.
  const ranked = scoreCandidates("Play", ["Play", "Play all"]);
  assert.equal(ranked[0].label, "Play");
  assert.equal(wouldRefuse(ranked), false, "an exact match must not be blocked by a longer near-miss");
});

test("a clear winner is not refused", () => {
  // Almost every click. The refusal must be rare or it becomes the new problem.
  const ranked = scoreCandidates(NEW_YORK, PAGE);
  assert.equal(wouldRefuse(ranked), false, "an exact match with a weak second place must go straight through");
});
