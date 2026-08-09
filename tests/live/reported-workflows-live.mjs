// Live, opt-in regression for the exact workflows reported by the user.
// This intentionally controls real Windows applications and the controlled
// Chromium profile. It never sends the WhatsApp draft.
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const selected = new Set((process.argv.slice(2).length ? process.argv.slice(2) : ["calculator", "whatsapp", "spotify", "youtube"]));
const report = {};

async function measured(name, run, verify = () => true) {
  const startedAt = Date.now();
  try {
    const result = await run();
    report[name] = { ok: verify(result), elapsedMs: Date.now() - startedAt, result };
    report[name].elapsedMs = Date.now() - startedAt;
  } catch (error) {
    report[name] = { ok: false, elapsedMs: Date.now() - startedAt, error: error?.stack ?? error?.message ?? String(error) };
  }
}

try {
  if (selected.has("calculator")) {
    await measured("calculator", async () => {
      const result = await adapter.calculateWithUi("99*1124", "111276");
      return {
        performed: result.performed, matched: result.matched, visibleResult: result.visibleResult,
        windowId: result.windowId, reason: result.reason, grounding: result.launch?.grounding,
        launch: result.launch?.launch, input: result.input
      };
    }, (result) => result.performed === true && result.matched === true);
  }
  if (selected.has("whatsapp")) {
    await measured("whatsapp", async () => {
      const message = "Amma, could you please let me know where you are and how long you think it will take you to return? I'm quite worried about you.";
      const result = await adapter.draftWhatsAppMessage("Amma", message);
      return {
        performed: result.performed, drafted: result.drafted, sent: result.sent,
        sendInvoked: result.sendInvoked, contactVisible: result.contactVisible,
        draftVisible: result.draftVisible, exactMessage: result.message === message,
        reason: result.reason ?? null, screen: result.screen ?? null,
        composerFocused: result.steps?.composerFocused ?? null,
        windowId: result.windowId
      };
    }, (result) => result.performed === true && result.drafted === true
      && result.sent === false && result.sendInvoked === false && result.exactMessage === true);
  }
  if (selected.has("spotify")) {
    await measured("spotify", async () => {
      const played = await adapter.playSpotifyTrack("Tum Hi Ho Bandhu", { searchSettleMs: 900, playDeadlineMs: 10000 });
      const playback = await adapter.readSpotifyPlayback();
      const result = await adapter.queueSpotifyTrack("Attention", { searchSettleMs: 900, queueDeadlineMs: 10000 });
      const verified = await adapter.readSpotifyQueue("Attention");
      const inspected = result.queued ? null : await adapter.inspectUi({ application: "spotify", maxElements: 500 });
      return {
        played: { invoked: played.invoked, resultFound: played.resultFound, title: playback.title, playing: playback.playing },
        queued: result.queued, reason: result.reason, matchedTrack: result.matchedTrack,
        verified: { queued: verified.queued, evidence: verified.evidence, reason: verified.reason },
        diagnosticControlCount: inspected?.elements?.length ?? 0
      };
    }, (result) => result.played?.invoked === true && result.played?.playing === true
      && result.queued === true && result.verified?.queued === true);
  }
  if (selected.has("youtube")) {
    await measured("youtube", async () => {
      const query = "wheels on the bus go round and round";
      const result = await adapter.browserDomAction("playMedia", {
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
        query,
        blockedStateSelector: ".ad-showing",
        timeoutMs: 85000
      });
      const observed = await adapter.browserDomAction("mediaState", {});
      const inspected = result.playing ? [] : await adapter.browserDomAction("inspect", { limit: 500 });
      return {
        performed: result.performed, playing: result.playing,
        selectedTitle: result.selectedTitle, selectedUrl: result.url,
        consent: result.consent, reason: result.reason, observed,
        pageLinks: inspected.filter((element) => /\/watch|\/shorts/i.test(String(element.href ?? ""))).slice(0, 40)
          .map((element) => ({ tag: element.tag, id: element.id, text: element.text, href: element.href, bounds: element.bounds }))
      };
    }, (result) => result.performed === true && result.playing === true);
  }
  if (selected.has("youtube-latest")) {
    await measured("youtube-latest", async () => {
      const result = await adapter.browserDomAction("playYouTubeLatest", { creator: "ashish chanchlani", timeoutMs: 85000 });
      const observed = await adapter.browserDomAction("mediaState", {});
      return {
        performed: result.performed,
        playing: result.playing,
        channelMatched: result.channelMatched,
        channelLabel: result.channelLabel,
        videosUrl: result.videosUrl,
        selectedTitle: result.selectedTitle,
        selectedUrl: result.selectedUrl,
        consent: result.consent,
        reason: result.reason,
        observed
      };
    }, (result) => result.performed === true && result.playing === true
      && result.channelMatched === true && /\/videos(?:[?#]|$)/i.test(String(result.videosUrl ?? "")));
  }
} finally {
  adapter.close();
}

console.log(JSON.stringify(report, null, 2));
if (Object.values(report).some((entry) => !entry.ok)) process.exitCode = 1;
