// VOICE INPUT — the mic beside Send, on the chat and on the pill.
//
// Shaped like ChatGPT's: press the mic, the text box becomes a live waveform
// with a timer, ✓ (or Enter, or the mic again) stops and transcribes, ✕ (or
// Escape) throws the recording away. The words land IN THE TEXT BOX, at the
// caret, and are never sent by themselves. Recognition mishears, and this agent
// drives the whole desktop — "delete the draft" heard as "delete the drafts" is
// exactly the kind of thing the person must get to read before it becomes an
// action. Pressing Send is the confirmation.
//
// Capture happens here, in the renderer; recognition happens in the daemon
// (POST /api/voice/transcribe, see apps/daemon/src/speech.js) so the same route
// serves Windows' offline recognizer or a Whisper endpoint without either
// surface knowing which. The recording is resampled to 16 kHz mono WAV first:
// both engines want it, and it is a sixth of the size of what the mic delivers.

const MAX_SECONDS = 300;
const TARGET_RATE = 16000;
const BAR_WIDTH = 3;
const BAR_GAP = 2;

const ICON_CANCEL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
const ICON_CONFIRM = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2 8.8-9.4"/></svg>';

/**
 * Wire a mic button to a text box.
 *
 * @param {object} options
 * @param {HTMLButtonElement} options.button  the mic; holds aria-pressed
 * @param {HTMLTextAreaElement} options.input the text box the words go into
 * @param {(text: string, kind?: string) => void} [options.onNote] where to say
 *        what went wrong; defaults to the bar itself
 * @param {() => void} [options.onChange] called after the box changes size
 */
