// Does typed text arrive as written, and is the clipboard left alone?
//
// The content below is exactly what SendKeys destroys: braces, parentheses, a
// plus, a caret, a percent and a tilde are its notation for grouping, key names
// and the three modifiers.
//
// It works on a file it creates in the temp directory and opens Notepad ON THAT
// FILE, so Ctrl+S writes straight to it with no Save dialog to negotiate and no
// chance of touching a document the user owns. It targets the window by the
// handle that appeared, never "whichever Notepad answers to the name" — the
// earlier version of this probe reused an already-open Notepad and typed into
// somebody else's document.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WindowsAutomationHostClient } from "../os-adapters/windows-host/src/client.js";

const CONTENT = [
  "#include <iostream>",
  "int main() { std::cout << \"100% sure\" << std::endl; return 0; }",
  "shell: cd ~/work && echo ^caret +plus %percent {brace}",
  "json: {\"a\": [1, 2], \"b\": {\"c\": true}}",
  "unicode: caffe - naive - nihongo"
].join("\r\n");

const host = new WindowsAutomationHostClient({ requestTimeoutMs: 30000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = path.join(os.tmpdir(), `syscora-typing-${Date.now()}.txt`);
let pid = null;

try {
  await host.request("host.health", {}, { timeoutMs: 40000 });
  await fs.writeFile(scratch, "", "utf8");

  const SENTINEL = `syscora-sentinel-${Date.now()}`;
  await host.request("clipboard.write", { text: SENTINEL });

  const before = new Set((await host.request("window.enumerate", {})).windows
    .filter((w) => /typing target/i.test(w.title)).map((w) => String(w.windowId)));
  // No -ExecutionPolicy override: this machine's CurrentUser policy is
  // RemoteSigned, which already runs a local unsigned script, and weakening the
  // policy to run a test would be a strange thing to do to somebody's machine.
  const child = spawn("powershell.exe", [
    "-NoProfile", "-STA",
    "-File", path.join(process.cwd(), "scripts", "typing-target.ps1"),
    "-OutPath", scratch, "-Seconds", "14"
  ], { detached: false, stdio: "ignore", windowsHide: false });
  pid = child.pid;

  // Poll rather than sleep a guessed amount: a cold PowerShell loading WinForms
  // takes anywhere from two to eight seconds on this machine, and a fixed wait
  // that is usually long enough is a probe that usually works.
  let mine = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && mine.length === 0) {
    await sleep(500);
    mine = (await host.request("window.enumerate", {})).windows
      .filter((w) => /typing target/i.test(w.title ?? "") && !before.has(String(w.windowId)));
  }
  if (mine.length === 0) throw new Error("the typing target window did not appear");
  const windowId = String(mine[0].windowId);
  console.log(`typing target window ${windowId}`);

  const typed = await host.request("keyboard.type", { windowId, text: CONTENT }, { timeoutMs: 30000 });
  console.log(`method    : ${typed.method}, accepted ${typed.injectedEvents}/${typed.requestedEvents}`);
  // Wait for the target to EXIT, not for a guessed number of seconds. It writes
  // the file on the way out, so reading on a timer reads whatever happens to be
  // there — which the first run of this probe did, and reported as corruption
  // when the file simply had not been written yet.
  await new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 30000);
    child.once("exit", () => { clearTimeout(giveUp); resolve(); });
  });
  await sleep(300);

  const clipboard = await host.request("clipboard.read", {});
  console.log("clipboard :", clipboard?.text === SENTINEL
    ? "UNTOUCHED"
    : `DISTURBED -> ${JSON.stringify(String(clipboard?.text ?? "").slice(0, 60))}`);

  const onDisk = await fs.readFile(scratch, "utf8");
  const normalise = (value) => value.replace(/\r\n/g, "\n").replace(/﻿/g, "").trim();
  const exact = normalise(onDisk) === normalise(CONTENT);
  console.log("");
  console.log(exact ? "EXACT: every character arrived as written." : "CORRUPTED:");
  if (!exact) {
    const wanted = normalise(CONTENT).split("\n");
    const got = normalise(onDisk).split("\n");
    for (let index = 0; index < Math.max(wanted.length, got.length); index += 1) {
      if (wanted[index] !== got[index]) {
        console.log(`  line ${index + 1} sent   : ${JSON.stringify(wanted[index])}`);
        console.log(`  line ${index + 1} arrived: ${JSON.stringify(got[index])}`);
      }
    }
  }
  process.exitCode = exact && clipboard?.text === SENTINEL ? 0 : 1;
} catch (error) {
  console.error("PROBE FAILED:", error.message);
  process.exitCode = 1;
} finally {
  host.close();
  // Close only the target this probe started, in case its own timer did not.
  if (pid) spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" }).unref();
  await sleep(500);
  await fs.rm(scratch, { force: true }).catch(() => {});
  console.log(`\nscratch file removed: ${scratch}`);
}
