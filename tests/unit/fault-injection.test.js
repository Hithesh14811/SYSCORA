// THE HONESTY INVARIANT, HELD AGAINST A MACHINE THAT LIES.
//
// `tool-evidence.test.js` proves each render BRANCHES on its receipt: it takes a
// real CONFIRMED result, rebuilds the receipt as UNCONFIRMED by hand, and checks
// the sentence changes. That is necessary and it is not sufficient — it says
// nothing about whether the chain in FRONT of the render produces the right
// verdict when the machine misbehaves.
//
// Here the receipt is never touched. A fault goes into the capability layer — the
// actuator silently does nothing, the pointer lands in another window, the reader
// goes blind — and the tool runs all the way through: act, read back, build the
// receipt, render. What is asserted is what a user would have been told.
//
// The rates this produces are reported by `scripts/probe-fault-injection.mjs`.
// This file is the part that has to stay true, so a regression turns CI red
// rather than being noticed the next time somebody runs a probe.

import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixtures/mock-machine.js";
import { ACTING_CALLS, FAULTS } from "./fixtures/faults.js";
import { CONFIRMED, EvidenceError, looksLikeSuccessClaim } from "../../packages/fast-agent/src/evidence.js";

async function runCell(call, overrides) {
  const files = new Map(call.file ? [call.file] : []);
  const { toolset } = harness({ files, overrides });
  const tool = new Map(toolset.toolsForTest.map((t) => [t.name, t])).get(call.tool);
  try {
    if (call.needsReading) await toolset.execute("screen", { application: "app" });
    const outcome = await toolset.execute(call.tool, call.args);
    const raw = outcome?.raw ?? null;
    if (!raw) return { verdict: null, text: String(outcome?.content ?? ""), refused: true };
    try {
      return { verdict: raw.evidence?.verdict ?? null, text: tool.render(raw), refused: false };
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      return { verdict: raw.evidence?.verdict ?? null, text: "", refused: true };
    }
  } catch {
    return { verdict: null, text: "", refused: false };
  }
}

// A fault that changes nothing about a tool's output never reached it, so that
// cell tests nothing. Excluded rather than counted — padding the denominator with
// cells that were never at risk would make the headline look better than it is.
const unperturbed = (cell, healthy) => cell.verdict === healthy.verdict && cell.text === healthy.text;

test("no acting tool claims success against a broken machine", async () => {
  const liars = [];
  const atRisk = [];
  for (const call of ACTING_CALLS) {
    const label = call.label ?? call.tool;
    const healthy = await runCell(call, {});
    for (const [name, fault] of Object.entries(FAULTS)) {
      const cell = await runCell(call, fault);
      if (unperturbed(cell, healthy)) continue;
      if (looksLikeSuccessClaim(healthy.text)) atRisk.push(`${label}/${name}`);
      if (!cell.refused && looksLikeSuccessClaim(cell.text)) {
        liars.push(`${label} / ${name}: ${JSON.stringify(cell.text.slice(0, 140))}`);
      }
    }
  }
  // THIS ASSERTION MUST BE ABLE TO FAIL. If no tool would have claimed success
  // even without the gate, the fixture is broken and a green run means nothing.
  assert.ok(atRisk.length > 0, "no tool would have claimed success without the gate — the faults are not landing");
  assert.deepEqual(liars, [], `tools claimed success on a broken machine:\n  ${liars.join("\n  ")}`);
});

test("no acting tool returns CONFIRMED against a broken machine", async () => {
  const wrong = [];
  for (const call of ACTING_CALLS) {
    const label = call.label ?? call.tool;
    const healthy = await runCell(call, {});
    for (const [name, fault] of Object.entries(FAULTS)) {
      const cell = await runCell(call, fault);
      if (unperturbed(cell, healthy)) continue;
      if (cell.verdict === CONFIRMED) wrong.push(`${label} / ${name}: ${JSON.stringify(cell.text.slice(0, 140))}`);
    }
  }
  assert.deepEqual(wrong, [], `CONFIRMED on a broken machine:\n  ${wrong.join("\n  ")}`);
});

test("a volume that lands nowhere near the request is not reported as the volume", async () => {
  // THE DEFECT THIS PINS, found by the probe on 13 Sep 2026. With the endpoint
  // reporting `applied: true` and a level nowhere near the request, `volume`
  // returned CONFIRMED and said "Volume is 5%." — true, and not an answer, since
  // the user had asked for 40%. `applied === false` was the only path that
  // compared the two numbers, and this block's own comment already said
  // `applied` is the endpoint reporting on itself.
  const { toolset } = harness({
    overrides: {
      capabilities: {
        "system.volume.set": async (inputs) => ({
          requestedPercent: inputs.percent, percent: 5, muted: false, peak: 0, applied: true
        })
      }
    }
  });
  const outcome = await toolset.execute("volume", { percent: 40 });
  const raw = outcome.raw;
  assert.notEqual(raw.evidence.verdict, CONFIRMED, "an endpoint that landed 35 points away is not a confirmation");
  const text = new Map(toolset.toolsForTest.map((t) => [t.name, t])).get("volume").render(raw);
  assert.equal(looksLikeSuccessClaim(text), false, `still reads as success: ${JSON.stringify(text)}`);
  assert.match(text, /40/, "the sentence must name what was asked for");
  assert.match(text, /5/, "the sentence must name what the endpoint actually reads");
});

test("ordinary endpoint quantisation is still a confirmation", () => {
  // The other half, and the one that keeps the fix shippable. A real endpoint
  // quantises the scalar, so landing a point or two away is normal — and a gate
  // that fires on ordinary success is one that gets switched off. This codebase
  // has paid for that twice.
  return (async () => {
    const { toolset } = harness({
      overrides: {
        capabilities: {
          "system.volume.set": async (inputs) => ({
            requestedPercent: inputs.percent, percent: inputs.percent - 1, muted: false, peak: 0, applied: true
          })
        }
      }
    });
    const outcome = await toolset.execute("volume", { percent: 40 });
    assert.equal(outcome.raw.evidence.verdict, CONFIRMED, "one point of quantisation must not read as failure");
  })();
});
