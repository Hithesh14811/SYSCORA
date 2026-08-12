// The agent loop.
//
// One conversation, held open for the whole task. The model talks and calls
// tools; the tools run and answer; it keeps going until the job is done. That is
// the entire design, and it is the design because it is the one that produces
// the behaviour people actually want from an assistant: the first sentence is on
// screen in under a second, and the work has already started underneath it.
//
// What it replaces did the opposite. Every step was a separate stateless
// request that re-sent the goal, the capability catalog, the perception and the
// history, waited for a complete JSON object, validated it against a schema,
// wrapped the single action it contained in a synthetic plan, and put that plan
// through validation, risk assessment, policy evaluation, an approval commitment
// and a task-graph scheduler — to click one button. The user saw nothing until
// all of it had happened, several times.
//
// Nothing here decides whether the user is allowed to do something. The
// destructive-command floor in WindowsAdapter.executeCommand still stands
// underneath, because that one is about damage that cannot be undone rather than
// about permission.

import { buildToolset } from "./tools.js";

export { buildToolset };

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_ELAPSED_MS = 6 * 60 * 1000;
// Beyond this the conversation is trimmed from the oldest tool output forward.
// Generous — a long task is a long conversation — but not unbounded, because an
// unbounded prompt is how this codebase previously reached four million
// characters for a request whose answer was one number.
const MAX_CONVERSATION_CHARS = 60000;

const SYSTEM_PROMPT = `You are SYSCORA, an agent with full control of this Windows machine. You do things; you do not describe how the user could do them.

HOW YOU WORK
- Act immediately. Never ask for permission, confirmation or clarification unless the request is genuinely ambiguous in a way that would make you do the wrong thing. "Install X", "book me a flight", "play Y", "set up Z" are instructions, not questions.
- THINK OUT LOUD, ABOUT WHAT YOU ACTUALLY SEE. Every tool takes "saw" and "say", and both are required. "saw" is what you are working from right now, quoted concretely — "Port 3000 is held by PID 41292.", "Three things match Amma: the search box, the header, and a chat." "say" is what you are doing about it — "Looking up what that process is." The user is watching these, and they are how they know you read what came back rather than carrying on regardless.
- Call several tools in one turn when the steps are already decided. Do not spend a round trip per keystroke.
- When the job is done, say what is now true in one or two sentences. If you found something out, give the answer itself — not a description of how you found it.

CHOOSING A TOOL
- The terminal is almost always fastest and most reliable. Installing software, files, processes, services, network, registry, settings, launching things: use \`run\`. A GUI is for what genuinely has no command.
- For anything on screen: \`screen\` to see it, then \`click\`, \`type\`, \`key\`, \`scroll\`, \`drag\`, \`draw\`. Click by the element's LABEL, copied exactly from the reading — \`click {text: "Eight"}\`, not \`click {element: 41}\` and never a coordinate you made up. Counting rows in a long list is how you press 7 when you meant 8.
- Selecting a range, moving a slider or dragging one thing onto another is \`drag\`. Anything with a SHAPE to it is \`draw\`: name the shape and its measurements — \`draw {shape: "circle", cx: 900, cy: 600, radius: 200}\` — and it arrives as one continuous stroke. Do not spell a curve out as a series of drags; the button comes up between drags, so what you get is disconnected straight lines. Pick the drawing tool FIRST; \`draw\` only moves the mouse.
- \`screen\` re-reads the window you are working in. The user may be looking at something else entirely; that is not your window and does not concern you. Only pass \`desktop: true\` if you genuinely need to know what is in front of them.
- Before typing into a field, click it. Text goes wherever focus happens to be, and where focus happens to be is not something you know.
- An application that was already running hands you the window the user was already using, with their work still in it. Opening it is not the same as getting a blank one. When the task is to write something NEW, call \`new_document\` first; only type into what is already open when the task is genuinely about that document.

CHECK BEFORE YOU CLAIM
- A delivered click or keystroke is not evidence anything happened. After acting in a window, read the screen back and quote what it says. After a command, its own output is the evidence — do not read the screen for that.
- Reading the screen CANNOT see a drawing, a shape, a photo or a colour — it reads text and controls. So never claim you drew, painted or produced something visual on the strength of a screen read: it would say the same thing about a blank canvas. \`drag\` and \`draw\` tell you directly whether the document changed; that is your evidence, and if one says nothing was drawn then nothing was drawn, whatever you intended.
- Before you send anything to a person — a message, an email — confirm from the screen that you are in the right conversation with the right name at the top. Sending the right words to the wrong person is worse than not sending them, and "I searched for them" is not confirmation that their chat is open.
- Never report something as done that you have not seen. If you could not confirm it, say exactly that and say what you did see instead.

WHEN SOMETHING FAILS
- Read the error. It usually says precisely what is wrong — "outside the window", "matches 3 things", "is not recognised" — and each of those has a different fix.
- Never repeat a call that just failed with the same arguments. It will fail the same way. Change something: a different target, a different tool, a different route to the same end.
- If the same approach has failed twice, it is the approach that is wrong, not the details. Step back and get there another way — a command instead of the GUI, a direct URL instead of filling a form, a different application.
- Do not report failure until you have actually run out of approaches.`;

