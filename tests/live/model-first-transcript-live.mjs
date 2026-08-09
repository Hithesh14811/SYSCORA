// Opt-in live check that the configured real model, not a keyword route, makes
// the decision for requests shaped like those that exposed the old assistant
// behavior. Personal chat/travel content is replaced with synthetic data before
// it leaves the machine. Destructive requests are classified but never run.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../../apps/daemon/src/runtime-factory.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-model-first-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "../..");
await fs.mkdir(path.join(tempRoot, ".syscora"), { recursive: true });
await fs.copyFile(path.join(repoRoot, ".syscora", "config.json"), path.join(tempRoot, ".syscora", "config.json"));

const runtime = createRuntime(tempRoot);
const reasoning = runtime.reasoningEngine;
const originalUnderstand = reasoning.understandIntent.bind(reasoning);
let currentTrace = null;
reasoning.understandIntent = async (...args) => {
  const result = await originalUnderstand(...args);
  if (currentTrace) currentTrace.modelCalls.push({ ok: result.ok, error: result.error ?? null, data: result.data ?? null });
  return result;
};

const cases = [
  {
    id: "conversational-chat",
    text: "tell me a short joke",
    pass: (intent) => intent.category === "CONVERSATION" && Boolean(intent.directAnswer)
  },
  {
    id: "spotify-play-and-queue",
    text: "play tum hi ho bandu on spotify and add attention to queue",
    pass: (intent) => (intent.operation === "spotify.track.play"
      || (intent.requiredCapabilities ?? []).includes("spotify.track.play"))
      && /tum hi ho band/i.test(String(intent.entities?.query ?? ""))
      && /attention/i.test(String(intent.entities?.queueQuery ?? ""))
  },
  {
    id: "whatsapp-draft",
    text: "type a polite draft message on whatsapp to Test Contact asking when they expect to return. do not send",
    pass: (intent) => intent.operation === "whatsapp.message.draft"
      && /^test contact$/i.test(String(intent.entities?.contact ?? ""))
      && String(intent.entities?.message ?? "").length > 15
      && intent.entities?.send !== true
  },
  {
    id: "youtube-generic-playback",
    text: "play wheels on the bus go round and round on youtube",
    pass: (intent) => intent.operation === "browser.media.play" && /youtube\.com/i.test(String(intent.entities?.url ?? ""))
  },
  {
    id: "youtube-creator-latest",
    text: "play ashish chanchlani's latest video on youtube",
    pass: (intent) => intent.operation === "browser.youtube.latest" && /ashish chanchlani/i.test(String(intent.entities?.creator ?? ""))
  },
  {
    id: "flight-research",
    text: "search the cheapest flight ticket from Testville to Sample City on 19th august one way economy",
    pass: (intent) => intent.operation === "browser.research" && /^https:/i.test(String(intent.entities?.url ?? ""))
  },
  {
    id: "calculator",
    text: "open calculator and do 99 x 1124",
    pass: (intent) => intent.operation === "calculator.evaluate"
      && intent.entities?.expression === "99*1124"
      && String(intent.entities?.expectedResult) === "111276"
  },
  {
    id: "reinstall-classification-only",
    text: "delete spotify and reinstall it",
    pass: (intent) => intent.operation === "package.winget.reinstall" && intent.entities?.id === "Spotify.Spotify"
  }
];

const report = [];
try {
  const requested = new Set(process.argv.slice(2));
  const selectedCases = requested.size > 0
    ? cases.filter((entry) => requested.has(entry.id))
    : cases;
  for (const entry of selectedCases) {
    currentTrace = { id: entry.id, modelCalls: [] };
    const startedAt = Date.now();
    const intent = await runtime.intentEngine.classify(entry.text, { workspacePath: tempRoot });
    const passed = currentTrace.modelCalls.length === 1 && currentTrace.modelCalls[0].ok === true && entry.pass(intent);
    const result = {
      id: entry.id,
      passed,
      elapsedMs: Date.now() - startedAt,
      modelCalled: currentTrace.modelCalls.length,
      modelSucceeded: currentTrace.modelCalls[0]?.ok === true,
      operation: intent.operation ?? null,
      category: intent.category,
      requiredCapabilities: intent.requiredCapabilities,
      entities: intent.entities,
      directAnswer: intent.directAnswer ?? null
    };
    report.push(result);
    console.log(JSON.stringify(result));
  }

  if (requested.size === 0 || requested.has("contextual-proceed")) {
    const history = [
      { role: "user", text: cases.find((entry) => entry.id === "flight-research").text },
      { role: "assistant", text: "I can open a live one-way economy flight search from Testville to Sample City on 19 August." }
    ];
    currentTrace = { id: "contextual-proceed", modelCalls: [] };
    const followup = await runtime.intentEngine.classify("proceed with that", { workspacePath: tempRoot, history });
    const result = {
      id: "contextual-proceed",
      passed: currentTrace.modelCalls.length === 1 && currentTrace.modelCalls[0].ok === true
        && /^browser\./.test(String(followup.operation ?? "")),
      modelCalled: currentTrace.modelCalls.length,
      modelSucceeded: currentTrace.modelCalls[0]?.ok === true,
      operation: followup.operation ?? null,
      category: followup.category,
      entities: followup.entities
    };
    report.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  currentTrace = null;
  runtime.adapter?.close?.();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ summary: `${report.filter((entry) => entry.passed).length}/${report.length}`, report }, null, 2));
if (report.some((entry) => !entry.passed)) process.exitCode = 1;
