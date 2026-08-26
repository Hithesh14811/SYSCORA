// THE REQUESTS THAT DO NOT NEED A LANGUAGE MODEL.
//
// "mute" costs 18,400 tokens and five and a half seconds, and every one of those
// tokens is spent deciding something that was never in doubt. There is exactly
// one thing "mute" can mean, the tool that does it takes no arguments worth
// reasoning about, and the round trip to a remote model is the entire latency.
//
// So: a router that matches a handful of phrasings EXACTLY and calls the tool
// itself. No model, no tokens, no network.
//
// TWO RULES, AND THEY ARE WHAT MAKE THIS SAFE.
//
// 1. IT ONLY FIRES ON AN UNAMBIGUOUS MATCH. Every pattern here is anchored to
//    the whole message. "mute" matches; "mute the spotify tab but not the
//    system" does not, and must not — a router that guesses is worse than no
//    router, because the model would have got it right. Anything that is not a
//    dead certainty falls through to the loop, which is the normal path and is
//    not a failure.
//
// 2. IT ONLY ANSWERS WHEN THE TOOL CONFIRMS. The fast path calls the SAME tools
//    as the model path, so it gets the same typed receipt (see evidence.js) — and
//    it hands the answer back only on a CONFIRMED verdict. `open notepad` where
//    "notepad" turns out not to be an application, or a mute the endpoint would
//    not accept, falls through to the model with nothing claimed. That is the W1
//    invariant doing the work: the fast path cannot invent a success, because it
//    cannot render one.
//
// What it must never become is a second agent. If a request needs a decision, it
// belongs in the loop.

// One shape for every phrasing: lower case, single spaces, no trailing
// punctuation, no leading politeness. Everything else is left alone — in
// particular an application's name keeps its own spelling, because that is what
// gets looked up.
export function normalizeRequest(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .trim()
    .replace(/^(?:please|pls|hey|ok|okay)[,\s]+/, "")
    .replace(/[\s,]*(?:please|pls|thanks|thank you)$/, "")
    .replace(/[.?!\s]+$/, "")
    .trim();
}

// An application name a person would type. Deliberately narrow: letters, digits
// and the few punctuation marks real application names use. A path, a quote, a
// pipe or a switch is not an application name and must reach the model.
const APPLICATION = "([a-z0-9][a-z0-9 .+_-]{1,28})";

// AN APPLICATION NAME IS NOT A DESCRIPTION OF ONE.
//
// The pattern above has to allow spaces, because "visual studio code" and
// "adobe acrobat reader" are real names people type. That is also how "open the
// file I was working on" became `launch("file i was working on")` — a phrase
// that looks exactly like a name to a regular expression.
//
// Two things separate them and both are cheap. A real name is short: three words
// covers everything on an ordinary desktop. And a real name contains no
// pronouns, no tense and no deixis — the moment a word like "my", "was" or
// "again" appears, the user is describing something rather than naming it, and
// that is a question for the model.
const MAX_NAME_WORDS = 3;
const DESCRIBES_RATHER_THAN_NAMES =
  /\b(?:i|me|my|mine|you|your|we|our|it|its|this|that|these|those|there|here|was|were|is|are|been|being|had|has|have|did|does|do|just|again|last|next|previous|earlier|before|after|other|another|same|all|every|any|some|thing|things|one|ones|file|files|folder|window|windows|tab|tabs)\b/;

function looksLikeAnApplicationName(value) {
  const name = String(value ?? "").trim();
  if (!name) return false;
  const words = name.split(" ").filter(Boolean);
  if (words.length > MAX_NAME_WORDS) return false;
  return !DESCRIBES_RATHER_THAN_NAMES.test(name);
}

