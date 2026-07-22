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

export const PrivilegedExecutionMode = Object.freeze({
  VALIDATE: "VALIDATE",
  COMMIT: "COMMIT"
});

// Explicitly-implemented privileged operations. Adding an operation here is the
// ONLY way to make it executable; there is no dynamic/wildcard dispatch.
const OPERATIONS = {
  "service.restart": {
    // scope = the Windows service name.
    validateScope(scope) {
      if (typeof scope !== "string" || scope.trim() === "") {
        return { valid: false, reason: "service.restart requires a non-empty service name scope." };
      }
      // Service names are conservative: letters, digits, and a small set of
      // separators. This blocks any attempt to smuggle shell/argument syntax
      // through the scope even though the adapter never uses a shell.
      if (!/^[A-Za-z0-9._ -]{1,256}$/.test(scope)) {
        return { valid: false, reason: "service.restart scope contains invalid characters." };
      }
      return { valid: true };
    },
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
    // scope = the WinGet package id.
    validateScope(scope) {
      if (typeof scope !== "string" || scope.trim() === "") {
        return { valid: false, reason: "package.install requires a non-empty package id scope." };
      }
      // WinGet ids look like Publisher.Package(.Suffix). Restrict to a safe
      // charset so nothing shell-like can pass through.
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/.test(scope)) {
        return { valid: false, reason: "package.install scope is not a valid package id." };
      }
      return { valid: true };
    },
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

export class PrivilegedOperationHelper {
  constructor({ permissionBroker, adapter } = {}) {
    this.permissionBroker = permissionBroker;
    this.adapter = adapter;
  }

  isSupported(operation) {
    return Object.prototype.hasOwnProperty.call(OPERATIONS, operation);
  }

  // The bounded operation ids this helper can route + execute. The registry
  // uses this to build its live privileged-operation allow-list, so elevation
  // availability is operation-specific (helper supporting service.restart does
  // NOT imply it supports arbitrary.plugin.adminAction).
  supportedOperations() {
    return Object.keys(OPERATIONS);
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
    const definition = OPERATIONS[operation];
    if (!definition) {
      return {
        success: false,
        reason: `Operation ${operation} is not in the allowed privileged helper list.`
      };
    }

    // Strict argument validation before any token is consumed.
    const scopeCheck = definition.validateScope(scope);
    if (!scopeCheck.valid) {
      return { success: false, reason: scopeCheck.reason };
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

    try {
      const result = await definition.run({
        adapter: this.adapter,
        scope,
        mode,
        signal: controller.signal
      });
      if (timedOut) {
        return { success: false, operation, scope, mode, reason: `Privileged operation ${operation} exceeded ${timeoutMs}ms and was cancelled.`, timedOut: true };
      }
      return { ...result, exitCode: result.exitCode ?? (result.success ? 0 : -1) };
    } catch (error) {
      return {
        success: false,
        operation,
        scope,
        mode,
        reason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export { OPERATIONS as PRIVILEGED_OPERATIONS };
