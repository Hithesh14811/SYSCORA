// Voice input: the shell grants the microphone and nothing else, and the
// daemon's offline recognizer turns real audio into the words that were said.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transcribe } from "../../apps/daemon/src/speech.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const main = fs.readFileSync(path.join(root, "apps/desktop-shell/src/main.js"), "utf8");

// Run the real handler source, not a description of it.
function loadPermissionHandlers(port) {
  const start = main.indexOf("function allowMicrophoneOnly(");
  assert.ok(start >= 0, "allowMicrophoneOnly is gone");
  let depth = 0;
  let end = main.indexOf("{", start);
  for (; end < main.length; end += 1) {
    if (main[end] === "{") depth += 1;
    if (main[end] === "}" && --depth === 0) break;
  }
  const source = main.slice(start, end + 1);
  const handlers = {};
  const session = {
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; }
  };
  new Function("session", "port", `${source}; allowMicrophoneOnly(session, port);`)(session, port);
  const request = (permission, details) => {
    let granted;
    handlers.request({ getURL: () => details.requestingUrl }, permission, (value) => { granted = value; }, details);
    return granted;
  };
  return { check: handlers.check, request };
}

test("the shell grants audio capture to the daemon's pages and nothing else", () => {
  const { check, request } = loadPermissionHandlers(4317);
  const daemon = "http://127.0.0.1:4317/overlay.html";
  assert.equal(request("media", { mediaTypes: ["audio"], requestingUrl: daemon }), true);
  assert.equal(request("media", { mediaTypes: ["audio", "video"], requestingUrl: daemon }), false, "camera rides along");
  assert.equal(request("media", { mediaTypes: ["video"], requestingUrl: daemon }), false);
  assert.equal(request("media", { mediaTypes: [], requestingUrl: daemon }), false);
  assert.equal(request("media", { mediaTypes: ["audio"], requestingUrl: "https://example.com/" }), false);
  assert.equal(request("media", { mediaTypes: ["audio"], requestingUrl: "http://127.0.0.1:9999/" }), false);
  for (const other of ["notifications", "geolocation", "clipboard-read", "midi", "openExternal"]) {
    assert.equal(request(other, { requestingUrl: daemon }), false, other);
  }
  assert.equal(check(null, "media", "http://127.0.0.1:4317", { mediaType: "audio" }), true);
  assert.equal(check(null, "media", "http://127.0.0.1:4317", { mediaType: "video" }), false);
  assert.equal(check(null, "notifications", "http://127.0.0.1:4317", {}), false);
});

test("the offline recognizer hears what was said", { skip: process.platform !== "win32" }, async () => {
  // Spoken by Windows' own synthesizer, captured to memory as 16 kHz mono WAV —
  // what the composer sends.
  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$m = New-Object System.IO.MemoryStream",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "$s.SetOutputToAudioStream($m, $f)",
    "$s.Speak('Open notepad and write a short note about the weather.')",
    "$s.Dispose()",
    "[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))"
  ].join("; ");
  const pcm = Buffer.from(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }), "base64");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);

  // A temp root has no config.json, so no Whisper endpoint: this is the local engine.
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "syscora-voice-"));
  const result = await transcribe(Buffer.concat([header, pcm]), { basePath });
  fs.rmSync(basePath, { recursive: true, force: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.engine, "windows");
  assert.match(result.text.toLowerCase(), /notepad/);
  assert.match(result.text.toLowerCase(), /weather/);
});
