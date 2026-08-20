// IS THERE ANYTHING ACTUALLY DRAWN IN THIS IMAGE?
//
//   node scripts/eval-ink-check.mjs <path.bmp>
//
// Prints one of: MISSING, UNREADABLE, BLANK, or `INK <percent>`.
//
// This exists because the eval had NO drawing task at all, and the one drawing
// result this project ever recorded — 54 steps and 894,000 tokens — was measured
// by nothing and could not be told from a blank canvas.
//
// TWO RULES SHAPE IT.
//
// 1. READING THE SCREEN CANNOT SEE A DRAWING. Text perception returns the same
//    nothing for a canvas with a circle on it as for an empty one, and a live
//    run once dragged across Paint with no tool selected, read the screen, and
//    reported "the shape is now visible on the canvas". It was blank. So the
//    check is on the saved FILE, on disk, in pixels.
//
// 2. VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES. The
//    agent's own `draw` tool checks its work with `screen-signature.js` — a
//    64x64 grid of average brightness. If this used the same module, a fault in
//    that grid would make the agent's claim and the eval's confirmation agree
//    with each other and disagree with reality, which is the exact failure this
//    whole harness exists to prevent. So: a different file format, a different
//    measure, no shared line of code.
//
// BMP rather than PNG for the same reason and one more: an uncompressed bitmap
// needs no decoder to argue about. A second PNG decoder would be seventy lines
// of filters and zlib written to check the first one, and the bugs would be
// quiet. This walks a raw pixel array.
//
// It would FAIL to notice a drawing made in the background colour — white on
// white is not visible, and calling that "drawn" would be the same lie in the
// other direction.

import fs from "node:fs";

// A blank Paint canvas is uniformly white: every sample lands in one bucket and
// the fraction below is exactly zero. Anything drawn in a visible colour moves
// it well clear, so the floor only has to be above nothing at all.
const FLOOR = 0.0002;

/** The verdict for a bitmap's bytes: BLANK, `INK <percent>`, or UNREADABLE. */
export function inkOf(bytes) {
  // A bitmap: 'BM', then the offset to the pixel array at 10, the dimensions at
  // 18 and 22, and the depth at 28. Height is negative when the rows are stored
  // top-down, which changes nothing here — every pixel is counted either way.
  if (!bytes || bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return "UNREADABLE not-a-bitmap";
  const pixelOffset = bytes.readUInt32LE(10);
  const width = Math.abs(bytes.readInt32LE(18));
  const height = Math.abs(bytes.readInt32LE(22));
  const depth = bytes.readUInt16LE(28);
  if (![24, 32].includes(depth) || width < 1 || height < 1) return `UNREADABLE ${depth}bpp ${width}x${height}`;

  const bytesPerPixel = depth / 8;
  // Rows are padded up to a four-byte boundary.
  const rowStride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
  // Sample on a grid rather than every pixel: a Paint canvas can be several
  // million pixels and the answer does not need all of them. Roughly 250k
  // samples finds a thin stroke and still runs inside a verify step.
  const step = Math.max(1, Math.round(Math.sqrt((width * height) / 250000)));

  const counts = new Map();
  let sampled = 0;
  for (let y = 0; y < height; y += step) {
    const row = pixelOffset + y * rowStride;
    for (let x = 0; x < width; x += step) {
      const at = row + x * bytesPerPixel;
      if (at + 2 >= bytes.length) continue;
      // Quantised to 8 levels per channel so that anti-aliasing along a stroke
      // does not register as hundreds of distinct "background" colours.
      const key = ((bytes[at] >> 5) << 6) | ((bytes[at + 1] >> 5) << 3) | (bytes[at + 2] >> 5);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sampled += 1;
    }
  }
  if (sampled === 0) return "UNREADABLE no-pixels";

  let modal = 0;
  for (const count of counts.values()) if (count > modal) modal = count;
  const different = (sampled - modal) / sampled;
  return different > FLOOR ? `INK ${(different * 100).toFixed(3)}%` : "BLANK";
}

// Only when run as a command, so a test can import `inkOf` without this firing.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const file = process.argv[2];
  let bytes = null;
  try {
    bytes = file ? fs.readFileSync(file) : null;
  } catch {
    bytes = null;
  }
  console.log(bytes ? inkOf(bytes) : "MISSING");
}