function messageChars(messages) {
  let total = 0;
  for (const message of messages) total += String(message.content ?? "").length;
  return total;
}

// Trim from the oldest tool output forward, in place. Tool results are the bulk
// of a long conversation and the oldest are the least likely to matter; the
// user's request and the model's own reasoning are never trimmed, because those
// are what keep it on task.
function pruneConversation(messages) {
  if (messageChars(messages) <= MAX_CONVERSATION_CHARS) return;
  for (let index = 0; index < messages.length && messageChars(messages) > MAX_CONVERSATION_CHARS; index += 1) {
    const message = messages[index];
    if (message.role !== "tool" || String(message.content ?? "").length < 400) continue;
    messages[index] = { ...message, content: `${String(message.content).slice(0, 300)}\n… [earlier output trimmed]` };
  }
}

export class FastAgent {
  constructor({
    provider,
    toolset,
    onEvent = () => {},
    maxSteps = DEFAULT_MAX_STEPS,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    signal = null,
    systemPrompt = SYSTEM_PROMPT
  }) {
    this.provider = provider;
    this.toolset = toolset;
    this.onEvent = onEvent;
    this.maxSteps = maxSteps;
    this.maxElapsedMs = maxElapsedMs;
    this.signal = signal;
    this.systemPrompt = systemPrompt;
  }

  async _emit(event) {
    try { await this.onEvent(event); } catch { /* observers must not break the run */ }
  }

