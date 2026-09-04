// How much conversation this model can actually be handed.
//
// WHY THIS EXISTS AT ALL: WITH THE RUN CEILINGS OFF, THIS IS THE ONLY BOUND LEFT.
//
// Until now the conversation had no bound on the default path. `pruneConversation`
// and `supersedeEarlierReading` were BOTH behind `SYSCORA_COLLAPSE_HISTORY=1`,
// which is off, so a run accumulated every screen reading it had ever taken and
// re-sent all of them on every step, forever. That was survivable only because
// six minutes and eighty steps stopped the run first — the wall clock was doing
// the context management, by accident and without saying so.
//
// Take the ceilings away and the failure moves to the provider: somewhere past
// its context window the endpoint stops answering, and what comes back is an
// HTTP error about token counts rather than anything the loop can act on. An
// hour-long coding session reaches that in minutes. So the bound has to become
// deliberate, and it has to be the model's REAL limit rather than a constant
// somebody picked.
//
// WHAT IS NOT DONE HERE, AND WHY. Nothing is deleted. A `tool` message answers an
// assistant `tool_call` by id, and every provider — OpenAI, Anthropic, Gemini —
// rejects a conversation where that pairing is broken. So the whole strategy is
// to shrink CONTENT and never to remove a message. That is also why the trim
// says so in the text it leaves behind: a silently shortened tool result reads as
// a complete one, and the model answers "that is everything I found" about a
// third of it.

// The ratio this codebase uses everywhere it converts between the two — see
// scripts/probe-one-window.mjs and measure-prompt-cost.mjs. It is an estimate and
// only ever used to stay well clear of a limit, never to predict a bill.
export const CHARS_PER_TOKEN = 4;

// Context windows by model name, most specific first. These are the INPUT limits
// the endpoints advertise; where a vendor ships several sizes under one family
// the smaller is taken, because being wrong in this direction costs a trim that
// was not needed and being wrong in the other costs the whole run.
//
// A model that matches nothing gets DEFAULT_CONTEXT_TOKENS, which is the smallest
// window in current wide use. Guessing high for an unknown model is how this
// would fail on exactly the model nobody tested.
const CONTEXT_BY_MODEL = Object.freeze([
  [/gemini[-_. ]?(?:3|2\.5|2|1\.5)/i, 1_000_000],
  [/gemini/i, 1_000_000],
  [/claude.*(?:opus|sonnet|haiku|fable)|(?:opus|sonnet|haiku|fable)[-_. ]?\d/i, 200_000],
  [/claude/i, 200_000],
  [/gpt[-_. ]?(?:6|5)|^o[34]\b|astra|sol\b/i, 400_000],
  [/gpt[-_. ]?4\.1/i, 1_000_000],
  [/gpt[-_. ]?4o|gpt[-_. ]?4[-_. ]?turbo/i, 128_000],
  [/deepseek/i, 128_000],
  [/qwen|glm|kimi|moonshot/i, 128_000],
  [/llama[-_. ]?(?:4|3\.[123])/i, 128_000],
  [/mistral|mixtral|codestral/i, 128_000],
  [/grok/i, 128_000]
]);

// The smallest window in wide use. An unknown model is assumed to be this and no
// larger; see the note above.
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/**
 * What the configured model can hold, in input tokens.
 *
 * Asked of the provider FIRST, because a provider that knows its own limit is
 * always right and this table is always a guess. `SYSCORA_MODEL_CONTEXT_TOKENS`
 * overrides both — an escape hatch for a model this does not recognise, so that
 * being wrong here is a configuration line rather than a code change.
 */
