import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveStateDir } from "../../../packages/shared-types/src/state-path.js";
import { resolveProtectedValue } from "../../../packages/secrets/src/protected-value.js";

// VOICE INPUT: AUDIO IN, TEXT OUT, AND NOTHING ELSE.
//
// The composer records, this turns the recording into words, and the words go
// back into the text box — where the person reads them and presses Send. A
// transcript is never submitted on its own: speech recognition mishears, and an
// agent that drives the whole desktop must not act on what it THOUGHT it heard.
//
// Two engines, chosen by configuration:
//   1. A Whisper-compatible endpoint (`speech` in config.json: baseUrl, apiKey,
//      model), POST {baseUrl}/audio/transcriptions — OpenAI, Groq and local
//      servers all speak it. Far better with accents and noise.
//   2. Otherwise Windows' own offline recognizer (System.Speech, DictationGrammar).
//      Nothing leaves the machine and nothing needs a key. Measured 5 Oct 2026:
//      a 6-second clip in ~1.9s, cold PowerShell included.
//
// The audio arrives as a WAV in memory and is piped to PowerShell on stdin, never
// written to a temp file — same reasoning as /api/attachments/extract: a
// recording of somebody talking needs no cleanup story if it never touches disk.

const RECOGNIZE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$recognizer = $installed | Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 1
if (-not $recognizer) { $recognizer = $installed | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if (-not $recognizer) { [Console]::Out.Write('{"ok":false,"reason":"NO_RECOGNIZER"}'); exit 0 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveStream((New-Object System.IO.MemoryStream(,$bytes)))
$parts = New-Object System.Collections.Generic.List[string]
while ($true) {
  # At the end of a stream input is DETACHED and Recognize() throws rather than
  # returning null, so the exception is the end-of-audio signal, not a failure.
  try { $result = $engine.Recognize() } catch [System.InvalidOperationException] { break }
  if ($null -eq $result) { break }
  if ($result.Text) { $parts.Add($result.Text) }
}
$engine.Dispose()
[Console]::Out.Write((@{ ok = $true; text = ($parts -join ' ') } | ConvertTo-Json -Compress))
`;

const ENCODED_SCRIPT = Buffer.from(RECOGNIZE_SCRIPT, "utf16le").toString("base64");
const LOCAL_TIMEOUT_MS = 60_000;

export function loadSpeechConfig(basePath) {
  const stateDirectory = resolveStateDir(basePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDirectory, "config.json"), "utf8"));
    const speech = parsed?.speech;
    if (!speech?.baseUrl) return null;
    const apiKey = speech.apiKey
      ? resolveProtectedValue(speech.apiKey, { baseDirectory: path.join(stateDirectory, "secrets") })
      : null;
    return { baseUrl: String(speech.baseUrl).replace(/\/+$/, ""), apiKey, model: speech.model ?? "whisper-1" };
  } catch {
    return null;
  }
}

function transcribeLocally(wav) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_SCRIPT],
      { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), LOCAL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `Windows speech recognition could not start: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.ok) resolve({ ok: true, text: String(parsed.text ?? "").trim(), engine: "windows" });
        else resolve({ ok: false, reason: "No English speech recognizer is installed on this PC (Settings → Time & language → Speech)." });
      } catch {
        resolve({ ok: false, reason: `Windows speech recognition failed${stderr ? `: ${stderr.trim().split("\n")[0]}` : "."}` });
      }
    });
    child.stdin.end(wav.toString("base64"));
  });
}

async function transcribeRemotely(wav, config) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", config.model);
  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) return { ok: false, reason: `The speech endpoint answered HTTP ${response.status}.` };
  const body = await response.json();
  return { ok: true, text: String(body?.text ?? "").trim(), engine: "whisper" };
}

export async function transcribe(wav, { basePath } = {}) {
  const remote = loadSpeechConfig(basePath);
  if (remote) {
    // A configured endpoint that is down should not take voice input with it;
    // the offline recognizer is worse, not absent.
    try {
      const result = await transcribeRemotely(wav, remote);
      if (result.ok) return result;
    } catch {}
  }
  return transcribeLocally(wav);
}
