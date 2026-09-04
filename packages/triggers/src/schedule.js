// WHEN DOES THIS FIRE NEXT?
//
// Five-field cron, in the machine's LOCAL time, because "every weekday at 9am"
// means nine in the morning where the user is sitting and nothing else.
//
//   minute  hour  day-of-month  month  day-of-week
//   0-59    0-23  1-31          1-12   0-6 (0 = Sunday, 7 also accepted)
//
// Each field takes `*`, a number, a range `a-b`, a list `a,b,c`, or a step
// `*/n` / `a-b/n`. That is the whole grammar; anything else is refused with a
// reason rather than silently treated as `*`, which is how a typo becomes a job
// that runs every minute forever.
//
// WHY A SCAN AND NOT ARITHMETIC. The next firing is found by walking forward one
// minute at a time and testing each. Closed-form date arithmetic over cron is
// where every implementation of this hides its bugs — month lengths, leap years,
// and the day-of-month/day-of-week rule below all interact. The scan is
// obviously correct by construction and costs about 1,440 iterations for a daily
// job; it is bounded at a year, and a schedule with no firing inside a year (
// `0 0 30 2 *` — the 30th of February) returns null rather than spinning.
//
// THE ONE RULE THAT SURPRISES EVERYONE, AND IT IS REAL CRON BEHAVIOUR: when BOTH
// day-of-month and day-of-week are restricted, a day matches if EITHER matches —
// not both. `0 9 1 * 1` is "the 1st, and also every Monday", not "Mondays that
// fall on the 1st". When only one of the two is restricted, only that one is
// consulted. Getting this backwards silently makes a weekday schedule fire on
// weekends, so it is tested both ways.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 6 }
];

// A year of minutes. Long enough for any real schedule, short enough that an
// impossible one gives up promptly.
const SCAN_LIMIT_MINUTES = 366 * 24 * 60;

function parseField(raw, { name, min, max }) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error(`the ${name} field is empty`);
  const allowed = new Set();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`the ${name} field has an empty item in its list`);
    const [rangeText, stepText] = piece.split("/");
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) throw new Error(`"${piece}" is not a valid step in ${name}`);
    }
    let low;
    let high;
    if (rangeText === "*") {
      low = min;
      high = max;
    } else if (rangeText.includes("-")) {
      const [lowText, highText] = rangeText.split("-");
      low = Number(lowText);
      high = Number(highText);
    } else {
      low = Number(rangeText);
      // A bare number with a step means "from here to the end of the field",
      // which is what every cron implementation does with `5/10`.
      high = stepText === undefined ? low : max;
    }
    if (!Number.isInteger(low) || !Number.isInteger(high)) throw new Error(`"${piece}" is not a number in ${name}`);
    // Sunday is 0 and is also written 7. Accept both, store 0.
    if (name === "dayOfWeek") {
      if (low === 7) low = 0;
      if (high === 7) high = 0;
    }
    if (low < min || high > max || low > high) {
      throw new Error(`"${piece}" is outside ${min}-${max} in ${name}`);
    }
    for (let value = low; value <= high; value += step) allowed.add(value);
  }
  return allowed;
}

/**
 * Parse a cron expression, or throw with the reason.
 *
 * @returns {{minute:Set<number>,hour:Set<number>,dayOfMonth:Set<number>,month:Set<number>,dayOfWeek:Set<number>,
 *   restrictsDayOfMonth:boolean,restrictsDayOfWeek:boolean}}
 */
export function parseCron(expression) {
  const parts = String(expression ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(
      `a cron expression has five fields (minute hour day-of-month month day-of-week); got ${parts.length}`
    );
  }
  const parsed = {};
  for (const [index, field] of FIELDS.entries()) {
    parsed[field.name] = parseField(parts[index], field);
  }
  // Kept so the day-of-month / day-of-week rule below can tell "restricted" from
  // "*", which is the whole difference between OR and AND.
  parsed.restrictsDayOfMonth = parts[2].trim() !== "*";
  parsed.restrictsDayOfWeek = parts[4].trim() !== "*";
  return parsed;
}

/** Is this expression usable? Returns the reason it is not, or null. */
export function cronProblem(expression) {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error.message;
  }
}

function matches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;
  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());
  // See the note at the top: OR when both are restricted, otherwise whichever
  // one is doing the restricting.
  if (parsed.restrictsDayOfMonth && parsed.restrictsDayOfWeek) return domMatch || dowMatch;
  if (parsed.restrictsDayOfMonth) return domMatch;
  if (parsed.restrictsDayOfWeek) return dowMatch;
  return true;
}

/**
 * The first firing strictly after `from`.
 *
 * STRICTLY AFTER is the whole reason a trigger does not fire twice. The runner
 * passes the last firing, so a job that ran at 09:00 is next due at 09:00
 * tomorrow rather than immediately again while the clock is still on 09:00.
 *
 * @returns {Date|null} null when nothing fires within a year.
 */
export function nextFireAfter(expression, from = new Date()) {
  const parsed = parseCron(expression);
  const cursor = new Date(from.getTime());
  // Move to the start of the next whole minute: seconds and milliseconds are not
  // part of the grammar and would otherwise make "fires at 09:00" depend on when
  // in the minute the question was asked.
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let scanned = 0; scanned < SCAN_LIMIT_MINUTES; scanned += 1) {
    if (matches(parsed, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** A sentence a person can check the schedule against. */
export function describeCron(expression) {
  const problem = cronProblem(expression);
  if (problem) return `not a usable schedule: ${problem}`;
  const next = nextFireAfter(expression);
  return next ? `next at ${next.toLocaleString()}` : "never fires within the next year";
}
