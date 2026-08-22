// Can it write a new document while another one is already open?
//
// The failure this guards against is not hypothetical: notepadTypeAndSave used
// to reuse the running Notepad, so the text went into whichever document
// happened to be in front. The fix is not to avoid a busy Notepad — refusing to
// work because the application is in use would be a worse tool — it is to press
// Ctrl+N and write in a fresh document, which is what a person does.
//
// So this deliberately arranges the dangerous case: a document open, in front,
// with known content in it. Then it asks for a new one, and checks BOTH that the
// new text landed and that the open document was left exactly as it was.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";

const SENTINEL = [
  "DO NOT TOUCH - this document was already open.",
  "If SYSCORA typed into this file, the fix did not work."
].join("\r\n");
const CONTENT = [
  "int main() { return 100%2; }",
  "path: C:\\Users\\{name}\\AppData ^ +x ~y"
].join("\r\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adapter = new WindowsAdapter();
const bystander = path.join(os.tmpdir(), `syscora-bystander-${Date.now()}.txt`);
const filename = `syscora-newtab-${Date.now()}.txt`;
let written = null;

try {
  await fs.writeFile(bystander, SENTINEL, "utf8");
  // Open it and let it settle in front: this is the document that must survive.
  spawn("notepad.exe", [bystander], { detached: false, stdio: "ignore", windowsHide: false });
  await sleep(4000);
  console.log("bystander document open:", bystander);

  const result = await adapter.notepadTypeAndSave({ content: CONTENT, filename });
  written = result.filePath;
  console.log("route     :", JSON.stringify(result.commandResult).slice(0, 120));
  console.log("wrote to  :", written);

  const bystanderNow = await fs.readFile(bystander, "utf8");
  const untouched = bystanderNow.replace(/\r\n/g, "\n") === SENTINEL.replace(/\r\n/g, "\n");
  console.log("");
  console.log(untouched
    ? "BYSTANDER UNTOUCHED: the document that was already open is unchanged."
    : `BYSTANDER MODIFIED — it now reads:\n${bystanderNow.slice(0, 300)}`);

  let landed = false;
  try {
    const onDisk = await fs.readFile(written, "utf8");
    const normalise = (v) => v.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").trim();
    landed = normalise(onDisk) === normalise(CONTENT);
    console.log(landed
      ? "NEW DOCUMENT EXACT: the text was written to a new document and saved."
      : `NEW DOCUMENT WRONG:\n  sent   : ${JSON.stringify(normalise(CONTENT))}\n  arrived: ${JSON.stringify(normalise(onDisk))}`);
  } catch {
    console.log(`NEW DOCUMENT MISSING: nothing was saved to ${written}`);
  }
  process.exitCode = untouched && landed ? 0 : 1;
} catch (error) {
  console.error("PROBE FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await fs.rm(bystander, { force: true }).catch(() => {});
  console.log(`\nscratch removed: ${bystander}`);
  if (written) console.log(`left on disk (delete if you like): ${written}`);
}
