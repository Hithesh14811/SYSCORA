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

/**
 * The skill that answers this request, and the values to run it with.
 *
 * Ties are broken by how much of the match was LITERAL: between two skills that
 * both fit, the one that recognised more of the sentence understood more of it.
 * A retired skill is never offered (§8).
 */
export function matchSkill(skills, request) {
  const text = String(request ?? "").trim();
  if (!text) return null;
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

  for (const [index, step] of (skill.steps ?? []).entries()) {
    const args = fillArguments(step.args ?? {}, parameters);
    let result;
    try {
      result = await execute(step.tool, args);
    } catch (error) {
      result = { ok: false, text: error?.message ?? String(error) };
    }
    if (result?.ok === false) {
      return handover({ step: index + 1, tool: step.tool, args, reason: String(result.text ?? "").slice(0, 300) });
    }
    // Recorded BEFORE the verification runs. A send that went out and then
    // failed its check has still gone out, and the model has to be told so in
    // the same breath, or it sends again.
    if (step.irreversible) alreadyDone.push(`${index + 1}. ${step.tool} ${JSON.stringify(args).slice(0, 120)}`);
    completed.push(`${index + 1}. ${step.tool} ${JSON.stringify(args).slice(0, 120)}`);

    if (step.verify && typeof verifyStep === "function") {
      const verified = await verifyStep(fillArguments(step.verify, parameters), { step, result });
      // Three states, not two. "Could not check" is not "check failed" — but it
      // is not proof either, and the fast path may only continue on proof.
      if (verified?.status !== "VERIFIED") {
        return handover({
          step: index + 1,
          tool: step.tool,
          args,
          reason: verified?.status === "UNCONFIRMED"
            ? `could not confirm: ${verified?.message ?? "no evidence either way"}`
            : `verification failed: ${verified?.message ?? "the step did not do what it does"}`,
          unconfirmed: verified?.status === "UNCONFIRMED"
        });
      }
    }
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