export function resolveContextTokens(provider = null) {
  const override = Number(process.env.SYSCORA_MODEL_CONTEXT_TOKENS);
  if (Number.isFinite(override) && override > 0) return override;

  const declared = Number(
    provider?.contextTokens
    ?? provider?.capabilities?.()?.contextTokens
    ?? NaN
  );
  if (Number.isFinite(declared) && declared > 0) return declared;

  const model = String(
    provider?.model ?? provider?.capabilities?.()?.model ?? ""
  );
  for (const [pattern, tokens] of CONTEXT_BY_MODEL) {
    if (pattern.test(model)) return tokens;
  }
  return DEFAULT_CONTEXT_TOKENS;
}

// What must fit ALONGSIDE the conversation, and is therefore not available to it.
//
// The tool schema is the one people forget: it is ~4,912 tokens, it is sent on
// every request, and `messageChars` cannot see it because it is not a message. A
// budget computed without it is over by that much on every step of every run.
const RESERVED_TOKENS = Object.freeze({
  // MEASURED, not estimated: `node scripts/measure-prompt-cost.mjs`, 4 Sep 2026.
  // The first version of this guessed 4,400 and 5,200 and was 1,600 tokens under
  // on the schema alone — which is the wrong direction, because under-reserving
  // means the trim lets the conversation grow past what actually fits and the
  // request fails at the endpoint. Re-run that script if either moves.
  systemPrompt: 4_483,
  toolSchema: 6_818,
  // The largest reply the loop will ever ask for — MODEL_OUTPUT_CEILING_RETRY.
  // Output shares the window with input on every endpoint this runs against.
  output: 16_384,
  // Slack. The char-per-token ratio is an estimate, tokenizers disagree with it
  // by 10-20% on code and on non-Latin text, and being 15% wrong at the limit is
  // a failed request rather than a slightly long prompt.
  margin: 8_000
});

const RESERVED_TOTAL = Object.values(RESERVED_TOKENS).reduce((sum, n) => sum + n, 0);

// Trim in one bite, down to well under the limit, rather than a little on every
// step. Rewriting a message changes the prompt PREFIX, and every provider-side
// prefix cache keys on the prefix being identical to last time — so trimming
// just enough to get under the ceiling means trimming again next step, and from
// that moment nothing is ever served from cache again. Measured on this endpoint:
// a cached input token costs roughly a tenth of a fresh one.
const TRIM_TARGET_FRACTION = 0.55;

// Collapse superseded screen readings once the conversation is genuinely large.
//
// This is NOT the old `SYSCORA_COLLAPSE_HISTORY` behaviour re-enabled by the back
// door, and the difference is the whole point. That flag was turned off on a
// measurement — three paired six-step runs, 24,725 billed tokens with the
// collapse against 16,623 and 16,196 without — and the measurement is right about
// what it measured: on a SHORT run, editing history costs more cache than the
// collapse saves.
//
// It says nothing about a two-hundred-step run, where the alternative to
// collapsing is carrying forty full readings of windows that have all since
// changed. So the collapse stays off exactly where it was measured to lose, and
// comes on where it was never measured and is obviously needed.
const COLLAPSE_ABOVE_FRACTION = 0.45;

/**
 * The conversation limits for this provider, in characters.
 *
 * Characters rather than tokens because that is what the loop can count without
 * a tokenizer, and a tokenizer per provider is a dependency this does not need
 * to stay clear of a limit.
 *
 * @returns {{contextTokens: number, availableTokens: number, maxChars: number,
 *            targetChars: number, collapseAtChars: number}}
 */
export function conversationLimits(provider = null) {
  const contextTokens = resolveContextTokens(provider);
  // A model whose whole window is smaller than the reserve is not one this agent
  // can drive, but it must not produce a negative budget and a permanent trim
  // loop. Floor it at something a conversation can exist in and let the request
  // fail honestly at the endpoint instead.
  const availableTokens = Math.max(8_000, contextTokens - RESERVED_TOTAL);
  const maxChars = availableTokens * CHARS_PER_TOKEN;
  return {
    contextTokens,
    availableTokens,
    maxChars,
    targetChars: Math.floor(maxChars * TRIM_TARGET_FRACTION),
    collapseAtChars: Math.floor(maxChars * COLLAPSE_ABOVE_FRACTION)
  };
}

