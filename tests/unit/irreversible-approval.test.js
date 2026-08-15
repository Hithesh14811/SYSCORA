// ONE CLICK IN FRONT OF WHAT CANNOT BE TAKEN BACK.
//
// The agent loop enforces only the DENY floor — formatting a disk, wiping shadow
// copies, piping a download into a shell — and everything between that and
// reading a file ran unattended, including deleting the user's documents and
// uninstalling their applications. The staged pipeline's approval machinery
// exists, but it costs several model calls per action, which is exactly why it
// is not on this path.
//
// So the question is asked where not asking is free: a regex over the command
// line, and a card in the transcript only for the shapes that are irreversible.
// These tests are about the wiring — that the question reaches the surface, that
// the answer reaches the loop, and that silence is not consent.

import test from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand, requiresClickConfirmation, requiresConfirmation, requiresSendConfirmation, ShellVerdict } from "../../packages/policy-engine/src/shell-rules.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { AgentRuntime } from "../../packages/agent-runtime/src/index.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { ReasoningEngine } from "../../packages/reasoning-engine/src/index.js";

// A model that asks for exactly the tool calls it is told to, then stops.
function scriptedProvider(turns) {
  let index = 0;
  return {
    name: "scripted",
    supportsChat: () => true,
    capabilities: () => ({ name: "scripted", remote: false }),
    async chat() {
      const turn = turns[index] ?? { text: "Done.", toolCalls: [] };
      index += 1;
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, position) => ({
          id: `call_${index}_${position}`,
          name: call.name,
          arguments: JSON.stringify({ saw: "the last result", say: "doing it", ...call.args })
        })),
        finishReason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      };
    }
  };
}

function runtimeWith(provider, adapter) {
  const capabilityRegistry = createDefaultCapabilityRegistry(adapter);
  return new AgentRuntime({
    capabilityRegistry,
    adapter,
    reasoningEngine: new ReasoningEngine({ modelProvider: provider, capabilityRegistry }),
    sessionStore: { save: async () => {}, get: async () => null, list: async () => [] },
    auditRepository: { append: async () => {} }
  });
}

const recordingAdapter = (ran) => ({
  executeCommand: async (cwd, command) => {
    ran.push(command);
    return { command, stdout: "ok", stderr: "", exitCode: 0 };
  },
  listWindows: async () => [],
  runPowerShell: async () => ({ stdout: "", stderr: "", exitCode: 1 })
});

test("an irreversible command asks the user, and a yes lets it run", async () => {
  const ran = [];
  const provider = scriptedProvider([
    { text: "Removing it.", toolCalls: [{ name: "run", args: { command: "Remove-Item -Recurse .\\build" } }] },
    { text: "Removed.", toolCalls: [] }
  ]);
  const runtime = runtimeWith(provider, recordingAdapter(ran));

  const events = [];
  runtime.onSessionEvent = (sessionId, event) => {
    events.push(event);
    // The user clicking Allow, as the daemon route would deliver it.
    if (event.eventType === "APPROVAL_REQUIRED") {
      setImmediate(() => runtime.resolveApproval(event.details.approvalId, true));
    }
  };

  const session = await runtime.submitIntent("delete the build folder", { fast: true });

  const asked = events.find((event) => event.eventType === "APPROVAL_REQUIRED");
  assert.ok(asked, "the user must be asked before an irreversible command");
  assert.equal(asked.details.rule, "delete-files");
  assert.match(asked.details.detail, /Remove-Item/, "the exact command is what is being agreed to");
  assert.ok(events.some((event) => event.eventType === "APPROVAL_RESOLVED"),
    "the transcript has to show what was decided");
  assert.deepEqual(ran, ["Remove-Item -Recurse .\\build"], "an approved command runs, once");
  assert.equal(session.finalResponse.status, "COMPLETED");
});

test("a no means the command never runs, and the agent is told to stop trying", async () => {
  const ran = [];
  const provider = scriptedProvider([
    { text: "Removing it.", toolCalls: [{ name: "run", args: { command: "Remove-Item -Recurse C:\\Users\\me\\Documents\\work" } }] },
    { text: "I did not delete anything.", toolCalls: [] }
  ]);
  const runtime = runtimeWith(provider, recordingAdapter(ran));

  const toolResults = [];
  runtime.onSessionEvent = (sessionId, event) => {
    if (event.eventType === "APPROVAL_REQUIRED") {
      setImmediate(() => runtime.resolveApproval(event.details.approvalId, false));
    }
    if (event.eventType === "TOOL_FINISHED") toolResults.push(event.details);
  };

  await runtime.submitIntent("delete my work folder", { fast: true });

  assert.deepEqual(ran, [], "a refused command must never be spawned");
  const refused = toolResults.find((result) => /said NO/.test(result.output ?? ""));
  assert.ok(refused, "the model has to be told it was refused");
  assert.equal(refused.ok, false, "a refusal is a failed step, so repeating it is caught by the repeat guard");
  assert.match(refused.output, /Do not try it again/);
});

