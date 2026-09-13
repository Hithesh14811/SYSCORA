// Matching a request to a saved route, and replaying it without the model.
//
// This is NOT the agent loop. It is a deterministic executor that calls the same
// `toolset.execute` every other route calls, so each tool keeps its own gates,
// its own failure semantics and its own progress reporting. A skill is a speed
// optimisation and never a consent one: replaying a send still asks, exactly as
// deriving it would (docs/skills.md §4.2).
//
// The safety argument is one sentence: THE FAST PATH IS ONLY ALLOWED TO KEEP
// RUNNING WHILE IT CAN PROVE IT IS ON TRACK. Every step verifies, and the first
// verification that fails stops the replay and hands the model the situation
// rather than starting it over.

// §11: no matching model. If deciding whether to use a skill costs a model call,
// the saving is already gone.
const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn `"send {contact} a message saying {text}"` into something that can
 * recognise one.
 *
 * Non-greedy captures, because `{text}` at the end would otherwise swallow the
 * literal that follows it. Whitespace is loosened: people type two spaces and
 * mean one, and a skill that misses because of that is a skill nobody trusts.
 */
export function exampleToPattern(example) {
  const names = [];
  let pattern = "";
  let lastIndex = 0;
  for (const match of String(example).matchAll(PLACEHOLDER)) {
    names.push(match[1]);
    pattern += escapeRegex(example.slice(lastIndex, match.index)).replace(/\s+/g, "\\s+");
    pattern += "(.+?)";
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegex(example.slice(lastIndex)).replace(/\s+/g, "\\s+");
  return { regex: new RegExp(`^\\s*${pattern}\\s*$`, "i"), names };
}

// "CAN YOU SEND AMMA A MESSAGE PLEASE" IS THE SAME REQUEST AS "SEND AMMA A MESSAGE".
//
// The pattern above is anchored `^...$`, so a saved route matched the sentence it
// was recorded from and nothing else. Every ordinary way of asking politely —
// which is how most people talk to an assistant — missed, and the run paid full
// model price for a route it already had. arXiv:2601.21123 solves the same
// problem with hybrid lexical and semantic RETRIEVAL over the skill library;
// this is the deterministic half of that idea, and the half that costs nothing:
// the request is stripped of wrapping and matched again.
//
// GREETINGS ARE DELIBERATELY NOT STRIPPED. "hi" and "hey" look like the same
// class of word and are not: "hi mum how are you" is a message to send, and
// eating its first word would replay a route with the wrong text in it. Only
// phrases that are unambiguously a request wrapper are removed.
const REQUEST_WRAPPER =
  /^\s*(?:syscora\s*[,:]?\s+|please\s+|pls\s+|plz\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|will\s+you\s+|i\s+want\s+you\s+to\s+|i\s+need\s+you\s+to\s+|go\s+ahead\s+and\s+)/i;
const REQUEST_TRAILER = /(?:\s*,?\s*(?:please|thanks|thank\s+you)\s*|\s*)[.!?]*\s*$/i;

/** The same request with the politeness taken off. Exported for the tests. */
export function normalizeRequest(text) {
  let out = String(text ?? "").trim();
  // Repeatedly, because "can you please send…" is two wrappers. Bounded by the
  // string only ever getting shorter.
  let previous = null;
  while (out && out !== previous) {
    previous = out;
    out = out.replace(REQUEST_WRAPPER, "").replace(REQUEST_TRAILER, "").trim();
  }
  return out;
}

/**
 * The skill that answers this request, and the values to run it with.
 *
 * Ties are broken by how much of the match was LITERAL: between two skills that
 * both fit, the one that recognised more of the sentence understood more of it.
 * A retired skill is never offered (§8).
 *
 * The request is tried AS TYPED first and only then normalised, so an exact
 * match always wins over a widened one — widening may add matches and may never
 * change which skill an already-matching sentence selects.
 */
export function matchSkill(skills, request) {
  const text = String(request ?? "").trim();
  if (!text) return null;
  const exact = matchAgainst(skills, text);
  if (exact) return exact;
  const normalized = normalizeRequest(text);
  if (!normalized || normalized === text) return null;
  const widened = matchAgainst(skills, normalized);
  // Said out loud in the result: a replay that matched only after the request was
  // rewritten is one worth being able to see in a transcript.
  return widened ? { ...widened, normalized } : null;
}

function matchAgainst(skills, text) {
  let best = null;
  for (const skill of skills ?? []) {
    if (skill?.stats?.retired === true) continue;
    for (const example of skill.match?.examples ?? []) {
      const { regex, names } = exampleToPattern(example);
      const found = text.match(regex);
      if (!found) continue;
      const parameters = {};
      let usable = true;
      for (const [index, name] of names.entries()) {
        const value = String(found[index + 1] ?? "").trim();
        // An empty capture means the sentence merely LOOKS like the example.
        // Replaying with a blank contact is how a message goes nowhere.
        if (!value) { usable = false; break; }
        parameters[name] = value;
      }
      if (!usable) continue;
      const literal = example.replace(PLACEHOLDER, "").length;
      if (!best || literal > best.literal) best = { skill, parameters, example, literal };
    }
  }
  return best ? { skill: best.skill, parameters: best.parameters, example: best.example } : null;
}

/** `{contact}` -> the captured value, everywhere in a step's arguments. */
export function fillArguments(args, parameters) {
  if (typeof args === "string") {
    return args.replace(PLACEHOLDER, (whole, name) =>
      (Object.hasOwn(parameters, name) ? String(parameters[name]) : whole));
  }
  if (Array.isArray(args)) return args.map((value) => fillArguments(value, parameters));
  if (args && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, fillArguments(value, parameters)]));
  }
  return args;
}

