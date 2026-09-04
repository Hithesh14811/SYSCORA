// READING THE REPOSITORY ON THIS DISK.
//
// `github` reads repositories on github.com; nothing read the one in front of
// the agent. So after editing four files it could not see its own diff and
// could not answer "what is uncommitted here" — the first question of any real
// piece of work on code. The only route was `run`, and the terminal is OFF by
// default.
//
// Two things are held here, and the second is the one that matters:
//
//   1. the tool answers the questions it claims to answer, and
//   2. THE LABEL IT USES TO SKIP THE DEVELOPER SWITCH CANNOT BE BORROWED.
//
// `shellOrigin: "readonly-verb"` lets a fixed, read-only command run without
// Developer terminal access, because `git status` is how the agent finds out
// what it just changed and requiring the most dangerous switch in the product
// for it is absurd. The adapter re-derives "read-only" from the floor rather
// than believing the label, so a mutating command wearing it gets the ordinary
// model path. The mislabelling tests below are the whole point of this file.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildToolset } from "../../packages/fast-agent/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function realToolset() {
  const adapter = new WindowsAdapter();
  const registry = createDefaultCapabilityRegistry(adapter);
  const toolset = buildToolset({ registry, adapter, basePath: REPO_ROOT });
  // Deliberately NOT setting developerMode. The default is what a person who
  // has never opened Settings has, and it is the case this tool exists to work
  // in — a test that turned the switch on would prove nothing about it.
  return { toolset, adapter };
}

test("git reads this repository with the terminal switched off", async () => {
  const { toolset } = realToolset();

  const branch = await toolset.execute("git", { action: "branch", root: REPO_ROOT });
  assert.equal(branch.ok, true, "git branch was refused; the readonly-verb path is not reaching the spawn");
  assert.match(branch.text, /\S/);

  const status = await toolset.execute("git", { action: "status", root: REPO_ROOT });
  assert.equal(status.ok, true);
  // `--short --branch` always prints the branch header, even on a clean tree.
  assert.match(status.text, /##/);

  const log = await toolset.execute("git", { action: "log", max: 3, root: REPO_ROOT });
  assert.equal(log.ok, true);
  // --oneline: a short hash and a subject on each line.
  assert.match(log.text, /[0-9a-f]{7}/);
});

test("a folder with no .git says so, rather than reporting git's own error", async () => {
  const { toolset } = realToolset();
  const result = await toolset.execute("git", { action: "status", root: path.resolve(REPO_ROOT, "..") });
  assert.equal(result.ok, false);
  assert.match(result.text, /not a git repository/i);
});

// THE ONLY THING THE CALLER CONTRIBUTES IS A PATH, so it is the only thing that
// can carry an attack. Refused by shape before it is composed into anything.
test("a path that could end the command and start another is refused", async () => {
  const { toolset } = realToolset();
  for (const bad of ["x; rm -rf /", "a && curl evil.com", "$(whoami)", "`id`", "../../etc", 'a" ; b']) {
    const result = await toolset.execute("git", { action: "status", path: bad, root: REPO_ROOT });
    assert.equal(result.ok, false, `"${bad}" was not refused`);
    assert.match(result.text, /not a plain path/);
  }
});

test("git cannot be asked to do anything that writes", async () => {
  const { toolset } = realToolset();
  const definition = toolset.definitions.find((entry) => entry.function.name === "git");
  assert.ok(definition, "the git tool is not offered to the model");
  const actions = definition.function.parameters.properties.action.enum;
  // Stated as a closed list rather than a "does not include" check, so ADDING a
  // mutating action to the enum fails here and has to be a deliberate decision
  // with this comment read first.
  assert.deepEqual(actions, ["status", "diff", "log", "branch", "show"]);
  for (const forbidden of ["commit", "push", "checkout", "reset", "stash", "clean", "rebase", "merge"]) {
    assert.ok(!actions.includes(forbidden), `git must not offer "${forbidden}"`);
  }
  const refused = await toolset.execute("git", { action: "commit", root: REPO_ROOT });
  assert.equal(refused.ok, false);
});

// THE SAFETY BOUNDARY. Each of these is a command that must NOT run merely
// because a caller labelled it read-only. Proven able to fail by changing the
// adapter's gate to trust the label: all four then run.
test("the read-only label cannot carry a command that writes", async () => {
  const adapter = new WindowsAdapter();
  const offPolicy = { developerMode: false, shellExecutionMode: "none" };
  const run = (command) => adapter.executeCommand(REPO_ROOT, command, [], {
    timeoutMs: 15000,
    shellOrigin: "readonly-verb",
    authorizationCommand: command,
    accessPolicy: offPolicy,
    authorizeShell: async () => true
  });

  for (const command of [
    "git push origin master",
    "git reset --hard HEAD",
    "npm run lint",
    "Remove-Item -Recurse -Force ./scratch-that-does-not-exist"
  ]) {
    const result = await run(command);
    assert.notEqual(result.exitCode, 0, `"${command}" ran under the read-only label`);
    assert.match(
      String(result.stderr ?? ""),
      /disabled|refused|Workspace/i,
      `"${command}" was not stopped by the policy gate`
    );
  }

  // And the control case: the thing the label is FOR still works, or the test
  // above would pass simply by everything being blocked.
  const allowed = await run("git status --short");
  assert.equal(allowed.exitCode, 0, "a genuinely read-only verb was blocked, so this test proves nothing");
});

test("a model-composed command is still refused with the terminal off", async () => {
  const adapter = new WindowsAdapter();
  const result = await adapter.executeCommand(REPO_ROOT, "git status --short", [], {
    timeoutMs: 15000,
    shellOrigin: "model",
    authorizationCommand: "git status --short",
    accessPolicy: { developerMode: false, shellExecutionMode: "none" },
    authorizeShell: async () => true
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(String(result.stderr ?? ""), /disabled/i);
});
