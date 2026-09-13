// A CLOCK IS NOT A CHANGE.
//
// A media player advances its position readout between any two screen readings,
// so the line-diff that feeds `screenUnchanged` says "something changed" forever.
// That disables BOTH of the agent loop's convergence guards at once:
//
//   unchangedReadings never increments   -> the nudge at 3 and the stop at 8
//                                           can never fire
//   screenChangedSinceLastCall is true   -> callCounts.clear() runs constantly,
//     on every reading                      so the repeat guard never reaches 3
//
// Measured live on 8 Sep 2026 — "play ankhe khuli ho ya ho bandh". Readings
// differed only by `0:26` -> `0:36` -> `0:43`. The run clicked the same row three
// times, spent 15 steps, 193 seconds and 256,755 tokens, and ended only because
// the user pressed stop.
//
// The other half of this file is the half that decides whether the fix is safe:
// a CHANGING NUMBER is still a change. Calculator's whole output is digits, and
// a volume going 20% to 40% is the thing somebody is looking for.

import test from "node:test";
import assert from "node:assert/strict";

import { countSubstantiveChanges } from "../../packages/fast-agent/src/tools.js";

test("a ticking playback position is not a substantive change", () => {
  const before = [
    '0| window "Spotify"',
    '42| text "0:26" @651,1350',
    '116| dataitem "Aankhein Khuli Ho Ya Ho Band" @687,1274'
  ];
  const after = [
    '0| window "Spotify"',
    '42| text "0:36" @651,1350',
    '116| dataitem "Aankhein Khuli Ho Ya Ho Band" @687,1274'
  ];
  assert.equal(countSubstantiveChanges(before, after), 0);
});

test("an hour-long position is a clock too", () => {
  assert.equal(
    countSubstantiveChanges(['21| text "1:02:14"'], ['21| text "1:07:59"']),
    0
  );
});

test("A CHANGING NUMBER IS STILL A CHANGE — this is what keeps the fix safe", () => {
  // Calculator's display. If this ever returns 0, an agent doing arithmetic can
  // never tell that it worked, which is far worse than the bug being fixed.
  assert.ok(countSubstantiveChanges(['5| text "5"'], ['5| text "12"']) > 0);
  // A volume readout — the thing a volume request is looking for.
  assert.ok(countSubstantiveChanges(['9| text "Volume 20%"'], ['9| text "Volume 40%"']) > 0);
  // A file count, a page number, a badge.
  assert.ok(countSubstantiveChanges(['3| text "2 items"'], ['3| text "3 items"']) > 0);
});

test("a real change alongside a ticking clock is still a change", () => {
  // The case that matters most: the clock must not MASK something real.
  const before = ['42| text "0:26"', '99| text "Now playing: Aankhein Khuli"'];
  const after = ['42| text "0:36"', '99| text "Now playing: Are Re Are"'];
  assert.ok(countSubstantiveChanges(before, after) > 0);
});

test("a control appearing or disappearing is a change", () => {
  assert.ok(countSubstantiveChanges(['1| text "0:26"'], ['1| text "0:36"', '2| button "Pause"']) > 0);
  assert.ok(countSubstantiveChanges(['1| text "0:26"', '2| button "Pause"'], ['1| text "0:36"']) > 0);
});

test("two identical readings are unchanged, clock or no clock", () => {
  assert.equal(countSubstantiveChanges(['1| text "hello"'], ['1| text "hello"']), 0);
  assert.equal(countSubstantiveChanges([], []), 0);
});

test("a time inside an otherwise different line does not hide that line", () => {
  assert.ok(countSubstantiveChanges(
    ['7| text "Downloading 0:30 remaining"'],
    ['7| text "Installing 0:30 remaining"']
  ) > 0);
});

test("a bare four-digit year or a price is not mistaken for a clock", () => {
  assert.ok(countSubstantiveChanges(['1| text "2025"'], ['1| text "2026"']) > 0);
  assert.ok(countSubstantiveChanges(['1| text "12.50"'], ['1| text "13.50"']) > 0);
});
