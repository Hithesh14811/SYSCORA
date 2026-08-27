import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const PACKAGE_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const WIRELESS_ENDPOINT = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/;
const PLATFORM_TOOLS_URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const MAX_PLATFORM_TOOLS_ARCHIVE_BYTES = 100 * 1024 * 1024;

const KEY_CODES = Object.freeze({
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recent: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  delete: "KEYCODE_DEL",
  power: "KEYCODE_POWER",
  wake: "KEYCODE_WAKEUP",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  volume_mute: "KEYCODE_VOLUME_MUTE",
  media_play_pause: "KEYCODE_MEDIA_PLAY_PAUSE",
  media_next: "KEYCODE_MEDIA_NEXT",
  media_previous: "KEYCODE_MEDIA_PREVIOUS"
});

function assertDeviceId(value) {
  const serial = String(value ?? "").trim();
  if (!DEVICE_ID.test(serial)) throw new Error("A valid Android device serial is required.");
  return serial;
}

function assertEndpoint(value) {
  const endpoint = String(value ?? "").trim();
  const match = WIRELESS_ENDPOINT.exec(endpoint);
  const port = Number(match?.[1]);
  if (!match || port > 65535) throw new Error("Wireless Android endpoints must be an exact host:port value.");
  return endpoint;
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value ?? ""));
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function bool(value) {
  return String(value).toLowerCase() === "true";
}

function nodeIdentity(node) {
  return crypto.createHash("sha256").update(JSON.stringify([
    node.resourceId, node.className, node.text, node.description, node.semanticLabel,
    node.bounds?.x, node.bounds?.y, node.bounds?.width, node.bounds?.height,
    node.enabled, node.focused, node.selected, node.checked
  ])).digest("hex").slice(0, 16);
}

/** Parse a UIAutomator hierarchy without retaining password-field contents. */
export function parseAndroidHierarchy(xml, { maxNodes = 700 } = {}) {
  const source = String(xml ?? "");
  const nodes = [];
  const nodePattern = /<node\b([^>]*?)(?:\/>|>)/g;
  let nodeMatch;
  while (nodes.length < Math.max(1, Number(maxNodes) || 700) && (nodeMatch = nodePattern.exec(source))) {
    const attributes = {};
    const attributePattern = /([\w:-]+)="([^"]*)"/g;
    let attributeMatch;
    while ((attributeMatch = attributePattern.exec(nodeMatch[1]))) {
      attributes[attributeMatch[1]] = decodeXml(attributeMatch[2]);
    }
    const bounds = parseBounds(attributes.bounds);
    if (!bounds) continue;
    const password = bool(attributes.password);
    const className = attributes.class || "";
    const node = {
      id: "",
      text: password ? "[password hidden]" : (attributes.text || ""),
      description: password ? "" : (attributes["content-desc"] || ""),
      resourceId: attributes["resource-id"] || "",
      className,
      role: className.includes(".") ? className.slice(className.lastIndexOf(".") + 1) : className,
      packageName: attributes.package || "",
      bounds,
      center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
      clickable: bool(attributes.clickable),
      enabled: attributes.enabled == null ? true : bool(attributes.enabled),
      focusable: bool(attributes.focusable),
      focused: bool(attributes.focused),
      scrollable: bool(attributes.scrollable),
      selected: bool(attributes.selected),
      checked: bool(attributes.checked),
      editable: /EditText|AutoCompleteTextView/i.test(className),
      password,
      semanticLabel: ""
    };
    nodes.push(node);
  }

  // Android frequently puts the words on a non-clickable child and the click
  // handler on an unlabelled parent View. A flat accessibility listing loses
  // that relationship and makes an ordinary labelled tab look untappable. Bind
  // the smallest containing labelled descendants back to an otherwise
  // unlabelled actionable container. This is geometry published by Android,
  // not a guessed coordinate, and works for tabs, cards, rows and modal buttons.
  const labelled = nodes.filter((node) => !node.password && (node.text || node.description));
  for (const node of nodes) {
    if ((!node.clickable && !node.editable) || node.text || node.description) continue;
    const area = node.bounds.width * node.bounds.height;
    const inside = labelled.filter((candidate) => {
      if (candidate === node) return false;
      const center = candidate.center;
      const contained = center.x >= node.bounds.x && center.x <= node.bounds.x + node.bounds.width
        && center.y >= node.bounds.y && center.y <= node.bounds.y + node.bounds.height;
      if (!contained) return false;
      const candidateArea = candidate.bounds.width * candidate.bounds.height;
      return candidateArea <= area && area <= Math.max(candidateArea * 40, 20_000);
    }).sort((left, right) => {
      const leftArea = left.bounds.width * left.bounds.height;
      const rightArea = right.bounds.width * right.bounds.height;
      return leftArea - rightArea;
    });
    const labels = [...new Set(inside.map((candidate) => candidate.text || candidate.description).filter(Boolean))];
    if (labels.length > 0 && labels.length <= 4) node.semanticLabel = labels.join(" ").slice(0, 240);
  }
  for (const node of nodes) node.id = nodeIdentity(node);
  const signature = crypto.createHash("sha256").update(nodes.map((node) => node.id).join("|")).digest("hex");
  return { nodes, signature };
}

