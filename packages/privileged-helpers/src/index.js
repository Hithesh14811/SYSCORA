// PrivilegedOperationHelper
//
// A bounded privileged execution boundary. It NEVER executes arbitrary shell
// strings and NEVER exposes a general command runner. Only the operations in
// OPERATIONS below are supported, each with:
//   - a strict argument/scope validator (validateScope)
//   - a bounded, cancellable executor (run) that dispatches to explicit adapter
//     methods, never to a shell
//   - a declared time limit
//
// Every execution is gated by a single-use approval token (issued and consumed
// through the PermissionBroker) and is audited by the caller. Execution has two
// modes:
//   - "VALIDATE" (default): perform read-only validation that the operation
//     could run (e.g. the target service exists). No state is mutated. This is
//     the safe default so that an approved token alone never causes a
//     destructive change unless COMMIT is explicitly requested.
//   - "COMMIT": perform the real, bounded mutating operation.

import { createHash } from "node:crypto";

import {
  hostImplementedOperations,
  schemaValidator,
  schemaOperation,
  OPERATION_SCHEMA_VERSION
} from "./operation-schema.js";

export const PrivilegedExecutionMode = Object.freeze({
  VALIDATE: "VALIDATE",
  COMMIT: "COMMIT"
});

// Operations the high-integrity PowerShell host actually implements in its
// closed switch, read from the shared schema. Registering an elevated operation
// that is not in this set produces a helper that would fail at first elevated
// use with "Unknown elevated operation" -- so registration rejects it instead.
const HOST_IMPLEMENTED = new Set(hostImplementedOperations());

// Explicitly-implemented privileged operations. Adding an operation here is the
// ONLY way to make it executable; there is no dynamic/wildcard dispatch.
const OPERATIONS = {
  "service.restart": {
    // scope = the Windows service name. The rule itself lives in the shared
    // schema, so the PowerShell host enforces the identical constraint.
    validateScope: schemaValidator("service.restart"),
    timeoutMs: 30000,
    async run({ adapter, scope, mode, signal }) {
      if (!adapter) {
        return { success: true, mode, operation: "service.restart", scope, reason: "No adapter; boundary approval only." };
      }
      // Always validate the target exists first (bounded, read-only).
      const existence = typeof adapter.serviceExists === "function"
        ? await adapter.serviceExists(scope)
        : { exists: true };
      if (!existence.exists) {
        return { success: false, mode, operation: "service.restart", scope, reason: `Service '${scope}' does not exist.` };
      }
      if (mode === PrivilegedExecutionMode.VALIDATE) {
        return { success: true, mode, operation: "service.restart", scope, reason: `Service '${scope}' exists and is eligible for restart.`, validated: true };
      }
      // COMMIT: perform the real bounded restart.
      const result = await adapter.restartService(scope, { signal, timeoutMs: 30000 });
      const ok = result?.commandResult ? (result.commandResult.exitCode === 0 && !result.commandResult.timedOut && !result.commandResult.cancelled) : true;
      return { success: ok, mode, operation: "service.restart", scope, exitCode: result?.commandResult?.exitCode ?? 0, result, reason: ok ? "Service restarted." : "Service restart failed." };
    }
  },
  "package.install": {
    // scope = the WinGet package id. Rule shared with the elevated host.
    validateScope: schemaValidator("package.install"),
    timeoutMs: 600000,
    async run({ adapter, scope, mode, signal }) {
      if (!adapter) {
        return { success: true, mode, operation: "package.install", scope, reason: "No adapter; boundary approval only." };
      }
      if (mode === PrivilegedExecutionMode.VALIDATE) {
        // Read-only eligibility check: confirm the package manager is present.
        const pm = typeof adapter.inspectPackageManager === "function"
          ? await adapter.inspectPackageManager("winget")
          : { commandResult: { exitCode: 0 } };
        const available = pm?.commandResult ? pm.commandResult.exitCode === 0 : true;
        return { success: available, mode, operation: "package.install", scope, reason: available ? "WinGet is available; package install is eligible." : "WinGet is not available.", validated: available };
      }
      // COMMIT: perform the real bounded install.
      const result = await adapter.wingetInstall(scope, { signal, timeoutMs: 600000 });
      const ok = result ? (result.exitCode === 0 && !result.timedOut && !result.cancelled) : false;
      return { success: ok, mode, operation: "package.install", scope, exitCode: result?.exitCode ?? -1, result, reason: ok ? "Package installed." : "Package install failed." };
    }
  }
};

