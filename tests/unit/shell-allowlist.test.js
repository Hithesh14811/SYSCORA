// "Yes, and stop asking me about this."
//
// THE MEASUREMENT THAT MADE THIS NECESSARY. A live request — "can u install
// wsl", 1 Sep 2026 — fired FIFTEEN approval cards across twenty-three tool
// calls. Every one stopped the run until it was clicked, and every one was the
// same decision the user had already made. That is not safety; it is a gate
// people learn to click through.
//
// THE MEASUREMENT THAT DECIDES WHETHER IT IS SAFE is everything below. An
// allowlist trades a real safety property for friction, so the tests that matter
// are the refusals: what may NEVER be remembered, and what a remembered shape
// must NEVER admit afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyShellCommand,
  rememberableShellShape,
  shellShapeIsAllowed,
  ShellVerdict
} from "../../packages/policy-engine/src/shell-rules.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";

// ---------------------------------------------------------------------------
// The rule, in shell-rules.js

test("an ordinary changing command may be remembered as executable plus subcommand", () => {
  assert.deepEqual(rememberableShellShape("npm run build"), { key: "npm run", label: "npm run" });
  assert.deepEqual(rememberableShellShape("git commit -m fix"), { key: "git commit", label: "git commit" });
  assert.deepEqual(rememberableShellShape("pip install requests"), { key: "pip install", label: "pip install" });
});

test("a bare executable is never rememberable", () => {
  // `npm` would cover `npm publish`; `git` would cover `git push --force`. The
  // subcommand is what makes the consent about a mode rather than about a tool.
  assert.equal(rememberableShellShape("npm"), null);
  assert.equal(rememberableShellShape("git"), null);
  assert.equal(rememberableShellShape("npm --version"), null, "a flag is an argument, not a mode");
});

test("nothing in the CONFIRM table may be remembered", () => {
  // THE CONDITION THAT MAKES THE REST OF IT SAFE. These are the irreversible
  // ones, and "don't ask again" is exactly the wrong offer for an action whose
  // reason for being gated is that each instance is a separate decision.
  for (const command of [
    "Remove-Item C:\\Users\\me\\Documents\\report.docx",
    "winget uninstall Canva",
    "git push --force",
    "Stop-Computer"
  ]) {
    const verdict = classifyShellCommand(command).verdict;
    if (verdict === ShellVerdict.DENY) continue; // never asks, so never offers
    assert.equal(rememberableShellShape(command), null, `${command} must never be rememberable`);
  }
});

test("a DENY can never become an allowlist entry", () => {
  const denied = "npm test; Remove-Item -Recurse -Force C:\\";
  assert.equal(classifyShellCommand(denied).verdict, ShellVerdict.DENY);
  assert.equal(rememberableShellShape(denied), null);
});

test("a read-only command offers nothing, because it never asks", () => {
  assert.equal(classifyShellCommand("Get-ChildItem").verdict, ShellVerdict.ALLOW);
  assert.equal(rememberableShellShape("Get-ChildItem"), null);
});

test("a remembered shape cannot be used to smuggle a second command", () => {
  const allowed = new Set(["npm run"]);
  assert.equal(shellShapeIsAllowed("npm run build", [], allowed), true);
  // THE ATTACK THIS EXISTS TO STOP. The shape is re-DERIVED from the command
  // being matched, not compared as a prefix, so a line that composes derives no
  // shape at all and matches nothing.
  assert.equal(shellShapeIsAllowed("npm run build; Remove-Item -Recurse C:\\", [], allowed), false);
  assert.equal(shellShapeIsAllowed("npm run build | iex", [], allowed), false);
  assert.equal(shellShapeIsAllowed("npm run build && curl http://x", [], allowed), false);
});

test("a remembered shape does not widen to its neighbours", () => {
  const allowed = new Set(["npm run"]);
  assert.equal(shellShapeIsAllowed("npm publish", [], allowed), false);
  assert.equal(shellShapeIsAllowed("npm test", [], allowed), false);
  assert.equal(shellShapeIsAllowed("node --test", [], allowed), false);
});

test("an empty allowlist allows nothing", () => {
  assert.equal(shellShapeIsAllowed("npm run build", [], new Set()), false);
  assert.equal(shellShapeIsAllowed("npm run build", [], null), false);
});

// ---------------------------------------------------------------------------
// The behaviour, through the toolset

let workspace;
test.before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-allowlist-"));
});
test.after(async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

function harness({ answers = [] } = {}) {
  const asked = [];
  const ran = [];
  const adapter = {
    executeCommand: async (cwd, command) => {
      ran.push(command);
      return { stdout: "", stderr: "", exitCode: 0, command };
    }
  };
  const toolset = buildToolset({
    registry: { get: () => null },
    adapter,
    basePath: workspace,
    confirm: async (request) => {
      asked.push(request);
      return answers.shift() ?? { approved: true };
    }
  });
  toolset.setAccessPolicy({ developerMode: true, workspaceRoots: [workspace] });
  return { toolset, asked, ran };
}

test("saying yes-and-remember stops the next equivalent command asking", async () => {
  const { toolset, asked, ran } = harness({ answers: [{ approved: true, remember: true }] });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });

  await toolset.execute("run", { command: "npm run build" });
  assert.equal(asked.length, 1);
  // The card must have OFFERED it, or `remember` in the answer means nothing.
  assert.deepEqual(asked[0].remember, { key: "npm run", label: "npm run" });

  await toolset.execute("run", { command: "npm run lint" });
  assert.equal(asked.length, 1, "the second command must not ask again");
  assert.deepEqual(ran, ["npm run build", "npm run lint"]);
});