export function attachVoiceInput({ button, input, onNote, onChange }) {
  if (!button || !input) return null;

  const bar = document.createElement("div");
  bar.className = "voice-bar";
  bar.hidden = true;
  bar.innerHTML = `
    <button type="button" class="voice-bar-button voice-cancel" aria-label="Discard recording" title="Discard (Esc)">${ICON_CANCEL}</button>
    <canvas class="voice-wave" aria-hidden="true"></canvas>
    <span class="voice-status" aria-live="polite"></span>
    <button type="button" class="voice-bar-button voice-confirm" aria-label="Stop and transcribe" title="Done (Enter)">${ICON_CONFIRM}</button>`;
  input.insertAdjacentElement("afterend", bar);

  const canvas = bar.querySelector(".voice-wave");
  const status = bar.querySelector(".voice-status");
  const cancelButton = bar.querySelector(".voice-cancel");
  const confirmButton = bar.querySelector(".voice-confirm");

  // idle → recording → transcribing → idle. One recording at a time.
  let state = "idle";
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioContext = null;
  let analyser = null;
  let levels = [];
  let frame = 0;
  let startedAt = 0;
  let lastSample = 0;
  let noteTimer = 0;
  let capTimer = 0;

  const say = (text, kind = "error") => {
    if (onNote) { onNote(text, kind); return; }
    // No notification system on this surface: the bar says it, briefly.
    bar.hidden = false;
    input.hidden = true;
    bar.dataset.state = "message";
    status.textContent = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (state === "idle") showInput(); }, 3200);
  };

  function showInput() {
    bar.hidden = true;
    input.hidden = false;
    bar.dataset.state = "";
    onChange?.();
  }

  function setState(next) {
    state = next;
    bar.dataset.state = next;
    button.setAttribute("aria-pressed", String(next === "recording"));
    button.dataset.voice = next;
    button.title = next === "recording" ? "Stop and transcribe" : "Voice input";
    confirmButton.disabled = next !== "recording";
  }

  function releaseMic() {
    cancelAnimationFrame(frame);
    clearTimeout(capTimer);
    stream?.getTracks().forEach((track) => track.stop());
    audioContext?.close().catch(() => {});
    stream = null;
    audioContext = null;
    analyser = null;
  }

  async function start() {
    if (state !== "idle") return;
    clearTimeout(noteTimer);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      say("Voice input needs the SYSCORA desktop app.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch (error) {
      releaseMic();
      // Denied comes from two places that look identical from here: the shell's
      // permission handler and Windows' own privacy switch. The second is the
      // one a person can actually change, so that is what this names.
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        say("Microphone blocked — turn on Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”.");
      } else if (error?.name === "NotFoundError") {
        say("No microphone found.");
      } else {
        say(`Could not start the microphone: ${error?.message ?? error}`);
      }
      return;
    }

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.start(250);

    levels = [];
    startedAt = performance.now();
    lastSample = 0;
    input.hidden = true;
    bar.hidden = false;
    setState("recording");
    // The cap is a timer, not a check in draw(): requestAnimationFrame stops
    // firing while a window is not being painted (minimised, or the pill hidden
    // by its shortcut), and a recording must not run on unbounded behind it.
    capTimer = setTimeout(() => stop(), MAX_SECONDS * 1000);
    sizeCanvas();
    draw();
    onChange?.();
  }

  function sizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  }

  // A rolling strip of bars, newest on the right — one bar per ~70 ms of RMS.
  function draw() {
    if (state !== "recording" || !analyser) return;
    frame = requestAnimationFrame(draw);
    const now = performance.now();
    const elapsed = (now - startedAt) / 1000;
    status.textContent = formatTime(elapsed);

    if (now - lastSample >= 70) {
      lastSample = now;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      // RMS of speech sits around 0.02–0.2; a square root spreads quiet talking
      // over the height instead of leaving it as a flat line.
      levels.push(Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6));
    }

    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(canvas.clientWidth * ratio)) sizeCanvas();
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    const step = (BAR_WIDTH + BAR_GAP) * ratio;
    const count = Math.floor(width / step);
    const visible = levels.slice(-count);
    const offset = width - visible.length * step;
    visible.forEach((level, index) => {
      const barHeight = Math.max(2 * ratio, level * height * 0.9);
      const x = offset + index * step;
      const y = (height - barHeight) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, BAR_WIDTH * ratio, barHeight, BAR_WIDTH * ratio / 2);
      ctx.fill();
    });
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") { resolve(); return; }
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
  }

  async function stop() {
    if (state !== "recording") return;
    setState("transcribing");
    status.textContent = "Transcribing…";
    await stopRecorder();
    releaseMic();
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    recorder = null;
    chunks = [];

    try {
      const wav = await toWav16k(blob);
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base64: bytesToBase64(new Uint8Array(wav)) })
      });
      const result = await response.json().catch(() => ({}));
      setState("idle");
      showInput();
      if (!response.ok || !result.ok) {
        say(result.reason ?? result.error ?? `Transcription failed (HTTP ${response.status}).`);
        return;
      }
      if (!result.text) {
        say("Didn't catch that — try again a little closer to the mic.", "reply");
        return;
      }
      insertAtCaret(result.text);
    } catch (error) {
      setState("idle");
      showInput();
      say(`Transcription failed: ${error?.message ?? error}`);
    }
  }

  async function cancel() {
    if (state !== "recording") return;
    setState("idle");
    await stopRecorder();
    releaseMic();
    recorder = null;
    chunks = [];
    showInput();
    input.focus();
  }

  function insertAtCaret(text) {
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    input.value = `${before}${lead}${text}${trail}${after}`;
    const caret = before.length + lead.length + text.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    // The composers grow and enable Send on `input`; a programmatic value
    // change fires nothing on its own.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onChange?.();
  }

  button.addEventListener("click", () => {
    if (state === "idle") start();
    else if (state === "recording") stop();
  });
  confirmButton.addEventListener("click", () => stop());
  cancelButton.addEventListener("click", () => cancel());
  // Enter and Escape while recording, from anywhere in the window — focus is on
  // the mic button or nowhere, never in the hidden text box.
  document.addEventListener("keydown", (event) => {
    if (state !== "recording") return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); stop(); }
  }, true);
  window.addEventListener("resize", () => { if (state === "recording") sizeCanvas(); });

  return { start, stop, cancel, get state() { return state; } };
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Decode whatever MediaRecorder produced (webm/opus in Chromium), mix to mono
// and resample to 16 kHz with an OfflineAudioContext, then wrap as PCM WAV.
async function toWav16k(blob) {
  const encoded = await blob.arrayBuffer();
  const decodeContext = new AudioContext();
  let decoded;
  try {
    decoded = await decodeContext.decodeAudioData(encoded);
  } finally {
    decodeContext.close().catch(() => {});
  }
  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), TARGET_RATE);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