// §3. The first act of a skill is to MAKE the environment true, not to hope it
// is. That is the whole price of being layout-independent, and it is about
// 300ms.
const PRECONDITION_TOOLS = {
  "app-running": (step) => ({ tool: "launch", args: { application: step.application } }),
  focused: (step) => ({ tool: "focus", args: { application: step.application } }),
  "window-state": (step) => ({ tool: "window_state", args: { state: step.state ?? "maximize" } }),
  "fresh-document": (step) => ({ tool: "new_document", args: { application: step.application } }),
  "path-exists": (step) => ({ tool: "run", args: { command: `Test-Path '${step.path}'` } })
};

// A missing application is not something the model can rediscover: it is not
// installed, and no amount of reading the screen changes that.
const FAIL_FAST = new Set(["app-running", "path-exists"]);

/**
 * Run a saved route. Returns either a completed replay, or a handover.
 *
 * The handover payload is the point of §6: the model is handed what has already
 * happened, in order, with the irreversible steps called out. Without that it
 * redoes finished work — and "redone" for a send means somebody's mother gets
 * the message twice.
 */
export async function replaySkill({ skill, parameters = {}, execute, verifyStep, now = () => Date.now() }) {
  const startedAt = now();
  const completed = [];
  const alreadyDone = [];

  const handover = (failure) => ({
    replayed: false,
    handover: {
      skill: skill.id,
      title: skill.title ?? skill.id,
      parameters,
      completed,
      alreadyDone,
      failure
    },
    elapsedMs: now() - startedAt,
    steps: completed.length
  });

  for (const precondition of skill.preconditions ?? []) {
    const build = PRECONDITION_TOOLS[precondition.ensure];
    if (!build) continue;
    const call = build(precondition);
    let result;
    try {
      result = await execute(call.tool, fillArguments(call.args, parameters));
    } catch (error) {
      result = { ok: false, text: error?.message ?? String(error) };
    }
    if (result?.ok === false) {
      const reason = `precondition ${precondition.ensure} failed: ${String(result.text ?? "").slice(0, 200)}`;
      if (FAIL_FAST.has(precondition.ensure)) {
        return { ...handover({ step: 0, reason, failFast: true }), failFast: true };
      }
      return handover({ step: 0, reason });
    }
    completed.push(`${precondition.ensure}${precondition.application ? ` (${precondition.application})` : ""}`);
  }

  // One attempt at one way of doing a step: run it, then prove it.
  //
  // Returns the same shape whichever branch it came from, so the caller does not
  // have to know whether it ran the recorded step or one of its alternatives.
  const attempt = async (branch, step) => {
    const args = fillArguments(branch.args ?? {}, parameters);
    let result;
    try {
      result = await execute(branch.tool, args);
    } catch (error) {
      result = { ok: false, text: error?.message ?? String(error) };
    }
    if (result?.ok === false) {
      // `delivered: false` — the tool itself refused or failed, so nothing
      // reached the machine. The distinction matters one screen down: an
      // irreversible step is only "already done" when it was actually
      // DELIVERED, and reporting a failed send as already sent is how a message
      // does not get sent at all.
      return { ok: false, delivered: false, args, result, reason: String(result.text ?? "").slice(0, 300) };
    }
    // A branch may carry its own check; where it does not it inherits the step's,
    // because an alternative route to the same place should have to prove the
    // same thing.
    const check = branch.verify ?? step.verify;
    if (check && typeof verifyStep === "function") {
      const verified = await verifyStep(fillArguments(check, parameters), { step, result });
      // Three states, not two. "Could not check" is not "check failed" — but it
      // is not proof either, and the fast path may only continue on proof.
      if (verified?.status !== "VERIFIED") {
        return {
          ok: false,
          // The call went through and only the CHECK failed, so whatever it did
          // has been done. This is the case `alreadyDone` was written for.
          delivered: true,
          args,
          result,
          unconfirmed: verified?.status === "UNCONFIRMED",
          reason: verified?.status === "UNCONFIRMED"
            ? `could not confirm: ${verified?.message ?? "no evidence either way"}`
            : `verification failed: ${verified?.message ?? "the step did not do what it does"}`
        };
      }
    }
    return { ok: true, delivered: true, args, result };
  };

  // WHEN A BRANCH MAY BE TRIED, AND THE TWO CASES WHERE IT MAY NEVER BE.
  //
  // Alternatives come from arXiv:2601.21123: a skill's execution graph carries
  // guarded branches for the ordinary UI variations that break a straight line.
  // They are not a retry — an identical call repeated is what the loop's repeat
  // guard refuses — they are a different route that was seen to work.
  //
  // 1. NEVER AFTER AN IRREVERSIBLE STEP. If a send went out and its check failed,
  //    the message is gone. Trying "another way to send it" sends it twice, and
  //    this codebase's founding defect is a message reported sent that was not —
  //    its mirror image is a message sent twice because a check was unsure.
  //    `alreadyDone` exists for precisely this and the handover names it.
  //
  // 2. NEVER AFTER THE USER SAID NO. A refusal is a boundary, and a branch tried
  //    after one is the machine looking for a way around the person. `index.js`
  //    states the rule — "a boundary is not a defect, and the user saying no is
  //    an answer, not an obstacle" — and `shell-rules.js` records a live session
  //    where four attempts were made to route around one refusal, two of them
  //    successful. A skill must not automate that.
  const mayBranch = (step, outcome) =>
    step.irreversible !== true
    && outcome.result?.raw?.refusedByUser !== true
    && (step.alternatives ?? []).length > 0;

  for (const [index, step] of (skill.steps ?? []).entries()) {
    let outcome = await attempt(step, step);
    const tried = [{ tool: step.tool, reason: outcome.reason }];
    let branchUsed = null;

    if (!outcome.ok && mayBranch(step, outcome)) {
      for (const [order, alternative] of step.alternatives.entries()) {
        const retry = await attempt(alternative, step);
        tried.push({ tool: alternative.tool, reason: retry.reason });
        if (retry.ok) {
          outcome = retry;
          branchUsed = order + 1;
          break;
        }
        outcome = retry;
      }
    }

    const toolUsed = branchUsed ? step.alternatives[branchUsed - 1].tool : step.tool;

    // Recorded BEFORE the failure is reported, and ONLY when the call actually
    // went through. A send that went out and then failed its check has still
    // gone out, and the model has to be told so in the same breath or it sends
    // again — but a send the tool REFUSED has not gone out, and reporting that
    // one as already done is how the message never gets sent at all. That is why
    // `attempt` returns `delivered` rather than only `ok`.
    if (step.irreversible && outcome.delivered) {
      alreadyDone.push(`${index + 1}. ${step.tool} ${JSON.stringify(outcome.args).slice(0, 120)}`);
    }

    if (!outcome.ok) {
      return handover({
        step: index + 1,
        tool: step.tool,
        args: outcome.args,
        reason: tried.length > 1
          // Every route that was tried, named. A handover saying only how the
          // last branch failed sends the model to re-try the first one.
          ? tried.map((entry) => `${entry.tool}: ${entry.reason}`).join(" | ")
          : outcome.reason,
        unconfirmed: outcome.unconfirmed === true,
        ...(tried.length > 1 ? { triedAlternatives: tried.length - 1 } : {})
      });
    }

    completed.push(
      `${index + 1}. ${toolUsed} ${JSON.stringify(outcome.args).slice(0, 120)}` +
      // Named, because a replay that quietly took a different route and reported
      // the recorded one is a replay whose statistics mean nothing.
      `${branchUsed ? ` (via alternative ${branchUsed})` : ""}`
    );
  }

  return { replayed: true, steps: completed.length, completed, alreadyDone, elapsedMs: now() - startedAt };
}

/** §6, verbatim in shape: what the model reads when a replay stops. */
export function describeHandover(handover) {
  const lines = [
    `You were running the skill "${handover.title}"`,
    ...Object.entries(handover.parameters ?? {}).map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`),
    "",
    "Completed:",
    ...(handover.completed.length ? handover.completed.map((line) => `  ${line}`) : ["  nothing yet"]),
    `  ALREADY DONE AND NOT REPEATABLE: ${handover.alreadyDone.length ? handover.alreadyDone.join("; ") : "none"}`,
    ""
  ];
  const failure = handover.failure ?? {};
  lines.push(failure.step ? `Failed at step ${failure.step}:` : "Failed before the first step:");
  if (failure.tool) lines.push(`  ${failure.tool} ${JSON.stringify(failure.args ?? {}).slice(0, 200)}`);
  lines.push(`  -> ${failure.reason ?? "unknown"}`);
  lines.push("", "Read the screen and carry on from here. Do not start again from the beginning.");
  return lines.join("\n");
}
