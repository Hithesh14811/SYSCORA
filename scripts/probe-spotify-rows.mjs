// WHICH ROW DOES SPOTIFY PUBLISH, AND WHICH ONE DOES THE SELECTOR PICK?
//
//   node scripts/probe-spotify-rows.mjs "tumhi ho bandhu pritam neeraj shridhar kavita seth"
//
// READ-ONLY. It opens the search (the `spotify:` protocol, same as `play_music`
// does) and then only LOOKS. It invokes nothing and plays nothing, so it can be
// run against a Spotify the user is listening to.
//
// WHY IT EXISTS. Live, 6 Sep 2026: `play_music` was asked for
// "Tumhi Ho Bandhu Pritam Neeraj Shridhar Kavita Seth" and started
// "Tum Hi Ho Bandhu - Neeraj Shridhar" by "Top Hits Unpacked" — a PODCAST
// EPISODE that repeats most of the query's words. The honesty layer caught it
// (`matchesTrackQuery` compared the live window title and reported REFUTED), the
// model then read the screen and clicked the real song row itself, and the
// request cost four extra steps.
//
// The ranker in `Find-UiTarget` scores a candidate as
//   (tokenHits * 1000) + (coverage * 500) - distance
// and NOTHING in that expression knows a song row from an episode row. This
// prints, for every Play-ish control on screen, the words near it and where it
// sits, so the discriminator can be chosen from what Spotify actually publishes
// rather than from a guess about it.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

// FLAGS MUST NOT BECOME PART OF THE QUERY, AND NEITHER MUST THEIR VALUES.
//
// The first version joined every argv entry, so `--all` was tokenised as a ninth
// search word. The second removed `--`-prefixed entries but not the value after
// `--json`, so a whole file path was tokenised as fifteen search words. Both
// times the coverage figures it printed were computed against tokens no row
// could contain — a probe measuring its own argument parsing.
const FLAGS_WITH_VALUE = new Set(["--json"]);
const argv = process.argv.slice(2);
const queryWords = [];
for (let i = 0; i < argv.length; i += 1) {
  if (FLAGS_WITH_VALUE.has(argv[i])) { i += 1; continue; }
  if (argv[i].startsWith("--")) continue;
  queryWords.push(argv[i]);
}
const query = queryWords.join(" ") || "tumhi ho bandhu pritam neeraj shridhar kavita seth";
const adapter = new WindowsAdapter();

const words = (value) => String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
const wanted = [...new Set(words(query))].filter((w) => w.length >= 2);

