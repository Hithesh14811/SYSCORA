// General-purpose routing.
//
// These pin the changes that let an ordinary request reach a route that can
// serve it. Each one corresponds to a failure observed live against the real
// model, not a hypothetical:
//
//   "list the running processes"  -> crashed with a raw ValidationError
//   "why is my computer slow"     -> refused without trying the adaptive loop
//   "how much free disk space"    -> loop proposed system.inspect, told unknown
//   "hi"                          -> ran the full planning pipeline first
//
// See scripts/live-routing-probe.js for the harness that surfaced them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { validateSchema } from "../../packages/model-providers/src/index.js";
import { INTENT_SCHEMA } from "../../packages/reasoning-engine/src/index.js";
import {
  InteractiveAgentController,
  parseCompoundDesktopRequest,
  buildDeterministicCompoundStrategy,
  DETERMINISTIC_SUBGOAL_VERBS
} from "../../packages/agent-runtime/src/interactive-agent-controller.js";
import { createDefaultCapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../../os-adapters/windows/src/windows-adapter.js";
import { matchGoalCriteriaForTask } from "../../packages/shared-types/src/goal-contract.js";

async function withRuntime(run) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-routing-"));
  try {
    const workspace = path.join(tempRoot, "ws");
    await fs.mkdir(workspace, { recursive: true });
    return await run(createRuntime(tempRoot), workspace);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

// ---- closed value sets ----------------------------------------------------

test("a schema enum is enforced, not merely documented", () => {
  const schema = { type: "object", properties: { category: { type: "string", enum: ["SYSTEM", "CONVERSATION"] } } };
  assert.equal(validateSchema({ category: "SYSTEM" }, schema).valid, true);

  // The exact live failure: models answered with categories of their own making.
  const invented = validateSchema({ category: "information_retrieval" }, schema);
  assert.equal(invented.valid, false);
  assert.match(invented.errors.join(" "), /must be one of SYSTEM, CONVERSATION/);
});

test("an absent enum leaves a field unconstrained", () => {
  const schema = { type: "object", properties: { note: { type: "string" } } };
  assert.equal(validateSchema({ note: "anything at all" }, schema).valid, true);
});

test("intent categories are a closed set including conversation", () => {
  const categories = INTENT_SCHEMA.properties.category.enum;
  assert.ok(Array.isArray(categories), "category must declare an enum");
  assert.ok(categories.includes("CONVERSATION"));
  assert.ok(categories.includes("SYSTEM"));
  assert.equal(validateSchema({ category: "communication" }, INTENT_SCHEMA).valid, false);
});

// ---- persistence must not destroy the session it is saving ----------------

test("saving a session whose plan has no tasks drops the plan instead of throwing", async () => {
  await withRuntime(async (runtime) => {
    const session = await runtime.sessionStore.get(
      (await runtime.submitIntent("hi", { autoApprove: false })).sessionId
    );
    // Reproduce the state a planner leaves behind when it finds no route.
    session.plan = {
      planId: "p1",
      planVersion: 1,
      parentPlanId: null,
      goal: "unroutable",
      summary: "no tasks",
      finalSuccessCriteria: ["none"],
      taskGraph: { graphId: "g1", tasks: [] },
      plannerSource: "DETERMINISTIC_FALLBACK"
    };

    await assert.doesNotReject(() => runtime.persistSession(session));
    assert.equal(session.plan, null, "an unexecutable plan is dropped, not persisted");
  });
});

test("saving a session with a real plan still validates it", async () => {
  await withRuntime(async (runtime) => {
    const session = await runtime.sessionStore.get(
      (await runtime.submitIntent("hi", { autoApprove: false })).sessionId
    );
    // A populated but structurally invalid graph is a genuine bug and must
    // still surface, so the leniency above stays narrow.
    session.plan = {
      planId: "p1",
      taskGraph: { graphId: "g1", tasks: [{ notATask: true }] }
    };
    await assert.rejects(() => runtime.persistSession(session));
  });
});

// ---- what the model is allowed to see -------------------------------------

test("read-only primitives are offered to the controller whatever the goal wording", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });

  // None of these phrasings contain the keywords the old filter looked for.
  for (const goal of [
    "how much free disk space do I have",
    "why is this computer slow",
    "tell me about this machine"
  ]) {
    const names = controller._catalog(goal).map((c) => c.name);
    assert.ok(
      names.includes("system.inspect"),
      `system.inspect must be reachable for "${goal}" (got ${names.length} capabilities)`
    );
  }
});

