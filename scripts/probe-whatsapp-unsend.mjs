#!/usr/bin/env node
// THE WHOLE UN-SEND ROUND TRIP, AGAINST THE USER'S OWN "Message yourself" CHAT.
//
// Sends one message, proves it arrived, deletes it FOR EVERYONE, and proves it
// is gone — each step read back over the raw view, which is a different pass
// from the clicks that did the work.
//
// NEVER point this at another person's conversation. The text is deliberately
// distinctive so nothing else can match it, and every lookup is an EXACT match:
// a substring search here could select somebody's real message.
//
// What was learned live on 22 Aug 2026 and is encoded below:
//   - the per-message menu opens on a RIGHT-CLICK of the bubble's text element.
//     `Open message options` is a named button but reports no-invoke-pattern, so
//     InvokePattern is not available for it.
//   - choosing "Delete" does NOT open a confirm dialog. It puts WhatsApp into a
//     SELECTION MODE with a bottom bar carrying "Cancel delete" and "Delete".
//     Pressing that second "Delete" is what opens the modal.
//   - the modal is a window titled "Delete message?" and its options are the
//     ONLY honest source of whether the delete-for-everyone window is still
//     open. On a message sent the day before it offered just "Cancel" and
//     "Delete for me" — the app saying the window has closed, in the only way it
//     ever says so.
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const TEXT = process.argv[2] ?? `syscora-undo-${Date.now().toString(36)}`;
const adapter = new WindowsAdapter();
const say = (...p) => console.log(...p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const windows = await adapter.listWindows();
const frame = windows.find((w) => w.ProcessName === "WhatsApp.Root" && String(w.MainWindowTitle ?? "").trim());
const content = windows.find((w) => w.ProcessName === "msedgewebview2" && /WhatsApp/.test(String(w.MainWindowTitle ?? "")));
if (!frame || !content) { say("WhatsApp frame/content not found"); process.exit(1); }
const FRAME = frame.WindowHandle;
const CONTENT = content.WindowHandle;

const read = async () =>
  (await adapter.hostRequest("ui.inspect", { windowId: CONTENT, includeHidden: true }, { timeoutMs: 30000 }))?.targets ?? [];
const exact = async (name) => (await read()).find((e) => String(e.name ?? "").trim() === name);
const countOf = async (name) => (await read()).filter((e) => String(e.name ?? "").trim() === name).length;
const clickEl = async (el, button = "left") => {
  const b = el.boundingRect;
  return adapter.hostRequest("pointer.click", {
    x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), button
  }, { timeoutMs: 15000 });
};

// TRAP 4/5: input goes to the FRAME, reads come from the content window.
await adapter.hostRequest("window.activate", { windowId: FRAME }, { timeoutMs: 25000 });

// ---- send -----------------------------------------------------------------
const box = (await read()).find((e) => /ControlType.Edit/.test(String(e.controlType ?? ""))
  && /type a message|message/i.test(String(e.name ?? "")));
if (!box) { say("no message box found"); process.exit(1); }
await clickEl(box);
await wait(400);
await adapter.hostRequest("keyboard.type", { text: TEXT, windowId: FRAME }, { timeoutMs: 25000 });
await wait(500);
// `chord` IS NOT OPTIONAL, AND OMITTING IT FAILS SILENTLY. With no `chord` the
// host falls back to SendKeys::SendWait($keys) — and SendKeys reads "enter" as
// five literal characters, not the Enter key, while still returning
// performed:true. Reproduced live 22 Aug 2026: the box ended up holding
// "syscora-undo-mt409iu6enter", nothing was sent, and the call reported success.
await adapter.hostRequest("keyboard.press", { chord: "enter", keys: "enter", windowId: FRAME }, { timeoutMs: 15000 });
await wait(2000);

// AN EMPTY INPUT BOX IS NOT EVIDENCE OF A SEND (trap 1). The conversation is.
const sent = await countOf(TEXT);
say(`sent "${TEXT}" — occurrences in the conversation: ${sent}`);
if (sent < 1) { say("FAILED: the message never reached the conversation"); process.exit(1); }

// ---- delete for everyone ---------------------------------------------------
const bubble = (await read()).filter((e) => String(e.name ?? "").trim() === TEXT).pop();
await clickEl(bubble, "right");
await wait(1400);
const menu = (await read()).filter((e) => /MenuItem/i.test(String(e.controlType ?? ""))).map((m) => m.name);
say(`menu: ${JSON.stringify(menu)}`);

const del = await exact("Delete");
if (!del) { say("no Delete in the menu"); process.exit(1); }
await clickEl(del);
await wait(1500);

// Selection mode, not a dialog. The bottom bar's own Delete opens the modal.
const barDelete = await exact("Delete");
if (!barDelete) { say("no bottom-bar Delete — the flow changed"); process.exit(1); }
await clickEl(barDelete);
await wait(2000);

const options = (await read())
  .filter((e) => /ControlType.Button/.test(String(e.controlType ?? "")) && /delete|cancel/i.test(String(e.name ?? "")))
  .map((e) => String(e.name).trim());
say(`confirm options: ${JSON.stringify(options)}`);

const forEveryone = await exact("Delete for everyone");
if (!forEveryone) {
  say("WINDOW CLOSED: the app does not offer \"Delete for everyone\" for this message.");
  const cancel = await exact("Cancel");
  if (cancel) await clickEl(cancel);
  await wait(800);
  const stray = await exact("Cancel delete");
  if (stray) await clickEl(stray);
  process.exit(2);
}
await clickEl(forEveryone);
await wait(2500);

// ---- prove it -------------------------------------------------------------
const left = await countOf(TEXT);
say(`occurrences after the delete: ${left}`);
say(left === 0 ? "CONFIRMED: the message is gone from the conversation." : "REFUTED: it is still there.");

// Leave nothing open behind us.
const stray = await exact("Cancel delete");
if (stray) await clickEl(stray);
await adapter.close?.();
process.exit(left === 0 ? 0 : 1);
