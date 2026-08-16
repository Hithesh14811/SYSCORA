// Turning a run that worked into a route that can be replayed.
//
// §9: a skill is offered ONLY when the run finished COMPLETED, made at least one
// tool call, and every step that had a verification passed it. A wrong skill is
// worse than no skill — it is a confident wrong answer, replayed for free,
// forever, and the user has no reason to look at it again.
//
// So this refuses far more often than it accepts, and says why each time. The
// reasons are the useful output: "step 3 is positional" means perception could
// not name a control, which is a bug worth fixing upstream rather than a route
// worth saving.

import { validateSkill } from "./skills.js";

// Observations are not part of a route. The replayer proves each step with its
// `verify`, so re-reading the screen between actions costs seconds and adds
// nothing — and a recorded reading is a snapshot of a layout, which is exactly
// what a skill must not contain.
const OBSERVATION_TOOLS = new Set(["screen", "look", "read_screen", "notes", "remember", "machine"]);

// What a step must prove before the replayer is allowed past it. Derived from
// the tool, so a recorded route gets verification without the model choosing it.
const DEFAULT_VERIFY = {
  // Ordinary typing is proved by the words being on screen. A SEND is not — see
  // sendVerify below.
  type: { kind: "element-present" },
  click: { kind: "element-present" },
  launch: { kind: "element-present" },
  // NOTHING, DELIBERATELY. A shell command reports its own exit code, and the
  // replayer already stops on a step that comes back not-ok — that is a signal
  // from the machine, not the agent's opinion of itself, which is what makes it
  // different from a delivered keystroke. The alternative was
  // `command-output-contains` with no value to look for, and an empty needle
  // matches everything: the first route ever replayed here wrote to a corrupted
  // path and reported the step verified.
  run: null
};

// §4.2. These are the ones that cannot be un-run, and the replayer has to name
// them in a handover so a half-finished route is not started again from the top.
const IRREVERSIBLE_TOOLS = new Set(["send", "delete", "uninstall", "pay", "purchase"]);
const IRREVERSIBLE_LABEL = /\b(send|delete|remove|uninstall|pay|buy|purchase|confirm|submit|post|publish)\b/i;

// THE STEP THAT SENDS IS THE STEP THAT NEEDS THE REAL CHECK.
//
// `input-empty` used to be the default for a `type` step, and it cannot prove a
// send at all: WhatsApp's message box publishes value="\n" WHEN IT IS EMPTY, so
// the check passed for a box that had never held the message. The Enter step had
// it worse — no entry in the table at all, so it fell through to
// `element-present` with no value, which asks "did the reading list anything"
// and passes on any screen at all.
//
// A send is confirmed by the words appearing in the CONVERSATION. `text` is
// carried into the check so it has something to look for; a check with an empty
// needle is not a check.
// `parameterise` because the check has to look for THIS run's message, not the
// one that was recorded. Saving the literal would make every later replay hunt
// the screen for the first message ever sent and hand over when it is not there.
function sendVerify(call, previous, values, names) {
  const text = call.tool === "type"
    ? call.args?.text
    : (previous?.tool === "type" ? previous.args?.text : null);
  if (!String(text ?? "").trim()) return null;
  return { kind: "message-in-conversation", value: parameterise(String(text), values, names).args };
}

function isSend(call, previous) {
  if (call.tool === "type" && (call.args?.submit === true || call.args?.enter === true)) return true;
  return call.tool === "key"
    && /^\s*enter\s*$/i.test(String(call.args?.keys ?? ""))
    && previous?.tool === "type";
}

function isIrreversible(call) {
  if (IRREVERSIBLE_TOOLS.has(call.tool)) return true;
  // TYPING WITH SUBMIT IS A SEND. This is the WhatsApp case exactly: the text
  // and the Enter arrive in one call, and afterwards the message is gone to
  // somebody. Missing it would let a replay that failed at a later step be
  // restarted from the top, and the message goes twice.
  if (call.tool === "type" && (call.args?.submit === true || call.args?.enter === true)) return true;
  const label = String(call.args?.text ?? call.args?.label ?? "");
  return call.tool === "click" && IRREVERSIBLE_LABEL.test(label);
}

/**
 * The values the user actually supplied, longest first.
 *
 * Quoted runs first because a person who wrote quotes meant exactly that, then
 * capitalised names and anything after a colon. Longest first matters: replacing
 * "Chintu" before "Chintu jeppu" would leave a stray " jeppu" in the argument
 * and the skill would type it every time.
 */
