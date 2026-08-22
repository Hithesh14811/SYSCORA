// THE AGENT'S OWN PATH: screen -> click -> type, and what the box holds after.
//
// probe-typing-lands.mjs drives the CAPABILITIES directly and the text lands
// every time. The agent drives the TOOLS, and live it was told "the focused
// control does NOT contain this text" on every attempt. Two different code
// paths, so run the second one and print every step.
//
// Types only. NEVER presses Enter, so nothing is sent.
//
//   node scripts/probe-type-through-toolset.mjs whatsapp "probe text"

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const application = process.argv[2] ?? "whatsapp";
const text = process.argv[3] ?? "probe text";
const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
toolset.setConfirmer?.(async () => { console.log("!! a confirmation was asked for — answering NO"); return false; });
await adapter.automationHost?.warm?.();

const step = async (name, args) => {
  const startedAt = Date.now();
  const result = await toolset.execute(name, args);
  console.log(`\n${name} ${JSON.stringify(args)} — ${Date.now() - startedAt}ms ok=${result.ok}`);
  console.log(String(result.text ?? "").split("\n").slice(0, 4).join("\n"));
  return result;
};

const reading = await step("screen", { application });
const box = String(reading.text ?? "").split("\n").find((line) => /type a message/i.test(line));
console.log(`\nmessage box row: ${box ?? "NOT IN THE READING"}`);
const label = box?.match(/"([^"]+)"/)?.[1];

await step("click", { text: label ?? "Type a message" });
console.log(`\nfocused right after the click: ${JSON.stringify(await toolset.focusedValue())}`);
await step("type", { text });
console.log(`\nfocused right after typing:    ${JSON.stringify(await toolset.focusedValue())}`);

console.log("\nNothing was sent.");
adapter.close?.();
process.exit(0);