test("capabilities that change the machine still have to be relevant to be offered", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const names = controller._catalog("how much free disk space do I have").map((c) => c.name);

  // Broadening what the agent can observe must not broaden what it can do.
  for (const consequential of ["package.winget.install", "application.close"]) {
    assert.ok(
      !names.includes(consequential),
      `${consequential} must not be offered for an unrelated read-only goal`
    );
  }
});

// A capability the model cannot name is a capability the agent does not have.
// Asked to maximize a window the planner reached for "window.maximize" and was
// rejected, because the only spelling available was window.state({state}).
test("window management is named the way a request is spoken", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const registered = new Set(registry.getCatalog().map((c) => c.name));
  for (const verb of ["window.maximize", "window.minimize", "window.restore"]) {
    assert.ok(registered.has(verb), `${verb} must be a capability in its own right`);
  }

  // And it has to be offered, not merely registered.
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const offered = controller._catalog("open notepad and maximize the window").map((c) => c.name);
  assert.ok(offered.includes("window.maximize"));
});

test("a spoken window-sizing clause is tracked as an outstanding step", () => {
  // Without a pattern for this verb the whole compound parse returns null, no
  // clause is tracked, and the session can report success after only the launch.
  const steps = parseCompoundDesktopRequest("open notepad and maximize the window");
  assert.ok(Array.isArray(steps), "compound request must parse");
  assert.deepEqual(steps.map((s) => s.verb), ["launch", "windowState"]);
  assert.equal(steps[1].state.toLowerCase(), "maximize");
  assert.ok(DETERMINISTIC_SUBGOAL_VERBS.has("windowState"), "the clause must count as an outstanding subgoal");
});

test("a spoken window-sizing clause compiles to the real state capability", () => {
  const strategy = buildDeterministicCompoundStrategy("open notepad and maximize the window");
  assert.ok(strategy, "compound request must compile mechanically");
  assert.deepEqual(
    [strategy.action, ...strategy.localSteps].map((step) => step.capability),
    ["application.launch", "window.wait", "window.activate", "window.maximize"]
  );
  assert.equal(strategy.localSteps.at(-1).completesGoal, true);
});

test("type exactly treats exactly as an instruction, not payload text", () => {
  const steps = parseCompoundDesktopRequest("open notepad and type exactly: SYSCORA live GUI probe");
  assert.deepEqual(steps.map((step) => step.verb), ["launch", "type"]);
  assert.equal(steps[1].text, "SYSCORA live GUI probe");
});

test("every capability offered to the controller is one the registry actually has", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const registered = new Set(registry.getCatalog().map((c) => c.name));
  for (const capability of controller._catalog("inspect this computer")) {
    assert.ok(registered.has(capability.name), `${capability.name} is not registered`);
  }
});

// The desktop interaction toolkit.
//
// Seeing a screen and acting on it is a general skill, not a set of modalities
// unlocked by the words a person happened to use. Gating them by keyword
// produced an agent whose senses and limbs depended on phrasing: "open Paint and
// draw a line" was offered no pointer, so it could not draw.

test("the interaction toolkit does not depend on how the request is phrased", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });

  // None of these name a modality, and one is about an application nobody tuned for.
  for (const goal of [
    "turn on dark mode in Settings",
    "open Paint and draw a line",
    "what does this dialog say",
    "find the Bluetooth toggle"
  ]) {
    const offered = controller._catalog(goal).map((c) => c.name);
    for (const prefix of ["pointer.", "keyboard.", "ui.", "window.", "screen.", "vision.", "ocr."]) {
      assert.ok(
        offered.some((name) => name.startsWith(prefix)),
        `"${goal}" must be able to use ${prefix}* — a person has all of these before knowing what a window contains`
      );
    }
  }
});

