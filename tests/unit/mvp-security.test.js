import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveData, REDACTED } from "../../packages/shared-types/src/redaction.js";
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


test("runtime persists redacted session and audit payloads", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-mvp-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const runtime = createRuntime(workspace);
    // THE SECRET IS PUT ON A SESSION DIRECTLY, NOT PLANNED ONTO ONE.
    //
    // This used to drive `runSetProjectEnvVariable`, which reached the staged
    // pipeline and let it build the session. That pipeline is deleted, so the
    // fixture no longer produces a session carrying an intent — and the test
    // failed on the fixture rather than on the property it exists to prove.
    //
    // The property is unchanged and is exactly what a user cares about: a secret
    // value handed to this runtime must not reach the session store or the audit
    // log in the clear. That is `persistSession`'s redaction, which is live, and
    // it is now exercised with nothing between the secret and the disk.
    const session = runtime._createSession({});
    session.intent = {
      intentType: "SET_PROJECT_ENV",
      rawText: "Set OPENAI_API_KEY for the current project",
      entities: {
        workspacePath: workspace,
        key: "OPENAI_API_KEY",
        value: "top-secret-value"
      }
    };
    await runtime.addSessionEvent(session, "INTENT_RECEIVED", { intent: session.intent });
    await runtime.persistSession(session);

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




