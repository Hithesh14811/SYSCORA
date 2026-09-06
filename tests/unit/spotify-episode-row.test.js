// IT PLAYED A PODCAST EPISODE INSTEAD OF THE SONG.
//
// Live, 6 Sep 2026: "play tum hi ho bandhu sakha tumhi song on spotify and send
// its link to amma on whatsapp". `play_music` was given
// "Tumhi Ho Bandhu Pritam Neeraj Shridhar Kavita Seth" and started
//
//   Tum Hi Ho Bandhu - Neeraj Shridhar   by "Top Hits Unpacked"
//
// which is a PODCAST EPISODE whose title repeats most of the query's words. The
// honesty layer caught it — `matchesTrackQuery` compared the live window title
// and reported REFUTED — and the model then read the screen and clicked the real
// song itself. Correct behaviour, four wasted steps.
//
// The tree below is the real one, captured with
// `node scripts/probe-spotify-rows.mjs "tumhi ho bandhu pritam neeraj shridhar
// kavita seth" --json`. Rows the ranker never sees have been dropped for
// readability; every element that decides the outcome is verbatim, including the
// left sidebar and the now-playing bar, because both were contaminating the
// scores.
//
// WHAT IT PINS, and each of these was a separate live defect:
//
//   1. an Episode row is never chosen for a song request
//   2. the now-playing bar's transport Play is never chosen — clicking it
//      resumes whatever is loaded, which is the wrong track by definition
//   3. the top-result card wins on its own metadata, not on its neighbours'

import test from "node:test";
import assert from "node:assert/strict";
import { spotifyPlayCandidate } from "../../os-adapters/windows/src/windows-adapter.js";

const box = (x, y, width, height) => ({ x, y, width, height });
const el = (name, controlType, x, y, width, height, value = null) =>
  ({ name, controlType: `ControlType.${controlType}`, value, boundingRect: box(x, y, width, height) });

const QUERY = "Tumhi Ho Bandhu Pritam Neeraj Shridhar Kavita Seth";

