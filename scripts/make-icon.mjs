#!/usr/bin/env node
// THE BRAND MARK, TURNED INTO EVERY ASSET THE PRODUCT NEEDS.
//
// This used to DRAW the mark — a white diamond on a blue gradient — because
// there was no mark to draw from. There is one now
// (`assets/brand/syscora-mark.png`), and it is the source of truth for both
// places the product shows itself:
//
//   apps/desktop/logo.png   the mark in the top bar, white, transparent, cropped
//   apps/desktop/icon.ico   the window, taskbar, Explorer and installer icon
//
// THE SOURCE IS WHITE-ON-BLACK, WHICH IS AN ALPHA CHANNEL IN DISGUISE. The
// artwork is a white knot on a near-black field with a soft glow. Its luminance
// IS the coverage of the mark, so the whole conversion is: alpha = luminance,
// colour = white. That keeps the glow — it becomes a soft falloff in alpha —
// and it means the same mask can be tinted any colour later without a second
// asset. Compositing the black background instead would put a black square in
// the middle of a glass top bar.
//
// No image library and no hand-made binary: a PNG is a zlib stream plus four
// chunks with CRCs, which Node can both read and write, and an .ico is a header
// plus a directory plus those PNGs.
//
//   node scripts/make-icon.mjs        writes apps/desktop/logo.png and icon.ico
//
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "assets", "brand", "syscora-mark.png");
const ICON_OUT = path.join(root, "apps", "desktop", "icon.ico");
const LOGO_OUT = path.join(root, "apps", "desktop", "logo.png");

// Every size Windows picks from: 16 in the title bar, 32 in the taskbar, 48 in
// Explorer, 256 for the installer and large tiles.
const SIZES = [16, 32, 48, 64, 128, 256];
// The top bar draws it at 28px; 256 is four times the largest retina case and
// still under 20 KB once it is one flat colour plus an alpha channel.
const LOGO_SIZE = 256;

// The tile behind the mark in the .ico. The mark alone would be a white shape on
// whatever the taskbar happens to be, which on a light theme is white — so there
// has to be a tile, and it is BLACK, the way the artwork itself is.
//
// It was a blue-to-indigo gradient, left over from the generation when the mark
// was a diamond drawn in CSS and the gradient WAS the brand. Against the real
// mark it is a colour the product does not use anywhere else, and it made the
// taskbar icon the loudest blue on a dark taskbar.
//
// Not flat #000: three near-black steps so the tile has a light direction and
// does not read as a hole punched in the taskbar. The rim below is what gives it
// an edge on a black background.
const FROM = [26, 29, 38];
const VIA = [15, 17, 23];
const TO = [7, 8, 12];
// A faint cool rim, so the tile has a visible boundary against a black taskbar
// without introducing a second colour.
const RIM = [86, 104, 140];

// ---- reading the source ------------------------------------------------------

/**
 * The minimum PNG reader this file needs: 8-bit, non-interlaced, truecolour with
 * or without alpha. Anything else throws rather than producing a quietly wrong
 * mark — a mis-decoded icon is the kind of thing nobody notices until it ships.
 */
function readPng(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8) throw new Error(`${file}: only 8-bit samples are supported, got ${depth}`);
      if (colour !== 2 && colour !== 6) throw new Error(`${file}: only truecolour is supported, got type ${colour}`);
      if (body[12] !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  return { width, height, channels, pixels: unfilter(raw, width, height, channels) };
}

/**
 * Undo the per-scanline filters. This is the one part of PNG that cannot be
 * skipped: every line carries a filter byte and lines 2..n are usually encoded
 * as differences from the line above, so treating the stream as raw samples
 * produces a picture that looks like television static.
 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const target = y * stride;
    const above = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[target + x - channels] : 0;
      const up = y > 0 ? out[above + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[above + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      out[target + x] = value & 0xff;
    }
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---- the mask ----------------------------------------------------------------

/**
 * Luminance, floored, cropped to the mark and returned as a square.
 *
 * THE FLOOR IS NOT COSMETIC. The "black" field is JPEG-ish noise around #0a0a0a,
 * so a raw luminance alpha paints a faint grey haze over the entire square — on
 * a dark top bar that reads as a smudge rather than as a mark. Anything under
 * the floor becomes fully transparent and the rest is rescaled so the mark keeps
 * its full brightness.
 *
 * Square, because the mark is round-ish and a bounding box that is 3px wider
 * than it is tall would make every size below stretch it.
 */
