// Conversation is an outcome, not a routing failure.
//
// SYSCORA is meant to hold a normal conversation as well as act on the computer.
// A greeting or a question about the assistant itself produces no task graph, so
// it reaches `reasoningEngine.converse()` from one of two places: an offline
// keyword fast path, or the fallback after planning returns an empty graph.
// Those two branches used to settle differently — the offline one COMPLETED, the
// online one FAILED — which meant that with a healthy model every answered
// question persisted as a failed session and rendered under a "this did not work"
// headline. These tests pin both branches to the same terminal state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";
import { LifecyclePhase, projectSessionLifecycle } from "../../packages/shared-types/src/session-lifecycle.js";

const ANSWER = "I'm SYSCORA. I can inspect and control this computer.";

async function withRuntime(run) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-conversation-"));
  try {
    const workspace = path.join(tempRoot, "ws");
    await fs.mkdir(workspace, { recursive: true });
    return await run(createRuntime(workspace), workspace);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

// A healthy model routes every message through classification and planning, so a
// conversational message only becomes an answer after the plan comes back empty.
function withHealthyModel(runtime) {
  runtime.reasoningEngine.hasModel = () => true;
  runtime.reasoningEngine.isModelHealthy = async () => true;
  runtime.reasoningEngine.understandIntent = async () => ({
    ok: true,
    data: {
      normalizedGoal: "Discuss the assistant itself",
      category: "CONVERSATION",
      entities: {},
      successCriteria: ["the question is answered in words"],
      confidence: 0.95
    }
  });
  runtime.reasoningEngine.converse = async () => ({ ok: true, text: ANSWER });
  return runtime;
}

test("answering after an empty plan settles as completed, not failed", async () => {
  await withRuntime(async (runtime) => {
    const session = await withHealthyModel(runtime).submitIntent("what can you do", { autoApprove: false });

    assert.equal(session.finalResponse.status, "ANSWERED");
    assert.equal(session.finalResponse.message, ANSWER);
    assert.equal(session.currentState, "COMPLETED", "an answered session must never persist as FAILED");
    assert.ok(session.events.some((e) => e.eventType === "CONVERSATIONAL_REPLY"));
  });
});

test("an answered session is persisted as answered, so reloading it agrees", async () => {
  await withRuntime(async (runtime) => {
    const session = await withHealthyModel(runtime).submitIntent("who are you", { autoApprove: false });
    const reloaded = await runtime.sessionStore.get(session.sessionId);

    assert.equal(reloaded.currentState, "COMPLETED");
    assert.equal(reloaded.finalResponse.status, "ANSWERED");
    assert.equal(projectSessionLifecycle(reloaded).phase, LifecyclePhase.ANSWERED);
  });
});

test("the offline path answers the same way when no model is reachable", async () => {
  await withRuntime(async (runtime) => {
    runtime.reasoningEngine.hasModel = () => true;
    runtime.reasoningEngine.isModelHealthy = async () => false;
    runtime.reasoningEngine.converse = async () => ({ ok: true, text: ANSWER });

    const session = await runtime.submitIntent("hey", { autoApprove: false });

    assert.equal(session.currentState, "COMPLETED");
    assert.equal(session.finalResponse.status, "ANSWERED");
  });
});

test("conversation performs no actions and leaves no plan behind", async () => {
  await withRuntime(async (runtime) => {
    const session = await withHealthyModel(runtime).submitIntent("what model are you", { autoApprove: false });

    assert.equal(session.plan, null);
    const acted = session.events.some((e) => /TASK_EXECUTED|ACTION_INVOKED|CAPABILITY_EXECUTED/.test(e.eventType));
    assert.equal(acted, false, "answering a question must not execute a capability");
    assert.equal(projectSessionLifecycle(session).executionStarted, false);
  });
});

// The fix must not turn every unroutable request into a fake answer: when the
// model declines to converse there is nothing to report, and the honest outcome
// is still a request for clarification.
test("a declined conversation asks for clarification rather than claiming an answer", async () => {
  await withRuntime(async (runtime) => {
    withHealthyModel(runtime);
    runtime.reasoningEngine.converse = async () => ({ ok: false });

    const session = await runtime.submitIntent("what model are you", { autoApprove: false });

    assert.equal(session.finalResponse.status, "NEEDS_CLARIFICATION");
    assert.equal(session.currentState, "FAILED");
    assert.equal(projectSessionLifecycle(session).phase, LifecyclePhase.AWAITING_USER_INPUT);
  });
});

// The fast path: the classifier recognises a message that asks nothing of the
// computer and answers it in the same call, so chatting costs one model call
// instead of the whole classify-context-plan pipeline. Live, this took a
// greeting from ~19s to ~2s.

// IntentEngine only lets a REAL remote model route an intent — Mock fixtures
// must never become executable tasks — so a test about model-driven routing has
// to present a remote-looking provider.
function withRemoteProvider(runtime) {
  runtime.reasoningEngine.modelProvider.capabilities = () => ({ name: "test", remote: true, structured: true });
  return runtime;
}

test("a conversational classification is answered without planning anything", async () => {
  await withRuntime(async (runtime) => {
    withRemoteProvider(runtime);
    runtime.reasoningEngine.hasModel = () => true;
    runtime.reasoningEngine.isModelHealthy = async () => true;
    runtime.reasoningEngine.understandIntent = async () => ({
      ok: true,
      data: {
        normalizedGoal: "Answer a general question",
        category: "CONVERSATION",
        directAnswer: ANSWER,
        entities: {},
        successCriteria: ["the question is answered"],
        confidence: 0.95
      }
    });
    // Reaching either of these means the fast path did not take the request.
    runtime.reasoningEngine.composeTaskGraph = async () => {
      throw new Error("planning must not run for a conversation");
    };
    runtime.reasoningEngine.converse = async () => {
      throw new Error("a second model call must not be needed for a conversation");
    };

    const session = await runtime.submitIntent("what is RAM", { autoApprove: false });

    assert.equal(session.currentState, "COMPLETED");
    assert.equal(session.finalResponse.status, "ANSWERED");
    assert.equal(session.finalResponse.message, ANSWER);
    assert.equal(session.plan, null);
    const reply = session.events.find((e) => e.eventType === "CONVERSATIONAL_REPLY");
    assert.equal(reply?.details?.source, "INTENT_CLASSIFICATION", "expected the fast path, not the fallback");
  });
});

// Guard against the failure mode this optimisation could introduce: answering
// from the model's own guess something that should have been measured.
test("a real task is never swallowed by the conversation route", async () => {
  await withRuntime(async (runtime) => {
    withRemoteProvider(runtime);
    runtime.reasoningEngine.hasModel = () => true;
    runtime.reasoningEngine.isModelHealthy = async () => true;
    // A classification that claims conversation while still naming a typed
    // operation is contradictory; the executable route has to win.
    runtime.reasoningEngine.understandIntent = async () => ({
      ok: true,
      data: {
        normalizedGoal: "Inspect the system",
        category: "CONVERSATION",
        directAnswer: "Your computer is fine.",
        operation: "system.inspect",
        entities: {},
        successCriteria: ["system information is reported"],
        confidence: 0.95
      }
    });

    const session = await runtime.submitIntent("inspect this system", { autoApprove: false });

    assert.notEqual(session.finalResponse.message, "Your computer is fine.");
    const reply = session.events.find((e) => e.eventType === "CONVERSATIONAL_REPLY");
    assert.equal(reply, undefined, "a typed operation must not be answered conversationally");
  });
});