// The real search-results tree, top to bottom.
const REAL_TREE = [
  el("What do you want to play?", "ComboBox", 386, 18, 652, 96,
    "tumhi ho bandhu pritam neeraj shridhar kavita seth"),
  // The left navigation. Its rows carry the words "Songs" and "Playlist" and sit
  // within 1600px of every result, which is how they used to reach the scores.
  el("Main", "Group", 18, 130, 144, 968),
  el("Your Library", "DataGrid", 26, 360, 128, 512),
  el("Liked Songs", "Group", 26, 360, 128, 100),
  el("hithesh sys", "Group", 26, 488, 128, 100),
  el("hithesh mix", "Group", 26, 616, 128, 100),

  el("Search results", "DataGrid", 210, 258, 794, 7575),

  // 1. THE TOP RESULT — the card the user means by "the green card".
  el("Tum Hi Ho Bandhu", "Group", 210, 258, 794, 222),
  el("Tum Hi Ho Bandhu", "Hyperlink", 434, 290, 300, 40),
  el("Play", "DataItem", 876, 321, 48, 48),
  el("Play", "Button", 876, 321, 48, 48),
  el("Song • Pritam, Neeraj Shridhar, Kavita Seth", "DataItem", 434, 410, 400, 30),
  el("Song", "Text", 434, 410, 60, 30),
  el("Pritam", "Hyperlink", 521, 410, 80, 30),
  el("Neeraj Shridhar", "Hyperlink", 616, 410, 190, 30),
  el("Kavita Seth", "Hyperlink", 434, 448, 150, 30),

  // 2. A different song that shares one word.
  el("Bandhu 2.0 (From \"Cocktail 2\")", "Group", 210, 512, 794, 128),
  el("Play Bandhu 2.0 (From \"Cocktail 2\")", "Button", 234, 528, 48, 48),
  el("Song • Pritam, Kavita Seth, Neeraj Shridhar, Irshad Kamil", "DataItem", 354, 583, 400, 30),
  el("Song", "Text", 354, 583, 60, 30),

  // 3. THE PODCAST EPISODE THAT WAS PLAYED. Its title repeats the query almost
  //    exactly; only the row's own type label says what it really is.
  el("Tum Hi Ho Bandhu - Neeraj Shridhar", "Group", 210, 640, 794, 220),
  el("Tum Hi Ho Bandhu - Neeraj Shridhar", "Hyperlink", 354, 660, 400, 40),
  el("Play Tum Hi Ho Bandhu - Neeraj Shridhar", "DataItem", 234, 675, 48, 48),
  el("Play Tum Hi Ho Bandhu - Neeraj Shridhar", "Button", 234, 675, 48, 48),
  el("Episode • Top Hits Unpacked", "DataItem", 354, 752, 400, 30),
  el("Episode", "Text", 354, 752, 80, 30),
  el("Top Hits Unpacked", "Hyperlink", 477, 752, 200, 30),
  el("4 min 36 sec", "Text", 324, 806, 140, 30),

  // 4. Another song, sharing two words.
  el("Tum Ho", "Group", 210, 860, 794, 128),
  el("Play Tum Ho", "Button", 234, 876, 48, 48),
  el("Song • Mohit Chauhan, Suzanne D'Mello", "DataItem", 354, 931, 400, 30),
  el("Song", "Text", 354, 931, 60, 30),

  // 5. THE NOW-PLAYING BAR. Its Play button is a bare "Play" and the track
  //    already loaded was this very song, so its neighbourhood matched seven of
  //    the eight query tokens — it is what the old ranker actually returned.
  el("Now playing bar", "Group", 18, 1114, 1594, 144),
  el("Now playing: Tum Hi Ho Bandhu by Pritam, Neeraj Shridhar, Kavita Seth", "Hyperlink", 1084, 791, 500, 40),
  el("Player controls", "Group", 496, 1129, 638, 114),
  el("Play", "Button", 783, 1129, 48, 48)
];

const chosenAt = (tree, query) => {
  const chosen = spotifyPlayCandidate(tree, query);
  if (!chosen) return null;
  return { name: chosen.name, x: chosen.boundingRect.x, y: chosen.boundingRect.y };
};

test("the song's card wins, not the podcast episode of nearly the same name", () => {
  const chosen = chosenAt(REAL_TREE, QUERY);
  assert.ok(chosen, "giving up here is what sent the model round the screen-and-click loop");
  assert.equal(chosen.y, 321, "the top-result card's Play sits at y=321");
  assert.equal(chosen.x, 876);
  assert.equal(chosen.name, "Play", "the card publishes a BARE Play beside the title");
});

test("the episode row is never chosen for a song request", () => {
  const chosen = spotifyPlayCandidate(REAL_TREE, QUERY);
  assert.ok(chosen);
  assert.doesNotMatch(
    String(chosen.name),
    /Neeraj Shridhar/,
    "\"Play Tum Hi Ho Bandhu - Neeraj Shridhar\" is the Episode row — the thing that was played live"
  );
});

// THE REJECTION, ON ITS OWN.
//
// On the full tree above the card wins on score alone, because the row
// containers stopped the sidebar and the now-playing bar from inflating every
// candidate equally — so that test passes even with the episode rule removed,
// and it is the containment fix it is really pinning. Proven by deleting the
// rule and watching all six stay green.
//
// This is the case the rule itself decides: the ONLY row matching the request is
// an episode. Playing it would be answering "play me this song" with a podcast,
// which is what happened live; refusing hands the request back to the model,
// which can read the screen and ask.
const EPISODE_ONLY = [
  el("What do you want to play?", "ComboBox", 386, 18, 652, 96, "tum hi ho bandhu neeraj shridhar"),
  el("Search results", "DataGrid", 210, 258, 794, 2000),
  el("Tum Hi Ho Bandhu - Neeraj Shridhar", "Group", 210, 258, 794, 220),
  el("Play Tum Hi Ho Bandhu - Neeraj Shridhar", "Button", 234, 290, 48, 48),
  el("Episode • Top Hits Unpacked", "DataItem", 354, 370, 400, 30),
  el("Episode", "Text", 354, 370, 80, 30)
];

