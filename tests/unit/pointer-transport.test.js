// How a stroke and a key press travel from the runtime to the Windows host.
//
// Both carry two spellings of the same request, and which one the host uses
// changes what actually happens on the machine — so both have to be right, and
// neither can be checked by looking at the host.

import test from "node:test";
import assert from "node:assert/strict";
import { WindowsAdapter, chordSpec, normalizeSendKeys } from "../../os-adapters/windows/src/windows-adapter.js";

function hostRecorder() {
  const adapter = new WindowsAdapter();
  const calls = [];
  adapter.hostRequest = async (operation, params, options) => {
    calls.push({ operation, params, options });
    return { performed: true };
  };
  return { adapter, calls };
}

// A detailed figure is thousands of numbers, and the host's JSON parser boxes
// every one of them — measured at roughly a fifth of the cost of drawing a
// circle. Raw little-endian Int32 pairs decode with one block copy instead.
test("a path travels as raw bytes, and decodes back to the exact coordinates", async () => {
  const { adapter, calls } = hostRecorder();
  await adapter.pointerStroke({ paths: [[10, 20, 30, 40], [-5, 7, 900, 1200]], windowId: "7" });

  const [{ operation, params }] = calls;
  assert.equal(operation, "pointer.stroke");
  assert.equal(params.windowId, "7");
  assert.equal(params.pathsBase64.length, 2);
  assert.equal(params.path, undefined, "the array form must not be sent as well");

  // Buffer.from draws from a shared pool, so the view's offset and length are
  // what matter — reading its whole underlying ArrayBuffer reads other buffers.
  const decode = (encoded) => {
    const bytes = Buffer.from(encoded, "base64");
    return Array.from(new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4));
  };
  assert.deepEqual(decode(params.pathsBase64[0]), [10, 20, 30, 40]);
  // Negative coordinates are ordinary: a second monitor placed left of or above
  // the first has them, and a format that loses them loses that monitor.
  assert.deepEqual(decode(params.pathsBase64[1]), [-5, 7, 900, 1200]);
});

// A stroke deliberately asked to take four seconds is not a failed request at
// five, and a stroke that times out is abandoned with the mouse button down.
test("the stroke deadline is derived from the work, not fixed", async () => {
  const { adapter, calls } = hostRecorder();
  const short = Array.from({ length: 40 }, (_, index) => index);
  const long = Array.from({ length: 8000 }, (_, index) => index);

  await adapter.pointerStroke({ paths: [short], pacingMicros: 250 });
  await adapter.pointerStroke({ paths: [long], pacingMicros: 3000 });

  assert.ok(calls[0].options.timeoutMs >= 5000, "even a tiny stroke gets room for a round trip");
  assert.ok(calls[1].options.timeoutMs > calls[0].options.timeoutMs, "a longer path must get longer to finish");
  assert.ok(calls[1].options.timeoutMs <= 60000, "and it must still be bounded");
});

test("a path with nothing to draw is refused before it reaches the machine", async () => {
  const { adapter } = hostRecorder();
  await assert.rejects(() => adapter.pointerStroke({ paths: [] }), /at least one path/);
  await assert.rejects(() => adapter.pointerStroke({ paths: [[1, 2]] }), /at least one path/);
});

// The host can hold modifiers itself and report whether Windows accepted the
// keys, but only for combinations it can parse. The SendKeys spelling still
// travels for the notation it cannot.
test("a key press carries both the human spelling and the SendKeys notation", async () => {
  const { adapter, calls } = hostRecorder();
  await adapter.keyboardAction("press", { keys: "Ctrl+Shift+Escape" });
  assert.equal(calls[0].params.chord, "ctrl+shift+escape");
  assert.equal(calls[0].params.keys, normalizeSendKeys("Ctrl+Shift+Escape"));
});

test("notation only SendKeys understands is not offered to the chord parser", () => {
  // Already SendKeys: a brace group, or a leading modifier symbol.
  assert.equal(chordSpec("%{F4}"), null);
  assert.equal(chordSpec("{ENTER}"), null);
  assert.equal(chordSpec("^v"), null);
  assert.equal(chordSpec(""), null);
  assert.equal(chordSpec(null), null);
  // Written the way a person writes it.
  assert.equal(chordSpec("enter"), "enter");
  assert.equal(chordSpec("Alt+F4"), "alt+f4");
});

test("typing gets a longer deadline than a key press", async () => {
  const { adapter, calls } = hostRecorder();
  await adapter.keyboardAction("type", { text: "x".repeat(5000) });
  await adapter.keyboardAction("press", { keys: "enter" });
  assert.ok(calls[0].options.timeoutMs > calls[1].options.timeoutMs);
});
