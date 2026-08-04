/**
 * LIVE elevation check.
 *
 * Raises a REAL Windows UAC prompt, verifies the elevated host actually runs at
 * high integrity, performs one reversible elevated operation, tears the host
 * down, and then ATTACKS the torn-down session to prove the teardown was real.
 * Accept the prompt when it appears.
 *
 *   node tests/live/elevation-live.mjs
 *
 * What changed after the security review, and why:
 *
 *   - The previous version "restored" the test machine variable by setting it
 *     to an empty string. That is not a restore: it left a permanent empty
 *     machine-scoped variable behind, and if the variable had already existed
 *     with a real value it destroyed it. This version captures the exact prior
 *     state -- including "did not exist at all" -- and puts it back.
 *
 *   - The previous version treated `host.active === false` as proof of
 *     revocation. That flag only reports the daemon's own socket state and was
 *     true even while the high-integrity PowerShell process was still running
 *     and retrying its reconnect loop. This version waits for the real OS
 *     process id to disappear.
 *
 *   - The variable name is randomised per run so repeated or parallel runs
 *     cannot collide, and a leftover from a previously failed run cannot make a
 *     broken run look clean.
 *
 *   - Audit assertions go through a real AuditRepository and the hash chain is
 *     verified, rather than accepting the absence of a repository.
 *
 *   - A new adversarial step stands up a replacement pipe server under the
 *     freed pipe name after revocation, and requires that nothing connects to
 *     it. This is the direct regression test for the HIGH finding.
 */
import path from "node:path";
import os from "node:os";
import net from "node:net";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  ElevatedHostClient,
  isProcessAlive,
  waitForProcessExit
} from "../../os-adapters/windows-host/src/elevated-client.js";
import { ElevationGrantStore, ELEVATION_SCOPE_ALL } from "../../packages/permission-broker/src/elevation-grant-store.js";
import { ElevationService } from "../../packages/permission-broker/src/elevation-service.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { ApprovalTokenStore } from "../../packages/permission-broker/src/approval-token-store.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { PrivilegedOperationHelper, PrivilegedExecutionMode } from "../../packages/privileged-helpers/src/index.js";

// Randomised per run: two runs must not be able to collide, and a leftover
// value from an earlier failed run must not be mistaken for this run's state.
const TEST_VARIABLE = `SYSCORA_ELEVATION_LIVE_${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const SESSION_ID = `live-session-${crypto.randomUUID()}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-elevation-live-"));

let passed = false;
let host = null;
let hostPid = null;
let pipeName = null;
const checks = {};

/** Read a machine-scoped environment variable WITHOUT elevation. */
async function readMachineVariable(name) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      `$v = [Environment]::GetEnvironmentVariable('${name}', 'Machine');`
      + "if ($null -eq $v) { Write-Output 'SYSCORA_ABSENT' } else { Write-Output ('SYSCORA_VALUE=' + $v) }"
    ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("exit", () => {
      const match = /SYSCORA_VALUE=(.*)/.exec(output);
      if (match) resolve({ existed: true, value: match[1].trim() });
      else resolve({ existed: false, value: null });
    });
    child.once("error", () => resolve({ existed: false, value: null }));
  });
}

console.log("=== ELEVATION LIVE CHECK ===");
console.log(`test variable: ${TEST_VARIABLE}`);
console.log("A Windows UAC prompt will appear. Accept it to continue.\n");

// Capture the EXACT prior state before anything touches the machine, so the
// finally block can restore it faithfully.
const priorState = await readMachineVariable(TEST_VARIABLE);
console.log(`prior state of ${TEST_VARIABLE}: ${priorState.existed ? `present ("${priorState.value}")` : "absent"}`);

// A real audit repository with a real hash chain, in a temp directory.
const auditRepository = new AuditRepository(path.join(directory, "audit"));
await auditRepository.ensureSchema();

