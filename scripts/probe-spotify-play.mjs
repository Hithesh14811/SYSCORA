// WHY DOES `play_music` SAY "no track started" WHEN THE PLAY BUTTON IS RIGHT THERE?
//
//   node scripts/probe-spotify-play.mjs "we don't talk anymore"
//
// Measured live, 29 Aug 2026. `play_music` took 9.2 seconds, reported "Spotify is
// not playing: no track started", and the very next `screen` reading contained:
//
//   65| dataitem "Play" @924,398 — beside it: "We Don't Talk Anymore (feat. Selena Gomez)"
//
// The agent then clicked that and it played immediately. So the control was
// present, invokable, and correctly named the whole time. Every music request on
// this machine pays ~9 seconds and four extra steps for that miss.
//
// `_invokeSpotifyPlayButton` has three attempts in order:
//
//   1. findAndInvokeSemanticControl, controlType "Button"   -- UNBOUNDED
//   2. findAndInvokeSemanticControl, controlType null       -- UNBOUNDED
//   3. waitForUiTarget for a bare "Play" NEAR the track     -- gets whatever
//      is left of a 6,000ms budget, capped at 1,000ms, and is SKIPPED
//      ENTIRELY if fewer than 50ms remain.
//
// Attempt 3 is the one that matches the shape Spotify actually publishes. The
// hypothesis this probe tests is that 1 and 2 consume the whole budget, so the
// attempt that would have worked never runs.
//
// It times each attempt separately against the real Spotify window and says
// which one matched. It plays a track -- that is the thing being measured.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const query = process.argv.slice(2).join(" ") || "we don't talk anymore";

const adapter = new WindowsAdapter();
const timings = [];
const stamp = (label, ms, extra = "") => {
  timings.push({ label, ms, extra });
  console.log(`  ${String(Math.round(ms) + "ms").padStart(8)}  ${label}${extra ? "  " + extra : ""}`);
};

try {
  console.log(`QUERY: ${JSON.stringify(query)}`);
  console.log("");

  // Instrument the two inner calls so their real cost is visible rather than
  // inferred from the total.
  const realSemantic = adapter.findAndInvokeSemanticControl?.bind(adapter);
  const realWait = adapter.waitForUiTarget?.bind(adapter);
  let semanticCalls = 0;
  let waitCalls = 0;

  if (realSemantic) {
    adapter.findAndInvokeSemanticControl = async (args) => {
      const at = Date.now();
      semanticCalls += 1;
      const out = await realSemantic(args);
      stamp(`attempt ${semanticCalls}: semantic controlType=${args.controlType ?? "null"}`,
        Date.now() - at, out?.invoked ? "INVOKED" : "no match");
      return out;
    };
  }
  if (realWait) {
    adapter.waitForUiTarget = async (args) => {
      const at = Date.now();
      waitCalls += 1;
      const out = await realWait(args);
      stamp(`attempt 3: waitForUiTarget (timeoutMs=${args.timeoutMs})`,
        Date.now() - at, out?.matched ? "MATCHED" : "no match");
      return out;
    };
  }

  console.log("ATTEMPTS, IN ORDER:");
  const startedAt = Date.now();
  const result = await adapter.playSpotifyTrack(query, {});
  const total = Date.now() - startedAt;

  console.log("");
  console.log("RESULT");
  console.log(`  total            ${total}ms`);
  console.log(`  available        ${result?.available}`);
  console.log(`  resultFound      ${result?.resultFound}`);
  console.log(`  invoked          ${result?.invoked}`);
  console.log(`  playedButton     ${JSON.stringify(result?.playedButton ?? null)}`);
  console.log(`  playing          ${result?.playback?.playing}`);
  console.log(`  nowPlaying       ${JSON.stringify(result?.playback?.nowPlaying ?? result?.title ?? null)}`);
  console.log("");

  // THE POINT OF THE PROBE. Attempt 3 is the one that matches Spotify's real
  // shape; if it never ran, the budget is the defect rather than the matcher.
  if (waitCalls === 0) {
    console.log("FINDING: attempt 3 NEVER RAN.");
    const spent = timings.filter((t) => t.label.startsWith("attempt")).reduce((sum, t) => sum + t.ms, 0);
    console.log(`  The two semantic attempts spent ${Math.round(spent)}ms of a 6,000ms budget,`);
    console.log("  leaving under 50ms, so the bare-\"Play\"-beside-the-track matcher was skipped.");
    console.log("  That is the one that matches what Spotify actually publishes.");
  } else if (result?.playback?.playing) {
    console.log("FINDING: playback started. Which attempt matched is above.");
  } else {
    console.log("FINDING: every attempt ran and none matched -- the budget is NOT the defect;");
    console.log("  the selector is. Compare the names above against a `screen` reading.");
  }
} finally {
  try { await adapter.close?.(); } catch { /* nothing to close */ }
}
