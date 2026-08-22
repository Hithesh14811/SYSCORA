// THE REQUESTS THAT SHOULD COST NOTHING, TIMED ON THE REAL MACHINE.
//
//   node scripts/probe-fast-path.mjs
//
// W3.1's done-criterion is a number: `mute` and `volume 40` answer in under
// 400ms for 0 tokens, and a deliberately ambiguous phrasing still routes to the
// model. All three of those are measured here, through the real runtime, against
// the real audio endpoint.
//
// IT PUTS THE VOLUME BACK. The whole point is that these calls really change the
// machine, so the probe reads the level first and restores it at the end —
// including the mute flag. A measurement that leaves the user's speakers muted
// is not a measurement anybody will run twice.

import { createRuntime } from "../apps/daemon/src/runtime-factory.js";

const runtime = createRuntime(process.cwd());
const events = [];
runtime.onSessionEvent = (_sessionId, event) => events.push(event);

async function ask(request) {
  events.length = 0;
  const startedAt = Date.now();
  const session = await runtime.submitIntent(request, { workspacePath: process.cwd(), history: [] });
  const elapsed = Date.now() - startedAt;
  const metrics = session.finalResponse?.metrics ?? {};
  const usedModel = (Number(metrics.tokensIn) || 0) > 0;
  const matched = events.some((event) => event.eventType === "FAST_PATH_MATCHED");
  const declined = events.some((event) => event.eventType === "FAST_PATH_DECLINED");
  return {
    request,
    elapsed,
    tokensIn: Number(metrics.tokensIn) || 0,
    tokensOut: Number(metrics.tokensOut) || 0,
    usedModel,
    matched,
    declined,
    status: session.finalResponse?.status,
    message: String(session.finalResponse?.message ?? "").split("\n")[0]
  };
}

const show = (run) => {
  const route = run.matched && !run.declined && !run.usedModel
    ? "FAST PATH"
    : run.declined ? "declined → model" : run.matched ? "matched → model" : "model";
  console.log(
    `${`"${run.request}"`.padEnd(34)} ${String(run.elapsed).padStart(6)}ms  ` +
    `${String(run.tokensIn + run.tokensOut).padStart(7)} tokens  ${route.padEnd(17)} ${run.status}`
  );
  console.log(`${" ".repeat(36)}${run.message.slice(0, 100)}`);
};

// Read the level first, so it can be put back exactly. This first call also
// STARTS the automation host, which is a one-off second the daemon pays at
// startup in the real product — so it is reported separately rather than being
// averaged into the numbers the plan is graded on.
const before = await ask("what's my volume");
const level = /(\d+)\s*%/.exec(before.message);
const wasMuted = /muted/i.test(before.message);

console.log("\nW3.1 — the local fast path, on the real machine");
console.log("-".repeat(96));
console.log("(the first call also starts the automation host — the daemon does this at startup)");
show(before);

console.log("\nwarm:");
// PROVING SILENCE COSTS 300ms AND PROVING A LEVEL DOES NOT.
//
// The endpoint's peak meter is sampled across 300ms, and it is only evidence
// when it contradicts the mute flag — an endpoint that says it is muted while
// still emitting is the thing the user could hear. So an unmuted call skips it
// entirely, and the two are timed apart because averaging them hides which is
// which.
await ask("unmute");
show(await ask("volume 40"));      // unmuted: no meter, no 300ms
show(await ask("what's my volume"));
show(await ask("mute"));           // muted: 300ms of listening, and worth it
show(await ask("turn the volume down a bit"));

// Put the machine back the way it was found.
if (level) {
  await ask(`volume ${level[1]}`);
  if (!wasMuted) await ask("unmute");
  console.log(`\n(volume restored to ${level[1]}%${wasMuted ? ", still muted as found" : ", unmuted as found"})`);
}

console.log("\nBaseline in docs/production-plan.md: 18,400 tokens, 5.5s for a trivial request.");
console.log("Target: 0 tokens, under 400ms, and an ambiguous phrasing still reaches the model.");
process.exit(0);
