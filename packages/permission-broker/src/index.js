import crypto from "node:crypto";
import { PolicyEffect } from "../../shared-types/src/domain.js";
import { buildApprovalManifest, APPROVAL_MANIFEST_VERSION } from "./approval-manifest.js";

export class PermissionBroker {
  // installationKey (Buffer) authenticates secret commitments in the approval
  // manifest. The production runtime wires it from the InstallationKeyStore; a
  // broker constructed without one falls back to a process-ephemeral key so
  // unit/direct-call paths still function (commitments are then only stable
  // within the process, which is fine because no persistence spans processes
  // there). resolveCapabilityVersion binds the exact approved capability version.
  constructor({ approvalTokenStore = null, auditRepository = null, capabilityGrantStore = null, installationKey = null, resolveCapabilityVersion = null } = {}) {
    this.approvalTokenStore = approvalTokenStore;
    this.auditRepository = auditRepository;
    this.capabilityGrantStore = capabilityGrantStore;
    this._installationKey = installationKey ?? PermissionBroker._ephemeralKey();
    this.resolveCapabilityVersion = resolveCapabilityVersion;
  }

  static _ephemeralKey() {
    // Lazily created once per process. Stable within a process so a
    // build-then-verify in the same process matches; never persisted.
    if (!PermissionBroker.__ephemeralKey) {
      PermissionBroker.__ephemeralKey = crypto.randomBytes(32);
    }
    return PermissionBroker.__ephemeralKey;
  }

  // Evaluate whether a policy decision can proceed without further interaction.
  //   policyDecision   - the PolicyEngine decision (carries effect +
  //                      confirmationLevel).
  //   autoApprove      - caller-supplied blanket approval.
  //   approvalCommitment- the cryptographic commitment (SHA-256 over the
  //                      canonical ApprovalManifest) the approval is bound to.
  //                      Echoed back on the decision so the runtime records
  //                      exactly what was approved and can detect a later plan
  //                      whose commitment differs.
  evaluate({ policyDecision, autoApprove = false, approvalCommitment = null }) {
    if (!policyDecision || !policyDecision.effect) {
      return {
        required: true,
        approved: false,
        reason: "Missing policy decision."
      };
    }

    const confirmationLevel = policyDecision.confirmationLevel ?? null;

    if (policyDecision.effect === PolicyEffect.DENY) {
      return {
        required: false,
        approved: false,
        confirmationLevel,
        reason: policyDecision.reason
      };
    }

    if (policyDecision.effect === PolicyEffect.ALLOW) {
      return {
        required: false,
        approved: true,
        confirmationLevel,
        reason: "No additional approval required by policy."
      };
    }

    return {
      required: true,
      approved: autoApprove === true,
      confirmationLevel,
      // The approval, if granted, is bound to THIS commitment. A later resume
      // whose recomputed commitment differs must not reuse this approval.
      approvalCommitment,
      reason: autoApprove === true
        ? "Approval granted by caller."
        : "Approval required for this action."
    };
  }

  // Build the cryptographic approval manifest + commitment for a plan, bound to
  // this broker's installation key. This is the authoritative, security-material
  // commitment an approval is granted against (see approval-manifest.js). A
  // change to ANY security-material field — capability, version, dependencies,
  // ordering, permissions, elevation, rollback requirement, non-secret input, or
  // a secret VALUE (via keyed HMAC, no plaintext) — changes the commitment.
  //   priorManifest lets a legitimate redacted secret round-trip on resume.
  buildApprovalCommitment(plan, { priorManifest = null } = {}) {
    return buildApprovalManifest(plan, {
      key: this._installationKey,
      resolveVersion: this.resolveCapabilityVersion,
      priorManifest
    });
  }

  // Back-compat convenience: the bare commitment string for a plan. Prefer
  // buildApprovalCommitment (returns the full manifest for persistence).
  approvalCommitment(plan, options = {}) {
    return this.buildApprovalCommitment(plan, options).commitment;
  }