export function candidateValues(userText) {
  const text = String(userText ?? "");
  const values = new Set();
  // THE SAME WORDS IN TWO FORMS ARE TWO PARAMETERS, AND THAT IS A CORRUPTION.
  //
  // The quoted rule yields `hello there` while the "saying …" rule ran to the
  // end of the line and yielded `"hello there"` WITH its quotes. The step used
  // one and the example captured the other, so they were numbered separately
  // and the replay filled the step from a capture that was never made. Every
  // candidate is stripped of wrapping quotes and trailing punctuation so the two
  // rules cannot disagree about the same value.
  const clean = (value) => String(value)
    .trim()
    .replace(/^["'“”'`]+|["'“”'`]+$/g, "")
    .replace(/[.,;:!?]+$/, "")
    .trim();
  for (const match of text.matchAll(/["'“”']([^"'“”']{2,80})["'“”']/g)) values.add(clean(match[1]));
  for (const match of text.matchAll(/\bsaying\s+(.{2,80})$/gi)) values.add(clean(match[1]));
  // Capitalised words are how a contact's name is spotted — but NOT the first
  // word of the request, which is nearly always the verb. Measured: "Create a
  // file called routine.txt…" made "Create" a parameter of the route.
  const withoutOpening = text.replace(/^\s*\S+\s*/, " ");
  for (const match of withoutOpening.matchAll(/\b([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]+)?\b/g)) values.add(clean(match[0]));
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

// A PATH IS ONE THING, NOT A SENTENCE MADE OF WORDS.
//
// The first route this ever recorded turned `C:\Users\hithe\OneDrive\Documents\…`
// into `C:\{p2}\hithe\OneDrive\{p1}\…`, because "Users" and "Documents" are
// capitalised words and the extractor could not tell a name from a folder. On
// replay the placeholders were filled from a different sentence position and the
// command wrote to a path that did not exist — silently, since the step's check
// was vacuous. Paths and URLs are masked before anything is substituted.
const PATH_LIKE = /([a-zA-Z]:\\[^\s"']*|\\\\[^\s"']+|https?:\/\/[^\s"']+|%[A-Za-z_]+%[^\s"']*|\$env:[^\s"']+)/g;

function maskPaths(text) {
  const held = [];
  const masked = String(text).replace(PATH_LIKE, (found) => {
    held.push(found);
    return `\u0000${held.length - 1}\u0000`;
  });
  return { masked, restore: (value) => value.replace(/\u0000(\d+)\u0000/g, (_, index) => held[Number(index)]) };
}

/**
 * Replace the user's own words in an argument with placeholders.
 *
 * §9: start conservative. A skill with too few parameters simply matches less
 * often; one with too many corrupts its arguments — and a corrupted argument in
 * a `type` step is a message with somebody else's words in it.
 */
export function parameterise(args, values, names = new Map()) {
  const walk = (value) => {
    if (typeof value === "string") {
      // Substitution happens around paths, never inside them.
      const { masked, restore } = maskPaths(value);
      let out = masked;
      for (const candidate of values) {
        if (!candidate || !out.includes(candidate)) continue;
        const name = names.get(candidate) ?? `p${names.size + 1}`;
        names.set(candidate, name);
        out = out.split(candidate).join(`{${name}}`);
      }
      return restore(out);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    }
    return value;
  };
  const result = walk(args);
  return { args: result, names };
}

/**
 * Build a skill from a finished run, or refuse and say why.
 *
 * `calls` is what actually ran, in order: { tool, args, ok, verified }.
 * `verified` is tri-state on purpose — false means a check FAILED, null means
 * there was no check or it could not be made. Recording an unverified run would
 * save a route nobody ever proved worked, which is how a macro gets in.
 */
export function buildSkillFromRun({ id, title, userText, status, calls = [], malformedTurns = 0 }) {
  const reasons = [];
  if (status !== "COMPLETED") reasons.push(`the run ended ${status}, and only a completed run is a route`);
  if (malformedTurns > 0) {
    // A run containing tool-call markup as prose did not do what its transcript
    // appears to say. Baking that into a skill replays the wreckage forever.
    reasons.push("the run contained malformed tool-call markup");
  }
  const acting = calls.filter((call) => !OBSERVATION_TOOLS.has(call.tool));
  if (acting.length === 0) reasons.push("no tool did anything, so there is nothing to replay");
  if (acting.some((call) => call.ok === false)) reasons.push("a step failed during the run");
  if (acting.some((call) => call.verified === false)) reasons.push("a step's verification did not pass");
  if (reasons.length) return { recorded: false, reasons };

  const values = candidateValues(userText);
  // ONE NUMBERING FOR THE WHOLE ROUTE.
  //
  // Each step used to be parameterised with its own fresh map, and so was the
  // match example — so "Users" was {p2} in the command and {p3} in the example
  // that captures it. Replaying filled the step's placeholders from the wrong
  // captures and built a path to nowhere. The map is threaded through every
  // step AND the example, so a name means the same thing everywhere.
  const names = new Map();
  const parameters = new Map();
  const steps = acting.map((call, index) => {
    const { args } = parameterise(call.args ?? {}, values, names);
    for (const [value, name] of names) parameters.set(name, value);
    const previous = acting[index - 1];
    const verify = call.verify
      ?? (isSend(call, previous) ? sendVerify(call, previous, values, names) : null)
      ?? (Object.hasOwn(DEFAULT_VERIFY, call.tool) ? DEFAULT_VERIFY[call.tool] : { kind: "element-present" });
    return {
      tool: call.tool,
      args,
      ...(isIrreversible(call) ? { irreversible: true } : {}),
      ...(verify ? { verify } : {}),
      onFail: "handover"
    };
  });

  // Same map, so the example captures into the placeholders the steps use.
  const { args: exampleArgs } = parameterise(String(userText ?? ""), values, names);
  for (const [value, name] of names) parameters.set(name, value);
  const skill = {
    id,
    title: title || String(userText ?? "").slice(0, 60),
    parameters: [...parameters].map(([name, example]) => ({ name, description: `e.g. ${example}` })),
    match: { examples: [exampleArgs] },
    preconditions: preconditionsFor(acting),
    steps
  };

  const problems = validateSkill(skill);
  // The interesting refusal. A positional step means the control could not be
  // named — the route is not the problem, perception is.
  if (problems.length) return { recorded: false, reasons: problems };
  return { recorded: true, skill };
}

// §3. Establish, do not assume. Derived from what the run actually drove rather
// than from a guess: the application it launched or acted in is the one that has
// to be running and in front before any of this means anything.
function preconditionsFor(calls) {
  const application = calls.find((call) => call.args?.application)?.args?.application
    ?? calls.find((call) => call.tool === "launch")?.args?.application;
  if (!application) return [];
  return [
    { ensure: "app-running", application },
    { ensure: "focused", application }
  ];
}
