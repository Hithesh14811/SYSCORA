// Live, opt-in regression for the exact workflows reported by the user.
// This intentionally controls real Windows applications and the controlled
// Chromium profile. It never sends the WhatsApp draft.
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const selected = new Set((process.argv.slice(2).length ? process.argv.slice(2) : ["calculator", "whatsapp", "spotify", "youtube"]));
const report = {};

async function measured(name, run) {
  const startedAt = Date.now();
  try {
    report[name] = { ok: true, elapsedMs: Date.now() - startedAt, result: await run() };
    report[name].elapsedMs = Date.now() - startedAt;
  } catch (error) {
    report[name] = { ok: false, elapsedMs: Date.now() - startedAt, error: error?.stack ?? error?.message ?? String(error) };
  }
}

try {
  if (selected.has("calculator")) {
    await measured("calculator", async () => {
      const result = await adapter.calculateWithUi("39*17", "663");
      return { performed: result.performed, matched: result.matched, visibleResult: result.visibleResult, windowId: result.windowId };
    });
  }
  if (selected.has("whatsapp")) {
    await measured("whatsapp", async () => {
      const result = await adapter.draftWhatsAppMessage("Amma", "hi where are you");
      return {
        performed: result.performed, drafted: result.drafted, sent: result.sent,
        sendInvoked: result.sendInvoked, contactVisible: result.contactVisible,
        draftVisible: result.draftVisible, windowId: result.windowId
      };
    });
  }
  if (selected.has("spotify")) {
    await measured("spotify", async () => {
      const result = await adapter.queueSpotifyTrack("Cry For Me", { searchSettleMs: 900, queueDeadlineMs: 10000 });
      const verified = await adapter.readSpotifyQueue("Cry For Me");
      const inspected = result.queued ? null : await adapter.inspectUi({ application: "spotify", maxElements: 500 });
      return {
        queued: result.queued, reason: result.reason, matchedTrack: result.matchedTrack,
        verified: { queued: verified.queued, evidence: verified.evidence, reason: verified.reason },
        diagnosticControlCount: inspected?.elements?.length ?? 0
      };
    });
  }
  if (selected.has("youtube")) {
    await measured("youtube", async () => {
      const result = await adapter.browserDomAction("playYouTubeLatest", { creator: "ashish chanchlani", timeoutMs: 85000 });
      const observed = await adapter.browserDomAction("mediaState", {});
      const inspected = result.playing ? [] : await adapter.browserDomAction("inspect", { limit: 500 });
      return {
        performed: result.performed, playing: result.playing, channelMatched: result.channelMatched,
        channelLabel: result.channelLabel, videosUrl: result.videosUrl,
        selectedTitle: result.selectedTitle, selectedUrl: result.selectedUrl,
        consent: result.consent, reason: result.reason, observed,
        pageLinks: inspected.filter((element) => /\/watch|\/shorts/i.test(String(element.href ?? ""))).slice(0, 40)
          .map((element) => ({ tag: element.tag, id: element.id, text: element.text, href: element.href, bounds: element.bounds }))
      };
    });
  }
} finally {
  adapter.close();
}

console.log(JSON.stringify(report, null, 2));
if (Object.values(report).some((entry) => !entry.ok)) process.exitCode = 1;
