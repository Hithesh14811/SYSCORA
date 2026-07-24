import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async launch({ url = "about:blank", headless = false } = {}) {
    if (this.process && this.connection) {
      if (url && url !== "about:blank") await this.navigate({ url });
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
      return { launched: true, executable, target: this.target, lifecycle: structuredClone(this.lifecycle) };
    } catch (error) {
      if (this.connection !== browserConnection) browserConnection.close();
      const code = error.code ?? (/timed out/i.test(error.message) ? "CDP_TIMEOUT" : "CDP_START_FAILED");
      this._transition(BrowserLifecycleState.FAILED, { code });
      this.close();
      throw browserError(code, error.message, error);
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

  async navigate({ url, waitUntil = "complete", timeoutMs = 15000 } = {}) {
    if (!/^(?:https?:\/\/|data:text\/html(?:[;,]|$)|about:blank$)/i.test(String(url))) {
      throw browserError("NAVIGATION_FAILED", "browser.navigate requires an http(s), HTML data, or about:blank URL");
    }
    try {
      await this.connection.send("Page.navigate", { url });
    } catch (error) {
      throw browserError("NAVIGATION_FAILED", `Browser navigation failed: ${error.message}`, error);
    }
    this.observedTargets.clear();
    await this.wait({ condition: "document.readyState", value: waitUntil, timeoutMs });
    return this.currentState();
  }

  async currentState() {
    return this._evaluate(`(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight },
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        id: document.activeElement.id,
        name: document.activeElement.getAttribute("name")
      } : null
    }))()`);
  }

  async inspect({ limit = 120 } = {}) {
    const bounded = Math.max(1, Math.min(500, Number(limit) || 120));
    return this._evaluate(`(() => {
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
    return { found: true, target: found };
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
    const performed = await this._evaluate(`(() => { const e=document.querySelector(${selector}); if(!e)return false; e.scrollIntoView({block:"center"}); e.click(); return true; })()`);
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
    const expression = target
      ? `(() => { const e=document.querySelector(${this._targetSelector(target)}); if(!e)return false; e.scrollIntoView({block:"center"}); return true; })()`
      : `(() => { scrollBy(${Number(x) || 0},${Number(y) || 0}); return true; })()`;
    return { performed: await this._evaluate(expression) };
  }

  async wait({ condition = "selector", selector = null, value = null, timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + Math.min(30000, Math.max(100, Number(timeoutMs) || 10000));
    while (Date.now() < deadline) {
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
    this.process?.kill();
    this.connection = null;
    this.process = null;
    this.observedTargets.clear();
    if (this.userDataDir && this.userDataDir.startsWith(path.join(os.tmpdir(), "syscora-cdp-"))) {
      try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* browser may still be releasing files */ }
    }
    this.userDataDir = null;
  }
}