// Operations that genuinely require administrator rights. These are dispatched
// to the elevated host rather than the ordinary adapter, and are only reachable
// when the session holds an active elevation grant.
//
// This is the "general elevated-action support" surface: it is extensible via
// registerOperation, but it is still a typed allow-list. There is deliberately
// no elevated shell passthrough — an elevated arbitrary-command runner would
// make every other control in SYSCORA decorative.
//
// Every validator here is generated from the shared schema, which the elevated
// host loads and enforces independently. Two hand-written copies of the same
// rules drift; one specification with two enforcements cannot.
const ELEVATED_OPERATIONS = Object.fromEntries(
  hostImplementedOperations()
    .filter((name) => schemaOperation(name).elevated === true)
    .map((name) => [name, {
      requiresElevation: true,
      validateScope: schemaValidator(name),
      timeoutMs: schemaOperation(name).timeoutMs ?? 30000
    }])
);

export class PrivilegedOperationHelper {
  constructor({
    permissionBroker,
    adapter,
    elevatedHost = null,
    elevationGrantStore = null,
    auditRepository = null
  } = {}) {
    this.permissionBroker = permissionBroker;
    this.adapter = adapter;
    // Injected so a build without elevation wiring simply reports elevated
    // operations as unavailable rather than pretending to support them.
    this.elevatedHost = elevatedHost;
    this.elevationGrantStore = elevationGrantStore;
    // Elevated execution is fail-closed on auditability: without somewhere to
    // write the binding record, an elevated action does not run at all.
    this.auditRepository = auditRepository;
    this.operations = { ...OPERATIONS, ...ELEVATED_OPERATIONS };
  }

  /**
   * Extension point for additional elevated operations.
   *
   * Every registration must supply a strict validateScope. An operation without
   * one is rejected outright — "general" elevation support must not become
   * "unvalidated" elevation support.
   *
   * An ELEVATED registration must also correspond to a real case in the host's
   * closed switch. The previous contract accepted any name here and only failed
   * at first elevated use, deep inside a UAC-approved session, with "Unknown
   * elevated operation" — an extension point that looks like it worked and
   * silently does not is worse than one that refuses.
   */
  registerOperation(name, definition) {
    if (!name || typeof name !== "string") throw new Error("registerOperation requires an operation name");
    if (typeof definition?.validateScope !== "function") {
      throw new Error(`registerOperation(${name}) requires a validateScope function`);
    }
    if (definition.requiresElevation !== true && typeof definition.run !== "function") {
      throw new Error(`registerOperation(${name}) requires run() unless it is an elevated operation`);
    }
    if (definition.requiresElevation === true && !HOST_IMPLEMENTED.has(name)) {
      throw new Error(
        `registerOperation(${name}) declares requiresElevation but the elevated host has no implementation for it. `
        + `Add it to the shared schema (elevated-operations.v${OPERATION_SCHEMA_VERSION}.json) and to the host's `
        + `operation switch first. Host-implemented elevated operations: ${[...HOST_IMPLEMENTED].join(", ")}.`
      );
    }
    this.operations[name] = definition;
    return this.operations[name];
  }

  isSupported(operation) {
    return Object.prototype.hasOwnProperty.call(this.operations, operation);
  }

  requiresElevation(operation) {
    return this.operations[operation]?.requiresElevation === true;
  }

  // Operations that need administrator rights AND have an elevation channel
  // wired. Used to report honest availability rather than advertising elevated
  // capabilities on a build that cannot elevate.
  elevatedOperations() {
    return Object.entries(this.operations)
      .filter(([, definition]) => definition.requiresElevation === true)
      .map(([name]) => name);
  }

  // Honest readiness, not mere presence of an object. The runtime reports
  // ELEVATE availability from this, and a helper whose host is null (or whose
  // host has been revoked or left quarantined by a failed teardown) advertises
  // a control it cannot exercise. Execution still fails closed either way, but
  // upstream policy and UI decisions are made from this answer.
  canElevate() {
    if (!this.elevatedHost || !this.elevationGrantStore) return false;
    if (this.elevatedHost.revoked === true) return false;
    if (this.elevatedHost.quarantined === true) return false;
    return true;
  }

