import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  const error = new Error("Browser operation cancelled");
  error.name = "AbortError";
  error.code = "CANCELLED";
  throw error;
};

export const BROWSER_TARGET_KIND = "BROWSER_DOM";
export const DESKTOP_TARGET_KIND = "DESKTOP_UI";
export const MAX_BROWSER_TEXT_BYTES = 64 * 1024;

export function boundBrowserText(value, maxBytes = MAX_BROWSER_TEXT_BYTES) {
  const text = String(value ?? "");
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false };
  let bounded = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (bounded.endsWith("\uFFFD")) bounded = bounded.slice(0, -1);
  return { text: bounded, truncated: true, originalBytes };
}

export function normalizeBrowserElement(element = {}) {
  const tag = String(element.tag ?? element.controlType ?? "").toLowerCase();
  const inferredRole = { button: "button", a: "link", input: "textbox", select: "combobox", textarea: "textbox" }[tag] ?? tag ?? null;
  const role = element.role ?? inferredRole;
  return {
    ...element,
    id: String(element.id ?? element.targetId ?? `browser-${element.index ?? "element"}`),
    source: "DOM",
    targetKind: BROWSER_TARGET_KIND,
    role,
    text: String(element.text ?? element.name ?? ""),
    bbox: element.bbox ?? element.boundingRect ?? element.bounds ?? null,
    clickable: element.clickable ?? (["button", "a", "input", "select", "textarea"].includes(tag) || role === "button" || role === "link"),
    controlType: element.controlType ?? tag ?? null,
    name: element.name ?? element.text ?? null
  };
}

export function resolveTargetSurface(target) {
  return target?.targetKind === BROWSER_TARGET_KIND || target?.source === "DOM"
    ? BROWSER_TARGET_KIND
    : DESKTOP_TARGET_KIND;
}

export const BrowserLifecycleState = Object.freeze({
  DISCOVER: "DISCOVER",
  LAUNCH_CONTROLLED: "LAUNCH_CONTROLLED",
  WAIT_FOR_CDP: "WAIT_FOR_CDP",
  DISCOVER_TARGET: "DISCOVER_TARGET",
  READY: "READY",
  FAILED: "FAILED"
});

function browserError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function defaultBrowserCandidates() {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const relative = [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Google", "Chrome", "Application", "chrome.exe"]
  ];
  return roots.flatMap((root) => relative.map((parts) => path.join(root, ...parts)));
}

class CdpConnection {
  constructor(url, { timeoutMs = 10000, sessionId = null } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = sessionId;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string"
        ? event.data
        : (typeof event.data?.text === "function" ? await event.data.text() : Buffer.from(event.data).toString("utf8"));
      const message = JSON.parse(raw);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), this.timeoutMs);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
  }

  async send(method, params = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(this.sessionId ? { sessionId: this.sessionId } : {})
      }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

export class CdpBrowserAdapter {
  constructor({ executablePath = null, port = 0, requestTimeoutMs = 10000 } = {}) {
    this.executablePath = executablePath;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.connection = null;
    this.userDataDir = null;
    this.target = null;
    this.observedTargets = new Map();
    this.lifecycle = { state: BrowserLifecycleState.DISCOVER, history: [] };
  }

  _transition(state, details = {}) {
    this.lifecycle.state = state;
    this.lifecycle.history.push({ state, at: new Date().toISOString(), ...details });
  }

  _findExecutable() {
    if (this.executablePath && fs.existsSync(this.executablePath)) return this.executablePath;
    const found = defaultBrowserCandidates().find((candidate) => fs.existsSync(candidate));
    if (!found) throw browserError("BROWSER_NOT_INSTALLED", "No supported Chromium browser was found");
    return found;
  }

  async _json(url, options = {}) {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
    if (!response.ok) throw new Error(`Browser endpoint returned ${response.status}`);
    return response.json();
  }

