import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getWindowsAutomationHost } from "../../windows-host/src/client.js";
import { CdpBrowserAdapter } from "../../browser/src/cdp-browser-adapter.js";
import { classifyShellCommand, ShellVerdict } from "../../../packages/policy-engine/src/shell-rules.js";
import { accessibilityLaunchArgs } from "./webview-windows.js";
import { executeInWindowsSandbox } from "./windows-sandbox.js";

function pathIsInside(candidate, root) {
  try {
    const relative = path.relative(path.resolve(String(root)), path.resolve(String(candidate)));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function blockedCommand(command, args, reason, rule) {
  return {
    command,
    args,
    exitCode: -1,
    timedOut: false,
    cancelled: false,
    blocked: true,
    blockedRule: rule,
    stdout: "",
    stderr: reason
  };
}

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

const COMMAND_PROBE_ALIASES = Object.freeze({
  "node.js": "node",
  nodejs: "node",
  python3: "python",
  powershell: "powershell"
});

const SAFE_VERSION_ARGUMENTS = Object.freeze({
  python: ["--version"],
  py: ["--version"],
  node: ["--version"],
  npm: ["--version"],
  git: ["--version"],
  java: ["--version"],
  javac: ["--version"],
  dotnet: ["--version"],
  go: ["version"],
  rustc: ["--version"],
  cargo: ["--version"],
  docker: ["--version"],
  kubectl: ["version", "--client"],
  winget: ["--version"],
  code: ["--version"],
  gh: ["--version"],
  powershell: ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]
});

// Parse `winget search` output into structured candidates.
//
// WinGet prints a padded table, but a value wider than its column simply pushes
// into the next one, so fixed header offsets truncate long package ids. Columns
// are instead separated by runs of two or more spaces — a separator that single
// spaces inside a display name never produce. Name/Id/Version are read from the
// left and Source from the right, so the optional Match column cannot shift the
// source onto the wrong field. Rows that yield no id are dropped rather than
// guessed at.
export function parseWingetSearchTable(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\s*Name\s+Id\s+Version/i.test(line));
  if (headerIndex === -1) return [];
  const hasSource = /\bSource\b/i.test(lines[headerIndex]);

  const records = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || /^\s*-+\s*$/.test(line)) continue;
    const fields = line.trim().split(/\s{2,}/).map((field) => field.trim()).filter(Boolean);
    const [name, id, version] = fields;
    if (!id) continue;
    const source = hasSource && fields.length > 3 ? fields[fields.length - 1] : null;
    records.push({
      id,
      name: name || id,
      version: version || null,
      source: source ? source.toLowerCase() : null,
      publisher: null
    });
  }
  return records;
}

function expandWindowsEnvironmentPath(value) {
  const environment = new Map(
    Object.entries(process.env).map(([key, item]) => [key.toUpperCase(), item])
  );
  environment.set("USERPROFILE", process.env.USERPROFILE || os.homedir());
  environment.set("TEMP", process.env.TEMP || os.tmpdir());
  environment.set("TMP", process.env.TMP || os.tmpdir());
  const lookup = (key) => environment.get(String(key).toUpperCase());
  const expanded = String(value ?? "")
    .replace(/%([^%]+)%/g, (match, key) => lookup(key) ?? match)
    // `$env:USERPROFILE\Desktop` is how a Windows path is written in PowerShell,
    // and it is what a model writes when it has just been running PowerShell
    // commands. Only `%VAR%` was expanded, so a perfectly ordinary path was
    // resolved as a literal directory named `$env:USERPROFILE` relative to the
    // working directory, and the write failed with ENOENT on a path containing
    // the words the caller had asked to be substituted. Both spellings mean the
    // same thing; both are accepted. `${env:VAR}` is the braced form.
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gi, (match, key) => lookup(key) ?? match)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, key) => lookup(key) ?? match);
  return redirectKnownFolder(expanded);
}

// "MY DOCUMENTS" IS WHEREVER WINDOWS SAYS IT IS.
//
// `%USERPROFILE%\Documents` expands to a directory that exists on every Windows
// machine and, on a machine with OneDrive, is not the user's Documents. Both are
// real, both list without error, and the wrong one is nearly empty — so a
// listing of it looks like a thorough answer and is a wrong one. The same is
// true of Desktop and Pictures.
//
// This rewrites the profile-relative spelling of the three folders Windows
// itself redirects — `<home>\Documents`, `\Desktop`, `\Pictures`, however they
// were spelled — to wherever Windows currently says they are. It does nothing on
// a machine with no redirection, nothing to Downloads (which Windows does not
// redirect), and nothing to any other path.
//
// It applies to a literal `C:\Users\<name>\Documents` as well as to the
// `%USERPROFILE%` form, and that is deliberate: on a redirected machine that
// literal path is a vestigial directory Windows does not consider Documents, and
// anyone naming it means the folder they see in Explorer. The cost is that the
// leftover cannot be listed through here; the alternative is the failure this
// exists to stop, where listing it succeeds and reports nothing.
const REDIRECTABLE = new Map([
  ["documents", "MyDocuments"],
  ["desktop", "Desktop"],
  ["pictures", "MyPictures"]
]);
const knownFolderCache = new Map();

function knownFolderPath(specialFolder) {
  if (knownFolderCache.has(specialFolder)) return knownFolderCache.get(specialFolder);
  let resolved = "";
  try {
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-Command", `[Environment]::GetFolderPath('${specialFolder}')`
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    );
    resolved = String(probe.stdout ?? "").trim();
  } catch {
    resolved = "";
  }
  knownFolderCache.set(specialFolder, resolved);
  return resolved;
}

function redirectKnownFolder(value) {
  const home = process.env.USERPROFILE || os.homedir();
  if (!home) return value;
  const prefix = `${home.replace(/\\+$/, "")}\\`;
  if (!value.toLowerCase().startsWith(prefix.toLowerCase())) return value;
  const rest = value.slice(prefix.length);
  const [first, ...tail] = rest.split(/[\\/]/);
  const special = REDIRECTABLE.get(String(first ?? "").toLowerCase());
  if (!special) return value;
  const known = knownFolderPath(special);
  // Same place by another name, or a lookup that failed: leave it alone.
  if (!known || known.toLowerCase() === path.join(home, first).toLowerCase()) return value;
  return tail.length ? path.join(known, ...tail) : known;
}

// PRESSING A KEY BY ITS NAME.
//
// The host sends keystrokes through SendKeys, whose notation is a DSL: Enter is
// `{ENTER}`, Ctrl+S is `^s`, Alt+F4 is `%{F4}`. A bare word is not a key name to
// SendKeys — it is TEXT — so `keys: "enter"` types the five letters e,n,t,e,r
// into whatever has focus, and reports performed:true for doing it.
//
// Live, that is exactly what happened: asked to search YouTube, the agent typed
// its query, pressed "enter", and the search box then read "Not Your Typeenter".
// It tried again, cleared, retyped, pressed "enter" again, and burned its whole
// step budget on a search it had already typed correctly twice — because the one
// action that failed was the one that reported success.
//
// Nobody should have to know a 1995 Microsoft DSL to press Enter. A name is
// translated to its token; a combination written the way people write it
// ("ctrl+shift+esc") is translated to its modifiers; anything already in
// SendKeys notation passes through untouched.
const SEND_KEYS_NAMES = new Map(Object.entries({
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
  space: " ", spacebar: " ", backspace: "{BACKSPACE}", bksp: "{BACKSPACE}", delete: "{DELETE}",
  del: "{DELETE}", insert: "{INSERT}", home: "{HOME}", end: "{END}",
  pageup: "{PGUP}", pgup: "{PGUP}", pagedown: "{PGDN}", pgdn: "{PGDN}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  printscreen: "{PRTSC}", prtsc: "{PRTSC}", capslock: "{CAPSLOCK}", numlock: "{NUMLOCK}",
  break: "{BREAK}", help: "{HELP}",
  ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`f${index + 1}`, `{F${index + 1}}`]))
}));
const SEND_KEYS_MODIFIERS = new Map(Object.entries({
  ctrl: "^", control: "^", ctl: "^", alt: "%", shift: "+", win: "^{ESC}"
}));

export function normalizeSendKeys(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  // Already SendKeys notation — it contains a brace group, or it LEADS with a
  // modifier symbol. Leave it be: a caller that knows the notation is not
  // guessing. Testing for a modifier symbol anywhere would catch the `+` in
  // "ctrl+shift+escape", which is the spelling this exists to translate.
  if (/[{}]/.test(raw) || /^[\^%~+]/.test(raw)) return raw;

  const parts = raw.split(/\s*\+\s*/).filter(Boolean);
  const modifiers = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const modifier = SEND_KEYS_MODIFIERS.get(parts[index].toLowerCase());
    // A "+"-joined string whose leading segments are not modifiers is not a
    // combination at all; treat the whole thing as a single name.
    if (!modifier) return SEND_KEYS_NAMES.get(raw.toLowerCase()) ?? raw;
    modifiers.push(modifier);
  }
  const last = parts[parts.length - 1] ?? "";
  const key = SEND_KEYS_NAMES.get(last.toLowerCase())
    ?? (last.length === 1 ? last.toLowerCase() : null);
  // An unrecognised name is returned unchanged rather than guessed at, so it
  // fails visibly instead of typing something plausible.
  if (!key) return raw;
  return `${modifiers.join("")}${key}`;
}

// THE SAME KEY PRESS, SAID THE OTHER WAY.
//
// normalizeSendKeys turns "ctrl+shift+escape" into the notation SendKeys wants.
// The host can now do better than SendKeys — hold the modifiers itself, tap the
// key, release in the reverse order, and report whether Windows accepted the
// events — but only for combinations it can parse. So the human spelling travels
// alongside the notation and the host prefers it, falling back when a caller
// wrote something only SendKeys understands, like "%{F4}" or a bare "{ENTER}".
//
// Nothing is validated here on purpose. The table of key names lives in the
// host, next to the code that uses it; a second copy in this file would be a
// second thing to keep correct.
export function chordSpec(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /[{}]/.test(raw) || /^[\^%~+]/.test(raw)) return null;
  return raw.toLowerCase();
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

// DOES THIS WINDOW BELONG TO THIS APPLICATION?
//
// One rule, used everywhere, because answering it four different ways is how
// the same bug kept coming back in a new place. A window's TITLE is chosen by
// its content, not by the application: a Notepad file called
// "send message to amma on whatsapp sa.txt" is titled
// "*send message to amma on whatsapp sa - Notepad", and every title-substring
// test in this codebase said that window was WhatsApp.
//
// Live, `launch WhatsApp` returned that Notepad window — the user's own
// 200,000-character prompt file — and the next `type` would have written into
// it. The same test put a Chrome tab showing "Spotify - Web Player" forward as
// the Spotify desktop client.
//
// So the PROCESS is what identifies an application. The one exception is a
// generic host — ApplicationFrameHost and friends run somebody else's packaged
// UI and have no identity of their own, so for those, and only those, the title
// is the only identity available and is trusted.
const GENERIC_WINDOW_HOST = /^(applicationframehost|shellexperiencehost|windowsapp|runtimebroker)$/;

function compactName(value) {
  return String(value ?? "").toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]/g, "");
}

