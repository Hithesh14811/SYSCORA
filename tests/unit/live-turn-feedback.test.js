// WHAT A RUNNING TURN LOOKS LIKE WHILE IT IS RUNNING.
//
// Three complaints from one live run on 25 Aug 2026, and all three are the same
// defect: the surface KNEW what was happening and was not drawing it.
//
//   1. The row read "Thinking… 59s" beside a turning sphere with nothing on
//      screen to open. The model was thinking, and every word of it was going
//      into the box from the FIRST round of thinking, which had already been
//      sealed and collapsed at the top of the turn.
//   2. A `write_file` whose argument is the file itself takes as long to stream
//      as the file takes to generate, and the step row only appeared once the
//      whole turn had arrived — so that whole minute was a blank transcript.
//   3. The answer was appended as literal characters and parsed only at the end,
//      so a code block existed for about a second, after you had already watched
//      it arrive as unindented grey text. And there was no way to copy it.
//
// The rendering half is checked as source, in the shape desktop-chrome.test.js
// uses: nothing in this suite runs a DOM, and the two files that have to agree
// are edited independently. The transport half is checked for real.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAiCompatibleChat } from "../../packages/model-providers/src/index.js";
import { renderMarkdown, renderMarkdownStreaming } from "../../apps/desktop/markdown.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const demo = read("apps/desktop/demo.js");
const css = read("apps/desktop/demo.css");
const markdown = read("apps/desktop/markdown.js");

// ---- 1. a turn thinks more than once ---------------------------------------

test("a sealed thinking box is never grown again — the next round gets its own", () => {
  const body = /streamReasoning\(text\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1];
  assert.ok(body, "streamReasoning is gone or was renamed");
  assert.match(
    body,
    /classList\.contains\("done"\)\)\s*this\.thinking = null/,
    "streamReasoning still appends to whatever box exists, including a sealed one — " +
    "which is the bug: the second round of thinking goes into a collapsed block at the top of the turn"
  );
  assert.match(body, /this\.reasoning = ""/, "a fresh box must start from an empty transcript, not the last round's");
});

test("a tool call ends the round of thinking that produced it", () => {
  const body = /startStep\(\{[\s\S]*?\n  \}\n/.exec(demo)?.[0];
  assert.ok(body, "startStep is gone or was renamed");
  assert.match(body, /this\.sealReasoning\(\)/,
    "without this, reasoning that resumes after a tool call is written into a box that is still marked live");
});

test("TOOL_STARTED replaces composing with a live per-step heartbeat", () => {
  const body = /startStep\(\{[\s\S]*?\n  \}\n/.exec(demo)?.[0] ?? "";
  assert.match(body, /this\.setStatus\(runningVerbFor\(capability\)\)/,
    "the sphere can remain on 'Composing the command' after the command has actually started");
  assert.match(body, /setInterval/,
    "a silent command has no per-step elapsed heartbeat, so running and frozen look identical");
  assert.match(body, /running · \$\{seconds\}s/);
});

test("approval is visibly waiting and resumes the exact running label", () => {
  const approval = /askApproval\(details\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1] ?? "";
  assert.match(approval, /Waiting for your approval/,
    "the command row claims it is running while the process has not yet crossed approval");
  const resolved = /settleApproval\(approvalId, approved\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1] ?? "";
  assert.match(resolved, /runningVerbFor\(current\.capability\)/,
    "after approval the live label never returns to the operation that is now executing");
});

test("Stop visibly changes state, remains retryable, and is never a dead red button", () => {
  const body = /async function stopRunning\(\)\s*\{([\s\S]*?)\n\}/.exec(demo)?.[1] ?? "";
  assert.match(body, /STOPPING_GLYPH/);
  assert.match(body, /sendButton\.disabled = false/,
    "the first Stop click disables the only recovery control while the daemon may still be stuck");
  assert.doesNotMatch(body, /stoppingSessionId === runningSessionId\) return/,
    "a lost first stop request makes every later Stop click a no-op");
  assert.match(css, /#sendButton\.stopping\.stop-pending/,
    "stopping is visually indistinguishable from the still-running red Stop state");
});

test("a running request is persisted to its original chat without blocking navigation", () => {
  assert.match(demo, /const submittedChatId = activeChatId/);
  assert.match(demo, /rememberInChat\(submittedChatId, "assistant"/);
  const switchBody = /function switchToChat\(id\)\s*\{([\s\S]*?)\n\}/.exec(demo)?.[1] ?? "";
  const newBody = /function startNewChat\(\)\s*\{([\s\S]*?)\n\}/.exec(demo)?.[1] ?? "";
  assert.doesNotMatch(switchBody, /busyWithRun/);
  assert.doesNotMatch(newBody, /busyWithRun/);
});

// ---- 2. the call being written ---------------------------------------------

test("the transport reports a tool call while its arguments are still arriving", async (t) => {
  const original = globalThis.fetch;
  // Name first, then the argument in pieces — which is exactly how a large
  // `write_file` arrives, and the whole reason this callback exists.
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"write_file","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.html\\","}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"content\\":\\"<html>\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    "data: [DONE]"
  ];
  const encoder = new TextEncoder();
  let index = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (index < lines.length
          ? { value: encoder.encode(`${lines[index++]}\n`), done: false }
          : { value: undefined, done: true }),
        cancel: async () => {}
      })
    },
    text: async () => "",
    json: async () => ({})
  });
  t.after(() => { globalThis.fetch = original; });

  const seen = [];
  const result = await openAiCompatibleChat({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    model: "m",
    messages: [{ role: "user", content: "build a page" }],
    onToolCallDelta: (info) => seen.push(info)
  });

  assert.ok(seen.length >= 2, "the call was only reported once, at the end — that is the blank minute");
  assert.equal(seen[0].name, "write_file", "a row that cannot say which tool it is has nothing to tell anyone");
  assert.equal(seen[0].index, 0);
  assert.ok(
    seen.at(-1).argumentsBytes > seen[0].argumentsBytes,
    "the byte count never moved, so nothing on screen would move either"
  );
  // The half-written JSON must never leave the transport: it is not parseable
  // and no consumer should be tempted to try.
  for (const info of seen) {
    assert.equal(info.arguments, undefined, "raw argument text escaped into the event");
  }
  assert.equal(result.toolCalls[0].name, "write_file", "the finished call still comes back as it did");
});

