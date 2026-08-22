// Can we see inside a webview application?
//
// PHASE 1 OF THE PLAN, AND THE ONE THAT DECIDES WHETHER IT IS WORTH BUILDING.
//
// A huge share of the modern desktop is Chromium in a window: WhatsApp, Slack,
// Discord, Teams, Spotify, Notion, VS Code. Today SYSCORA reads those mostly by
// OCR, which is why an emoji react button — an icon with no text — is invisible,
// and why one live session spent 692,000 tokens hunting for one.
//
// Chromium DOES publish a full accessibility tree, with names on its icon
// buttons. The question this answers is whether it is publishing it to US, on
// this machine, right now.
//
//   node scripts/probe-webview-tree.mjs             # every candidate window
//   node scripts/probe-webview-tree.mjs whatsapp    # just the ones matching
//
// Read the summary at the bottom. If named buttons come back, build the adapter
// path (Phase 1 proper). If they do not, the finding is that Chromium is not
// exposing its tree to a non-assistive client, and the next thing to try is
// launching those apps with --force-renderer-accessibility. Either way it is a
// day, not a week.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const WEBVIEW_PROCESSES = /whatsapp|slack|discord|teams|spotify|notion|code|msedgewebview2|electron|figma|linear|obsidian|postman/i;
const filter = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

const adapter = new WindowsAdapter();
const pad = (value, width) => String(value).padEnd(width);

const windows = await adapter.listWindows().catch(() => []);
if (windows.length === 0) {
  console.log("No windows listed — is the automation host running?");
  process.exit(1);
}

const candidates = windows.filter((window) => {
  const name = `${window.ProcessName ?? window.processName ?? ""} ${window.MainWindowTitle ?? window.title ?? ""}`;
  if (!WEBVIEW_PROCESSES.test(name)) return false;
  return filter ? filter.test(name) : true;
});

if (candidates.length === 0) {
  console.log("None of the known webview applications are open.");
  console.log("Open WhatsApp, Slack, Discord or Spotify and run this again.");
  process.exit(0);
}

console.log(`${candidates.length} webview window(s) to inspect\n`);
const summary = [];

for (const window of candidates) {
  const windowId = String(window.WindowHandle ?? window.windowId ?? window.handle ?? "");
  const name = window.ProcessName ?? window.processName ?? "?";
  const title = String(window.MainWindowTitle ?? window.title ?? "").slice(0, 60);
  console.log(`── ${name} — ${title} (${windowId})`);

  const started = Date.now();
  const ui = await adapter.inspectUi({ windowId, maxElements: 2000 }).catch((error) => ({ error: error?.message }));
  const elapsed = Date.now() - started;
  if (ui?.error) {
    console.log(`   inspectUi failed: ${ui.error}\n`);
    summary.push({ name, total: 0, named: 0, namedControls: 0, elapsed });
    continue;
  }

  const elements = ui.elements ?? ui.targets ?? [];
  const named = elements.filter((element) => String(element.name ?? element.text ?? "").trim());
  // The question that matters. A control with a NAME can be clicked by label —
  // which is the difference between "click the react button" and guessing at
  // coordinates until the token budget runs out.
  const CONTROL = /button|menuitem|tab|link|hyperlink|checkbox|radio|combobox|edit|listitem/i;
  const namedControls = named.filter((element) =>
    CONTROL.test(String(element.controlType ?? element.role ?? "")));
  // Icon buttons are the prize: a control with a name but no text of its own.
  const iconish = namedControls.filter((element) => {
    const label = String(element.name ?? "").trim();
    return label.length > 0 && label.length < 30;
  });

  console.log(`   ${pad(elements.length, 6)} elements in ${elapsed}ms`);
  console.log(`   ${pad(named.length, 6)} carry a name`);
  console.log(`   ${pad(namedControls.length, 6)} are NAMED CONTROLS — clickable by label`);
  if (iconish.length) {
    console.log(`   examples: ${iconish.slice(0, 8).map((element) => `"${element.name}"`).join(", ")}`);
  }
  console.log("");
  summary.push({ name, total: elements.length, named: named.length, namedControls: namedControls.length, elapsed });
}

console.log("─".repeat(64));
console.log(`${pad("application", 20)} ${pad("elements", 10)} ${pad("named", 8)} ${pad("controls", 10)} time`);
for (const row of summary) {
  console.log(`${pad(row.name, 20)} ${pad(row.total, 10)} ${pad(row.named, 8)} ${pad(row.namedControls, 10)} ${row.elapsed}ms`);
}

const best = Math.max(0, ...summary.map((row) => row.namedControls));
console.log("");
if (best >= 20) {
  console.log("VERDICT: the tree is there. These applications publish named controls, so they");
  console.log("can be driven by label instead of by OCR and guesswork. Build the adapter path:");
  console.log("route windows whose process matches a webview to inspectUi-first perception, and");
  console.log("skip the OCR pass entirely for them. That is Phase 1 proper.");
} else if (best > 0) {
  console.log("VERDICT: partial. Some named controls, not enough to navigate by. Chromium");
  console.log("publishes its full tree only once it believes an assistive client is present.");
  console.log("Next experiment: relaunch one of these apps with --force-renderer-accessibility");
  console.log("and run this again. If the count jumps, the fix is launch flags, not perception.");
} else {
  console.log("VERDICT: nothing. Either inspectUi is not reaching these windows at all, or");
  console.log("Chromium is refusing to expose its tree. Check a native window (Notepad) with");
  console.log("this same probe first — if that is also empty, the problem is the host, not");
  console.log("the webview.");
}
