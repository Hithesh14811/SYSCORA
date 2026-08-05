// EnvironmentModel
//
// A typed, freshness-aware query facade over the live machine. Planning and
// recovery ask it questions ("is this installed?", "which window is its own?",
// "what owns port 3000?") and receive one shape of answer: a resolved value plus
// the provenance needed to decide whether acting on it is still safe.
//
// Three properties matter more than breadth here:
//   1. Resolution, not inference. Every field traces to a probe that ran. A name
//      that does not resolve is reported absent — never inferred from a failed
//      launch or an ungrounded window.
//   2. Separated states. "Not installed", "installed but not running", "running
//      without a window" and "could not be determined" are distinct answers.
//   3. Freshness is explicit. An answer carries when it was observed and how
//      long that observation is good for, so a consequential action can refuse
//      to run on a stale view instead of silently trusting it.

export const Freshness = Object.freeze({
  FRESH: "FRESH",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN"
});

export const Sensitivity = Object.freeze({
  PUBLIC: "PUBLIC",
  INTERNAL: "INTERNAL",
  SENSITIVE: "SENSITIVE"
});

// Default observation lifetimes by entity class. Window and tab state changes
// fastest, installation state slowest.
const DEFAULT_TTL_MS = Object.freeze({
  application: 10_000,
  process: 5_000,
  window: 3_000,
  port: 5_000,
  browserTab: 3_000
});

function windowId(candidate) {
  return String(candidate.WindowHandle ?? candidate.windowId ?? "");
}

function processIdOf(candidate) {
  const value = Number(candidate.Id ?? candidate.processId ?? candidate.OwningProcess);
  return Number.isFinite(value) ? value : null;
}

function processNameOf(candidate) {
  return candidate.ProcessName ?? candidate.processName ?? null;
}

// Windows process names, executables and Start menu entries disagree on
// punctuation and the .exe suffix; compare on the bare stem.
function nameStem(value) {
  return String(value ?? "").toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]+/g, "");
}

export class EnvironmentModel {
  constructor({ adapter, browserAdapter = null, ttlMs = {} } = {}) {
    this.adapter = adapter;
    this.browserAdapter = browserAdapter;
    this.ttlMs = { ...DEFAULT_TTL_MS, ...ttlMs };
  }

  // Run a probe, recording rather than throwing when it is unavailable. A
  // partially observed environment is still useful; a thrown exception is not.
  async _probe(label, degraded, run, fallback) {
    try {
      return await run();
    } catch {
      degraded.push(label);
      return fallback;
    }
  }

  isFresh(answer, maxAgeMs = null) {
    const observedAt = Date.parse(answer?.observedAt ?? "");
    if (!Number.isFinite(observedAt)) return false;
    const limit = Number.isFinite(maxAgeMs) ? maxAgeMs : Number(answer?.ttlMs ?? 0);
    return Date.now() - observedAt <= limit;
  }

  classify(answer, maxAgeMs = null) {
    if (answer?.freshness === Freshness.UNKNOWN) return Freshness.UNKNOWN;
    return this.isFresh(answer, maxAgeMs) ? Freshness.FRESH : Freshness.STALE;
  }

