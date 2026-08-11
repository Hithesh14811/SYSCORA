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
- Every tool takes a "say": one short first-person sentence about what you are doing right then — "Opening Spotify.", "Checking what's using that port.", "That path was wrong, trying the other one." Always fill it in. It is what the user sees while the tool runs, and a silent tool call reads to them as nothing happening.
- Keep talking as you go the way a colleague would — "that failed because the path is wrong, trying the other one" — but briefly. No preambles, no summaries of what you are about to summarise, no bullet-point plans nobody asked for.
- Call several tools in one turn when the steps are already decided. Do not spend a round trip per keystroke.
- When the job is done, say what is now true in one or two sentences. If you found something out, give the answer itself — not a description of how you found it.

CHOOSING A TOOL
- The terminal is almost always fastest and most reliable. Installing software, files, processes, services, network, registry, settings, launching things: use \`run\`. A GUI is for what genuinely has no command.
- For anything on screen: \`screen\` to see it, then \`click\`, \`type\`, \`key\`, \`scroll\`. Click by the element's LABEL, copied exactly from the reading — \`click {text: "Eight"}\`, not \`click {element: 41}\` and never a coordinate you made up. Counting rows in a sixty-item list is how you press 7 when you meant 8.
- After doing something in a window, read the screen back before claiming it worked. A delivered keystroke is not evidence the text arrived. After a command, its own output is the evidence — do not read the screen for that.
- If something fails, work out why from what you got back and try another way. Do not report failure until you have actually run out of approaches.`;

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
        const reason = error instanceof Error ? error.message : String(error);
        await this._emit({ type: "AGENT_ERROR", details: { reason } });
        return this._settle(
          toolCalls > 0 ? "PARTIALLY_COMPLETED" : "FAILED",
          toolCalls > 0
            ? `${lastText ? `${lastText}\n\n` : ""}I was interrupted partway through (${reason}). What I already did is still in place.`
            : `I could not reach the model (${reason}). Nothing was changed.`,
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
        if (say && say !== lastText) {
          lastText = say;
          await this._emit({ type: "AGENT_SAYS", details: { text: say } });
        }
        await this._emit({
          type: "TOOL_STARTED",
          details: { callId: call.id, tool: call.name, args, preview: this.toolset.previewOf(call.name, args) }
        });
        const result = await this.toolset.execute(call.name, args);
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
