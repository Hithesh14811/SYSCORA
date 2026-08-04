// Session-scoped elevation + the unattended auto-approve tier.
//
// These tests pin the security-relevant behaviour of general elevated-action
// support: elevation is never implicit, always expires, is revocable, is scoped
// to named operations, and the unattended tier is a separate explicit opt-in
// that is recorded every time it skips a human.
//
// The second half of this file exercises the REAL high-integrity boundary --
// the actual elevated-host.ps1 process, over the actual named-pipe protocol.
// An independent review found that the original 15 tests all used a fake host
// object and never touched the PowerShell process or the wire format, so none
// of them could have caught the findings that blocked this subsystem. Those
// tests run the genuine host script at medium integrity (no UAC prompt is
// possible or needed to test the protocol; a medium-integrity host simply
// cannot perform admin work, which is irrelevant to what is being asserted).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  ElevationGrantStore,
  ELEVATION_SCOPE_ALL,
  MAX_ELEVATION_LIFETIME_MS
} from "../../packages/permission-broker/src/elevation-grant-store.js";
import { ElevationService, ElevationConsentKind } from "../../packages/permission-broker/src/elevation-service.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { ApprovalTokenStore } from "../../packages/permission-broker/src/approval-token-store.js";
import { PrivilegedOperationHelper, PrivilegedExecutionMode } from "../../packages/privileged-helpers/src/index.js";
import { validateAgainstSchema } from "../../packages/privileged-helpers/src/operation-schema.js";
import { ConfirmationLevel, PolicyEffect } from "../../packages/shared-types/src/domain.js";
import {
  ElevatedHostClient,
  ELEVATED_HOST_SCRIPT,
  ELEVATED_OPERATION_SCHEMA_PATH,
  MAX_HOST_LIFETIME_MS,
  isProcessAlive,
  waitForProcessExit
} from "../../os-adapters/windows-host/src/elevated-client.js";

const onWindows = process.platform === "win32";

async function tempStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-elevation-"));
  return { store: new ElevationGrantStore(directory), directory };
}

// A recording audit repository. Elevated execution is fail-closed on
// auditability, so tests that expect an elevated action to succeed must supply
// one -- which is itself the point.
function recordingAudit() {
  const events = [];
  return {
    events,
    async append(sessionId, eventType, details) {
      events.push({ sessionId, eventType, details });
      return { id: `evt_${events.length}` };
    },
    ofType(eventType) {
      return events.filter((entry) => entry.eventType === eventType);
    }
  };
}

// A stand-in for the elevated PowerShell host: it records what it was asked to
// do without touching the machine.
function fakeElevatedHost({ failWith = null } = {}) {
  return {
    active: false,
    expiresAt: null,
    lifetimeMs: 0,
    hostPid: 4242,
    revoked: false,
    quarantined: false,
    calls: [],
    startCount: 0,
    shutdownCount: 0,
    async start() {
      this.startCount += 1;
      if (failWith) throw Object.assign(new Error(failWith.message), { code: failWith.code });
      this.active = true;
      this.expiresAt = Date.now() + this.lifetimeMs;
      return { started: true, reused: false, pid: 4242, expiresAt: new Date(this.expiresAt).toISOString() };
    },
    async request(operation, params) {
      this.calls.push({ operation, params });
      return { performed: true, operation, ...params };
    },
    async shutdown() {
      this.shutdownCount += 1;
      this.active = false;
      this.revoked = true;
      this.expiresAt = null;
      return { ok: true, exited: true, pid: 4242, shutdownAcknowledged: true };
    },
    close() { this.active = false; this.expiresAt = null; }
  };
}