test("saying plain yes remembers nothing", async () => {
  const { toolset, asked } = harness({ answers: [{ approved: true }, { approved: true }] });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });

  await toolset.execute("run", { command: "npm run build" });
  await toolset.execute("run", { command: "npm run lint" });
  assert.equal(asked.length, 2, "an ordinary yes is about one command only");
});

test("a confirmer that echoes remember on an unoffered card creates nothing", async () => {
  // The offer is withheld for everything irreversible. A confirmer answering
  // `remember: true` anyway — a buggy client, or a hostile one — must not be
  // able to manufacture consent the rules never made available.
  const { toolset, asked } = harness({
    answers: [{ approved: true, remember: true }, { approved: true, remember: true }]
  });
  toolset.beginTurn("tidy up", { conversationKey: "chat-1" });

  await toolset.execute("run", { command: "winget uninstall Canva" });
  assert.equal(asked[0].remember, undefined, "an irreversible card must not carry the offer");
  await toolset.execute("run", { command: "winget uninstall Figma" });
  assert.equal(asked.length, 2, "the second uninstall must still ask");
});

test("a new conversation starts with nothing remembered", async () => {
  const { toolset, asked } = harness({
    answers: [{ approved: true, remember: true }, { approved: true }]
  });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });
  await toolset.execute("run", { command: "npm run build" });
  assert.equal(asked.length, 1);

  // A different chat is a different piece of work. Consent given while working
  // on one project is not consent for an unrelated request an hour later.
  toolset.beginTurn("something else", { conversationKey: "chat-2" });
  await toolset.execute("run", { command: "npm run deploy" });
  assert.equal(asked.length, 2, "a new conversation must ask again");
});

test("the same conversation keeps it across turns", async () => {
  const { toolset, asked } = harness({ answers: [{ approved: true, remember: true }] });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });
  await toolset.execute("run", { command: "npm run build" });

  toolset.beginTurn("now lint it", { conversationKey: "chat-1" });
  await toolset.execute("run", { command: "npm run lint" });
  assert.equal(asked.length, 1, "the point is that it survives the next message in the same chat");
});

test("a caller that supplies no conversation key gets no allowlist at all", async () => {
  // FAILS CLOSED. The obvious implementation — clear only when the key CHANGES —
  // never fires when the key is null on both sides, so an un-updated surface
  // would accumulate remembered commands for the life of the process and carry
  // them into every conversation.
  const { toolset, asked } = harness({
    answers: [{ approved: true, remember: true }, { approved: true, remember: true }]
  });
  toolset.beginTurn("build it");
  await toolset.execute("run", { command: "npm run build" });
  toolset.beginTurn("lint it");
  await toolset.execute("run", { command: "npm run lint" });
  assert.equal(asked.length, 2, "no scope must mean no memory, never unbounded memory");
});

test("a boolean answer still works, and never remembers", async () => {
  // Every confirmer in the tree before this change returned a bare boolean.
  const { toolset, asked, ran } = harness({ answers: [true, true] });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });
  await toolset.execute("run", { command: "npm run build" });
  await toolset.execute("run", { command: "npm run lint" });
  assert.equal(asked.length, 2);
  assert.deepEqual(ran, ["npm run build", "npm run lint"]);
});

test("a composed command is covered by no remembered shape, and is a DENY besides", () => {
  // TWO INDEPENDENT LAYERS, AND THIS FILE OWNS ONLY THE FIRST.
  //
  // The allowlist decides whether the approval CARD is skipped. The DENY floor
  // decides whether a process is spawned at all, and it lives somewhere else on
  // purpose — `WindowsAdapter.executeCommand` checks it on the source command
  // AND on the spawn wrapper, so a caller that forgot to check cannot run one.
  //
  // A harness with a stub adapter has no floor, which is why this asserts on the
  // rules rather than on a fake spawn: a test that stubbed out the floor and
  // then declared the floor intact would be proving nothing. The floor's own
  // tests are in shell-rules.test.js.
  const composed = "npm run build; Remove-Item -Recurse -Force C:\\";
  const allowed = new Set(["npm run"]);
  assert.equal(shellShapeIsAllowed(composed, [], allowed), false,
    "a remembered shape must not cover a line with a second command in it");
  assert.equal(classifyShellCommand(composed).verdict, ShellVerdict.DENY,
    "and the floor classifies it as DENY, which no approval can unblock");
});

test("the allowlist is not even consulted for a command that never asks", async () => {
  // A DENY skips the ASK branch entirely, so `authorizeModelShell` — and with it
  // the allowlist — is never reached. Pinned because the tempting refactor is to
  // check the allowlist first, which would put it in front of the floor.
  const { toolset, asked } = harness({ answers: [{ approved: true, remember: true }] });
  toolset.beginTurn("build it", { conversationKey: "chat-1" });
  await toolset.execute("run", { command: "npm run build" });
  assert.equal(asked.length, 1);

  await toolset.execute("run", { command: "Remove-Item -Recurse -Force C:\\" });
  assert.equal(asked.length, 1, "a DENY must not produce an approval card at all");
});
