// How much of a window actually changed, measured from its pixels.
//
// This exists because text perception is blind to graphics. OCR of a canvas with
// a circle on it and OCR of an empty canvas return the same nothing, so an agent
// that draws and then "checks by reading the screen" learns literally nothing and
// says it worked. Live, that is exactly what happened: it dragged across Paint's
// canvas with no tool selected, read the screen, and reported "the shape is now
// visible on the canvas". The canvas was blank.
//
// The obvious fix — hash the PNG bytes before and after — is worse than useless,
// because it is far too sensitive. Moving the mouse updates the pointer
// coordinate readout in Paint's status bar, so the bytes differ after ANY drag
// and the hash says "changed" just as confidently for a circle as for two digits
// ticking over. That false positive let the same failure through a second time.
//
// So: reduce the image to a coarse grid of average brightness and compare cells.
// A shape drawn across a canvas moves a real share of the grid; a status-bar
// readout moves one cell, below the noise floor.
//
// It decodes the PNG here rather than asking the Windows host to do it. The
// first attempt added a System.Drawing GetPixel loop to the host script and the
// machine's antivirus flagged the whole script as malicious — which broke every
// GUI action, not just this one. Pixel-scraping code in a PowerShell script looks
// exactly like spyware to a heuristic scanner, and it is not worth arguing with:
// zlib is built into Node, and a PNG is a handful of chunks.

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Channels per pixel, by PNG colour type. Palette (3) is unsupported: screen
// captures are never palettised, and guessing at one would be worse than
// declining to measure.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/**
 * Average brightness over a `grid` x `grid` sampling of a PNG file's pixels.
 *
 * Returns an array of `grid * grid` values 0-255, or null when the image cannot
 * be read — an unreadable image must produce "I cannot tell", never a number
 * that looks like a measurement.
 */
// Grid resolution and per-cell sensitivity, calibrated against real captures of
// a 2906x1730 Paint window rather than guessed:
//
//   grid  thr | pointer moved only | one thin pencil stroke
//     24    6 |            0.00000 |                0.00000   <- misses the stroke
//     24    2 |            0.00000 |                0.01389
//     64    3 |            0.00000 |                0.00708
//     96    3 |            0.00000 |                0.00521
//
// A coarse grid averages a one-pixel line away to nothing, which would report a
// real drawing as "nothing happened". PNG is lossless, so there is no
// compression noise to protect against and the threshold can be small. At 64/3
// a pointer move registers exactly zero and the faintest mark a person can make
// registers seven thousandths — a clear order of magnitude apart.
export const SIGNATURE_GRID = 64;
export const CELL_THRESHOLD = 3;
// Above this share of cells, something was actually drawn. Seven times below the
// faintest real stroke measured, and above anything a static window produces.
export const VISIBLE_CHANGE = 0.001;

export function screenSignature(pngBytes, { grid = SIGNATURE_GRID } = {}) {
  try {
    const buffer = Buffer.isBuffer(pngBytes) ? pngBytes : Buffer.from(pngBytes);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const data = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const start = offset + 8;
      if (start + length > buffer.length) break;
      if (type === "IHDR") {
        width = buffer.readUInt32BE(start);
        height = buffer.readUInt32BE(start + 4);
        bitDepth = buffer[start + 8];
        colorType = buffer[start + 9];
        interlace = buffer[start + 12];
      } else if (type === "IDAT") {
        data.push(buffer.subarray(start, start + length));
      } else if (type === "IEND") {
        break;
      }
      offset = start + length + 4;
    }

    const channels = CHANNELS[colorType];
    // Interlaced images arrive as seven sub-images; captures are never
    // interlaced, so decline rather than carry the complexity.
    if (!width || !height || bitDepth !== 8 || !channels || interlace !== 0) return null;

    const raw = zlib.inflateSync(Buffer.concat(data));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;

    const cells = new Float64Array(grid * grid);
    const counts = new Uint32Array(grid * grid);
    // One scanline of the previous row, un-filtered, for the Up/Average/Paeth
    // filters. Only two rows are ever held, so a full-screen capture costs
    // kilobytes rather than the tens of megabytes the whole image would.
    let previous = Buffer.alloc(stride);
    let current = Buffer.alloc(stride);

    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (stride + 1);
      const filter = raw[rowStart];
      raw.copy(current, 0, rowStart + 1, rowStart + 1 + stride);
      for (let index = 0; index < stride; index += 1) {
        const left = index >= channels ? current[index - channels] : 0;
        const up = previous[index];
        const upLeft = index >= channels ? previous[index - channels] : 0;
        let value = current[index];
        if (filter === 1) value += left;
        else if (filter === 2) value += up;
        else if (filter === 3) value += (left + up) >> 1;
        else if (filter === 4) value += paeth(left, up, upLeft);
        current[index] = value & 0xff;
      }
      const cellY = Math.min(grid - 1, Math.floor((y * grid) / height));
      for (let x = 0; x < width; x += 1) {
        const pixel = x * channels;
        // Rec. 601 luma. Greyscale types put their single sample in all three.
        const luma = channels >= 3
          ? 0.299 * current[pixel] + 0.587 * current[pixel + 1] + 0.114 * current[pixel + 2]
          : current[pixel];
        const cell = cellY * grid + Math.min(grid - 1, Math.floor((x * grid) / width));
        cells[cell] += luma;
        counts[cell] += 1;
      }
      const swap = previous;
      previous = current;
      current = swap;
    }

    return Array.from(cells, (total, index) => (counts[index] ? Math.round(total / counts[index]) : 0));
  } catch {
    return null;
  }
}

// The share of the window that visibly changed, 0 to 1, or null when either
// reading is missing. The per-cell threshold absorbs compression and anti-alias
// noise; the caller decides what fraction counts as "something happened".
export function changedFraction(before, after, { threshold = CELL_THRESHOLD, region = null, grid = SIGNATURE_GRID } = {}) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length || before.length === 0) {
    return null;
  }
  // Restricted to the cells covering `region` — a rectangle in grid coordinates.
  // This is what separates "it drew where I dragged" from "a menu closed
  // somewhere else", and a whole-window comparison cannot tell those apart: live,
  // a drag that drew nothing was reported as having drawn something because the
  // Shapes flyout happened to close between the two captures.
  let moved = 0;
  let counted = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (region) {
      const x = index % grid;
      const y = Math.floor(index / grid);
      if (x < region.left || x > region.right || y < region.top || y > region.bottom) continue;
    }
    counted += 1;
    if (Math.abs(before[index] - after[index]) > threshold) moved += 1;
  }
  return counted === 0 ? null : moved / counted;
}

/**
 * The grid cells covering a screen rectangle inside a captured window.
 *
 * Returns null when the geometry is unknown, so the caller reports "cannot tell"
 * rather than measuring the wrong part of the picture.
 */
export function gridRegion({ bounds, from, to, grid = SIGNATURE_GRID, padCells = 2 }) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const cellX = (screenX) => Math.floor(((screenX - bounds.x) / bounds.width) * grid);
  const cellY = (screenY) => Math.floor(((screenY - bounds.y) / bounds.height) * grid);
  const clamp = (value) => Math.max(0, Math.min(grid - 1, value));
  return {
    left: clamp(Math.min(cellX(from.x), cellX(to.x)) - padCells),
    right: clamp(Math.max(cellX(from.x), cellX(to.x)) + padCells),
    top: clamp(Math.min(cellY(from.y), cellY(to.y)) - padCells),
    bottom: clamp(Math.max(cellY(from.y), cellY(to.y)) + padCells)
  };
}