function parseProperties(output) {
  const values = {};
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function parseKeyValues(output) {
  const values = {};
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1].trim()] = match[2];
  }
  return values;
}

function safeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// `adb shell` does not involve a Windows shell, but Android still parses the
// command with its own remote shell. Quote every value whose contents are not
// from a closed local allow-list before it crosses that second boundary.
function quoteAndroidShellArgument(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseLockState(output) {
  const text = String(output ?? "");
  const locked = /(?:isStatusBarKeyguard|showing|mShowingLockscreen)\s*[=:]\s*true/i.test(text);
  const secure = /mIsSecure\s*[=:]\s*true/i.test(text) ? true
    : /mIsSecure\s*[=:]\s*false/i.test(text) ? false
      : null;
  return { locked, secure, canDismissWithoutCredential: locked && secure === false };
}

function normalizeResult(result) {
  if (result && typeof result === "object" && Number.isInteger(result.exitCode)) return result;
  throw new Error("The Android command runner returned an invalid result.");
}

function abortableDelay(ms, signal = null) {
  if (signal?.aborted) return Promise.reject(new Error("Android command was cancelled."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Android command was cancelled."));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Screenshot-free, multi-device Android control over the official ADB boundary.
 * Commands for one device are serialized; independent devices run concurrently.
 */
export class AndroidAdapter {
  constructor({
    adbPath = process.env.SYSCORA_ADB_PATH || null,
    runner = null,
    setupRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "SYSCORA", "tools", "android"),
    fetchImpl = globalThis.fetch,
    extractArchive = null
  } = {}) {
    this.adbPath = adbPath || "adb";
    this.explicitAdbPath = Boolean(adbPath);
    this.runner = runner;
    this.setupRoot = path.resolve(setupRoot);
    this.fetchImpl = fetchImpl;
    this.extractArchive = extractArchive;
    this.deviceQueues = new Map();
    this.lastDeviceSnapshot = [];
  }

  _adbCandidates() {
    if (this.explicitAdbPath) return [this.adbPath];
    return [...new Set([
      this.adbPath,
      path.join(this.setupRoot, "platform-tools", "adb.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, "platform-tools", "adb.exe"),
      // The official zip contains a platform-tools directory. A common manual
      // extraction destination is itself also named platform-tools.
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, "platform-tools", "platform-tools", "adb.exe")
    ].filter(Boolean))];
  }

  async _spawnExecutable(executable, args, { timeoutMs = DEFAULT_TIMEOUT_MS, stdin = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let timedOut = false;
      let overflowed = false;
      let settled = false;
      let exitCode = null;
      let exitFlush = null;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(250, timeoutMs));
      const onAbort = () => child.kill();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort, { once: true });
      const collect = (target) => (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          overflowed = true;
          child.kill();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      const cleanup = () => {
        clearTimeout(timer);
        if (exitFlush) clearTimeout(exitFlush);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const finish = (code = exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        resolve({
          exitCode: Number.isInteger(code) ? code : -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
          aborted: signal?.aborted === true,
          overflowed
        });
      };
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once("exit", (code) => {
        exitCode = code;
        // adb start-server launches a daemon which may inherit stdout/stderr.
        // The command is finished when adb exits, even if the daemon keeps an
        // inherited pipe open. Waiting only for "close" caused the 10-minute
        // foreground deadlock seen after USB authorization.
        exitFlush = setTimeout(() => finish(code), 100);
      });
      child.once("close", (code) => {
        finish(Number.isInteger(code) ? code : exitCode);
      });
      if (stdin != null) child.stdin.end(String(stdin)); else child.stdin.end();
    });
  }

  async _spawn(args, options = {}) {
    if (this.runner) return normalizeResult(await this.runner(this.adbPath, args, options));
    let lastError = null;
    for (const candidate of this._adbCandidates()) {
      try {
        const result = await this._spawnExecutable(candidate, args, options);
        this.adbPath = candidate;
        return result;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    throw new Error(lastError?.code === "ENOENT"
      ? "Android Platform Tools (adb) were not found. This check is conclusive; do not run another software or shell check. Use the bounded Android setup operation or set SYSCORA_ADB_PATH."
      : (lastError?.message ?? "Android Platform Tools could not be started."));
  }

  async _verifyAdbExecutable(executable, options = {}) {
    if (this.runner) return normalizeResult(await this.runner(executable, ["version"], options));
    return this._spawnExecutable(executable, ["version"], options);
  }

  async _adb(args, options = {}) {
    const result = await this._spawn(args.map(String), options);
    if (result.timedOut) throw new Error(`Android command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
    if (result.aborted) throw new Error("Android command was cancelled.");
    if (result.overflowed) throw new Error("Android command returned too much data and was stopped.");
    if (result.exitCode !== 0) throw new Error(String(result.stderr || result.stdout || "adb failed").trim());
    return result;
  }

  _forDevice(serial, operation) {
    const id = assertDeviceId(serial);
    const prior = this.deviceQueues.get(id) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    this.deviceQueues.set(id, current);
    current.finally(() => {
      if (this.deviceQueues.get(id) === current) this.deviceQueues.delete(id);
    }).catch(() => {});
    return current;
  }

  _device(serial, args, options = {}) {
    const id = assertDeviceId(serial);
    return this._adb(["-s", id, ...args], options);
  }

  async isAvailable() {
    try {
      const result = await this._adb(["version"], { timeoutMs: 3_000 });
      return {
        available: /Android Debug Bridge/i.test(result.stdout),
        version: result.stdout.split(/\r?\n/)[0] || null,
        path: this.adbPath
      };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  /**
   * Install Google's official Platform Tools into SYSCORA's private tools
   * directory. This deliberately does not modify PATH: a running process cannot
   * inherit a user PATH change, which is how a successful install still looked
   * missing until restart. The adapter switches to the validated executable in
   * memory and can list devices in the very next call.
   */
  async setupPlatformTools({ onProgress = null, signal = null } = {}) {
    const report = (progress) => {
      try { onProgress?.(progress); } catch { /* progress must not break setup */ }
    };
    const available = await this.isAvailable();
    if (available.available) {
      return { installed: true, alreadyAvailable: true, path: available.path, version: available.version };
    }
    if (process.platform !== "win32") {
      throw new Error("Automatic Android Platform Tools setup is currently supported on Windows only.");
    }
    if (typeof this.fetchImpl !== "function") throw new Error("No HTTPS download implementation is available.");

    const parent = path.dirname(this.setupRoot);
    const installRoot = path.join(parent, `.android-install-${crypto.randomUUID()}`);
    const archivePath = path.join(installRoot, "platform-tools.zip");
    const extractedAdb = path.join(installRoot, "platform-tools", "adb.exe");
    const destination = path.join(this.setupRoot, "platform-tools");
    const destinationAdb = path.join(destination, "adb.exe");
    const backup = path.join(this.setupRoot, `.platform-tools-backup-${crypto.randomUUID()}`);
    let destinationMoved = false;
    await fs.mkdir(installRoot, { recursive: true });
    try {
      report({ percent: 0, phase: "Downloading Android Platform Tools", label: "Starting secure download from Google" });
      const response = await this.fetchImpl(PLATFORM_TOOLS_URL, { signal });
      if (!response?.ok || !response.body?.getReader) {
        throw new Error(`Google Platform Tools download failed${response?.status ? ` (HTTP ${response.status})` : ""}.`);
      }
      const total = Number(response.headers?.get?.("content-length")) || null;
      if (total && total > MAX_PLATFORM_TOOLS_ARCHIVE_BYTES) throw new Error("The Platform Tools download is unexpectedly large.");
      const file = await fs.open(archivePath, "w");
      let received = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          if (signal?.aborted) throw new Error("Android Platform Tools setup was cancelled.");
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_PLATFORM_TOOLS_ARCHIVE_BYTES) throw new Error("The Platform Tools download exceeded the safety limit.");
          await file.write(Buffer.from(value));
          report({
            percent: total ? Math.min(75, Math.round((received / total) * 75)) : null,
            phase: "Downloading Android Platform Tools",
            label: total ? `${Math.round(received / 1024 / 1024 * 10) / 10} MB of ${Math.round(total / 1024 / 1024 * 10) / 10} MB` : `${Math.round(received / 1024)} KB received`
          });
        }
      } finally {
        await file.close();
      }
      if (received === 0) throw new Error("Google returned an empty Platform Tools archive.");

      report({ percent: 80, phase: "Extracting Android Platform Tools", label: "Unpacking the downloaded archive" });
      if (this.extractArchive) {
        await this.extractArchive(archivePath, installRoot);
      } else {
        const extracted = await this._spawnExecutable("tar.exe", ["-xf", archivePath, "-C", installRoot], {
          timeoutMs: 30_000,
          signal
        });
        if (extracted.exitCode !== 0 || extracted.timedOut || extracted.aborted) {
          throw new Error(extracted.stderr.trim() || "Windows could not extract the Platform Tools archive.");
        }
      }
      await fs.access(extractedAdb);
      const verified = await this._verifyAdbExecutable(extractedAdb, { timeoutMs: 5_000, signal });
      if (verified.exitCode !== 0 || !/Android Debug Bridge/i.test(verified.stdout)) {
        throw new Error("The downloaded adb executable did not pass its version check.");
      }

      await fs.mkdir(this.setupRoot, { recursive: true });
      try {
        await fs.rename(destination, backup);
        destinationMoved = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await fs.rename(path.join(installRoot, "platform-tools"), destination);
      } catch (error) {
        if (destinationMoved) await fs.rename(backup, destination).catch(() => {});
        throw error;
      }
      if (destinationMoved) await fs.rm(backup, { recursive: true, force: true });
      this.adbPath = destinationAdb;
      this.explicitAdbPath = true;
      report({ percent: 100, phase: "Android Platform Tools ready", label: "adb was verified and activated" });
      return {
        installed: true,
        alreadyAvailable: false,
        path: destinationAdb,
        version: verified.stdout.split(/\r?\n/)[0] || null,
        restartRequired: false
      };
    } finally {
      await fs.rm(installRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  _parseDevices(output) {
    const devices = [];
    for (const line of String(output ?? "").split(/\r?\n/).slice(1)) {
      const match = /^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/.exec(line.trim());
      if (!match) continue;
      const details = Object.fromEntries(String(match[3] ?? "").split(/\s+/).map((part) => part.split(/:(.*)/s)).filter((pair) => pair.length >= 2 && pair[0]));
      devices.push({
        serial: match[1], state: match[2], wireless: match[1].includes(":"),
        model: details.model ?? null, product: details.product ?? null, device: details.device ?? null,
        transportId: details.transport_id ?? null
      });
    }
    return devices;
  }

  async _listDevicesOnce({ signal = null, timeoutMs = 20_000 } = {}) {
    // The first adb call starts its local server and Windows can put a firewall
    // consent dialog in front of that startup. Five seconds was shorter than a
    // human could read and accept it, turning a healthy first run into a timeout
    // just as the server became ready. Later calls still return immediately.
    const result = await this._adb(["devices", "-l"], { timeoutMs, signal });
    const devices = this._parseDevices(result.stdout);
    return { devices, count: devices.length };
  }

  async listDevices({ signal = null, onProgress = null, stabilizeMs = 12_000, pollIntervalMs = 350 } = {}) {
    const previous = this.lastDeviceSnapshot;
    let result = await this._listDevicesOnce({ signal });
    // Accepting the RSA prompt briefly resets USB on many phones. The old code
    // observed that one empty instant, told the model the phone vanished, and
    // the model escaped into raw shell. If the immediately preceding snapshot
    // was unauthorized, absorb that expected reconnect here and return on the
    // first real ADB state instead of spending another model turn.
    const authorizationReset = result.count === 0 && previous.some((device) => device.state === "unauthorized");
    if (authorizationReset) {
      const startedAt = Date.now();
      const deadline = startedAt + Math.max(0, stabilizeMs);
      while (result.count === 0 && Date.now() < deadline) {
        const elapsedMs = Date.now() - startedAt;
        try {
          onProgress?.({
            percent: null,
            phase: "Waiting for Android to reconnect",
            label: `USB authorization was accepted; reconnecting (${Math.max(1, Math.round(elapsedMs / 1000))}s)`
          });
        } catch { /* progress must never break discovery */ }
        await abortableDelay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
        result = await this._listDevicesOnce({ signal, timeoutMs: Math.min(5_000, Math.max(500, deadline - Date.now())) });
      }
      result = { ...result, authorizationReset: true, waitedMs: Date.now() - startedAt };
    }
    this.lastDeviceSnapshot = result.devices;
    return result;
  }

  async waitForDevices({ signal = null, onProgress = null, timeoutMs = 20_000, pollIntervalMs = 350 } = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(500, timeoutMs);
    let result = { devices: [], count: 0 };
    while (Date.now() < deadline) {
      result = await this._listDevicesOnce({ signal, timeoutMs: Math.min(5_000, Math.max(500, deadline - Date.now())) });
      if (result.count > 0) {
        this.lastDeviceSnapshot = result.devices;
        return { ...result, waitedMs: Date.now() - startedAt };
      }
      try {
        onProgress?.({ percent: null, phase: "Waiting for Android", label: `No device yet — ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s` });
      } catch { /* progress must never break discovery */ }
      await abortableDelay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
    }
    this.lastDeviceSnapshot = [];
    return { ...result, waitedMs: Date.now() - startedAt, timedOut: true };
  }

  async refreshDevices(options = {}) {
    await this._adb(["kill-server"], { timeoutMs: 8_000, signal: options.signal });
    await this._adb(["start-server"], { timeoutMs: 15_000, signal: options.signal });
    return this.waitForDevices(options);
  }

  async connect(endpoint) {
    const target = assertEndpoint(endpoint);
    const result = await this._adb(["connect", target], { timeoutMs: 12_000 });
    const connected = /connected to|already connected to/i.test(result.stdout);
    if (!connected) throw new Error(result.stdout.trim() || `Could not connect to ${target}.`);
    return { connected: true, endpoint: target, message: result.stdout.trim() };
  }

  async pair(endpoint, pairingCode) {
    const target = assertEndpoint(endpoint);
    const code = String(pairingCode ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw new Error("The Android wireless pairing code must contain exactly six digits.");
    // The code travels on stdin, not in the process command line or logs.
    const result = await this._adb(["pair", target], { timeoutMs: 20_000, stdin: `${code}\n` });
    const paired = /successfully paired/i.test(result.stdout);
    if (!paired) throw new Error(result.stdout.trim() || `Could not pair with ${target}.`);
    return { paired: true, endpoint: target, message: result.stdout.replace(code, "[redacted]").trim() };
  }

  async disconnect(endpoint) {
    const target = assertEndpoint(endpoint);
    const result = await this._adb(["disconnect", target], { timeoutMs: 8_000 });
    return { disconnected: /disconnected/i.test(result.stdout), endpoint: target, message: result.stdout.trim() };
  }

  async inspectDevice(serial) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const [propsResult, batteryResult, displayResult, storageResult, windowResult, lockResult] = await Promise.all([
        this._device(id, ["shell", "getprop"]),
        this._device(id, ["shell", "dumpsys", "battery"]),
        this._device(id, ["shell", "wm", "size"]),
        this._device(id, ["shell", "df", "-k", "/data"]),
        this._device(id, ["shell", "dumpsys", "window", "windows"]),
        this._device(id, ["shell", "dumpsys", "window", "policy"])
      ]);
      const props = parseProperties(propsResult.stdout);
      const battery = parseKeyValues(batteryResult.stdout);
      const physicalSize = /Physical size:\s*(\d+)x(\d+)/i.exec(displayResult.stdout)
        ?? /Override size:\s*(\d+)x(\d+)/i.exec(displayResult.stdout);
      const foreground = /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9._]+)\/([^}\s]+)/.exec(windowResult.stdout)
        ?? /mFocusedApp=.*\s([A-Za-z0-9._]+)\/([^}\s]+)/.exec(windowResult.stdout);
      const lock = parseLockState(lockResult.stdout);
      const dataLine = storageResult.stdout.split(/\r?\n/).find((line) => /\/data\s*$/.test(line.trim()));
      const storageColumns = dataLine?.trim().split(/\s+/) ?? [];
      return {
        serial: id,
        identity: {
          manufacturer: props["ro.product.manufacturer"] || null,
          model: props["ro.product.model"] || null,
          device: props["ro.product.device"] || null,
          hardware: props["ro.hardware"] || null
        },
        os: {
          androidVersion: props["ro.build.version.release"] || null,
          sdk: safeInteger(props["ro.build.version.sdk"]),
          securityPatch: props["ro.build.version.security_patch"] || null,
          build: props["ro.build.display.id"] || null
        },
        battery: {
          level: safeInteger(battery.level), status: safeInteger(battery.status),
          plugged: safeInteger(battery.plugged), temperatureC: safeInteger(battery.temperature) == null ? null : safeInteger(battery.temperature) / 10
        },
        display: physicalSize ? { width: Number(physicalSize[1]), height: Number(physicalSize[2]) } : null,
        storage: storageColumns.length >= 6 ? {
          totalKb: safeInteger(storageColumns[1]), usedKb: safeInteger(storageColumns[2]),
          availableKb: safeInteger(storageColumns[3]), usedPercent: storageColumns[4]
        } : null,
        foregroundApp: foreground ? { packageName: foreground[1], activity: foreground[2] } : null,
        lock,
        connectivity: { adb: "device", wireless: id.includes(":") }
      };
    });
  }

  async listPackages(serial, { includeSystem = false, query = "", limit = 500 } = {}) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const args = ["shell", "pm", "list", "packages", ...(includeSystem ? [] : ["-3"]), "-f"];
      const result = await this._device(id, args);
      const needle = String(query).trim().toLowerCase();
      const packages = result.stdout.split(/\r?\n/).map((line) => {
        const match = /^package:(.*?)=([A-Za-z0-9._]+)$/.exec(line.trim());
        return match ? { apkPath: match[1], packageName: match[2] } : null;
      }).filter(Boolean).filter((item) => !needle || item.packageName.toLowerCase().includes(needle)).slice(0, Math.min(2000, Math.max(1, Number(limit) || 500)));
      return { serial: id, packages, count: packages.length, systemPackagesIncluded: includeSystem };
    });
  }

  async readUi(serial, options = {}) {
    return this._forDevice(serial, () => this._readUiUnlocked(assertDeviceId(serial), options));
  }

  async _readUiUnlocked(serial, { maxNodes = 700 } = {}) {
    const result = await this._device(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 8_000 });
    const start = result.stdout.indexOf("<?xml");
    const fallback = result.stdout.indexOf("<hierarchy");
    const xmlStart = start >= 0 ? start : fallback;
    if (xmlStart < 0) throw new Error("Android did not publish an accessibility hierarchy for the current screen.");
    const parsed = parseAndroidHierarchy(result.stdout.slice(xmlStart), { maxNodes });
    return { serial, read: true, ...parsed };
  }

  _select(nodes, selector = {}) {
    const normalized = {
      text: String(selector.text ?? "").trim().toLowerCase(),
      textContains: String(selector.textContains ?? "").trim().toLowerCase(),
      description: String(selector.description ?? "").trim().toLowerCase(),
      resourceId: String(selector.resourceId ?? "").trim(),
      className: String(selector.className ?? "").trim(),
      id: String(selector.id ?? "").trim()
    };
    if (!Object.values(normalized).some(Boolean)) throw new Error("A semantic Android selector is required; coordinate-only actions are not accepted.");
    const matches = nodes.filter((node) => {
      if (node.password) return false;
      if (normalized.id && node.id !== normalized.id) return false;
      const semanticText = [node.text, node.semanticLabel].filter(Boolean).join(" ").toLowerCase();
      if (normalized.text && node.text.toLowerCase() !== normalized.text && node.semanticLabel.toLowerCase() !== normalized.text) return false;
      if (normalized.textContains && !semanticText.includes(normalized.textContains)) return false;
      if (normalized.description && node.description.toLowerCase() !== normalized.description) return false;
      if (normalized.resourceId && node.resourceId !== normalized.resourceId) return false;
      if (normalized.className && node.className !== normalized.className) return false;
      if (selector.clickable === true && !node.clickable) return false;
      if (selector.editable === true && !node.editable) return false;
      return node.enabled;
    });
    const occurrence = selector.occurrence == null ? null : Number(selector.occurrence);
    if (Number.isInteger(occurrence) && occurrence >= 0 && occurrence < matches.length) return matches[occurrence];
    if (matches.length === 0) throw new Error("No accessible Android element matches that selector.");
    if (matches.length > 1) {
      const summary = matches.slice(0, 6).map((node, index) => `${index}: ${node.role} ${JSON.stringify(node.text || node.description || node.resourceId)}`).join("; ");
      throw new Error(`The selector is ambiguous (${matches.length} matches). Add resourceId, className, id, or occurrence. ${summary}`);
    }
    return matches[0];
  }

  async _waitForUiChange(serial, beforeSignature, timeoutMs = 2_000) {
    const deadline = Date.now() + Math.min(5_000, Math.max(0, Number(timeoutMs) || 0));
    let latest = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        latest = await this._readUiUnlocked(serial, { maxNodes: 700 });
        if (latest.signature !== beforeSignature) return { changed: true, ui: latest };
      } catch { /* transient while an activity is changing */ }
    }
    return { changed: false, ui: latest };
  }

  async tap(serial, selector, { waitForChangeMs = 2_000 } = {}) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const before = await this._readUiUnlocked(id);
      let target;
      try {
        // Prefer the clickable semantic owner when both it and a static child
        // carry the same visible label. This removes an artificial ambiguity
        // without weakening the real ambiguity check between two buttons.
        target = this._select(before.nodes, { ...selector, clickable: true });
      } catch (error) {
        if (!/No accessible Android element matches/i.test(String(error?.message ?? error))) throw error;
        target = this._select(before.nodes, selector);
      }
      // A selector may legitimately name the static label inside a tappable
      // container. Resolve the smallest enabled clickable container that owns
      // the label rather than injecting a tap into a node Android says cannot
      // be clicked.
      if (!target.clickable) {
        const owners = before.nodes.filter((candidate) => candidate.enabled && candidate.clickable
          && target.center.x >= candidate.bounds.x
          && target.center.x <= candidate.bounds.x + candidate.bounds.width
          && target.center.y >= candidate.bounds.y
          && target.center.y <= candidate.bounds.y + candidate.bounds.height)
          .sort((left, right) => (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height));
        if (owners.length === 0) {
          throw new Error(`The matched Android element ${JSON.stringify(target.text || target.description || target.resourceId)} is not clickable and has no accessible clickable container.`);
        }
        target = owners[0];
      }
      await this._device(id, ["shell", "input", "tap", target.center.x, target.center.y]);
      const observation = await this._waitForUiChange(id, before.signature, waitForChangeMs);
      return { performed: true, serial: id, target, changed: observation.changed, ui: observation.ui };
    });
  }

  async typeText(serial, selector, text, { clear = false, waitForChangeMs = 1_500 } = {}) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const value = String(text ?? "");
      if (!value) throw new Error("Text cannot be empty.");
      if (!/^[\x20-\x7E\n\r\t]*$/.test(value)) {
        throw new Error("Reliable Unicode input needs the optional SYSCORA Android companion; ADB text input is limited to ASCII.");
      }
      const before = await this._readUiUnlocked(id);
      const target = this._select(before.nodes, { ...selector, editable: true });
      if (target.password) throw new Error("SYSCORA will not read from or type into Android password fields.");
      await this._device(id, ["shell", "input", "tap", target.center.x, target.center.y]);
      if (clear) {
        await this._device(id, ["shell", "input", "keyevent", "KEYCODE_MOVE_END"]);
        // Android has no stable cross-version "clear this field" ADB verb.
        // Delete the accessibility-published value character-by-character in
        // one bounded command. If the app withholds its value, refuse instead
        // of claiming a clear that may leave user text behind.
        if (!target.text || target.text === "[password hidden]") {
          throw new Error("This Android field does not publish its current value, so it cannot be cleared safely without the companion service.");
        }
        const deleteCount = Math.min(2_000, [...target.text].length);
        await this._device(id, ["shell", "input", "keyevent", ...Array.from({ length: deleteCount }, () => "KEYCODE_DEL")]);
      }
      // `adb shell` ultimately crosses Android's remote shell boundary. Keep
      // text to a deliberately non-executable alphabet; reject unsupported
      // characters instead of silently changing what the user asked to type.
      if (!/^[A-Za-z0-9 @._,+:/=\-]*$/.test(value)) {
        throw new Error("ADB text input cannot safely type one or more requested punctuation characters. Use the optional Android companion for full text input.");
      }
      const encoded = value.replace(/ /g, "%s");
      await this._device(id, ["shell", "input", "text", encoded]);
      const observation = await this._waitForUiChange(id, before.signature, waitForChangeMs);
      return { performed: true, serial: id, target, changed: observation.changed, characters: value.length, ui: observation.ui };
    });
  }

  async pressKey(serial, key) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const normalized = String(key ?? "").trim().toLowerCase();
      const code = KEY_CODES[normalized];
      if (!code) throw new Error(`Unsupported Android key. Allowed keys: ${Object.keys(KEY_CODES).join(", ")}.`);
      await this._device(id, ["shell", "input", "keyevent", code]);
      return { performed: true, serial: id, key: normalized };
    });
  }

  async scroll(serial, { direction = "down", selector = null } = {}) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const before = await this._readUiUnlocked(id);
      const target = selector ? this._select(before.nodes, selector) : before.nodes.find((node) => node.scrollable && node.enabled);
      if (!target) throw new Error("No accessible scrollable Android container was found.");
      const horizontal = /^(left|right)$/i.test(direction);
      const forward = /^(down|right)$/i.test(direction);
      const start = horizontal
        ? { x: target.bounds.x + target.bounds.width * (forward ? 0.8 : 0.2), y: target.center.y }
        : { x: target.center.x, y: target.bounds.y + target.bounds.height * (forward ? 0.8 : 0.2) };
      const end = horizontal
        ? { x: target.bounds.x + target.bounds.width * (forward ? 0.2 : 0.8), y: target.center.y }
        : { x: target.center.x, y: target.bounds.y + target.bounds.height * (forward ? 0.2 : 0.8) };
      await this._device(id, ["shell", "input", "swipe", Math.round(start.x), Math.round(start.y), Math.round(end.x), Math.round(end.y), 260]);
      const observation = await this._waitForUiChange(id, before.signature, 2_000);
      return { performed: true, serial: id, direction, changed: observation.changed, ui: observation.ui };
    });
  }

  async launchApp(serial, packageName) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      const packageId = String(packageName ?? "").trim();
      if (!PACKAGE_ID.test(packageId)) throw new Error("A valid Android package name is required.");
      const resolved = await this._device(id, ["shell", "cmd", "package", "resolve-activity", "--brief", packageId]);
      const component = resolved.stdout.trim().split(/\r?\n/).find((line) => line.includes("/"));
      if (!component || !/^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/.test(component)) {
        throw new Error(`No safe launchable activity was found for ${packageId}.`);
      }
      const result = await this._device(id, ["shell", "am", "start", "-n", quoteAndroidShellArgument(component)]);
      return { performed: !/Error:/i.test(result.stdout), serial: id, packageName: packageId, component, message: result.stdout.trim() };
    });
  }

  async openUri(serial, uri) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      let parsed;
      try { parsed = new URL(String(uri)); } catch { throw new Error("A valid URI is required."); }
      if (!/^(https?|spotify|geo|mailto|tel):$/i.test(parsed.protocol)) throw new Error(`URI scheme ${parsed.protocol} is not allowed.`);
      const result = await this._device(id, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", quoteAndroidShellArgument(parsed.toString())]);
      return { performed: !/Error:/i.test(result.stdout), serial: id, uri: parsed.toString(), message: result.stdout.trim() };
    });
  }

  async installApk(serial, apkPath, { replace = false } = {}) {
    const id = assertDeviceId(serial);
    const resolved = path.resolve(String(apkPath ?? ""));
    if (path.extname(resolved).toLowerCase() !== ".apk") throw new Error("Only an exact local .apk file can be installed.");
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("The APK path is not a file.");
    return this._forDevice(id, async () => {
      const result = await this._device(id, ["install", ...(replace ? ["-r"] : []), resolved], { timeoutMs: 180_000 });
      const installed = /\bSuccess\b/i.test(result.stdout);
      if (!installed) throw new Error(result.stdout.trim() || "Android did not confirm APK installation.");
      return { performed: true, installed: true, serial: id, apkPath: resolved, replacedExisting: replace };
    });
  }

  async dismissKeyguard(serial) {
    return this._forDevice(serial, async () => {
      const id = assertDeviceId(serial);
      await this._device(id, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
      const before = await this.inspectDeviceUnlocked(id);
      if (!before.lock.locked) {
        return { performed: true, serial: id, unlocked: true, lock: before.lock, reason: null };
      }
      if (before.lock.secure !== false) {
        return { performed: false, serial: id, unlocked: false, reason: "The device has a secure lock or does not publish enough lock security state. SYSCORA will not bypass PIN, password, pattern, biometric, or device policy." };
      }
      await this._device(id, ["shell", "wm", "dismiss-keyguard"]);
      const after = await this.inspectDeviceUnlocked(id);
      return { performed: !after.lock.locked, serial: id, unlocked: !after.lock.locked, lock: after.lock, reason: after.lock.locked ? "Android did not dismiss the non-secure keyguard." : null };
    });
  }

  async inspectDeviceUnlocked(serial) {
    const [windowResult, lockResult] = await Promise.all([
      this._device(serial, ["shell", "dumpsys", "window", "windows"]),
      this._device(serial, ["shell", "dumpsys", "window", "policy"])
    ]);
    const foreground = /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9._]+)\/([^}\s]+)/.exec(windowResult.stdout);
    return { serial, foregroundApp: foreground ? { packageName: foreground[1], activity: foreground[2] } : null, lock: parseLockState(lockResult.stdout) };
  }

  async runOnDevices(serials, operation, input = {}) {
    const ids = [...new Set((serials ?? []).map(assertDeviceId))];
    if (ids.length === 0 || ids.length > 32) throw new Error("Choose between 1 and 32 Android devices.");
    const supported = new Set(["inspect", "read_ui", "tap", "type", "scroll", "launch", "open_uri", "key", "install", "dismiss_keyguard"]);
    if (!supported.has(operation)) throw new Error(`Unsupported multi-device operation: ${operation}.`);
    const settled = await Promise.all(ids.map(async (serial) => {
      try {
        const value = operation === "inspect" ? await this.inspectDevice(serial)
          : operation === "read_ui" ? await this.readUi(serial, input)
            : operation === "tap" ? await this.tap(serial, input.selector, input)
              : operation === "type" ? await this.typeText(serial, input.selector, input.text, input)
                : operation === "scroll" ? await this.scroll(serial, input)
                  : operation === "launch" ? await this.launchApp(serial, input.packageName)
                    : operation === "open_uri" ? await this.openUri(serial, input.uri)
                      : operation === "key" ? await this.pressKey(serial, input.key)
                        : operation === "install" ? await this.installApk(serial, input.apkPath, input)
                          : await this.dismissKeyguard(serial);
        return { serial, ok: true, value };
      } catch (error) {
        return { serial, ok: false, error: error.message };
      }
    }));
    return { operation, devices: settled, succeeded: settled.filter((item) => item.ok).length, failed: settled.filter((item) => !item.ok).length };
  }
}

export const AndroidKeyCodes = KEY_CODES;
