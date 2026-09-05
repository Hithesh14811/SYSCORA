// THE BIG CARD IS THE ANSWER, AND IT WAS LOSING TO THE ROWS BENEATH IT.
//
// Live, "play agar tum mil jao": Spotify carried on playing "Agar Tum Saath Ho"
// — a different song that happened to be playing already — and the run only
// recovered after the model read the screen, clicked the wrong row, hit an
// ambiguity refusal twice, and finally clicked by index. Nine steps, 147,358
// tokens, 39.9s, for one song.
//
// The tree below is the real one from that session. What matters in it:
//
//   60| dataitem "Agar Tum Mil Jao - Female Version"   @687,493   the card title
//   66| dataitem "Play"                                @1004,493  the card's action
//   68| dataitem "Play Agar Tum Mil Jao - Trending Version"  @362,719
//   78| dataitem "Play Agar Tum Mil Jao - Male Version"      @362,866
//   97| dataitem "Play Agar Tum Mil Jao - Male Version"      @362,1122  (a PLAYLIST)
//
// Spotify publishes the top-result card as a BARE "Play" beside the title, and
// the list rows as "Play <title>". Every row here carries all four query tokens,
// so a scorer that only counts tokens ties four ways and gives up — which is
// exactly what happened.

import test from "node:test";
import assert from "node:assert/strict";
import { spotifyPlayCandidate } from "../../os-adapters/windows/src/windows-adapter.js";

const box = (x, y, width = 40, height = 40) => ({ x, y, width, height });

const REAL_TREE = [
  { name: "Agar Tum Mil Jao - Female Version", controlType: "ControlType.DataItem", boundingRect: box(687, 493, 300, 40) },
  { name: "Song • Roop Kumar Rathod, Anu Malik, Shreya Ghoshal, Sayeed Quadri", controlType: "ControlType.DataItem", boundingRect: box(711, 553, 400, 30) },
  { name: "Play", controlType: "ControlType.DataItem", boundingRect: box(1004, 493) },
  { name: "Play Agar Tum Mil Jao - Trending Version", controlType: "ControlType.DataItem", boundingRect: box(362, 719, 300, 40) },
  { name: "Song • Shreya Ghoshal, Roop Kumar Rathod, Anu Malik, Sayeed Quadri", controlType: "ControlType.DataItem", boundingRect: box(679, 767, 400, 30) },
  { name: "Play Agar Tum Mil Jao - Male Version", controlType: "ControlType.DataItem", boundingRect: box(362, 866, 300, 40) },
  { name: "Song • Roop Kumar Rathod, Anu Malik, Udit Narayan, Sayeed Quadri", controlType: "ControlType.DataItem", boundingRect: box(679, 892, 400, 30) },
  { name: "Pause Agar Tum Saath Ho", controlType: "ControlType.DataItem", boundingRect: box(362, 994, 300, 40) },
  { name: "Play Agar Tum Mil Jao - Male Version", controlType: "ControlType.DataItem", boundingRect: box(362, 1122, 300, 40) },
  { name: "Playlist • Suchismita Nayak", controlType: "ControlType.DataItem", boundingRect: box(602, 1148, 300, 30) },
  { name: "Play Agar Tum Mil Jao", controlType: "ControlType.DataItem", boundingRect: box(362, 1250, 300, 40) }
];

test("the top-result card wins over the rows that tie with it", () => {
  const chosen = spotifyPlayCandidate(REAL_TREE, "Agar Tum Mil Jao");
  assert.ok(chosen, "four rows tie on tokens; without a tie-break this gives up and the song never plays");
  assert.equal(chosen.name, "Play", "the card's action is a BARE Play beside the title");
  assert.equal(chosen.boundingRect.x, 1004);
  assert.equal(chosen.boundingRect.y, 493);
});

// The tie-break must not become "always prefer a bare Play". When there is no
// card, the row that actually names the track is still the right answer.
test("with no card, the named row still wins", () => {
  // "Agar Tum Saath Ho" appears in the real tree only as a PAUSE row (it is the
  // track already playing), so this asks for one that has a real Play row and
  // removes the card, leaving the rows to be told apart on their names alone.
  const rowsOnly = REAL_TREE.filter((element) => element.name !== "Play");
  const chosen = spotifyPlayCandidate(rowsOnly, "Agar Tum Mil Jao Trending Version");
  assert.ok(chosen);
  assert.match(chosen.name, /Trending Version/);
});

// A bare "Play" that is nowhere near the requested title is some other card, and
// preferring it would be worse than the tie it replaced.
test("a bare Play far from the title does not win", () => {
  const elsewhere = [
    { name: "Agar Tum Mil Jao - Female Version", controlType: "ControlType.DataItem", boundingRect: box(687, 493, 300, 40) },
    { name: "Play", controlType: "ControlType.DataItem", boundingRect: box(1004, 3200) },
    { name: "Play Agar Tum Mil Jao - Male Version", controlType: "ControlType.DataItem", boundingRect: box(362, 866, 300, 40) },
    { name: "Song • Roop Kumar Rathod, Udit Narayan", controlType: "ControlType.DataItem", boundingRect: box(679, 892, 400, 30) }
  ];
  const chosen = spotifyPlayCandidate(elsewhere, "Agar Tum Mil Jao");
  assert.ok(chosen);
  assert.match(chosen.name, /Male Version/, "the far-away bare Play belongs to something else");
});

// A row already playing is a Pause, never a Play — clicking it would STOP the
// music, which is the opposite of what was asked.
test("a Pause row is never chosen", () => {
  const chosen = spotifyPlayCandidate(REAL_TREE, "Agar Tum Saath Ho");
  assert.ok(!chosen || !/^Pause/.test(chosen.name), "clicking Pause would stop the music");
});

// THE CAP THAT SILENTLY LOST SONGS.
//
// `spotifyQueryTokens` keeps eight words, which is right for a QUERY and wrong
// for the text being searched — and it was used for both. What sits nearest a
// Spotify row is the artist line above it, so on the real tree the row
// "Play Agar Tum Mil Jao - Trending Version" had its neighbourhood truncated to
// "song roop kumar rathod anu malik shreya ghoshal", scored ZERO against the
// query, and was filtered out before ranking ever happened. Its own title was
// never reached.
//
// This is the deeper reason the local matcher chose wrong songs, and it is
// invisible from the outside: nothing errors, a row simply stops existing.
test("a row is not lost because its neighbours' names came first", () => {
  const noisy = [
    // Long artist lines, deliberately ahead of the row in reading order, each
    // easily eight words on its own.
    { name: "Song • Roop Kumar Rathod, Anu Malik, Shreya Ghoshal, Sayeed Quadri", controlType: "ControlType.DataItem", boundingRect: box(679, 660, 400, 30) },
    { name: "Play Only This One Matters", controlType: "ControlType.DataItem", boundingRect: box(362, 700, 300, 40) },
    { name: "Song • Another Long Artist Credit With Many Words Indeed Here", controlType: "ControlType.DataItem", boundingRect: box(679, 740, 400, 30) }
  ];
  const chosen = spotifyPlayCandidate(noisy, "Only This One Matters");
  assert.ok(chosen, "the row scored zero against its own title because the artist line filled the cap");
  assert.equal(chosen.name, "Play Only This One Matters");
});
