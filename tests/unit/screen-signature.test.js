import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { screenSignature, changedFraction, SIGNATURE_GRID } from "../../packages/fast-agent/src/screen-signature.js";

// A minimal valid 8-bit RGB PNG, built here so the decoder is tested against
// real chunk framing, real zlib and real scanline filters rather than a stub.
function makePng(width, height, pixelAt, { filter = 0 } = {}) {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      const at = y * (stride + 1) + 1 + x * channels;
      // Sub filter encodes the difference from the pixel to the left.
      const [pr, pg, pb] = x > 0 ? pixelAt(x - 1, y) : [0, 0, 0];
      raw[at] = filter === 1 ? (r - pr) & 0xff : r;
      raw[at + 1] = filter === 1 ? (g - pg) & 0xff : g;
      raw[at + 2] = filter === 1 ? (b - pb) & 0xff : b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test("a PNG is decoded into a brightness grid", () => {
  const white = screenSignature(makePng(128, 128, () => [255, 255, 255]));
  assert.equal(white.length, SIGNATURE_GRID * SIGNATURE_GRID);
  assert.ok(white.every((cell) => cell === 255), "an all-white image is uniformly bright");

  const black = screenSignature(makePng(128, 128, () => [0, 0, 0]));
  assert.ok(black.every((cell) => cell === 0), "an all-black image is uniformly dark");
});

test("scanline filters are un-applied, not read as pixel values", () => {
  const pixel = (x) => (x < 64 ? [255, 255, 255] : [0, 0, 0]);
  const unfiltered = screenSignature(makePng(128, 128, pixel, { filter: 0 }));
  const subFiltered = screenSignature(makePng(128, 128, pixel, { filter: 1 }));
  assert.deepEqual(subFiltered, unfiltered, "the same image encoded two ways must measure the same");
});

test("a mark on a blank field registers, and an identical image does not", () => {
  const blank = screenSignature(makePng(256, 256, () => [255, 255, 255]));
  const same = screenSignature(makePng(256, 256, () => [255, 255, 255]));
  assert.equal(changedFraction(blank, same), 0, "nothing changed means nothing changed");

  // A one-pixel-wide diagonal, the faintest thing a person can draw. This is the
  // case a coarser grid averaged away to zero and reported as "nothing drawn".
  const stroke = screenSignature(makePng(256, 256, (x, y) => (x === y ? [0, 0, 0] : [255, 255, 255])));
  assert.ok(changedFraction(blank, stroke) > 0.001, "a thin stroke must register as a change");
});

test("an unreadable image measures nothing rather than guessing", () => {
  assert.equal(screenSignature(Buffer.from("not a png")), null);
  assert.equal(screenSignature(Buffer.alloc(0)), null);
  assert.equal(changedFraction(null, [1, 2, 3]), null);
  assert.equal(changedFraction([1, 2], [1, 2, 3]), null, "grids of different sizes are not comparable");
});
