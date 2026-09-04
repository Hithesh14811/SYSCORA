// Numbers, in the same shape wherever they are printed — renderer half.
//
// THE SAME THREE LINES AS `packages/shared-types/src/format.js`, AND THEY ARE
// DUPLICATED DELIBERATELY. This file is loaded by the browser from the daemon's
// static route, which serves the desktop directory and refuses every path
// outside it (`server.js`: `if (!staticPath.startsWith(desktopRoot))`). Reaching
// into `packages/` from here would mean widening that check, which is a security
// boundary worth far more than three deduplicated lines.
//
// The defect both halves exist to prevent: `(150285).toLocaleString()` with no
// locale uses the MACHINE's, so on an en-IN machine a token count printed in the
// middle of an English sentence came out as `1,50,285`.
//
// Change one, change the other. `tests/unit/number-format.test.js` fails if the
// two ever disagree.
export const DISPLAY_LOCALE = "en-GB";

/** A count a person will read: `150,285`, never `1,50,285`. */
export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(DISPLAY_LOCALE) : String(value);
}