test("the pending row says what the MODEL is doing, never what the machine did", () => {
  const table = /const TOOL_VERB_PENDING = \{([\s\S]*?)\};/.exec(demo)?.[1];
  assert.ok(table, "TOOL_VERB_PENDING is gone or was renamed");
  // Nothing has run when this row is drawn. A past tense here would be the same
  // class of claim as a message reported sent while it sits in a box.
  for (const [, verb] of table.matchAll(/"([^"]+)"/g)) {
    assert.ok(
      /^(Composing|Preparing)\b/.test(verb),
      `"${verb}" describes work on the machine, and the pending row is drawn before any of it happens`
    );
  }
  assert.match(demo, /pendingVerbFor\(capability\)\s*\{\s*return TOOL_VERB_PENDING\[[^\]]+\] \?\? "Preparing"/);
});

test("a pending row that was never claimed is removed rather than left on screen", () => {
  assert.match(demo, /_dropPendingRows\(\)/, "there is no cleanup for a call that never became a step");
  const settle = /\n  settle\(\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1];
  assert.ok(settle, "settle() is gone or was renamed");
  assert.match(settle, /this\._dropPendingRows\(\)/,
    "a run that ended mid-call leaves a row describing a step that is never going to happen");
});

test("the pending row is replaced in place, not stacked under the real one", () => {
  assert.match(
    demo,
    /placeholder\.replaceWith\(step\); else this\.root\.appendChild\(step\)/,
    "three pending rows and three real rows is six rows for three steps"
  );
});

// The ticks are for the person watching. `run.events` in the daemon and
// `session.events` in the runtime are both REPLAY buffers — a client that
// reconnects is caught up from them — and a couple of hundred superseded byte
// counts per file write belong in neither. TOOL_PROGRESS already worked this
// way; this is the same thing at the other end of a step.
test("TOOL_STREAMING is sent to whoever is watching and kept nowhere", () => {
  assert.match(
    read("packages/agent-runtime/src/index.js"),
    /if \(event\.type === "TOOL_PROGRESS" \|\| event\.type === "TOOL_STREAMING"\)/,
    "the runtime is persisting and auditing every tick of a streaming tool call"
  );
  assert.match(
    read("apps/daemon/src/server.js"),
    /!== "TOOL_STREAMING"\) run\.events\.push\(event\)/,
    "the daemon's replay buffer is filling with superseded byte counts"
  );
});