// WHAT ONE SCREENSHOT COSTS, IN THE UNIT THIS FILE COUNTS IN.
//
// An image is not billed by the length of its base64: every vendor prices it by
// resolution, and a window-sized capture lands around 1,500 tokens. Counting the
// base64 instead would say two million characters for one look and trigger a trim
// of the entire conversation; counting `String(content)` on an array — which is
// what this function did before images existed — says "[object Object]", fifteen
// characters, and the run walks into the context window with six screenshots in
// it believing it is nearly empty.
//
// Both failures are silent and both are expensive, so an image is counted as what
// it actually costs.
export const IMAGE_TOKENS = 1_500;
const IMAGE_CHARS = IMAGE_TOKENS * CHARS_PER_TOKEN;

/** What one message costs, in characters, whatever shape its content is. */
export function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block?.type === "input_image") total += IMAGE_CHARS;
    else total += String(block?.text ?? "").length;
  }
  return total;
}

/** Total characters of message content, which is what a provider bills as input. */
export function messageChars(messages) {
  let total = 0;
  for (const message of messages) total += contentChars(message?.content);
  return total;
}

/**
 * Drop every screenshot but the most recent, in place.
 *
 * A LOOK IS ONLY TRUE UNTIL THE NEXT ONE — the same argument as
 * `supersedeEarlierReading`, and far more expensive here. Six screenshots is
 * ~9,000 tokens of pictures of windows that have all since changed, re-sent on
 * every step for the rest of the run. The newest is the only one that describes
 * the screen as it is now.
 *
 * Done before any text is trimmed, because losing a stale picture costs nothing
 * and losing a tool result costs evidence.
 *
 * @returns {number} how many were dropped
 */
export function dropStaleImages(messages) {
  const carrying = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (Array.isArray(messages[index]?.content)
      && messages[index].content.some((block) => block?.type === "input_image")) {
      carrying.push(index);
    }
  }
  let dropped = 0;
  for (const index of carrying.slice(0, -1)) {
    const message = messages[index];
    messages[index] = {
      ...message,
      content: message.content
        .filter((block) => block?.type !== "input_image")
        // Said out loud rather than silently removed: a turn that quietly lost
        // the picture it was reasoning about reads as one that never had it.
        .concat([{ type: "text", text: "[an earlier screenshot of this window, dropped — it is out of date. Ask for another if you still need to see it.]" }])
    };
    dropped += 1;
  }
  return dropped;
}

// The tail that is never touched. The most recent tool results are what the next
// decision is actually made from, and a trim that reaches them is not saving
// context, it is blinding the agent one step before it acts.
const NEVER_TRIM_RECENT_TOOL_RESULTS = 6;
// Below this a tool result is not worth trimming: the annotation costs almost as
// much as the content, and rewriting a message is what breaks the prefix cache.
const WORTH_TRIMMING_CHARS = 400;
// What survives of a trimmed result. Enough to keep what it WAS — a window name,
// a path, an exit code — while losing the body.
const TRIMMED_HEAD_CHARS = 280;
// Roughly what the "this was trimmed" sentence costs. Used only where the
// arithmetic has to land UNDER a limit rather than merely reduce; see pass 3.
const ANNOTATION_CHARS = 180;

/**
 * Shrink the conversation to fit, in place, oldest tool output first.
 *
 * Returns what it did, so the caller can say so rather than trimming silently.
 * The user's messages, the model's own text and every assistant `tool_calls`
 * structure are untouched: the first two are what keep it on task and the third
 * is what every provider validates.
 *
 * @returns {{trimmed: boolean, before: number, after: number, messages: number}}
 */
