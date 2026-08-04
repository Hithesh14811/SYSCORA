import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const hostDirectory = path.dirname(fileURLToPath(import.meta.url));
const elevatedScript = path.resolve(hostDirectory, "..", "elevated-host.ps1");
const defaultSchemaPath = path.resolve(
  hostDirectory, "..", "..", "..",
  "packages", "privileged-helpers", "schema", "elevated-operations.v1.json"
);

// Must agree with packages/permission-broker/src/elevation-grant-store.js. The
// review found the client applied only a 30-second MINIMUM, so a caller asking
// for a year got a year at the host even though the grant store capped the
// record at 8 hours. The cap is enforced here as well as there, because a
// disagreement between the two is exactly the kind of drift that turns into a
// privilege that outlives its justification.
export const MAX_HOST_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MIN_HOST_LIFETIME_MS = 30 * 1000;

export const ELEVATED_HOST_PROTOCOL = "syscora-elevated-host/2";
export const ELEVATED_HOST_SCRIPT = elevatedScript;
export const ELEVATED_OPERATION_SCHEMA_PATH = defaultSchemaPath;

/**
 * Wait for a specific OS process to actually exit.
 *
 * The review's sharpest finding about teardown was that the daemon reported a
 * clean shutdown based on its own socket state, which says nothing about
 * whether the high-integrity process died. This is the real check. The recorded
 * start time guards against PID reuse: a live process under the same id with a
 * different start time is a different process, so the original one is gone.
 *
 * Returns { exited, reason }.
 */