  // The bounded operation ids this helper can route + execute. The registry
  // uses this to build its live privileged-operation allow-list, so elevation
  // availability is operation-specific (helper supporting service.restart does
  // NOT imply it supports arbitrary.plugin.adminAction).
  supportedOperations() {
    return Object.keys(this.operations);
  }

  async issueApprovalToken(operation, scope, options = {}) {
    return this.permissionBroker.issuePrivilegeToken({
      sessionId: options.sessionId,
      operation,
      scope,
      approved: options.approved === true
    });
  }

  // Execute a bounded privileged operation.
  //   operation: must be in OPERATIONS (allow-list).
  //   scope: operation-specific target (validated per operation).
  //   options: { token, sessionId, mode }
  async execute(operation, scope, options = {}) {
    const definition = this.operations[operation];
    if (!definition) {
      return {
        success: false,
        reason: `Operation ${operation} is not in the allowed privileged helper list.`
      };
    }

    // Strict argument validation before any token is consumed.
    const scopeCheck = definition.validateScope(scope, options.params ?? {});
    if (!scopeCheck.valid) {
      return { success: false, reason: scopeCheck.reason };
    }

    // Elevation enforcement. An elevated operation requires BOTH an active
    // session-scoped elevation grant covering it AND a live elevated host.
    // Neither implies the other, and absence of either is a hard stop — never
    // a silent downgrade to unelevated execution, which would appear to
    // succeed while doing something different from what was approved.
    if (definition.requiresElevation === true) {
      if (!this.elevatedHost) {
        return {
          success: false,
          operation,
          scope,
          reason: `${operation} requires administrator rights, but no elevation channel is configured.`,
          requiresElevation: true
        };
      }
      const elevation = this.elevationGrantStore
        ? await this.elevationGrantStore.check({ sessionId: options.sessionId, operation })
        : { elevated: false, reason: "No elevation grant store is wired." };
      if (!elevation.elevated) {
        return {
          success: false,
          operation,
          scope,
          reason: elevation.reason ?? "This session is not elevated.",
          requiresElevation: true,
          requiresApproval: true
        };
      }
      options = { ...options, elevationGrantId: elevation.grant?.grantId ?? null };

      // Fail closed on auditability. An elevated action with nowhere to record
      // it is an elevated action nobody can review afterwards, which is
      // precisely the record the rest of this system exists to produce.
      if (!this.auditRepository || typeof this.auditRepository.append !== "function") {
        return {
          success: false,
          operation,
          scope,
          reason: `${operation} requires administrator rights, but no audit repository is wired to record it.`,
          requiresElevation: true,
          auditUnavailable: true
        };
      }
    }

    const mode = options.mode === PrivilegedExecutionMode.COMMIT
      ? PrivilegedExecutionMode.COMMIT
      : PrivilegedExecutionMode.VALIDATE;

    // Single-use, scoped approval token is mandatory.
    const tokenDecision = await this.permissionBroker.consumePrivilegeToken({
      sessionId: options.sessionId,
      token: options.token,
      operation,
      scope
    });
    if (!tokenDecision.valid) {
      return {
        success: false,
        reason: tokenDecision.reason,
        requiresApproval: true
      };
    }

    // Bounded execution with a hard time limit and cooperative cancellation.
    const controller = new AbortController();
    const externalSignal = options.signal ?? null;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timeoutMs = Number(options.timeoutMs ?? definition.timeoutMs ?? 30000);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    const startedAt = new Date().toISOString();
    let outcome;
    try {
      const result = definition.requiresElevation === true
        ? await this._runElevated(operation, scope, mode, options)
        : await definition.run({
            adapter: this.adapter,
            scope,
            mode,
            signal: controller.signal
          });
      outcome = timedOut
        ? { success: false, operation, scope, mode, reason: `Privileged operation ${operation} exceeded ${timeoutMs}ms and was cancelled.`, timedOut: true }
        : { ...result, exitCode: result.exitCode ?? (result.success ? 0 : -1) };
    } catch (error) {
      outcome = {
        success: false,
        operation,
        scope,
        mode,
        reason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timer);
    }

    if (definition.requiresElevation === true) {
      const audit = await this._recordElevatedAction({
        operation, scope, mode, options, startedAt, outcome
      });
      if (!audit.recorded) {
        // The audit chain is the only durable evidence that an administrator
        // action happened and who authorised it. Losing it silently is not an
        // option, so the action is reported as failed even when the underlying
        // work succeeded, and the caller is told exactly why.
        return {
          ...outcome,
          success: false,
          auditFailed: true,
          auditError: audit.error,
          reason: `${operation} ran with administrator rights but its audit record could not be written (${audit.error}). Treating the action as failed.`
        };
      }
      return { ...outcome, auditEventId: audit.eventId ?? null };
    }
    return outcome;
  }