const RULES = [
  {
    id: "software-installed",
    // A factual host question with exactly one bounded interpretation. The
    // typed tool performs the observation; this route merely avoids asking a
    // remote model to rediscover which tool to call.
    pattern: /^(?:is|do i have)\s+(?:the\s+)?([a-z0-9][a-z0-9 .+_-]{0,38})\s+(?:installed|available)(?:\s+(?:on|in)\s+(?:this|my)\s+(?:computer|pc|system|machine))?$/,
    call: (match) => (looksLikeAnApplicationName(match[1])
      ? { tool: "software", args: { name: match[1].trim() } }
      : null)
  },
  {
    id: "mute",
    // "mute the volume", "mute my sound", "mute the system", "mute"
    pattern: /^(?:mute|mute it|mute (?:the|my) (?:volume|sound|audio|system|speakers?))$/,
    call: () => ({ tool: "volume", args: { mute: true } })
  },
  {
    id: "unmute",
    pattern: /^(?:unmute|unmute it|unmute (?:the|my) (?:volume|sound|audio|system|speakers?)|turn (?:the )?sound back on)$/,
    call: () => ({ tool: "volume", args: { mute: false } })
  },
  {
    id: "volume-set",
    // "volume 40", "set the volume to 40%", "turn the volume down to 40",
    // "put volume at 40". The NUMBER is what makes this unambiguous — "turn the
    // volume down" on its own is not here, because by how much is a decision.
    pattern: /^(?:(?:set|turn|put|change)\s+)?(?:the\s+|my\s+)?(?:volume|sound)\s*(?:up\s+|down\s+)?(?:to|at)?\s*(\d{1,3})\s*(?:%|percent)?$/,
    call: (match) => {
      const percent = Number(match[1]);
      // A percentage outside the scale is a typo or a different request. Let the
      // model ask about it rather than clamping silently.
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) return null;
      return { tool: "volume", args: { percent } };
    }
  },
  {
    id: "volume-read",
    pattern: /^(?:volume|what(?:'s| is)?\s+(?:the|my)\s+volume(?:\s+(?:at|set to))?|how loud is it)$/,
    call: () => ({ tool: "volume", args: {} })
  },
  {
    id: "launch",
    // "open spotify", "launch notepad". NOT "run X" — "run the tests" is not an
    // application — and not "start X", which is as often a server as an app.
    pattern: new RegExp(`^(?:open|launch)\\s+(?:the\\s+)?${APPLICATION}$`),
    call: (match) => (looksLikeAnApplicationName(match[1])
      ? { tool: "launch", args: { application: match[1].trim() } }
      : null)
  },
  {
    id: "close",
    pattern: new RegExp(`^(?:close|quit|exit)\\s+(?:the\\s+)?${APPLICATION}$`),
    call: (match) => (looksLikeAnApplicationName(match[1])
      ? { tool: "close_app", args: { application: match[1].trim() } }
      : null)
  }
];

// Words that mean the request is CONDITIONAL, HYPOTHETICAL or ABOUT the action
// rather than a request to perform it. "how do I mute this", "should I close
// spotify", "what happens if I mute" — each of those matches nothing here
// anyway because the patterns are whole-message anchored, but a phrasing that
// slips through one of them would be answered by DOING the thing, which is the
// one mistake this router must never make.
const NOT_AN_INSTRUCTION = /\b(?:how|why|should|would|could|can|whether|if|explain|what happens|instead of|without)\b/;

/**
 * The tool call this request unambiguously means, or null to use the model.
 *
 * Null is the ordinary answer and carries no cost: the loop runs exactly as it
 * did before.
 */
export function matchFastPath(userText) {
  // The transcript/debug harness appends an explicit "ignore this" note to
  // ordinary prompts. It is user-declared metadata, not part of the request;
  // strip only that exact trailing marker and leave every other aside alone.
  const routedText = String(userText ?? "").replace(/\s*\(\s*ignore this\b[\s\S]*$/i, "");
  const said = normalizeRequest(routedText);
  if (!said || said.length > 60) return null;
  // This rule answers a question rather than performing an action, so the
  // instruction-only guard below does not apply to its "do I have" phrasing.
  const diagnosticRule = RULES.find((rule) => rule.id === "software-installed");
  const diagnosticMatch = diagnosticRule.pattern.exec(said);
  if (diagnosticMatch) {
    const call = diagnosticRule.call(diagnosticMatch);
    if (call) return { ...call, rule: diagnosticRule.id };
  }
  if (NOT_AN_INSTRUCTION.test(said)) return null;
  for (const rule of RULES) {
    if (rule === diagnosticRule) continue;
    const match = rule.pattern.exec(said);
    if (!match) continue;
    const call = rule.call(match);
    if (call) return { ...call, rule: rule.id };
  }
  return null;
}

// Exported for the test that proves every rule is reachable and that none of
// them overlaps another.
export const FAST_PATH_RULES = RULES.map((rule) => rule.id);
