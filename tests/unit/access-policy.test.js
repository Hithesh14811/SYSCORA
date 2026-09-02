import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalMode,
  canAutoApprove,
  normalizeAccessPolicy
} from "../../packages/shared-types/src/access-policy.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";

test("new requests default to balanced access with arbitrary terminal off", () => {
  const policy = normalizeAccessPolicy({});
  assert.equal(policy.approvalMode, ApprovalMode.BALANCED);
  assert.equal(policy.developerMode, false);
  assert.equal(policy.shellExecutionMode, "none");
});

test("enabling developer mode without a boundary defaults to isolation", () => {
  const policy = normalizeAccessPolicy({ developerMode: true });
  assert.equal(policy.shellExecutionMode, "isolated");
});

test("legacy autoApprove is accepted only as an approval-mode compatibility field", () => {
  assert.equal(normalizeAccessPolicy({ autoApprove: true }).approvalMode, ApprovalMode.FULL);
  assert.equal(normalizeAccessPolicy({ autoApprove: true }).developerMode, false,
    "blanket approval must not silently expose the terminal");
});

test("full access cannot auto-approve an instruction found in untrusted content", () => {
  const policy = normalizeAccessPolicy({ approvalMode: "full" });
  assert.equal(canAutoApprove({ kind: "command" }, policy), true);
  assert.equal(canAutoApprove({ kind: "injected-instruction" }, policy), false);
});

test("the run tool is absent until developer terminal access is explicit", () => {
  const toolset = buildToolset({ registry: { get: () => null }, adapter: {} });
  toolset.setAccessPolicy({ approvalMode: "balanced", developerMode: false });
  assert.equal(toolset.has("run"), false);
  assert.equal(toolset.definitions.some((definition) => definition.function.name === "run"), false);

  toolset.setAccessPolicy({ approvalMode: "balanced", developerMode: true, shellExecutionMode: "host" });
  assert.equal(toolset.has("run"), true);
  assert.equal(toolset.definitions.some((definition) => definition.function.name === "run"), true);
});

test("Ask mode gates network access before a network operation starts", async () => {
  let asked = null;
  const toolset = buildToolset({ registry: { get: () => null }, adapter: {} });
  toolset.setAccessPolicy({ approvalMode: "ask", developerMode: false });
  toolset.setConfirmer(async (request) => { asked = request; return false; });
  toolset.beginTurn("look this up");
  const result = await toolset.execute("search", { query: "SYSCORA" });
  assert.equal(result.ok, false);
  assert.equal(asked?.rule, "access.ask.network");
});

test("batch cannot bypass Ask mode or the hidden terminal", async () => {
  const requests = [];
  const toolset = buildToolset({ registry: { get: () => null }, adapter: {} });
  toolset.setAccessPolicy({ approvalMode: "ask", developerMode: false });
  toolset.setConfirmer(async (request) => { requests.push(request); return false; });
  toolset.beginTurn("do these together");

  const network = await toolset.execute("batch", {
    steps: [{ tool: "search", args: { query: "SYSCORA" } }]
  });
  assert.equal(network.ok, false);
  assert.equal(requests[0]?.rule, "access.ask.network");

  const shell = await toolset.execute("batch", {
    steps: [{ tool: "run", args: { command: "Write-Output hello" } }]
  });
  assert.equal(shell.ok, false);
  assert.match(shell.text, /terminal is off/i);
});

test("balanced access does not ask for interpreter version checks", async () => {
  let asked = 0;
  let spawned = 0;
  const adapter = {
    async executeCommand() {
      spawned += 1;
      return { exitCode: 0, stdout: "Python 3.12.4", stderr: "" };
    }
  };
  const toolset = buildToolset({ registry: { get: () => null }, adapter });
  toolset.setAccessPolicy({
    approvalMode: "balanced",
    developerMode: true,
    shellExecutionMode: "host"
  });
  toolset.setConfirmer(async () => { asked += 1; return true; });

  const result = await toolset.execute("run", { command: "python --version; py --version" });

  assert.equal(result.ok, true);
  assert.equal(spawned, 1);
  assert.equal(asked, 0, "a version query is observational, not a potentially unsafe action");
});

test("workspace mode permits a read-only diagnostic without a folder but still blocks mutation", async () => {
  let spawned = 0;
  const adapter = {
    async executeCommand() {
      spawned += 1;
      return { exitCode: 0, stdout: "Python 3.12.4", stderr: "" };
    }
  };
  const toolset = buildToolset({ registry: { get: () => null }, adapter });
  toolset.setAccessPolicy({
    approvalMode: "balanced",
    developerMode: true,
    shellExecutionMode: "workspace",
    workspaceRoots: []
  });

  const read = await toolset.execute("run", { command: "python --version" });
  const mutation = await toolset.execute("run", { command: "python cleanup.py" });

  assert.equal(read.ok, true);
  assert.equal(spawned, 1);
  assert.equal(mutation.ok, false);
  assert.match(mutation.text, /needs an attached folder/i);
});