  /**
   * Run one user turn to completion.
   *
   * @returns {{status: string, message: string, steps: number, toolCalls: number, elapsedMs: number}}
   */
  async run(userText, { history = [] } = {}) {
    const startedAt = Date.now();
    // The toolset persists across turns so the agent keeps its place on the
    // machine; what it saw on screen last time does not survive the user having
    // had the keyboard in between.
    this.toolset.beginTurn?.();
    const messages = [
      { role: "system", content: this.systemPrompt },
      ...history.slice(-12).map((turn) => ({
        role: String(turn?.role ?? "user") === "assistant" ? "assistant" : "user",
        content: String(turn?.text ?? turn?.content ?? "").slice(0, 2000)
      })).filter((turn) => turn.content),
      { role: "user", content: String(userText) }
    ];

    let steps = 0;
    let toolCalls = 0;
    let lastText = "";
    // Calls that have already failed, by tool + arguments, with what they said.
    const failedCalls = new Map();

    while (steps < this.maxSteps) {
      if (this.signal?.aborted) {
        return this._settle("CANCELLED", lastText || "Stopped.", { steps, toolCalls, startedAt });
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= this.maxElapsedMs) {
        return this._settle(
          "PARTIALLY_COMPLETED",
          `${lastText ? `${lastText}\n\n` : ""}I ran out of time on this one. Anything already done is still in place.`,
          { steps, toolCalls, startedAt }
        );
      }
      steps += 1;

      let turn;
      try {
        turn = await this._callModel(messages, this.maxElapsedMs - elapsed);
      } catch (error) {
        // The user pressing stop aborts the in-flight request, which surfaces
        // here as a provider error. Reporting that as "all configured model
        // providers failed" blames the endpoint for something the user did, and
        // sends them looking for a fault that does not exist.
        if (this.signal?.aborted) {
          return this._settle(
            "CANCELLED",
            `${lastText ? `${lastText}\n\n` : ""}Stopped. Anything already done is still in place.`,
            { steps, toolCalls, startedAt }
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        await this._emit({ type: "AGENT_ERROR", details: { reason } });
        // WHOSE PROBLEM IS THIS?
        //
        // A raw `HTTP 429: {"object":"error","message":"Rate limit exceeded",...}`
        // pasted into "I was interrupted partway through (…)" tells the user that
        // something went wrong and gives them no way to know it was their model
        // account rather than the agent, the machine, or the request. It sends
        // them to debug the wrong thing — and there is nothing to debug.
        const rateLimited = /\b429\b|rate.?limit/i.test(reason);
        const cause = rateLimited
          ? "your model provider is rate-limiting this account — it stopped accepting requests, not the agent"
          : reason;
        return this._settle(
          toolCalls > 0 ? "PARTIALLY_COMPLETED" : "FAILED",
          toolCalls > 0
            ? `${lastText ? `${lastText}\n\n` : ""}I had to stop partway through: ${cause}. ` +
              "What I already did is still in place, so it is safe to ask again."
            : `I could not start: ${cause}. Nothing was changed.`,
          { steps, toolCalls, startedAt }
        );
      }

      if (turn.text.trim()) {
        lastText = turn.text.trim();
        await this._emit({ type: "AGENT_SAYS", details: { text: lastText } });
      }

      if (turn.toolCalls.length === 0) {
        return this._settle("COMPLETED", lastText || "Done.", { steps, toolCalls, startedAt });
      }

      messages.push({
        role: "assistant",
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }))
      });

      // Sequentially, because these share one screen, one focused window and one
      // pointer: running "click the field" and "type the password" at the same
      // time is not faster, it is a race.
      for (const call of turn.toolCalls) {
        // Stop means stop. Checked before each tool rather than only between
        // model calls, because a queued sequence of clicks and keystrokes would
        // otherwise all land after the user asked it to stop.
        if (this.signal?.aborted) {
          return this._settle(
            "CANCELLED",
            `${lastText ? `${lastText}\n\n` : ""}Stopped. Anything already done is still in place.`,
            { steps, toolCalls, startedAt }
          );
        }
        toolCalls += 1;
        let args = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `The arguments for ${call.name} were not valid JSON. Send them again.`
          });
          continue;
        }
        // The model's own line about this step, which arrived with the call and
        // therefore reaches the user before the work does. Suppressed when it
        // merely repeats what already streamed this turn.
        const say = String(args.say ?? "").trim();
        const saw = String(args.saw ?? "").trim();
        if ((say || saw) && say !== lastText) {
          lastText = say || saw;
          await this._emit({ type: "AGENT_SAYS", details: { text: say, observed: saw || null } });
        }
        // Narration is not an argument; showing it beside the tool name rendered
        // rows like `windows  Checking all open windows to find the...`.
        const { say: _said, saw: _observed, ...shown } = args;
        await this._emit({
          type: "TOOL_STARTED",
          details: { callId: call.id, tool: call.name, args: shown, preview: this.toolset.previewOf(call.name, args) }
        });

        // DOING THE SAME FAILING THING AGAIN IS NOT AN ATTEMPT.
        //
        // Told a coordinate was outside the window, the model clicked the exact
        // same coordinate again, was told the same thing, and clicked it a third
        // time. Nothing about the machine had changed between them, so nothing
        // about the outcome could. Three of a twenty-four step budget went on one
        // click that could never land, and the task ended unfinished.
        //
        // The prompt asks it not to. Prompts lose to enforcement here, and this
        // one is cheap to enforce: an identical call that already failed is
        // answered with what it failed with, plus the instruction to change
        // something, without spending the seconds or touching the machine.
        const signature = `${call.name}:${JSON.stringify(shown)}`;
        const priorFailure = failedCalls.get(signature);
        if (priorFailure) {
          const refusal =
            `You already ran exactly this and it failed: ${priorFailure}\n` +
            "Running it again will fail the same way. Change something — a different target, " +
            "a different tool, or a different route to the same result.";
          await this._emit({
            type: "TOOL_FINISHED",
            details: { callId: call.id, tool: call.name, ok: false, output: refusal, durationMs: 0, repeated: true }
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: refusal });
          continue;
        }

        const result = await this.toolset.execute(call.name, args);
        // A FAILURE IS ONLY FINAL UNTIL SOMETHING CHANGES.
        //
        // Recorded failures used to be permanent, which is wrong in the ordinary
        // case rather than the exotic one: click "Save" — not on screen — open
        // the File menu, click "Save" again, and the second click is refused with
        // "you already ran exactly this and it failed", when the menu that was
        // missing is now open. The task then fails for a reason that no longer
        // exists, and the model is told to stop trying the thing that would work.
        //
        // What the guard is actually for is the loop of identical attempts with
        // nothing in between. So a successful call — anything that moved the
        // machine or re-read it — clears the record: the world may no longer be
        // the one those calls failed in. Consecutive repeats are still refused.
        if (result.ok) failedCalls.clear();
        else failedCalls.set(signature, result.text);
        await this._emit({
          type: "TOOL_FINISHED",
          details: {
            callId: call.id,
            tool: call.name,
            ok: result.ok,
            output: result.text,
            durationMs: result.durationMs
          }
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text || "(no output)" });
      }

      pruneConversation(messages);
    }

    return this._settle(
      "PARTIALLY_COMPLETED",
      `${lastText ? `${lastText}\n\n` : ""}I stopped after ${this.maxSteps} steps without finishing. Anything already done is still in place.`,
      { steps, toolCalls, startedAt }
    );
  }

  async _callModel(messages, remainingMs) {
    // One retry, because the endpoint this runs against intermittently drops a
    // connection and losing a whole task to that is far more expensive than
    // sending the request again.
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.provider.chat({
          messages,
          tools: this.toolset.definitions,
          temperature: 0.2,
          maxTokens: 2048,
          timeoutMs: Math.max(15000, Math.min(90000, remainingMs)),
          signal: this.signal,
          onTextDelta: (delta) => { this._emit({ type: "AGENT_DELTA", details: { text: delta } }); },
          onRetry: (info) => { this._emit({ type: "AGENT_THROTTLED", details: info }); }
        });
      } catch (error) {
        lastError = error;
        if (this.signal?.aborted) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw lastError;
  }

  _settle(status, message, { steps, toolCalls, startedAt }) {
    const settled = { status, message, steps, toolCalls, elapsedMs: Date.now() - startedAt };
    this._emit({ type: "AGENT_DONE", details: settled });
    return settled;
  }
}
