// WHAT SURVIVES THE JOURNEY TO A SCREENSHOT.
//
// `content-boundary.js` records that a Unicode tag character is invisible to a
// screenshot-reading monitor "at any resolution, because a character that renders
// as nothing is not in a screenshot". That sentence is an argument. This file is
// the part that can be MEASURED, and the measurement is the interesting half:
// it lets the same detector be run twice over the same payload, once on what the
// accessibility tree returns and once on what a camera pointed at the screen
// would have captured, with nothing else changed.
//
// WHY THAT SHAPE AND NOT "OUR RULES AGAINST A VISION MODEL". Comparing this
// codebase's seven rules to somebody's VLM measures two things at once — the
// detector and the modality — and a reviewer cannot tell which one moved. Holding
// the detector fixed and projecting the INPUT isolates the modality, which is the
// only variable anyone should care about here. It also means the blind spot comes
// out as a property of the channel rather than as a score: a payload whose
// projection is empty carries no evidence for ANY screenshot reader, however good,
// and that is a stronger statement than a recall number.
//
// THE PROJECTION IS FIRST-ORDER AND SAYS SO. Real rasterisation is font shaping,
// the full Unicode Bidirectional Algorithm, and a layout engine. This models the
// character-level channel only: which code points contribute no glyph, and the
// one reordering case that an actual attack depends on. Everything above the
// character level — `display:none`, a 1px font, white-on-white, a control pushed
// off the viewport, text baked into an image — is NOT derivable from the string
// and must be declared by whoever writes the case. `projectionIsDerivable()`
// exists so a corpus cannot quietly get that wrong.

/**
 * Code points that occupy no space and draw no mark of their own.
 *
 * Deliberately WIDER than `content-boundary.js`'s detection set, and the
 * difference is the point. That file excludes U+200C and U+200D because they are
 * required letters in Hindi, Marathi and Persian and flagging them would break
 * ordinary text — a detection decision. This file is not detecting anything: a
 * ZWNJ genuinely does not reach the screen as a glyph, so a projection that kept
 * it would be lying about the channel in order to be polite about the language.
 */
const NO_GLYPH = new RegExp(
  "[" +
  "\\u{E0000}-\\u{E007F}" + // tag characters, the ASCII mirror
  "\\u200B\\u200C\\u200D\\u2060\\uFEFF" + // zero-width space, ZWNJ, ZWJ, word joiner, BOM
  "\\u00AD" + // soft hyphen: a line-break hint, not a mark
  "\\u{FE00}-\\u{FE0F}" + // variation selectors
  "\\u180E" + // Mongolian vowel separator
  "]",
  "gu"
);

// The bidi controls that vanish but change what is drawn around them. They are
// separated from NO_GLYPH because deleting them is not enough: U+202E reverses
// the run that follows it, which is the entire mechanism behind the spoofed
// filename ("...cod.exe" shown as "...exe.doc"). A projection that merely dropped
// it would report the attacker's raw string as what a person saw, which is the
// opposite of what happened.
const RTL_OVERRIDE = /‮/;
const OTHER_BIDI = /[‪-‭⁦-⁩؜‎‏]/g;

/**
 * What a screenshot of this string would contain, as text.
 *
 * @param {string} text The string as the accessibility tree returns it.
 * @returns {string} The glyphs a reader would actually see, in display order.
 */
export function visibleProjection(text) {
  let body = String(text ?? "");
  // Reordering first: once the control characters are stripped there is nothing
  // left to say which run was reversed.
  if (RTL_OVERRIDE.test(body)) {
    body = body
      .split("\n")
      .map((line) => {
        const at = line.search(RTL_OVERRIDE);
        if (at < 0) return line;
        // First-order: everything after the override is drawn right-to-left, so
        // it appears reversed. Real bidi resolves per directional run and would
        // leave embedded Latin words readable; this is the approximation the
        // spoofing attack itself relies on, and the corpus may override it.
        const before = line.slice(0, at);
        const after = line.slice(at + 1).replace(RTL_OVERRIDE, "");
        return before + [...after].reverse().join("");
      })
      .join("\n");
  }
  return body.replace(OTHER_BIDI, "").replace(NO_GLYPH, "");
}

/**
 * How much of this string never reaches the screen.
 *
 * Reported alongside a detection result so a row in the matrix can be read
 * without trusting the projection: a case claiming a screenshot blind spot should
 * show a large hidden fraction, and one that does not is a corpus bug.
 */
export function projectionStats(text) {
  const body = String(text ?? "");
  const seen = visibleProjection(body);
  const hiddenChars = Math.max(0, body.length - seen.length);
  return {
    rawChars: body.length,
    visibleChars: seen.length,
    hiddenChars,
    hiddenFraction: body.length === 0 ? 0 : hiddenChars / body.length,
    // The strongest single cell in the matrix: nothing at all survived, so no
    // screenshot reader can have seen anything, independent of its recall.
    rendersToNothing: body.trim().length > 0 && seen.trim().length === 0
  };
}

/**
 * May this case's screenshot view be COMPUTED, or must the author declare it?
 *
 * A corpus that lets the harness derive `pixels` for a `display:none` case would
 * score that case as fully visible and quietly turn the paper's central claim
 * upside down. Presentation-level hiding leaves no trace in the string, so the
 * only safe rule is that the harness derives nothing it cannot see evidence for.
 */
export function projectionIsDerivable(kind) {
  return DERIVABLE_KINDS.has(String(kind ?? "").trim());
}

// Character-level channels only. Anything whose hiding lives in CSS, in layout,
// in a bitmap or in an ARIA attribute must ship its own `pixels` field.
const DERIVABLE_KINDS = new Set(["unicode-tag", "zero-width", "bidi-override", "plain-visible", "benign"]);

export const PROJECTION_KINDS = Object.freeze([...DERIVABLE_KINDS]);
