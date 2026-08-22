#!/usr/bin/env node
// WHAT DOES A MESSAGE'S OWN MENU LOOK LIKE, AND HOW DO YOU OPEN IT?
//
// READ-ONLY BY DEFAULT. It opens the menu and prints what is in it. It does not
// choose anything. Pass --press "<label>" to invoke one item, which is how the
// deletion path gets exercised once the reading is understood — never before.
//
// It targets messages whose text matches EXACTLY, and defaults to `eval-ping`,
// the agent's own test messages in the user's "Message yourself" chat. Nothing
// here should ever run against another person's conversation.
//
// The four traps this has to survive, all of them observed live:
//   2. message text is IsControlElement=false, so the raw view is the only pass
//      that sees it;
//   4. a WebView2 app is two unrelated top-level windows — the frame owns input,
//      the Chromium content window owns the reading. Found by PARENTAGE, never
//      by title;
//   5. the working window slides back to the frame, after which every reading
//      returns the same caption buttons;
//   3. a synthetic click delivered after another window held the foreground is
//      swallowed — so the frame is activated first and the result is checked.
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1];
};
const needle = flag("text") ?? "eval-ping";
const press = flag("press");
if (!needle.trim()) throw new Error("Empty needle: that would match every message and check nothing.");

const adapter = new WindowsAdapter();
const say = (...parts) => console.log(...parts);

// The content window, by parentage. `process.parents` is what the host offers
// for exactly this.
const windows = await adapter.listWindows();
const frame = windows.find((w) => w.ProcessName === "WhatsApp.Root" && String(w.MainWindowTitle ?? "").trim());
if (!frame) {
  say("WhatsApp.Root has no titled window — is WhatsApp running?");
  process.exit(1);
}
const content = windows.find((w) => w.ProcessName === "msedgewebview2" && /WhatsApp/.test(String(w.MainWindowTitle ?? "")));
say(`frame   ${frame.ProcessName} "${frame.MainWindowTitle}" (${frame.WindowHandle})`);
say(`content ${content?.ProcessName} "${content?.MainWindowTitle}" (${content?.WindowHandle})`);
if (!content) { say("no content window found by parentage — trap 4"); process.exit(1); }

async function rawText(windowId) {
  const reading = await adapter.hostRequest("ui.inspect", { windowId, includeHidden: true }, { timeoutMs: 30000 });
  return reading?.targets ?? reading?.elements ?? [];
}

const before = await rawText(content.WindowHandle);
const hits = before.filter((el) => String(el.name ?? "").trim() === needle);
say(`\nraw-view elements: ${before.length}, exact matches for ${JSON.stringify(needle)}: ${hits.length}`);
if (hits.length === 0) {
  say("nothing to work with. The message may have scrolled out of the virtualised list.");
  process.exit(1);
}
for (const [i, h] of hits.entries()) {
  say(`  ${i}: "${h.name}" ${JSON.stringify(h.boundingRect)}`);
}

// The LAST one is the most recent, which is the one an undo would target.
const target = hits[hits.length - 1];
const bounds = target.boundingRect ?? {};
const centre = {
  x: Math.round(Number(bounds.x) + Number(bounds.width ?? 0) / 2),
  y: Math.round(Number(bounds.y) + Number(bounds.height ?? 0) / 2)
};
say(`\ntargeting the most recent at ${centre.x},${centre.y}`);

// TRAP 4 AND 5: input goes to the FRAME.
const activated = await adapter.hostRequest("window.activate", { windowId: frame.WindowHandle }, { timeoutMs: 15000 });
say(`window.activate frame -> ${JSON.stringify(activated).slice(0, 160)}`);

await adapter.hostRequest("pointer.click", { x: centre.x, y: centre.y, button: "right" }, { timeoutMs: 15000 });
await new Promise((r) => setTimeout(r, 900));

// A Chromium context menu may be a popup OUTSIDE the content window, so look at
// every top-level window rather than only the one that was clicked.
const after = await adapter.listWindows();
const fresh = after.filter((w) => !windows.some((old) => old.WindowHandle === w.WindowHandle));
say(`\nnew top-level windows after the right-click: ${fresh.length}`);
for (const w of fresh) say(`  ${w.ProcessName} "${w.MainWindowTitle}" cls=${w.ClassName} (${w.WindowHandle})`);

const menuSources = [...fresh.map((w) => w.WindowHandle), content.WindowHandle];
for (const handle of menuSources) {
  const items = await rawText(handle).catch(() => []);
  const menuish = items.filter((el) => /menuitem|listitem|button/i.test(String(el.controlType ?? ""))
    && String(el.name ?? "").trim());
  if (menuish.length === 0) continue;
  say(`\n--- controls under window ${handle} (${menuish.length}) ---`);
  for (const el of menuish.slice(0, 40)) {
    say(`  ${String(el.controlType).replace("ControlType.","").padEnd(12)} ${JSON.stringify(el.name)}`);
  }
}

if (press) {
  say(`\n--press ${JSON.stringify(press)} — invoking it`);
  const invoked = await adapter.hostRequest("ui.invoke", { windowId: content.WindowHandle, name: press }, { timeoutMs: 20000 });
  say(`ui.invoke -> ${JSON.stringify(invoked).slice(0, 300)}`);
} else {
  say("\nRead-only. Closing the menu with Escape.");
  await adapter.hostRequest("keyboard.press", { keys: "escape" }, { timeoutMs: 10000 }).catch(() => {});
}

await adapter.close?.();
process.exit(0);