test("a background wrapper that becomes ASK is approved at the final boundary", async () => {
  let asked = null;
  const adapter = {
    async executeCommand(_cwd, _command, _args, options) {
      const approved = await options.authorizeShell({
        verdict: { verdict: "ASK", rule: "shell.default-ask", reason: "the wrapper starts a process" }
      });
      return approved
        ? { exitCode: 0, stdout: "123", stderr: "" }
        : { blocked: true, exitCode: 1, stdout: "", stderr: "Blocked" };
    }
  };
  const toolset = buildToolset({ registry: { get: () => null }, adapter });
  toolset.setAccessPolicy({ approvalMode: "ask", developerMode: true, shellExecutionMode: "host" });
  toolset.setConfirmer(async (request) => { asked = request; return false; });
  toolset.beginTurn("start this in the background");

  await toolset.execute("run", { command: "Get-Date", background: true });
  assert.equal(asked?.rule, "shell.default-ask");
  assert.equal(asked?.detail, "Get-Date");
});

test("the Windows spawn boundary refuses a model mutation without an authorizer", async () => {
  const adapter = new WindowsAdapter();
  const result = await adapter.executeCommand(process.cwd(), "exit 0", [], {
    shellOrigin: "model",
    accessPolicy: { developerMode: true, shellExecutionMode: "host", workspaceRoots: [] }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.blockedRule, "shell.ask-without-authorizer");
});

test("the Windows spawn boundary refuses even read-only shell when developer mode is off", async () => {
  const adapter = new WindowsAdapter();
  const result = await adapter.executeCommand(process.cwd(), "Write-Output safe", [], {
    shellOrigin: "model",
    accessPolicy: { developerMode: false, shellExecutionMode: "none", workspaceRoots: [] }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.blockedRule, "shell.developer-mode-required");
});

test("a background wrapper cannot disguise an original hard-DENY command", async () => {
  const adapter = new WindowsAdapter();
  const result = await adapter.executeCommand(process.cwd(), "Write-Output harmless-wrapper", [], {
    shellOrigin: "model",
    authorizationCommand: "format C: /q",
    authorizeShell: async () => true,
    accessPolicy: { developerMode: true, shellExecutionMode: "host", workspaceRoots: [] }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.blockedRule, "disk-format");
});

// ---- installing an app is not workspace work --------------------------------
//
// The workspace gate refuses any non-read-only command when no folder is
// attached and tells the user to attach one. Measured live, 29 Aug 2026, that
// refusal pushed "install Quick Share from Microsoft Store" down the Store GUI
// instead: 21 steps, 99.5s, and it hit the 150,000-token ceiling before the
// install finished. The same install through `winget install --id` is ~3 steps.
//
// The exemption is from the FOLDER requirement, not from safety — which is what
// the second and third tests here exist to hold.

const workspaceToolset = (run) => {
  const toolset = buildToolset({
    registry: { get: () => null },
    adapter: { executeCommand: run ?? (async () => ({ stdout: "done", stderr: "", exitCode: 0 })) }
  });
  toolset.setAccessPolicy({
    approvalMode: "balanced", developerMode: true, shellExecutionMode: "workspace", workspaceRoots: []
  });
  toolset.beginTurn("install quick share");
  return toolset;
};

test("a package install is not refused for want of an attached folder", async () => {
  const toolset = workspaceToolset();
  const result = await toolset.execute("run", { command: "winget install --id 9PCTGDFXVZLJ --source msstore" });
  assert.ok(
    !/needs an attached folder/.test(result.text ?? ""),
    `the install was still refused for want of a folder: ${result.text}`
  );
});

test("an ordinary system-changing command still needs the folder", async () => {
  // The exemption is narrow on purpose. If it widened to "anything that changes
  // the system" it would have quietly removed the workspace gate altogether.
  const toolset = workspaceToolset();
  const result = await toolset.execute("run", { command: "Remove-Item -Recurse -Force C:\Users\hithe\Documents" });
  assert.equal(result.ok, false);
  assert.match(result.text, /needs an attached folder/);
});

test("an install with a second command smuggled behind it is still refused", async () => {
  const toolset = workspaceToolset();
  const result = await toolset.execute("run", {
    command: "winget install x; Remove-Item -Recurse -Force C:\Users"
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /needs an attached folder/);
});

test("the refusal names the route that actually works", async () => {
  // The old wording sent the model to ask the user to attach a project, which
  // for "install an app" is a non-sequitur it cannot act on — so it improvised
  // the GUI and never said why.
  const toolset = workspaceToolset();
  const result = await toolset.execute("run", { command: "Set-Content C:\a.txt hi" });
  assert.match(result.text, /Installing an application does NOT need a folder/);
});
