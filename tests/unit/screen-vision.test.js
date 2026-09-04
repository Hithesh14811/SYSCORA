// "YOU CANNOT SEE ICONS" — THE AGENT'S OWN SYSTEM PROMPT, AND ITS OLDEST GAP.
//
// A reading is text and control names, so a control with no label — an emoji
// react, a paperclip, an unlabelled three-dot menu — does not appear in it at
// all. The measured cost of that blindness is the `unchangedReadings >= 8` guard
// firing after forty-eight steps and 692,000 tokens spent hunting for a button
// that was never going to be in the tree.
//
// `screen {vision: true}` is the answer, and these tests pin the four things that
// make it safe rather than merely present:
//
//   1. it never engages on a model that cannot see, because sending an image to
//      one fails the whole request rather than the look
//   2. a picture that was asked for and did not arrive SAYS SO, because silence
//      would be read as "there is nothing there"
//   3. the block is vendor-neutral in the loop and spelled by each transport
//   4. a screenshot is accounted for at what it costs, not at the length of its
//      base64 and not at the fifteen characters of "[object Object]"

import test from "node:test";
import assert from "node:assert/strict";
import { FastAgent } from "../../packages/fast-agent/src/index.js";
import {
  contentChars,
  dropStaleImages,
  IMAGE_TOKENS,
  messageChars
} from "../../packages/fast-agent/src/context-budget.js";
import { toAnthropicMessages } from "../../packages/model-providers/src/index.js";

const PIXEL = "iVBORw0KGgoAAAANSUhEUg==";

function visionProvider(turns, { vision = true } = {}) {
  const sent = [];
  return {
    sent,
    model: vision ? "claude-opus-5" : "deepseek-chat",
    supportsChat: () => true,
    supportsVision: () => vision,
    async chat({ messages }) {
      sent.push(structuredClone(messages));
      const turn = turns.shift() ?? { text: "Done." };
      return {
        text: turn.text ?? "",
        toolCalls: (turn.toolCalls ?? []).map((call, index) => ({
          id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {})
        })),
        finishReason: turn.toolCalls?.length ? "tool_calls" : "stop"
      };
    }
  };
}

function screenToolset(result) {
  const seen = [];
  return {
    seen,
    definitions: [{ type: "function", function: { name: "screen", description: "", parameters: {} } }],
    has: () => true,
    previewOf: () => "",
    isActingTool: () => false,
    setVisionAvailable(available) { seen.push(available); },
    async execute() { return result; }
  };
}

test("the loop tells the toolset whether the configured model has eyes", async () => {
  const seeing = screenToolset({ ok: true, text: "Window: Notepad" });
  await new FastAgent({ provider: visionProvider([{ text: "ok" }]), toolset: seeing, maxSteps: 2 })
    .run("look");
  assert.deepEqual(seeing.seen, [true]);

  const blind = screenToolset({ ok: true, text: "Window: Notepad" });
  await new FastAgent({ provider: visionProvider([{ text: "ok" }], { vision: false }), toolset: blind, maxSteps: 2 })
    .run("look");
  assert.deepEqual(blind.seen, [false]);
});

// A provider that has no opinion must be treated as blind. Unknown means no:
// a model that cannot see, sent an image, answers HTTP 400 mid-task.
test("a provider that says nothing about vision is treated as blind", async () => {
  const toolset = screenToolset({ ok: true, text: "x" });
  const provider = { supportsChat: () => true, async chat() { return { text: "ok", toolCalls: [] }; } };
  await new FastAgent({ provider, toolset, maxSteps: 2 }).run("look");
  assert.deepEqual(toolset.seen, [false]);
});

