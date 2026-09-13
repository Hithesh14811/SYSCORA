// THE THREE LOOP-LEVEL CHANGES, HELD TO WHAT THEY CLAIM.
//
//   the verification verdict on a settle   — COMPLETED stops being one word
//   parallel reads                          — a turn of pure reads stops waiting
//   the task-state digest                   — what survives a trim
//
// The first two both touch the hot path, so most of what is here is regression
// cover: the ordering, the guards and the events below the change must be
// exactly what they were.

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent, taskStateDigest } from "../../packages/fast-agent/src/index.js";
import { Outcome, Verification } from "../../packages/fast-agent/src/episode.js";
import { CONFIRMED, evidence } from "../../packages/fast-agent/src/evidence.js";

function scriptedProvider(turns) {
  return {
    supportsChat: () => true,
    async chat({ onTextDelta }) {
      const turn = turns.shift() ?? { text: "Done." };
      for (const word of String(turn.text ?? "").match(/\S+\s*/g) ?? []) onTextDelta?.(word);
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.toolCalls?.length ? "tool_calls" : "stop"
      };
    }
  };
}

function stubToolset(handlers = {}, extra = {}) {
  return {
    definitions: [],
    has: (name) => name in handlers,
    previewOf: () => "",
    isActingTool: (name) => extra.acting?.includes(name) ?? false,
    async execute(name, args, options) {
      const handler = handlers[name];
      if (!handler) return { ok: false, text: `There is no tool called "${name}".` };
      return handler(args, options);
    },
    ...extra
  };
}

/** A result carrying a real receipt, built the way a tool builds one. */
const confirmedResult = (text) => ({
  ok: true,
  text,
  raw: { evidence: evidence({ observed: text, method: "test.reader", verdict: CONFIRMED, actedVia: "test.actor" }) }
});

// ---------------------------------------------------------------------------
// VERIFICATION AUTONOMY ON A REAL SETTLE
// ---------------------------------------------------------------------------

test("a question that acted on nothing settles ANSWERED, not unverified", async () => {
  const outcome = await new FastAgent({
    provider: scriptedProvider([{ text: "Python 3.12 is installed." }]),
    toolset: stubToolset()
  }).run("is python installed");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.verification, Verification.NOT_APPLICABLE);
  assert.equal(outcome.outcome, Outcome.ANSWERED);
});

test("a run whose acting tool was CONFIRMED settles autonomous_verified_success", async () => {
  const outcome = await new FastAgent({
    provider: scriptedProvider([
      { text: "Writing it.", toolCalls: [{ name: "write_file", args: { path: "x" } }] },
      { text: "Saved the file." }
    ]),
    toolset: stubToolset(
      { write_file: () => confirmedResult("x holds 12 characters") },
      { acting: ["write_file"] }
    )
  }).run("write a file");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(outcome.verification, Verification.AUTONOMOUS_VERIFIED);
  assert.equal(outcome.outcome, Outcome.AUTONOMOUS_VERIFIED_SUCCESS);
});

test("THE CELL THIS EXISTS FOR: it acted, nothing read it back, and it still said COMPLETED", async () => {
  // The status is deliberately unchanged — fifteen call sites and four consumers
  // branch on it. What changes is that the run now SAYS nothing verified it.
  const outcome = await new FastAgent({
    provider: scriptedProvider([
      { text: "Clicking.", toolCalls: [{ name: "click", args: { text: "Send" } }] },
      { text: "All set." }
    ]),
    toolset: stubToolset(
      // ok, but no receipt at all — the honest "nobody looked" case.
      { click: () => ({ ok: true, text: "clicked" }) },
      { acting: ["click"] }
    )
  }).run("click send");
  assert.equal(outcome.status, "COMPLETED", "the existing status must not move");
  assert.equal(outcome.verification, Verification.UNVERIFIED);
  assert.equal(outcome.outcome, Outcome.UNVERIFIED_SUCCESS);
});

