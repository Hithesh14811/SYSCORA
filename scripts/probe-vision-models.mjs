// CAN ANY MODEL THIS KEY SERVES ACTUALLY LOOK AT THE SCREEN?
//
//   node scripts/probe-vision-models.mjs
//   node scripts/probe-vision-models.mjs --models zai-org/GLM-5.3,moonshotai/Kimi-K3
//
// THE GAP THIS IS MEASURING. `screen.capture` has written a PNG since the
// beginning and the capability registry's own comment says it "writes a PNG the
// agent cannot read". Nothing in this repository has ever sent an image to a
// model — `grep -rn "image_url"` over packages/ and apps/ returns nothing. So
// perception is the UIA tree plus Windows OCR, and the system prompt has to
// carry this paragraph:
//
//   "YOU CANNOT SEE ICONS. A reading is text and control names; a button that is
//    only a picture — an emoji react, a paperclip, an unlabelled three-dot menu
//    — does not appear in it at all... say plainly that you cannot see that
//    control and ask the user to click it."
//
// That is the single most un-JARVIS sentence in the product, and it is true.
// Before it can stop being true, something has to be able to see. This asks the
// only question that matters first: does the configured endpoint serve a model
// that accepts an image at all?
//
// IT IS GRADED ON A REAL SCREENSHOT, NOT A TEST CARD. A synthetic red circle
// proves an API accepts `image_url` and proves nothing about reading a Windows
// desktop, which is small text, thin icons and low contrast. So this captures a
// real window through the product's own capture path and asks a question whose
// answer is checkable from the window title.
//
// IT ONLY READS. One window is captured to a temp PNG. Nothing is clicked,
// typed or changed, and the automation host is closed on the way out — an
// undead host holds a stdio pipe and stops the process exiting (see W1).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { closeWindowsAutomationHost } from "../os-adapters/windows-host/src/client.js";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// Every model the key serves. Which of them are multimodal is exactly the thing
// nobody here knows, so the default is to ask all of them rather than to guess
// from the names — "GLM-4.7" says nothing about whether THIS deployment of it
// takes an image.
const DEFAULT_CANDIDATES = [
  "zai-org/GLM-5.3", "zai-org/GLM-5.3-Fast", "zai-org/GLM-5.3-Flash",
  "zai-org/GLM-5.2", "zai-org/GLM-5.2-Fast", "zai-org/GLM-4.7",
  "moonshotai/Kimi-K3", "moonshotai/Kimi-K2.6", "moonshotai/Kimi-K2.7-Code",
  "deepseek-ai/DeepSeek-V4-Pro-0813", "deepseek-ai/DeepSeek-V4-Flash-0731",
  "openai/gpt-oss-120b", "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
  "thinkingmachines/inkling", "thinkingmachines/inkling-small"
];

async function captureAWindow() {
  const adapter = new WindowsAdapter();
  // The adapter returns the host's own PascalCase rows — `MainWindowTitle`,
  // `Bounds`, `WindowHandle`. A first version of this guessed `title`/`width`
  // and found nothing on a desktop with 21 windows open, which is the ordinary
  // way to write a probe that reports a clean negative about nothing.
  const windows = await adapter.listWindows();
  const visible = (Array.isArray(windows) ? windows : windows?.windows ?? []).filter(
    (window) => String(window?.MainWindowTitle ?? "").trim()
      && Number(window?.Bounds?.width) > 400 && Number(window?.Bounds?.height) > 300
  );
  if (!visible.length) return { error: "no window big enough to be worth capturing" };
  // Whatever the user is actually looking at is the honest test case.
  const target = visible.find((window) => window.Foreground) ?? visible[0];
  const file = path.join(os.tmpdir(), `syscora-vision-probe-${Date.now()}.png`);
  const shot = await adapter.captureScreen({ windowId: String(target.WindowHandle), path: file });
  const capturedPath = shot?.path ?? file;
  let bytes;
  try {
    bytes = await fs.readFile(capturedPath);
  } catch (error) {
    return { error: `capture wrote nothing readable: ${error.message}` };
  }
  return { window: target, path: capturedPath, bytes };
}