function markMask() {
  const { width, height, channels, pixels } = readPng(SOURCE);
  const FLOOR = 26;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const at = index * channels;
    // Rec. 709 luma. The artwork is greyscale, so any sane weighting agrees;
    // this one is the standard.
    const luma = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
    mask[index] = luma <= FLOOR ? 0 : Math.min(255, Math.round(((luma - FLOOR) / (255 - FLOOR)) * 255));
  }

  // The bounding box of the mark itself, ignoring the glow: the glow is what
  // makes the mark feel lit, but cropping to it would leave the solid shape
  // visibly small inside its own box.
  const SOLID = 110;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] < SOLID) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("the brand mark decoded to nothing — check assets/brand/syscora-mark.png");

  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  // A little room for the glow to breathe, and so the mark is not touching the
  // edge of its own asset.
  const pad = Math.round(side * 0.06);
  const box = side + pad * 2;
  const left = Math.round(minX + (maxX - minX + 1) / 2 - box / 2);
  const top = Math.round(minY + (maxY - minY + 1) / 2 - box / 2);

  const square = new Uint8Array(box * box);
  for (let y = 0; y < box; y++) {
    const sourceY = top + y;
    if (sourceY < 0 || sourceY >= height) continue;
    for (let x = 0; x < box; x++) {
      const sourceX = left + x;
      if (sourceX < 0 || sourceX >= width) continue;
      square[y * box + x] = mask[sourceY * width + sourceX];
    }
  }
  return { size: box, data: square };
}

/**
 * Box-average downscale. Every output pixel is the mean of the source pixels it
 * covers, which is what keeps a 1000px line-art mark readable at 16px — nearest
 * neighbour drops whole strokes of a knot this thin.
 */
function resizeMask(mask, target) {
  const scale = mask.size / target;
  const out = new Float64Array(target * target);
  for (let y = 0; y < target; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < target; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let total = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < mask.size; sy++) {
        for (let sx = x0; sx < x1 && sx < mask.size; sx++) {
          total += mask.data[sy * mask.size + sx];
          count++;
        }
      }
      out[y * target + x] = count ? total / count : 0;
    }
  }
  return out;
}

// ---- the two things this writes ---------------------------------------------

/** The top bar's mark: white, with the artwork's own glow as its alpha. */
function renderLogo(mask) {
  const alpha = resizeMask(mask, LOGO_SIZE);
  const pixels = Buffer.alloc(LOGO_SIZE * LOGO_SIZE * 4);
  for (let index = 0; index < LOGO_SIZE * LOGO_SIZE; index++) {
    const at = index * 4;
    pixels[at] = 255;
    pixels[at + 1] = 255;
    pixels[at + 2] = 255;
    pixels[at + 3] = Math.round(Math.max(0, Math.min(255, alpha[index])));
  }
  return png(LOGO_SIZE, LOGO_SIZE, pixels);
}

const mix = (a, b, t) => a.map((channel, index) => channel + (b[index] - channel) * t);

/** The gradient runs at 150deg, the same angle the CSS uses. */
function background(x, y, size) {
  const t = Math.min(1, Math.max(0, (x * 0.45 + y * 0.85) / (size * 1.15)));
  return t < 0.45 ? mix(FROM, VIA, t / 0.45) : mix(VIA, TO, (t - 0.45) / 0.55);
}

/**
 * Inside the rounded square?
 *
 * The signed distance to a rounded box, in full: the straight edges are the
 * `min(max(...), 0)` term and the corners are the `hypot` one. A first version
 * required BOTH axes to be inside at once, which is true only of the middle
 * cross of the square — the icon came out as four detached corner blobs.
 */