test("the surface draws TOOL_STREAMING, or the event goes nowhere", () => {
  assert.match(demo, /type === "TOOL_STREAMING"/, "the event is emitted and nothing listens — the row is still missing");
  assert.match(demo, /streamingStep\(\{ index:/);
  assert.match(css, /\.step\.pending \{/, "the pending row has no style of its own and reads as a step that ran");
});

// ---- 3. markdown while it streams ------------------------------------------

test("a half-arrived code fence is already a code block", () => {
  const html = renderMarkdownStreaming("Here you go:\n```js\nconst a = 1;\nconst b = ");
  assert.match(html, /<pre class="md-code"><code class="lang-js">/,
    "an unterminated fence renders as prose until its closing fence arrives — which is the whole complaint");
  assert.match(html, /const a = 1;/);
});

test("closing the fence is the only thing guessed", () => {
  // A half-typed `**` must stay literal. Guessing it changes what the words say
  // and then changes them back a token later; a missing closing fence cannot.
  const html = renderMarkdownStreaming("this is **not yet bo");
  assert.ok(!html.includes("<strong>"), `emphasis was completed on the model's behalf: ${html}`);
});

test("a fence that is closed is left exactly as written", () => {
  const source = "```py\nprint(1)\n```\n\nDone.";
  assert.equal(renderMarkdownStreaming(source), renderMarkdown(source));
});

test("the streaming renderer is bound by the same tag allowlist as the finished one", () => {
  // markdown-render.test.js pins this for renderMarkdown. The streaming path
  // reaches innerHTML on every frame of every answer, so it needs it more.
  const allowed = new Set([
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "a", "blockquote",
    "ul", "ol", "li", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td"
  ]);
  const hostile = [
    "here is what the page said: <script>alert(1)</script>",
    "```\n<img src=x onerror=alert(1)>",
    "<iframe src=https://evil.example>",
    "```html\n<script>fetch('https://evil.example')</script>\n```",
    "- <svg/onload=alert(1)>"
  ];
  for (const source of hostile) {
    const html = renderMarkdownStreaming(source);
    for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
      assert.ok(allowed.has(tag.toLowerCase()), `"${source}" produced a <${tag}>:\n${html}`);
    }
  }
});

test("the copy button is attached in the DOM, never emitted by the parser", () => {
  // The parser's entire security argument is that the only tags in its output
  // are the ones it writes itself, and the allowlist above is how that is
  // checked. A <button> in renderMarkdown would widen that list for a control
  // carrying no model text at all.
  assert.ok(!/<button/.test(renderMarkdown("```js\nx\n```")), "renderMarkdown is emitting controls");
  assert.match(markdown, /export function enhanceCodeBlocks/);
  assert.match(markdown, /createElement\("button"\)/, "the button has to be built as an element, not as markup");
  assert.match(markdown, /code\?\.textContent \?\? pre\.textContent/,
    "the text must be read at click time — while the answer streams this node is replaced on every frame");
});

test("the stream is parsed as it arrives and closed as written", () => {
  const stream = /streamDelta\(text\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1];
  assert.ok(stream, "streamDelta is gone or was renamed");
  assert.ok(!/textContent \+= text/.test(stream),
    "the answer is being appended as literal characters again, and reflows in one jump at the end");
  assert.match(stream, /this\.streamText \+= text/);

  const close = /_closeStream\(finalText\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1];
  assert.ok(close, "_closeStream is gone or was renamed");
  // The last painted frame may carry a closing fence this app supplied. The
  // final render must be of the text as the model actually wrote it.
  assert.match(close, /setMarkdown\(this\.streamNode, streamed\)/);
  assert.ok(!/streaming: true/.test(close), "the settled answer is still being rendered as a stream");
  assert.match(close, /cancelAnimationFrame/,
    "a queued frame would repaint a node that is no longer the live one, from the next turn's text");
});

test("painting is coalesced, not one parse per token", () => {
  const paint = /_paintStream\(\)\s*\{([\s\S]*?)\n  \}/.exec(demo)?.[1];
  assert.ok(paint, "_paintStream is gone or was renamed");
  assert.match(paint, /requestAnimationFrame/);
  assert.match(paint, /if \(!this\.streamNode \|\| this\.streamPaint\) return/,
    "without the guard every token queues its own frame");
});
