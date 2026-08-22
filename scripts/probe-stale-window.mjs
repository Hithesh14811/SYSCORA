// WHAT DOES A READING OF A WINDOW THAT IS NOT THERE LOOK LIKE?
//
//   node scripts/probe-stale-window.mjs
//
// Observed live, 20 Aug 2026. `launch WhatsApp` handed back windowId 198130 and
// wrote it into the working window. The very next `screen the working window`
// spent 11.8 seconds and came back headed
//
//   Window: WhatsApp.Root — WhatsApp (windowId 198130)
//
// with 186 elements in it: Visual Studio Code's menus, Opera's toolbar, Chrome's
// bookmarks, Spotify's transport. Every application on the desktop except the
// one it named. The agent noticed the reading "looks scrambled", forced focus,
// read again and got the real window (197286) — so the request survived, at the
// cost of two extra steps and about twelve seconds.
//
// THE PART THAT MATTERS IS WHY NOTHING CAUGHT IT. The screen tool only reaches
// for the WebView2 content window when the first reading has no usable content,
// and `hasUsableContent` counts elements. A desktop-wide reading has hundreds,
// so the guard passes at full confidence in exactly the case it exists to catch,
// and the wrong window is returned under the right window's name.
//
// So this asks two questions with no model in the loop:
//
//   1. a handle that does not exist — is that an error, or a tree?
//   2. the real launch → read sequence — which window answers?
//
// It would FAIL to find anything if a dead handle produced an error or an empty
// reading. Both are fine answers; silently returning the desktop is not.

import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

const heading = (text) => (String(text).match(/^Window: .*$/m)?.[0] ?? "(no window heading)");
const elementCount = (text) => (String(text).match(/^\s*\d+\|/gm) ?? []).length;

// A SECOND LOOK AT AN UNCHANGED WINDOW HAS NO ELEMENT LIST, AND THAT IS THE TOOL
// WORKING. It answers "IDENTICAL to your last reading" and spends no tokens on
// the same 150 rows. Counting element lines alone reports that as "0 elements",
// which reads as a broken reading and is the opposite of the truth — this probe
// exists to find misleading readings, so it had better not produce one.
const isUnchangedReading = (text) => /^IDENTICAL to your last reading/m.test(String(text));

// Labels that belong to applications this reading was NOT asked about. A single
// window cannot contain another program's menu bar, so one hit here means the
// reading is not of a window at all.
// Machine-specific by nature: these are labels seen bleeding in from whatever
// else happened to be open when the bug was reproduced. Add whatever your own
// desktop contributes — a hit means the reading is not of one window.
const FOREIGN = ["Opera menu", "Toggle Panel", "Search tabs", "Now playing bar", "Address bar"];
const foreign = (text) => FOREIGN.filter((label) => String(text).includes(label));

const report = (label, ms, result) => {
  const text = String(result?.text ?? "");
  const strangers = foreign(text);
  const what = isUnchangedReading(text)
    ? "unchanged since the last look (no list re-sent)"
    : `${elementCount(text)} elements`;
  console.log(`${label}`);
  console.log(`  ${ms}ms · ok=${result?.ok} · ${what}`);
  console.log(`  ${heading(text)}`);
  console.log(`  other applications visible in it: ${strangers.length ? strangers.join(", ") : "none"}`);
  console.log("");
  return { elements: elementCount(text), strangers: strangers.length };
};

const timed = async (name, args) => {
  const startedAt = Date.now();
  const result = await toolset.execute(name, args).catch((error) => ({ ok: false, text: String(error?.message ?? error) }));
  return { ms: Date.now() - startedAt, result };
};

console.log("\nDOES A DEAD WINDOW HANDLE READ AS THE DESKTOP?\n");

// 1. A handle that cannot be a live window. Nothing should answer to this.
const dead = await timed("screen", { windowId: 999999999 });
const deadReading = report("1. screen windowId=999999999 (no such window)", dead.ms, dead.result);

// 2. The sequence from the live run: launch, then read the working window with
//    no application named — which is what the agent does when it believes it
//    already knows where it is.
const launched = await timed("launch", { application: "WhatsApp" });
const launchedId = String(launched.result?.text ?? "").match(/windowId (\d+)/)?.[1] ?? "?";
console.log(`2. launch WhatsApp → ${launched.ms}ms · windowId ${launchedId}\n`);

const working = await timed("screen", {});
const workingReading = report("3. screen with no application named (the working window)", working.ms, working.result);

// 3. The same look, asked for by name — the route that works, for comparison.
const byName = await timed("screen", { application: "WhatsApp" });
const namedReading = report("4. screen application=\"WhatsApp\"", byName.ms, byName.result);

console.log("-".repeat(78));
if (deadReading.elements > 20) {
  console.log(`A handle that does not exist returned ${deadReading.elements} elements. That is a fabricated reading.`);
} else {
  console.log(`A handle that does not exist returned ${deadReading.elements} elements — it did not fabricate a tree.`);
}
if (workingReading.strangers > 0) {
  console.log(`The working-window read contained ${workingReading.strangers} other applications' controls. It is not a window reading.`);
} else {
  console.log("The working-window read contained no other application's controls.");
}
console.log(`By name: ${namedReading.strangers} strangers, ${byName.ms}ms.`);

adapter.close?.();
process.exit(0);