try {
  let ready = await adapter.waitForApplicationWindow("spotify", 1500);
  if (!ready.ready) {
    console.log("Spotify is not open — launching it (nothing will be played).");
    await adapter.launchApplication("spotify", { beforeWindows: ready.windows });
    ready = await adapter.waitForApplicationWindow("spotify", 20000);
  }
  if (!ready.ready) {
    console.log("Spotify would not become ready.");
    process.exit(1);
  }
  const windowId = String(ready.window.WindowHandle);
  console.log(`Spotify window ${windowId} — "${ready.window.MainWindowTitle}"`);
  console.log(`query tokens: ${wanted.join(" ")}\n`);

  await adapter.openSpotifySearch(query);
  // A COLD SPOTIFY DOES NOT PUBLISH ITS RESULTS FOR SEVERAL SECONDS, and the
  // first run of this probe measured the home view instead of the search — one
  // Play control, belonging to the now-playing bar. That is the same cold-tree
  // problem `_invokeSpotifyPlayButton`'s budget was raised for. Wait properly
  // here: the probe is measuring the SHAPE, not the timing.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const tree = await adapter.inspectUi({ windowId, maxElements: 400 });
  const elements = tree?.elements ?? [];
  console.log(`${elements.length} elements published\n`);

  // `--json <path>` writes the raw tree so a unit test can be held to the SAME
  // tree that produced a live failure, rather than to one somebody imagined.
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(process.argv[jsonAt + 1], JSON.stringify({ query, elements }, null, 1));
    console.log(`wrote the raw tree to ${process.argv[jsonAt + 1]}\n`);
  }

  const rect = (element) => element.boundingRect ?? element.bbox ?? {};
  const centre = (element) => {
    const r = rect(element);
    return { x: Number(r.x ?? 0) + Number(r.width ?? 0) / 2, y: Number(r.y ?? 0) + Number(r.height ?? 0) / 2 };
  };

  // Section headings: Spotify labels its result groups ("Songs", "Artists",
  // "Podcasts & Shows", "Episodes"). The heading nearest ABOVE a row is the
  // thing that says what kind of row it is.
  const HEADINGS = /^(top result|songs?|artists?|albums?|playlists?|podcasts?( & shows)?|episodes?|profiles?|genres?|featuring)$/i;
  const headings = elements
    .filter((e) => HEADINGS.test(String(e.text ?? e.name ?? "").trim()))
    .map((e) => ({ text: String(e.text ?? e.name).trim(), ...centre(e) }))
    .sort((a, b) => a.y - b.y);

  console.log("SECTION HEADINGS FOUND");
  if (headings.length === 0) console.log("  (none — the heading is not published as its own element)");
  for (const h of headings) console.log(`  y=${String(Math.round(h.y)).padStart(5)}  x=${String(Math.round(h.x)).padStart(5)}  "${h.text}"`);
  console.log();

  // WHAT KIND OF ROW IS THIS? SPOTIFY SAYS SO, ON THE ROW ITSELF.
  //
  // The first version of this probe looked for a section heading ABOVE the row
  // and got the filter tabs at the top of the page ("Songs", "Podcasts & Shows")
  // for every candidate, which says nothing about any individual row.
  //
  // What Spotify actually publishes is a per-row TYPE LABEL — a short Text
  // element reading exactly "Song", "Episode", "Artist", "Playlist" or "Album",
  // sitting on the same row as the result and slightly to its right. Measured on
  // this tree: Play controls at x=282 with labels at x=388-468, and the label's
  // centre is a consistent ~26px BELOW the Play control's.
  //
  // That is the discriminator the ranker is missing: an "Episode" row and a
  // "Song" row can carry identical words and mean completely different things.
  const ROW_TYPE = /^(song|episode|artist|playlist|album|podcast|show|profile)$/i;
  const rowLabels = elements
    .map((e) => ({ text: String(e.text ?? e.name ?? "").trim(), ...centre(e) }))
    .filter((row) => ROW_TYPE.test(row.text));

  const labelFor = (c) => {
    let best = null;
    for (const label of rowLabels) {
      const dy = label.y - c.y;
      // Same row, label to the RIGHT of the play control and close to it.
      if (dy < -20 || dy > 60) continue;
      if (label.x < c.x - 40) continue;
      const distance = Math.abs(dy) + Math.abs(label.x - c.x) / 10;
      if (!best || distance < best.distance) best = { text: label.text, distance };
    }
    return best?.text ?? null;
  };

  // Every candidate the Spotify selector would consider: a control whose name
  // starts with "Play".
  const candidates = elements.filter((e) => /^play\b/i.test(String(e.name ?? e.text ?? "")));
  console.log(`PLAY-ISH CONTROLS: ${candidates.length}\n`);

  for (const candidate of candidates) {
    const c = centre(candidate);
    // The same neighbourhood the PowerShell ranker builds: same row, within
    // maxDistance horizontally.
    const near = elements.filter((e) => {
      if (e === candidate) return false;
      const o = centre(e);
      return Math.abs(o.y - c.y) <= 140 && Math.abs(o.x - c.x) <= 1100;
    });
    const haystack = [candidate.name ?? "", ...near.map((e) => e.text ?? e.name ?? "")].join(" ").toLowerCase();
    const hits = wanted.filter((t) => haystack.includes(t));
    const coverage = wanted.length ? hits.length / wanted.length : 0;
    const score = hits.length * 1000 + Math.round(coverage * 500);

    console.log(`  "${String(candidate.name ?? candidate.text).slice(0, 70)}"`);
    console.log(`     role=${candidate.role ?? candidate.controlType}  @${Math.round(c.x)},${Math.round(c.y)}  ROW TYPE=${JSON.stringify(labelFor(c))}`);
    console.log(`     tokenHits=${hits.length}/${wanted.length}  coverage=${coverage.toFixed(2)}  ~score=${score}`);
    console.log(`     near: ${near.map((e) => String(e.text ?? e.name ?? "").trim()).filter(Boolean).slice(0, 6).map((t) => JSON.stringify(t.slice(0, 44))).join(", ")}`);
    console.log();
  }

  // THE WHOLE TREE, ORDERED DOWN THE PAGE. The Play controls alone cannot show
  // what distinguishes a song row from an episode row, because Spotify only
  // publishes a row's Play control on hover — so the row itself, and the type
  // label beside it, is what a selector has to key on.
  if (process.argv.includes("--all")) {
    console.log("EVERY ELEMENT, TOP TO BOTTOM\n");
    const ordered = elements
      .map((e) => ({ e, ...centre(e) }))
      .filter((row) => String(row.e.text ?? row.e.name ?? "").trim())
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const row of ordered) {
      const label = String(row.e.text ?? row.e.name).trim().slice(0, 88);
      console.log(`  y=${String(Math.round(row.y)).padStart(5)} x=${String(Math.round(row.x)).padStart(5)}  ${String(row.e.role ?? row.e.controlType ?? "").replace("ControlType.", "").padEnd(11)} ${JSON.stringify(label)}`);
    }
  }
} catch (error) {
  console.error("probe failed:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  // The host is a long-lived child process; leaving it running is what once
  // left 15 orphaned powershell.exe holding 801 MB. It is not a promise.
  try {
    const { closeWindowsAutomationHost } = await import("../os-adapters/windows-host/src/client.js");
    await Promise.resolve(closeWindowsAutomationHost?.());
  } catch { /* teardown must not mask the probe's own result */ }
}
