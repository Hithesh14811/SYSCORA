import {
  DEFAULT_ELEVATION_LIFETIME_MS,
  MAX_ELEVATION_LIFETIME_MS,
  ELEVATION_SCOPE_ALL
} from "./elevation-grant-store.js";

/**
 * Clamp a requested elevation lifetime to the SAME hard cap the grant store
 * enforces, before it reaches anything else.
 *
 * The review found the service passed the raw requested value straight to the
 * elevated host, whose own clamp applied a 30-second minimum but no maximum.
 * The grant row therefore expired at 8 hours while the high-integrity process
 * kept its original, longer deadline — the record and the reality disagreed,
 * and the reality was the more privileged of the two.
 */
export function clampElevationLifetimeMs(lifetimeMs) {
  const requested = Number(lifetimeMs);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_ELEVATION_LIFETIME_MS;
  return Math.min(requested, MAX_ELEVATION_LIFETIME_MS);
}

export const ElevationConsentKind = Object.freeze({
  // Windows itself prompted and the user accepted. This is the only kind that
  // proves a human was present at the moment of elevation.
  UAC_PROMPT: "UAC_PROMPT",
  // The operator enabled unattended elevation ahead of time. A human consented
  // once, in configuration, rather than at the moment of the action.
  PRECONFIGURED: "PRECONFIGURED"
});

/**
 * Session-scoped elevation.
 *
 * Owns the whole lifecycle: decide whether elevation is permitted, obtain the
 * OS-level consent, record the grant, and expose it to the privileged helper.
 *
 * Two modes:
 *   - INTERACTIVE (default): every elevated session begins with a real UAC
 *     prompt. SYSCORA's own approval gate may be auto-approved, but Windows
 *     still asks.
 *   - UNATTENDED (`unattendedElevation: true`, off by default): SYSCORA will not
 *     ask its own approval question for elevated work. The Windows UAC prompt
 *     is still raised by the OS — this build does not bypass it, because doing
 *     so is privilege escalation rather than a feature. To remove the prompt
 *     entirely, install the elevated host as a service or scheduled task with
 *     highest privileges at install time.
 */
export class ElevationService {
  constructor({
    elevationGrantStore,
    elevatedHost = null,
    auditRepository = null,
    // Off by default. Turning this on is an explicit, recorded decision.
    unattendedElevation = false,
    defaultLifetimeMs = DEFAULT_ELEVATION_LIFETIME_MS,
    allowedOperations = [ELEVATION_SCOPE_ALL],
    onAuditFailure = null
  } = {}) {
    this.elevationGrantStore = elevationGrantStore;
    this.elevatedHost = elevatedHost;
    this.auditRepository = auditRepository;
    this.unattendedElevation = unattendedElevation === true;
    this.defaultLifetimeMs = clampElevationLifetimeMs(defaultLifetimeMs);
    this.allowedOperations = allowedOperations;
    // Escalation path for a lost audit write, so an operator can be told rather
    // than discovering the gap during an incident review.
    this.onAuditFailure = onAuditFailure;
  }

  available() {
    return Boolean(this.elevatedHost && this.elevationGrantStore);
  }

  /**
   * Write a lifecycle event.
   *
   * This used to swallow every failure. For a privilege-escalation subsystem
   * that is the wrong default: losing the record of who elevated, when, and on
   * what basis is itself a security failure. Now a failed write is surfaced —
   * `required: true` events fail the operation outright, and the rest still
   * report loudly rather than vanishing.
   *
   * Returns { recorded, error }.
   */
  async _audit(sessionId, eventType, details, { required = false } = {}) {
    if (!this.auditRepository?.append) {
      const error = "No audit repository is wired.";
      if (required) return { recorded: false, error };
      console.error(`[SECURITY] Elevation event ${eventType} for session ${sessionId} was not recorded: ${error}`);
      return { recorded: false, error };
    }
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.auditRepository.append(sessionId, eventType, details);
        return { recorded: true };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    console.error(`[SECURITY] Elevation event ${eventType} for session ${sessionId} could not be recorded: ${lastError}`);
    this.onAuditFailure?.({ sessionId, eventType, error: lastError });
    return { recorded: false, error: lastError };
  }

  async status(sessionId) {
    if (!this.elevationGrantStore) return { elevated: false, available: false };
    const check = await this.elevationGrantStore.check({ sessionId, operation: null });
    return {
      available: this.available(),
      unattendedElevation: this.unattendedElevation,
      elevated: check.elevated === true,
      reason: check.reason ?? null,
      grant: check.grant ?? null,
      hostExpiresAt: this.elevatedHost?.expiresAt ? new Date(this.elevatedHost.expiresAt).toISOString() : null
    };
  }