async function askWithImage({ baseUrl, apiKey, model, base64, question }) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }
          ]
        }],
        max_tokens: 300,
        temperature: 0
      })
    });
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - startedAt, detail: error?.message ?? String(error) };
  }
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
    return { ok: false, elapsedMs, status: response.status, detail: body };
  }
  const body = await response.json();
  return {
    ok: true,
    elapsedMs,
    answer: String(body.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim(),
    inTokens: Number(body.usage?.prompt_tokens ?? 0)
  };
}

async function main() {
  const config = loadModelConfig(process.cwd());
  if (!config.apiKey) {
    console.error("No API key resolved from the configuration.");
    process.exit(2);
  }

  console.log("CAN ANYTHING HERE SEE? — real screenshot, every model this key serves");
  console.log(`  endpoint  ${config.baseUrl}\n`);

  const captured = await captureAWindow();
  if (captured.error) {
    console.error(`Could not capture a window: ${captured.error}`);
    closeWindowsAutomationHost();
    process.exit(2);
  }
  const base64 = captured.bytes.toString("base64");
  console.log(`  window    "${captured.window.MainWindowTitle}" (${captured.window.ProcessName ?? "?"})`);
  console.log(`  capture   ${captured.bytes.length.toLocaleString()} bytes PNG, ${Math.round(base64.length / 1024)} KB base64`);
  // The size is the second question. An image is charged as input tokens and a
  // desktop screenshot is not small; a model that can see but costs 3,000 tokens
  // a glance is a different product decision from one that costs 300.
  console.log(`  question  what application is this, and name one control you can see\n`);

  const candidates = flag("models")
    ? flag("models").split(",").map((name) => name.trim()).filter(Boolean)
    : DEFAULT_CANDIDATES;

  const seeing = [];
  for (const model of candidates) {
    const result = await askWithImage({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model,
      base64,
      question: "What application is shown in this screenshot, and name one button or control you can see in it? Answer in one short sentence."
    });
    if (!result.ok) {
      console.log(`  ${model.padEnd(42)} NO  ${result.status ?? "err"}  ${result.detail ?? ""}`);
      continue;
    }
    // GRADED ON THE WINDOW TITLE, which is ground truth the model was not told.
    // A model that answers fluently about a screenshot it cannot see is the
    // failure mode worth catching, and this codebase has a name for it.
    const words = String(captured.window.MainWindowTitle).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
    const hit = words.some((word) => result.answer.toLowerCase().includes(word))
      || result.answer.toLowerCase().includes(String(captured.window.ProcessName ?? "").toLowerCase().replace(/\.exe$/, ""));
    console.log(`  ${model.padEnd(42)} ${hit ? "SEES" : "?   "} ${String(result.elapsedMs).padStart(6)}ms ${String(result.inTokens).padStart(6)}t  ${result.answer.slice(0, 90)}`);
    if (result.ok) seeing.push({ model, hit, inTokens: result.inTokens, elapsedMs: result.elapsedMs });
  }

  console.log("\nWHAT THIS DECIDES");
  const canSee = seeing.filter((row) => row.hit);
  if (!canSee.length) {
    console.log("  NOTHING this key serves can read a screenshot. A vision fallback needs a second");
    console.log("  vendor configured before any of it can be built — that is a billing decision,");
    console.log("  not a code one, and it must be made before the work starts.");
  } else {
    console.log(`  ${canSee.length} model(s) read the real screenshot. Cheapest per glance:`);
    for (const row of [...canSee].sort((left, right) => left.inTokens - right.inTokens).slice(0, 3)) {
      console.log(`    ${row.model.padEnd(42)} ${row.inTokens.toLocaleString()} input tokens, ${row.elapsedMs}ms`);
    }
    console.log("  Compare against a `screen` reading of the same window before wiring anything:");
    console.log("  text perception is 267-1,029 tokens and already NAMES its controls.");
  }

  await fs.unlink(captured.path).catch(() => {});
  // AN UNDEAD HOST STOPS THE PROCESS EXITING. See W1 in state-of-the-world.
  closeWindowsAutomationHost();
}

main().catch(async (error) => {
  console.error(error);
  closeWindowsAutomationHost();
  process.exit(1);
});