  // application -> installed identity -> process -> window, resolved as a chain.
  async resolveApplication(name) {
    const degraded = [];
    const observedAt = new Date().toISOString();
    const requested = String(name ?? "").trim();

    const resolution = await this._probe("installation", degraded,
      () => this.adapter.resolveApplicationTarget(requested),
      { resolved: false, kind: null, target: null, reason: "RESOLUTION_PROBE_FAILED" });

    const stem = nameStem(requested);
    const targetStem = nameStem(resolution?.target?.split(/[\\/]/).pop());
    const matchesApplication = (candidate) => {
      const candidateStem = nameStem(processNameOf(candidate));
      return candidateStem !== "" && (candidateStem === stem || candidateStem === targetStem);
    };

    const allProcesses = await this._probe("processes", degraded, () => this.adapter.listProcesses(), []);
    const processes = (allProcesses ?? []).filter(matchesApplication).map((candidate) => ({
      processId: processIdOf(candidate),
      processName: processNameOf(candidate),
      executablePath: candidate.Path ?? candidate.path ?? null
    }));
    const processIds = new Set(processes.map((entry) => entry.processId).filter((id) => id !== null));

    const allWindows = await this._probe("windows", degraded, () => this.adapter.listWindows(), []);
    const windows = (allWindows ?? [])
      .filter((candidate) => processIds.has(processIdOf(candidate)) || matchesApplication(candidate))
      .map((candidate) => ({
        windowId: windowId(candidate),
        processId: processIdOf(candidate),
        processName: processNameOf(candidate),
        title: candidate.MainWindowTitle ?? candidate.title ?? ""
      }));

    const installed = resolution?.resolved === true;
    return {
      entity: "application",
      name: requested,
      installed,
      installedIdentity: installed ? { kind: resolution.kind, target: resolution.target } : null,
      // "Installed but not started" is a real state and must not read as absent.
      running: processes.length > 0,
      processes,
      windows,
      reason: installed ? null : (resolution?.reason ?? "NO_INSTALLED_IDENTITY"),
      observedAt,
      ttlMs: this.ttlMs.application,
      freshness: degraded.includes("installation") ? Freshness.UNKNOWN : Freshness.FRESH,
      confidence: degraded.length === 0 ? 1 : 0.6,
      source: "WINDOWS_HOST",
      sensitivity: Sensitivity.INTERNAL,
      degraded
    };
  }

  // process -> listening port, in the direction planning actually asks for it.
  async resolvePort(port) {
    const degraded = [];
    const observedAt = new Date().toISOString();
    const inspection = await this._probe("port", degraded,
      () => this.adapter.inspectPort(Number(port)),
      { port: Number(port), listening: null, status: "INDETERMINATE", connections: [], probe: { ok: false } });

    const determinate = inspection?.status === "LISTENING" || inspection?.status === "NOT_LISTENING";
    const ownerIds = new Set((inspection?.connections ?? [])
      .map((connection) => processIdOf(connection))
      .filter((id) => id !== null));

    let owners = [];
    if (ownerIds.size > 0) {
      const processes = await this._probe("processes", degraded, () => this.adapter.listProcesses(), []);
      owners = [...ownerIds].map((processId) => {
        const match = (processes ?? []).find((candidate) => processIdOf(candidate) === processId);
        return {
          processId,
          processName: processNameOf(match ?? {}),
          executablePath: match?.Path ?? match?.path ?? null
        };
      });
    }

    return {
      entity: "port",
      port: Number(port),
      listening: determinate ? inspection.listening : null,
      status: inspection?.status ?? "INDETERMINATE",
      owners,
      observedAt,
      ttlMs: this.ttlMs.port,
      freshness: determinate ? Freshness.FRESH : Freshness.UNKNOWN,
      confidence: determinate ? 1 : 0,
      source: "WINDOWS_HOST",
      sensitivity: Sensitivity.INTERNAL,
      degraded
    };
  }

  // browser -> tab -> URL. Matching is on observed tab state so a later action
  // can be bound to the exact target that was found.
  async resolveBrowserTab({ urlContains = null, titleContains = null } = {}) {
    const degraded = [];
    const observedAt = new Date().toISOString();
    const targets = await this._probe("browserTabs", degraded,
      () => this.browserAdapter?.listTargets?.() ?? [],
      []);

    const matches = (target) => {
      const url = String(target.url ?? "").toLowerCase();
      const title = String(target.title ?? "").toLowerCase();
      if (urlContains && !url.includes(String(urlContains).toLowerCase())) return false;
      if (titleContains && !title.includes(String(titleContains).toLowerCase())) return false;
      return Boolean(urlContains || titleContains);
    };
    const tab = (targets ?? []).find(matches) ?? null;

    return {
      entity: "browserTab",
      found: Boolean(tab),
      tab,
      candidates: (targets ?? []).length,
      observedAt,
      ttlMs: this.ttlMs.browserTab,
      freshness: degraded.includes("browserTabs") ? Freshness.UNKNOWN : Freshness.FRESH,
      confidence: degraded.length === 0 ? 1 : 0,
      source: "DOM",
      // Tab URLs and titles can expose what the user is doing.
      sensitivity: Sensitivity.SENSITIVE,
      degraded
    };
  }
}
