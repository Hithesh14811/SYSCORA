// CAN THE CONFIGURED MODEL ACTUALLY SEE THE SCREEN?
//
//   node scripts/probe-vision-live.mjs [application]
//
//   SYSCORA_VISION_MODEL=claude-opus-5 \
//   SYSCORA_VISION_BASE_URL=https://api.anthropic.com \
//   SYSCORA_VISION_API_KEY=... \
//   node scripts/probe-vision-live.mjs notepad
//
// THE ONE THING ABOUT VISION THAT HAS NEVER BEEN PROVEN.
//
// `screen {vision: true}` is built, unit-tested through both transports, and
// proven end to end on a real window — a 204,890-byte PNG of Chrome, valid
// header, exact base64 round trip, temp file cleaned up. What has never happened
// is ONE REAL REQUEST to a model with eyes, because the endpoint configured on
// this machine serves sixteen models and not one of them can see:
//
//   deepseek-ai/DeepSeek-V4-{Flash,Pro}   moonshotai/Kimi-K2.6, K2.7-Code, K3
//   nvidia/Nemotron-3-Ultra               openai/gpt-oss-120b
//   thinkingmachines/inkling{,-small}     zai-org/GLM-4.7, 5.2, 5.2-Fast, 5.3...
//
// Until that request happens the capability is MEASURED, not DEMONSTRATED, and
// the difference matters: the whole "text first, pixels as the exception" claim
// rests on the exception actually working.
//
// So this takes a real window, captures it, sends it to a vision model, and asks
// one question whose answer cannot be guessed from the request — what the window
// is and what is written in it. It prints the reply, the tokens, and the latency.
// A model that answers with the window's real contents has seen it; a model that
// answers plausibly-but-wrongly has not, and the reply is printed in full so a
// person decides which happened rather than a regex.
//
// It reads the screen and makes one model request. It changes nothing.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { createModelProviderChain, modelSupportsVision } from "../packages/model-providers/src/index.js";
import { loadModelConfig } from "../apps/daemon/src/model-config.js";

const application = process.argv[2] ?? "notepad";

// A vision model named in the environment wins over the configured one, so this
// can be pointed at a second vendor without touching `.syscora/config.json` —
// which is the user's file and holds their live credentials.
const override = process.env.SYSCORA_VISION_MODEL;
const config = loadModelConfig(process.cwd());
const modelConfig = override
  ? {
      ...config,
      provider: process.env.SYSCORA_VISION_PROVIDER ?? (/claude|opus|sonnet|haiku/i.test(override) ? "anthropic" : "openai"),
      model: override,
      baseUrl: process.env.SYSCORA_VISION_BASE_URL ?? config.baseUrl,
      apiKey: process.env.SYSCORA_VISION_API_KEY ?? config.apiKey,
      fallbackProviderConfigs: []
    }
  : config;

const provider = createModelProviderChain(modelConfig);
const model = modelConfig.model ?? "(unnamed)";

console.log(`  model              ${model}`);
console.log(`  endpoint           ${modelConfig.baseUrl}`);
console.log(`  supportsVision()   ${provider.supportsVision?.() === true}`);
console.log(`  name says vision   ${modelSupportsVision(model)}`);

if (provider.supportsVision?.() !== true) {
  console.log("\n  This model cannot see, so there is nothing to prove here.");
  console.log("  Point the probe at one that can:\n");
  console.log("    SYSCORA_VISION_MODEL=claude-opus-5 \\");
  console.log("    SYSCORA_VISION_BASE_URL=https://api.anthropic.com \\");
  console.log("    SYSCORA_VISION_API_KEY=<your key> \\");
  console.log("    node scripts/probe-vision-live.mjs notepad\n");
  console.log("  Nothing was captured and no request was made.");
  process.exit(1);
}

const adapter = new WindowsAdapter();
const registry = createDefaultCapabilityRegistry(adapter);
const toolset = buildToolset({ registry, adapter });
toolset.beginTurn?.(`look at ${application}`);
toolset.setVisionAvailable?.(true);

try {
  const withPicture = await toolset.execute("screen", { application, vision: true });
  const attachment = withPicture?.raw?.imageAttachment;
  if (!attachment) {
    console.log(`\n  No picture came back for "${application}". Result was:\n  ${String(withPicture?.text).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`\n  captured           ${attachment.bytes?.toLocaleString("en-GB") ?? "?"} bytes, ${attachment.mediaType}`);

  // A question whose answer is IN THE WINDOW and not in the question. A model
  // that cannot see has to invent, and an invention is obvious beside a reading.
  const startedAt = Date.now();
  const turn = await provider.chat({
    messages: [
      { role: "system", content: "You are looking at a screenshot of a single application window." },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Describe this window in two sentences: which application it is, and the exact text you can "
              + "read in it. Quote the text verbatim. If you cannot see an image, say exactly: NO IMAGE RECEIVED."
          },
          { type: "input_image", mediaType: attachment.mediaType, data: attachment.data }
        ]
      }
    ],
    tools: [],
    temperature: 0,
    maxTokens: 400,
    timeoutMs: 120000
  });
  const elapsed = Date.now() - startedAt;

  console.log(`  latency            ${elapsed}ms`);
  console.log(`  tokens in/out      ${turn.usage?.prompt_tokens ?? "?"} / ${turn.usage?.completion_tokens ?? "?"}`);
  console.log(`  finishReason       ${turn.finishReason ?? "(none)"}`);
  console.log("\n  WHAT THE MODEL SAID\n");
  console.log(String(turn.text ?? "(nothing)").split("\n").map((line) => `    ${line}`).join("\n"));

  console.log("\n  WHAT THE READING SAID (compare them yourself)\n");
  console.log(String(withPicture.text ?? "").split("\n").slice(0, 14).map((line) => `    ${line}`).join("\n"));

  const blind = /NO IMAGE RECEIVED/i.test(String(turn.text ?? ""));
  console.log(blind
    ? "\n  RESULT: the model reports it received no image. The transport did not deliver it."
    : "\n  RESULT: a real request carrying a real screenshot completed. Read the two blocks above:\n"
      + "          if the description matches the reading, this model can see this agent's screen.");
  process.exitCode = blind ? 1 : 0;
} catch (error) {
  console.log(`\n  REQUEST FAILED: ${error?.message ?? error}`);
  console.log("  An HTTP 400 here usually means the endpoint rejected the image block —");
  console.log("  which is the thing this probe exists to catch before a user hits it mid-task.");
  process.exitCode = 1;
} finally {
  try {
    const { closeWindowsAutomationHost } = await import("../os-adapters/windows-host/src/client.js");
    await Promise.resolve(closeWindowsAutomationHost?.());
  } catch { /* teardown must not mask the result */ }
}
