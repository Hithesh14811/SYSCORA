// THE CHECK THAT CAN TELL A DRAWING FROM AN EMPTY CANVAS.
//
// The eval had no drawing task, because nothing could verify one. Reading the
// screen cannot: OCR of a canvas with a circle on it and OCR of a blank canvas
// return the same nothing, and a live run once dragged across Paint with no tool
// selected and reported "the shape is now visible on the canvas" over a blank
// one.
//
// The obvious cheap proxies are all vacuous, and this is not a theoretical
// worry — measured 21 Aug 2026, a blank 1152x648 bitmap, the same canvas with a
// circle on it, and the same canvas with an INVISIBLE white-on-white circle were
// all exactly 2,986,038 bytes. A file-size check would have passed all three.
//
// So these tests hold the real function to both edges: it must see a thin stroke,
// and it must refuse to call an invisible one drawn.

import test from "node:test";
import assert from "node:assert/strict";
import { inkOf } from "../eval/fixtures/ink-check.mjs";

// A 24-bit bottom-up bitmap, the shape System.Drawing and Paint both write.
function bitmap(width, height, paint) {
  const stride = Math.floor((width * 3 + 3) / 4) * 4;
  const offset = 54;
  const buffer = Buffer.alloc(offset + stride * height);
  buffer.write("BM", 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(offset, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  const set = (x, y, [b, g, r]) => {
    const at = offset + y * stride + x * 3;
    buffer[at] = b;
    buffer[at + 1] = g;
    buffer[at + 2] = r;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) set(x, y, [255, 255, 255]);
  }
  paint?.(set);
  return buffer;
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

test("a blank canvas is blank", () => {
  assert.equal(inkOf(bitmap(1152, 648)), "BLANK");
});

test("a thin stroke across the canvas is ink", () => {
  // One two-pixel line, which is less than a drawn circle leaves behind.
  const drawn = bitmap(1152, 648, (set) => {
    for (let x = 100; x < 1000; x += 1) {
      set(x, 300, BLACK);
      set(x, 301, BLACK);
    }
  });
  assert.match(inkOf(drawn), /^INK /,
    "this is the least ink a drawing task could plausibly produce; missing it makes the row unpassable");
});

// THE ONE THAT MATTERS. A drawing made in the background colour is not a
// drawing, and every cheap proxy — file size, bytes changed, "did the canvas
// differ" — calls it one.
test("a stroke in the background colour is not a drawing", () => {
  const invisible = bitmap(1152, 648, (set) => {
    for (let x = 100; x < 1000; x += 1) {
      set(x, 300, WHITE);
      set(x, 301, WHITE);
    }
  });
  assert.equal(inkOf(invisible), "BLANK",
    "white on white is not visible, and calling it drawn is the same lie as calling a blank canvas drawn");
});

test("a canvas that is mostly ink is still ink", () => {
  // Filled dark, with a small light patch: the modal colour is now the INK, and
  // a check that assumed the background is always the majority would call this
  // blank.
  const filled = bitmap(400, 400, (set) => {
    for (let y = 0; y < 400; y += 1) {
      for (let x = 0; x < 400; x += 1) set(x, y, BLACK);
    }
    for (let y = 10; y < 60; y += 1) {
      for (let x = 10; x < 60; x += 1) set(x, y, WHITE);
    }
  });
  assert.match(inkOf(filled), /^INK /);
});

test("something that is not a bitmap says so rather than guessing", () => {
  assert.match(inkOf(Buffer.from("<html>not an image at all</html>")), /^UNREADABLE/,
    "an unreadable file must never be reported as BLANK — that would fail a run that actually drew");
  assert.match(inkOf(Buffer.alloc(0)), /^UNREADABLE/);
});

test("an unsupported depth is unreadable, not blank", () => {
  const eightBit = bitmap(64, 64);
  eightBit.writeUInt16LE(8, 28);
  assert.match(inkOf(eightBit), /^UNREADABLE/);
});