  // Authoritative capability permission enforcement. Deny-by-default: a
  // capability only executes when there is an active, unexpired, non-revoked
  // grant that covers EVERY declared permission and whose scope matches the
  // capability's permission model. Session existence alone is never sufficient.
  //
  // Resolution order:
  //   1. Policy must not have denied the action (approved === true).
  //   2. If a capabilityGrantStore + sessionId are present (the real runtime),
  //      a stored grant is required and consumed according to its reuse policy.
  //   3. Otherwise a caller may pass an explicit grantedPermissions set
  //      (direct-call / unit-test path); every declared permission must appear.
  async evaluateCapability({ capability, approved = false, grantedPermissions = null, sessionId = null } = {}) {
    const name = capability?.name ?? capability?.capabilityId ?? "unknown";
    const required = capability?.requirements?.permissions ?? capability?.permissions ?? [];
    const model = capability?.permissionModel ?? null;

    if (!approved) {
      return { approved: false, required, reason: `Capability ${name} has not been approved by policy.` };
    }

    // Real runtime path: enforce against the persisted grant store.
    if (this.capabilityGrantStore && sessionId) {
      const decision = await this.capabilityGrantStore.check({
        sessionId,
        capability: name,
        requiredPermissions: required,
        scope: model?.scope ?? []
      });
      if (!decision.valid) {
        await this.auditRepository?.append?.(sessionId, "CAPABILITY_GRANT_DENIED", {
          capability: name,
          required,
          reason: decision.reason
        });
        return { approved: false, required, reason: decision.reason, missing: decision.missing };
      }
      // Consume single-use grants so a grant is never silently reused.
      if (decision.grant?.reusePolicy === "SINGLE_USE") {
        await this.capabilityGrantStore.consume(decision.grant.grantId);
      }
      await this.auditRepository?.append?.(sessionId, "CAPABILITY_GRANT_CONSUMED", {
        capability: name,
        grantId: decision.grant?.grantId,
        reusePolicy: decision.grant?.reusePolicy
      });
      return { approved: true, required, reason: `Capability ${name} grant verified.`, grant: decision.grant };
    }

    // Direct-call path: an explicit grant set must cover every declared permission.
    if (Array.isArray(grantedPermissions)) {
      const missing = required.filter((permission) => !grantedPermissions.includes(permission));
      if (missing.length > 0) {
        return { approved: false, required, missing, reason: `Missing capability permissions: ${missing.join(", ")}` };
      }
      return { approved: true, required, reason: "Capability permissions approved." };
    }

    // Compatibility path: no grant store is configured, so authoritative
    // deny-by-default enforcement is not in effect for this broker. The
    // production runtime ALWAYS wires a capabilityGrantStore (see runtime
    // factory), so it takes the grant-store branch above; this branch only
    // applies to lightweight/legacy wiring where policy approval is the gate.
    // Policy has already approved (checked at the top), so the capability runs.
    return {
      approved: true,
      required,
      reason: required.length === 0
        ? `Capability ${name} declares no permissions.`
        : `Capability ${name} approved by policy (no grant store configured for authoritative enforcement).`
    };
  }

  // Issue capability grants for every capability in an approved plan. Called by
  // the runtime immediately after policy/permission approval, before execution.
  async grantPlanCapabilities({ sessionId, capabilities = [] }) {
    if (!this.capabilityGrantStore || !sessionId) return [];
    const issued = [];
    for (const capability of capabilities) {
      const name = capability?.name ?? capability?.capabilityId;
      if (!name) continue;
      const model = capability.permissionModel ?? {};
      const grant = await this.capabilityGrantStore.grant({
        sessionId,
        capability: name,
        permissions: capability?.requirements?.permissions ?? capability?.permissions ?? [],
        scope: model.scope ?? [],
        type: model.type ?? "READ",
        reusePolicy: model.reusePolicy ?? "SESSION_REUSABLE",
        lifetimeMs: model.approvalLifetimeMs ?? null
      });
      issued.push(grant);
      await this.auditRepository?.append?.(sessionId, "CAPABILITY_GRANT_ISSUED", {
        capability: name,
        grantId: grant.grantId,
        scope: grant.scope,
        type: grant.type,
        reusePolicy: grant.reusePolicy,
        expiresAt: grant.expiresAt
      });
    }
    return issued;
  }

  async revokeSessionCapabilities(sessionId, reason = "Session capabilities revoked.") {
    if (!this.capabilityGrantStore || !sessionId) return 0;
    const count = await this.capabilityGrantStore.revokeSession(sessionId);
    if (count > 0) {
      await this.auditRepository?.append?.(sessionId, "CAPABILITY_GRANTS_REVOKED", { count, reason });
    }
    return count;
  }

  evaluatePrivilegeEscalation({ operation, scope, approved = false }) {
    if (!operation || !scope) {
      return {
        approved: false,
        reason: "Operation and scope are required for privilege escalation."
      };
    }
    if (!approved) {
      return {
        approved: false,
        reason: `Privilege escalation requires explicit approval for ${operation} (${scope}).`
      };
    }
    return {
      approved: true,
      reason: `Privilege escalation approved for ${operation} (${scope}).`
    };
  }

  async issuePrivilegeToken({ sessionId = "privileged", operation, scope, approved = false }) {
    const decision = this.evaluatePrivilegeEscalation({ operation, scope, approved });
    if (!decision.approved) {
      if (this.auditRepository) {
        await this.auditRepository.append(sessionId, "PRIVILEGED_TOKEN_DENIED", {
          operation,
          scope,
          reason: decision.reason
        });
      }
      return {
        approved: false,
        reason: decision.reason
      };
    }
    if (!this.approvalTokenStore) {
      return {
        approved: false,
        reason: "Approval token store is not configured."
      };
    }
    const tokenRecord = await this.approvalTokenStore.issue(operation, scope);
    if (this.auditRepository) {
      await this.auditRepository.append(sessionId, "PRIVILEGED_TOKEN_ISSUED", {
        operation,
        scope,
        token: tokenRecord.token,
        expiresAt: tokenRecord.expiresAt
      });
    }
    return {
      approved: true,
      token: tokenRecord.token,
      expiresAt: tokenRecord.expiresAt
    };
  }

  async consumePrivilegeToken({ sessionId = "privileged", token, operation, scope }) {
    if (!this.approvalTokenStore) {
      return {
        valid: false,
        reason: "Approval token store is not configured."
      };
    }
    const result = await this.approvalTokenStore.consume(token, operation, scope);
    if (this.auditRepository) {
      await this.auditRepository.append(sessionId, result.valid ? "PRIVILEGED_TOKEN_CONSUMED" : "PRIVILEGED_TOKEN_REJECTED", {
        operation,
        scope,
        token,
        reason: result.reason ?? "Consumed successfully."
      });
    }
    return result;
  }
}
