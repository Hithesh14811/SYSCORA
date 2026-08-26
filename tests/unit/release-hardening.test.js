import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the current desktop sends explicit access policy instead of blanket autoApprove", () => {
  const source = read("apps/desktop/demo.js");
  const submitStart = source.indexOf("async function submit(");
  const submitEnd = source.indexOf("async function resume(", submitStart);
  const submit = source.slice(submitStart, submitEnd);
  assert.match(submit, /approvalMode/);
  assert.match(submit, /developerMode/);
  assert.match(submit, /shellExecutionMode/);
  assert.doesNotMatch(submit, /autoApprove\s*:\s*true/);
});

test("first-run privacy onboarding cannot be dismissed before acknowledgement", () => {
  const source = read("apps/desktop/demo.js");
  assert.match(source, /onboardingCancel\.hidden\s*=\s*firstRun/);
  assert.match(source, /ONBOARDING_STORAGE_KEY,\s*"1"/);
});

test("Electron production renderer hardening is explicit", () => {
  const source = read("apps/desktop-shell/src/main.js");
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /devTools:\s*developerToolsAllowed/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /will-attach-webview/);
});

test("the local renderer is served with a script-restricting CSP", () => {
  const source = read("apps/daemon/src/server.js");
  assert.match(source, /"script-src 'self'"/);
  assert.match(source, /"object-src 'none'"/);
  assert.match(source, /"frame-ancestors 'none'"/);
  assert.match(source, /"x-content-type-options": "nosniff"/);
});

test("Electron is pinned to the reviewed supported release", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.devDependencies.electron, "43.4.1");
});