export function trimConversation(messages, limits) {
  const before = messageChars(messages);
  if (before <= limits.maxChars) return { trimmed: false, before, after: before, messages: 0 };

  // PICTURES FIRST, BECAUSE A STALE ONE COSTS THE MOST AND IS WORTH THE LEAST.
  // See dropStaleImages: ~1,500 tokens each, describing a window that has since
  // changed, against a tool result that is evidence of something that happened.
  const droppedImages = dropStaleImages(messages);
  if (messageChars(messages) <= limits.maxChars) {
    return { trimmed: droppedImages > 0, before, after: messageChars(messages), messages: droppedImages };
  }

  let protectedFrom = messages.length;
  let recent = 0;
  for (let index = messages.length - 1; index >= 0 && recent < NEVER_TRIM_RECENT_TOOL_RESULTS; index -= 1) {
    if (messages[index].role !== "tool") continue;
    recent += 1;
    protectedFrom = index;
  }

  let trimmedCount = droppedImages;

  // SAY IT WAS CUT, AND SAY WHAT IT WAS. A shortened result that does not
  // announce itself is read as the whole of what that tool returned, and the
  // model then reports a third of a listing as all of it. The count is there so
  // "read it again" is an obviously available move rather than a guess.
  const shrink = (index, keepChars) => {
    const message = messages[index];
    // Only string tool results are shrunk. A block list is a screenshot turn and
    // is handled by dropStaleImages above; slicing `String(array)` would replace
    // it with the literal text "[object Object]".
    if (message.role !== "tool" || typeof message.content !== "string") return false;
    const content = message.content;
    if (content.length < WORTH_TRIMMING_CHARS || content.length <= keepChars) return false;
    const replacement = `${content.slice(0, keepChars)}\n… [${content.length - keepChars} ` +
      "more characters of this earlier result were dropped to make room. It is out of date anyway — " +
      "read it again if you still need it.]";
    if (replacement.length >= content.length) return false;
    messages[index] = { ...message, content: replacement };
    trimmedCount += 1;
    return true;
  };

  // PASS 1 — the old results, which is where the bulk is and where the loss
  // costs least. Down to the target rather than to the limit: see
  // TRIM_TARGET_FRACTION on why trimming just enough is the expensive shape.
  for (let index = 0; index < protectedFrom && messageChars(messages) > limits.targetChars; index += 1) {
    shrink(index, TRIMMED_HEAD_CHARS);
  }

  // PASS 2 — THE PROTECTED TAIL, WHEN THE TAIL ALONE DOES NOT FIT.
  //
  // Six recent readings of a big window can exceed the whole budget on their own,
  // and the first version of this stopped at pass 1 and returned still over the
  // limit — which is the silent failure this module exists to prevent, reached by
  // a different road. The request would go to the endpoint anyway and come back
  // as a token-count error.
  //
  // So the tail is not sacred when the alternative is a rejected request. It is
  // still trimmed OLDEST FIRST, and the single most recent result is never
  // touched, because that one is what the next decision is actually made from.
  for (let index = protectedFrom; index < messages.length - 1 && messageChars(messages) > limits.maxChars; index += 1) {
    shrink(index, TRIMMED_HEAD_CHARS);
  }

  // PASS 3 — ONE RESULT BIGGER THAN THE WHOLE BUDGET. A 400 KB file read on a
  // small-window model. Clipping it loses most of it; sending it loses the run.
  if (messageChars(messages) > limits.maxChars) {
    const last = messages.length - 1;
    if (messages[last]?.role === "tool") {
      // MINUS THE ANNOTATION, which is the off-by-one this arithmetic invites:
      // `shrink` keeps N characters and then ADDS the sentence saying what it
      // dropped, so asking for exactly the remaining room lands ~150 characters
      // over it and the whole pass achieves nothing.
      const others = messageChars(messages) - String(messages[last].content ?? "").length;
      const room = Math.max(TRIMMED_HEAD_CHARS, limits.maxChars - others - ANNOTATION_CHARS);
      shrink(last, room);
    }
  }

  return { trimmed: trimmedCount > 0, before, after: messageChars(messages), messages: trimmedCount };
}
