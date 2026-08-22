import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveData, REDACTED } from "../../packages/shared-types/src/redaction.js";
import { RiskEngine } from "../../packages/risk-engine/src/index.js";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

test("redactSensitiveData masks sensitive fields recursively", () => {
  const input = {
    value: "secret-1",
    nested: {
      token: "secret-2",
      keep: "visible"
    },
    list: [
      { password: "secret-3" },
      { key: "visible-name" }
    ]
  };

  const output = redactSensitiveData(input);
  assert.equal(output.value, REDACTED);
  assert.equal(output.nested.token, REDACTED);
  assert.equal(output.nested.keep, "visible");
  assert.equal(output.list[0].password, REDACTED);
  assert.equal(output.list[1].key, "visible-name");
});

// A COUNT IS NOT A CREDENTIAL.
//
// `/token/i` matched `tokensIn`, `tokensOut`, `tokensCached` and `tokensFresh`,
// so every persisted session recorded its own cost as "***REDACTED***" — 1,673
// of the 1,998 rows on this machine. The product's headline claims are about
// cost per task, and the record of it was being destroyed on the way to disk.
test("token COUNTS survive persistence while auth tokens do not", () => {
  const output = redactSensitiveData({
    metrics: { tokensIn: 3324, tokensOut: 8584, tokensCached: 49536, tokensFresh: 227 },
    auth: { token: "sk-notarealkey0000", accessToken: "ya29.notarealtoken" },
    // A number under an unambiguous name stays covered: a numeric PIN is still
    // a credential, and this is the case the shape rule must not give away.
    login: { password: 4821, secret: 99 }
  });

  assert.equal(output.metrics.tokensIn, 3324, "a token COUNT is a measurement");
  assert.equal(output.metrics.tokensOut, 8584);
  assert.equal(output.metrics.tokensCached, 49536);
  assert.equal(output.metrics.tokensFresh, 227);
  assert.equal(output.auth.token, REDACTED, "a token that is a string is still a credential");
  assert.equal(output.auth.accessToken, REDACTED);
  assert.equal(output.login.password, REDACTED, "an unambiguous name is redacted at any type");
  assert.equal(output.login.secret, REDACTED);
});

test("risk engine evaluates from plan without context.intent", () => {
  const engine = new RiskEngine();
  const result = engine.assess(
    {
      taskGraph: {
        tasks: [
          {
            action: {
              parameters: {
                key: "OPENAI_API_KEY"
              }
            }
          }
        ]
      }
    },
    {
      currentEnvironment: {
        exists: false
      }
    }
  );

  assert.equal(result.overallRisk, "MEDIUM");
  assert.equal(result.evidence.containsSensitiveValue, true);
});