  /**
   * Elevate a session.
   *
   * `userConsented` is the caller's assertion that a human asked for this.
   * Without it, elevation only proceeds when unattended elevation was
   * explicitly configured — never by default and never inferred from the fact
   * that a plan happens to need admin rights.
   */
  async elevateSession({
    sessionId,
    operations = this.allowedOperations,
    lifetimeMs = this.defaultLifetimeMs,
    userConsented = false,
    reason = null
  }) {
    if (!sessionId) throw new Error("elevateSession requires sessionId");
    if (!this.available()) {
      await this._audit(sessionId, "ELEVATION_UNAVAILABLE", { reason: "No elevation channel is configured." });
      return { elevated: false, reason: "Elevation is not available in this build." };
    }

    const existing = await this.elevationGrantStore.check({ sessionId, operation: null });
    if (existing.elevated && this.elevatedHost.active) {
      return { elevated: true, reused: true, grant: existing.grant };
    }

    if (!userConsented && !this.unattendedElevation) {
      await this._audit(sessionId, "ELEVATION_REFUSED", {
        reason: "Elevation requires explicit user consent, and unattended elevation is disabled."
      });
      return {
        elevated: false,
        requiresConsent: true,
        reason: "Elevation requires explicit user consent."
      };
    }

    const consentKind = userConsented
      ? ElevationConsentKind.UAC_PROMPT
      : ElevationConsentKind.PRECONFIGURED;

    // Clamp here, once, before the value reaches EITHER the host or the store,
    // so the process deadline and the grant row cannot disagree.
    const cappedLifetimeMs = clampElevationLifetimeMs(lifetimeMs);

    const requestAudit = await this._audit(sessionId, "ELEVATION_REQUESTED", {
      operations,
      requestedLifetimeMs: lifetimeMs,
      lifetimeMs: cappedLifetimeMs,
      lifetimeClamped: cappedLifetimeMs !== Number(lifetimeMs),
      consentKind,
      unattended: !userConsented,
      reason
    }, { required: true });
    if (!requestAudit.recorded) {
      // No UAC prompt is raised at all if the request cannot be recorded.
      return {
        elevated: false,
        auditFailed: true,
        reason: `Elevation was refused because it could not be audited: ${requestAudit.error}`
      };
    }

    // The OS consent step. This is where Windows shows the UAC prompt.
    let launch;
    try {
      this.elevatedHost.lifetimeMs = cappedLifetimeMs;
      launch = await this.elevatedHost.start();
    } catch (error) {
      await this._audit(sessionId, "ELEVATION_DENIED", {
        code: error.code ?? "ELEVATION_FAILED",
        error: error.message
      });
      return {
        elevated: false,
        declined: error.code === "ELEVATION_DECLINED",
        reason: error.message
      };
    }

    const grant = await this.elevationGrantStore.grant({
      sessionId,
      operations,
      lifetimeMs: cappedLifetimeMs,
      consentKind,
      // The pid recorded here is the one the OS reported at launch, not one the
      // host claimed over the pipe. Teardown is verified against it.
      consentEvidence: JSON.stringify({ hostPid: launch.pid ?? null, expiresAt: launch.expiresAt }),
      unattended: !userConsented
    });

    await this._audit(sessionId, "ELEVATION_GRANTED", {
      grantId: grant.grantId,
      operations: grant.operations,
      consentKind,
      unattended: grant.unattended,
      expiresAt: grant.expiresAt,
      lifetimeMs: cappedLifetimeMs,
      hostPid: launch.pid ?? null
    }, { required: true });

    return { elevated: true, reused: launch.reused === true, grant, hostPid: launch.pid ?? null };
  }

  /**
   * Drop elevation immediately.
   *
   * Revocation is only real if the high-integrity PROCESS stops. The previous
   * implementation revoked the grant rows and closed the daemon's socket, then
   * reported success — while the elevated PowerShell process went back to its
   * reconnect loop, still high-integrity, still holding its token, ready to
   * hand it to whoever answered next on that pipe name.
   *
   * Now: send an authenticated SHUTDOWN over the live channel, then WAIT for
   * the real pid to disappear, and only report a clean revocation when the OS
   * confirms it. A teardown that cannot be confirmed is a loud, audited failure
   * state — `hostTerminated: false` — not a quiet success.
   */
  async revokeSession(sessionId, { reason = "session-ended" } = {}) {
    const revoked = this.elevationGrantStore
      ? await this.elevationGrantStore.revokeSession(sessionId)
      : 0;

    let teardown = { ok: true, exited: true, pid: null, skipped: true };
    if (this.elevatedHost) {
      try {
        teardown = typeof this.elevatedHost.shutdown === "function"
          ? await this.elevatedHost.shutdown({ reason })
          : (this.elevatedHost.close?.(), { ok: true, exited: true, pid: null, legacyClose: true });
      } catch (error) {
        teardown = { ok: false, exited: false, pid: this.elevatedHost.hostPid ?? null, reason: error.message };
      }
    }

    if (revoked > 0 || !teardown.ok) {
      await this._audit(sessionId, "ELEVATION_REVOKED", {
        revoked,
        reason,
        hostPid: teardown.pid ?? null,
        hostTerminated: teardown.exited === true
      });
    }

    if (!teardown.ok) {
      // Deliberately loud. The grant is gone from the store, but a
      // high-integrity process is still running that we could not stop, and the
      // pipe name is being held open specifically so nothing else can claim it.
      await this._audit(sessionId, "ELEVATION_TEARDOWN_FAILED", {
        reason: teardown.reason ?? "The elevated host did not exit.",
        hostPid: teardown.pid ?? null,
        pipeRetained: teardown.pipeRetained === true
      });
      console.error(
        `[SECURITY] Elevated host pid ${teardown.pid ?? "unknown"} did not exit after revocation of session `
        + `${sessionId}: ${teardown.reason ?? "unknown"}. The pipe name is retained to prevent takeover.`
      );
    }

    return {
      revoked,
      hostTerminated: teardown.exited === true,
      hostPid: teardown.pid ?? null,
      teardownFailed: teardown.ok === false,
      teardownReason: teardown.ok === false ? (teardown.reason ?? null) : null
    };
  }
}