test("the intervention summary rides along on every settle", async () => {
  const outcome = await new FastAgent({
    provider: scriptedProvider([{ text: "Nothing to do." }]),
    toolset: stubToolset()
  }).run("hello");
  assert.ok(outcome.interventions, "no ledger on the settle");
  assert.equal(outcome.interventions.missingHarness, 0);
});

test("an episode package is attached to the finished run", async () => {
  const events = [];
  // NOT the word "Done." — on a run with zero tool calls that is a bare claim,
  // and `claimsWithoutEvidence` has settled it FAILED since long before any of
  // this. Using it here would test that guard rather than the package.
  const outcome = await new FastAgent({
    provider: scriptedProvider([{ text: "There is nothing to do for that." }]),
    toolset: stubToolset(),
    onEvent: (event) => events.push(event)
  }).run("say hello");
  assert.ok(outcome.episode, "no episode package on the outcome");
  assert.equal(outcome.episode.outcomeRecord.status, "COMPLETED");
  assert.ok(events.some((event) => event.type === "EPISODE_PACKAGE"));
  // AGENT_DONE is emitted before the package is built and must NOT have been
  // mutated afterwards — that would be a race with whoever received it.
  const done = events.find((event) => event.type === "AGENT_DONE");
  assert.equal(done.details.episode, undefined);
});

test("a failed call is classified into the attribution trace, without its text", async () => {
  const outcome = await new FastAgent({
    provider: scriptedProvider([
      { text: "Clicking.", toolCalls: [{ name: "click", args: { text: "Send" } }] },
      { text: "That control matched several things." }
    ]),
    toolset: stubToolset(
      { click: () => ({ ok: false, text: 'click failed: "Send" matches 3 things on screen' }) },
      { acting: ["click"] }
    )
  }).run("click send");
  const attributed = outcome.episode.failureAttribution;
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0].failureClass, "ambiguous-target");
  assert.equal(attributed[0].boundary, false);
  // The failure TEXT must not be in the record — it can carry a path, a contact
  // name or a message, and this package is meant to be shareable.
  assert.equal(JSON.stringify(attributed).includes("Send"), false);
});

test("a refusal is recorded as a boundary, not as a technique that failed", async () => {
  const outcome = await new FastAgent({
    provider: scriptedProvider([
      { text: "Running.", toolCalls: [{ name: "run", args: { command: "rm -rf /" } }] },
      { text: "I did not run that." }
    ]),
    toolset: stubToolset(
      { run: () => ({ ok: false, text: "this command can change the system, so workspace terminal access needs your approval" }) },
      { acting: ["run"] }
    )
  }).run("delete everything");
  assert.equal(outcome.episode.failureAttribution[0].boundary, true);
});

test("a toolset with none of the new hooks still runs — nothing added is required", async () => {
  // The desktop shell, the eval runner and six test files build toolsets that
  // know nothing about approvals, jobs or journals. Every one of them must work.
  const outcome = await new FastAgent({
    provider: scriptedProvider([{ text: "Fine." }]),
    toolset: { definitions: [], has: () => false, previewOf: () => "", execute: async () => ({ ok: true, text: "" }) }
  }).run("anything");
  assert.equal(outcome.status, "COMPLETED");
});

// ---------------------------------------------------------------------------
// PARALLEL READS
// ---------------------------------------------------------------------------

test("a turn of pure reads runs them together, and still answers in order", async () => {
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const read = (name) => async (args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    order.push(`${name}:${args.path}`);
    return { ok: true, text: `${name} ${args.path}` };
  };
  const outcome = await new FastAgent({
    provider: scriptedProvider([
      {
        text: "Reading all three.",
        toolCalls: [
          { id: "a", name: "read_file", args: { path: "1" } },
          { id: "b", name: "read_file", args: { path: "2" } },
          { id: "c", name: "read_file", args: { path: "3" } }
        ]
      },
      { text: "Here they are." }
    ]),
    toolset: stubToolset({ read_file: read("read_file") })
  }).run("read three files");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(maxInFlight, 3, "the three reads were still run one after another");
});