test("a session is not elevated until something explicitly grants it", async () => {
  const { store, directory } = await tempStore();
  try {
    const check = await store.check({ sessionId: "s1", operation: "service.restart" });
    assert.equal(check.elevated, false);
    assert.match(check.reason, /not elevated/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an elevation grant always expires and is capped", async () => {
  const { store, directory } = await tempStore();
  try {
    // A caller asking for effectively unlimited elevation gets the hard cap.
    const grant = await store.grant({
      sessionId: "s1",
      lifetimeMs: Number.MAX_SAFE_INTEGER,
      consentKind: ElevationConsentKind.UAC_PROMPT
    });
    assert.ok(grant.expiresAt, "a grant must always carry an expiry");
    assert.equal(grant.ttlMs, MAX_ELEVATION_LIFETIME_MS);

    // A non-positive lifetime is not treated as "never expires".
    const defaulted = await store.grant({
      sessionId: "s2",
      lifetimeMs: 0,
      consentKind: ElevationConsentKind.UAC_PROMPT
    });
    assert.ok(Date.parse(defaulted.expiresAt) > Date.now());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an expired grant no longer elevates", async () => {
  const { store, directory } = await tempStore();
  try {
    await store.grant({ sessionId: "s1", lifetimeMs: 1, consentKind: ElevationConsentKind.UAC_PROMPT });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const check = await store.check({ sessionId: "s1", operation: "service.restart" });
    assert.equal(check.elevated, false);
    assert.match(check.reason, /expired/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a grant only covers the operations it names", async () => {
  const { store, directory } = await tempStore();
  try {
    await store.grant({
      sessionId: "s1",
      operations: ["service.restart"],
      consentKind: ElevationConsentKind.UAC_PROMPT
    });
    assert.equal((await store.check({ sessionId: "s1", operation: "service.restart" })).elevated, true);
    const other = await store.check({ sessionId: "s1", operation: "package.install" });
    assert.equal(other.elevated, false, "a scoped grant must not authorize an unnamed operation");
    assert.match(other.reason, /does not cover/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("revocation takes effect immediately", async () => {
  const { store, directory } = await tempStore();
  try {
    await store.grant({ sessionId: "s1", consentKind: ElevationConsentKind.UAC_PROMPT });
    assert.equal((await store.check({ sessionId: "s1", operation: "service.restart" })).elevated, true);
    const revoked = await store.revokeSession("s1");
    assert.equal(revoked, 1);
    const after = await store.check({ sessionId: "s1", operation: "service.restart" });
    assert.equal(after.elevated, false);
    assert.match(after.reason, /revoked/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("elevation refuses without consent unless unattended elevation is configured", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const audit = recordingAudit();
    const service = new ElevationService({
      elevationGrantStore: store, elevatedHost: host, auditRepository: audit
    });

    const refused = await service.elevateSession({ sessionId: "s1", userConsented: false });
    assert.equal(refused.elevated, false);
    assert.equal(refused.requiresConsent, true);
    assert.equal(host.startCount, 0, "no UAC prompt may be raised without consent or configuration");

    const consented = await service.elevateSession({ sessionId: "s1", userConsented: true });
    assert.equal(consented.elevated, true);
    assert.equal(consented.grant.consentKind, ElevationConsentKind.UAC_PROMPT);
    assert.equal(consented.grant.unattended, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("unattended elevation elevates without a per-action question and records why", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const audit = recordingAudit();
    const service = new ElevationService({
      elevationGrantStore: store,
      elevatedHost: host,
      unattendedElevation: true,
      auditRepository: audit
    });

    const result = await service.elevateSession({ sessionId: "s1", userConsented: false });
    assert.equal(result.elevated, true);
    // The consent is recorded as configuration, never as a user prompt that
    // did not happen.
    assert.equal(result.grant.consentKind, ElevationConsentKind.PRECONFIGURED);
    assert.equal(result.grant.unattended, true);
    assert.ok(audit.events.some((entry) => entry.eventType === "ELEVATION_GRANTED"));
    assert.equal(audit.ofType("ELEVATION_GRANTED")[0].details.unattended, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a declined UAC prompt is reported, not worked around", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost({
      failWith: { code: "ELEVATION_DECLINED", message: "Elevation was declined at the Windows UAC prompt." }
    });
    const service = new ElevationService({
      elevationGrantStore: store, elevatedHost: host, auditRepository: recordingAudit()
    });
    const result = await service.elevateSession({ sessionId: "s1", userConsented: true });
    assert.equal(result.elevated, false);
    assert.equal(result.declined, true);
    assert.equal((await store.check({ sessionId: "s1", operation: null })).elevated, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an elevated operation refuses to run unelevated rather than silently downgrading", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const broker = new PermissionBroker();
    const helper = new PrivilegedOperationHelper({
      permissionBroker: broker,
      adapter: null,
      elevatedHost: host,
      elevationGrantStore: store,
      auditRepository: recordingAudit()
    });

    assert.equal(helper.requiresElevation("system.setEnvironmentVariable"), true);

    const denied = await helper.execute("system.setEnvironmentVariable", "SYSCORA_TEST", {
      sessionId: "s1",
      params: { value: "x" },
      mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(denied.success, false);
    assert.equal(denied.requiresElevation, true);
    assert.equal(host.calls.length, 0, "nothing may reach the elevated host without a grant");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an elevated COMMIT reaches the elevated host only with a covering grant", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const audit = recordingAudit();
    // A real token store: the privilege token is a genuine gate, and a broker
    // without a store correctly refuses to issue one.
    const broker = new PermissionBroker({ approvalTokenStore: new ApprovalTokenStore(directory) });
    const helper = new PrivilegedOperationHelper({
      permissionBroker: broker,
      adapter: null,
      elevatedHost: host,
      elevationGrantStore: store,
      auditRepository: audit
    });
    await store.grant({
      sessionId: "s1",
      operations: [ELEVATION_SCOPE_ALL],
      consentKind: ElevationConsentKind.UAC_PROMPT
    });
    const token = await broker.issuePrivilegeToken({
      sessionId: "s1", operation: "system.setEnvironmentVariable", scope: "SYSCORA_TEST", approved: true
    });

    // VALIDATE must not cross the elevation boundary.
    const validated = await helper.execute("system.setEnvironmentVariable", "SYSCORA_TEST", {
      sessionId: "s1", token: token.token, params: { value: "x" }, mode: PrivilegedExecutionMode.VALIDATE
    });
    assert.equal(validated.success, true);
    assert.equal(validated.validated, true);
    assert.equal(host.calls.length, 0, "VALIDATE must not perform the elevated action");

    const commitToken = await broker.issuePrivilegeToken({
      sessionId: "s1", operation: "system.setEnvironmentVariable", scope: "SYSCORA_TEST", approved: true
    });
    const committed = await helper.execute("system.setEnvironmentVariable", "SYSCORA_TEST", {
      sessionId: "s1", token: commitToken.token, params: { value: "x" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(committed.success, true);
    assert.equal(committed.elevated, true);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].operation, "system.setEnvironmentVariable");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("elevated operations still validate their arguments strictly", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const helper = new PrivilegedOperationHelper({
      permissionBroker: new PermissionBroker(),
      adapter: null,
      elevatedHost: host,
      elevationGrantStore: store,
      auditRepository: recordingAudit()
    });
    await store.grant({ sessionId: "s1", consentKind: ElevationConsentKind.UAC_PROMPT });

    const badStartup = await helper.execute("service.setStartupType", "Spooler", {
      sessionId: "s1", params: { startupType: "Whenever" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(badStartup.success, false);
    assert.match(badStartup.reason, /Automatic, Manual, or Disabled/);

    const badHost = await helper.execute("system.hostsEntry.add", "example.com", {
      sessionId: "s1", params: { address: "not-an-ip; rm -rf /" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(badHost.success, false);
    assert.equal(host.calls.length, 0, "an invalid argument must never reach the elevated host");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("registerOperation refuses an operation without strict validation", () => {
  const helper = new PrivilegedOperationHelper({ permissionBroker: new PermissionBroker() });
  assert.throws(
    () => helper.registerOperation("evil.anything", { requiresElevation: true }),
    /validateScope/
  );
  // An elevated operation the HOST does not implement is refused at
  // registration time. The old contract accepted it here and failed with
  // "Unknown elevated operation" only at first elevated use.
  assert.throws(
    () => helper.registerOperation("custom.elevated", {
      requiresElevation: true,
      validateScope: (scope) => ({ valid: typeof scope === "string" })
    }),
    /the elevated host has no implementation for it/
  );
  assert.equal(helper.isSupported("custom.elevated"), false);

  // A non-elevated operation with a real run() is still accepted.
  helper.registerOperation("custom.local", {
    validateScope: (scope) => ({ valid: typeof scope === "string" }),
    run: async () => ({ success: true })
  });
  assert.equal(helper.isSupported("custom.local"), true);
  assert.equal(helper.requiresElevation("custom.local"), false);
});

test("autoApprove alone does not auto-approve elevated work", () => {
  const broker = new PermissionBroker();
  const elevatedPolicy = {
    effect: PolicyEffect.CONFIRM,
    confirmationLevel: ConfirmationLevel.ELEVATE,
    reason: "Operation requires ADMINISTRATOR privilege."
  };

  const withAutoApprove = broker.evaluate({ policyDecision: elevatedPolicy, autoApprove: true });
  assert.equal(withAutoApprove.approved, false, "elevated work needs its own opt-in");
  assert.match(withAutoApprove.reason, /unattended-elevation opt-in/);

  const withElevatedOptIn = broker.evaluate({
    policyDecision: elevatedPolicy, autoApprove: true, autoApproveElevated: true
  });
  assert.equal(withElevatedOptIn.approved, true);
  assert.equal(withElevatedOptIn.elevatedApproval, true);
  assert.equal(withElevatedOptIn.unattendedApproval, true);

  // The elevated opt-in on its own, without autoApprove, is still not enough.
  const elevatedOnly = broker.evaluate({
    policyDecision: elevatedPolicy, autoApprove: false, autoApproveElevated: true
  });
  assert.equal(elevatedOnly.approved, false);
});

test("a policy DENY is never auto-approved at any tier", () => {
  const broker = new PermissionBroker();
  const decision = broker.evaluate({
    policyDecision: { effect: PolicyEffect.DENY, confirmationLevel: ConfirmationLevel.DENY, reason: "denied" },
    autoApprove: true,
    autoApproveElevated: true
  });
  assert.equal(decision.approved, false);
});

test("ordinary confirmation is still auto-approved by autoApprove alone", () => {
  const broker = new PermissionBroker();
  const decision = broker.evaluate({
    policyDecision: { effect: PolicyEffect.CONFIRM, confirmationLevel: ConfirmationLevel.CONFIRM, reason: "confirm" },
    autoApprove: true
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.elevatedApproval, false);
  assert.equal(decision.unattendedApproval, true);
});

// ---------------------------------------------------------------------------
// Configuration: the shipped default is OFF, and half-on is still off.
// ---------------------------------------------------------------------------

test("enabling unattended without enabled stays fully off", async () => {
  // Claimed to exist by the previous change description; it did not. Written
  // now, because "unattended: true" is the single most dangerous line anyone
  // can put in this config file and it must be inert without "enabled: true".
  const { loadElevationConfig } = await import("../../apps/daemon/src/runtime-factory.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-elev-config-"));
  try {
    await fs.mkdir(path.join(directory, ".syscora"), { recursive: true });
    await fs.writeFile(
      path.join(directory, ".syscora", "config.json"),
      JSON.stringify({ elevation: { unattended: true, lifetimeMinutes: 60 } }),
      "utf8"
    );
    // Environment overrides must not resurrect it either.
    const saved = {
      enabled: process.env.SYSCORA_ELEVATION_ENABLED,
      unattended: process.env.SYSCORA_ELEVATION_UNATTENDED
    };
    delete process.env.SYSCORA_ELEVATION_ENABLED;
    delete process.env.SYSCORA_ELEVATION_UNATTENDED;
    try {
      const config = loadElevationConfig(directory);
      assert.equal(config.enabled, false, "elevation must stay disabled by default");
      assert.equal(config.unattended, false, "unattended elevation is meaningless and must be off when elevation is off");
    } finally {
      if (saved.enabled !== undefined) process.env.SYSCORA_ELEVATION_ENABLED = saved.enabled;
      if (saved.unattended !== undefined) process.env.SYSCORA_ELEVATION_UNATTENDED = saved.unattended;
    }

    // And with no config file at all, the shipped default is off.
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-elev-bare-"));
    try {
      const config = loadElevationConfig(bare);
      assert.equal(config.enabled, false);
      assert.equal(config.unattended, false);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a helper with no elevation host reports ELEVATE as unavailable", () => {
  const withoutHost = new PrivilegedOperationHelper({ permissionBroker: new PermissionBroker() });
  assert.equal(withoutHost.canElevate(), false, "no host means no elevation capability");

  const withHost = new PrivilegedOperationHelper({
    permissionBroker: new PermissionBroker(),
    elevatedHost: fakeElevatedHost(),
    elevationGrantStore: { check: async () => ({ elevated: false }) }
  });
  assert.equal(withHost.canElevate(), true);

  // A revoked or quarantined host is not a capability either.
  const revokedHost = fakeElevatedHost();
  revokedHost.revoked = true;
  const withRevoked = new PrivilegedOperationHelper({
    permissionBroker: new PermissionBroker(),
    elevatedHost: revokedHost,
    elevationGrantStore: { check: async () => ({ elevated: false }) }
  });
  assert.equal(withRevoked.canElevate(), false);
});

// ---------------------------------------------------------------------------
// Lifetime: the grant store's cap and the host's deadline must agree.
// ---------------------------------------------------------------------------

test("a lifetime over the hard cap is clamped before it reaches the host", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const service = new ElevationService({
      elevationGrantStore: store, elevatedHost: host, auditRepository: recordingAudit()
    });
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const result = await service.elevateSession({
      sessionId: "s1", userConsented: true, lifetimeMs: thirtyDays
    });

    assert.equal(result.elevated, true);
    // The store caps its row...
    assert.equal(result.grant.ttlMs, MAX_ELEVATION_LIFETIME_MS);
    // ...and the HOST was handed the same capped value, not the raw request.
    // Previously the service assigned the raw lifetime here and the client
    // applied only a minimum, so the process outlived its own grant record.
    assert.equal(host.lifetimeMs, MAX_ELEVATION_LIFETIME_MS);
    assert.ok(
      Date.parse(result.grant.expiresAt) - Date.now() <= MAX_ELEVATION_LIFETIME_MS + 5000,
      "the grant must not expire later than the cap"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the client and the grant store agree on the hard cap", () => {
  assert.equal(MAX_HOST_LIFETIME_MS, MAX_ELEVATION_LIFETIME_MS,
    "a disagreement here is a process that outlives its grant record");
});

// ---------------------------------------------------------------------------
// Audit: an elevated action that cannot be recorded does not happen.
// ---------------------------------------------------------------------------

test("an elevated action emits one authoritative audit record binding approval to outcome", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const audit = recordingAudit();
    const broker = new PermissionBroker({ approvalTokenStore: new ApprovalTokenStore(directory) });
    const helper = new PrivilegedOperationHelper({
      permissionBroker: broker, adapter: null, elevatedHost: host,
      elevationGrantStore: store, auditRepository: audit
    });
    const grant = await store.grant({
      sessionId: "s1", operations: [ELEVATION_SCOPE_ALL], consentKind: ElevationConsentKind.UAC_PROMPT
    });
    const token = await broker.issuePrivilegeToken({
      sessionId: "s1", operation: "system.setEnvironmentVariable", scope: "SYSCORA_AUDIT_TEST", approved: true
    });

    const committed = await helper.execute("system.setEnvironmentVariable", "SYSCORA_AUDIT_TEST", {
      sessionId: "s1", token: token.token, params: { value: "v" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(committed.success, true);

    const records = audit.ofType("ELEVATED_ACTION_EXECUTED");
    assert.equal(records.length, 1, "exactly one authoritative record per elevated action");
    const detail = records[0].details;
    assert.equal(detail.operation, "system.setEnvironmentVariable");
    assert.equal(detail.scope, "SYSCORA_AUDIT_TEST");
    assert.equal(detail.mode, "COMMIT");
    assert.equal(detail.actor.sessionId, "s1");
    assert.equal(detail.elevationGrantId, grant.grantId);
    assert.equal(detail.outcome, "SUCCESS");
    assert.deepEqual(detail.parameters, { scope: "SYSCORA_AUDIT_TEST", value: "v" });
    assert.ok(detail.startedAt && detail.endedAt, "start and end timestamps are mandatory");
    assert.ok(Date.parse(detail.endedAt) >= Date.parse(detail.startedAt));
    // A commitment to the approval token, not the token itself.
    assert.equal(
      detail.approvalCommitmentSha256,
      crypto.createHash("sha256").update(String(token.token), "utf8").digest("hex")
    );
    assert.ok(!JSON.stringify(detail).includes(token.token), "the raw token must not be written to the log");
    // The commitment must not be named in a way the audit repository's redactor
    // strips (it matches /token/i on key names). A ***REDACTED*** commitment
    // silently voids the binding between an approval and the change it caused,
    // which is the whole purpose of this record.
    assert.ok(
      !Object.keys(detail).some((key) => /(value|secret|token|password|credential|apiKey|accessKey|privateKey)/i.test(key)),
      `no top-level field of the elevated action record may be redacted away: ${Object.keys(detail).join(", ")}`
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an elevated action fails closed when its audit record cannot be written", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const broker = new PermissionBroker({ approvalTokenStore: new ApprovalTokenStore(directory) });
    const helper = new PrivilegedOperationHelper({
      permissionBroker: broker,
      adapter: null,
      elevatedHost: host,
      elevationGrantStore: store,
      auditRepository: { append: async () => { throw new Error("disk full"); } }
    });
    await store.grant({
      sessionId: "s1", operations: [ELEVATION_SCOPE_ALL], consentKind: ElevationConsentKind.UAC_PROMPT
    });
    const token = await broker.issuePrivilegeToken({
      sessionId: "s1", operation: "system.setEnvironmentVariable", scope: "SYSCORA_AUDIT_FAIL", approved: true
    });

    const committed = await helper.execute("system.setEnvironmentVariable", "SYSCORA_AUDIT_FAIL", {
      sessionId: "s1", token: token.token, params: { value: "v" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(committed.success, false, "a lost audit record must not be reported as success");
    assert.equal(committed.auditFailed, true);
    assert.match(committed.reason, /audit record could not be written/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an elevated action is refused outright when no audit repository is wired", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const helper = new PrivilegedOperationHelper({
      permissionBroker: new PermissionBroker(),
      adapter: null,
      elevatedHost: host,
      elevationGrantStore: store
      // auditRepository deliberately absent
    });
    await store.grant({
      sessionId: "s1", operations: [ELEVATION_SCOPE_ALL], consentKind: ElevationConsentKind.UAC_PROMPT
    });
    const result = await helper.execute("system.setEnvironmentVariable", "SYSCORA_NO_AUDIT", {
      sessionId: "s1", params: { value: "v" }, mode: PrivilegedExecutionMode.COMMIT
    });
    assert.equal(result.success, false);
    assert.equal(result.auditUnavailable, true);
    assert.equal(host.calls.length, 0, "nothing may run elevated without somewhere to record it");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("elevation is refused when the request itself cannot be audited", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const service = new ElevationService({
      elevationGrantStore: store,
      elevatedHost: host,
      auditRepository: { append: async () => { throw new Error("audit sink offline"); } }
    });
    const result = await service.elevateSession({ sessionId: "s1", userConsented: true });
    assert.equal(result.elevated, false);
    assert.equal(result.auditFailed, true);
    assert.equal(host.startCount, 0, "no UAC prompt may be raised for an unauditable request");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("revocation reports whether the elevated process actually terminated", async () => {
  const { store, directory } = await tempStore();
  try {
    const host = fakeElevatedHost();
    const audit = recordingAudit();
    const service = new ElevationService({
      elevationGrantStore: store, elevatedHost: host, auditRepository: audit
    });
    await service.elevateSession({ sessionId: "s1", userConsented: true });

    const revoked = await service.revokeSession("s1", { reason: "test" });
    assert.equal(revoked.revoked, 1);
    assert.equal(revoked.hostTerminated, true);
    assert.equal(host.shutdownCount, 1, "revocation must go through the authenticated shutdown path");
    assert.equal(audit.ofType("ELEVATION_REVOKED")[0].details.hostTerminated, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a teardown that cannot prove the process exited is a loud failure, not a clean revoke", async () => {
  const { store, directory } = await tempStore();
  try {
    // This is the exact bug the live check previously masked: the daemon closed
    // its own socket, saw `active === false`, and called it a clean teardown.
    const stubbornHost = {
      ...fakeElevatedHost(),
      async shutdown() {
        return { ok: false, exited: false, pid: 4242, reason: "process-still-running", pipeRetained: true };
      }
    };
    const audit = recordingAudit();
    const service = new ElevationService({
      elevationGrantStore: store, elevatedHost: stubbornHost, auditRepository: audit
    });
    await store.grant({ sessionId: "s1", consentKind: ElevationConsentKind.UAC_PROMPT });

    const revoked = await service.revokeSession("s1", { reason: "test" });
    assert.equal(revoked.teardownFailed, true);
    assert.equal(revoked.hostTerminated, false);
    assert.equal(audit.ofType("ELEVATION_TEARDOWN_FAILED").length, 1);
    assert.equal(audit.ofType("ELEVATION_TEARDOWN_FAILED")[0].details.pipeRetained, true);
    assert.equal(audit.ofType("ELEVATION_REVOKED")[0].details.hostTerminated, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared-schema validation, checked directly.
// ---------------------------------------------------------------------------

test("the shared schema rejects the hosts-file inputs the review flagged", () => {
  // ":::" passed the old /^[0-9.:a-fA-F]{3,45}$/ charset check.
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "example.com", { address: ":::" }).valid, false);
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "example.com", { address: "999.1.1.1" }).valid, false);
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "example.com", { address: "1" }).valid, false);
  // An embedded newline would turn one mapping into arbitrary extra lines.
  assert.equal(
    validateAgainstSchema("system.hostsEntry.add", "example.com", { address: "127.0.0.1\n10.0.0.1 evil.com" }).valid,
    false
  );
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "exa\r\nmple.com", { address: "127.0.0.1" }).valid, false);
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "-bad.example.com", { address: "127.0.0.1" }).valid, false);

  // Genuinely valid inputs still pass.
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "example.com", { address: "127.0.0.1" }).valid, true);
  assert.equal(validateAgainstSchema("system.hostsEntry.add", "example.com", { address: "::1" }).valid, true);
  assert.equal(
    validateAgainstSchema("system.hostsEntry.add", "a.b.example.com", { address: "2001:db8::8a2e:370:7334" }).valid,
    true
  );
});

test("the shared schema rejects undeclared parameters at the elevation boundary", () => {
  assert.equal(
    validateAgainstSchema("system.setEnvironmentVariable", "PATHX", { value: "x", extra: "smuggled" }).valid,
    false
  );
  assert.equal(
    validateAgainstSchema("system.setEnvironmentVariable", "PATHX", { value: "x" }).valid,
    true
  );
  // The `name` alias must not disagree with the scope.
  assert.equal(
    validateAgainstSchema("system.setEnvironmentVariable", "PATHX", { value: "x", name: "SOMETHING_ELSE" }).valid,
    false
  );
  assert.equal(
    validateAgainstSchema("system.setEnvironmentVariable", "PATHX", { value: "x", name: "PATHX" }).valid,
    true
  );
  // Oversized values are rejected.
  assert.equal(
    validateAgainstSchema("system.setEnvironmentVariable", "PATHX", { value: "x".repeat(8193) }).valid,
    false
  );
});

// ---------------------------------------------------------------------------
// THE REAL HIGH-INTEGRITY BOUNDARY.
//
// Everything below spawns the actual elevated-host.ps1 and speaks the actual
// pipe protocol. No UAC prompt is raised: the host runs at medium integrity,
// which is irrelevant to the protocol properties being asserted and lets these
// run in an ordinary unit-test pass.
// ---------------------------------------------------------------------------

/**
 * Drives the REAL host script through the REAL client, without elevation.
 *
 * Only the launch step is overridden, so the handshake, the MAC scheme, the
 * shutdown path and the teardown verification under test are the shipped ones.
 */
class TestHostClient extends ElevatedHostClient {
  constructor({ daemonPid = process.pid, hostLifetimeSeconds = null, ...options } = {}) {
    super({ requireElevated: false, connectTimeoutMs: 20000, teardownTimeoutMs: 12000, ...options });
    this.daemonPid = daemonPid;
    this.hostLifetimeSeconds = hostLifetimeSeconds;
    this.child = null;
    this.hostStderr = "";
  }

  async _spawnElevatedHost({ secretFile, lifetimeSeconds }) {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", ELEVATED_HOST_SCRIPT,
      "-PipeName", this.pipeName,
      "-SecretFile", secretFile,
      "-DaemonPid", String(this.daemonPid),
      "-LifetimeSeconds", String(this.hostLifetimeSeconds ?? lifetimeSeconds),
      "-SchemaFile", ELEVATED_OPERATION_SCHEMA_PATH
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr.on("data", (chunk) => { this.hostStderr = `${this.hostStderr}${chunk}`.slice(-4000); });
    child.stdout.resume();
    return { pid: child.pid, startTime: null };
  }

  /** Write a frame straight onto the wire, bypassing every daemon-side check. */
  sendRawFrame(frame, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new Error("raw frame timed out"));
      }, timeoutMs);
      this.pending.set(frame.id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(frame)}\n`, "utf8");
    });
  }

  /** Build a correctly-MAC'd frame for arbitrary (possibly invalid) params. */
  buildFrame(operation, params, { seq = ++this.sequence, id = crypto.randomUUID() } = {}) {
    const paramsJson = JSON.stringify(params ?? {});
    return {
      id, seq, operation, paramsJson,
      mac: this._hmac(`syscora-request|${this._nonce}|${seq}|${id}|${operation}|${paramsJson}`)
    };
  }

  async forceKill() {
    try { this.child?.kill(); } catch { /* already gone */ }
  }
}

async function withRealHost(options, body) {
  const client = new TestHostClient(options);
  try {
    await client.start();
    return await body(client);
  } finally {
    if (!client.revoked) { try { await client.shutdown({ reason: "test-cleanup" }); } catch { /* ignore */ } }
    await client.forceKill();
  }
}

test("the real elevated host completes the mutual handshake and reports protocol v2", { skip: !onWindows }, async () => {
  await withRealHost({ lifetimeMs: 60000 }, async (client) => {
    const health = await client.request("host.health", {});
    assert.equal(health.protocol, "syscora-elevated-host/2");
    assert.equal(health.pid, client.hostPid, "the host's own pid must match the pid captured from the OS at launch");
    assert.equal(health.schemaVersion, 1);
    assert.ok(health.remainingSeconds > 0);
  });
});

test("the host refuses to authenticate to a pipe served by anyone but the daemon", { skip: !onWindows }, async () => {
  // The HIGH-severity finding, at its root: the v1 host handed its bearer token
  // to whoever held the pipe name. Here the pipe is served by this process, but
  // the host is told to expect a DIFFERENT daemon pid -- exactly the situation
  // of a squatter holding a freed name. It must disclose nothing and exit.
  const pipeName = `syscora-takeover-${crypto.randomUUID()}`;
  const secretDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-rogue-"));
  const secretFile = path.join(secretDirectory, "session.secret");
  await fs.writeFile(secretFile, crypto.randomBytes(32).toString("hex"), "utf8");

  const received = [];
  let connections = 0;
  const rogue = net.createServer((socket) => {
    connections += 1;
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
  });
  await new Promise((resolve) => rogue.listen(`\\\\.\\pipe\\${pipeName}`, resolve));

  // A pid that is definitely not ours and (almost certainly) not a live pipe
  // server. The host must compare and refuse.
  const wrongDaemonPid = 4;
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", ELEVATED_HOST_SCRIPT,
    "-PipeName", pipeName,
    "-SecretFile", secretFile,
    "-DaemonPid", String(wrongDaemonPid),
    "-LifetimeSeconds", "30",
    "-SchemaFile", ELEVATED_OPERATION_SCHEMA_PATH
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  try {
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 25000);
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });

    assert.notEqual(exitCode, "timeout",
      "the host must exit rather than keep retrying against a pipe it cannot attribute to the daemon");
    assert.equal(received.join(""), "",
      "the host must not send a hello, a pid, a token or an HMAC proof to an unverified pipe server");
    assert.ok(connections <= 1, "at most one connection attempt, and nothing disclosed on it");
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await new Promise((resolve) => rogue.close(resolve));
    await fs.rm(secretDirectory, { recursive: true, force: true });
  }
});

test("SHUTDOWN really terminates the process and the session cannot be resumed", { skip: !onWindows }, async () => {
  const client = new TestHostClient({ lifetimeMs: 120000 });
  try {
    await client.start();
    const pid = client.hostPid;
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(await isProcessAlive(pid), true, "the host process must be running before teardown");
    const pipeName = client.pipeName;

    const teardown = await client.shutdown({ reason: "test" });
    assert.equal(teardown.ok, true);
    assert.equal(teardown.exited, true, "teardown must be proven against the OS, not against socket state");
    assert.equal(teardown.shutdownAcknowledged, true, "the host must acknowledge the authenticated SHUTDOWN");

    // The real OS check, not a mock and not `client.active`.
    assert.equal(await isProcessAlive(pid), false, "the high-integrity process must actually be gone");

    // A revoked session is not resumable.
    await assert.rejects(() => client.request("host.health", {}), /revoked/i);
    await assert.rejects(() => client.start(), /revoked/i);

    // THE REGRESSION TEST FOR THE HIGH FINDING: stand a replacement server up
    // under the freed name and confirm nothing reconnects to it. Before the
    // fix, the still-running host would have reconnected here and handed over
    // its token.
    const takeover = net.createServer((socket) => {
      takeover.gotConnection = true;
      socket.on("data", (chunk) => { takeover.received = `${takeover.received ?? ""}${chunk}`; });
    });
    takeover.gotConnection = false;
    await new Promise((resolve, reject) => {
      takeover.once("error", reject);
      takeover.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(takeover.gotConnection, false,
        "a terminated host must not reconnect to a replacement server on the freed pipe name");
      assert.equal(takeover.received, undefined, "and must therefore disclose nothing to it");
    } finally {
      await new Promise((resolve) => takeover.close(resolve));
    }
  } finally {
    await client.forceKill();
  }
});

test("the host validates parameters itself, even when the daemon-side check is bypassed", { skip: !onWindows }, async () => {
  await withRealHost({ lifetimeMs: 60000 }, async (client) => {
    // These frames are correctly authenticated and never pass through
    // PrivilegedOperationHelper.execute(), so ONLY the host's own validation
    // stands between them and a high-integrity process. The v1 host had none.
    const cases = [
      ["system.hostsEntry.add", { scope: "example.com", address: ":::" }, /valid IPv4 or IPv6/i],
      ["system.hostsEntry.add", { scope: "example.com", address: "127.0.0.1\n10.0.0.1 evil.com" }, /valid IPv4 or IPv6/i],
      ["system.hostsEntry.add", { scope: "-bad.example.com", address: "127.0.0.1" }, /valid hostname/i],
      ["service.setStartupType", { scope: "Spooler", startupType: "Whenever" }, /Automatic, Manual, or Disabled/i],
      ["system.setEnvironmentVariable", { scope: "SYSCORA_HOSTCHECK", value: "x".repeat(9000) }, /8192/],
      ["system.setEnvironmentVariable", { scope: "SYSCORA_HOSTCHECK", value: "ok", extra: "smuggled" }, /does not accept/i],
      ["system.setEnvironmentVariable", { scope: "bad;name", value: "ok" }, /valid machine variable name/i],
      ["service.restart", { scope: "Spooler & calc.exe" }, /valid service name/i],
      ["definitely.not.an.operation", { scope: "x" }, /not in the shared elevated-operation schema/i]
    ];

    for (const [operation, params, expected] of cases) {
      const frame = client.buildFrame(operation, params);
      await assert.rejects(
        () => client.sendRawFrame(frame),
        expected,
        `the host must reject ${operation} with ${JSON.stringify(params)}`
      );
    }

    // The daemon-side validator agrees on every one of them, which is the
    // point of the shared schema: two enforcements, one specification.
    for (const [operation, params] of cases) {
      const { scope, ...rest } = params;
      assert.equal(
        validateAgainstSchema(operation, scope, rest).valid,
        false,
        `the daemon-side validator must also reject ${operation}`
      );
    }
  });
});

test("a replayed request frame is rejected by the host", { skip: !onWindows }, async () => {
  await withRealHost({ lifetimeMs: 60000 }, async (client) => {
    const frame = client.buildFrame("host.health", {});
    const first = await client.sendRawFrame(frame);
    assert.equal(first.ok, true);

    // Byte-for-byte replay of a frame that was already accepted. The sequence
    // number is covered by the MAC, so it cannot be bumped without the secret.
    const replay = { ...frame, id: crypto.randomUUID() };
    await assert.rejects(
      () => client.sendRawFrame(replay),
      /Replayed or out-of-order request sequence/i
    );

    // Tampering with the payload while keeping the MAC also fails.
    const tampered = client.buildFrame("host.health", {});
    tampered.operation = "system.setEnvironmentVariable";
    tampered.paramsJson = JSON.stringify({ scope: "SYSCORA_TAMPER", value: "owned" });
    await assert.rejects(
      () => client.sendRawFrame(tampered),
      /request authentication failed/i
    );
  });
});

test("a token from one session is rejected by another session's host", { skip: !onWindows }, async () => {
  // Two independent sessions. A frame minted with session A's secret and nonce
  // is offered to session B. Because the MAC binds both, B rejects it -- and
  // because no bearer token is ever transmitted, capturing A's handshake would
  // not have helped either.
  const alpha = new TestHostClient({ lifetimeMs: 60000 });
  const beta = new TestHostClient({ lifetimeMs: 60000 });
  try {
    await alpha.start();
    await beta.start();

    const alphaFrame = alpha.buildFrame("host.health", {});
    // Replay it into beta's connection verbatim.
    const crossSession = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      beta.pending.set(alphaFrame.id, { resolve, reject, timer });
      beta.socket.write(`${JSON.stringify(alphaFrame)}\n`, "utf8");
    });
    await assert.rejects(() => crossSession, /request authentication failed/i);

    // Beta still works for its own correctly-authenticated traffic.
    const health = await beta.request("host.health", {});
    assert.equal(health.ok, true);
  } finally {
    for (const client of [alpha, beta]) {
      if (!client.revoked) { try { await client.shutdown({ reason: "test-cleanup" }); } catch { /* ignore */ } }
      await client.forceKill();
    }
  }
});

test("a request arriving after the deadline is rejected, not executed", { skip: !onWindows }, async () => {
  // The host is given a 3-second deadline while the client believes it has the
  // 30-second minimum, so the connection is opened well before expiry and the
  // request is submitted after it. v1 computed its deadline once, before the
  // blocking ReadLine, so a connection opened in time could work indefinitely.
  const client = new TestHostClient({ lifetimeMs: 30000, hostLifetimeSeconds: 3 });
  try {
    await client.start();
    const pid = client.hostPid;

    const before = await client.request("host.health", {});
    assert.equal(before.ok, true, "requests before the deadline are served normally");

    await new Promise((resolve) => setTimeout(resolve, 4200));

    await assert.rejects(
      () => client.request("system.setEnvironmentVariable", { scope: "SYSCORA_DEADLINE", value: "late" }),
      /lifetime expired|connection closed/i,
      "a request submitted after the deadline must not be executed"
    );

    // And the host must have terminated itself rather than lingering.
    const exit = await waitForProcessExit(pid, { timeoutMs: 8000 });
    assert.equal(exit.exited, true, "an expired host must exit on its own");
  } finally {
    // shutdown() also releases the retained pipe listener; skipping it leaks an
    // open handle and the test process never exits.
    try { await client.shutdown({ reason: "test-cleanup" }); } catch { /* host already exited */ }
    await client.forceKill();
  }
});

test("the host's deadline is clamped to the hard cap, not the requested lifetime", { skip: !onWindows }, async () => {
  // A caller asking for 30 days must get 8 hours at the actual process, which
  // is the agreement between the grant store's cap and the running host that
  // the review found missing.
  await withRealHost({ lifetimeMs: 30 * 24 * 60 * 60 * 1000 }, async (client) => {
    const health = await client.request("host.health", {});
    const capSeconds = MAX_HOST_LIFETIME_MS / 1000;
    assert.ok(
      health.remainingSeconds <= capSeconds + 5 && health.remainingSeconds > capSeconds - 120,
      `the host deadline must be the 8h cap, got ${health.remainingSeconds}s`
    );
    assert.equal(client._effectiveLifetimeMs, MAX_HOST_LIFETIME_MS);
  });
});

test("a second peer cannot join a live session's pipe", { skip: !onWindows }, async () => {
  await withRealHost({ lifetimeMs: 60000 }, async (client) => {
    const rejected = [];
    client.onSecurityEvent = (event, detail) => rejected.push({ event, detail });

    // The listener is deliberately held open for the whole session so the name
    // cannot be squatted; an extra connection must be refused, not served.
    const intruder = net.connect(`\\\\.\\pipe\\${client.pipeName}`);
    const closed = new Promise((resolve) => {
      intruder.once("close", resolve);
      intruder.once("error", resolve);
    });
    await closed;

    // The genuine session is unaffected.
    const health = await client.request("host.health", {});
    assert.equal(health.ok, true);
    assert.ok(
      rejected.some((entry) => entry.event === "ELEVATION_PEER_REJECTED"),
      "an extra peer on a live session's pipe must be recorded, not silently dropped"
    );
  });
});