test("ordinary work is never interrupted to ask", async () => {
  const ran = [];
  const provider = scriptedProvider([
    { text: "Installing.", toolCalls: [{ name: "run", args: { command: "winget install VideoLAN.VLC" } }] },
    { text: "Installed.", toolCalls: [] }
  ]);
  const runtime = runtimeWith(provider, recordingAdapter(ran));

  const events = [];
  runtime.onSessionEvent = (sessionId, event) => events.push(event);

  await runtime.submitIntent("install vlc", { fast: true });

  assert.equal(events.filter((event) => event.eventType === "APPROVAL_REQUIRED").length, 0);
  assert.deepEqual(ran, ["winget install VideoLAN.VLC"]);
});

// Stop, while a question is on screen. The card is part of a run, so pressing
// stop has to answer it — otherwise the loop sits behind a card nobody is going
// to click until the question times out on its own. And a click that lands after
// that is not authorization for a run that has already ended.
test("stopping answers the question, and a late click authorizes nothing", async () => {
  const ran = [];
  const controller = new AbortController();
  const provider = scriptedProvider([
    { text: "Removing it.", toolCalls: [{ name: "run", args: { command: "Remove-Item notes.txt" } }] },
    { text: "Stopped.", toolCalls: [] }
  ]);
  const runtime = runtimeWith(provider, recordingAdapter(ran));

  let approvalId = null;
  runtime.onSessionEvent = (sessionId, event) => {
    if (event.eventType === "APPROVAL_REQUIRED") {
      approvalId = event.details.approvalId;
      setImmediate(() => controller.abort(new Error("STOPPED_BY_USER")));
    }
  };

  await runtime.submitIntent("delete notes.txt", { fast: true, signal: controller.signal });

  assert.ok(approvalId, "it did ask");
  assert.deepEqual(ran, [], "silence, and then a stop, is not consent");
  assert.equal(runtime.resolveApproval(approvalId, true), false,
    "answering after the run has finished must not be accepted");
});

// A GATE THAT REFUSES ARBITRARY THINGS TRAINS THE THING IT IS GATING TO EVADE IT.
//
// The root-delete rule matched `C:\Users` anywhere in the path, so deleting one
// file in your own Documents was refused as "deleting a drive root" — while
// `Get-ChildItem <path> | Remove-Item` and `[System.IO.Directory]::Delete(...)`
// went straight through, because it required the path to follow the verb. It
// refused the safe readable form and permitted the two dangerous ones.
//
// Live, the model met a refusal and tried cmd's rmdir, then the pipe (which
// worked), then an elevated process, then the .NET API (which worked). Four
// routes around one decision.
test("the delete floor is about the target, not about which words came first", () => {
  const denied = [
    String.raw`Remove-Item C:\ -Recurse -Force`,
    String.raw`del /s /q C:\Windows`,
    String.raw`Remove-Item "C:\Users" -Recurse`,
    String.raw`Remove-Item C:\Users\hithe -Recurse -Force`,
    String.raw`rmdir /s /q "C:\Program Files"`,
    String.raw`Remove-Item $env:USERPROFILE -Recurse`,
    String.raw`rm -rf /`,
    // The routes reached for after a refusal. Order no longer protects them.
    String.raw`Get-ChildItem C:\Windows -Force | Remove-Item -Recurse -Force`,
    String.raw`[System.IO.Directory]::Delete("C:\Users\hithe", $true)`,
    String.raw`Start-Process cmd -ArgumentList '/c','rmdir /s /q C:\' -Verb RunAs`
  ];
  for (const command of denied) {
    assert.equal(classifyShellCommand(command).verdict, ShellVerdict.DENY, `must be refused: ${command}`);
  }

  const ordinary = [
    // The one that was wrongly refused: a single file the user owns.
    String.raw`Remove-Item C:\Users\hithe\OneDrive\Documents\report.docx`,
    String.raw`Remove-Item "C:\Users\hithe\AppData\Local\Programs\Python\Python310" -Recurse -Force`,
    String.raw`Remove-Item .\build -Recurse`,
    String.raw`Remove-Item C:\Python313 -Recurse -Force`
  ];
  for (const command of ordinary) {
    assert.notEqual(classifyShellCommand(command).verdict, ShellVerdict.DENY,
      `deleting something the user owns is ordinary work: ${command}`);
    assert.equal(requiresConfirmation(command).confirm, true, `but it must still ask: ${command}`);
  }
});