test("no capability is unlocked by naming a specific application", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  // The keyboard was once gated behind a list that literally read
  // /type|enter|input|put|write|calculator|notepad/ — an app-specific unlock.
  const generic = controller._catalog("adjust the setting in that window").map((c) => c.name).sort();
  const named = controller._catalog("adjust the setting in notepad").map((c) => c.name).sort();
  assert.deepEqual(generic, named, "naming an app must not change what the agent can do");
});

test("widening the window toolkit does not widen system-level authority", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const offered = controller._catalog("what does this dialog say");
  const names = offered.map((c) => c.name);

  // Acting on a WINDOW is general. Acting on the SYSTEM stays relevance-gated.
  for (const consequential of ["package.winget.install", "application.close", "process.launch"]) {
    assert.ok(!names.includes(consequential), `${consequential} must not be offered for an unrelated goal`);
  }

  // And everything offered still has to be real.
  const registered = new Set(registry.getCatalog().map((c) => c.name));
  for (const capability of offered) assert.ok(registered.has(capability.name), `${capability.name} is not registered`);
});

// A question must never be planned as a change.
//
// Asked "what is using the most memory on this computer?", the controller's
// mechanical continuation picked a control whose NAME shared a word with the
// question and proposed clicking it. The risk engine correctly scored that as a
// persistent change with unknown reversibility, so the user was asked to approve
// a mutation in order to be told a number.

test("a goal the classifier resolved to reads only is informational", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  assert.equal(InteractiveAgentController.isInformationalGoal(["processes.list"], registry), true);
  assert.equal(InteractiveAgentController.isInformationalGoal(["processes.list", "system.inspect"], registry), true);
  // One mutating capability is enough to make it real work.
  assert.equal(InteractiveAgentController.isInformationalGoal(["processes.list", "ui.action"], registry), false);
  // No named capabilities means no claim either way.
  assert.equal(InteractiveAgentController.isInformationalGoal([], registry), false);
});

test("an informational goal is offered no way to change anything", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const offered = controller._catalog("which process is using the most memory", { readOnly: true }).map((c) => c.name);

  for (const mutating of [
    "ui.action", "ui.click", "ui.type", "pointer.click", "pointer.drag",
    "keyboard.type", "keyboard.press", "command.run"
  ]) {
    assert.ok(!offered.includes(mutating), `${mutating} must not be offered to answer a question`);
  }
});

test("an informational goal can still look, open, focus and scroll", () => {
  const registry = createDefaultCapabilityRegistry(new WindowsAdapter());
  const controller = new InteractiveAgentController({ capabilityRegistry: registry });
  const offered = controller._catalog("what does the settings window say", { readOnly: true }).map((c) => c.name);

  // Reading a GUI means being able to reach it. Blocking these would make the
  // read-only rule a blindfold rather than a boundary.
  for (const permitted of [
    "processes.list", "ui.inspect", "ui.find", "ui.extract", "screen.capture", "ocr.read",
    "application.launch", "window.activate", "window.maximize", "pointer.wheel"
  ]) {
    assert.ok(offered.includes(permitted), `${permitted} must remain available for an informational goal`);
  }
});

// Criteria for a read describe the ANSWER, so they overlap what a task returned
// far more than the command line that produced it. Judging inputs alone scored a
// correct result below threshold and reported it to the user as inconclusive.
test("goal criteria are matched against what a task returned, not only its inputs", () => {
  const contract = {
    criteria: [{
      criterionId: "c1",
      kind: "STATE",
      description: "The total count of files in the Downloads folder is returned"
    }]
  };
  const task = {
    capability: "command.run",
    inputs: { command: "powershell", args: ["-Command", "(Get-ChildItem $env:USERPROFILE\Downloads).Count"] }
  };

  const withoutResult = matchGoalCriteriaForTask(contract, task, null);
  const withResult = matchGoalCriteriaForTask(contract, task, null, {
    stdout: "371", exitCode: 0, count: 371, folder: "Downloads", files: 371
  });

  assert.ok(
    withResult.includes("c1"),
    `the returned count must satisfy the criterion (matched without result: ${JSON.stringify(withoutResult)})`
  );
});