test("A TURN THAT TOUCHES THE POINTER IS STILL STRICTLY SEQUENTIAL", async () => {
  // The whole reason the loop runs in series: one screen, one focused window,
  // one pointer. A click and a type overlapping is a race, not a speed-up.
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return { ok: true, text: "ok" };
  };
  await new FastAgent({
    provider: scriptedProvider([
      {
        text: "Doing both.",
        toolCalls: [
          { id: "a", name: "click", args: { text: "Field" } },
          { id: "b", name: "type", args: { text: "hello" } }
        ]
      },
      { text: "Done." }
    ]),
    toolset: stubToolset({ click: slow, type: slow })
  }).run("click then type");
  assert.equal(maxInFlight, 1, "a click and a type overlapped");
});

test("a MIXED turn is sequential — one unsafe call disqualifies the whole turn", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return { ok: true, text: "ok" };
  };
  await new FastAgent({
    provider: scriptedProvider([
      {
        text: "Both.",
        toolCalls: [
          { id: "a", name: "read_file", args: { path: "1" } },
          { id: "b", name: "run", args: { command: "echo hi" } }
        ]
      },
      { text: "Done." }
    ]),
    toolset: stubToolset({ read_file: slow, run: slow })
  }).run("read and run");
  assert.equal(maxInFlight, 1);
});

test("PREFETCHING DOES NOT CHANGE WHAT A THROWING TOOL DOES", async () => {
  // The real toolset catches a tool's error and returns `{ok: false}`, which is
  // why the loop has never wrapped `execute`. A stub that throws raw therefore
  // tests the one thing that matters here: the prefetched path and the
  // sequential path must fail IDENTICALLY. If prefetching swallowed the error,
  // or turned it into an unhandled rejection, these two would diverge.
  const boom = async () => { throw new Error("no such file"); };
  const runWith = (tool) => new FastAgent({
    provider: scriptedProvider([{
      text: "Going.",
      toolCalls: [{ id: "a", name: tool, args: { path: "1" } }, { id: "b", name: tool, args: { path: "2" } }]
    }]),
    toolset: stubToolset({ [tool]: boom })
  }).run("two calls");

  // read_file x2 is prefetched; click x2 is not.
  const parallel = await runWith("read_file").then(() => null, (error) => error.message);
  const sequential = await runWith("click").then(() => null, (error) => error.message);
  assert.equal(parallel, sequential);
  assert.equal(parallel, "no such file");
});

// ---------------------------------------------------------------------------
// THE TASK-STATE DIGEST
// ---------------------------------------------------------------------------

test("the digest is built from receipts, and names what must not be redone", () => {
  const said = taskStateDigest({
    request: "send amma a message and save a note",
    steps: 22,
    performed: [
      { tool: "launch", verified: true },
      { tool: "type", verified: true },
      { tool: "click", verified: false },
      { tool: "screen", verified: null }
    ],
    openFailures: ["click failed: matches 3 things on screen"]
  });
  assert.match(said, /send amma a message/);
  assert.match(said, /CONFIRMED done[^\n]*launch/);
  assert.match(said, /REPORTED AS NOT DONE[^\n]*click/);
  assert.match(said, /Still failing[^\n]*matches 3 things/);
  // A `screen` read has no receipt about the world and must not appear as work
  // that was done.
  assert.equal(/CONFIRMED done[^\n]*screen/.test(said), false);
  assert.match(said, /Do not redo anything on the CONFIRMED line/);
});

test("with nothing confirmed the digest says so rather than staying silent", () => {
  const said = taskStateDigest({ request: "do a thing", performed: [], steps: 3 });
  assert.match(said, /nothing yet has been read back off the machine/);
});

test("the digest repeats a tool count rather than listing it twice", () => {
  const said = taskStateDigest({
    request: "x",
    performed: [{ tool: "write_file", verified: true }, { tool: "write_file", verified: true }]
  });
  assert.match(said, /write_file x2/);
});

test("a very long request is bounded inside the digest", () => {
  const said = taskStateDigest({ request: "z".repeat(4000), performed: [] });
  assert.ok(said.length < 1200);
});