  /**
   * The single authoritative record of one elevated action.
   *
   * Lifecycle events (REQUESTED / GRANTED / REVOKED) describe the session. This
   * describes the ACTION: who, under which grant, with exactly which arguments,
   * against which approval token, over what window, and how it ended. Without
   * it there is no record binding an approval to the change it produced.
   *
   * Parameters go through the audit repository's existing redaction, so this
   * adds no new disclosure path.
   */
  async _recordElevatedAction({ operation, scope, mode, options, startedAt, outcome }) {
    const payload = {
      operation,
      scope,
      mode,
      actor: {
        sessionId: options.sessionId ?? null,
        unattended: options.unattended === true
      },
      elevationGrantId: options.elevationGrantId ?? null,
      // A commitment, not the token: enough to prove afterwards that a specific
      // approval token authorised this action, without writing a credential
      // into the log. Approval tokens are `priv_<uuidv4>` (122 bits), so the
      // digest is not reversible by search.
      //
      // The field is deliberately NOT named "...Token...": the audit
      // repository's redactor matches /token/i on key names and would replace
      // this with ***REDACTED***, destroying the very binding between approval
      // and action that this record exists to establish. (It did exactly that
      // until the live check surfaced it.)
      approvalCommitmentSha256: options.token
        ? createHash("sha256").update(String(options.token), "utf8").digest("hex")
        : null,
      parameters: { scope, ...(options.params ?? {}) },
      startedAt,
      endedAt: new Date().toISOString(),
      outcome: outcome.success ? "SUCCESS" : "FAILURE",
      reason: outcome.reason ?? null,
      timedOut: outcome.timedOut === true,
      elevatedHostPid: this.elevatedHost?.hostPid ?? null,
      schemaVersion: OPERATION_SCHEMA_VERSION
    };

    let lastError = null;
    // A bounded retry, because a transient sqlite lock should not lose the
    // record — but a persistent failure must surface, not be swallowed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const event = await this.auditRepository.append(
          options.sessionId ?? "elevation", "ELEVATED_ACTION_EXECUTED", payload
        );
        return { recorded: true, eventId: event?.id ?? event?.eventId ?? null };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    console.error(
      `[SECURITY] Failed to write the audit record for elevated action ${operation} on '${scope}' `
      + `(session ${options.sessionId ?? "unknown"}, grant ${options.elevationGrantId ?? "unknown"}): ${lastError}`
    );
    return { recorded: false, error: lastError };
  }

  /**
   * Dispatch an elevated operation to the high-integrity host.
   *
   * VALIDATE mode never crosses the elevation boundary: it reports that the
   * session could perform the operation, without performing it. Only COMMIT
   * actually runs elevated, so an approval token alone never mutates the
   * machine.
   */
  async _runElevated(operation, scope, mode, options) {
    if (mode === PrivilegedExecutionMode.VALIDATE) {
      return {
        success: true,
        mode,
        operation,
        scope,
        validated: true,
        elevated: true,
        elevationGrantId: options.elevationGrantId ?? null,
        reason: `Session is elevated and ${operation} is eligible to run.`
      };
    }
    const result = await this.elevatedHost.request(operation, {
      scope,
      ...(options.params ?? {})
    }, { timeoutMs: options.timeoutMs });
    return {
      success: result?.performed !== false,
      mode,
      operation,
      scope,
      elevated: true,
      elevationGrantId: options.elevationGrantId ?? null,
      result,
      reason: result?.performed === false
        ? (result.reason ?? `${operation} did not perform a change.`)
        : `${operation} completed with administrator rights.`
    };
  }
}

export { OPERATIONS as PRIVILEGED_OPERATIONS, ELEVATED_OPERATIONS };