  async launch({ url = "about:blank", headless = false, signal = null } = {}) {
    throwIfAborted(signal);
    if (this.process && this.connection) {
      if (url && url !== "about:blank") await this.navigate({ url, signal });
      return { launched: true, reused: true, target: this.target };
    }
    this._transition(BrowserLifecycleState.DISCOVER);
    const executable = this._findExecutable();
    this._transition(BrowserLifecycleState.LAUNCH_CONTROLLED, { executable });
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "syscora-cdp-"));
    const args = [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      ...(headless ? ["--disable-gpu"] : []),
      ...(process.env.SYSCORA_BROWSER_DISABLE_SANDBOX === "1" ? ["--no-sandbox"] : []),
      ...(headless ? ["--headless=new"] : []),
      url
    ];
    this.process = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: headless });
    const abortLaunch = () => this.close();
    signal?.addEventListener("abort", abortLaunch, { once: true });
    this._transition(BrowserLifecycleState.WAIT_FOR_CDP);
    let endpoint = "";
    try {
      await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(browserError("CDP_TIMEOUT", "Browser debug endpoint did not start")), 10000);
      this.process.stderr.on("data", (chunk) => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (!match) return;
        endpoint = match[1];
        clearTimeout(timer);
        resolve();
      });
      this.process.once("exit", (code) => {
        clearTimeout(timer);
        reject(browserError("CDP_START_FAILED", `Browser exited before CDP connected (${code})`));
      });
      });
    } catch (error) {
      this._transition(BrowserLifecycleState.FAILED, { code: error.code ?? "CDP_START_FAILED" });
      this.close();
      throwIfAborted(signal);
      throw error;
    }
    const browserConnection = new CdpConnection(endpoint, { timeoutMs: this.requestTimeoutMs });
    try {
      await browserConnection.connect();
      this._transition(BrowserLifecycleState.DISCOVER_TARGET);
      const created = await browserConnection.send("Target.getTargets");
      let target = created.targetInfos?.find((item) => item.type === "page");
      if (!target) {
        const result = await browserConnection.send("Target.createTarget", { url });
        target = { targetId: result.targetId, url };
      }
      const attached = await browserConnection.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true
      });
      if (!attached?.sessionId) throw browserError("NO_TARGET", "Browser target session unavailable");
      browserConnection.sessionId = attached.sessionId;
      this.connection = browserConnection;
      const ready = await this.connection.send("Runtime.evaluate", {
        expression: "1 + 1",
        returnByValue: true
      });
      if (ready?.result?.value !== 2) throw browserError("DOM_UNAVAILABLE", "Browser runtime is unavailable");
      this.target = { targetId: target.targetId, url: target.url };
      this._transition(BrowserLifecycleState.READY, { targetId: target.targetId });
      throwIfAborted(signal);
      // The requested URL was passed to Chrome on the command line, but the
      // target picked above is simply the first page target reported — which,
      // on a cold start, is usually Chrome's initial blank tab rather than the
      // one loading that URL. Attaching there leaves every later read looking
      // at about:blank (browser.research then reports "results not found" for
      // a page it never opened). Navigate the attached session explicitly, the
      // same way the reuse branch above already does, so the target this
      // adapter controls is always the requested page.
      // Trust the live page, not the target's reported URL: Target.getTargets
      // reports the URL Chrome was asked to open, while the attached session
      // can still be sitting on the initial blank document.
      //
      // Chrome is already loading the command-line URL at this point, so give
      // that a moment to land before intervening — issuing Page.navigate into
      // an in-flight navigation is what made it hang. Only drive the navigation
      // ourselves if the page is still blank after that grace period, and treat
      // a failure there as non-fatal: the caller's own wait/read steps report
      // the real state, and killing a usable session over a corrective step
      // would be worse than the blank page it was meant to fix.
      if (url && url !== "about:blank") {
        const settleDeadline = Date.now() + 3000;
        let live = null;
        do {
          live = await this.currentState().catch(() => null);
          if (live?.url && live.url !== "about:blank") break;
          await delay(150);
        } while (Date.now() < settleDeadline);
        if (!live?.url || live.url === "about:blank") {
          try {
            await this.navigate({ url, signal });
          } catch (navigationError) {
            if (navigationError?.name === "AbortError") throw navigationError;
          }
        }
      }
      return { launched: true, executable, target: this.target, lifecycle: structuredClone(this.lifecycle) };
    } catch (error) {
      if (this.connection !== browserConnection) browserConnection.close();
      const code = error.code ?? (/timed out/i.test(error.message) ? "CDP_TIMEOUT" : "CDP_START_FAILED");
      this._transition(BrowserLifecycleState.FAILED, { code });
      this.close();
      throw browserError(code, error.message, error);
    } finally {
      signal?.removeEventListener("abort", abortLaunch);
    }
  }

  async connect({ endpoint = "http://127.0.0.1:9222" } = {}) {
    const pages = await this._json(`${endpoint.replace(/\/$/, "")}/json/list`);
    const page = pages.find((item) => item.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("No debuggable browser page found");
    this.connection = new CdpConnection(page.webSocketDebuggerUrl, { timeoutMs: this.requestTimeoutMs });
    await this.connection.connect();
    await this.connection.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
    this.target = { targetId: page.id, url: page.url };
    return { connected: true, target: this.target };
  }

  async _evaluate(expression, { awaitPromise = true } = {}) {
    if (!this.connection) throw new Error("Browser is not connected");
    const result = await this.connection.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
    return result.result?.value;
  }

  async navigate({ url, waitUntil = "complete", timeoutMs = 15000, signal = null } = {}) {
    throwIfAborted(signal);
    if (!/^(?:https?:\/\/|data:text\/html(?:[;,]|$)|about:blank$)/i.test(String(url))) {
      throw browserError("NAVIGATION_FAILED", "browser.navigate requires an http(s), HTML data, or about:blank URL");
    }
    try {
      await this.connection.send("Page.navigate", { url });
    } catch (error) {
      throw browserError("NAVIGATION_FAILED", `Browser navigation failed: ${error.message}`, error);
    }
    this.observedTargets.clear();
    await this.wait({ condition: "document.readyState", value: waitUntil, timeoutMs, signal });
    return this.currentState();
  }

  async currentState() {
    return this._evaluate(`(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        id: document.activeElement.id,
        name: document.activeElement.getAttribute("name")
      } : null
    }))()`);
  }

  async mediaState({ selector = "video, audio", blockedStateSelector = null } = {}) {
    const selected = JSON.stringify(String(selector || "video, audio"));
    const blocked = JSON.stringify(blockedStateSelector == null ? null : String(blockedStateSelector));
    return this._evaluate(`(() => {
      const media=document.querySelector(${selected});
      if(!media)return {found:false,playing:false,reason:"media-element-not-found",url:location.href,title:document.title};
      const blockedSelector=${blocked}; const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);
        return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&s.opacity!=="0"};
      const requestedBlock=blockedSelector?[...document.querySelectorAll(blockedSelector)].some(visible):false;
      // YouTube does not consistently retain the ad-showing class on every player
      // revision. Treat any visible ad UI as blocked playback so the verifier
      // waits for the requested content rather than declaring a pre-roll ad to
      // be the selected video.
      const youtubeAd=/youtube\.com$/i.test(location.hostname)&&[...document.querySelectorAll(
        '.ad-showing,.ytp-ad-player-overlay,.ytp-ad-text,.ytp-ad-skip-button-container,.video-ads [class*="ytp-ad"]'
      )].some(visible);
      const blockedByPage=requestedBlock||youtubeAd;
      return {found:true,playing:!blockedByPage&&!media.paused&&!media.ended&&media.readyState>=2,blockedByPage,paused:media.paused,
        ended:media.ended,currentTime:media.currentTime,duration:Number.isFinite(media.duration)?media.duration:null,
        readyState:media.readyState,muted:media.muted,volume:media.volume,url:location.href,title:document.title};
    })()`);
  }

  // Continue through common consent interstitials with the least-permissive
  // available choice. This never silently accepts optional tracking cookies.
  async dismissCookieNotice({ timeoutMs = 6000, signal = null } = {}) {
    const deadline = Date.now() + Math.max(500, Math.min(10000, Number(timeoutMs) || 6000));
    let last = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      last = await this._evaluate(`(() => {
        const clean=v=>String(v||"").replace(/\\s+/g," ").trim();
        const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"};
        const controls=[...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')].filter(visible);
        const labels=[
          /^reject all$/i,/^reject optional/i,/^only necessary$/i,/^necessary only$/i,
          /^decline all$/i,/^decline$/i,/^continue without accepting$/i,/^no thanks$/i
        ];
        for(const pattern of labels){
          const hit=controls.find(el=>pattern.test(clean(el.innerText||el.value||el.getAttribute('aria-label'))));
          if(hit){const label=clean(hit.innerText||hit.value||hit.getAttribute('aria-label'));hit.click();return {handled:true,label,preference:'reject-optional',url:location.href};}
        }
        const text=clean(document.body?.innerText).slice(0,1200);
        return {handled:false,consentVisible:/cookie|consent|before you continue/i.test(text),url:location.href};
      })()`);
      if (last?.handled) {
        await delay(350);
        return last;
      }
      if (!last?.consentVisible) return { handled: false, needed: false, url: last?.url };
      await delay(200);
    }
    return { ...(last ?? {}), handled: false, reason: "privacy-preserving-consent-control-not-found" };
  }

  // A creator-latest request is not a generic keyword search. Resolve the
  // creator's channel, visit its Videos page, select the first newest upload,
  // and only then start/verify playback.
  async playYouTubeLatest({ creator, url = null, timeoutMs = 75000, signal = null } = {}) {
    const requestedCreator = String(creator ?? "").trim();
    if (!requestedCreator) throw new Error("A YouTube creator name is required");
    const searchUrl = url || `https://www.youtube.com/results?search_query=${encodeURIComponent(requestedCreator)}`;
    const deadline = Date.now() + Math.min(90000, Math.max(5000, Number(timeoutMs) || 75000));
    await this.launch({ url: searchUrl, signal });
    const consent = await this.dismissCookieNotice({ timeoutMs: 5000, signal });
    let state = await this.currentState();
    if (/consent\.youtube\.com|consent\.google\./i.test(state.url) && !consent.handled) {
      return { performed: false, playing: false, creator: requestedCreator, reason: consent.reason ?? "youtube-consent-blocked", consent, state };
    }
    if (!/youtube\.com\/results/i.test(state.url)) {
      await this.navigate({ url: searchUrl, timeoutMs: Math.min(15000, deadline - Date.now()), signal });
      await this.dismissCookieNotice({ timeoutMs: 3000, signal });
    }
    let channelReady = await this.wait({
      condition: "selector",
      selector: "ytd-channel-renderer a#main-link, ytd-channel-renderer a[href], a[href^='/@']",
      timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())),
      signal
    });
    if (!channelReady.matched && Date.now() < deadline - 5000) {
      // A blank/partially hydrated search result is recoverable once. Reload
      // the exact search page rather than abandoning the required channel-first
      // workflow or clicking an arbitrary video result.
      await this.connection.send("Page.reload", { ignoreCache: true });
      await this.wait({
        condition: "document.readyState",
        value: "complete",
        timeoutMs: Math.min(12000, Math.max(500, deadline - Date.now())),
        signal
      });
      await this.dismissCookieNotice({ timeoutMs: Math.min(5000, Math.max(500, deadline - Date.now())), signal });
      channelReady = await this.wait({
        condition: "selector",
        selector: "ytd-channel-renderer a#main-link, ytd-channel-renderer a[href], a[href^='/@']",
        timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())),
        signal
      });
    }
    if (!channelReady.matched) {
      return { performed: false, playing: false, creator: requestedCreator, reason: "youtube-channel-result-not-found", consent, state: await this.currentState() };
    }
    const encodedCreator = JSON.stringify(requestedCreator);
    const channel = await this._evaluate(`(() => {
      const requested=${encodedCreator};
      const norm=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      const tokens=norm(requested).split(" ").filter(Boolean);
      const links=[...document.querySelectorAll("ytd-channel-renderer a#main-link, ytd-channel-renderer a[href], a[href^='/@']")];
      let best=null,bestScore=-1;
      for(const link of links){
        const box=link.getBoundingClientRect();if(box.width<=0||box.height<=0)continue;
        const row=link.closest('ytd-channel-renderer')||link;
        const label=String(link.innerText||link.getAttribute('aria-label')||row.innerText||"").trim();
        const hay=norm(label);const hits=tokens.filter(t=>hay.includes(t)).length;
        const score=(tokens.length&&hits===tokens.length?100:0)+hits*10-(hay.length/1000);
        const href=link.href;if(href&&score>bestScore){best={href,label,score};bestScore=score;}
      }
      return best;
    })()`);
    if (!channel?.href || channel.score < 10) {
      return { performed: false, playing: false, creator: requestedCreator, reason: "matching-youtube-channel-not-found", channel, consent };
    }
    await this.navigate({ url: channel.href, timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())), signal });
    await this.dismissCookieNotice({ timeoutMs: 2500, signal });
    state = await this.currentState();
    const channelUrl = new URL(state.url);
    const videosUrl = `${channelUrl.origin}${channelUrl.pathname.replace(/\/$/, "")}/videos`;
    await this.navigate({ url: videosUrl, timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())), signal });
    await this.dismissCookieNotice({ timeoutMs: 2500, signal });
    // If YouTube exposes a Latest chip, select it explicitly. Channels whose
    // Videos page is already newest-first simply continue unchanged.
    await this._evaluate(`(() => {
      const clean=v=>String(v||"").replace(/\\s+/g," ").trim();
      const candidates=[...document.querySelectorAll('button,[role="tab"],yt-chip-cloud-chip-renderer,[role="button"]')];
      const latest=candidates.find(el=>/^latest$/i.test(clean(el.innerText||el.getAttribute('aria-label'))));
      if(latest){latest.click();return true}return false;
    })()`);
    await delay(250);
    // YouTube's 2026 channel grid no longer assigns #video-title(-link) to
    // every card, but each card still exposes a same-origin /watch anchor. The
    // first unique watch URL is the first newest item after the Latest sort.
    const videoSelector = "a[href*='/watch?v=']";
    const videoReady = await this.wait({ condition: "selector", selector: videoSelector, timeoutMs: Math.min(18000, Math.max(500, deadline - Date.now())), signal });
    if (!videoReady.matched) {
      return { performed: false, playing: false, creator: requestedCreator, reason: "youtube-channel-has-no-visible-videos", channel, videosUrl, consent };
    }
    const selected = await this._evaluate(`(() => {
      const links=[...document.querySelectorAll(${JSON.stringify(videoSelector)})].filter(link=>{const r=link.getBoundingClientRect();return r.width>0&&r.height>0&&link.href});
      if(!links.length)return null;
      const href=links[0].href;
      const same=links.filter(link=>link.href===href);
      const labels=same.map(link=>String(link.title||link.getAttribute('aria-label')||link.innerText||"").replace(/\\s+/g," ").trim())
        .filter(label=>label&&!/^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test(label));
      const title=labels.sort((a,b)=>b.length-a.length)[0]||String(links[0].innerText||"").trim();
      return {href,title};
    })()`);
    if (!selected?.href) return { performed: false, playing: false, creator: requestedCreator, reason: "youtube-latest-video-not-grounded", channel, videosUrl, consent };
    await this.navigate({ url: selected.href, timeoutMs: Math.min(18000, Math.max(500, deadline - Date.now())), signal });
    // YouTube may defer its consent interstitial until the first watch page.
    // Handling only the search/channel pages leaves a <video> shell behind the
    // dialog at readyState 0 forever. Reject optional cookies after the final
    // navigation and fail honestly if the least-permissive control is absent.
    const playbackConsent = await this.dismissCookieNotice({ timeoutMs: Math.min(8000, Math.max(500, deadline - Date.now())), signal });
    if (playbackConsent?.consentVisible && !playbackConsent.handled) {
      return { performed: false, playing: false, creator: requestedCreator, reason: playbackConsent.reason ?? "youtube-consent-blocked", selectedTitle: selected.title, channel, videosUrl, consent: playbackConsent };
    }
    const mediaReady = await this.wait({ condition: "selector", selector: "video", timeoutMs: Math.max(500, deadline - Date.now()), signal });
    if (!mediaReady.matched) return { performed: false, playing: false, creator: requestedCreator, reason: "media-element-not-found", selectedTitle: selected.title, channel, videosUrl, consent };
    let started = await this._evaluate(`(()=>{const video=document.querySelector('video');if(!video)return false;try{const p=video.play();if(p&&p.catch)p.catch(()=>{});return true}catch{return false}})()`);
    let observed = await this.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
    if (!observed.playing && Number(observed.currentTime) <= 0) {
      const playControl = await this.find({ selector: "button.ytp-play-button,button[aria-label^='Play'],[role='button'][aria-label^='Play']", text: "Play" });
      if (playControl.found) {
        const clicked = await this.click({ target: playControl.target });
        started = clicked.performed || started;
        await delay(250);
        observed = await this.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
      }
    }
    // Chromium can finish the SPA navigation with a visible YouTube player
    // shell whose media element never receives a source (readyState 0,
    // duration null). Waiting longer cannot heal that state. Reload the exact
    // channel-grounded watch URL once, only after observing the stuck shell.
    if (Number(observed.readyState) < 2 && Number(observed.currentTime) <= 0 && Date.now() < deadline - 3000) {
      await delay(1200);
      observed = await this.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
      if (Number(observed.readyState) < 2 && Number(observed.currentTime) <= 0) {
        // A second Page.navigate to the same YouTube URL may be satisfied from
        // the existing SPA document and preserve the source-less player. Force
        // a real document reload so player scripts and the media source are
        // initialized from scratch.
        await this.connection.send("Page.reload", { ignoreCache: true });
        await this.wait({
          condition: "document.readyState",
          value: "complete",
          timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())),
          signal
        });
        const reloadConsent = await this.dismissCookieNotice({ timeoutMs: Math.min(8000, Math.max(500, deadline - Date.now())), signal });
        if (reloadConsent?.consentVisible && !reloadConsent.handled) {
          return { performed: false, playing: false, creator: requestedCreator, reason: reloadConsent.reason ?? "youtube-consent-blocked", selectedTitle: selected.title, channel, videosUrl, consent: reloadConsent };
        }
        await this.wait({ condition: "selector", selector: "video", timeoutMs: Math.min(15000, Math.max(500, deadline - Date.now())), signal });
        const replayControl = await this.find({ selector: "button.ytp-play-button,button[aria-label^='Play'],[role='button'][aria-label^='Play']", text: "Play" });
        if (replayControl.found) {
          const clicked = await this.click({ target: replayControl.target });
          started = clicked.performed || started;
        } else {
          started = await this._evaluate(`(()=>{const video=document.querySelector('video');if(!video)return false;try{const p=video.play();if(p&&p.catch)p.catch(()=>{});return true}catch{return false}})()`) || started;
        }
        await delay(300);
        observed = await this.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
      }
    }
    let firstTime = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (!observed.paused && !observed.ended && observed.readyState >= 2 && Number(observed.currentTime) > 0) {
        if (firstTime == null) firstTime = Number(observed.currentTime);
        else if (Number(observed.currentTime) > firstTime) break;
      }
      await delay(250);
      observed = await this.mediaState({ selector: "video", blockedStateSelector: ".ad-showing" });
    }
    const channelTokens = requestedCreator.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const channelMatched = channelTokens.every((token) => String(channel.label ?? "").toLowerCase().includes(token));
    const playing = observed.playing === true || (!observed.paused && !observed.ended && observed.readyState >= 2 && Number(observed.currentTime) > 0);
    return {
      performed: started === true,
      playing,
      creator: requestedCreator,
      channelMatched,
      channelLabel: channel.label,
      channelUrl: channel.href,
      videosUrl,
      selectedTitle: selected.title,
      selectedUrl: selected.href,
      mediaState: observed,
      consent: playbackConsent?.handled ? playbackConsent : consent,
      reason: playing ? null : "media-playback-not-observed"
    };
  }

  async playMedia({
    url,
    query = null,
    resultSelector = "a#video-title, a[href*='/watch'], a[href*='/video/']",
    mediaSelector = "video, audio",
    blockedStateSelector = null,
    timeoutMs = 75000,
    signal = null
  } = {}) {
    if (!url) throw new Error("browser media playback requires an explicit URL");
    await this.launch({ url, signal });
    const deadline = Date.now() + Math.min(75000, Math.max(1000, Number(timeoutMs) || 75000));
    const consent = await this.dismissCookieNotice({ timeoutMs: 5000, signal });
    let state = await this.currentState();
    if (/consent\.youtube\.com|consent\.google\./i.test(state.url) && !consent.handled) {
      return {
        performed: false,
        playing: false,
        reason: consent.reason ?? "privacy-preserving-consent-control-not-found",
        consent,
        state
      };
    }
    let selectedTitle = null;
    if (!/\/(?:watch|video|shorts)\b/i.test(new URL(state.url).pathname)) {
      const ready = await this.wait({ condition: "selector", selector: resultSelector, timeoutMs: Math.min(10000, timeoutMs), signal });
      if (!ready.matched) return { performed: false, playing: false, reason: "media-result-not-found", state };
      const found = query
        ? await this.findBest({ selector: resultSelector, text: query, minCoverage: 0.5 })
        : await this.find({ selector: resultSelector });
      const target = found.found ? found.target : null;
      if (!target) return { performed: false, playing: false, reason: "media-result-not-found", state };
      selectedTitle = target.text ?? target.name ?? null;
      const clicked = await this.click({ target });
      if (!clicked.performed) return { performed: false, playing: false, reason: "media-result-not-opened", state };
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        await delay(150);
        state = await this.currentState();
        if (/\/(?:watch|video|shorts)\b/i.test(new URL(state.url).pathname)) break;
      }
    }
    // The first watch-page navigation is where YouTube frequently presents its
    // cookie interstitial. Give that privacy-preserving rejection enough time
    // to render; the old 2.5s fire-and-forget call returned before the button
    // existed, then waited 75s on a video element stuck at readyState 0.
    const playbackConsent = await this.dismissCookieNotice({ timeoutMs: Math.min(8000, Math.max(500, deadline - Date.now())), signal });
    if (playbackConsent?.consentVisible && !playbackConsent.handled) {
      return {
        performed: false,
        playing: false,
        reason: playbackConsent.reason ?? "privacy-preserving-consent-control-not-found",
        consent: playbackConsent,
        state: await this.currentState()
      };
    }
    const mediaReady = await this.wait({ condition: "selector", selector: mediaSelector, timeoutMs: Math.max(500, deadline - Date.now()), signal });
    if (!mediaReady.matched) return { performed: false, playing: false, reason: "media-element-not-found", state };
    const selector = JSON.stringify(mediaSelector);
    let started = await this._evaluate(`(()=>{const media=document.querySelector(${selector});if(!media)return false;
      try{const pending=media.play();if(pending&&typeof pending.catch==="function")pending.catch(()=>{});return true}catch{return false}})()`);
    let observed = await this.mediaState({ selector: mediaSelector, blockedStateSelector });
    if (!observed.playing && Number(observed.currentTime) <= 0) {
      const playControl = await this.find({ selector: "button.ytp-play-button,button[aria-label^='Play'],[role='button'][aria-label^='Play']", text: "Play" });
      if (playControl.found) {
        const clicked = await this.click({ target: playControl.target });
        started = clicked.performed || started;
        await delay(250);
        observed = await this.mediaState({ selector: mediaSelector, blockedStateSelector });
      }
    }
    let firstPlayingTime = null;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const selectedIdentityObserved = selectedTitle && String(observed.title ?? "").toLowerCase().includes(String(selectedTitle).toLowerCase());
      const contentPlaying = observed.playing || (selectedIdentityObserved && !observed.paused && !observed.ended && observed.readyState >= 2);
      if (contentPlaying && observed.currentTime > 0) {
        if (firstPlayingTime == null) firstPlayingTime = observed.currentTime;
        else if (observed.currentTime > firstPlayingTime) break;
      }
      await delay(250);
      observed = await this.mediaState({ selector: mediaSelector, blockedStateSelector });
    }
    const playing = observed.playing === true || Boolean(selectedTitle && String(observed.title ?? "").toLowerCase().includes(String(selectedTitle).toLowerCase()) && !observed.paused && !observed.ended && observed.readyState >= 2);
    return {
      performed: started === true,
      playing,
      query,
      selectedTitle,
      mediaState: observed,
      url: observed.url,
      title: observed.title,
      consent: playbackConsent?.handled ? playbackConsent : consent,
      reason: playing ? null : "media-playback-not-observed"
    };
  }

  async researchState({
    resultSelector = "main a[href], article a[href], [role='main'] a[href]",
    limit = 12
  } = {}) {
    const selector = JSON.stringify(String(resultSelector));
    const bounded = Math.max(1, Math.min(50, Number(limit) || 12));
    return this._evaluate(`(() => {
      const clean=value=>String(value||"").replace(/\\s+/g," ").trim();
      const absolute=value=>{try{return new URL(value,location.href).href}catch{return null}};
      const items=[]; const seen=new Set();
      for(const anchor of document.querySelectorAll(${selector})){
        if(items.length>=${bounded})break;
        const href=absolute(anchor.getAttribute("href"));
        const container=anchor.closest("article,[data-result],[role='article'],div")||anchor;
        const text=clean(container.innerText||anchor.innerText||anchor.textContent);
        const title=clean(anchor.innerText||anchor.textContent||anchor.getAttribute("aria-label"));
        if(!href||!/^https?:/i.test(href)||!text||seen.has(href))continue;
        seen.add(href); items.push({title:title||text.slice(0,200),snippet:text.slice(0,1000),url:href});
      }
      return {found:items.length>0,items,sourceUrl:location.href,pageTitle:document.title,
        observedAt:new Date().toISOString(),reason:items.length?null:"research-results-not-found"};
    })()`);
  }

  async research({ url, resultSelector, limit = 12, signal = null } = {}) {
    if (!url) throw new Error("browser research requires an explicit URL");
    await this.launch({ url, signal });
    await this.wait({ condition: "document.readyState", value: "complete", timeoutMs: 15000, signal });
    return this.researchState({ resultSelector, limit });
  }

  async inspect({ limit = 120 } = {}) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 120));
    const elements = await this._evaluate(`(() => {
      const visible = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
        return r.width>0 && r.height>0 && s.visibility!=="hidden" && s.display!=="none"; };
      return [...document.querySelectorAll("a,button,input,select,textarea,[role],[contenteditable=true],h1,h2,h3,p")]
        .filter(visible).slice(0, ${bounded}).map((e, index) => {
          const r=e.getBoundingClientRect();
          return { index, tag:e.tagName.toLowerCase(), role:e.getAttribute("role"), id:e.id||null,
            name:e.getAttribute("name"), type:e.getAttribute("type"), text:(e.innerText||e.value||e.getAttribute("aria-label")||"").trim().slice(0,300),
            href:e.href||null, bounds:{x:r.x,y:r.y,width:r.width,height:r.height} };
        });
    })()`);
    return (elements ?? []).map(normalizeBrowserElement);
  }

  async find({ selector = null, text = null, role = null, name = null } = {}) {
    const query = JSON.stringify({ selector, text, role, name });
    const found = await this._evaluate(`(() => {
      const q=${query}; let candidates=[];
      if(q.selector){ try{candidates=[...document.querySelectorAll(q.selector)]}catch{return null} }
      else candidates=[...document.querySelectorAll("a,button,input,select,textarea,[role],[contenteditable=true],h1,h2,h3,p")];
      const norm=v=>(v||"").trim().toLowerCase();
      const hit=candidates.find(e => (!q.text || norm(e.innerText||e.value||e.getAttribute("aria-label")).includes(norm(q.text))) &&
        (!q.role || e.getAttribute("role")===q.role) && (!q.name || norm(e.getAttribute("name")||e.getAttribute("aria-label"))===norm(q.name)));
      if(!hit)return null; const r=hit.getBoundingClientRect();
      const token="syscora-"+crypto.randomUUID(); hit.dataset.syscoraTarget=token;
      return { targetId:token, source:"DOM", selector:'[data-syscora-target="'+token+'"]',
        name:hit.getAttribute("aria-label")||hit.getAttribute("name")||hit.innerText||hit.value||null,
        controlType:hit.tagName.toLowerCase(), boundingRect:{x:r.x,y:r.y,width:r.width,height:r.height},
        confidence:0.98, observedAt:new Date().toISOString(), url:location.href };
    })()`.replace("crypto.randomUUID()", "(globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2))"));
    if (!found) return { found: false, reason: "dom-target-not-found" };
    this.observedTargets.set(found.targetId, found);
    return { found: true, target: normalizeBrowserElement(found) };
  }

  async findBest({ selector, text, minCoverage = 0.5 } = {}) {
    if (!selector || !text) return { found: false, reason: "selector-and-text-required" };
    const query = JSON.stringify({ selector: String(selector), text: String(text), minCoverage: Number(minCoverage) });
    const found = await this._evaluate(`(() => {
      const q=${query}; let candidates=[]; try{candidates=[...document.querySelectorAll(q.selector)]}catch{return null}
      const tokens=value=>String(value||"").toLowerCase().match(/[a-z0-9]+/g)?.filter(x=>x.length>=2)||[];
      const wanted=[...new Set(tokens(q.text))]; let best=null;
      for(const hit of candidates){
        const label=(hit.innerText||hit.textContent||hit.getAttribute("aria-label")||hit.getAttribute("title")||"").trim();
        const actual=new Set(tokens(label)); const hits=wanted.filter(token=>actual.has(token)).length;
        const coverage=wanted.length?hits/wanted.length:0;
        if(!best||coverage>best.coverage||(coverage===best.coverage&&label.length>best.label.length))best={hit,label,coverage};
      }
      if(!best||best.coverage<Math.max(0,Math.min(1,q.minCoverage||0.5)))return null;
      const r=best.hit.getBoundingClientRect(); const token="syscora-"+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
      best.hit.dataset.syscoraTarget=token;
      return {targetId:token,source:"DOM",selector:'[data-syscora-target="'+token+'"]',name:best.label,
        controlType:best.hit.tagName.toLowerCase(),boundingRect:{x:r.x,y:r.y,width:r.width,height:r.height},
        confidence:best.coverage,observedAt:new Date().toISOString(),url:location.href,textCoverage:best.coverage};
    })()`);
    if (!found) return { found: false, reason: "matching-dom-target-not-found" };
    this.observedTargets.set(found.targetId, found);
    return { found: true, target: normalizeBrowserElement(found), textCoverage: found.textCoverage };
  }

  _targetSelector(target) {
    const observed = target?.targetId ? this.observedTargets.get(target.targetId) : null;
    if (!observed || observed.selector !== target.selector || target?.source !== "DOM") {
      throw new Error("A runtime-observed DOM target is required");
    }
    const age = Date.now() - Date.parse(observed.observedAt);
    if (!Number.isFinite(age) || age > 15000) throw new Error("DOM target is stale; call browser.find again");
    return JSON.stringify(target.selector);
  }

  async click({ target } = {}) {
    const selector = this._targetSelector(target);
    const point = await this._evaluate(`(() => { const e=document.querySelector(${selector}); if(!e)return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:null; })()`);
    if (!point) return { performed: false, target };
    let performed = false;
    try {
      // A DOM e.click() event is synthetic and does not satisfy autoplay,
      // popup, or other user-activation gates. Dispatch a real CDP mouse input
      // at the centre of the freshly observed target so browser actions have
      // the same trusted semantics as a physical click.
      await this.connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await this.connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      performed = true;
    } catch {
      // Older/restricted CDP endpoints may not expose the Input domain. Keep a
      // bounded compatibility fallback for ordinary controls.
      performed = await this._evaluate(`(() => { const e=document.querySelector(${selector}); if(!e)return false; e.click(); return true; })()`);
    }
    return { performed, target };
  }

  async type({ target, text, clear = true } = {}) {
    const selector = this._targetSelector(target);
    const payload = JSON.stringify(String(text ?? ""));
    const performed = await this._evaluate(`(() => { const e=document.querySelector(${selector}); if(!e)return false;
      e.focus(); if(${clear ? "true" : "false"}) e.value=""; e.value+=${payload};
      e.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:${payload}}));
      e.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
    return { performed, length: String(text ?? "").length, target };
  }

  async select({ target, value } = {}) {
    const selector = this._targetSelector(target);
    const payload = JSON.stringify(String(value ?? ""));
    const performed = await this._evaluate(`(() => { const e=document.querySelector(${selector}); if(!(e instanceof HTMLSelectElement))return false;
      e.value=${payload}; e.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
    return { performed, value, target };
  }

  async scroll({ target = null, x = 0, y = 600 } = {}) {
    const scrollBefore = await this._evaluate(`({x:scrollX,y:scrollY})`);
    const expression = target
      ? `(() => { const e=document.querySelector(${this._targetSelector(target)}); if(!e)return false; e.scrollIntoView({block:"center"}); return true; })()`
      : `(() => { scrollBy(${Number(x) || 0},${Number(y) || 0}); return true; })()`;
    const performed = await this._evaluate(expression);
    const scrollAfter = await this._evaluate(`({x:scrollX,y:scrollY})`);
    return {
      performed,
      scrollBefore,
      scrollAfter,
      moved: scrollBefore.x !== scrollAfter.x || scrollBefore.y !== scrollAfter.y
    };
  }

  async wait({ condition = "selector", selector = null, value = null, timeoutMs = 10000, signal = null } = {}) {
    const deadline = Date.now() + Math.min(30000, Math.max(100, Number(timeoutMs) || 10000));
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const matched = condition === "document.readyState"
        ? await this._evaluate(`document.readyState === ${JSON.stringify(value ?? "complete")}`)
        : await this._evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      if (matched) return { matched: true, condition, selector, value };
      await delay(100);
    }
    return { matched: false, reason: "browser-wait-timeout", condition, selector, value };
  }

  async read({ target = null, selector = null } = {}) {
    const selected = target ? this._targetSelector(target) : JSON.stringify(selector ?? "body");
    const result = await this._evaluate(`(() => { const e=document.querySelector(${selected}); return e ? (e.innerText||e.value||e.textContent||"").trim() : null; })()`);
    return { found: result != null, text: result };
  }

  async extract({ kind = "text", query = null, selector = "body" } = {}) {
    const payload = JSON.stringify({ kind: String(kind), query: query == null ? null : String(query), selector: String(selector || "body") });
    const result = await this._evaluate(`(() => {
      const cfg=${payload}; const root=document.querySelector(cfg.selector); if(!root)return {found:false,reason:"selector-not-found"};
      const text=(root.innerText||root.textContent||"").trim();
      const lines=text.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);
      const query=(cfg.query||"").toLowerCase();
      const ranked=query ? [...lines.filter(x=>x.toLowerCase().includes(query)), ...lines.filter(x=>!x.toLowerCase().includes(query))] : lines;
      let value=null, evidence=null;
      for(const line of ranked){
        const match=cfg.kind==="version" ? line.match(/\\b\\d+(?:\\.\\d+){1,3}\\b/) :
          cfg.kind==="number" ? line.match(/[-+]?\\d+(?:[,.]\\d+)?/) : null;
        if(match){value=match[0];evidence=line.slice(0,500);break;}
      }
      if(cfg.kind==="text"){const line=ranked[0]||null;value=line;evidence=line;}
      return value==null ? {found:false,reason:"value-not-found",kind:cfg.kind} : {found:true,value,kind:cfg.kind,evidence,sourceUrl:location.href};
    })()`);
    return result;
  }

  async download({ target, directory, timeoutMs = 20000 } = {}) {
    if (!path.isAbsolute(String(directory ?? ""))) throw new Error("Download directory must be absolute");
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error("Download directory does not exist");
    const before = new Set(fs.readdirSync(directory));
    await this.connection.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
    const clicked = await this.click({ target });
    if (!clicked.performed) return { downloaded: false, reason: "download-target-not-clicked" };
    const deadline = Date.now() + Math.min(60000, Math.max(500, Number(timeoutMs) || 20000));
    while (Date.now() < deadline) {
      const files = fs.readdirSync(directory);
      const added = files.find((file) => !before.has(file) && !file.endsWith(".crdownload"));
      if (added) return { downloaded: true, path: path.join(directory, added), target };
      await delay(150);
    }
    return { downloaded: false, reason: "download-timeout", target };
  }

  close() {
    this.connection?.close();
    if (this.process) {
      this.process.stderr?.removeAllListeners();
      this.process.stderr?.destroy();
      try { this.process.kill(); } catch { /* process already exited */ }
      this.process.unref?.();
    }
    this.connection = null;
    this.process = null;
    this.observedTargets.clear();
    if (this.userDataDir && this.userDataDir.startsWith(path.join(os.tmpdir(), "syscora-cdp-"))) {
      try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* browser may still be releasing files */ }
    }
    this.userDataDir = null;
  }
}