test("an episode is refused when it is the only thing that matches a song request", () => {
  assert.equal(
    spotifyPlayCandidate(EPISODE_ONLY, "tum hi ho bandhu neeraj shridhar"),
    null,
    "a podcast is not an answer to a request for a song; refusing returns the choice to the user"
  );
});

test("...and is accepted the moment the request asks for one", () => {
  const chosen = spotifyPlayCandidate(EPISODE_ONLY, "tum hi ho bandhu neeraj shridhar podcast");
  assert.ok(chosen, "the rule is about song requests, not about episodes being unreachable");
  assert.match(String(chosen.name), /Neeraj Shridhar/);
});

// The rejection is about SONG requests, not about episodes existing. Somebody
// asking for a podcast must still be able to get one, or the fix has replaced a
// wrong answer with a missing capability.
test("asking for a podcast still reaches the episode row", () => {
  // The search box has to hold the request being made. It does in the product —
  // `openSpotifySearch` types the query before this runs — and the first version
  // of this test left the original query in the box, so the staleness guard
  // correctly refused the whole tree and the test failed for a reason that had
  // nothing to do with podcasts.
  const asked = "Tum Hi Ho Bandhu podcast episode";
  const searched = REAL_TREE.map((element) => element.controlType === "ControlType.ComboBox"
    ? { ...element, value: asked.toLowerCase() }
    : element);
  const chosen = spotifyPlayCandidate(searched, asked);
  assert.ok(chosen, "a podcast request must not be filtered down to nothing");
  assert.match(String(chosen.name), /Neeraj Shridhar/);
});

// THE TRANSPORT IS NOT A SEARCH RESULT.
//
// This is the one that would have been worst in the wild: with the requested
// track already loaded, the now-playing bar's neighbourhood matches the query
// better than any row, so "play X" would click Play on the transport and resume
// whatever happened to be there — reporting success while ignoring the request.
test("the now-playing bar's Play is never chosen", () => {
  const chosen = spotifyPlayCandidate(REAL_TREE, QUERY);
  assert.ok(chosen);
  assert.notEqual(chosen.boundingRect?.y ?? chosen.y, 1129, "y=1129 is the transport, not a result");
  assert.ok((chosen.boundingRect?.y ?? chosen.y) < 1100, "a result row is above the now-playing bar");
});

// STALE RESULTS ARE NOT THIS REQUEST'S RESULTS.
//
// The ranker now runs BEFORE the bounded waits, so it can be handed the previous
// search's rows — `openSpotifySearch` returns as soon as Windows accepts the
// protocol hand-off, not when Spotify has rendered. The search box publishes the
// live query, so this is answerable rather than a matter of timing.
test("rows from a previous search are refused rather than played", () => {
  const stale = REAL_TREE.map((element) => element.controlType === "ControlType.ComboBox"
    ? { ...element, value: "something else entirely" }
    : element);
  assert.equal(spotifyPlayCandidate(stale, QUERY), null,
    "these rows belong to a different query; playing them plays the last song asked for");
});

// And the guard must not fire on a build that does not publish the box, or it
// would veto every request on that build.
test("a build with no search box is not gated", () => {
  const noBox = REAL_TREE.filter((element) => element.controlType !== "ControlType.ComboBox");
  const chosen = chosenAt(noBox, QUERY);
  assert.ok(chosen, "an unreadable search box must fail open, not closed");
  assert.equal(chosen.y, 321);
});
