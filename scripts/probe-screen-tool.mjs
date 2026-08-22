// THE READING THE MODEL IS ACTUALLY GIVEN, IN FULL.
//
// probe-conversation-text.mjs calls adapter.inspectUi directly and sees the
// conversation. The `screen` TOOL goes through the perception layer, and a live
// run insisted "the screen reading isn't capturing the message content" for
// fifteen steps and 194,328 tokens. Those are two different code paths, so print
// what the tool returns, whole, and compare.
//
//   node scripts/probe-screen-tool.mjs whatsapp

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const application = process.argv[2] ?? "whatsapp";
const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

const startedAt = Date.now();
const result = await toolset.execute("screen", { application });
console.log(`${Date.now() - startedAt}ms, ok=${result.ok}\n`);
console.log(result.text);

adapter.close?.();
process.exit(0);