export async function waitForProcessExit(processId, { timeoutMs = 10000, startTimeIso = null } = {}) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return { exited: true, reason: "no-pid-recorded" };
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$deadline=(Get-Date).AddMilliseconds(${Math.max(0, Math.floor(timeoutMs))});`,
    "while($true){",
    `  $p = Get-Process -Id ${processId} -ErrorAction SilentlyContinue;`,
    "  if (-not $p) { exit 0 }",
    startTimeIso
      ? `  try { if ($p.StartTime.ToUniversalTime().ToString('o') -ne '${startTimeIso}') { exit 0 } } catch { }`
      : "",
    "  if ((Get-Date) -ge $deadline) { exit 3 }",
    "  Start-Sleep -Milliseconds 150",
    "}"
  ].filter(Boolean).join(" ");

  const exitCode = await new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script
    ], { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(-1));
    child.once("exit", (code) => resolve(code));
  });

  if (exitCode === 0) return { exited: true, reason: "process-gone" };
  if (exitCode === 3) return { exited: false, reason: "process-still-running" };
  return { exited: false, reason: `process-check-failed (exit ${exitCode})` };
}

/** Is this OS process currently running? Used by tests and by teardown audit. */
export async function isProcessAlive(processId) {
  const result = await waitForProcessExit(processId, { timeoutMs: 0 });
  return !result.exited;
}

/**
 * Client for the elevated operation host.
 *
 * Elevation model, stated plainly:
 *   - Raising integrity level on Windows requires the OS to consent. That is
 *     the UAC prompt, shown by `Start-Process -Verb RunAs`. SYSCORA cannot and
 *     does not suppress it; bypassing UAC is privilege escalation, not a
 *     feature.
 *   - The prompt is paid ONCE per elevated session. The resulting high-integrity
 *     host is then reused for the grant's lifetime, which is what makes
 *     elevation session-scoped rather than per-action.
 *   - The host exits on its own deadline, so an elevated process cannot outlive
 *     the grant that justified it even if the daemon crashes.
 *
 * PIPE SECURITY -- what is enforced and why (this was an explicit review item).
 * Node's `net.createServer().listen('\\\\.\\pipe\\name')` offers no way to
 * attach a Windows security descriptor, so the pipe carries the default DACL:
 * reachable by the same user (which is required, since the elevated host is the
 * same user at high integrity) but also by any other same-user process. A
 * native addon or P/Invoke helper could narrow that to a single SID, but it
 * would still not distinguish the real host from another same-user process, so
 * it is defence in depth rather than the control. The controls that actually
 * decide authority are therefore:
 *   1. The host verifies the pipe's SERVER process id equals the daemon pid it
 *      was launched with, so it will not hand a handshake to a squatter.
 *   2. Authentication is challenge-response over a secret that never crosses
 *      the wire, and every request carries a MAC bound to a strictly increasing
 *      sequence number, so possession of the pipe grants nothing.
 *   3. The listener is held for the WHOLE session and released only after the
 *      elevated process is confirmed dead, so the name cannot be squatted in
 *      the window between revocation and process exit.
 */
export class ElevatedHostClient {
  constructor({
    lifetimeMs = 15 * 60 * 1000,
    requestTimeoutMs = 120000,
    schemaPath = defaultSchemaPath,
    teardownTimeoutMs = 15000,
    connectTimeoutMs = 90000,
    onSecurityEvent = null,
    // Whether the launched host must prove it holds administrator rights.
    // TRUE in every shipped path. It exists as a flag only so the protocol
    // tests can drive the real host process at medium integrity, where a UAC
    // prompt is impossible; it grants nothing, because a medium-integrity host
    // simply fails every operation that actually needs admin rights.
    requireElevated = true
  } = {}) {
    this.lifetimeMs = lifetimeMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.schemaPath = schemaPath;
    this.teardownTimeoutMs = teardownTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requireElevated = requireElevated !== false;
    // Optional sink for events that a security reviewer needs to see even when
    // nothing threw: rejected peers, failed teardown, protocol violations.
    this.onSecurityEvent = onSecurityEvent;

    this.pipeName = null;
    this.socket = null;
    this.server = null;
    this.rl = null;
    this.hostPid = null;
    this.hostStartTime = null;
    this.hostElevated = false;
    this.pending = new Map();
    this.startedAt = null;
    this.expiresAt = null;
    this.launching = null;
    this.sequence = 0;

    this._secret = null;
    this._nonce = null;
    this._startedMono = null;
    this._effectiveLifetimeMs = null;
    // Once revoked, this client is permanently unusable. It is not reset by a
    // later start(): a revoked session must not be resumable.
    this.revoked = false;
    // Set when teardown could not prove the elevated process exited. The
    // listener is deliberately retained in this state.
    this.quarantined = false;
    this.teardownFailure = null;
  }

  get active() {
    return Boolean(this.socket) && !this.expired && !this.revoked;
  }

  /**
   * Monotonic expiry. `Date.now()` can move backwards across a clock change or
   * a DST/NTP correction, which would extend a live elevation grant.
   */
  get expired() {
    if (this._startedMono == null || this._effectiveLifetimeMs == null) {
      return this.expiresAt != null && Date.now() >= this.expiresAt;
    }
    return performance.now() - this._startedMono >= this._effectiveLifetimeMs;
  }

  get remainingMs() {
    if (this._startedMono == null) return 0;
    return Math.max(0, this._effectiveLifetimeMs - (performance.now() - this._startedMono));
  }

  _emit(event, detail) {
    try { this.onSecurityEvent?.(event, detail); } catch { /* never let a sink break teardown */ }
  }

  _hmac(message) {
    if (!this._secret) throw new Error("The elevated host session has no active secret.");
    return crypto.createHmac("sha256", this._secret).update(message, "utf8").digest("hex");
  }

  /**
   * Launch the elevated host (raising one UAC prompt) and connect to it.
   * Concurrent callers share a single launch rather than each prompting.
   */
  async start() {
    if (this.revoked) {
      const error = new Error("This elevation session was revoked and cannot be resumed.");
      error.code = "ELEVATION_REVOKED";
      throw error;
    }
    if (this.active) return { started: true, reused: true, expiresAt: new Date(this.expiresAt).toISOString() };
    if (this.launching) return this.launching;
    this.launching = this._launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async _launch() {
    this.pipeName = `syscora-elevated-${crypto.randomUUID()}`;
    this._secret = crypto.randomBytes(32).toString("hex");
    this.sequence = 0;

    // Clamp BEFORE anything downstream sees it. Both bounds, not just the
    // minimum -- an 8-hour ceiling that only the grant store knows about is not
    // a ceiling on the elevated process.
    const requested = Number(this.lifetimeMs);
    const clamped = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, MIN_HOST_LIFETIME_MS), MAX_HOST_LIFETIME_MS)
      : MIN_HOST_LIFETIME_MS;
    this._effectiveLifetimeMs = clamped;
    const lifetimeSeconds = Math.ceil(clamped / 1000);

    // The session secret is passed by FILE PATH, never on a command line. The
    // medium-integrity launcher's command line is readable by any same-user
    // process, so a secret placed there would be disclosed before the elevated
    // host ever starts. The host reads the file once and deletes it.
    const secretDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-elev-"));
    const secretFile = path.join(secretDirectory, "session.secret");
    await fs.writeFile(secretFile, this._secret, { encoding: "utf8", mode: 0o600 });

    // Listen BEFORE elevating, so the elevated host has something to connect
    // to the moment the user accepts the UAC prompt.
    const connected = this._listen();

    const cleanupSecretFile = async () => {
      try { await fs.rm(secretDirectory, { recursive: true, force: true }); } catch { /* host may have removed it */ }
    };

    let launched;
    try {
      launched = await this._spawnElevatedHost({ secretFile, lifetimeSeconds });
    } catch (error) {
      this._stopListening();
      await cleanupSecretFile();
      throw error;
    }
    // Authoritative: captured from the OS at launch, not from the pipe.
    this.hostPid = launched.pid;
    this.hostStartTime = launched.startTime ?? null;

    try {
      await connected;
    } catch (error) {
      this._stopListening();
      await cleanupSecretFile();
      throw error;
    } finally {
      await cleanupSecretFile();
    }

    this.startedAt = Date.now();
    this._startedMono = performance.now();
    this.expiresAt = this.startedAt + clamped;

    const health = await this.request("host.health", {});
    if (this.requireElevated && health?.elevated !== true) {
      await this.shutdown({ reason: "not-elevated" });
      const error = new Error("Elevated host started but is not running with administrator rights.");
      error.code = "ELEVATION_NOT_EFFECTIVE";
      throw error;
    }
    if (health?.protocol !== ELEVATED_HOST_PROTOCOL) {
      await this.shutdown({ reason: "protocol-mismatch" });
      const error = new Error(`Elevated host speaks ${health?.protocol}, expected ${ELEVATED_HOST_PROTOCOL}.`);
      error.code = "ELEVATION_PROTOCOL_MISMATCH";
      throw error;
    }
    return {
      started: true,
      reused: false,
      pid: this.hostPid,
      hostReportedPid: health.pid ?? null,
      lifetimeMs: clamped,
      expiresAt: new Date(this.expiresAt).toISOString()
    };
  }

  /**
   * Raise the UAC prompt and start the high-integrity host.
   *
   * Returns { pid, startTime } captured FROM THE OS. `Start-Process -PassThru`
   * is the only way to learn the real pid, because Windows re-parents the
   * elevated child so it is not a child of this process. A pid self-reported
   * over the pipe would be worthless — an impostor would simply report the
   * right number — and every teardown check depends on this one being true.
   *
   * Overridable so the protocol tests can drive the same host script at medium
   * integrity; every shipped caller uses this implementation.
   */
  async _spawnElevatedHost({ secretFile, lifetimeSeconds }) {
    const psArgument = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const launchCommand = [
      "$ErrorActionPreference='Stop';",
      "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList",
      "@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',",
      `${psArgument(elevatedScript)},`,
      `'-PipeName',${psArgument(this.pipeName)},`,
      `'-SecretFile',${psArgument(secretFile)},`,
      `'-DaemonPid','${process.pid}',`,
      `'-LifetimeSeconds','${lifetimeSeconds}',`,
      `'-SchemaFile',${psArgument(this.schemaPath)});`,
      "Write-Output ('SYSCORA_ELEVATED_PID=' + $p.Id);",
      "try { Write-Output ('SYSCORA_ELEVATED_START=' + $p.StartTime.ToUniversalTime().ToString('o')) } catch { }"
    ].join(" ");

    const launcher = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", launchCommand
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let launchOutput = "";
    let launchError = "";
    launcher.stdout.on("data", (chunk) => { launchOutput = `${launchOutput}${chunk}`.slice(-4000); });
    launcher.stderr.on("data", (chunk) => { launchError = `${launchError}${chunk}`.slice(-4000); });
    const launchExit = await new Promise((resolve) => launcher.once("exit", resolve));

    if (launchExit !== 0) {
      // The overwhelmingly common cause is the user declining the UAC prompt.
      const declined = /cancell?ed by the user|operation was canceled/i.test(launchError);
      const error = new Error(
        declined
          ? "Elevation was declined at the Windows UAC prompt."
          : `Elevated host could not be launched: ${launchError.trim() || `exit ${launchExit}`}`
      );
      error.code = declined ? "ELEVATION_DECLINED" : "ELEVATION_LAUNCH_FAILED";
      throw error;
    }

    const pidMatch = /SYSCORA_ELEVATED_PID=(\d+)/.exec(launchOutput);
    if (!pidMatch) {
      const error = new Error("The elevated host was launched but its process id could not be established.");
      error.code = "ELEVATION_PID_UNKNOWN";
      throw error;
    }
    const startMatch = /SYSCORA_ELEVATED_START=(\S+)/.exec(launchOutput);
    return { pid: Number(pidMatch[1]), startTime: startMatch ? startMatch[1] : null };
  }

  /**
   * Host the pipe and complete the mutual handshake.
   *
   * The listener is retained for the entire session rather than closed after
   * the first peer. Releasing the name early is what let a squatter take it
   * over; extra connections are refused instead.
   */
  _listen({ timeoutMs = this.connectTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._stopListening();
        const error = new Error("The elevated host did not connect before the timeout.");
        error.code = "ELEVATION_CONNECT_FAILED";
        reject(error);
      }, timeoutMs);

      this.server = net.createServer((socket) => {
        // A pipe peer can vanish at any moment -- the host exits on its own
        // deadline, and teardown kills it outright. An 'error' event with no
        // listener is an uncaught exception that would take the daemon down,
        // so this is attached before anything else can go wrong.
        socket.on("error", (error) => {
          this._emit("ELEVATION_SOCKET_ERROR", { error: error.message });
        });

        // One elevated host per session. A second connection is not a race to
        // win, it is an anomaly worth recording.
        if (this.socket || settled) {
          this._emit("ELEVATION_PEER_REJECTED", { reason: "session-already-connected" });
          socket.destroy();
          return;
        }
        this._handshake(socket)
          .then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          })
          .catch((error) => {
            this._emit("ELEVATION_PEER_REJECTED", { reason: error.message });
            try { socket.destroy(); } catch { /* already gone */ }
          });
      });
      this.server.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      this.server.listen(`\\\\.\\pipe\\${this.pipeName}`);
    });
  }

  /**
   * Mutual handshake. The host has already checked that WE are the daemon (by
   * pipe server pid) before reaching this point; here we check that IT is the
   * host we launched, without either side transmitting the secret.
   */
  _handshake(socket) {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input: socket });
      const lines = [];
      let stage = "hello";
      const nonce = crypto.randomBytes(32).toString("hex");
      const fail = (reason) => {
        rl.close();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("handshake-timeout"), 30000);

      rl.on("line", (line) => {
        lines.push(line);
        let frame = null;
        try { frame = JSON.parse(line); } catch { return fail("malformed-handshake-frame"); }

        if (stage === "hello") {
          if (frame?.type !== "hello" || frame?.protocol !== ELEVATED_HOST_PROTOCOL) {
            return fail("unexpected-hello");
          }
          // Cross-check the self-reported pid against the pid the OS gave us at
          // launch. This alone proves nothing (an impostor can lie), but a
          // mismatch is conclusive evidence of the wrong peer.
          if (Number(frame.pid) !== Number(this.hostPid)) {
            return fail(`hello-pid-mismatch (expected ${this.hostPid}, got ${frame.pid})`);
          }
          stage = "auth";
          socket.write(`${JSON.stringify({ type: "challenge", nonce })}\n`, "utf8");
          return;
        }

        if (stage === "auth") {
          clearTimeout(timer);
          const expected = this._hmac(`syscora-auth|${nonce}|${this.hostPid}`);
          const offered = String(frame?.proof ?? "");
          const ok = frame?.type === "auth"
            && offered.length === expected.length
            && crypto.timingSafeEqual(Buffer.from(offered, "utf8"), Buffer.from(expected, "utf8"));
          if (!ok) return fail("authentication-failed");

          this._nonce = nonce;
          this.socket = socket;
          this.rl = rl;
          this.hostElevated = frame.elevated === true;
          stage = "ready";
          socket.write(`${JSON.stringify({ type: "authenticated" })}\n`, "utf8");
          rl.on("line", (message) => this._onMessage(message));
          socket.on("close", () => this._onClosed());
          resolve();
          return;
        }
      });
      rl.on("close", () => {
        if (stage !== "ready") {
          clearTimeout(timer);
          reject(new Error("handshake-closed"));
        }
      });
    });
  }

  _stopListening() {
    try { this.server?.close(); } catch { /* already closed */ }
    this.server = null;
  }

  _onMessage(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Elevated operation failed"));
  }

  _onClosed() {
    const error = new Error("The elevated host connection closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = null;
    this.rl = null;
  }

  async request(operation, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.revoked) {
      const error = new Error("This elevation session was revoked.");
      error.code = "ELEVATION_REVOKED";
      throw error;
    }
    if (this.expired) {
      const error = new Error("The elevation grant for this session has expired.");
      error.code = "ELEVATION_EXPIRED";
      throw error;
    }
    if (!this.socket) {
      const error = new Error("The elevated host is not running.");
      error.code = "ELEVATION_NOT_STARTED";
      throw error;
    }
    return this._send(operation, params, timeoutMs);
  }

  _send(operation, params, timeoutMs) {
    const id = crypto.randomUUID();
    const seq = ++this.sequence;
    const paramsJson = JSON.stringify(params ?? {});
    // The MAC covers the sequence number, so a frame captured off this session
    // cannot be replayed into it, and it covers the session nonce, so a frame
    // from a previous session cannot be replayed into a new one.
    const mac = this._hmac(`syscora-request|${this._nonce}|${seq}|${id}|${operation}|${paramsJson}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Elevated operation timed out: ${operation}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, seq, operation, paramsJson, mac })}\n`, "utf8");
    });
  }

  /**
   * Authenticated teardown, verified against the OS.
   *
   * This is the control the review found missing. In order:
   *   1. Tell the host to exit, over the still-authenticated channel.
   *   2. Mark the session revoked so nothing else can be sent or resumed.
   *   3. WAIT for the real process to disappear and confirm it did.
   *   4. Only then release the pipe name.
   *
   * If step 3 fails the pipe name is deliberately NOT released: holding it is
   * the only thing preventing a still-live high-integrity process from being
   * picked up by whoever grabs the name next. The failure is returned and
   * emitted, never reported as a clean teardown.
   */
  async shutdown({ reason = "revoked", timeoutMs = this.teardownTimeoutMs } = {}) {
    const processId = this.hostPid;
    const startTimeIso = this.hostStartTime;
    let shutdownAcknowledged = false;
    let shutdownError = null;

    if (this.socket && this._secret && this._nonce && !this.revoked) {
      try {
        await this._send("host.shutdown", {}, Math.min(5000, timeoutMs));
        shutdownAcknowledged = true;
      } catch (error) {
        shutdownError = error.message;
      }
    }

    // Revoke first, so nothing can be sent while we wait for the exit.
    this.revoked = true;
    try { this.socket?.end(); } catch { /* already gone */ }
    this._onClosed();
    this._secret = null;
    this._nonce = null;
    this.expiresAt = null;
    this._startedMono = null;
    this._effectiveLifetimeMs = null;

    const exit = await waitForProcessExit(processId, { timeoutMs, startTimeIso });

    if (!exit.exited) {
      this.quarantined = true;
      this.teardownFailure = {
        reason: "ELEVATION_TEARDOWN_FAILED",
        detail: exit.reason,
        pid: processId,
        shutdownAcknowledged,
        shutdownError
      };
      // Pipe name intentionally retained -- see the doc comment above.
      this._emit("ELEVATION_TEARDOWN_FAILED", this.teardownFailure);
      return {
        ok: false,
        pid: processId,
        exited: false,
        reason: exit.reason,
        shutdownAcknowledged,
        pipeRetained: true
      };
    }

    this._stopListening();
    this.pipeName = null;
    this._emit("ELEVATION_TEARDOWN_VERIFIED", { pid: processId, reason });
    return { ok: true, pid: processId, exited: true, shutdownAcknowledged, pipeRetained: false };
  }

  /**
   * Synchronous best-effort close, retained for callers that cannot await.
   *
   * It marks the session revoked but CANNOT prove the elevated process exited,
   * so it does not release the pipe name either. Prefer shutdown().
   */
  close() {
    this.revoked = true;
    try { this.socket?.end(); } catch { /* already gone */ }
    this._onClosed();
    this._secret = null;
    this._nonce = null;
    this.expiresAt = null;
    this._startedMono = null;
    this._effectiveLifetimeMs = null;
  }
}
