// DOES THE HOST STILL TYPE "enter" AND CALL IT A KEY PRESS?
//
//   node scripts/probe-key-refusal.mjs
//
// SendKeys types anything that is not its own notation literally. So
// `keyboard.press` with `keys: "enter"` and no `chord` typed e-n-t-e-r into the
// focused window and returned `performed: true`. Observed live: a WhatsApp
// message box left holding "syscora-undo-mt409iu6enter", nothing sent, and a
// receipt saying the keystroke had been delivered.
//
// This proves the refusal on the REAL host, and it proves it the only way that
// means anything: by reading the window afterwards. A result object saying
// `performed: false` is the host's own account of itself — the question is
// whether five characters appeared on screen, and only the window can answer.
//
// SAFE BY CONSTRUCTION. It opens its own Notepad, focuses it, and every
// keystroke it risks goes there. Nothing is saved and the window is closed at
// the end. If the guard is broken, the damage is the word "enter" in a scratch
// document.

import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const adapter = new WindowsAdapter();
await adapter.automationHost?.warm?.();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readDocument = async (windowId) => {
  const inspected = await adapter.inspectUi({ windowId: String(windowId), maxElements: 200 }).catch(() => null);
  return (inspected?.targets ?? inspected?.elements ?? [])
    .map((target) => String(target.value ?? target.name ?? ""))
    .join(" ");
};

let windowId = null;
let failures = 0;
try {
  const launched = await adapter.launchApplication("notepad");
  await sleep(1200);
  const windows = await adapter.listWindows();
  const notepad = windows.find((window) => String(window.ProcessName ?? "").toLowerCase() === "notepad");
  if (!notepad) {
    console.log("\nNotepad did not open — cannot run this safely, so nothing was pressed.\n");
    process.exit(2);
  }
  windowId = String(notepad.WindowHandle);
  void launched;

  console.log(`\nscratch window: ${windowId}\n`);

  // Straight at the host, bypassing WindowsAdapter.keyboardAction — which
  // translates "enter" into a chord and would hide the very thing under test.
  // This is what a caller reaching the host directly does, and it is how the
  // live defect happened.
  const cases = [
    { keys: "enter", expect: "refused", why: "a key NAME with no chord — the live defect" },
    { keys: "ctrl+s", expect: "refused", why: "a combination spelled as text, not SendKeys notation" },
    { keys: "hello world", expect: "refused", why: "plain text belongs in keyboard.type" },
    { keys: "{ESC}", expect: "sent", why: "real SendKeys notation must still work" },
    { keys: "a", expect: "sent", why: "a single character is a genuine keystroke" },
    { keys: "^{ESC}", expect: "sent", why: "a leading modifier is notation and must still work" }
  ];

  for (const testCase of cases) {
    const before = await readDocument(windowId);
    const result = await adapter.hostRequest(
      "keyboard.press",
      { windowId, keys: testCase.keys },
      { timeoutMs: 8000 }
    ).catch((error) => ({ performed: false, reason: `threw: ${error?.message ?? error}` }));
    await sleep(250);
    const after = await readDocument(windowId);

    const refused = result?.performed === false;
    const changed = after !== before;
    const ok = testCase.expect === "refused" ? (refused && !changed) : refused === false;

    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  keys=${JSON.stringify(testCase.keys).padEnd(15)} ` +
      `expected ${testCase.expect.padEnd(8)} -> performed=${String(result?.performed)} ` +
      `documentChanged=${changed}`
    );
    console.log(`        ${testCase.why}`);
    if (refused && result?.message) console.log(`        host said: ${result.message}`);
    // THE POINT: a refusal that still typed something is not a refusal.
    if (testCase.expect === "refused" && changed) {
      console.log("        *** THE DOCUMENT CHANGED — the characters were typed anyway ***");
    }
  }
} finally {
  if (windowId) {
    // Close without saving. Notepad asks; the chord answers "Don't Save".
    await adapter.keyboardAction("press", { windowId, keys: "ctrl+w" }).catch(() => {});
    await sleep(600);
    await adapter.keyboardAction("press", { keys: "alt+n" }).catch(() => {});
  }
  adapter.close?.();
}

console.log(`\n${failures === 0 ? "PASS — the host presses keys and refuses to type them" : `FAIL — ${failures} case(s) wrong`}\n`);
process.exit(failures === 0 ? 0 : 1);