export function applicationWindowScore(window, application) {
  const needle = compactName(application);
  if (!needle) return 0;
  const process = compactName(window?.ProcessName ?? window?.processName);
  if (process) {
    if (process === needle) return 3;
    if (process.includes(needle) || needle.includes(process)) return 2;
    if (!GENERIC_WINDOW_HOST.test(process)) return 0;
  }
  const title = compactName(window?.MainWindowTitle ?? window?.title);
  return title && title.includes(needle) ? 1 : 0;
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
    const className = String(window.ClassName ?? window.className ?? "");
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
    // Packaged Windows applications commonly publish two top-level windows:
    // the app-owned Windows.UI.Core.CoreWindow and an ApplicationFrameWindow
    // owned by ApplicationFrameHost.  The former often wins PID correlation,
    // but exposes only a handful of chrome nodes; the latter is the surface a
    // person can actually see and the one UI Automation can operate.  Prefer
    // the frame when both appear as candidates for the same launch.  This is a
    // class-semantic signal, not a hard-coded application name, so it applies
    // to Calculator, Settings and other packaged apps alike.
    if (/applicationframewindow/i.test(className)) {
      // Only make this decisive when the frame title identifies the requested
      // app.  An unrelated ApplicationFrameHost window must not beat a real
      // process match merely because it happens to be new.
      score += titleSimilarity >= 0.5 ? 90 : 10;
      signals.push("interactive-application-frame");
    }
    if (/windows\.ui\.core\.corewindow/i.test(className)) {
      score -= 20; signals.push("packaged-core-window");
    }
    return { window, score, signals, titleSimilarity };
  }).sort((left, right) => right.score - left.score);
  const best = candidates[0];
  // "NEW" AND "IN FRONT" DO NOT SAY WHICH APPLICATION THIS IS.
  //
  // new-hwnd alone scored 45 against a threshold of 45, so ANY window that
  // happened not to be in the previous enumeration was accepted as the
  // application just launched — with no name, process or title match at all.
  // Add the foreground-transition bonus and it cleared the bar comfortably.
  //
  // Live, that is exactly what happened, twice: `launch mspaint` and `launch
  // WhatsApp` both came back grounded on windowId 198792 — SYSCORA's own
  // Electron chat window, which is the window in front because the user is
  // watching it. Every step afterwards read, clicked and typed into the wrong
  // application, and the launch had reported success.
  //
  // Being new and being in front are corroborating signals; they are not
  // identifying ones. At least one signal that actually names the application —
  // the PID we launched, its process name, or its title — has to be present
  // before this may claim to have found it.
  const IDENTIFYING = ["launched-pid", "process-identity", "title-similarity", "interactive-application-frame"];
  const identified = best && (best.signals ?? []).some((signal) =>
    signal === "interactive-application-frame"
      ? best.titleSimilarity >= 0.5
      : IDENTIFYING.includes(signal));
  if (!best || best.score < 45 || !identified) {
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

  // Run a command and capture its output.
  //
  // Two shapes are supported, and the distinction matters:
  //
  //   executeCommand(cwd, "git", ["--version"])   -> spawned directly, no shell
  //   executeCommand(cwd, "git --version")        -> run as a command LINE
  //
  // The first is the typed form every internal caller uses (winget, git, docker),
  // where the executable and its arguments are already separated and must never
  // be re-parsed by a shell. That path is unchanged.
  //
  // The second is how a language model writes a command, every time — one string,
  // the way a person types it into a terminal. It used to be passed straight to
  // `spawn(..., { shell: false })`, which looks for an executable literally named
  // `git --version` and fails with ENOENT and exit code -1. So `command.run`, the
  // single most general capability in the system and the fastest correct route
  // for a large share of real tasks, failed on essentially every model-authored
  // call — and failed QUIETLY, as a nonzero exit rather than an error, which is
  // how "check whether Git is installed" reported Done with exitCode -1.
  //
  // A bare line with no arguments goes through PowerShell rather than cmd.exe: it
  // runs cmd-style lines (`dir`, `git --version`, `echo hi`) as well as real
  // PowerShell (`Get-Process | Sort-Object WS`), so one route covers both instead
  // of asking the model to declare which dialect it wrote.
  async executeCommand(workingDirectory, command, args = [], options = {}) {
    const commandLine = String(command ?? "");
    // THE HARD FLOOR UNDER THE TERMINAL.
    //
    // This is the single place every command in the runtime is spawned, which
    // makes it the only place a refusal cannot be routed around. Risk, policy
    // and approval decide whether a *mutating* command runs; they are the right
    // mechanism for that, and the user can answer yes. A command that formats a
    // disk, wipes the shadow copies, disables Defender or pipes a download into
    // a shell is not a question — approving it would not make it recoverable —
    // so it is refused here, below the approval gate, where an auto-approving
    // session cannot reach past it either.
    //
    // The refusal is a RESULT, not a throw: the caller's verify() reads a
    // nonzero exit and reports the reason to the user, which is the same shape
    // as any other command that did not succeed.
    const spawnVerdict = classifyShellCommand(command, args);
    // Background execution wraps the model's line in Start-Process. Judge both
    // the bytes that will be spawned and the original line they carry: a hard
    // DENY must not become an approvable wrapper merely because it is detached.
    const sourceVerdict = options.shellOrigin === "model" && options.authorizationCommand != null
      ? classifyShellCommand(String(options.authorizationCommand))
      : spawnVerdict;
    const denied = sourceVerdict.verdict === ShellVerdict.DENY ? sourceVerdict
      : (spawnVerdict.verdict === ShellVerdict.DENY ? spawnVerdict : null);
    if (denied) {
      return blockedCommand(command, args, denied.reason, denied.rule);
    }
    const verdict = sourceVerdict.verdict === ShellVerdict.ASK ? sourceVerdict : spawnVerdict;

    // MODEL SHELL POLICY AT THE FINAL SPAWN BOUNDARY.
    //
    // Internal typed commands (for example the registry's own `git --version`)
    // keep their existing path. A free-form command written by the model must
    // explicitly identify itself, and is refused closed if the caller forgot
    // either the developer opt-in or the final ASK callback.
    if (options.shellOrigin === "model") {
      const policy = options.accessPolicy ?? {};
      if (policy.developerMode !== true || policy.shellExecutionMode === "none") {
        return blockedCommand(
          command,
          args,
          "Arbitrary terminal access is disabled. Enable Developer terminal access to use it.",
          "shell.developer-mode-required"
        );
      }
      if (policy.shellExecutionMode === "workspace") {
        const roots = Array.isArray(policy.workspaceRoots) ? policy.workspaceRoots : [];
        // A version/status query has no filesystem write target to confine. Let
        // it run without forcing the user to attach an unrelated folder; any
        // command that can mutate remains refused until it has a real root.
        const readOnlyWithoutRoot = roots.length === 0 && verdict.verdict === ShellVerdict.ALLOW;
        if (!readOnlyWithoutRoot && (roots.length === 0 || !roots.some((root) => pathIsInside(workingDirectory, root)))) {
          return blockedCommand(
            command,
            args,
            "Workspace terminal access can only spawn inside an attached folder.",
            "shell.workspace-boundary"
          );
        }
      }
      if (verdict.verdict === ShellVerdict.ASK) {
        if (typeof options.authorizeShell !== "function") {
          return blockedCommand(
            command,
            args,
            "This command can change the system and no approval channel reached the spawn boundary.",
            "shell.ask-without-authorizer"
          );
        }
        let approved = false;
        try {
          approved = await options.authorizeShell({
            command: String(options.authorizationCommand ?? command),
            args,
            verdict
          });
        } catch {
          approved = false;
        }
        if (approved !== true) {
          return blockedCommand(
            command,
            args,
            "The command was not approved, so no process was spawned.",
            verdict.rule || "shell.default-ask"
          );
        }
      }
      if (policy.shellExecutionMode === "isolated") {
        if (args.length > 0) {
          return blockedCommand(
            command,
            args,
            "Disposable execution accepts a command line, not an internal typed command.",
            "shell.isolation-command-shape"
          );
        }
        return executeInWindowsSandbox({
          command: commandLine,
          workspaceRoots: policy.workspaceRoots,
          timeoutMs: options.timeoutMs,
          signal: options.signal ?? null
        });
      }
    }
    const usesShell = args.length === 0 && /[\s|&<>^"']/.test(commandLine.trim());
    const [spawnCommand, spawnArgs] = usesShell
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", commandLine]]
      : [command, args];
    return new Promise((resolve) => {
      const child = spawn(spawnCommand, spawnArgs, {
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
      let terminating = false;
      let settled = false;
      let exitCode = null;
      let exitFlush = null;
      // On Windows, killing the PowerShell wrapper alone can orphan the real
      // command it launched. That leaves the daemon waiting on one process
      // while adb/installers/servers continue invisibly in another. Stop the
      // exact process tree owned by this command; the user pressed Stop on the
      // whole step, not on its wrapper.
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        if (process.platform === "win32" && child.pid) {
          try {
            const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore", windowsHide: true, shell: false
            });
            killer.unref();
            // taskkill is the tree-aware route. The direct kill is a bounded
            // fallback if policy or antivirus prevents taskkill itself.
            const fallback = setTimeout(() => {
              try { child.kill(); } catch { /* already gone */ }
            }, 500);
            fallback.unref?.();
            return;
          } catch { /* fall through to the direct child */ }
        }
        try { child.kill(); } catch { /* already gone */ }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      // Cooperative cancellation: an aborted signal kills the child promptly and
      // the result carries `cancelled: true` so callers can distinguish it from a
      // timeout or a normal non-zero exit.
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timeout);
        if (exitFlush) clearTimeout(exitFlush);
        if (signal) signal.removeEventListener?.("abort", onAbort);
      };
      const settle = (code = exitCode, error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        // A daemon started by the command can inherit these handles after the
        // command process itself has exited (adb start-server does exactly
        // this). Waiting for ChildProcess "close" then waits for the daemon,
        // not the command, and can pin the whole agent forever. The process
        // "exit" event is the authoritative completion boundary. Give its own
        // buffered output one turn to drain, then detach inherited handles.
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        resolve({
          command,
          args,
          exitCode: Number.isInteger(code) ? code : -1,
          timedOut,
          cancelled,
          stdout,
          stderr: error ? `${stderr}\n${error.message}`.trim() : stderr
        });
      };
      // OUTPUT AS IT ARRIVES, NOT ONLY WHEN IT IS OVER.
      //
      // A command's output was invisible until it exited, which for anything
      // quick is the same thing. For an install it is not: `winget install`
      // downloads a two-hundred-megabyte package and prints a progress bar the
      // whole way, and all of that was buffered and thrown at the transcript
      // afterwards. The user watched a spinner for forty seconds with no way to
      // tell a slow download from a hung one.
      //
      // `onOutput` is optional and costs nothing when nobody is listening; an
      // observer that throws must not kill the command it is watching.
      const onOutput = typeof options.onOutput === "function" ? options.onOutput : null;
      const publish = (text, stream) => {
        if (!onOutput) return;
        try { onOutput({ text, stream }); } catch { /* watching must not break running */ }
      };
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        publish(text, "stdout");
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        publish(text, "stderr");
      });
      child.on("exit", (code) => {
        exitCode = code;
        // Usually "close" follows immediately and preserves every last byte.
        // This fallback is what prevents an inherited pipe from becoming a
        // ten-minute request after the actual command has already finished.
        exitFlush = setTimeout(() => settle(code), 100);
      });
      child.on("close", (code) => {
        settle(Number.isInteger(code) ? code : exitCode);
      });
      child.on("error", (error) => {
        settle(-1, error);
      });
    });
  }

  // A bounded host diagnostic for "is X installed?". This is deliberately not
  // arbitrary shell access: where.exe receives one validated command token,
  // and only a small reviewed set of executables may be launched with fixed
  // version arguments. It therefore remains available when the model terminal
  // is hidden or configured to use Windows Sandbox, while still describing the
  // actual host machine the user asked about.
  async inspectCommand(commandName) {
    const requested = String(commandName ?? "").trim().toLowerCase();
    const canonical = COMMAND_PROBE_ALIASES[requested] ?? requested.replace(/\.exe$/i, "");
    if (!/^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(canonical)) {
      return { checked: false, installed: false, requested, command: canonical, paths: [], reason: "not-a-command-name" };
    }

    const candidates = canonical === "python" ? ["python", "py"] : [canonical];
    const paths = [];
    for (const candidate of candidates) {
      const located = await this.executeCommand(process.cwd(), "where.exe", [candidate], { timeoutMs: 4000 });
      if (located.exitCode !== 0) continue;
      for (const line of String(located.stdout ?? "").split(/\r?\n/)) {
        const found = line.trim();
        if (found && !paths.some((entry) => entry.toLowerCase() === found.toLowerCase())) paths.push(found);
      }
    }

    // WindowsApps entries are app-execution aliases which may only open the
    // Store. They are not evidence that a runtime is installed. Prefer a real
    // executable and report no CLI installation when aliases are all we found.
    const realPaths = paths.filter((entry) => !/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(entry));
    const executablePath = realPaths[0] ?? null;
    if (!executablePath) {
      return {
        checked: true,
        installed: false,
        requested,
        command: canonical,
        path: null,
        paths,
        aliasesOnly: paths.length > 0,
        version: null
      };
    }

    let version = null;
    let versionResult = null;
    const versionArgs = SAFE_VERSION_ARGUMENTS[canonical] ??
      (canonical === "python" && /[\\/]py\.exe$/i.test(executablePath) ? SAFE_VERSION_ARGUMENTS.py : null);
    if (versionArgs) {
      versionResult = await this.executeCommand(path.dirname(executablePath), executablePath, versionArgs, { timeoutMs: 6000 });
      if (versionResult.exitCode === 0) {
        version = `${String(versionResult.stdout ?? "").trim()}\n${String(versionResult.stderr ?? "").trim()}`
          .trim().split(/\r?\n/).find(Boolean) ?? null;
      }
    }

    return {
      checked: true,
      installed: true,
      requested,
      command: canonical,
      path: executablePath,
      paths,
      aliasesOnly: false,
      version,
      versionResult
    };
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
      // Disk volumes. "How much free disk space do I have" is one of the most
      // ordinary questions anyone asks their computer, and it was unanswerable:
      // this call reported OS, CPU and RAM and no storage at all, so the runtime
      // dutifully ran system.inspect and then had to answer a disk question from
      // data containing no disks. The result read as a canned spec sheet that
      // never mentioned the thing that was asked about.
      "$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | " +
      "ForEach-Object { [pscustomobject]@{drive=$_.DeviceID;label=$_.VolumeName;" +
      "totalBytes=$_.Size;freeBytes=$_.FreeSpace;fileSystem=$_.FileSystem} }); " +
      "[pscustomobject]@{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;hostname=$env:COMPUTERNAME;username=$env:USERNAME;architecture=$env:PROCESSOR_ARCHITECTURE;totalMemory=$cs.TotalPhysicalMemory;freePhysicalMemoryKb=$os.FreePhysicalMemory;cpuName=$cpu.Name;cpuCores=$cpu.NumberOfCores;cpuLogical=$cpu.NumberOfLogicalProcessors;disks=$disks} | ConvertTo-Json -Compress -Depth 4"
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "{}");
    } catch {
      parsed = null;
    }
    // Promoted to a top-level field, in readable units, rather than left nested
    // inside windowsDetails. Whatever answers the user's question has to be easy
    // to find in this object — both for the summariser and for the model.
    const disks = (Array.isArray(parsed?.disks) ? parsed.disks : [])
      .filter((disk) => Number(disk?.totalBytes) > 0)
      .map((disk) => {
        const totalBytes = Number(disk.totalBytes);
        const freeBytes = Number(disk.freeBytes);
        const gib = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;
        return {
          drive: disk.drive,
          label: disk.label || null,
          fileSystem: disk.fileSystem || null,
          totalBytes,
          freeBytes,
          usedBytes: totalBytes - freeBytes,
          totalGb: gib(totalBytes),
          freeGb: gib(freeBytes),
          usedGb: gib(totalBytes - freeBytes),
          percentFree: Math.round((freeBytes / totalBytes) * 1000) / 10
        };
      });
    return {
      platform: process.platform,
      release: os.release(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      architecture: os.arch(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
      disks,
      windowsDetails: parsed,
      rawCommand: ps
    };
  }

  // Applications installed on THIS machine, from both registry uninstall hives
  // (per-machine and per-user, 32- and 64-bit) plus Store packages.
  //
  // Recorded as missing in the architecture notes and it stayed missing:
  // `package.winget.search` queries the winget REPOSITORY, which answers "does
  // this software exist" and not "do I have it", so "what's installed on this
  // computer" had no honest route and was served by whatever deterministic plan
  // happened to be nearest.
  async listInstalledApplications({ limit = 400 } = {}) {
    const script =
      "$paths = @(" +
      "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); " +
      "$apps = foreach ($p in $paths) { " +
      "Get-ItemProperty $p -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -and -not $_.SystemComponent } | " +
      "ForEach-Object { [pscustomobject]@{name=$_.DisplayName;version=$_.DisplayVersion;" +
      "publisher=$_.Publisher;source='registry'} } }; " +
      "$store = Get-AppxPackage -ErrorAction SilentlyContinue | " +
      "ForEach-Object { [pscustomobject]@{name=$_.Name;version=$_.Version;" +
      "publisher=$_.Publisher;source='store'} }; " +
      "@($apps) + @($store) | Sort-Object name -Unique | ConvertTo-Json -Compress -Depth 3";
    const ps = await this.runPowerShell(script, { timeoutMs: 60000 });
    let parsed = [];
    try {
      parsed = JSON.parse(ps.stdout || "[]");
    } catch {
      parsed = [];
    }
    const applications = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((app) => app?.name)
      .slice(0, limit);
    return { applications, count: applications.length, truncated: applications.length >= limit };
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
      `$ErrorActionPreference='Stop'; ` +
      `[Environment]::SetEnvironmentVariable('Path','${escapedValue}','User'); ` +
      `[Environment]::GetEnvironmentVariable('Path','User') | ConvertTo-Json -Compress`
    );
    // PowerShell method-invocation failures can be non-terminating and still
    // leave the host process at exit code 0. Never report a durable OS mutation
    // as successful when the registry write was denied (or any diagnostic was
    // emitted). This is especially important for rollback: a false success here
    // means the session claims it restored PATH while the machine stayed changed.
    if (ps.exitCode !== 0 || String(ps.stderr ?? "").trim()) {
      const error = new Error(
        `Unable to update the Windows user PATH: ${String(ps.stderr || `PowerShell exited with code ${ps.exitCode}`).trim()}`
      );
      // A KILLED PROCESS IS NOT A REFUSED WRITE, AND THE CALLER NEEDS TO KNOW
      // WHICH.
      //
      // A timeout arrives here as exit code -1 with an empty stderr, which is
      // indistinguishable from a genuine failure once it has been flattened into
      // USER_PATH_UPDATE_FAILED — and the two call for opposite responses: retry
      // the first, never silently retry the second. Observed 20 Aug 2026 in the
      // full test suite, where spawning powershell.exe under load took longer
      // than the default timeout and the PATH test failed as though the registry
      // write had been rejected.
      //
      // Importantly this says nothing about whether the write LANDED. A timeout
      // means unknown, which is why it is still an error and not a shrug.
      error.code = ps.timedOut === true
        ? "USER_PATH_UPDATE_TIMED_OUT"
        : /registry access is not allowed|access.*denied|securityexception/i.test(String(ps.stderr ?? ""))
          ? "USER_PATH_PERMISSION_DENIED"
          : "USER_PATH_UPDATE_FAILED";
      error.commandResult = ps;
      throw error;
    }
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
    // The probe emits a self-describing envelope. "No listener" and "the probe
    // could not run" are different answers, and neither may be inferred from the
    // host process exit code: `Get-NetTCPConnection` finding nothing sets a
    // nonzero exit code on an otherwise perfectly successful inspection, which
    // previously turned a valid "nothing is listening on port 3000" into a
    // repeated execution failure.
    const ps = await this.runPowerShell(
      "$ErrorActionPreference='SilentlyContinue'; " +
      `$connections=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
      "Select-Object -First 10 LocalAddress,LocalPort,OwningProcess); " +
      "[pscustomobject]@{ok=$true;connections=$connections} | ConvertTo-Json -Compress -Depth 4; " +
      "exit 0"
    );
    let parsed = null;
    try {
      parsed = JSON.parse(ps.stdout || "null");
    } catch {
      parsed = null;
    }
    const probeSucceeded = parsed?.ok === true;
    if (!probeSucceeded) {
      return {
        port,
        listening: null,
        status: "INDETERMINATE",
        connections: [],
        probe: { ok: false, reason: "PORT_PROBE_FAILED", exitCode: ps?.exitCode ?? null },
        commandResult: ps
      };
    }
    const raw = parsed.connections ?? [];
    const connections = Array.isArray(raw) ? raw : [raw];
    return {
      port,
      listening: connections.length > 0,
      status: connections.length > 0 ? "LISTENING" : "NOT_LISTENING",
      connections,
      probe: { ok: true, exitCode: ps?.exitCode ?? null },
      commandResult: ps
    };
  }

  async wingetSearch(query) {
    const q = String(query ?? "").trim();
    return this.executeCommand(process.cwd(), "winget", ["search", "--name", q, "--source", "winget"], { timeoutMs: 20000 });
  }

  // Typed package discovery for the prerequisite workflow. Returns structured
  // candidates with an explicit source so an approval can bind to an exact
  // identity; free-text output is never handed on as a package identity.
  async searchPackages(query, source = "winget") {
    const result = await this.wingetSearch(query);
    if (result.exitCode !== 0) return [];
    return parseWingetSearchTable(result.stdout ?? "").map((entry) => ({ ...entry, source: entry.source || source }));
  }

  // Publisher and version for one already-identified package, so the approval
  // prompt shows who is actually being trusted.
  async describePackage(id, source = "winget") {
    const result = await this.executeCommand(
      process.cwd(),
      "winget",
      ["show", "--id", id, "--source", source, "--accept-source-agreements"],
      { timeoutMs: 20000 }
    );
    if (result.exitCode !== 0) return { id, source, publisher: null, version: null, commandResult: result };
    const field = (label) => result.stdout?.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
    return { id, source, publisher: field("Publisher"), version: field("Version"), commandResult: result };
  }

  async installPackage(id, source = "winget") {
    return this.executeCommand(
      process.cwd(),
      "winget",
      ["install", "--id", id, "--source", source, "--accept-package-agreements", "--accept-source-agreements"],
      { timeoutMs: 300000 }
    );
  }

  async wingetShow(id) {
    return this.executeCommand(process.cwd(), "winget", ["show", "--id", id, "--source", "winget"], { timeoutMs: 20000 });
  }

  async wingetInstall(id) {
    return this.executeCommand(process.cwd(), "winget", ["install", "--id", id, "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"], { timeoutMs: 300000 });
  }

  async wingetUninstall(id) {
    return this.executeCommand(
      process.cwd(),
      "winget",
      ["uninstall", "--id", id, "--source", "winget", "--accept-source-agreements", "--disable-interactivity"],
      { timeoutMs: 300000 }
    );
  }

  async wingetReinstall(id) {
    const uninstall = await this.wingetUninstall(id);
    if (uninstall.exitCode !== 0) {
      return { exitCode: uninstall.exitCode, stage: "uninstall", uninstall, install: null };
    }
    const install = await this.wingetInstall(id);
    return { exitCode: install.exitCode, stage: "install", uninstall, install };
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
    // Installation is a distinct question from "is this workspace a repo" —
    // a workspace with no .git folder never even runs `git`, so isRepository
    // alone cannot answer "is Git installed". Probe it explicitly so a request
    // that only asks about installation has real evidence to anchor to.
    const versionProbe = await this.executeCommand(workspacePath, "git", ["--version"], { timeoutMs: 6000 });
    const gitInstalled = versionProbe.exitCode === 0;
    const gitVersion = gitInstalled ? versionProbe.stdout.trim() : null;
    try {
      await fs.access(path.join(workspacePath, ".git"));
    } catch {
      return { workspacePath, gitInstalled, gitVersion, isRepository: false, status: "NOT_A_REPOSITORY", probeMethod: "filesystem" };
    }
    const probeResult = await this.executeCommand(workspacePath, "git", ["status", "--short", "--branch"], { timeoutMs: 6000 });
    return {
      workspacePath,
      gitInstalled,
      gitVersion,
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

  // WHERE "DOCUMENTS" IS, ON THIS MACHINE.
  //
  // `homedir()/Documents` is where Documents lives on a machine nobody has
  // configured. On a machine with OneDrive — which is the default state of a
  // signed-in Windows 11 install, not an exotic one — the Documents, Desktop and
  // Pictures known folders are redirected into the OneDrive tree, and
  // `C:\Users\<name>\Documents` survives as a near-empty leftover.
  //
  // So this returned a real, existing, wrong directory. Saving a document put it
  // somewhere the user does not look, and searching it for a file they were
  // looking at came back empty — successfully, which is worse than failing.
  //
  // `SHGetKnownFolderPath`, which is what `Environment.GetFolderPath` calls,
  // answers the question properly. It is read once and cached because a known
  // folder does not move while the process is running, and the fallback is the
  // old guess so a machine where the lookup fails still works as it did.
  _knownFolder(specialFolder, fallbackName) {
    this._knownFolders ??= new Map();
    if (this._knownFolders.has(specialFolder)) return this._knownFolders.get(specialFolder);
    let resolved = "";
    try {
      const probe = spawnSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-Command", `[Environment]::GetFolderPath('${specialFolder}')`
        ],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      );
      resolved = String(probe.stdout ?? "").trim();
    } catch {
      resolved = "";
    }
    const value = resolved || path.join(os.homedir(), fallbackName);
    this._knownFolders.set(specialFolder, value);
    return value;
  }

  getDocumentsPath() {
    return this._knownFolder("MyDocuments", "Documents");
  }

  getDesktopPath() {
    return this._knownFolder("Desktop", "Desktop");
  }

  // Downloads is the one known folder with no SpecialFolder member, so the
  // profile-relative path is all there is without going to its GUID. It is also
  // the one Windows almost never redirects.
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

  // List what is in a directory, optionally descending a bounded number of
  // levels. This is the most basic filesystem question there is — "what's in my
  // Downloads folder", "show me the structure of this project" — and there was
  // no primitive for it: `filesystem.search` requires a name pattern, which
  // answers "where is X", not "what is here". So directory questions had no
  // route at all and were refused after ~50s of trying.
  //
  // Done in Node rather than PowerShell: no shell start-up, no quoting surface,
  // and the traversal bound is enforced in code instead of trusted to a script.
  async listDirectory(directoryPath, { depth = 1, maxEntries = 500, includeHidden = false } = {}) {
    const root = path.resolve(expandWindowsEnvironmentPath(directoryPath ?? process.cwd()));
    const maxDepth = Math.min(6, Math.max(1, Math.trunc(Number(depth)) || 1));
    const limit = Math.min(2000, Math.max(1, Math.trunc(Number(maxEntries)) || 500));
    // Walking into these answers no question anyone asked and can be enormous.
    const skip = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information"]);
    const entries = [];
    let truncated = false;

    const walk = async (directory, level, relative) => {
      if (truncated || level > maxDepth) return;
      let dirents;
      try {
        dirents = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        // An unreadable subdirectory is a fact about that subdirectory, not a
        // failure of the listing. Record it and carry on.
        entries.push({ path: relative || ".", type: "unreadable", reason: error.code ?? "EACCES" });
        return;
      }
      for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= limit) { truncated = true; return; }
        if (!includeHidden && dirent.name.startsWith(".")) continue;
        const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
        const childAbsolute = path.join(directory, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ path: childRelative, name: dirent.name, type: "directory", depth: level });
          if (!skip.has(dirent.name)) await walk(childAbsolute, level + 1, childRelative);
        } else {
          let size = null;
          try { size = (await fs.stat(childAbsolute)).size; } catch { /* size is a nicety */ }
          entries.push({ path: childRelative, name: dirent.name, type: "file", depth: level, sizeBytes: size });
        }
      }
    };

    let rootExists = true;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        return { root, exists: true, isDirectory: false, entries: [], count: 0, truncated: false, depth: maxDepth };
      }
    } catch {
      rootExists = false;
    }
    if (rootExists) await walk(root, 1, "");
    return {
      root,
      exists: rootExists,
      isDirectory: rootExists,
      depth: maxDepth,
      entries,
      count: entries.length,
      directoryCount: entries.filter((entry) => entry.type === "directory").length,
      fileCount: entries.filter((entry) => entry.type === "file").length,
      truncated
    };
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

  // A FILE THAT IS NOT THERE IS A VERDICT, NOT AN EXCEPTION.
  //
  // This used to let the read throw, so "the file was never written" surfaced as
  // a bare ENOENT from whichever caller was unlucky — losing the reason the write
  // failed, which the caller had already worked out and was about to report.
  // Absent is simply the strongest possible answer to "does it contain this".
  async verifyFileContains(filePath, expectedSubstring) {
    try {
      const file = await this.readTextFile(filePath);
      return {
        filePath: file.filePath,
        matches: file.contents.includes(expectedSubstring),
        length: file.contents.length
      };
    } catch (error) {
      return { filePath, matches: false, exists: false, reason: error.message };
    }
  }

  // Resolve an application name to a concrete installed identity WITHOUT
  // starting anything. Read-only by construction, so an unknown name is a
  // truthful "not installed" answer rather than a failed launch — which is what
  // the prerequisite/install-and-resume workflow needs to distinguish.
  // People name applications the way they speak, not the way Windows registers
  // them: "the calculator app", "the notepad app", "the Chrome browser". None of
  // those resolve, so a perfectly present application is reported as not
  // installed — which then reads to the user as "SYSCORA can't open Calculator".
  // Produce the spoken form first, then progressively plainer ones, so the exact
  // name a caller supplied always wins and the fallbacks only ever ADD reach.
  static applicationNameVariants(application) {
    const original = String(application ?? "").trim();
    const variants = [original];
    const stripArticle = original.replace(/^(?:the|a|an)\s+/i, "").trim();
    variants.push(stripArticle);
    // Trailing generic nouns describe the KIND of thing, never its identity.
    const stripNoun = stripArticle.replace(/\s+(?:app|application|program|software|browser|editor|window)$/i, "").trim();
    variants.push(stripNoun);
    return [...new Set(variants.filter(Boolean))];
  }

  async resolveApplicationTarget(application, executable = application) {
    const variants = WindowsAdapter.applicationNameVariants(application);
    if (variants.length > 1) {
      for (const variant of variants) {
        const attempt = await this._resolveApplicationTargetExact(
          variant,
          variant === application ? executable : variant
        );
        // Report the resolution under the name the caller asked for, so audit
        // and error messages still say what the user actually said.
        if (attempt.resolved) return { ...attempt, application, requestedApplication: application, resolvedVia: variant };
      }
    }
    return this._resolveApplicationTargetExact(application, executable);
  }

  async _resolveApplicationTargetExact(application, executable = application) {
    const escapedApplication = escapePowerShellSingleQuoted(application);
    const escapedExe = escapePowerShellSingleQuoted(executable);
    // App Paths and Get-Command register browsers and many desktop programs
    // under their executable file name ("msedge.exe"), while users and models
    // name them without it. Try both spellings rather than reporting a present
    // application as absent.
    const escapedExeWithSuffix = escapePowerShellSingleQuoted(
      /\.exe$/i.test(executable) ? executable : `${executable}.exe`
    );
    // EVERY PROBE RAN EVERY TIME, AND TOGETHER THEY EXCEEDED THE TIMEOUT.
    //
    // Measured on this machine: `Get-StartApps` takes 5.7 SECONDS, and
    // `Get-Command` on a name that is not an executable takes another 4.5 while
    // it searches the PATH. Both ran unconditionally, before the cheap checks,
    // inside an eight-second budget — so resolution TIMED OUT and came back
    // RESOLUTION_PROBE_FAILED, which `launch` reports as "not installed".
    //
    // That is why WhatsApp could not be opened: it is a packaged app, only
    // Get-StartApps knows it, and the probe never survived long enough to say
    // so. The agent fell back to working the AppUserModelId out by hand —
    // Get-Process, Get-StartApps, shell:AppsFolder — five commands and half a
    // minute for something the tool was supposed to do.
    //
    // So the order is now by cost. The registry and the Start menu's own
    // shortcuts answer in about 200ms and cover ordinary desktop programs
    // (Spotify resolves here). Only when they find nothing is the slow pair
    // paid for, and then with a budget that lets it finish.
    const fast = await this.runPowerShell(
      `$ErrorActionPreference = 'SilentlyContinue'; ` +
      `$appPath = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + '${escapedExeWithSuffix}') -ErrorAction SilentlyContinue; ` +
      `if (-not $appPath.'(default)') { $appPath = Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + '${escapedExe}') -ErrorAction SilentlyContinue }; ` +
      `$roots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ }; ` +
      `$shortcut = $roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue } | ` +
      `Where-Object { $_.BaseName -ieq '${escapedApplication}' } | Select-Object -First 1; ` +
      // where.exe answers the same question as Get-Command in 174ms instead of
      // 4.5 seconds, because it looks at the PATH and stops rather than building
      // PowerShell's whole command table. It is what finds notepad, the
      // browsers, and anything else that is simply on the PATH.
      `$onPath = & where.exe '${escapedExeWithSuffix}' 2>$null | Select-Object -First 1; ` +
      `if (-not $onPath) { $onPath = & where.exe '${escapedExe}' 2>$null | Select-Object -First 1 }; ` +
      `if ($appPath.'(default)') { $kind = 'app-path'; $target = $appPath.'(default)' } ` +
      `elseif ($onPath) { $kind = 'command'; $target = $onPath } ` +
      `elseif ($shortcut) { $kind = 'start-menu-shortcut'; $target = $shortcut.FullName } ` +
      `else { $kind = $null; $target = $null } ` +
      `[pscustomobject]@{ ok = $true; resolved = [bool]$kind; kind = $kind; target = $target } | ConvertTo-Json -Compress; ` +
      `exit 0`,
      { timeoutMs: 8000 }
    );
    let parsed = null;
    try { parsed = JSON.parse(fast.stdout || "null"); } catch { parsed = null; }
    let commandResult = fast;
    if (parsed?.ok === true && parsed.resolved !== true) {
      const slow = await this.runPowerShell(
        `$ErrorActionPreference = 'SilentlyContinue'; ` +
        `$app = Get-StartApps | Where-Object { $_.Name -ieq '${escapedApplication}' } | Select-Object -First 1; ` +
        `if (-not $app) { $app = Get-StartApps | Where-Object { $_.Name -ilike '${escapedApplication}*' } | Select-Object -First 1 }; ` +
        `$command = $null; ` +
        `if (-not $app) { $command = Get-Command -Name '${escapedExe}' -ErrorAction SilentlyContinue | Select-Object -First 1 }; ` +
        `if (-not $app -and -not $command) { $command = Get-Command -Name '${escapedExeWithSuffix}' -ErrorAction SilentlyContinue | Select-Object -First 1 }; ` +
        `if ($app) { $kind = 'start-menu'; $target = $app.AppID } ` +
        `elseif ($command) { $kind = 'command'; $target = $command.Source } ` +
        `else { $kind = $null; $target = $null } ` +
        `[pscustomobject]@{ ok = $true; resolved = [bool]$kind; kind = $kind; target = $target } | ConvertTo-Json -Compress; ` +
        `exit 0`,
        { timeoutMs: 25000 }
      );
      commandResult = slow;
      try { parsed = JSON.parse(slow.stdout || "null"); } catch { parsed = null; }
    }
    if (parsed?.ok !== true) {
      return {
        application,
        executable,
        resolved: false,
        kind: null,
        target: null,
        reason: "RESOLUTION_PROBE_FAILED",
        commandResult
      };
    }
    return {
      application,
      executable,
      resolved: parsed.resolved === true,
      kind: parsed.kind ?? null,
      target: parsed.target ?? null,
      reason: parsed.resolved === true ? null : "NO_INSTALLED_IDENTITY",
      commandResult
    };
  }

  // Start an already-resolved identity. Every branch targets a concrete path or
  // AppUserModelId that resolution proved exists.
  async launchResolvedTarget(resolution) {
    const escapedTarget = escapePowerShellSingleQuoted(String(resolution.target ?? ""));
    if (resolution.kind === "start-menu") {
      return this.runPowerShell(
        `$ErrorActionPreference = 'Stop'; ` +
        `Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + '${escapedTarget}'); ` +
        `[pscustomobject]@{ started = $true; method = 'start-menu'; appId = '${escapedTarget}' } | ConvertTo-Json -Compress`,
        { timeoutMs: 8000 }
      );
    }
    // START IT SO IT CAN BE READ.
    //
    // An Electron application publishes NOTHING to the accessibility tree unless
    // it is told to at launch: VS Code measured 4 elements without this flag and
    // 157 with it, 3 named controls against 90. There is no way to ask an
    // already-running one — the system-wide screen-reader flag was tested and
    // moved nothing — so the one moment it can be fixed is here, and SYSCORA
    // launches applications constantly. See accessibilityLaunchArgs for why this
    // is a known list rather than every program.
    const extraArgs = accessibilityLaunchArgs({
      application: resolution.application,
      target: resolution.target,
      kind: resolution.kind
    });
    const argumentList = extraArgs.length
      ? ` -ArgumentList @(${extraArgs.map((arg) => `'${escapePowerShellSingleQuoted(arg)}'`).join(",")})`
      : "";
    return this.runPowerShell(
      `$ErrorActionPreference = 'Stop'; ` +
      `$process = Start-Process -FilePath '${escapedTarget}'${argumentList} -PassThru; ` +
      `[pscustomobject]@{ started = $true; method = '${resolution.kind}'; processId = $process.Id; target = '${escapedTarget}' } | ConvertTo-Json -Compress`,
      { timeoutMs: 8000 }
    );
  }

  // Open an http(s) URL with a specifically named installed application. This
  // is a typed runtime operation: the application is resolved to an installed
  // identity first and the URL is passed as one literal argument, never parsed
  // as model-authored shell. Executable-backed browsers support this directly;
  // opaque Start-menu identities deliberately return unsupported rather than
  // handing the URL to the machine's unrelated default browser.
  async openUrlInApplication(url, application) {
    const targetUrl = String(url ?? "").trim();
    const app = String(application ?? "").trim();
    if (!/^https?:\/\//i.test(targetUrl)) throw new Error("Only http(s) URLs can be opened");
    if (!app) throw new Error("An application name is required");
    const resolution = await this.resolveApplicationTarget(app, app);
    if (!resolution.resolved) {
      return {
        exitCode: -1,
        stderr: `${app} is not installed or could not be resolved.`,
        application: app,
        resolution,
        opened: false
      };
    }
    if (resolution.kind === "start-menu") {
      return {
        exitCode: -1,
        stderr: `${app} has only an opaque Start-menu identity, which cannot safely receive a URL argument.`,
        application: app,
        resolution,
        opened: false,
        reason: "APPLICATION_ARGUMENTS_UNSUPPORTED"
      };
    }
    const executable = escapePowerShellSingleQuoted(String(resolution.target));
    const literalUrl = escapePowerShellSingleQuoted(targetUrl);
    const commandResult = await this.runPowerShell(
      `$ErrorActionPreference = 'Stop'; ` +
      `$process = Start-Process -FilePath '${executable}' -ArgumentList @('${literalUrl}') -PassThru; ` +
      `[pscustomobject]@{ opened = $true; processId = $process.Id } | ConvertTo-Json -Compress`,
      { timeoutMs: 8000 }
    );
    let opened = null;
    try { opened = JSON.parse(commandResult.stdout || "null"); } catch { opened = null; }
    return {
      ...commandResult,
      application: app,
      resolution,
      opened: opened?.opened === true,
      processId: opened?.processId ?? null
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
    // Resolution and launch are two separate stages. A launch may only target a
    // concrete installed identity — a Start menu AppUserModelId, a resolvable
    // command, an App Paths registration, or a Start menu shortcut. The previous
    // single-stage script ended in a `literal` Start-Process fallback, which
    // turned an unknown name (a website such as "youtube", a typo, or an
    // uninstalled application) into a bogus launch attempt whose failure was
    // then indistinguishable from "the window could not be grounded".
    const resolution = await this.resolveApplicationTarget(application, exe);
    if (!resolution.resolved) {
      return {
        application,
        exe,
        resolution,
        launchResult: resolution.commandResult,
        launch: { started: false, method: null },
        window: null,
        windowIdentity: null,
        failureCategory: "APPLICATION_NOT_INSTALLED",
        grounding: {
          grounded: false,
          attempts: 0,
          elapsedMs: Date.now() - launchStartedAt,
          progressExtended: false,
          readinessState: "APPLICATION_NOT_INSTALLED",
          confidence: 0,
          signals: [],
          candidates: []
        },
        before: {
          windowIds: beforeWindows.map((candidate) => String(candidate.WindowHandle ?? candidate.windowId)),
          foregroundWindowId: String(beforeWindows.find((candidate) => candidate.Foreground ?? candidate.foreground)?.WindowHandle ?? "")
        },
        windows: beforeWindows
      };
    }
    // Do not wait for a GUI application's process to exit. Start-Process returns
    // as soon as Windows accepts the launch request.
    const result = await this.launchResolvedTarget(resolution);
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
      resolution,
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
  // The Windows Core Audio endpoint, as an inline C# shim.
  //
  // Volume used to be media-key simulation only: it could nudge up or down and
  // could not read anything. So "what's the volume?" had no capability at all,
  // and "set it to 26%" had no way to express an absolute level — the planner
  // emitted an empty-input call and the session died on a precondition check.
  // Nudging is not the same skill as knowing and setting a value, and a person
  // asking for 26% means 26%.
  //
  // IAudioEndpointVolume is declared by vtable order, so every method above the
  // one being called must be present and correctly shaped even though it is
  // unused — a missing slot silently calls the wrong function. (Getting this
  // wrong is what made an earlier attempt return "value does not fall within
  // the expected range".)
  static AUDIO_ENDPOINT_SHIM = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr n);
  int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float l, ref Guid ctx);
  int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint ch, float l, ref Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float l);
  int GetChannelVolumeLevelScalar(uint ch, out float l);
  int SetMute(bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}
// WHAT IS ACTUALLY COMING OUT OF THE SPEAKER.
//
// The mute FLAG is not the same fact as silence, and the user has now twice
// reported hearing audio while this reported "(muted)". A flag is what the
// endpoint was told; the peak meter is what it is emitting. Reading both, from
// two different interfaces on the same device, is the only way to tell "muted"
// from "we set a bit and something is still making noise".
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float peak); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  // Declared and unused, because the vtable is positional: without this slot
  // GetId below is called at OpenPropertyStore's index and comes back "Value
  // does not fall within the expected range" — the same failure this file's
  // header warns about, made again.
  int OpenPropertyStore(int access, out IntPtr store);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetState(out int state);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, IntPtr c); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class SyscoraAudio {
  static IMMDevice Device() {
    IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev); return dev;
  }
  static IAudioEndpointVolume Endpoint() {
    Guid id = typeof(IAudioEndpointVolume).GUID; object o;
    Device().Activate(ref id, 23, IntPtr.Zero, out o); return (IAudioEndpointVolume)o;
  }
  // Sampled rather than read once: a waveform crosses zero, so a single sample
  // of playing audio is silent about a third of the time. Reporting THAT as
  // silence would be the same class of lie as trusting the flag.
  public static float Peak() {
    Guid id = typeof(IAudioMeterInformation).GUID; object o;
    Device().Activate(ref id, 23, IntPtr.Zero, out o);
    var meter = (IAudioMeterInformation)o;
    float highest = 0;
    for (int i = 0; i < 12; i++) {
      float p; meter.GetPeakValue(out p);
      if (p > highest) highest = p;
      System.Threading.Thread.Sleep(25);
    }
    return highest;
  }
  public static string DeviceId() { string id; Device().GetId(out id); return id; }
  public static float Get() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return v; }
  public static bool GetMute() { bool m; Endpoint().GetMute(out m); return m; }
  public static void Set(float v) { Guid g = Guid.Empty; Endpoint().SetMasterVolumeLevelScalar(v, ref g); }
  public static void Mute(bool m) { Guid g = Guid.Empty; Endpoint().SetMute(m, ref g); }
}
'@
`;

  // THE LONG-LIVED HOST ALREADY HAS THE ENDPOINT COMPILED.
  //
  // Both volume calls below spawn a powershell.exe and Add-Type the C# shim
  // above, every time. Measured 17 Aug 2026: 1,400ms for "what's my volume", of
  // which ~1,100ms was startup and compilation and 300ms was the peak sample
  // doing real work. The automation host has the same shim compiled once at
  // startup, so the same question costs an IPC round trip.
  //
  // Null when the host cannot answer — no host, or its Add-Type failed on this
  // machine — and both callers then take the out-of-process route unchanged. The
  // fallback is not decoration: this is the only place in the product that can
  // tell the user whether their machine is making a noise.
  async _audioViaHost(operation, params = {}) {
    if (!this.automationHost) return null;
    try {
      const answer = await this.hostRequest(operation, params, { timeoutMs: 8000 });
      return answer?.available === true ? answer : null;
    } catch {
      return null;
    }
  }

  async readSystemVolume() {
    const viaHost = await this._audioViaHost("audio.read");
    if (viaHost) {
      return {
        available: true,
        percent: Number(viaHost.percent),
        muted: viaHost.muted === true,
        // Null when the endpoint is not muted: the meter is only EVIDENCE when
        // it contradicts the flag, and sampling it costs 300ms of the host's
        // single thread. See Read-AudioEndpoint.
        peak: Number.isFinite(Number(viaHost.peak)) ? Number(viaHost.peak) : null,
        deviceId: viaHost.deviceId ?? null
      };
    }
    const ps = await this.runPowerShell(
      `${WindowsAdapter.AUDIO_ENDPOINT_SHIM}
[pscustomobject]@{ percent = [math]::Round([SyscoraAudio]::Get()*100,1); muted = [SyscoraAudio]::GetMute(); peak = [SyscoraAudio]::Peak(); deviceId = [SyscoraAudio]::DeviceId() } | ConvertTo-Json -Compress`,
      { timeoutMs: 20000 }
    );
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    if (parsed == null || !Number.isFinite(Number(parsed.percent))) {
      return { available: false, percent: null, muted: null, commandResult: ps };
    }
    return {
      available: true,
      percent: Number(parsed.percent),
      muted: parsed.muted === true,
      // Measured output over ~300ms, 0 to 1. The flag says what the endpoint was
      // told; this says what it is emitting.
      peak: Number.isFinite(Number(parsed.peak)) ? Number(parsed.peak) : null,
      deviceId: parsed.deviceId ?? null,
      commandResult: ps
    };
  }

  // Set the master volume to an absolute percentage, then read it back. The
  // read-back is the evidence: the capability's verify() compares what was asked
  // for against what the endpoint actually reports, so "set to 26%" can only be
  // reported as done when the device really is at 26%.
  async setSystemVolume(percent, { mute = null } = {}) {
    const target = Math.min(100, Math.max(0, Number(percent)));
    if (!Number.isFinite(target)) throw new Error("A volume percentage between 0 and 100 is required");
    const viaHost = await this._audioViaHost("audio.set", {
      level: target / 100,
      ...(mute === null ? {} : { mute: mute === true })
    });
    if (viaHost) {
      return {
        requestedPercent: target,
        percent: Number.isFinite(Number(viaHost.percent)) ? Number(viaHost.percent) : null,
        muted: viaHost.muted === true,
        peak: Number.isFinite(Number(viaHost.peak)) ? Number(viaHost.peak) : null,
        applied: viaHost.applied === true
      };
    }
    const muteClause = mute === null ? "" : `[SyscoraAudio]::Mute($${mute === true ? "true" : "false"});`;
    const ps = await this.runPowerShell(
      `${WindowsAdapter.AUDIO_ENDPOINT_SHIM}
[SyscoraAudio]::Set(${(target / 100).toFixed(4)}); ${muteClause}
[pscustomobject]@{ percent = [math]::Round([SyscoraAudio]::Get()*100,1); muted = [SyscoraAudio]::GetMute(); peak = [SyscoraAudio]::Peak() } | ConvertTo-Json -Compress`,
      { timeoutMs: 20000 }
    );
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    const observed = Number(parsed?.percent);
    return {
      requestedPercent: target,
      percent: Number.isFinite(observed) ? observed : null,
      muted: parsed?.muted === true,
      peak: Number.isFinite(Number(parsed?.peak)) ? Number(parsed.peak) : null,
      // Endpoints quantise, so an exact match is not always achievable. One
      // percentage point is close enough to call the request honoured.
      applied: Number.isFinite(observed) && Math.abs(observed - target) <= 1,
      commandResult: ps
    };
  }

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
    const script = [
      "Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;",
      `$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${handle});`,
      "$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);",
      "$playing=$false;$nowPlaying=$null;",
      "foreach($el in $all){try{$name=$el.Current.Name;$type=$el.Current.ControlType.ProgrammaticName;if(-not $nowPlaying -and -not $el.Current.IsOffscreen -and $name -like 'Now playing:*'){$nowPlaying=$name};if($type -eq 'ControlType.Group' -and $name -eq 'Player controls'){$buttons=$el.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)));foreach($button in $buttons){if($button.Current.Name -eq 'Pause'){$playing=$true;break}}}}catch{}};",
      "[pscustomobject]@{playing=$playing;nowPlaying=$nowPlaying}|ConvertTo-Json -Compress"
    ].join(" ");
    let ui = await this.runPowerShell(script, { timeoutMs: 5000 });
    let state = null;
    try { state = JSON.parse(ui.stdout || "null"); } catch { state = null; }
    let accessibleLabel = String(state?.nowPlaying ?? "").replace(/^Now playing:\s*/i, "").trim();
    // Playing but the accessible label wasn't on screen at read time — it can
    // appear a beat later as the UI settles. Retry once before falling back to
    // the window title, which is a known-unreliable signal (Spotify shows the
    // idle "Spotify Free" title even during genuine playback).
    if (state?.playing === true && !accessibleLabel) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const retry = await this.runPowerShell(script, { timeoutMs: 5000 });
      let retryState = null;
      try { retryState = JSON.parse(retry.stdout || "null"); } catch { retryState = null; }
      const retryLabel = String(retryState?.nowPlaying ?? "").replace(/^Now playing:\s*/i, "").trim();
      if (retryLabel) {
        ui = retry;
        state = retryState;
        accessibleLabel = retryLabel;
      }
    }
    const fallback = this.interpretSpotifyPlayback(window.MainWindowTitle);
    const playing = state?.playing === true || (state == null && fallback.playing);
    // A fallback title that is itself one of Spotify's known-idle strings
    // ("Spotify" / "Spotify Free" / "Spotify Premium") is not evidence of what
    // is playing, even while playback is confirmed live — it commonly shows
    // during genuine playback too. Report unknown rather than asserting it.
    const IDLE_TITLES = new Set(["spotify", "spotify free", "spotify premium"]);
    const fallbackIsIdle = IDLE_TITLES.has(fallback.title.trim().toLowerCase());
    const title = playing && accessibleLabel
      ? accessibleLabel
      : (playing && !fallbackIsIdle ? fallback.title : null);
    return { running: true, window, playing, title, nowPlaying: title, accessibilityLabel: accessibleLabel || null, commandResult: ui };
  }

  // Bounded wait for an application's main window to appear. NEVER waits
  // indefinitely: polls listWindows() until a match or the (clamped) deadline,
  // returning { ready, window }.
  // A BROWSER TAB NAMED AFTER AN APPLICATION IS NOT THAT APPLICATION.
  //
  // This accepted any window whose process name OR TITLE contained the needle,
  // and a title match is not evidence of anything: a Chrome window showing
  // "Spotify - Web Player: Music for everyone" matched "spotify" and was
  // returned as the Spotify desktop client.
  //
  // Live, that produced the installer the user saw and never asked for.
  // playSpotifyTrack takes a ready window as proof the client is there and then
  // hands the track off over the `spotify:` protocol — so with a browser tab
  // standing in for the client, Windows received a `spotify:` URI with no
  // registered handler behind it and offered to install Spotify from the Store.
  // Nothing in the transcript said "installing", because nothing was: it was a
  // protocol hand-off to an application that is not on this machine.
  //
  // So the process is what identifies it, and `matchTitle` is opt-in for the
  // callers that genuinely mean "a window called this".
  async waitForApplicationWindow(match, timeoutMs = 8000, { matchTitle = false } = {}) {
    const needle = String(match ?? "").toLowerCase();
    const compact = needle.replace(/[^a-z0-9]/g, "");
    const deadline = Date.now() + clampInt(timeoutMs, 500, 20000, 8000);
    // Browsers are never the application: they are the one process that can be
    // called anything, because a page chooses its own title.
    const BROWSER = /^(chrome|msedge|firefox|opera|brave|avastbrowser|vivaldi|iexplore|safari)$/i;
    let window = null;
    while (Date.now() < deadline) {
      const windows = await this.listWindows();
      const named = windows.filter((w) => applicationWindowScore(w, needle) > 0);
      window = named[0] ?? null;
      if (!window && matchTitle) {
        window = windows.find((w) =>
          !BROWSER.test(String(w.ProcessName ?? "")) &&
          String(w.MainWindowTitle ?? "").toLowerCase().includes(needle)) ?? null;
      }
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

    // 4. Bounded UI Automation: locate a result whose accessible text matches
    //    the requested track, then invoke that result's Play button. There is no
    //    "first Play button" fallback: playing an unrelated paused item is worse
    //    than reporting that the matching row could not be identified.
    const uia = await this._invokeSpotifyPlayButton(text, playDeadlineMs, ready.window?.WindowHandle);
    steps.push({ step: "activate-play", ok: uia.invoked, detail: uia.reason ?? null });

    // 5. Let playback start, then read the live title for an honest result.
    //
    // Unless nothing was clicked. If the matching row could not be found there
    // is no Play button that was pressed, so waiting a second and a bit to see
    // whether it started is waiting for something that cannot happen — and this
    // is the common case: three music requests in one session each paid the full
    // wait before falling back to reading the screen and clicking, which worked
    // every time. The search results are populated by now either way, so that
    // fallback is one click away.
    if (uia.invoked && this.automationHost) {
      // Arm a local readiness predicate and return the instant Spotify exposes
      // the requested Now-playing label. This replaces a blind 1.2-second sleep
      // without asking the model to inspect the screen between polls.
      const playbackReady = await this.waitForUiTarget({
        application: "spotify",
        windowId: ready.window?.WindowHandle,
        selector: {
          nameStartsWith: "Now playing:",
          nearText: spotifyQueryTokens(text).join(" "),
          minimumCoverage: 0.5,
          maxDistance: 1200,
          sameRowTolerance: 140
        },
        timeoutMs: 1800
      }).catch(() => null);
      steps.push({
        step: "playback-ready",
        ok: playbackReady?.matched === true,
        elapsedMs: playbackReady?.elapsedMs ?? null,
        eventWakeups: playbackReady?.eventWakeups ?? 0
      });
    } else if (uia.invoked) {
      // Compatibility only: production Windows sessions use the persistent
      // host above, while degraded/non-Windows environments retain the former
      // bounded settle before the legacy playback read.
      await new Promise((r) => setTimeout(r, 1200));
    }
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
      playedEpisode: uia.pickedEpisode === true,
      matchedLabel: uia.matchedLabel ?? null,
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
    const startedAt = Date.now();
    const tokens = spotifyQueryTokens(query);
    if (tokens.length === 0) return { found: false, invoked: false, name: null, reason: "invalid-track-query", commandResult: null };
    // Modern Chromium accessibility trees often expose a result as one button
    // named "Play <title> by <artist>" instead of a title label containing a
    // nested generic Play button. Try the general compound-name selector first.
    if (this.automationHost) {
      // Button first, because when a row IS a button that is the least ambiguous
      // possible match. Then again with no control-type constraint at all: the
      // rows in Spotify's search results are DataItems, not buttons, and a name
      // that both starts with "Play " and contains the requested track is
      // already specific enough to stand on its own.
      for (const controlType of ["Button", null]) {
        try {
          const semantic = await this.findAndInvokeSemanticControl({
            application: "spotify",
            windowId: windowHandle,
            actionPrefix: "Play ",
            objectName: String(query).trim(),
            controlType
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

      // Spotify's top result often publishes the title/artist and the action as
      // separate siblings: a bare DataItem named "Play" beside text naming the
      // song. Wait for that relationship locally, waking on UIA changes and
      // polling only as a fallback. This is the general primitive the screen
      // tool already teaches the model manually as "beside it".
      const remainingMs = Math.min(2500, Math.max(0, limit - (Date.now() - startedAt)));
      if (remainingMs >= 50) {
        try {
          const selector = {
            nameStartsWith: "Play",
            controlTypes: ["Button", "DataItem", "ListItem", "Hyperlink"],
            nearText: spotifyQueryTokens(query).join(" "),
            minimumCoverage: 0.5,
            maxDistance: 1100,
            sameRowTolerance: 140
          };
          const nearby = await this.waitForUiTarget({
            application: "spotify",
            windowId: windowHandle,
            selector,
            timeoutMs: remainingMs
          });
          if (nearby?.matched && nearby.target) {
            const bounds = uiBounds(nearby.target);
            const invoked = await this.invokeControl({
              windowId: nearby.target.windowId ?? windowHandle,
              name: nearby.target.name,
              x: Number(bounds.x) + Number(bounds.width) / 2,
              y: Number(bounds.y) + Number(bounds.height) / 2
            });
            if (invoked?.performed === true) {
              return {
                found: true,
                invoked: true,
                name: nearby.target.name ?? null,
                matchedLabel: String(query).trim(),
                matchedBounds: bounds,
                reason: null,
                readiness: nearby,
                semantic: invoked
              };
            }
            // Spotify exposes its row action as a DataItem without
            // InvokePattern. The target is already grounded to the requested
            // row and exact window, so deliver one ordinary click locally rather
            // than throwing the result away and starting a new PowerShell scan.
            const clicked = await this.pointerAction("click", {
              windowId: String(nearby.target.windowId ?? windowHandle),
              x: Number(bounds.x) + Number(bounds.width) / 2,
              y: Number(bounds.y) + Number(bounds.height) / 2,
              button: "left",
              clicks: 1
            }).catch(() => null);
            if (clicked?.performed === true) {
              return {
                found: true,
                invoked: true,
                name: nearby.target.name ?? null,
                matchedLabel: String(query).trim(),
                matchedBounds: bounds,
                reason: null,
                readiness: nearby,
                semantic: clicked
              };
            }
          }
        } catch {
          // A bounded miss returns below so the model-visible screen fallback
          // can act; only sessions without the persistent host use the legacy
          // process-isolated matcher.
        }
      }
      // The persistent host already performed every bounded semantic route. Do
      // not buy a second process startup and another tree walk after it misses;
      // returning now lets the existing screen fallback act immediately.
      return {
        found: false,
        invoked: false,
        name: null,
        reason: "matching-track-not-found",
        commandResult: null
      };
    }
    // Keep host readiness plus compatibility matching inside the caller's one
    // deadline. A failed readiness predicate must not silently buy a second
    // full six-second wait.
    const legacyLimit = Math.max(100, limit - (Date.now() - startedAt));
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
      // THE ONE RESULT SPOTIFY ITSELF PICKED WAS THE ONE THIS COULD NOT PRESS.
      //
      // Every search for a play control was restricted to ControlType.Button.
      // Spotify's search page does not use buttons for its rows: the list rows
      // come back as DataItem ("Play Tu Chahiye"), and the big top-result card —
      // the one Spotify chose as the best match, and the one a person clicks —
      // exposes its play control as a bare DataItem named "Play".
      //
      // So asked for "Dildara", with "Dildaara (Stand By Me)" sitting in the top
      // card, this walked the tree, found no Button, and returned
      // matching-track-not-found. Playback never started, the previous song kept
      // playing, and the honest report of that ("still playing Stand By Me") was
      // read as a matching failure. The model then re-typed the query by hand,
      // read the screen, and clicked the very control this had skipped — which
      // is how we know the control was there and clickable the whole time.
      //
      // Control type was never the right filter. What makes something pressable
      // is that it is named for the action and carries an Invoke pattern, and
      // both are checked below regardless of what kind of element Chromium chose
      // to call it.
      "$playableTypes=@([System.Windows.Automation.ControlType]::Button," +
        "[System.Windows.Automation.ControlType]::DataItem," +
        "[System.Windows.Automation.ControlType]::ListItem," +
        "[System.Windows.Automation.ControlType]::Hyperlink);",
      "$buttonCond=$null; foreach($t in $playableTypes){ $c=New-Object System.Windows.Automation.PropertyCondition(" +
        "[System.Windows.Automation.AutomationElement]::ControlTypeProperty,$t); " +
        "if($buttonCond){$buttonCond=New-Object System.Windows.Automation.OrCondition($buttonCond,$c)}else{$buttonCond=$c} };",
      `$tokens=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTokens}')) | ConvertFrom-Json);`,
      `$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'));`,
      `$displayQuery=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDisplayQuery}'));`,
      "$lowerQuery=$query.ToLower();$queryVariants=@($displayQuery);foreach($digraph in @('t','d','k','g','p','b','c','s')){for($i=0;$i-lt$lowerQuery.Length;$i++){if($lowerQuery[$i]-eq$digraph){$queryVariants+=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($lowerQuery.Insert($i+1,'h'))}}};",
      // Spotify frequently corrects spelling in search results. Accept a single
      // insertion/deletion/substitution per meaningful token, matching the same
      // tolerance used by independent playback verification.
      "$near={param($a,$b);$a=[string]$a;$b=[string]$b;if($a -eq $b){return $true};if([Math]::Abs($a.Length-$b.Length)-gt 1){return $false};if($a.Length -eq $b.Length){$d=0;for($i=0;$i-lt$a.Length;$i++){if($a[$i]-ne$b[$i]){$d++}};return $d-le 1};$long=if($a.Length-gt$b.Length){$a}else{$b};$short=if($a.Length-gt$b.Length){$b}else{$a};for($i=0;$i-lt$long.Length;$i++){if(($long.Remove($i,1))-eq$short){return $true}};return $false};",
      // A SONG'S TITLE NEVER CONTAINS ITS ARTIST. A PODCAST EPISODE'S DOES.
      //
      // This required EVERY token of the query to appear in the row's label, and
      // that rule quietly favours the wrong kind of result. Asked for "Shake It
      // Off Taylor Swift", Spotify's own song row is labelled just "Shake It
      // Off" — no artist, so two of the five tokens are missing and it was
      // rejected. The podcast episode "Shake It Off - Taylor Swift" contains all
      // five, matched exactly, and played. The user got an episode ABOUT the
      // song instead of the song, and every check downstream agreed it was
      // right, because it matched the words they asked for.
      //
      // So: a majority of tokens is enough to be a candidate, and the row's own
      // kind decides between candidates. Nothing here knows what Taylor Swift
      // is; it knows that a row advertising "Episode" or "Your Episodes" is a
      // podcast, and that a request for a track means the song when both exist.
      "$scoreOf={ param($name) if(-not $name){ return 0 }; $words=@(([string]$name).ToLower() -split '[^a-z0-9]+' | Where-Object { $_ }); $hits=0; foreach($token in @($tokens)){ foreach($word in $words){if(& $near ([string]$word) ([string]$token)){$hits++;break}} }; return $hits };",
      "$needed=[Math]::Max(1,[Math]::Ceiling(@($tokens).Count * 0.5));",
      "$matches={ param($name) return ((& $scoreOf $name) -ge $needed) };",
      "$isEpisode={ param($node) try{ $all=$node.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition); $n=[Math]::Min($all.Count,40); for($i=0;$i -lt $n;$i++){ $nm=[string]$all[$i].Current.Name; if($nm -and ($nm -like 'Episode*' -or $nm -like '*Your Episodes*' -or $nm -like 'Podcast*')){ return $true } } }catch{}; return $false };",
      "$play=$null;",
      "$matchedLabel=$null;",
      "$matchedBounds=$null;",
      "$episodePlay=$null;$episodeLabel=$null;$episodeBounds=$null;$pickedEpisode=$false;",
      "while($sw.ElapsedMilliseconds -lt " + legacyLimit + " -and -not $play){",
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
      "  if($labels.Count -eq 0){try{foreach($variant in @($queryVariants)){if($sw.ElapsedMilliseconds -ge (" + legacyLimit + "/2)){break};$variantCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$variant);$variantLabel=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$variantCondition);if($variantLabel){$labels=@($variantLabel);break}}}catch{$labels=@()}};",
      "  $playNameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Play');$genericPlayCond=New-Object System.Windows.Automation.AndCondition($buttonCond,$playNameCond);",
      "  foreach($labelEl in $labels){try{$label=$labelEl.Current.Name;$rr=$labelEl.Current.BoundingRectangle;if($labelEl.Current.IsOffscreen -or -not (& $matches $label) -or $rr.Width -le 0 -or $rr.Height -le 0 -or $rr.Height -gt 260){continue};$ancestor=$labelEl;for($depth=0;$depth-lt 5;$depth++){$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor);if(-not $ancestor){break};$candidate=$ancestor.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$genericPlayCond);if($candidate -and -not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled){if(& $isEpisode $ancestor){if(-not $episodePlay){$episodePlay=$candidate;$episodeLabel=$label;$episodeBounds=$rr}}else{$best=$candidate;$matchedLabel=$label;$matchedBounds=$rr};break}}}catch{};if($best){break}};",
      // Some Chromium apps expose the action and object as one accessibility
      // control (for example "Play Good For You by ..."). Search only Button
      // controls, not the entire raw tree, and bind the action to the requested
      // object tokens before invoking it. This is the same general semantic
      // action+object shape used by the persistent host selector above.
      "  if(-not $best -and $sw.ElapsedMilliseconds -lt " + legacyLimit + "){try{$actionButtons=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCond);foreach($candidate in $actionButtons){if($sw.ElapsedMilliseconds -ge " + legacyLimit + "){break};$candidateName=$candidate.Current.Name;$candidateBounds=$candidate.Current.BoundingRectangle;if(-not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled -and $candidateName.StartsWith('Play ',[StringComparison]::OrdinalIgnoreCase) -and (& $matches $candidateName) -and $candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0){$best=$candidate;$matchedLabel=$candidateName;$matchedBounds=$candidateBounds;break}}}catch{}};",
      "  if($best){$play=$best;break};",
      "  if(-not $play){ Start-Sleep -Milliseconds 400 }",
      "};",
      // An episode is used ONLY when nothing else answered to the name — asked
      // for a podcast, that is the right answer; asked for a song that does not
      // exist, it is at least the honest one, and it is reported as an episode
      // so the caller can say so rather than claiming it played the track.
      "if(-not $play -and $episodePlay){$play=$episodePlay;$matchedLabel=$episodeLabel;$matchedBounds=$episodeBounds;$pickedEpisode=$true};",
      "if(-not $play){ [pscustomobject]@{found=$false;invoked=$false;reason='matching-track-not-found'} | ConvertTo-Json -Compress; return };",
      "$name=$play.Current.Name; $invoked=$false;",
      "try{ $ip=$play.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke(); $invoked=$true }catch{ $invoked=$false };",
      "[pscustomobject]@{found=$true;invoked=$invoked;name=$name;matchedLabel=$matchedLabel;matchedBounds=$matchedBounds;pickedEpisode=$pickedEpisode} | ConvertTo-Json -Compress"
    ].join(" ");
    const ps = await this.runPowerShell(script, { timeoutMs: legacyLimit + 4000 });
    let parsed = null;
    try { parsed = JSON.parse(ps.stdout || "null"); } catch { parsed = null; }
    return {
      found: Boolean(parsed?.found),
      invoked: Boolean(parsed?.invoked),
      name: parsed?.name ?? null,
      matchedLabel: parsed?.matchedLabel ?? null,
      matchedBounds: parsed?.matchedBounds ?? null,
      pickedEpisode: parsed?.pickedEpisode === true,
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

  // A complete calculator expression is a single bounded UI transaction.  The
  // previous adaptive path located and clicked every key independently, paying
  // UI inspection and model latency between each digit.  Calculator natively
  // supports keyboard input, so use that advertised interaction surface and
  // then read the display back from UI Automation.
  async calculateWithUi(expression, expectedResult) {
    const normalized = String(expression ?? "").trim();
    if (!/^\d+(?:\.\d+)?(?:[+*/-]\d+(?:\.\d+)?)+$/.test(normalized)) {
      throw new Error("A bounded arithmetic expression is required");
    }
    const launch = await this.launchApplication("calculator");
    const windowId = launch?.windowIdentity?.windowId ?? launch?.window?.WindowHandle ?? null;
    if (!windowId) return { performed: false, reason: "calculator-window-not-ready", expression: normalized, launch };
    // SendKeys treats + as a modifier unless braced; all remaining admitted
    // characters are literal Calculator keys. Escape first clears stale state.
    const keys = `{ESC}${normalized.replace(/\+/g, "{+}")}{ENTER}`;
    const input = await this.keyboardAction("press", { application: "calculator", windowId: String(windowId), keys });
    const expected = String(expectedResult ?? "").trim();
    const compactNumber = (value) => String(value ?? "").replace(/[,\s]/g, "");
    const deadline = Date.now() + 1500;
    let inspected = { elements: [] };
    let visible = [];
    let matched = false;
    do {
      inspected = await this.inspectUi({ application: "calculator", windowId: String(windowId), maxElements: 160 });
      visible = (inspected.elements ?? []).map((element) => String(element.name ?? element.value ?? "")).filter(Boolean);
      matched = Boolean(expected && visible.some((value) => compactNumber(value).includes(compactNumber(expected))));
      if (matched || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return {
      performed: input?.performed === true,
      expression: normalized,
      expectedResult: expected,
      matched,
      visibleResult: visible.find((value) => compactNumber(value).includes(compactNumber(expected))) ?? null,
      windowId: String(windowId),
      input,
      launch,
      inspected
    };
  }

  async _readApplicationOcr(application, windowId) {
    const captured = await this.captureScreen({ application, windowId: String(windowId) });
    if (!captured?.captured || !captured.path) {
      return { readable: false, text: "", targets: [], captured };
    }
    const bounds = captured.bounds ?? {};
    const ocr = await this.readOcr({
      path: captured.path,
      windowId: String(windowId),
      originX: Number(bounds.x ?? 0),
      originY: Number(bounds.y ?? 0)
    });
    return {
      readable: true,
      text: String(ocr?.text ?? ocr?.ocrText ?? ""),
      targets: ocr?.targets ?? [],
      captured,
      ocr
    };
  }

  // Drafting is intentionally NOT sending. WhatsApp's WebView exposes only its
  // title-bar controls to Windows UIA, which made a generic controller repeatedly
  // choose Minimize/Restore. The app's own Ctrl+K search shortcut avoids that
  // opaque tree entirely, keeps one pinned window foregrounded, and never emits
  // Enter after the message text has been inserted.
  async draftWhatsAppMessage(contact, message) {
    const recipient = String(contact ?? "").trim();
    const body = String(message ?? "");
    if (!recipient || !body.trim()) throw new Error("A WhatsApp contact and non-empty draft are required");
    const launch = await this.launchApplication("whatsapp");
    const windowId = launch?.windowIdentity?.windowId ?? launch?.window?.WindowHandle ?? null;
    if (!windowId) return { performed: false, drafted: false, sent: false, reason: "whatsapp-window-not-ready", launch };
    const pinned = { application: "whatsapp", windowId: String(windowId) };
    await this.manageWindow("activate", pinned);
    const compact = (value) => String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const clickOcrTarget = async (target) => {
      const bounds = target?.boundingRect ?? target?.bounds;
      if (!bounds || !["x", "y", "width", "height"].every((key) => Number.isFinite(Number(bounds[key])))) {
        return { performed: false, reason: "ocr-target-has-no-bounds" };
      }
      return this.pointerAction("click", {
        ...pinned,
        x: Math.round(Number(bounds.x) + Number(bounds.width) / 2),
        y: Math.round(Number(bounds.y) + Number(bounds.height) / 2),
        button: "left"
      });
    };

    // The installed WhatsApp WebView does not implement Ctrl+K. Ground the
    // visible search field through a fresh OCR observation instead. Pointer
    // input is tied to that exact window and observed rectangle; there is no
    // fixed screen coordinate or minimize/maximize probing.
    const initialScreen = await this._readApplicationOcr("whatsapp", windowId);
    const initialTargets = initialScreen.targets ?? [];
    // If the requested chat is already visible, use the freshly observed row
    // directly. The old implementation refused to continue unless a textual
    // Search label was visible, even though the current WhatsApp build often
    // presents Search as an icon while the desired chat row is plain OCR text.
    let contactTarget = initialTargets
      .filter((target) => compact(target?.name ?? target?.text) === compact(recipient))
      .sort((left, right) => Number(left?.boundingRect?.y ?? 0) - Number(right?.boundingRect?.y ?? 0))
      .find((target) => Number(target?.boundingRect?.width ?? 0) > 0 && Number(target?.boundingRect?.height ?? 0) > 0);
    let searchOpened = null;
    let contactTyped = null;
    if (!contactTarget) {
      const searchTarget = initialTargets
        .filter((target) => /search/i.test(String(target?.name ?? target?.text ?? "")))
        .sort((left, right) => {
          const score = (target) => /search.*(?:new\s+chat|chat)/i.test(String(target?.name ?? target?.text ?? "")) ? 1 : 0;
          return score(right) - score(left);
        })[0];
      // Ctrl+F is WhatsApp's local chat-list search fallback. It does not
      // minimize/maximize, move focus to another window, or send anything.
      searchOpened = searchTarget
        ? await clickOcrTarget(searchTarget)
        : await this.keyboardAction("press", { ...pinned, keys: "^f" });
      await this.keyboardAction("press", { ...pinned, keys: "^a" });
      contactTyped = await this.keyboardAction("type", { ...pinned, text: recipient });
      await new Promise((resolve) => setTimeout(resolve, 450));
      const resultsScreen = await this._readApplicationOcr("whatsapp", windowId);
      const searchBottom = searchTarget
        ? Number(searchTarget.boundingRect?.y ?? 0) + Number(searchTarget.boundingRect?.height ?? 0)
        : 0;
      contactTarget = (resultsScreen.targets ?? [])
        .filter((target) => compact(target?.name ?? target?.text) === compact(recipient))
        .sort((left, right) => Number(left?.boundingRect?.y ?? 0) - Number(right?.boundingRect?.y ?? 0))
        .find((target) => Number(target?.boundingRect?.y ?? 0) > searchBottom + 10);
    }
    if (!contactTarget) {
      return { performed: false, drafted: false, sent: false, sendInvoked: false, reason: "whatsapp-contact-not-visible", windowId: String(windowId), launch };
    }
    const chatOpened = await clickOcrTarget(contactTarget);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const chatScreen = await this._readApplicationOcr("whatsapp", windowId);
    const composerTarget = (chatScreen.targets ?? []).find((target) =>
      /(?:(?:type|write)\s+(?:a\s+)?message|^message$)/i.test(String(target?.name ?? target?.text ?? "").trim())
    );
    const composerFocused = composerTarget ? await clickOcrTarget(composerTarget) : { performed: true, method: "chat-default-focus" };
    const existingDraftSelected = await this.keyboardAction("press", { ...pinned, keys: "^a" });
    const draftTyped = await this.keyboardAction("type", { ...pinned, text: body });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const screen = await this._readApplicationOcr("whatsapp", windowId).catch((error) => ({ readable: false, text: "", error: error.message }));
    const visible = compact(screen.text);
    const contactVisible = visible.includes(compact(recipient));
    const messageTokens = [...new Set(compact(body).split(" ").filter((token) => token.length >= 3))];
    const visibleTokens = new Set(visible.split(" ").filter(Boolean));
    const draftCoverage = messageTokens.length
      ? messageTokens.filter((token) => visibleTokens.has(token)).length / messageTokens.length
      : 0;
    // OCR commonly splits a long composer value across runs and drops
    // punctuation/contractions. Full normalized equality is strongest; high
    // unique-token coverage is accepted only in the requested contact's chat.
    const draftVisible = visible.includes(compact(body)) || (contactVisible && draftCoverage >= 0.8);
    return {
      performed: draftTyped?.performed === true,
      drafted: draftTyped?.performed === true && (draftVisible || screen.readable === false),
      sent: false,
      sendInvoked: false,
      contact: recipient,
      message: body,
      contactVisible,
      draftVisible,
      windowId: String(windowId),
      steps: { searchOpened, contactTyped, chatOpened, composerFocused, existingDraftSelected, draftTyped },
      screen: {
        readable: screen.readable === true,
        contactVisible,
        draftVisible,
        draftCoverage: Number(draftCoverage.toFixed(3)),
        composerGrounded: Boolean(composerTarget),
        targetCount: (screen.targets ?? []).length
      },
      launch
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
      "$activate={param($el);try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern);$pattern.Invoke();return $true}catch{};try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern);$pattern.Expand();return $true}catch{};try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern);$pattern.DoDefaultAction();return $true}catch{};try{$pattern=$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern);$pattern.Select();return $true}catch{};try{$b=$el.Current.BoundingRectangle;if($b.Width-gt 0-and$b.Height-gt 0){[void][SyscoraSpotifyMouse]::SetCursorPos([int]($b.X+$b.Width/2),[int]($b.Y+$b.Height/2));[SyscoraSpotifyMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[SyscoraSpotifyMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);return $true}}catch{};return $false};",
      "$display=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($query.ToLower());$variants=@($display);foreach($digraph in @('t','d','k','g','p','b','c','s')){for($i=0;$i-lt$query.Length;$i++){if($query[$i]-eq$digraph){$variants+=[cultureinfo]::InvariantCulture.TextInfo.ToTitleCase($query.ToLower().Insert($i+1,'h'))}}};",
      "$label=$null;foreach($variant in $variants){$cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$variant);$label=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond);if($label){break}};",
      "$buttonCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button);$option=$null;",
      "if($label){$ancestor=$label;for($depth=0;$depth-lt 5;$depth++){$ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor);if(-not$ancestor){break};$buttons=$ancestor.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCond);foreach($button in $buttons){if($button.Current.Name-like'More options for *'-and(&$matches $button.Current.Name)){$option=$button;break}};if($option){break}}};",
      // Spotify often exposes only one compound accessibility button such as
      // "More options for Cry For Me by ..." and no exact title label. Search
      // those buttons directly before declaring that the track was absent.
      "if(-not$option){$buttons=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCond);foreach($button in $buttons){try{$name=$button.Current.Name;if(-not$button.Current.IsOffscreen-and$button.Current.IsEnabled-and$name-like'More options*'-and(&$matches $name)){$option=$button;break}}catch{}}};",
      "if(-not$option){[pscustomobject]@{found=$false;invoked=$false;reason='matching-track-options-not-found'}|ConvertTo-Json -Compress;return};",
      "if(-not(&$activate $option)){[pscustomobject]@{found=$true;invoked=$false;reason='track-options-not-opened'}|ConvertTo-Json -Compress;return};Start-Sleep -Milliseconds 350;",
      // Chromium context menus may be hosted in a top-level popup outside the
      // Spotify HWND subtree. Query the desktop UIA root after opening it.
      "$queueName=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Add to queue');$desktop=[System.Windows.Automation.AutomationElement]::RootElement;$queue=$desktop.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$queueName);$queueNames=@();if(-not $queue){$desktopAll=$desktop.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);foreach($candidate in $desktopAll){try{$candidateName=[string]$candidate.Current.Name;if($candidateName -like '*queue*'){$queueNames+=$candidateName};if((-not $queue) -and $candidateName -like '*Add to queue*' -and (-not $candidate.Current.IsOffscreen) -and $candidate.Current.IsEnabled){$queue=$candidate}}catch{}}};if(-not $queue){[pscustomobject]@{found=$true;invoked=$false;reason='add-to-queue-control-not-found';menuNames=@($queueNames|Select-Object -Unique -First 20)}|ConvertTo-Json -Compress;return};",
      "$invoked=&$activate $queue;$matched=if($label){$label.Current.Name}else{$option.Current.Name};[pscustomobject]@{found=$true;invoked=$invoked;matchedLabel=$matched;optionName=$option.Current.Name}|ConvertTo-Json -Compress"
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
    const encodedTokens = Buffer.from(JSON.stringify(spotifyQueryTokens(text)), "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]" + Number(handle) + ");",
      "$queueCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Queue');$queue=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$queueCond);if($queue){try{$qp=$queue.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern);if($qp.Current.ToggleState-eq[System.Windows.Automation.ToggleState]::Off){$qp.Toggle()}}catch{}};Start-Sleep -Milliseconds 300;",
      `$query=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'));$tokens=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTokens}'))|ConvertFrom-Json);`,
      "$rb=$root.Current.BoundingRectangle;$match=$null;$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);foreach($label in $all){try{$name=[string]$label.Current.Name;$b=$label.Current.BoundingRectangle;if($label.Current.IsOffscreen -or $b.X -lt ($rb.X+($rb.Width*0.55))){continue};$words=@($name.ToLower() -split '[^a-z0-9]+' | Where-Object{$_});$ok=$true;foreach($token in @($tokens)){if($words -notcontains [string]$token){$ok=$false;break}};if($ok){$match=$label;break}}catch{}};[pscustomobject]@{queued=[bool]$match;evidence=if($match){$match.Current.Name}else{$null}}|ConvertTo-Json -Compress"
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
  /**
   * The control that has the keyboard right now, and what it holds.
   *
   * Null when there is no host to ask — which the caller must read as "could not
   * check", never as "the box is empty". `publishesValue` false says the control
   * has no ValuePattern at all, which is a third answer again: it will never
   * tell us what is in it, so no number of retries will help.
   */
  async focusedElement({ windowId = null } = {}) {
    if (!this.automationHost) return null;
    try {
      const focused = await this.hostRequest("ui.focused", { windowId }, { timeoutMs: 4000 });
      return focused?.found ? focused : null;
    } catch {
      return null;
    }
  }

  /**
   * Press a named control through UIA, with no mouse involved.
   *
   * Returns `{ performed: false, reason }` rather than throwing whenever this is
   * not the right way to press this thing — no such name, no InvokePattern, two
   * controls answering to it — so the caller can fall back to a real click
   * without having to know why.
   */
  async invokeControl({ windowId = null, name = null, x = null, y = null } = {}) {
    if (!this.automationHost || !windowId || !name) return { performed: false, reason: "unavailable" };
    try {
      return await this.hostRequest("ui.invoke", { windowId: String(windowId), name, x, y }, { timeoutMs: 6000 });
    } catch (error) {
      return { performed: false, reason: "host-error", detail: error?.message };
    }
  }

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
    // Inspecting "WhatsApp" must not walk a Notepad document that happens to be
    // named after the task. One rule for what belongs to an application.
    const selected = needle
      ? windows.filter((w) => applicationWindowScore(w, needle) > 0)
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
    // Acting on a control inside "WhatsApp" must never land in another
    // application whose title merely mentions it.
    const window = windows
      .map((candidate) => ({ candidate, score: applicationWindowScore(candidate, needle) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.candidate;
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

  // The one window the user is looking at, without describing every other one.
  // Returns null when the host cannot answer, so callers fall back to filtering
  // listWindows() and nothing depends on this being available.
  async getForegroundWindow() {
    if (!this.automationHost) return null;
    try {
      const result = await this.hostRequest("window.foreground", {}, { timeoutMs: 4000 });
      return result?.window ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Wait locally for the foreground window to become observably different.
   * This is used after fire-and-forget OS hand-offs such as opening a URL. It
   * returns as soon as Windows exposes the new handle/title, with a short
   * adaptive poll because there is no model decision inside this loop.
   */
  async waitForForegroundChange(before = null, timeoutMs = 2500) {
    const deadline = Date.now() + clampInt(timeoutMs, 50, 10000, 2500);
    const beforeId = String(before?.windowId ?? before?.WindowHandle ?? "");
    const beforeTitle = String(before?.title ?? before?.MainWindowTitle ?? "");
    let polls = 0;
    let current = null;
    while (Date.now() < deadline) {
      polls += 1;
      current = await this.getForegroundWindow();
      const currentId = String(current?.windowId ?? current?.WindowHandle ?? "");
      const currentTitle = String(current?.title ?? current?.MainWindowTitle ?? "");
      if (current && (currentId !== beforeId || currentTitle !== beforeTitle)) {
        return { changed: true, window: current, polls };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(125, 40 + polls * 10)));
    }
    return { changed: false, window: current ?? await this.getForegroundWindow(), polls, reason: "foreground-wait-timeout" };
  }

  /**
   * Every live process as processId -> parentProcessId.
   *
   * Exists for one question: which window really belongs to an application. An
   * application's frame window and the Chromium window holding its interface
   * share no handle, no parent window and no owner — only this. See
   * `pickWebviewWindow`.
   *
   * Returns an empty Map rather than throwing when nothing can answer, because
   * every caller's fallback is "then treat the frame as the application", which
   * is exactly the old behaviour and never worse than it.
   */
  async listProcessParents() {
    if (this.automationHost) {
      try {
        const result = await this.hostRequest("process.parents", {}, { timeoutMs: 6000 });
        const parents = new Map();
        for (const row of result?.processes ?? []) {
          const pid = Number(row.processId);
          const parent = Number(row.parentProcessId);
          if (Number.isFinite(pid) && Number.isFinite(parent)) parents.set(pid, parent);
        }
        if (parents.size > 0) return parents;
      } catch {
        // Fall through: a host that cannot answer is a missed optimisation, not
        // a failure of the reading that asked.
      }
    }
    try {
      const ps = await this.runPowerShell(
        "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | " +
        "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
        { timeoutMs: 8000 }
      );
      const parents = new Map();
      for (const line of String(ps.stdout ?? "").split(/\r?\n/)) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (Number.isFinite(pid) && Number.isFinite(parent)) parents.set(pid, parent);
      }
      return parents;
    } catch {
      return new Map();
    }
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

  /**
   * A typed, bounded UI readiness predicate executed wholly inside the local
   * automation runtime. The persistent host wakes on UIA structure/property
   * events and rechecks the selector, with an adaptive poll fallback for sparse
   * Chromium providers. No screen frames or model calls are involved.
   */
  async waitForUiTarget({ application = null, windowId = null, selector = {}, condition = "present", timeoutMs = 5000 } = {}) {
    const bounded = clampInt(timeoutMs, 50, 20000, 5000);
    if (this.automationHost) {
      return this.hostRequest("ui.wait", {
        application,
        windowId,
        selector,
        condition,
        timeoutMs: bounded
      }, { timeoutMs: bounded + 2000 });
    }
    return { matched: false, reason: "automation-host-unavailable", polls: 0 };
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

  /**
   * Deliver one or more continuous strokes.
   *
   * The path is sent as base64 little-endian Int32 pairs rather than as a JSON
   * array. A detailed figure is thousands of numbers and the host's JSON parser
   * boxes every one of them, which measured at roughly a fifth of the total cost
   * of drawing a circle; a block copy costs nothing at any length.
   *
   * The timeout is derived from the work rather than fixed. A five-second
   * ceiling is right for a click and wrong for a stroke the caller deliberately
   * asked to take four seconds — and a stroke that times out is not merely a
   * failed request. It abandons the host mid-path, which is why the host
   * releases the button in a finally block and why the deadline here is
   * generous enough that it should never be reached.
   */
  async pointerStroke({ paths, pacingMicros = 250, ...params } = {}) {
    const encode = (flat) => Buffer.from(Int32Array.from(flat).buffer).toString("base64");
    const list = (paths ?? []).filter((path) => Array.isArray(path) && path.length >= 4);
    if (list.length === 0) throw new Error("A stroke needs at least one path of two or more points.");
    const points = list.reduce((total, path) => total + path.length / 2, 0);
    // The host's own ceiling on how long it will spend pacing, plus room for the
    // per-point overhead and one round trip.
    const budgetMs = Math.min(20000, Math.ceil((points * pacingMicros) / 1000)) + points * 2 + 5000;
    return this.hostRequest(
      "pointer.stroke",
      { ...params, pacingMicros, pathsBase64: list.map(encode) },
      { timeoutMs: Math.min(60000, budgetMs) }
    );
  }

  async keyboardAction(operation, params = {}) {
    return this.hostRequest(
      `keyboard.${operation}`,
      // `chord` carries the combination as a person wrote it, so the host can
      // press and release the keys itself; `keys` carries the SendKeys spelling
      // for the notation this cannot parse. Both travel, and the host prefers
      // the first.
      operation === "press"
        ? { ...params, keys: normalizeSendKeys(params.keys), chord: chordSpec(params.keys) }
        : params,
      { timeoutMs: operation === "type" ? 20000 : 5000 }
    );
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

  // TYPING A DOCUMENT, NOT PERFORMING IT AS KEYSTROKES.
  //
  // This used to push both the content and the destination path through
  // SendKeys, escaped with escapePowerShellSingleQuoted — which escapes for a
  // PowerShell string literal and has nothing to say about SendKeys' own
  // language. So every `{`, `+`, `^`, `%`, `(` and `)` in the text was read as
  // notation: source code, JSON and anything with an emoticon in it arrived
  // mangled, and a Documents folder whose path contains a bracket could not be
  // saved to at all. The file check at the end caught it, which turned silent
  // corruption into a plain failure, but the text still never arrived.
  //
  // Both now go through the host's typing path, which is exact for any content.
  //
  // WRITE IN A NEW DOCUMENT, ALONGSIDE WHATEVER IS ALREADY OPEN.
  //
  // Notepad reuses its running instance, so asking it to open put the text into
  // whichever document happened to be in front — someone's notes, mid-edit. The
  // fix is not to avoid the running Notepad; refusing to work when the
  // application is already in use would be a worse tool. It is to do what a
  // person does: press Ctrl+N for a fresh document and write in that. On Windows
  // 11 that is a new tab in the same window, on the older Notepad a new window,
  // and either way the existing document is untouched and still open.
  async notepadTypeAndSave({ content, filename }) {
    const documents = this.getDocumentsPath();
    const filePath = path.join(documents, filename);
    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Whether Notepad was ALREADY running decides whether a fresh document is
    // needed: a Notepad this call started opens on an empty Untitled one, and an
    // extra Ctrl+N there would just leave a stray blank tab behind.
    const alreadyRunning = (await this.listWindows().catch(() => []))
      .some((window) => /notepad/i.test(String(window.ProcessName ?? "")));
    await this.launchApplication("notepad");
    let commandResult = null;

    if (this.automationHost) {
      try {
        // waitForApplicationWindow returns a listWindows row, whose handle field
        // is WindowHandle. Reading `windowId` off it yields undefined and
        // quietly degrades to matching Notepad by name.
        const found = await this.waitForApplicationWindow("notepad", 8000);
        let handle = found?.window?.WindowHandle ?? found?.window?.windowId ?? null;
        if (alreadyRunning) {
          await settle(600);
          await this.keyboardAction("press", {
            ...(handle ? { windowId: String(handle) } : { application: "notepad" }),
            keys: "ctrl+n"
          });
          // WAIT FOR THE NEW DOCUMENT TO BE READY TO RECEIVE TEXT.
          //
          // A fixed pause after Ctrl+N is not enough and fails in a way that
          // looks like a typing bug rather than a timing one: measured here, the
          // first nine characters of a sixty-character document arrived and the
          // rest were discarded, because the tab was still building its editor
          // and threw away what was already queued for it.
          //
          // A new document is titled "Untitled", so the title says when it is
          // there. The new document may be a tab in the same window or a window
          // of its own, which is the other reason to re-read the handle instead
          // of assuming the one from before Ctrl+N still points at it.
          const readyBy = Date.now() + 8000;
          let front = null;
          while (Date.now() < readyBy) {
            await settle(300);
            front = await this.getForegroundWindow();
            if (front?.windowId
              && /notepad/i.test(String(front.processName ?? ""))
              && /^\*?untitled/i.test(String(front.title ?? ""))) break;
            front = null;
          }
          if (!front) throw new Error("Notepad did not open a new document to write in");
          handle = front.windowId;
          // The title appears a moment before the editor will keep what it is
          // given; this is the settle that the readiness check cannot replace.
          await settle(700);
        }
        const target = handle ? { windowId: String(handle) } : { application: "notepad" };
        await settle(600);

        // TYPE, THEN CHECK IT WENT IN — AND TYPE AGAIN IF IT DID NOT.
        //
        // A freshly created tab accepts keystrokes before it is ready to keep
        // them. Measured here, across runs that were otherwise identical: the
        // whole document arrived, or the first nine characters of it did, or
        // nothing did and an empty file was saved and reported as written. The
        // keystrokes were delivered every time — Windows accepted every event —
        // so nothing downstream could tell the difference.
        //
        // Notepad titles an unsaved document with a leading asterisk and its
        // first line, so the title says whether anything landed. That is the
        // cheap check that turns an unreliable step into a reliable one.
        const documentHasText = async () => {
          const front = await this.getForegroundWindow();
          return /^\*/.test(String(front?.title ?? ""));
        };
        let typedIn = false;
        for (let attempt = 0; attempt < 3 && !typedIn; attempt += 1) {
          await this.keyboardAction("type", { ...target, text: String(content ?? "") });
          const settledBy = Date.now() + 2500;
          while (Date.now() < settledBy && !typedIn) {
            await settle(300);
            typedIn = await documentHasText();
          }
          // Anything a half-written attempt left behind must go, or the retry
          // appends to it and the document ends up with the text twice.
          //
          // Select-all-and-delete is the most destructive keystroke pair in this
          // file, so it is fenced: it only ever runs against a document that is
          // still called Untitled, which is the one this call created moments
          // ago. If the window in front is anything else — the user clicked away,
          // the handle was wrong — the retry is abandoned rather than risk
          // emptying a document somebody was working on.
          if (!typedIn) {
            const front = await this.getForegroundWindow();
            if (!/^\*?untitled/i.test(String(front?.title ?? ""))) {
              throw new Error("the document in front is no longer the new one; refusing to clear it");
            }
            await this.keyboardAction("press", { ...target, keys: "ctrl+a" });
            await settle(150);
            await this.keyboardAction("press", { ...target, keys: "{DEL}" });
            await settle(300);
          }
        }
        if (!typedIn) throw new Error("the text did not reach the new Notepad document");
        await settle(400);
        // WAIT FOR THE SAVE DIALOG THIS CTRL+S OPENED — not for any Save dialog.
        //
        // Two separate mistakes are being avoided here. A fixed pause is how the
        // path ends up typed into the document instead of into the filename box:
        // if the dialog is a beat late, the keystrokes land wherever focus still
        // is. And matching any dialog that happens to be open is how a stale one
        // left over from an earlier attempt gets typed into instead — which is
        // exactly what made this fail intermittently while it was being built.
        // So: note which dialogs exist first, then wait for one that is new.
        const isSaveDialog = (window) => String(window.ClassName ?? window.className ?? "") === "#32770"
          && /save/i.test(String(window.MainWindowTitle ?? window.title ?? ""));
        const dialogsBefore = new Set((await this.listWindows().catch(() => []))
          .filter(isSaveDialog).map((window) => String(window.WindowHandle ?? window.windowId)));
        await this.keyboardAction("press", { ...target, keys: "ctrl+s" });
        let dialog = null;
        const dialogDeadline = Date.now() + 8000;
        while (Date.now() < dialogDeadline && !dialog) {
          await settle(300);
          dialog = (await this.listWindows().catch(() => []))
            .find((window) => isSaveDialog(window)
              && !dialogsBefore.has(String(window.WindowHandle ?? window.windowId))) ?? null;
        }
        if (!dialog) throw new Error("the Save dialog did not appear, so nothing was typed into it");
        const dialogHandle = dialog.WindowHandle ?? dialog.windowId;
        await this.keyboardAction("type", {
          ...(dialogHandle ? { windowId: String(dialogHandle) } : {}),
          text: filePath
        });
        await settle(400);
        await this.keyboardAction("press", { keys: "enter" });
        await settle(900);
        commandResult = { host: "persistent" };
      } catch (error) {
        commandResult = { host: "persistent", failed: true, reason: error.message };
      }
    }

    if (!commandResult || commandResult.failed) {
      // No host. The clipboard is still exact, so the fallback borrows it rather
      // than reaching for SendKeys' notation again; only the two control keys
      // are keystrokes, and those have no text to corrupt.
      const escapedContent = escapePowerShellSingleQuoted(content);
      const escapedPath = escapePowerShellSingleQuoted(filePath);
      commandResult = await this.runPowerShell(
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$wshell = New-Object -ComObject WScript.Shell; ` +
        `Start-Sleep -Milliseconds 800; ` +
        `if (-not $wshell.AppActivate('Notepad')) { throw 'Notepad window not found' }; ` +
        `Start-Sleep -Milliseconds 400; ` +
        `[System.Windows.Forms.Clipboard]::SetText('${escapedContent}'); ` +
        `Start-Sleep -Milliseconds 200; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('^v'); ` +
        `Start-Sleep -Milliseconds 400; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('^s'); ` +
        `Start-Sleep -Milliseconds 1200; ` +
        `[System.Windows.Forms.Clipboard]::SetText('${escapedPath}'); ` +
        `Start-Sleep -Milliseconds 200; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('^v'); ` +
        `Start-Sleep -Milliseconds 400; ` +
        `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); ` +
        `Start-Sleep -Milliseconds 800; ` +
        `'saved'`,
        { timeoutMs: 45000 }
      );
    }

    const verify = await this.verifyFileContains(filePath, content);
    return { filePath, content, commandResult, verification: verify };
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
