// Numbers, in the same shape wherever they are printed.
//
// `(150285).toLocaleString()` USES THE MACHINE'S LOCALE, AND THAT IS A BUG.
//
// Observed live, 1 Sep 2026, in a sentence a user actually read: "this request
// has cost 1,50,285 billed tokens, which is the ceiling I run under
// (1,50,000)". That is the Indian digit grouping — lakh, not thousand — because
// this machine's locale is en-IN and nothing named a locale. The rest of the
// product is written in en-GB, so one number in a paragraph of English was
// grouped by a different convention from every other number beside it.
//
// It is worse than cosmetic in two specific ways:
//
//   the same build prints different text on different machines, so a bug report
//   quoting a number cannot be matched against a transcript;
//
//   the eval asserts on rendered sentences, so a suite that passes on a
//   developer's machine can fail on a user's for reasons that have nothing to
//   do with the agent.
//
// So the locale is NAMED, once, here. en-GB because that is the language the
// product's prose is written in — the point is that it is fixed and stated, not
// that it is British.
//
// THERE IS A SECOND COPY OF THIS IN `apps/desktop/format.js`, ON PURPOSE. The
// daemon serves static files only from the desktop directory and refuses
// anything outside it, which is a security boundary worth more than three
// deduplicated lines. Change one, change the other; the tests pin both.
export const DISPLAY_LOCALE = "en-GB";

/** A count a person will read: `150,285`, never `1,50,285`. */
export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(DISPLAY_LOCALE) : String(value);
}