try {
  host = new ElevatedHostClient({ lifetimeMs: 3 * 60 * 1000 });
  const grantStore = new ElevationGrantStore(directory);
  const service = new ElevationService({
    elevationGrantStore: grantStore,
    elevatedHost: host,
    auditRepository
  });

  const startedAt = Date.now();
  const elevated = await service.elevateSession({
    sessionId: SESSION_ID,
    operations: [ELEVATION_SCOPE_ALL],
    userConsented: true,
    reason: "live elevation verification"
  });
  console.log(`elevateSession -> ${JSON.stringify(elevated.elevated)} in ${Date.now() - startedAt}ms`);
  if (!elevated.elevated) throw new Error(`Elevation failed: ${elevated.reason}`);

  hostPid = host.hostPid;
  pipeName = host.pipeName;
  console.log("grant:", JSON.stringify({
    grantId: elevated.grant.grantId,
    consentKind: elevated.grant.consentKind,
    expiresAt: elevated.grant.expiresAt,
    unattended: elevated.grant.unattended
  }));
  console.log(`elevated host OS pid (captured via Start-Process -PassThru): ${hostPid}`);

  const health = await host.request("host.health", {});
  console.log("elevated host health:", JSON.stringify(health));
  checks.elevated = elevated.elevated === true;
  checks.highIntegrity = health.elevated === true;
  checks.protocolV2 = health.protocol === "syscora-elevated-host/2";
  checks.pidMatches = health.pid === hostPid;
  if (!checks.highIntegrity) throw new Error("Host is not running elevated");
  if (!checks.pidMatches) throw new Error(`Host pid ${health.pid} does not match launch pid ${hostPid}`);

  // The process must genuinely exist right now, so "it is gone later" means
  // something.
  checks.processRunningBefore = await isProcessAlive(hostPid);
  console.log(`elevated process ${hostPid} alive before teardown: ${checks.processRunningBefore}`);

  // --- one real elevated operation, through the full privileged-helper path ---
  const broker = new PermissionBroker({ approvalTokenStore: new ApprovalTokenStore(directory) });
  const helper = new PrivilegedOperationHelper({
    permissionBroker: broker,
    adapter: null,
    elevatedHost: host,
    elevationGrantStore: grantStore,
    auditRepository
  });
  const token = await broker.issuePrivilegeToken({
    sessionId: SESSION_ID, operation: "system.setEnvironmentVariable", scope: TEST_VARIABLE, approved: true
  });
  const committed = await helper.execute("system.setEnvironmentVariable", TEST_VARIABLE, {
    sessionId: SESSION_ID,
    token: token.token,
    params: { value: "elevated-ok" },
    mode: PrivilegedExecutionMode.COMMIT
  });
  console.log("elevated COMMIT:", JSON.stringify({
    success: committed.success, elevated: committed.elevated, reason: committed.reason
  }));
  if (!committed.success) throw new Error(`Elevated operation failed: ${committed.reason}`);
  checks.operationPerformed = committed.success === true;

  // Independently confirm the machine actually changed.
  const afterWrite = await readMachineVariable(TEST_VARIABLE);
  console.log(`independent read-back: ${JSON.stringify(afterWrite)}`);
  checks.machineActuallyChanged = afterWrite.existed && afterWrite.value === "elevated-ok";

  // --- host-side validation, with the daemon-side validator bypassed ---
  // Proves the high-integrity process is authoritative over its own inputs.
  let hostRejected = null;
  try {
    await host.request("system.hostsEntry.add", { scope: "example.com", address: ":::" });
  } catch (error) {
    hostRejected = error.message;
  }
  console.log(`host-side validation of a malformed address: ${hostRejected ?? "ACCEPTED (BAD)"}`);
  checks.hostValidatesItself = Boolean(hostRejected && /valid IPv4 or IPv6/i.test(hostRejected));

  // --- revocation, verified against the OS ---
  const revoked = await service.revokeSession(SESSION_ID, { reason: "live-check-complete" });
  console.log("revokeSession ->", JSON.stringify(revoked));
  const afterRevoke = await grantStore.check({ sessionId: SESSION_ID, operation: null });
  checks.grantRevoked = afterRevoke.elevated === false;
  checks.teardownReportedClean = revoked.teardownFailed !== true && revoked.hostTerminated === true;

  // THE REAL CHECK: the OS says the process is gone. Not `host.active`.
  const exitCheck = await waitForProcessExit(hostPid, { timeoutMs: 15000 });
  checks.processActuallyTerminated = exitCheck.exited === true;
  console.log(`elevated process ${hostPid} after revoke: ${exitCheck.exited ? "TERMINATED" : `STILL RUNNING (${exitCheck.reason})`}`);

  // --- ADVERSARIAL: pipe takeover after revoke ---
  // Stand a replacement server up under the freed pipe name. Before the fix the
  // still-running elevated host would have reconnected here and handed over its
  // bearer token to whoever answered.
  console.log(`\n--- adversarial: attempting pipe takeover on ${pipeName} ---`);
  const takeover = net.createServer((socket) => {
    takeover.connected = true;
    socket.on("data", (chunk) => { takeover.received = `${takeover.received ?? ""}${chunk}`; });
  });
  takeover.connected = false;
  let takeoverBound = false;
  try {
    await new Promise((resolve, reject) => {
      takeover.once("error", reject);
      takeover.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
    });
    takeoverBound = true;
    console.log("rogue listener bound to the freed pipe name; waiting 5s for a reconnect attempt...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(`rogue listener received a connection: ${takeover.connected}`);
    console.log(`rogue listener received bytes: ${takeover.received ? JSON.stringify(takeover.received) : "none"}`);
    checks.noTakeoverReconnect = takeover.connected === false && takeover.received === undefined;
  } catch (error) {
    // Failing to bind is also a pass: it means the daemon is still holding the
    // name, which is the quarantine behaviour when teardown could not be proven.
    console.log(`rogue listener could not bind the pipe name (${error.code ?? error.message}); the daemon still holds it.`);
    checks.noTakeoverReconnect = true;
  } finally {
    if (takeoverBound) await new Promise((resolve) => takeover.close(resolve));
  }

  // The revoked session must also be unusable from the daemon side.
  let resumeError = null;
  try { await host.request("host.health", {}); } catch (error) { resumeError = error.code ?? error.message; }
  checks.sessionNotResumable = resumeError === "ELEVATION_REVOKED";
  console.log(`resuming the revoked session -> ${resumeError}`);

  // --- audit chain ---
  const chain = await auditRepository.verifyChain({});
  const allEvents = await auditRepository.readAll();
  const eventTypes = allEvents.map((entry) => entry.eventType ?? entry.event_type);
  const actionRecords = allEvents.filter((entry) => (entry.eventType ?? entry.event_type) === "ELEVATED_ACTION_EXECUTED");
  checks.auditChainValid = chain.valid === true;
  checks.auditHasLifecycle = ["ELEVATION_REQUESTED", "ELEVATION_GRANTED", "ELEVATION_REVOKED"]
    .every((type) => eventTypes.includes(type));
  checks.auditHasActionRecord = actionRecords.length >= 1;
  // The commitment must SURVIVE the repository's redaction. It is the only
  // thing binding a specific approval token to this specific machine change,
  // and a field name containing "token" gets replaced with ***REDACTED***,
  // which silently voids that binding.
  const actionPayload = actionRecords.length > 0
    ? (actionRecords[0].payload ?? JSON.parse(actionRecords[0].payload_json ?? "{}"))
    : {};
  checks.commitmentSurvivesRedaction = /^[0-9a-f]{64}$/.test(String(actionPayload.approvalCommitmentSha256 ?? ""));
  checks.commitmentMatchesToken =
    actionPayload.approvalCommitmentSha256 === crypto.createHash("sha256").update(String(token.token), "utf8").digest("hex");
  // ...while the secret material itself must NOT appear anywhere in the chain.
  checks.noRawTokenInAudit = !JSON.stringify(allEvents).includes(token.token);

  console.log("\naudit chain verify:", JSON.stringify({ valid: chain.valid, length: chain.length, error: chain.error ?? null }));
  console.log("audit events:", eventTypes.join(", "));
  if (actionRecords.length > 0) {
    const payload = actionRecords[0].payload ?? JSON.parse(actionRecords[0].payload_json ?? "{}");
    console.log("ELEVATED_ACTION_EXECUTED payload:", JSON.stringify({
      operation: payload.operation,
      scope: payload.scope,
      mode: payload.mode,
      elevationGrantId: payload.elevationGrantId,
      outcome: payload.outcome,
      startedAt: payload.startedAt,
      endedAt: payload.endedAt,
      approvalCommitmentSha256: payload.approvalCommitmentSha256?.slice(0, 16) + "...",
      elevatedHostPid: payload.elevatedHostPid
    }));
  }

  console.log("\n--- gate ---");
  for (const [name, value] of Object.entries(checks)) {
    console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  }
  passed = Object.values(checks).every(Boolean);
} catch (error) {
  console.error("\nERROR:", error.message, error.code ? `(${error.code})` : "");
  console.error(error.stack);
} finally {
  // Restore the EXACT prior state. This needs elevation, so it is done through
  // a short-lived elevated host if the original one is already gone. If the
  // variable did not exist before, it is removed rather than blanked.
  try {
    const current = await readMachineVariable(TEST_VARIABLE);
    const needsRestore = current.existed !== priorState.existed || current.value !== priorState.value;
    if (needsRestore) {
      console.log(`\nrestoring ${TEST_VARIABLE} to its prior state (${priorState.existed ? `"${priorState.value}"` : "absent"})...`);
      console.log("A second UAC prompt may appear for the restore. Accept it.");
      const restoreScript = priorState.existed
        ? `[Environment]::SetEnvironmentVariable('${TEST_VARIABLE}', '${String(priorState.value).replace(/'/g, "''")}', 'Machine')`
        // $null REMOVES the variable. Setting '' does not -- it leaves a
        // permanent empty machine variable behind, which is exactly the bug
        // the previous version of this script shipped.
        : `[Environment]::SetEnvironmentVariable('${TEST_VARIABLE}', $null, 'Machine')`;
      // -EncodedCommand, so the inner script survives the outer shell intact.
      // Passing it as a quoted string would let the OUTER PowerShell expand
      // `$null` to an empty string before the inner one ever saw it, silently
      // turning "remove the variable" into "blank the variable".
      const encoded = Buffer.from(restoreScript, "utf16le").toString("base64");
      await new Promise((resolve) => {
        const child = spawn("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
          "$ErrorActionPreference='Stop'; $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru "
          + `-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'); `
          + "$p.WaitForExit(); exit $p.ExitCode"
        ], { stdio: "ignore", windowsHide: true });
        child.once("exit", resolve);
        child.once("error", resolve);
      });
      const restored = await readMachineVariable(TEST_VARIABLE);
      const ok = restored.existed === priorState.existed && restored.value === priorState.value;
      console.log(`restore ${ok ? "OK" : "FAILED"}: ${JSON.stringify(restored)}`);
      if (!ok) {
        console.error(`[WARNING] ${TEST_VARIABLE} could not be restored. Remove it manually.`);
        passed = false;
      }
    } else {
      console.log(`\n${TEST_VARIABLE} already matches its prior state; nothing to restore.`);
    }
  } catch (error) {
    console.error("[WARNING] restore step failed:", error.message);
    passed = false;
  }

  try { if (host && !host.revoked) await host.shutdown({ reason: "live-check-cleanup" }); } catch { /* already gone */ }
  if (hostPid != null) {
    const finalCheck = await isProcessAlive(hostPid);
    console.log(`final: elevated process ${hostPid} alive = ${finalCheck}`);
    if (finalCheck) {
      console.error(`[WARNING] elevated process ${hostPid} is still running. Kill it manually.`);
      passed = false;
    }
  }
  try { await auditRepository.close?.(); } catch { /* fine */ }
  await fs.rm(directory, { recursive: true, force: true });
}

console.log(passed ? "\nELEVATION LIVE: PASS" : "\nELEVATION LIVE: FAIL");
process.exit(passed ? 0 : 1);