test("runtime persists redacted session and audit payloads", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-mvp-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtime = createRuntime(workspace);
    await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set OPENAI_API_KEY for the current project",
        entities: {
          workspacePath: workspace,
          key: "OPENAI_API_KEY",
          value: "top-secret-value"
        }
      },
      { autoApprove: true }
    );

    const sessions = await runtime.sessionStore.list();
    const persistedSession = sessions.at(-1);
    assert.equal(persistedSession.intent.entities.value, REDACTED);

    const auditEvents = await runtime.auditRepository.readAll();
    const serializedAudit = JSON.stringify(auditEvents);
    assert.equal(serializedAudit.includes("top-secret-value"), false);
    assert.equal(serializedAudit.includes(REDACTED), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime can manually rollback latest session and emits observation", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-mvp-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtime = createRuntime(workspace);
    const session = await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set APP_MODE for the current project",
        entities: {
          workspacePath: workspace,
          key: "APP_MODE",
          value: "dev"
        }
      },
      { autoApprove: true }
    );

    const auditEvents = await runtime.auditRepository.readAll();
    const hasObservation = auditEvents.some((event) => event.eventType === "OBSERVATION_COLLECTED");
    assert.equal(hasObservation, true);

    const rolledBack = await runtime.rollbackSessionById(session.sessionId);
    assert.equal(rolledBack.finalResponse.status, "ROLLED_BACK");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime can resume in-flight approval session after restart", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-resume-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtimeBeforeRestart = createRuntime(workspace);
    // Editing an EXISTING file is one of the three actions that still require
    // approval under the autonomous-execution policy; pre-create .env so the env
    // set parks in AWAITING_APPROVAL (creating a new .env would be autonomous).
    await fs.writeFile(path.join(workspace, ".env"), "SEED=1\n", "utf8");
    const awaiting = await runtimeBeforeRestart.runSetProjectEnvVariable(
      {
        rawText: "Set FEATURE_FLAG for the current project",
        entities: {
          workspacePath: workspace,
          key: "FEATURE_FLAG",
          value: "true"
        }
      },
      { autoApprove: false }
    );

    assert.equal(awaiting.currentState, "REQUEST_CONFIRMATION_IF_REQUIRED");
    assert.equal(awaiting.finalResponse.status, "AWAITING_APPROVAL");

    const runtimeAfterRestart = createRuntime(workspace);
    const resumed = await runtimeAfterRestart.resumeSessionById(awaiting.sessionId, { autoApprove: true });
    assert.equal(resumed.finalResponse.status, "COMPLETED");
    assert.equal(resumed.currentState, "COMPLETED");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resume voids a prior approval if the plan changed after approval was requested", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-mutate-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtime = createRuntime(workspace);
    // Editing an existing file still requires approval — pre-create .env so the set parks.
    await fs.writeFile(path.join(workspace, ".env"), "SEED=1\n", "utf8");
    const awaiting = await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set FEATURE_FLAG for the current project",
        entities: { workspacePath: workspace, key: "FEATURE_FLAG", value: "true" }
      },
      { autoApprove: false }
    );
    assert.equal(awaiting.finalResponse.status, "AWAITING_APPROVAL");
    assert.ok(awaiting.approvalCommitment, "approval must be bound to a cryptographic commitment");

    // Tamper with the suspended session's plan (different target key) before
    // resuming. The approval was shown for FEATURE_FLAG, not HIJACKED_KEY.
    const session = await runtime.sessionStore.get(awaiting.sessionId);
    session.plan.taskGraph.tasks[0].inputs.key = "HIJACKED_KEY";
    await runtime.sessionStore.save(session);

    const resumed = await runtime.resumeSessionById(awaiting.sessionId, { autoApprove: true });
    // The mutated plan must NOT auto-run on the stale approval; it re-gates.
    assert.equal(resumed.finalResponse.status, "AWAITING_APPROVAL");
    assert.notEqual(resumed.currentState, "COMPLETED");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime supports explicit pause and cancel controls", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-control-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtime = createRuntime(workspace);
    // Editing an existing file still requires approval — pre-create .env so the sets park.
    await fs.writeFile(path.join(workspace, ".env"), "SEED=1\n", "utf8");
    const awaiting = await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set CONTROL_TEST for the current project",
        entities: {
          workspacePath: workspace,
          key: "CONTROL_TEST",
          value: "1"
        }
      },
      { autoApprove: false }
    );

    const paused = await runtime.pauseSessionById(awaiting.sessionId, "Pause test");
    assert.equal(paused.currentState, "PAUSED");
    assert.equal(paused.finalResponse.status, "PAUSED");

    const resumed = await runtime.resumeSessionById(awaiting.sessionId, { autoApprove: true });
    assert.equal(resumed.currentState, "COMPLETED");

    const second = await runtime.runSetProjectEnvVariable(
      {
        rawText: "Set CONTROL_TEST_2 for the current project",
        entities: {
          workspacePath: workspace,
          key: "CONTROL_TEST_2",
          value: "2"
        }
      },
      { autoApprove: false }
    );
    const cancelled = await runtime.cancelSessionById(second.sessionId, "Cancel test");
    assert.equal(cancelled.currentState, "CANCELLED");
    assert.equal(cancelled.finalResponse.status, "CANCELLED");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
