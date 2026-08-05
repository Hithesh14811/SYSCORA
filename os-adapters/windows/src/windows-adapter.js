import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getWindowsAutomationHost } from "../../windows-host/src/client.js";
import { CdpBrowserAdapter } from "../../browser/src/cdp-browser-adapter.js";

function parseEnvContents(rawContents) {
  const pairs = new Map();
  for (const line of rawContents.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    pairs.set(key, value);
  }
  return pairs;
}

function serializeEnvContents(pairs) {
  return [...pairs.entries()].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function expandWindowsEnvironmentPath(value) {
  const environment = new Map(
    Object.entries(process.env).map(([key, item]) => [key.toUpperCase(), item])
  );
  environment.set("USERPROFILE", process.env.USERPROFILE || os.homedir());
  environment.set("TEMP", process.env.TEMP || os.tmpdir());
  environment.set("TMP", process.env.TMP || os.tmpdir());
  return String(value ?? "").replace(/%([^%]+)%/g, (match, key) => {
    const replacement = environment.get(String(key).toUpperCase());
    return replacement == null ? match : replacement;
  });
}

// Coerce a caller-supplied duration into a bounded integer. UI-automation waits
// are interpolated (unquoted) into PowerShell, so they MUST be integer literals
// derived from a clamped number, never free-form caller text.
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function spotifyQueryTokens(value) {
  const ignored = new Set(["the", "a", "an", "by", "for", "on", "in", "of", "and", "to", "feat", "ft"]);
  return [...new Set(String(value ?? "").toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((token) => !ignored.has(token)) ?? [])].slice(0, 8);
}

function spotifyTokenDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const prior = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = prior;
    }
  }
  return row[b.length];
}

export function spotifyNameMatchesQuery(name, query) {
  const expected = spotifyQueryTokens(query);
  const candidates = spotifyQueryTokens(name);
  return expected.length > 0 && expected.every((token) => candidates.some((candidate) =>
    candidate === token || spotifyTokenDistance(candidate, token) <= 1
  ));
}

function uiBounds(target) {
  return target?.boundingRect ?? target?.bounds ?? {};
}

function identityTokens(value) {
  return new Set(
    String(value ?? "").toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1) ?? []
  );
}

function tokenSimilarity(left, right) {
  const a = identityTokens(left);
  const b = identityTokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

export function correlateLaunchWindow({
  application,
  beforeWindows = [],
  afterWindows = [],
  launch = null
} = {}) {
  const beforeIds = new Set(beforeWindows.map((window) => String(window.WindowHandle ?? window.windowId)));
  const beforeForeground = beforeWindows.find((window) => window.Foreground ?? window.foreground);
  const launchedPid = Number(launch?.processId);
  const compactApplication = String(application ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = afterWindows.map((window) => {
    const windowId = String(window.WindowHandle ?? window.windowId);
    const processId = Number(window.Id ?? window.processId);
    const processName = String(window.ProcessName ?? window.processName ?? "");
    const title = String(window.MainWindowTitle ?? window.title ?? "");
    const foreground = Boolean(window.Foreground ?? window.foreground);
    const signals = [];
    let score = 0;
    if (Number.isFinite(launchedPid) && processId === launchedPid) { score += 70; signals.push("launched-pid"); }
    if (!beforeIds.has(windowId)) { score += 45; signals.push("new-hwnd"); }
    const compactProcess = processName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compactApplication && compactProcess &&
        (compactApplication.includes(compactProcess) || compactProcess.includes(compactApplication))) {
      score += 35; signals.push("process-identity");
    }
    const titleSimilarity = tokenSimilarity(application, title);
    if (titleSimilarity >= 0.5) { score += 30; signals.push("title-similarity"); }
    if (foreground && String(beforeForeground?.WindowHandle ?? beforeForeground?.windowId) !== windowId) {
      score += 15; signals.push("foreground-transition");
    }
    return { window, score, signals, titleSimilarity };
  }).sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 45) {
    return { grounded: false, window: null, confidence: 0, candidates: candidates.slice(0, 5) };
  }
  return {
    grounded: true,
    window: best.window,
    confidence: Math.min(0.99, 0.45 + best.score / 150),
    signals: best.signals,
    candidates: candidates.slice(0, 5)
  };
}

export class WindowsAdapter {
  constructor({ automationHost = null, browserAutomation = null } = {}) {
    // `false` is an explicit opt-out used by deterministic tests and degraded
    // environments; null/undefined keeps the normal Windows-host default.
    this.automationHost = automationHost === false
      ? null
      : (automationHost ?? (process.platform === "win32" ? getWindowsAutomationHost() : null));
    this.browserAutomation = browserAutomation ?? new CdpBrowserAdapter();
  }

  close() {
    this.browserAutomation?.close?.();
    this.automationHost?.close?.();
  }

  async hostRequest(operation, params = {}, options = {}) {
    if (!this.automationHost) throw new Error("Windows automation host is unavailable");
    return this.automationHost.request(operation, params, options);
  }