test("every route to a delete asks, not just the readable one", () => {
  for (const command of [
    String.raw`Remove-Item notes.txt`,
    String.raw`Get-ChildItem C:\Python313 -Force | Remove-Item -Recurse -Force`,
    String.raw`[System.IO.Directory]::Delete("C:\Users\hithe\Documents\proj", $true)`,
    String.raw`Start-Process cmd -ArgumentList '/c','rmdir /s /q C:\Python313' -Verb RunAs`
  ]) {
    assert.equal(requiresConfirmation(command).confirm, true, `must ask: ${command}`);
  }
  for (const command of ["winget install VLC", "Get-ChildItem -Recurse", "git commit -m 'remove old build'"]) {
    assert.equal(requiresConfirmation(command).confirm, false, `must not ask: ${command}`);
  }
});

// The gate was on the wrong things. It asked whether it could delete an empty
// leftover folder, and did not ask before sending a message to the wrong person
// twice or clicking "Delete for everyone" twice.
test("the controls that push something out to another person ask first", async () => {
  const acted = [];
  const asked = [];
  const toolset = buildToolset({
    registry: {
      get: (name) => ({
        execute: async () => {
          acted.push(name);
          if (name !== "screen.read") return { performed: true, x: 1, y: 1 };
          return {
            read: true, windowId: "1", application: "WhatsApp", title: "WhatsApp", visibleText: "",
            elements: [
              { role: "button", text: "Delete for everyone", clickable: true, bounds: { x: 0, y: 0, width: 80, height: 20 } },
              { role: "button", text: "More options for Kalank - Title Track", clickable: true, bounds: { x: 0, y: 40, width: 80, height: 20 } }
            ]
          };
        }
      })
    },
    adapter: {}
  });
  toolset.setConfirmer(async (request) => { asked.push(request); return false; });
  await toolset.execute("screen", { application: "WhatsApp" });

  const destructive = await toolset.execute("click", { text: "Delete for everyone" });
  assert.equal(asked.length, 1, "deleting for everyone must ask");
  assert.equal(destructive.ok, false);
  assert.match(destructive.text, /said NO/);

  acted.length = 0;
  const ordinary = await toolset.execute("click", { text: "More options for Kalank - Title Track" });
  assert.equal(asked.length, 1, "an ordinary click must not ask — this is the speed the product lives on");
  assert.equal(ordinary.ok, true);
  assert.ok(acted.includes("pointer.clickAt"));

  // Enter in a messaging app IS the send. The card shows what is about to go out.
  await toolset.execute("type", { text: "ajab prem ki gajab kahani" });
  acted.length = 0;
  const sent = await toolset.execute("key", { keys: "enter" });
  assert.equal(asked.length, 2, "pressing Enter in WhatsApp must ask before it sends");
  assert.match(asked[1].detail, /ajab prem ki gajab kahani/, "the card must show the message itself");
  assert.equal(sent.ok, false);
  assert.ok(!acted.includes("keyboard.press"), "a refused send must never reach the keyboard");
});

test("enter in an ordinary application is just a newline", () => {
  assert.equal(requiresSendConfirmation("enter", "notepad").confirm, false);
  assert.equal(requiresSendConfirmation("enter", "Code.exe").confirm, false);
  assert.equal(requiresSendConfirmation("ctrl+s", "whatsapp").confirm, false);
  assert.equal(requiresSendConfirmation("enter", "WhatsApp").confirm, true);
});

test("a label that merely contains the word delete is not a delete-for-everyone", () => {
  assert.equal(requiresClickConfirmation("Delete for everyone").confirm, true);
  assert.equal(requiresClickConfirmation("Send").confirm, true);
  assert.equal(requiresClickConfirmation("More options for Kalank - Title Track").confirm, false);
  assert.equal(requiresClickConfirmation("Deleted messages").confirm, false);
  assert.equal(requiresClickConfirmation("Add to Liked Songs").confirm, false);
});