function tileDistance(x, y, size) {
  const radius = size * 0.22;
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

function insideTile(x, y, size) {
  return tileDistance(x, y, size) <= 0;
}

/**
 * How much of the rim light this pixel catches: 1 at the very edge, 0 a few
 * pixels in. A black tile on a black taskbar has no silhouette at all without
 * it — the icon reads as the mark floating in nothing, and at 16px as a smudge.
 */
function rimLight(x, y, size) {
  const distance = tileDistance(x + 0.5, y + 0.5, size);
  if (distance > 0) return 0;
  const width = Math.max(1, size * 0.045);
  return Math.max(0, 1 - -distance / width);
}

/**
 * One icon size, as RGBA: the mark in white over the gradient tile.
 *
 * The mark is inset to 68% of the tile. At 100% a knot with holes in it reads as
 * a smudge at 16px, and the whole point of the small sizes is that the shape is
 * still recognisable in a taskbar.
 */
function renderIcon(mask, size) {
  const INSET = 0.68;
  const markSize = Math.max(1, Math.round(size * INSET));
  const mark = resizeMask(mask, markSize);
  const offset = Math.round((size - markSize) / 2);

  const pixels = Buffer.alloc(size * size * 4);
  const STEPS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The tile edge is sampled 4x4: at 16px an unsmoothed rounded corner is a
      // staircase, and the title bar is where this is seen most.
      let covered = 0;
      for (let sy = 0; sy < STEPS; sy++) {
        for (let sx = 0; sx < STEPS; sx++) {
          if (insideTile(x + (sx + 0.5) / STEPS, y + (sy + 0.5) / STEPS, size)) covered++;
        }
      }
      const coverage = covered / (STEPS * STEPS);

      const markX = x - offset;
      const markY = y - offset;
      const raw = markX >= 0 && markY >= 0 && markX < markSize && markY < markSize
        ? mark[markY * markSize + markX] / 255
        : 0;
      // THE GLOW IS AN ASSET IN THE TOP BAR AND A PROBLEM IN A TASKBAR. Carried
      // through unchanged it makes the mark half-transparent over the tile, and
      // at 32px a half-transparent knot is a smudge. Remapped so the strokes go
      // fully white and only the true antialiased edge stays partial.
      const onMark = Math.max(0, Math.min(1, (raw - 0.1) / 0.55));

      // Tile, then rim, then mark — three blends into one pixel, in that order,
      // so the mark sits on top of the light rather than under it.
      const tile = background(x, y, size);
      const rim = rimLight(x, y, size) * 0.5;
      const lit = tile.map((channel, index) => channel + (RIM[index] - channel) * rim);
      const at = (y * size + x) * 4;
      pixels[at] = Math.round(lit[0] + (255 - lit[0]) * onMark);
      pixels[at + 1] = Math.round(lit[1] + (255 - lit[1]) * onMark);
      pixels[at + 2] = Math.round(lit[2] + (255 - lit[2]) * onMark);
      pixels[at + 3] = Math.round(255 * coverage);
    }
  }
  return pixels;
}

// ---- PNG ---------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;    // bit depth
  header[9] = 6;    // truecolour with alpha
  // Filter byte 0 (none) in front of every scanline. Nothing here is a
  // photograph, so a filter buys almost nothing and costs the clarity.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- ICO ---------------------------------------------------------------------

const mask = markMask();

fs.writeFileSync(LOGO_OUT, renderLogo(mask));

const images = SIZES.map((size) => ({ size, data: png(size, size, renderIcon(mask, size)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);              // 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const directory = [];
for (const image of images) {
  const entry = Buffer.alloc(16);
  // 256 is written as 0 — the field is one byte and 256 does not fit in it.
  entry[0] = image.size === 256 ? 0 : image.size;
  entry[1] = image.size === 256 ? 0 : image.size;
  entry.writeUInt16LE(1, 4);             // colour planes
  entry.writeUInt16LE(32, 6);            // bits per pixel
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  directory.push(entry);
  offset += image.data.length;
}

fs.writeFileSync(ICON_OUT, Buffer.concat([header, ...directory, ...images.map((image) => image.data)]));
console.log(`wrote ${LOGO_OUT} — ${LOGO_SIZE}px, ${(fs.statSync(LOGO_OUT).size / 1024).toFixed(1)} KB`);
console.log(`wrote ${ICON_OUT} — ${SIZES.join(", ")} px, ${(fs.statSync(ICON_OUT).size / 1024).toFixed(1)} KB`);