  async executeCommand(workingDirectory, command, args = [], options = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });
      const timeoutMs = options.timeoutMs ?? 15000;
      const signal = options.signal ?? null;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      // Cooperative cancellation: an aborted signal kills the child promptly and
      // the result carries `cancelled: true` so callers can distinguish it from a
      // timeout or a normal non-zero exit.
      const onAbort = () => {
        cancelled = true;
        child.kill();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener?.("abort", onAbort);
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        cleanup();
        resolve({
          command,
          args,
          exitCode: code ?? -1,
          timedOut,
          cancelled,
          stdout,
          stderr
        });
      });
      child.on("error", (error) => {
        cleanup();
        resolve({
          command,
          args,
          exitCode: -1,
          timedOut,
          cancelled,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim()
        });
      });
    });
  }

  async runPowerShell(script, options = {}) {
    return this.executeCommand(
      process.cwd(),
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      options
    );
  }

  // Inspect a service and report whether it exists (used by the privileged
  // helper to validate a target before attempting a bounded restart).
  async serviceExists(serviceName) {
    const escaped = escapePowerShellSingleQuoted(serviceName);
    const ps = await this.runPowerShell(
      `if (Get-Service -Name '${escaped}' -ErrorAction SilentlyContinue) { 'true' } else { 'false' }`,
      { timeoutMs: 6000 }
    );
    return { exists: (ps.stdout ?? "").trim() === "true", commandResult: ps };
  }

  async getSystemInformation() {
    const ps = await this.runPowerShell(
      "$os = Get-CimInstance Win32_OperatingSystem; " +
      "$cs = Get-CimInstance Win32_ComputerSystem; " +
      "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors; " +
      "[pscustomobject]@{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;hostname=$env:COMPUTERNAME;username=$env:USERNAME;architecture=$env:PROCESSOR_ARCHITECTURE;totalMemory=$cs.TotalPhysicalMemory;cpuName=$cpu.Name;cpuCores=$cpu.NumberOfCores;cpuLogical=$cpu.NumberOfLogicalProcessors} | ConvertTo-Json -Compress"
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "{}");
    } catch {
      parsed = null;
    }
    return {
      platform: process.platform,
      release: os.release(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      architecture: os.arch(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
      windowsDetails: parsed,
      rawCommand: ps
    };
  }

  async listProcesses() {
    const ps = await this.runPowerShell(
      "Get-Process | Sort-Object -Descending WorkingSet64 | Select-Object -First 25 Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Compress"
    );
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async listServices() {
    const ps = await this.runPowerShell(
      "Get-Service | Select-Object -First 50 Name,DisplayName,Status,StartType | ConvertTo-Json -Compress"
    );
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async inspectUserEnvironmentVariable(key) {
    const escaped = escapePowerShellSingleQuoted(key);
    const ps = await this.runPowerShell(
      `[Environment]::GetEnvironmentVariable('${escaped}','User') | ConvertTo-Json -Compress`
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "null");
    } catch {
      parsed = ps.stdout.trim() || null;
    }
    return {
      key,
      scope: "User",
      value: parsed
    };
  }

  async getUserPath() {
    const ps = await this.runPowerShell(
      "[Environment]::GetEnvironmentVariable('Path','User') | ConvertTo-Json -Compress"
    );
    let value = null;
    try {
      value = JSON.parse(ps.stdout || "null");
    } catch {
      value = ps.stdout.trim() || null;
    }
    return {
      scope: "User",
      value,
      commandResult: ps
    };
  }

  normalizePathEntry(entry) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed) return null;
    return trimmed.replace(/[\\/]+$/g, "");
  }

  splitPath(pathValue) {
    if (!pathValue) return [];
    return String(pathValue)
      .split(";")
      .map((item) => this.normalizePathEntry(item))
      .filter(Boolean);
  }

  joinPath(entries) {
    return entries.map((item) => this.normalizePathEntry(item)).filter(Boolean).join(";");
  }

  async setUserPath(nextPathValue) {
    const previous = await this.getUserPath();
    const escapedValue = escapePowerShellSingleQuoted(nextPathValue);
    const ps = await this.runPowerShell(
      `[Environment]::SetEnvironmentVariable('Path','${escapedValue}','User'); ` +
      `[Environment]::GetEnvironmentVariable('Path','User') | ConvertTo-Json -Compress`
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "null");
    } catch {
      parsed = ps.stdout.trim() || null;
    }
    await this.broadcastEnvironmentChange();
    return {
      scope: "User",
      previousValue: previous.value,
      nextValue: parsed,
      commandResult: ps
    };
  }

  async broadcastEnvironmentChange() {
    // Broadcast WM_SETTINGCHANGE to notify Explorer and other apps
    await this.runPowerShell(
      "Add-Type @'\n" +
      "using System;\n" +
      "using System.Runtime.InteropServices;\n" +
      "public static class Native {\n" +
      "  [DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)]\n" +
      "  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);\n" +
      "}\n" +
      "'@; " +
      "$HWND_BROADCAST = [IntPtr]0xffff; $WM_SETTINGCHANGE = 0x1A; $SMTO_ABORTIFHUNG = 0x2; " +
      "[IntPtr]$r = [IntPtr]::Zero; " +
      "[void][Native]::SendMessageTimeout($HWND_BROADCAST,$WM_SETTINGCHANGE,[IntPtr]::Zero,'Environment',$SMTO_ABORTIFHUNG,2000,[ref]$r);"
    );
  }

  async verifyUserPathEntry(entry) {
    const normalized = this.normalizePathEntry(entry);
    const current = await this.getUserPath();
    const entries = this.splitPath(current.value);
    const present = entries.some((e) => e.toLowerCase() === normalized.toLowerCase());
    return {
      entry: normalized,
      present,
      currentValue: current.value,
      entries
    };
  }

  async rollbackUserPath(previousValue) {
    return this.setUserPath(previousValue);
  }

  async verifyUserPathInNewProcess(expectedContains) {
    const escaped = escapePowerShellSingleQuoted(expectedContains);
    const ps = await this.runPowerShell(
      `$p = [Environment]::GetEnvironmentVariable('Path','User'); ` +
      `$contains = $p -like '*${escaped}*'; ` +
      `[pscustomobject]@{contains=$contains; path=$p} | ConvertTo-Json -Compress`
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "{}");
    } catch {
      parsed = null;
    }
    return {
      contains: Boolean(parsed?.contains),
      path: parsed?.path ?? null
    };
  }

  async addUserPathEntry(entry) {
    const current = await this.getUserPath();
    const entries = this.splitPath(current.value);
    const normalized = this.normalizePathEntry(entry);
    const deduped = [...new Set(entries.map((e) => e.toLowerCase()))];
    const exists = deduped.includes(normalized.toLowerCase());
    const nextEntries = exists ? entries : [...entries, normalized];
    const nextValue = this.joinPath(nextEntries);
    const setResult = await this.setUserPath(nextValue);
    return {
      previousValue: current.value,
      nextValue: setResult.nextValue,
      added: !exists,
      entry: normalized
    };
  }

  async dedupeUserPath() {
    const current = await this.getUserPath();
    const entries = this.splitPath(current.value);
    const seen = new Set();
    const nextEntries = [];
    for (const entry of entries) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      nextEntries.push(entry);
    }
    const nextValue = this.joinPath(nextEntries);
    const setResult = await this.setUserPath(nextValue);
    return {
      previousValue: current.value,
      nextValue: setResult.nextValue,
      removedCount: entries.length - nextEntries.length
    };
  }

  async inspectPort(portNumber) {
    const port = Number(portNumber);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be an integer from 1 through 65535");
    }
    const ps = await this.runPowerShell(
      `$connections=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
      "Select-Object -First 10 LocalAddress,LocalPort,OwningProcess);" +
      "if($connections.Count -eq 0){'[]'}else{$connections|ConvertTo-Json -Compress}"
    );
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    const connections = Array.isArray(parsed) ? parsed : [parsed];
    return {
      port,
      listening: connections.length > 0,
      status: connections.length > 0 ? "LISTENING" : "NOT_LISTENING",
      connections,
      commandResult: ps
    };
  }

  async wingetSearch(query) {
    const q = String(query ?? "").trim();
    return this.executeCommand(process.cwd(), "winget", ["search", "--name", q, "--source", "winget"], { timeoutMs: 20000 });
  }

  async wingetShow(id) {
    return this.executeCommand(process.cwd(), "winget", ["show", "--id", id, "--source", "winget"], { timeoutMs: 20000 });
  }

  async wingetInstall(id) {
    return this.executeCommand(process.cwd(), "winget", ["install", "--id", id, "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"], { timeoutMs: 300000 });
  }

  async wingetList(id) {
    // Installation is explicitly sourced from the community WinGet repository.
    // Verify against that same source so `winget list` never probes `msstore`
    // and blocks on its interactive agreement prompt, which previously turned a
    // successful install into a false verification failure.
    return this.executeCommand(
      process.cwd(),
      "winget",
      ["list", "--id", id, "--source", "winget", "--accept-source-agreements"],
      { timeoutMs: 20000 }
    );
  }

  async setUserEnvironmentVariable(key, value) {
    const previous = await this.inspectUserEnvironmentVariable(key);
    const escapedKey = escapePowerShellSingleQuoted(key);
    const escapedValue = escapePowerShellSingleQuoted(value);
    const ps = await this.runPowerShell(
      `[Environment]::SetEnvironmentVariable('${escapedKey}','${escapedValue}','User'); ` +
      `[Environment]::GetEnvironmentVariable('${escapedKey}','User') | ConvertTo-Json -Compress`
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "null");
    } catch {
      parsed = ps.stdout.trim() || null;
    }
    return {
      key,
      scope: "User",
      previousValue: previous.value,
      nextValue: parsed,
      commandResult: ps
    };
  }

  async verifyUserEnvironmentVariable(key, expectedValue) {
    const inspection = await this.inspectUserEnvironmentVariable(key);
    return {
      key,
      scope: "User",
      observedValue: inspection.value,
      matches: inspection.value === expectedValue
    };
  }

  async restoreUserEnvironmentVariable(key, previousValue) {
    const escapedKey = escapePowerShellSingleQuoted(key);
    if (previousValue === null || previousValue === undefined) {
      await this.runPowerShell(
        `[Environment]::SetEnvironmentVariable('${escapedKey}',$null,'User')`
      );
      return;
    }
    const escapedValue = escapePowerShellSingleQuoted(previousValue);
    await this.runPowerShell(
      `[Environment]::SetEnvironmentVariable('${escapedKey}','${escapedValue}','User')`
    );
  }

  async inspectProjectEnvironment(workspacePath) {
    const filePath = path.join(workspacePath, ".env");
    try {
      const rawContents = await fs.readFile(filePath, "utf8");
      const values = Object.fromEntries(parseEnvContents(rawContents));
      return {
        filePath,
        exists: true,
        rawContents,
        values
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          filePath,
          exists: false,
          rawContents: "",
          values: {}
        };
      }
      throw error;
    }
  }

  async setProjectEnvironmentVariable(workspacePath, key, value) {
    const inspection = await this.inspectProjectEnvironment(workspacePath);
    const pairs = parseEnvContents(inspection.rawContents);
    pairs.set(key, value);
    await fs.writeFile(inspection.filePath, serializeEnvContents(pairs), "utf8");
    return {
      filePath: inspection.filePath,
      changedKey: key,
      previousValue: inspection.values[key] ?? null,
      nextValue: value
    };
  }

  async verifyProjectEnvironmentVariable(workspacePath, key, expectedValue) {
    const inspection = await this.inspectProjectEnvironment(workspacePath);
    const observedValue = inspection.values[key] ?? null;
    return {
      filePath: inspection.filePath,
      observedValue,
      matches: observedValue === expectedValue
    };
  }

  async restoreEnvFile(filePath, previousContents) {
    if (previousContents === "") {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    await fs.writeFile(filePath, previousContents, "utf8");
  }

  async inspectGitRepository(workspacePath) {
    try {
      await fs.access(path.join(workspacePath, ".git"));
    } catch {
      return { workspacePath, isRepository: false, status: "NOT_A_REPOSITORY", probeMethod: "filesystem" };
    }
    const probeResult = await this.executeCommand(workspacePath, "git", ["status", "--short", "--branch"], { timeoutMs: 6000 });
    return {
      workspacePath,
      isRepository: probeResult.exitCode === 0,
      status: probeResult.exitCode === 0 ? "REPOSITORY" : "PROBE_FAILED",
      branchStatus: probeResult.stdout,
      probeResult
    };
  }

  async inspectDockerEnvironment(workspacePath) {
    const probeResult = await this.executeCommand(workspacePath, "docker", ["--version"], { timeoutMs: 6000 });
    return {
      workspacePath,
      available: probeResult.exitCode === 0,
      status: probeResult.exitCode === 0 ? "AVAILABLE" : "NOT_AVAILABLE",
      version: probeResult.exitCode === 0 ? probeResult.stdout.trim() : null,
      probeResult
    };
  }

  async inspectService(serviceName) {
    return this.runPowerShell(`Get-Service -Name '${escapePowerShellSingleQuoted(serviceName)}' | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress`, { timeoutMs: 6000 });
  }

  async inspectPackageManager(managerName) {
    const manager = String(managerName ?? "winget");
    const probeResult = await this.executeCommand(process.cwd(), manager, ["--version"], { timeoutMs: 6000 });
    return {
      packageManager: manager,
      available: probeResult.exitCode === 0,
      status: probeResult.exitCode === 0 ? "AVAILABLE" : "NOT_AVAILABLE",
      version: probeResult.exitCode === 0 ? probeResult.stdout.trim() : null,
      probeResult
    };
  }

  getDocumentsPath() {
    return path.join(os.homedir(), "Documents");
  }

  getDesktopPath() {
    return path.join(os.homedir(), "Desktop");
  }

  getDownloadsPath() {
    return path.join(os.homedir(), "Downloads");
  }

  async searchFiles(rootDirectory, pattern, maxResults = 50) {
    const root = rootDirectory ?? this.getDownloadsPath();
    const escapedRoot = escapePowerShellSingleQuoted(root);
    const escapedPattern = escapePowerShellSingleQuoted(pattern);
    // maxResults is interpolated unquoted into the script, so it must be a
    // bounded integer literal — never caller text. Coerce and clamp.
    const limit = Math.min(1000, Math.max(1, Math.trunc(Number(maxResults)) || 50));
    const ps = await this.runPowerShell(
      `Get-ChildItem -Path '${escapedRoot}' -Recurse -Filter '${escapedPattern}' -ErrorAction SilentlyContinue | ` +
      `Select-Object -First ${limit} FullName,Length,LastWriteTime | ConvertTo-Json -Compress`,
      { timeoutMs: 30000 }
    );
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    return { root, pattern, files: Array.isArray(parsed) ? parsed : [parsed].filter(Boolean), commandResult: ps };
  }

  async createDirectory(directoryPath) {
    const target = path.resolve(expandWindowsEnvironmentPath(directoryPath));
    await fs.mkdir(target, { recursive: true });
    return { directoryPath: target, created: true };
  }

  async verifyDirectoryExists(directoryPath) {
    const target = path.resolve(expandWindowsEnvironmentPath(directoryPath));
    try {
      const stat = await fs.stat(target);
      return { exists: stat.isDirectory(), directoryPath: target };
    } catch {
      return { exists: false, directoryPath: target };
    }
  }

  async writeTextFile(filePath, contents) {
    const target = path.resolve(expandWindowsEnvironmentPath(filePath));
    let previousContents = null;
    let existed = false;
    try {
      previousContents = await fs.readFile(target, "utf8");
      existed = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
    return { filePath: target, existed, previousContents, nextContents: contents };
  }

  async readTextFile(filePath) {
    const target = path.resolve(expandWindowsEnvironmentPath(filePath));
    const contents = await fs.readFile(target, "utf8");
    return { filePath: target, contents };
  }

  async removeTextFile(filePath) {
    const target = path.resolve(expandWindowsEnvironmentPath(filePath));
    try {
      await fs.unlink(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { filePath: target, removed: true };
  }

  // Remove a directory. Used only as the rollback of filesystem.createDirectory
  // for a directory THIS runtime created, so a non-recursive removal is correct:
  // it refuses (ENOTEMPTY) if the user put files there, which is the safe choice.
  async removeDirectory(directoryPath, { recursive = false } = {}) {
    const target = path.resolve(expandWindowsEnvironmentPath(directoryPath));
    try {
      await fs.rmdir(target, { recursive });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { directoryPath: target, removed: true };
  }

  async verifyFileContains(filePath, expectedSubstring) {
    const file = await this.readTextFile(filePath);
    return {
      filePath: file.filePath,
      matches: file.contents.includes(expectedSubstring),
      length: file.contents.length
    };
  }

  async launchApplication(application) {
    const launchStartedAt = Date.now();
    const map = {
      notepad: "notepad.exe",
      calc: "calc.exe",
      calculator: "calc.exe",
      spotify: "spotify.exe"
    };
    const exe = map[application.toLowerCase()] ?? application;
    const beforeWindows = await this.listWindows();
    // Do not wait for a GUI application's process to exit. The previous direct
    // spawn treated a correctly-launched Spotify window as a timeout after 8s,
    // then the runtime re-planned the same action indefinitely. Prefer a Start
    // menu AppUserModelId (reliable for Store/WinGet apps), then fall back to
    // the executable name. Start-Process returns as soon as Windows accepts the
    // launch request.
    const escapedApplication = escapePowerShellSingleQuoted(application);
    const escapedExe = escapePowerShellSingleQuoted(exe);
    const result = await this.runPowerShell(
      `$ErrorActionPreference = 'Stop'; ` +
      `$app = Get-StartApps | Where-Object { $_.Name -ieq '${escapedApplication}' } | Select-Object -First 1; ` +
      `if ($app) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + $app.AppID); ` +
      `[pscustomobject]@{ started = $true; method = 'start-menu'; appId = $app.AppID } | ConvertTo-Json -Compress } ` +
      `else { ` +
      `$command = Get-Command -Name '${escapedExe}' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `$appPath = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + '${escapedExe}') -ErrorAction SilentlyContinue; ` +
      `$roots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ }; ` +
      `$shortcut = $roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue } | ` +
      `Where-Object { $_.BaseName -ieq '${escapedApplication}' } | Select-Object -First 1; ` +
      `if ($command) { $process = Start-Process -FilePath $command.Source -PassThru; $method = 'command'; $target = $command.Source } ` +
      `elseif ($appPath.'(default)') { $process = Start-Process -FilePath $appPath.'(default)' -PassThru; $method = 'app-path'; $target = $appPath.'(default)' } ` +
      `elseif ($shortcut) { $process = Start-Process -FilePath $shortcut.FullName -PassThru; $method = 'start-menu-shortcut'; $target = $shortcut.FullName } ` +
      `else { $process = Start-Process -FilePath '${escapedExe}' -PassThru; $method = 'literal'; $target = '${escapedExe}' } ` +
      `[pscustomobject]@{ started = $true; method = $method; processId = $process.Id; target = $target } | ConvertTo-Json -Compress }`,
      { timeoutMs: 8000 }
    );
    let launch = null;
    try { launch = JSON.parse(result.stdout || 'null'); } catch { launch = null; }
    const baseDeadline = Date.now() + 4000;
    const hardDeadline = Date.now() + 12000;
    let deadline = baseDeadline;
    let progressExtended = false;
    let windows = [];
    let correlation = { grounded: false, window: null, confidence: 0, candidates: [] };
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      windows = await this.listWindows();
      correlation = correlateLaunchWindow({ application, beforeWindows, afterWindows: windows, launch });
      if (correlation.grounded) break;
      const processProgress = Boolean(launch?.processId || launch?.appId);
      const windowProgress = (correlation.candidates ?? []).some((candidate) =>
        (candidate.signals ?? []).some((signal) => ["launched-pid", "new-hwnd", "title-similarity"].includes(signal))
      );
      if (!progressExtended && (processProgress || windowProgress)) {
        deadline = hardDeadline;
        progressExtended = true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, 100 + attempts * 50)));
    }
    const window = correlation.window ?? null;
    const windowIdentity = window ? {
      windowId: String(window.WindowHandle ?? window.windowId),
      processId: Number(window.Id ?? window.processId),
      processName: window.ProcessName ?? window.processName ?? null,
      title: window.MainWindowTitle ?? window.title ?? "",
      className: window.ClassName ?? window.className ?? null,
      bounds: window.Bounds ?? window.bounds ?? null,
      confidence: correlation.confidence,
      correlationSignals: correlation.signals ?? [],
      observedAt: new Date().toISOString()
    } : null;
    return {
      application,
      exe,
      launchResult: result,
      launch,
      window,
      windowIdentity,
      grounding: {
        grounded: Boolean(window),
        attempts,
        elapsedMs: Date.now() - launchStartedAt,
        progressExtended,
        readinessState: window
          ? "APPLICATION_READY"
          : launch?.processId || launch?.appId
            ? "PROCESS_WITHOUT_WINDOW"
            : correlation.candidates?.length
              ? "WINDOW_WITHOUT_UIA"
              : "NO_PROCESS",
        confidence: correlation.confidence,
        signals: correlation.signals ?? [],
        candidates: correlation.candidates?.map((candidate) => ({
          windowId: String(candidate.window?.WindowHandle ?? candidate.window?.windowId ?? ""),
          processId: candidate.window?.Id ?? candidate.window?.processId ?? null,
          processName: candidate.window?.ProcessName ?? candidate.window?.processName ?? null,
          title: candidate.window?.MainWindowTitle ?? candidate.window?.title ?? "",
          score: candidate.score,
          signals: candidate.signals
        })) ?? []
      },
      before: {
        windowIds: beforeWindows.map((candidate) => String(candidate.WindowHandle ?? candidate.windowId)),
        foregroundWindowId: String(beforeWindows.find((candidate) => candidate.Foreground ?? candidate.foreground)?.WindowHandle ?? "")
      },
      windows
    };
  }

  async launchProcess(executable, args = [], workingDirectory = process.cwd()) {
    const command = String(executable ?? "").trim();
    if (!command) throw new Error("Executable is required");
    const boundedArgs = Array.isArray(args) ? args.map(String).slice(0, 64) : [];
    return new Promise((resolve) => {
      const child = spawn(command, boundedArgs, {
        cwd: path.resolve(workingDirectory),
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: false
      });
      child.once("error", (error) => resolve({ started: false, executable: command, args: boundedArgs, error: error.message }));
      child.once("spawn", () => {
        const pid = child.pid;
        child.unref();
        resolve({ started: true, executable: command, args: boundedArgs, processId: pid });
      });
    });
  }

  async openSpotifySearch(query) {
    const text = String(query ?? "").trim();
    if (!text) throw new Error("A Spotify search query is required");
    // `spotify:` is the desktop client's registered protocol. This is an
    // asynchronous hand-off to the already-installed app, not browser/UI
    // automation, so it returns as soon as Windows accepts the request.
    const uri = `spotify:search:${encodeURIComponent(text)}`;
    const escapedUri = escapePowerShellSingleQuoted(uri);
    const launchResult = await this.runPowerShell(
      `$ErrorActionPreference = 'Stop'; Start-Process -FilePath '${escapedUri}'; ` +
      `[pscustomobject]@{ opened = $true; uri = '${escapedUri}' } | ConvertTo-Json -Compress`,
      { timeoutMs: 5000 }
    );
    let launch = null;
    try { launch = JSON.parse(launchResult.stdout || "null"); } catch { launch = null; }
    return { query: text, uri, launch, launchResult };
  }

  // Dispatch bounded Windows media-key events. Windows has no simple
  // permissionless master-volume read API, so callers are told that the command
  // was sent rather than being given an invented final percentage.
  async adjustSystemVolume(direction, steps = 2) {
    const down = String(direction).toLowerCase() === "down";
    const count = clampInt(steps, 1, 10, 2);
    const virtualKey = down ? 0xAE : 0xAF;
    const script = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SyscoraMediaKey { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr x); }'; " +
      `1..${count} | ForEach-Object { [SyscoraMediaKey]::keybd_event(${virtualKey},0,0,[UIntPtr]::Zero); [SyscoraMediaKey]::keybd_event(${virtualKey},0,2,[UIntPtr]::Zero) }; ` +
      `[pscustomobject]@{ dispatched = $true; direction = '${down ? "down" : "up"}'; steps = ${count} } | ConvertTo-Json -Compress`;
    const commandResult = await this.runPowerShell(script, { timeoutMs: 4000 });
    let dispatched = null;
    try { dispatched = JSON.parse(commandResult.stdout || "null"); } catch { dispatched = null; }
    return { direction: down ? "down" : "up", steps: count, dispatched: dispatched?.dispatched === true, commandResult };
  }

  // Interpret a Spotify main-window title into a playback state. Spotify sets the
  // window title to the currently playing track ("<Artist> - <Track>" / "<Track>
  // • <Artist>") ONLY while audio is actually playing; when idle or paused it
  // reverts to a static "Spotify" / "Spotify Free" / "Spotify Premium". That makes
  // the title a reliable, OAuth-free playback signal. Pure and deterministic, so
  // it is unit-testable without a live client.
  interpretSpotifyPlayback(title) {
    const raw = String(title ?? "").trim();
    const idle = new Set([
      "", "spotify", "spotify free", "spotify premium",
      "advertisement", "spotify - advertisement"
    ]);
    const playing = !idle.has(raw.toLowerCase());
    return { title: raw, playing, nowPlaying: playing ? raw : null };
  }

  // Fresh, independent read of the live Spotify playback state from the window
  // title. Used by the capability's verify() so playback is confirmed from the OS
  // itself, never merely trusted from the action's own return value.
  async readSpotifyPlayback() {
    // Do not use Get-Process.MainWindowHandle here.  Modern Spotify can host its
    // visible Chromium window in a process for which that property is zero.  The
    // top-level window enumeration below sees the actual interactive surface.
    const windows = await this.listWindows();
    const window = windows.find((item) => String(item.ProcessName ?? "").toLowerCase() === "spotify") ?? null;
    if (!window?.WindowHandle) {
      const process = await this.runPowerShell(
        "Get-Process -Name Spotify -ErrorAction SilentlyContinue | Select-Object -First 1 Id | ConvertTo-Json -Compress",
        { timeoutMs: 4000 }
      );
      let parsed = null;
      try { parsed = JSON.parse(process.stdout || "null"); } catch { parsed = null; }
      return { running: Boolean(parsed?.Id), window: null, ...this.interpretSpotifyPlayback(""), commandResult: process };
    }

    // Spotify's window title is commonly just "Spotify Free" even during
    // playback. Read the player controls and the accessible "Now playing: ..."
    // label instead. A Pause button inside the *Player controls* group is the
    // authoritative signal that audio is playing; a stale now-playing label on
    // its own only means a track is loaded/paused.
    const handle = Number(window.WindowHandle);
    const ui = await this.runPowerShell([
      "Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;",
      `$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${handle});`,
      "$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);",
      "$playing=$false;$nowPlaying=$null;",
      "foreach($el in $all){try{$name=$el.Current.Name;$type=$el.Current.ControlType.ProgrammaticName;if(-not $nowPlaying -and -not $el.Current.IsOffscreen -and $name -like 'Now playing:*'){$nowPlaying=$name};if($type -eq 'ControlType.Group' -and $name -eq 'Player controls'){$buttons=$el.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)));foreach($button in $buttons){if($button.Current.Name -eq 'Pause'){$playing=$true;break}}}}catch{}};",
      "[pscustomobject]@{playing=$playing;nowPlaying=$nowPlaying}|ConvertTo-Json -Compress"
    ].join(" "), { timeoutMs: 5000 });
    let state = null;
    try { state = JSON.parse(ui.stdout || "null"); } catch { state = null; }
    const accessibleLabel = String(state?.nowPlaying ?? "").replace(/^Now playing:\s*/i, "").trim();
    const fallback = this.interpretSpotifyPlayback(window.MainWindowTitle);
    const playing = state?.playing === true || (state == null && fallback.playing);
    const title = playing && accessibleLabel ? accessibleLabel : fallback.title;
    return { running: true, window, playing, title, nowPlaying: playing ? title : null, accessibilityLabel: accessibleLabel || null, commandResult: ui };
  }

  // Bounded wait for an application's main window to appear. NEVER waits
  // indefinitely: polls listWindows() until a match or the (clamped) deadline,
  // returning { ready, window }.
  async waitForApplicationWindow(match, timeoutMs = 8000) {
    const needle = String(match ?? "").toLowerCase();
    const deadline = Date.now() + clampInt(timeoutMs, 500, 20000, 8000);
    let window = null;
    while (Date.now() < deadline) {
      const windows = await this.listWindows();
      window = windows.find((w) =>
        String(w.ProcessName ?? "").toLowerCase().includes(needle) ||
        String(w.MainWindowTitle ?? "").toLowerCase().includes(needle)
      ) ?? null;
      if (window) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ready: Boolean(window), window, match: needle };
  }

  // Play a track in the installed Spotify desktop client via bounded, window-
  // scoped UI Automation. This is the honest counterpart to openSpotifySearch:
  //   1. launch/focus Spotify           2. bounded wait for its window
  //   3. populate results via spotify:   4. invoke the first "Play" result (UIA)
  //   5. re-read the live window title so the caller/verify sees real state.
  // Every wait is bounded; there is no indefinite loop and no blind coordinate
  // clicking. It returns a structured result but does NOT itself claim success —
  // the capability verifies playback independently from the live title.
  async playSpotifyTrack(query, options = {}) {
    const text = String(query ?? "").trim();
    if (!text) throw new Error("A Spotify track query is required");
    const readyTimeoutMs = clampInt(options.readyTimeoutMs, 500, 20000, 8000);
    const searchSettleMs = clampInt(options.searchSettleMs, 200, 6000, 1500);
    const playDeadlineMs = clampInt(options.playDeadlineMs, 500, 15000, 6000);
    const steps = [];

    // 1. Launch or focus Spotify (reuses the Start-menu/executable launch path).
    const launch = await this.launchApplication("spotify");
    steps.push({ step: "launch", ok: Boolean(launch?.launch?.started || launch?.window) });

    // 2. Bounded wait for the Spotify window to be ready.
    const ready = await this.waitForApplicationWindow("spotify", readyTimeoutMs);
    steps.push({ step: "window-ready", ok: ready.ready });
    if (!ready.ready) {
      const playback = await this.readSpotifyPlayback();
      if (!playback.running) {
        return {
          query: text, available: false,
          reason: "Spotify does not appear to be installed or could not be launched.",
          steps, playback
        };
      }
      return {
        query: text, available: true, launched: true, windowReady: false, timedOut: true,
        reason: "Spotify window did not become ready within the allotted time.",
        steps, playback
      };
    }

    // 3. Populate the search results through the desktop client's search protocol
    //    (reliable) rather than blindly typing into a located search box.
    const search = await this.openSpotifySearch(text);
    steps.push({ step: "search", ok: Boolean(search?.launch?.opened) });
    await new Promise((r) => setTimeout(r, searchSettleMs));

    // 4. Bounded UI Automation: locate a result whose accessible text matches
    //    the requested track, then invoke that result's Play button. There is no
    //    "first Play button" fallback: playing an unrelated paused item is worse
    //    than reporting that the matching row could not be identified.
    const uia = await this._invokeSpotifyPlayButton(text, playDeadlineMs, ready.window?.WindowHandle);
    steps.push({ step: "activate-play", ok: uia.invoked, detail: uia.reason ?? null });

    // 5. Let playback start, then read the live title for an honest result.
    await new Promise((r) => setTimeout(r, 1200));
    const playback = await this.readSpotifyPlayback();

    return {
      query: text,
      available: true,
      launched: true,
      windowReady: true,
      searchOpened: Boolean(search?.launch?.opened),
      resultFound: uia.found,
      invoked: uia.invoked,
      playedButton: uia.name ?? null,
      title: playback.title,
      playback,
      steps
    };
  }

  // Window-scoped UI Automation helper: within a bounded deadline, locate the
  // requested result's Play button in the Spotify window and invoke it via
  // the InvokePattern. Uses native Windows UI Automation (UIAutomationClient), not
  // coordinate clicking. Matches only "Play " (never "Pause ") so it starts, and
  // never toggles, playback. Returns { found, invoked, name, reason }.
  async _invokeSpotifyPlayButton(query, deadlineMs, windowHandle = null) {
    const limit = clampInt(deadlineMs, 500, 15000, 6000);
    const tokens = spotifyQueryTokens(query);
    if (tokens.length === 0) return { found: false, invoked: false, name: null, reason: "invalid-track-query", commandResult: null };
    // Modern Chromium accessibility trees often expose a result as one button
    // named "Play <title> by <artist>" instead of a title label containing a
    // nested generic Play button. Try the general compound-name selector first.
    if (this.automationHost) {
      try {
        const semantic = await this.findAndInvokeSemanticControl({
          application: "spotify",
          windowId: windowHandle,
          actionPrefix: "Play ",
          objectName: String(query).trim(),
          controlType: "Button"
        });
        if (semantic.invoked) {
          return {
            found: true,
            invoked: true,
            name: semantic.target?.name ?? null,
            matchedLabel: semantic.target?.name ?? null,
            matchedBounds: semantic.target?.boundingRect ?? null,
            reason: null,
            semantic
          };
        }
      } catch {
        // The bounded legacy UIA path below also tolerates minor spelling
        // corrections and keeps compatibility when the host is unavailable.
      }
    }
    const encodedTokens = Buffer.from(JSON.stringify(tokens), "utf8").toString("base64");
    const queryText = String(query).trim();
    const displayQuery = queryText.toLowerCase().replace(/\b[a-z0-9]/g, (character) => character.toUpperCase());
    const encodedQuery = Buffer.from(queryText, "utf8").toString("base64");
    const encodedDisplayQuery = Buffer.from(displayQuery, "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;",
      "Add-Type -AssemblyName UIAutomationTypes;",
      "$sw=[System.Diagnostics.Stopwatch]::StartNew();",
      "$windowHandle=" + Number(windowHandle || 0) + ";",
      "if($windowHandle -eq 0){ [pscustomobject]@{found=$false;invoked=$false;reason='no-window'} | ConvertTo-Json -Compress; return };",
      "$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windowHandle);",
      "$buttonCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button);",
      `$tokens=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTokens}')) | ConvertFrom-Json);`,
      `$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'));`,
      `$displayQuery=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDisplayQuery}'));`,
      "$lowerQuery=$query.ToLower();$queryVariants=@($displayQuery);foreach($digraph in @('t','d','k','g','p','b','c','s')){for($i=0;$i-lt$lowerQuery.Length;$i++){if($lowerQuery[$i]-eq$digraph){$queryVariants+=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($lowerQuery.Insert($i+1,'h'))}}};",
      // Spotify frequently corrects spelling in search results. Accept a single
      // insertion/deletion/substitution per meaningful token, matching the same
      // tolerance used by independent playback verification.
      "$near={param($a,$b);$a=[string]$a;$b=[string]$b;if($a -eq $b){return $true};if([Math]::Abs($a.Length-$b.Length)-gt 1){return $false};if($a.Length -eq $b.Length){$d=0;for($i=0;$i-lt$a.Length;$i++){if($a[$i]-ne$b[$i]){$d++}};return $d-le 1};$long=if($a.Length-gt$b.Length){$a}else{$b};$short=if($a.Length-gt$b.Length){$b}else{$a};for($i=0;$i-lt$long.Length;$i++){if(($long.Remove($i,1))-eq$short){return $true}};return $false};",
      "$matches={ param($name) if(-not $name){ return $false }; $words=@(([string]$name).ToLower() -split '[^a-z0-9]+' | Where-Object { $_ }); foreach($token in @($tokens)){ $hit=$false;foreach($word in $words){if(& $near ([string]$word) ([string]$token)){$hit=$true;break}};if(-not $hit){return $false} }; return $true };",
      "$play=$null;",
      "$matchedLabel=$null;",
      "$matchedBounds=$null;",
      "while($sw.ElapsedMilliseconds -lt " + limit + " -and -not $play){",
      "  $best=$null;$bestScore=-100000;",
      // Ask UIA for exact-name elements first. Spotify exposes the requested top
      // result under that exact Name, so this avoids a full 800+ element walk.
      // Spotify's Chromium UIA provider incorrectly returns zero results when
      // PropertyConditionFlags.IgnoreCase is used. Try exact user casing, then
      // the title-cased display form that Spotify normally exposes.
      "  try{$nameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$query);$labels=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$nameCond);if($labels.Count -eq 0 -and $displayQuery -ne $query){$displayCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$displayQuery);$labels=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$displayCond)}}catch{$labels=@()};",
      // Resolve Spotify's spelling correction with one provider-side UIA query
      // over bounded single-edit title variants. Then search only the matching
      // title's few ancestors for the generic Play button. This is substantially
      // faster than walking every descendant in Spotify's Chromium tree.
      "  if($labels.Count -eq 0){try{foreach($variant in @($queryVariants)){if($sw.ElapsedMilliseconds -ge (" + limit + "/2)){break};$variantCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$variant);$variantLabel=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$variantCondition);if($variantLabel){$labels=@($variantLabel);break}}}catch{$labels=@()}};",
      "  $playNameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Play');$genericPlayCond=New-Object System.Windows.Automation.AndCondition($buttonCond,$playNameCond);",
      "  foreach($labelEl in $labels){try{$label=$labelEl.Current.Name;$rr=$labelEl.Current.BoundingRectangle;if($labelEl.Current.IsOffscreen -or -not (& $matches $label) -or $rr.Width -le 0 -or $rr.Height -le 0 -or $rr.Height -gt 260){continue};$ancestor=$labelEl;for($depth=0;$depth-lt 5;$depth++){$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor);if(-not $ancestor){break};$candidate=$ancestor.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$genericPlayCond);if($candidate -and -not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled){$best=$candidate;$matchedLabel=$label;$matchedBounds=$rr;break}}}catch{};if($best){break}};",
      // Some Chromium apps expose the action and object as one accessibility
      // control (for example "Play Good For You by ..."). Search only Button
      // controls, not the entire raw tree, and bind the action to the requested
      // object tokens before invoking it. This is the same general semantic
      // action+object shape used by the persistent host selector above.
      "  if(-not $best -and $sw.ElapsedMilliseconds -lt " + limit + "){try{$actionButtons=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCond);foreach($candidate in $actionButtons){if($sw.ElapsedMilliseconds -ge " + limit + "){break};$candidateName=$candidate.Current.Name;$candidateBounds=$candidate.Current.BoundingRectangle;if(-not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled -and $candidateName.StartsWith('Play ',[StringComparison]::OrdinalIgnoreCase) -and (& $matches $candidateName) -and $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0){$best=$candidate;$matchedLabel=$candidateName;$matchedBounds=$candidateBounds;break}}}catch{}};",
      "  if($best){$play=$best;break};",
      "  if(-not $play){ Start-Sleep -Milliseconds 400 }",
      "};",
      "if(-not $play){ [pscustomobject]@{found=$false;invoked=$false;reason='matching-track-not-found'} | ConvertTo-Json -Compress; return };",
      "$name=$play.Current.Name; $invoked=$false;",
      "try{ $ip=$play.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); $invoked=$true }catch{ $invoked=$false };",
      "[pscustomobject]@{found=$true;invoked=$invoked;name=$name;matchedLabel=$matchedLabel;matchedBounds=$matchedBounds} | ConvertTo-Json -Compress"
    ].join(" ");
    const ps = await this.runPowerShell(script, { timeoutMs: limit + 4000 });
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    return {
      found: Boolean(parsed?.found),
      invoked: Boolean(parsed?.invoked),
      name: parsed?.name ?? null,
      matchedLabel: parsed?.matchedLabel ?? null,
      matchedBounds: parsed?.matchedBounds ?? null,
      reason: parsed?.reason ?? null,
      commandResult: ps
    };
  }

  // Add a requested track to Spotify's queue through accessible, named controls:
  // search -> matching "More options" -> "Add to queue". No coordinates or
  // ungrounded first-result fallback are used.
  async queueSpotifyTrack(query, options = {}) {
    const text = String(query ?? "").trim();
    if (!text) throw new Error("A Spotify queue query is required");
    const readyTimeoutMs = clampInt(options.readyTimeoutMs, 500, 20000, 8000);
    const searchSettleMs = clampInt(options.searchSettleMs, 200, 6000, 1500);
    const launch = await this.launchApplication("spotify");
    const ready = await this.waitForApplicationWindow("spotify", readyTimeoutMs);
    if (!ready.ready) return { query: text, available: false, queued: false, reason: "spotify-window-not-ready", launch, ready };

    const search = await this.openSpotifySearch(text);
    await new Promise((resolve) => setTimeout(resolve, searchSettleMs));
    const added = await this._invokeSpotifyQueueButton(text, options.queueDeadlineMs ?? 8000, ready.window?.WindowHandle);
    return {
      query: text,
      available: true,
      queued: Boolean(added?.invoked),
      reason: added?.invoked ? null : (added?.reason ?? "add-to-queue-failed"),
      matchedTrack: added?.matchedLabel ?? null,
      search,
      added
    };
  }

  async _invokeSpotifyQueueButton(query, deadlineMs, windowHandle = null) {
    const limit = clampInt(deadlineMs, 500, 15000, 8000);
    const tokens = spotifyQueryTokens(query);
    if (tokens.length === 0) return { found: false, invoked: false, reason: "invalid-track-query" };
    const encodedTokens = Buffer.from(JSON.stringify(tokens), "utf8").toString("base64");
    const encodedQuery = Buffer.from(String(query).trim(), "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SyscoraSpotifyMouse{[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}';",
      "$windowHandle=" + Number(windowHandle || 0) + ";if($windowHandle -eq 0){[pscustomobject]@{found=$false;invoked=$false;reason='no-window'}|ConvertTo-Json -Compress;return};",
      "$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windowHandle);",
      `$tokens=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTokens}'))|ConvertFrom-Json);$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'));`,
      "$near={param($a,$b);$a=[string]$a;$b=[string]$b;if($a-eq$b){return $true};if([Math]::Abs($a.Length-$b.Length)-gt 1){return $false};if($a.Length-eq$b.Length){$d=0;for($i=0;$i-lt$a.Length;$i++){if($a[$i]-ne$b[$i]){$d++}};return $d-le 1};$long=if($a.Length-gt$b.Length){$a}else{$b};$short=if($a.Length-gt$b.Length){$b}else{$a};for($i=0;$i-lt$long.Length;$i++){if($long.Remove($i,1)-eq$short){return $true}};return $false};",
      "$matches={param($name);$words=@(([string]$name).ToLower()-split'[^a-z0-9]+'|Where-Object{$_});foreach($token in @($tokens)){$hit=$false;foreach($word in $words){if(&$near $word $token){$hit=$true;break}};if(-not$hit){return $false}};return $true};",
      "$activate={param($el);try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);$pattern.Invoke();return $true}catch{};try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern);$pattern.DoDefaultAction();return $true}catch{};try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);$pattern.Select();return $true}catch{};try{$b=$el.Current.BoundingRectangle;if($b.Width-gt 0-and$b.Height-gt 0){[void][SyscoraSpotifyMouse]::SetCursorPos([int]($b.X+$b.Width/2),[int]($b.Y+$b.Height/2));[SyscoraSpotifyMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[SyscoraSpotifyMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);return $true}}catch{};return $false};",
      "$display=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($query.ToLower());$variants=@($display);foreach($digraph in @('t','d','k','g','p','b','c','s')){for($i=0;$i-lt$query.Length;$i++){if($query[$i]-eq$digraph){$variants+=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($query.ToLower().Insert($i+1,'h'))}}};",
      "$label=$null;foreach($variant in $variants){$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$variant);$label=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond);if($label){break}};",
      "if(-not$label){[pscustomobject]@{found=$false;invoked=$false;reason='matching-track-not-found'}|ConvertTo-Json -Compress;return};",
      "$buttonCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button);$option=$null;$ancestor=$label;",
      "for($depth=0;$depth-lt 5;$depth++){$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor);if(-not$ancestor){break};$buttons=$ancestor.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCond);foreach($button in $buttons){if($button.Current.Name-like'More options for *'-and(&$matches $button.Current.Name)){$option=$button;break}};if($option){break}};",
      "if(-not$option){[pscustomobject]@{found=$false;invoked=$false;reason='matching-track-options-not-found'}|ConvertTo-Json -Compress;return};",
      "if(-not(&$activate $option)){[pscustomobject]@{found=$true;invoked=$false;reason='track-options-not-opened'}|ConvertTo-Json -Compress;return};Start-Sleep -Milliseconds 350;",
      "$queueName=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Add to queue');$queue=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$queueName);if(-not$queue){[pscustomobject]@{found=$true;invoked=$false;reason='add-to-queue-control-not-found'}|ConvertTo-Json -Compress;return};",
      "$invoked=&$activate $queue;[pscustomobject]@{found=$true;invoked=$invoked;matchedLabel=$label.Current.Name;optionName=$option.Current.Name}|ConvertTo-Json -Compress"
    ].join(" ");
    const ps = await this.runPowerShell(script, { timeoutMs: limit + 4000 });
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    return { ...parsed, found: Boolean(parsed?.found), invoked: Boolean(parsed?.invoked), commandResult: ps };
  }

  // Independent postcondition probe. Prefer Spotify's live-region confirmation;
  // otherwise open the Queue panel and require the requested track below a queue
  // heading in the same right-side region.
  async readSpotifyQueue(query) {
    const text = String(query ?? "").trim();
    if (!text) return { queued: false, reason: "invalid-track-query" };
    const playback = await this.readSpotifyPlayback();
    const handle = playback.window?.WindowHandle;
    if (!handle) return { queued: false, query: text, reason: "spotify-window-not-ready" };
    const encodedQuery = Buffer.from(text, "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]" + Number(handle) + ");",
      "$queueCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Queue');$queue=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$queueCond);if($queue){try{$qp=$queue.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern);if($qp.Current.ToggleState-eq[System.Windows.Automation.ToggleState]::Off){$qp.Toggle()}}catch{}};Start-Sleep -Milliseconds 300;",
      `$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'));$display=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($query.ToLower());`,
      "$nameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$display);$labels=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$nameCond);$rb=$root.Current.BoundingRectangle;$match=$null;foreach($label in $labels){$b=$label.Current.BoundingRectangle;if(-not$label.Current.IsOffscreen-and$b.X-ge($rb.X+($rb.Width*0.55))){$match=$label;break}};[pscustomobject]@{queued=[bool]$match;evidence=if($match){$match.Current.Name}else{$null}}|ConvertTo-Json -Compress"
    ].join(" ");
    const ps = await this.runPowerShell(script, { timeoutMs: 7000 });
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    return parsed?.queued
      ? { queued: true, query: text, evidence: parsed.evidence, source: "queue-panel", commandResult: ps }
      : { queued: false, query: text, reason: "track-not-observed-in-queue", commandResult: ps };
  }

  // General-purpose, read-only UI perception.  It deliberately returns the
  // accessibility tree rather than pixels: accessible names, automation IDs,
  // control types and bounding rectangles are stable targets for an agent and
  // avoid unsafe coordinate guessing.  The caller may scope to one application
  // (recommended) or inspect the foreground-visible windows.
  async inspectUi({ application = null, windowId = null, maxElements = 120 } = {}) {
    if (this.automationHost) {
      try {
        const inspected = await this.hostRequest("ui.inspect", { application, windowId, maxElements }, { timeoutMs: 12000 });
        return {
          application,
          windows: inspected.window ? [{
            Id: inspected.window.processId,
            ProcessName: inspected.window.processName,
            MainWindowTitle: inspected.window.title,
            WindowHandle: Number(inspected.window.windowId)
          }] : [],
          elements: inspected.targets ?? [],
          targets: inspected.targets ?? [],
          host: "persistent"
        };
      } catch {
        // Compatibility fallback below keeps the frozen MVP operational if the
        // companion host cannot start in the current Windows session.
      }
    }
    const limit = clampInt(maxElements, 1, 500, 120);
    const windows = await this.listWindows();
    const needle = application ? String(application).toLowerCase() : null;
    const selected = needle
      ? windows.filter((w) => String(w.ProcessName ?? "").toLowerCase().includes(needle) || String(w.MainWindowTitle ?? "").toLowerCase().includes(needle))
      : windows;
    const handles = selected.map((w) => Number(w.WindowHandle)).filter((n) => Number.isFinite(n) && n > 0);
    const windowMeta = selected.map((window) => ({
      handle: Number(window.WindowHandle),
      processName: window.ProcessName ?? "",
      title: window.MainWindowTitle ?? ""
    })).filter((window) => Number.isFinite(window.handle) && window.handle > 0);
    const encoded = Buffer.from(JSON.stringify({ windows: windowMeta, limit }), "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;",
      `$cfg=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json);`,
      "$out=@();$cond=[System.Windows.Automation.Condition]::TrueCondition;$interactive=@('ControlType.Button','ControlType.Edit','ControlType.ComboBox','ControlType.CheckBox','ControlType.RadioButton','ControlType.Hyperlink','ControlType.ListItem','ControlType.DataItem','ControlType.MenuItem','ControlType.TabItem');",
      "foreach($win in $cfg.windows){try{$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$win.handle);$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)}catch{continue};foreach($el in $all){try{$r=$el.Current.BoundingRectangle;$name=$el.Current.Name;$id=$el.Current.AutomationId;$type=$el.Current.ControlType.ProgrammaticName;$visible=-not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0;if($visible -and ($name -or $id)){$priority=if($interactive -contains $type){0}else{1};$out+=[pscustomobject]@{priority=$priority;windowHandle=[Int64]$win.handle;processName=$win.processName;windowTitle=$win.title;name=$name;automationId=$id;controlType=$type;enabled=$el.Current.IsEnabled;offscreen=$false;bounds=[pscustomobject]@{x=[int]$r.X;y=[int]$r.Y;width=[int]$r.Width;height=[int]$r.Height}}}}catch{}}};",
      "$out|Sort-Object priority,@{Expression={$_.bounds.y}},@{Expression={$_.bounds.x}}|Select-Object -First $cfg.limit -Property * -ExcludeProperty priority|ConvertTo-Json -Compress -Depth 4"
    ].join(" ");
    let result = await this.runPowerShell(script, { timeoutMs: 12000 });
    const parseElements = (commandResult) => {
      let parsed = [];
      try { parsed = JSON.parse(commandResult.stdout || "[]"); } catch { parsed = []; }
      return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
    };
    let elements = parseElements(result);
    // Chromium-backed apps sometimes expose only their two root panes while a
    // route is loading. Retry once after a short readiness interval instead of
    // returning a misleading "empty GUI" observation.
    if (windowMeta.length > 0 && elements.length <= 2) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      result = await this.runPowerShell(script, { timeoutMs: 12000 });
      elements = parseElements(result);
    }
    return { application, windows: selected, elements, commandResult: result };
  }

  // General UI action, always scoped to a visible application window and an
  // accessibility selector. No coordinate clicking, no broad desktop target and
  // no arbitrary PowerShell supplied by a model. `click` uses Invoke/Selection
  // patterns; `type` prefers ValuePattern then falls back to focused SendKeys.
  async interactUi({ application, target, action, text = "" } = {}) {
    const app = String(application ?? "").trim();
    const verb = String(action ?? "").toLowerCase();
    if (!app || !target || !["click", "type", "key"].includes(verb)) throw new Error("application, target and a supported UI action are required");
    if (this.automationHost) {
      try {
        const mappedAction = verb === "key" ? "type" : verb;
        return {
          application: app,
          action: verb,
          ...(await this.hostRequest("ui.action", {
            application: app,
            target,
            selector: target.selector ?? target,
            action: mappedAction,
            text,
            allowFirst: target.occurrence != null
          }, { timeoutMs: 12000 })),
          host: "persistent"
        };
      } catch {
        // Fall through to the original process-isolated implementation.
      }
    }
    const windows = await this.listWindows();
    const needle = app.toLowerCase();
    const window = windows.find((w) => String(w.ProcessName ?? "").toLowerCase().includes(needle) || String(w.MainWindowTitle ?? "").toLowerCase().includes(needle));
    if (!window?.WindowHandle) return { performed: false, reason: "application-window-not-found", application: app };
    const selector = {
      name: typeof target.name === "string" ? target.name.slice(0, 300) : null,
      nameContains: typeof target.nameContains === "string" ? target.nameContains.slice(0, 300) : null,
      automationId: typeof target.automationId === "string" ? target.automationId.slice(0, 300) : null,
      controlType: typeof target.controlType === "string" ? target.controlType.slice(0, 120) : null,
      withinName: typeof target.withinName === "string" ? target.withinName.slice(0, 300) : null,
      occurrence: Number.isInteger(target.occurrence) && target.occurrence >= 0 ? Math.min(target.occurrence, 100) : null,
      bounds: target.bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(target.bounds[key])))
        ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Number(target.bounds[key])]))
        : null
    };
    if (!selector.name && !selector.nameContains && !selector.automationId) throw new Error("target.name, target.nameContains, or target.automationId is required");
    const encoded = Buffer.from(JSON.stringify({ handle: Number(window.WindowHandle), selector, action: verb, text: String(text).slice(0, 4000) }), "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; Add-Type -AssemblyName System.Windows.Forms;",
      `$cfg=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json);$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$cfg.handle);$seed=[System.Windows.Automation.Condition]::TrueCondition;if($cfg.selector.automationId){$seed=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,[string]$cfg.selector.automationId)}elseif($cfg.selector.name){$seed=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$cfg.selector.name)};$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$seed);$hits=@();`,
      "foreach($el in $all){try{$ok=$true;$name=$el.Current.Name;$r=$el.Current.BoundingRectangle;if($cfg.selector.name -and $name -ne $cfg.selector.name){$ok=$false};if($cfg.selector.nameContains -and $name.IndexOf([string]$cfg.selector.nameContains,[StringComparison]::OrdinalIgnoreCase) -lt 0){$ok=$false};if($cfg.selector.automationId -and $el.Current.AutomationId -ne $cfg.selector.automationId){$ok=$false};if($cfg.selector.controlType -and $el.Current.ControlType.ProgrammaticName -ne $cfg.selector.controlType){$ok=$false};if($cfg.selector.bounds){$cx=$r.X+($r.Width/2);$cy=$r.Y+($r.Height/2);$b=$cfg.selector.bounds;if($cx -lt $b.x -or $cx -gt ($b.x+$b.width) -or $cy -lt $b.y -or $cy -gt ($b.y+$b.height)){$ok=$false}};if($ok -and $cfg.selector.withinName){$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el);$inside=$false;for($depth=0;$depth -lt 8 -and $ancestor;$depth++){if($ancestor.Current.Name.IndexOf([string]$cfg.selector.withinName,[StringComparison]::OrdinalIgnoreCase) -ge 0){$inside=$true;break};$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)};if(-not $inside){$ok=$false}};if($ok -and $el.Current.IsEnabled -and -not $el.Current.IsOffscreen){$hits+=,$el}}catch{}};",
      "$index=if($null -ne $cfg.selector.occurrence){[int]$cfg.selector.occurrence}else{0};if($hits.Count -eq 0 -or $index -ge $hits.Count){[pscustomobject]@{performed=$false;reason='target-not-found';matchCount=$hits.Count}|ConvertTo-Json -Compress;return};$disambiguated=[bool]($cfg.selector.automationId -or $cfg.selector.withinName -or $cfg.selector.bounds -or $null -ne $cfg.selector.occurrence);if($hits.Count -gt 1 -and -not $disambiguated){$choices=@($hits|Select-Object -First 5|ForEach-Object{$rr=$_.Current.BoundingRectangle;[pscustomobject]@{name=$_.Current.Name;automationId=$_.Current.AutomationId;controlType=$_.Current.ControlType.ProgrammaticName;bounds=[pscustomobject]@{x=[int]$rr.X;y=[int]$rr.Y;width=[int]$rr.Width;height=[int]$rr.Height}}});[pscustomobject]@{performed=$false;reason='ambiguous-target';matchCount=$hits.Count;choices=$choices}|ConvertTo-Json -Compress -Depth 4;return};$hit=$hits[$index];",
      " $performed=$false;$method=$null;try{if($cfg.action -eq 'click'){try{$hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();$performed=$true;$method='invoke'}catch{$hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select();$performed=$true;$method='select'}}elseif($cfg.action -eq 'type'){$hit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$cfg.text);$performed=$true;$method='value'}else{$hit.SetFocus();[System.Windows.Forms.SendKeys]::SendWait([string]$cfg.text);$performed=$true;$method='sendkeys'}}catch{$reason=$_.Exception.Message};$hr=$hit.Current.BoundingRectangle;[pscustomobject]@{performed=$performed;method=$method;reason=$reason;matchCount=$hits.Count;target=[pscustomobject]@{name=$hit.Current.Name;automationId=$hit.Current.AutomationId;controlType=$hit.Current.ControlType.ProgrammaticName;bounds=[pscustomobject]@{x=[int]$hr.X;y=[int]$hr.Y;width=[int]$hr.Width;height=[int]$hr.Height}}}|ConvertTo-Json -Compress -Depth 4"
    ].join(" ");
    const result = await this.runPowerShell(script, { timeoutMs: 15000 });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout || "null"); } catch { parsed = null; }
    return { application: app, action: verb, ...(parsed ?? { performed: false, reason: "invalid-ui-automation-result" }), commandResult: result };
  }

  async closeApplication(processName) {
    const name = processName.toLowerCase().replace(".exe", "");
    const ps = await this.runPowerShell(
      `Get-Process -Name '${escapePowerShellSingleQuoted(name)}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`,
      { timeoutMs: 8000 }
    );
    return { processName: name, commandResult: ps };
  }

  async listWindows() {
    if (this.automationHost) {
      try {
        const result = await this.hostRequest("window.enumerate", {}, { timeoutMs: 5000 });
        return (result.windows ?? []).map((window) => ({
          Id: window.processId,
          ProcessName: window.processName,
          MainWindowTitle: window.title,
          WindowHandle: Number(window.windowId),
          ClassName: window.className,
          Bounds: window.bounds,
          DisplayId: window.displayId,
          Dpi: window.dpi,
          Foreground: window.foreground
        }));
      } catch {
        // Fall through to the original bounded PowerShell implementation.
      }
    }
    const ps = await this.runPowerShell(
      `if (-not ("SyscoraWindowEnumerator" -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public sealed class SyscoraWindowInfo { public long WindowHandle; public uint ProcessId; public string Title; }
public static class SyscoraWindowEnumerator {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static List<SyscoraWindowInfo> GetVisibleWindows() {
    var windows = new List<SyscoraWindowInfo>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint processId; GetWindowThreadProcessId(hWnd, out processId);
      var text = new StringBuilder(GetWindowTextLength(hWnd) + 1); GetWindowText(hWnd, text, text.Capacity);
      windows.Add(new SyscoraWindowInfo { WindowHandle = hWnd.ToInt64(), ProcessId = processId, Title = text.ToString() });
      return true;
    }, IntPtr.Zero);
    return windows;
  }

}
'@
      }
      [SyscoraWindowEnumerator]::GetVisibleWindows() | ForEach-Object {
        $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($p) { [pscustomobject]@{ Id = $p.Id; ProcessName = $p.ProcessName; MainWindowTitle = $_.Title; WindowHandle = $_.WindowHandle } }
      } | ConvertTo-Json -Compress`,
      { timeoutMs: 8000 }
    );
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
  }

  async findUiTarget({ application = null, windowId = null, selector = {} } = {}) {
    return this.hostRequest("ui.find", { application, windowId, selector }, { timeoutMs: 8000 });
  }

  // Reusable semantic UI primitive for controls whose accessible name combines
  // an action and an object, such as "Play <track>", "Open <document>", or
  // "Watch <video>". Requiring both fragments is more precise than choosing the
  // first generic button and avoids application- or item-specific coordinates.
  async findAndInvokeSemanticControl({
    application = null,
    windowId = null,
    actionPrefix,
    objectName,
    controlType = "Button"
  } = {}) {
    const prefix = String(actionPrefix ?? "").trim();
    const object = String(objectName ?? "").trim();
    if (!prefix || !object) {
      return { found: false, invoked: false, reason: "semantic-selector-incomplete" };
    }
    const selector = {
      nameStartsWith: prefix,
      nameContains: object,
      controlType
    };
    const found = await this.findUiTarget({ application, windowId, selector });
    if (!found?.found || !found.target) {
      return { found: false, invoked: false, reason: found?.reason ?? "target-not-found", selector };
    }
    if (found.ambiguous) {
      return {
        found: true,
        invoked: false,
        reason: "ambiguous-semantic-target",
        matchCount: found.matchCount,
        target: found.target,
        selector
      };
    }
    const action = await this.performUiAction({
      application,
      windowId: windowId ?? found.target.windowId,
      target: found.target,
      action: "invoke"
    });
    return {
      found: true,
      invoked: action?.performed === true,
      reason: action?.performed === true ? null : (action?.reason ?? "invoke-failed"),
      target: found.target,
      selector,
      action
    };
  }

  async performUiAction({ application = null, windowId = null, target, action, text = "", allowFirst = false } = {}) {
    const params = {
      application, windowId: windowId ?? target?.windowId, target, selector: target?.selector ?? target,
      action, text, allowFirst
    };
    const first = await this.hostRequest("ui.action", params, { timeoutMs: 10000 });
    // Only a stale control may be refreshed deterministically. A missing or
    // mismatched window and a foreground-acquisition failure are safety
    // boundaries: resolving another control after either failure could redirect
    // input to a different window.
    if (first?.performed !== false || !["stale-target", "target-not-found"].includes(first?.reason)) {
      return first;
    }
    const stableSelector = {
      ...(target?.automationId ? { automationId: target.automationId } : {}),
      ...(target?.name ? { name: target.name } : {}),
      ...(target?.controlType ? { controlType: target.controlType } : {})
    };
    if (Object.keys(stableSelector).length === 0) return first;
    const refreshed = await this.hostRequest("ui.find", {
      application,
      windowId: windowId ?? target?.windowId,
      selector: stableSelector
    }, { timeoutMs: 8000 });
    if (!refreshed?.found || !refreshed.target) {
      return {
        ...first,
        deterministicRecovery: {
          attempted: true,
          strategy: "refresh-stable-uia-identity",
          succeeded: false,
          reason: refreshed?.reason ?? "target-refresh-failed"
        }
      };
    }
    const retried = await this.hostRequest("ui.action", {
      ...params,
      windowId: refreshed.target.windowId,
      target: refreshed.target,
      selector: stableSelector
    }, { timeoutMs: 10000 });
    return {
      ...retried,
      deterministicRecovery: {
        attempted: true,
        strategy: "refresh-stable-uia-identity",
        succeeded: retried?.performed === true,
        priorReason: first.reason,
        refreshedTargetId: refreshed.target.targetId
      }
    };
  }

  async manageWindow(operation, params = {}) {
    return this.hostRequest(`window.${operation}`, params, { timeoutMs: 8000 });
  }

  async pointerAction(operation, params = {}) {
    return this.hostRequest(`pointer.${operation}`, params, { timeoutMs: 5000 });
  }

  async keyboardAction(operation, params = {}) {
    return this.hostRequest(`keyboard.${operation}`, params, { timeoutMs: 5000 });
  }

  async clipboardAction(operation, params = {}) {
    return this.hostRequest(`clipboard.${operation}`, params, { timeoutMs: 5000 });
  }

  async captureScreen(params = {}) {
    const defaultPath = path.join(os.tmpdir(), "syscora-m4", `capture-${Date.now()}.png`);
    return this.hostRequest("screen.capture", { ...params, path: params.path ?? defaultPath }, { timeoutMs: 10000 });
  }

  async readOcr(params = {}) {
    return this.hostRequest("ocr.read", params, { timeoutMs: 15000 });
  }

  async locateVisualTarget(params = {}) {
    return this.hostRequest("vision.locate", params, { timeoutMs: 20000 });
  }

  async browserDomAction(operation, params = {}, { signal } = {}) {
    const method = this.browserAutomation?.[operation];
    if (typeof method !== "function") throw new Error(`Unsupported browser DOM operation: ${operation}`);
    return method.call(this.browserAutomation, { ...params, ...(signal ? { signal } : {}) });
  }

  async notepadTypeAndSave({ content, filename }) {
    const documents = this.getDocumentsPath();
    const filePath = path.join(documents, filename);
    await this.launchApplication("notepad");
    await new Promise((r) => setTimeout(r, 2000));
    const escapedContent = escapePowerShellSingleQuoted(content);
    const escapedPath = escapePowerShellSingleQuoted(filePath);
    const ps = await this.runPowerShell(
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$wshell = New-Object -ComObject WScript.Shell; ` +
      `Start-Sleep -Milliseconds 800; ` +
      `if (-not $wshell.AppActivate('Notepad')) { throw 'Notepad window not found' }; ` +
      `Start-Sleep -Milliseconds 400; ` +
      `[System.Windows.Forms.SendKeys]::SendWait('${escapedContent}'); ` +
      `Start-Sleep -Milliseconds 400; ` +
      `[System.Windows.Forms.SendKeys]::SendWait('^s'); ` +
      `Start-Sleep -Milliseconds 1200; ` +
      `[System.Windows.Forms.SendKeys]::SendWait('${escapedPath}'); ` +
      `Start-Sleep -Milliseconds 400; ` +
      `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); ` +
      `Start-Sleep -Milliseconds 800; ` +
      `'saved'`,
      { timeoutMs: 45000 }
    );
    const verify = await this.verifyFileContains(filePath, content);
    return { filePath, content, commandResult: ps, verification: verify };
  }

  async browserSearch(query) {
    const encoded = encodeURIComponent(query);
    const url = `https://www.bing.com/search?q=${encoded}`;
    const result = await this.executeCommand(process.cwd(), "cmd", ["/c", "start", "msedge", url], { timeoutMs: 15000 });
    return { query, url, launchResult: result };
  }

  async restartService(serviceName) {
    const escaped = escapePowerShellSingleQuoted(serviceName);
    const ps = await this.runPowerShell(
      `Restart-Service -Name '${escaped}' -Force -ErrorAction Stop; ` +
      `Get-Service -Name '${escaped}' | Select-Object Name,Status | ConvertTo-Json -Compress`,
      { timeoutMs: 30000 }
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "{}");
    } catch {
      parsed = null;
    }
    return { serviceName, status: parsed?.Status ?? null, commandResult: ps };
  }

  async analyzeSystemPerformance() {
    const system = await this.getSystemInformation();
    const processes = await this.listProcesses();
    const top = processes.slice(0, 5);
    const memoryPressure = system.freeMemory / system.totalMemory < 0.15;
    const contributors = top.map((p) => ({
      processName: p.ProcessName,
      workingSetMb: p.WorkingSet64 ? Math.round(p.WorkingSet64 / 1024 / 1024) : null
    }));
    return {
      memoryPressure,
      freeMemoryGb: (system.freeMemory / 1024 / 1024 / 1024).toFixed(2),
      totalMemoryGb: (system.totalMemory / 1024 / 1024 / 1024).toFixed(2),
      topMemoryProcesses: contributors,
      summary: memoryPressure
        ? "Memory is under pressure; top processes may be contributing to slowness."
        : "No extreme memory pressure detected from current snapshot."
    };
  }
}
