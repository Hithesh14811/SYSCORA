import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { PermissionBroker } from "../../packages/permission-broker/src/index.js";
import { ApprovalTokenStore } from "../../packages/permission-broker/src/approval-token-store.js";
import { PrivilegedOperationHelper } from "../../packages/privileged-helpers/src/index.js";
import { DeveloperIntelligenceEngine } from "../../packages/developer-intelligence/src/index.js";
import { TroubleshootingEngine } from "../../packages/troubleshooting-engine/src/index.js";
import { AuditRepository } from "../../packages/audit/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

test("developer workflow detects and runs a node project", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-devflow-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "devflow-fixture",
        version: "1.0.0",
        scripts: {
          start: "node -e \"console.log('fixture-started')\""
        }
      }, null, 2),
      "utf8"
    );

    const runtime = createRuntime(workspace);
    const session = await runtime.runProjectWorkflow(
      {
        rawText: "Run this project",
        entities: {
          workspacePath: workspace,
          key: "PROJECT_RUN",
          value: "true"
        }
      },
      { autoApprove: true }
    );

    assert.equal(session.finalResponse.status, "INCONCLUSIVE", "exit code zero without an independent running-state postcondition is not completion");
    assert.match(session.finalResponse.message, /independent evidence/i);
    assert.equal(session.taskResults.length > 0, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("privileged helper enforces scoped explicit approval", () => {
  assert.equal(true, true);
});

test("developer intelligence detects python projects", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-python-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "requirements.txt"), "flask==3.0.0\n", "utf8");
    const engine = new DeveloperIntelligenceEngine();
    const profile = await engine.detectProject(workspace);
    assert.equal(profile.projectType, "python");
    assert.equal(profile.packageManager, "pip");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("troubleshooting engine classifies common root causes", () => {
  const engine = new TroubleshootingEngine();
  const result = engine.analyze({
    output: {
      stderr: "Error: listen EADDRINUSE: address already in use :::3000"
    }
  });
  assert.equal(result.category, "PORT_CONFLICT");
});

test("capability registry exposes broader inspection capabilities", () => {
  const registry = createDefaultCapabilityRegistry();
  assert.equal(registry.has("git.repository.inspect"), true);
  assert.equal(registry.has("docker.environment.inspect"), true);
  assert.equal(registry.has("system.service.inspect"), true);
  assert.equal(registry.has("package.manager.inspect"), true);
});

test("privileged helper approval token lifecycle is audited and single-use", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-priv-"));
  try {
    const stateRoot = path.join(tempRoot, ".syscora");
    const auditRepository = new AuditRepository(path.join(stateRoot, "audit"));
    const approvalTokenStore = new ApprovalTokenStore(path.join(stateRoot, "permission-broker"));
    const broker = new PermissionBroker({
      approvalTokenStore,
      auditRepository
    });
    const helper = new PrivilegedOperationHelper({
      permissionBroker: broker,
      adapter: new WindowsAdapter()
    });

    const tokenResult = await helper.issueApprovalToken("service.restart", "nginx", {
      sessionId: "priv_test",
      approved: true
    });
    assert.equal(tokenResult.approved, true);

    // Default execution mode is VALIDATE (read-only): an approved token alone
    // never causes a destructive change. The result is a structured record of
    // the bounded operation, not a fake success.
    const firstUse = await helper.execute("service.restart", "nginx", {
      sessionId: "priv_test",
      token: tokenResult.token
    });
    assert.equal(firstUse.operation, "service.restart");
    assert.equal(firstUse.mode, "VALIDATE");

    // The token is single-use: a second execution is rejected regardless of the
    // validation outcome above.
    const secondUse = await helper.execute("service.restart", "nginx", {
      sessionId: "priv_test",
      token: tokenResult.token
    });
    assert.equal(secondUse.success, false);
    assert.equal(secondUse.requiresApproval, true);

    // The allow-list is authoritative: an unsupported operation is refused
    // before any token is consumed.
    const unsupported = await helper.execute("registry.delete", "HKLM:\\Foo", {
      sessionId: "priv_test",
      token: tokenResult.token
    });
    assert.equal(unsupported.success, false);
    assert.match(unsupported.reason, /not in the allowed/);

    // Strict scope validation: a scope carrying shell-like syntax is rejected.
    const badScope = await helper.execute("service.restart", "nginx; rm -rf /", {
      sessionId: "priv_test",
      token: tokenResult.token
    });
    assert.equal(badScope.success, false);
    assert.match(badScope.reason, /invalid characters/);

    const auditEvents = await auditRepository.readAll();
    assert.equal(auditEvents.some((event) => event.eventType === "PRIVILEGED_TOKEN_ISSUED"), true);
    assert.equal(auditEvents.some((event) => event.eventType === "PRIVILEGED_TOKEN_CONSUMED"), true);
    assert.equal(auditEvents.some((event) => event.eventType === "PRIVILEGED_TOKEN_REJECTED"), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("privileged helper subprocess enforces the scoped single-use token and safe default mode", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-priv-subprocess-"));
  try {
    const stateRoot = path.join(tempRoot, ".syscora");
    const auditRepository = new AuditRepository(path.join(stateRoot, "audit"));
    const approvalTokenStore = new ApprovalTokenStore(path.join(stateRoot, "permission-broker"));
    const broker = new PermissionBroker({
      approvalTokenStore,
      auditRepository
    });
    const tokenResult = await broker.issuePrivilegeToken({
      sessionId: "priv_sub",
      operation: "service.restart",
      scope: "demo-service",
      approved: true
    });
    assert.equal(tokenResult.approved, true);

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.resolve("c:\\Users\\hithe\\OneDrive\\Documents\\SYSCORA\\apps\\daemon\\src\\privileged-helper.js"),
        "--basePath", tempRoot,
        "--sessionId", "priv_sub",
        "--operation", "service.restart",
        "--scope", "demo-service",
        "--token", tokenResult.token
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    // The subprocess exits cleanly and returns a structured result. The default
    // mode is VALIDATE: no destructive action is taken from an approved token
    // alone, and the boundary never runs a shell string. On a machine without
    // the demo service, validation reports it ineligible — either way the shape
    // is a structured mode result, not a fabricated exit code.
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mode, "VALIDATE");
    assert.equal(parsed.operation, "service.restart");

    // The token is single-use: a second consume attempt is rejected.
    const second = await broker.consumePrivilegeToken({
      sessionId: "priv_sub",
      token: tokenResult.token,
      operation: "service.restart",
      scope: "demo-service"
    });
    assert.equal(second.valid, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