// THE PICTURE IS A MESSAGE OF ITS OWN. A tool result must stay a string —
// OpenAI's wire format has no way to put an image in one — so the loop turns the
// attachment into a `user` turn every provider understands.
test("an attached screenshot becomes a vendor-neutral image message", async () => {
  const provider = visionProvider([
    { text: "Looking.", toolCalls: [{ name: "screen", args: { vision: true } }] },
    { text: "The paperclip is at the bottom left." }
  ]);
  const toolset = screenToolset({
    ok: true,
    text: "Window: WhatsApp",
    raw: { imageAttachment: { mediaType: "image/png", data: PIXEL, bytes: 18 } }
  });

  await new FastAgent({ provider, toolset, maxSteps: 4 }).run("what is that icon");

  // The SECOND request is the one that carries the picture.
  const second = provider.sent[1];
  const toolResult = second.find((m) => m.role === "tool");
  assert.equal(typeof toolResult.content, "string", "a tool result must stay a string");
  const image = second.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "input_image"));
  assert.ok(image, "the screenshot must reach the model as its own message");
  assert.equal(image.role, "user");
  assert.equal(image.content.find((b) => b.type === "input_image").data, PIXEL);
});

test("no attachment means no extra message at all", async () => {
  const provider = visionProvider([
    { text: "Looking.", toolCalls: [{ name: "screen", args: {} }] },
    { text: "Four windows are open." }
  ]);
  await new FastAgent({ provider, toolset: screenToolset({ ok: true, text: "Window: Notepad" }), maxSteps: 4 })
    .run("what is open");
  const second = provider.sent[1];
  assert.equal(second.some((m) => Array.isArray(m.content)), false);
});

// Each transport spells it its own way — the same argument as `reasoningBody`.
// A vendor's field names must not be in the loop.
test("Anthropic gets its own image shape, not the neutral one", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "what is that" },
    { role: "user", content: [{ type: "text", text: "[the window]" }, { type: "input_image", mediaType: "image/png", data: PIXEL }] }
  ]);
  const block = messages.flatMap((m) => m.content).find((b) => b.type === "image");
  assert.ok(block, "the neutral block must be translated, not passed through");
  assert.deepEqual(block.source, { type: "base64", media_type: "image/png", data: PIXEL });
  assert.equal(messages.flatMap((m) => m.content).some((b) => b.type === "input_image"), false);
});

// A BASE64 SCREENSHOT IS NOT WHAT IT COSTS. Counting the string says two million
// characters for one look and trims the whole conversation; counting
// `String(content)` on an array says "[object Object]" — fifteen characters — and
// the run walks into the context window believing it is nearly empty. Both
// failures are silent and both are expensive.
test("a screenshot is counted at what it costs, not at either wrong answer", () => {
  const image = [{ type: "text", text: "hi" }, { type: "input_image", mediaType: "image/png", data: "A".repeat(2_000_000) }];
  const counted = contentChars(image);
  assert.ok(counted > 1_000, "an image must not count as fifteen characters");
  assert.ok(counted < 100_000, "an image must not count as the length of its base64");
  assert.equal(counted, 2 + IMAGE_TOKENS * 4);
  assert.equal(messageChars([{ role: "user", content: image }]), counted);
});

// A LOOK IS ONLY TRUE UNTIL THE NEXT ONE — the same argument as
// `supersedeEarlierReading`, and far more expensive here: six screenshots is
// ~9,000 tokens of pictures of windows that have all since changed.
test("only the newest screenshot survives, and the loss is announced", () => {
  const shot = (n) => ({
    role: "user",
    content: [{ type: "text", text: `look ${n}` }, { type: "input_image", mediaType: "image/png", data: PIXEL }]
  });
  const messages = [{ role: "user", content: "go" }, shot(1), { role: "assistant", content: "a" }, shot(2), shot(3)];

  const dropped = dropStaleImages(messages);

  assert.equal(dropped, 2);
  const remaining = messages.filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "input_image"));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].content[0].text, "look 3", "the newest must be the one kept");
  // Announced, not silently removed: a turn that quietly lost the picture it was
  // reasoning about reads as one that never had it.
  const emptied = messages[1].content.map((b) => b.text).join(" ");
  assert.match(emptied, /dropped/i);
});

test("dropping images is idempotent, so a long run does not keep re-announcing", () => {
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "look" }, { type: "input_image", mediaType: "image/png", data: PIXEL }]
  }];
  assert.equal(dropStaleImages(messages), 0, "the only image is the newest and must be kept");
  assert.equal(dropStaleImages(messages), 0);
});
