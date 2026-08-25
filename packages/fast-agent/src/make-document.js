// MAKING A DOCUMENT HAD NO VERB, SO IT COST THIRTEEN TOOL CALLS.
//
// Measured live, 25 Aug 2026. "create a pdf file properly formatted, write an
// essay about how to make an aircraft from scratch" took 219.7 seconds, 14
// steps, 13 tool calls and 227,584 tokens. Not one of those steps was about the
// essay. The agent probed for Python, probed for `reportlab` and `fpdf`, ran
// `pip install reportlab`, wrote a Python SCRIPT containing the whole essay,
// ran the script, stat'd the output, tried to read the PDF back and failed,
// dumped its header bytes to prove it was a PDF, tried `open_url` on a local
// path (which only takes http), fell back to `Start-Process`, listed the
// windows, launched it again, and finally OCR'd Microsoft Edge to confirm the
// text was there.
//
// Every one of those is a reasonable move for a model that has no tool for the
// job. The defect is the missing tool. A person asking for a PDF is not asking
// for a Python toolchain, and they are certainly not paying for one.
//
// WHY THIS IS WRITTEN HERE RATHER THAN INSTALLED.
//
// Same argument as apps/desktop/markdown.js: this project ships with zero
// runtime dependencies, which is most of why its supply-chain surface is
// nothing. Every format below is a documented container that Node's own
// `zlib` and `Buffer` can build:
//
//   - A .docx, .xlsx and .pptx are ZIP archives of XML. Node has deflate.
//   - A PDF is a text-mode object graph. The fourteen standard Type 1 fonts
//     are present in every reader by specification, so nothing is embedded and
//     the only hard part is knowing how wide the glyphs are — which is the
//     width table below, straight out of the Helvetica AFM.
//
// WHAT IT DOES NOT DO. It does not lay out images, columns or footnotes, and
// there is no .pptx writer here yet. A request for one of those should fail
// saying so rather than produce something that quietly is not it.
//
// VERIFICATION DOES NOT SHARE A CODE PATH WITH THIS FILE. Everything written
// here is read back by `documents.js`, which was written to parse other
// people's documents and knows nothing about this module. A PDF this file
// believes it wrote and that extractor cannot read is not a PDF.

import zlib from "node:zlib";

// ---- markdown → blocks -------------------------------------------------------
//
// The model writes markdown — it is what it is fluent in and what it emits
// unprompted. The same shape as the block walker in apps/desktop/markdown.js,
// stopping at structure rather than going on to HTML, because three different
// writers below need the structure and none of them wants tags.

/** Inline runs: `**bold**`, `*italic*`, `` `code` ``. Nothing nested. */
function runs(text) {
  const out = [];
  const pattern = /(\*\*\*|\*\*|\*|`)((?:(?!\1)[\s\S])+)\1/g;
  let at = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > at) out.push({ text: text.slice(at, match.index) });
    const marker = match[1];
    out.push({
      text: match[2],
      bold: marker === "**" || marker === "***",
      italic: marker === "*" || marker === "***",
      code: marker === "`"
    });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out.length ? out : [{ text }];
}

const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());

/**
 * Blocks, in document order. Each is `{ kind, … }` where kind is one of
 * heading | paragraph | bullet | numbered | code | rule | table.
 */
export function parseBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```+\s*$/.test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ kind: "code", language: fence[1] || "", text: body.join("\n") });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, runs: runs(heading[2].trim()) });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { blocks.push({ kind: "rule" }); index += 1; continue; }

    // A table, which is the whole point of the spreadsheet writer and reads far
    // better than pipes in the others.
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const head = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) { rows.push(cells(lines[index])); index += 1; }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const listMatch = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = !listMatch[2];
      const items = [];
      while (index < lines.length) {
        const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[index]);
        if (!item || Boolean(item[2]) === ordered) break;
        let text = item[4];
        index += 1;
        // A wrapped item belongs to the line above it, not to a new paragraph.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index])
          && !/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[index])) {
          text += ` ${lines[index].trim()}`;
          index += 1;
        }
        items.push({ indent: Math.min(2, Math.floor(item[1].length / 2)), runs: runs(text) });
        // One blank line inside a list is still the same list — models put one
        // between numbered points constantly. Two end it.
        if (index < lines.length && !lines[index].trim()
          && index + 1 < lines.length && /^\s*(?:[-*+]|\d+[.)])\s/.test(lines[index + 1])) {
          index += 1;
        }
      }
      blocks.push({ kind: ordered ? "numbered" : "bullet", items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim()
      && !/^\s*(#{1,6}\s|\d+[.)]\s|[-*+]\s|```)/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) blocks.push({ kind: "paragraph", runs: runs(paragraph.join(" ")) });
  }
  return blocks;
}

// ---- ZIP ---------------------------------------------------------------------
//
// documents.js has the reader; this is the other half. An OOXML file is a ZIP
// with a specific set of members, and nothing about writing one needs a library.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** `files` is [{ name, data }]. Deflated, because Word and Excel both expect it. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Storing is legal and is smaller for anything that does not compress. It
    // also keeps a tiny archive readable in a hex dump, which is how the first
    // broken .docx here was diagnosed.
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date — 1 Jan 1980, the ZIP epoch
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 38);          // external attributes
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// A control character is not representable in XML 1.0 at all, and one in the
// middle of a document makes Word declare the whole file corrupt and offer to
// repair it. Tab, newline and carriage return are the three that are legal.
// Built from character codes rather than written as a literal class, because a
// source file with raw control bytes in it is one git treats as binary.
const XML_CONTROL = new RegExp(
  `[${["\\u0000-\\u0008", "\\u000B", "\\u000C", "\\u000E-\\u001F"].join("")}]`,
  "g"
);

const xmlEscape = (value) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
  .replace(XML_CONTROL, "");

// ---- PDF ---------------------------------------------------------------------
//
// The fourteen standard fonts are in every reader by specification, so nothing
// is embedded. What that costs is having to know the glyph widths in order to
// wrap a line, which is what these tables are: Helvetica and Helvetica-Bold from
// their AFMs, in 1/1000 em. Helvetica-Oblique has Helvetica's widths.

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

// THE ENCODING HAS THESE GLYPHS. THE FIRST VERSION THREW THEM AWAY.
//
// WinAnsi is Latin-1 plus a block between 0x80 and 0x9F holding exactly the
// typographic characters a model writes constantly — curly quotes, en and em
// dashes, the ellipsis, the bullet — which Unicode puts somewhere else entirely.
// This started out folding "•" to "-" on the assumption there was no bullet, and
// every list in the rendered PDF came out as hyphens. There is one, at 0x95.
// Seen on the page, not in the source.
const WINANSI = new Map(Object.entries({
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f
}).map(([character, code]) => [character, String.fromCharCode(code)]));

// No WinAnsi glyph at all, so spelled rather than lost. A sentence that reads
// "keep the load ? 4g" has had its meaning removed.
const SPELL = new Map(Object.entries({
  "−": "-", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
  "×": "x", "÷": "/", "′": "'", "″": '"', "·": "-",
  " ": " "
}));

function toWinAnsi(text) {
  let out = "";
  for (const character of String(text ?? "")) {
    if (WINANSI.has(character)) { out += WINANSI.get(character); continue; }
    if (SPELL.has(character)) { out += SPELL.get(character); continue; }
    const code = character.codePointAt(0);
    // Latin-1 proper, which WinAnsi agrees with from 0xA0 up, plus printable
    // ASCII. Everything else — CJK, emoji, mathematical alphabets — has no glyph
    // in a standard Type 1 font, and would need one embedded.
    out += (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? character : "?";
  }
  return out;
}

// The WinAnsi extras, from the same AFM as the tables above. Without them a line
// of bullets or quotes measures at the fallback width and wraps in the wrong place.
const EXTRA_WIDTHS = {
  0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000
};

const pdfString = (text) => toWinAnsi(text).replace(/[\\()]/g, (c) => `\\${c}`);

function widthOf(text, size, bold) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const character of toWinAnsi(text)) {
    const code = character.charCodeAt(0);
    // Anything left over is an accented Latin-1 glyph, and every one of those is
    // within a few units of its unaccented base. 556 is the mean.
    total += code >= 32 && code <= 126 ? table[code - 32] : (EXTRA_WIDTHS[code] ?? 556);
  }
  return (total * size) / 1000;
}

/** Break `runs` into lines that fit `maxWidth`, keeping each run's style. */
function wrap(inlineRuns, size, maxWidth, forceBold = false) {
  const lines = [];
  let line = [];
  let used = 0;
  for (const run of inlineRuns) {
    const bold = forceBold || Boolean(run.bold);
    for (const word of String(run.text).split(/(\s+)/)) {
      if (!word) continue;
      const isSpace = /^\s+$/.test(word);
      const width = widthOf(isSpace ? " " : word, size, bold);
      if (isSpace) {
        // A space at the start of a line is a hole in the left margin.
        if (line.length) { line.push({ text: " ", bold, italic: run.italic, code: run.code, width }); used += width; }
        continue;
      }
      if (used + width > maxWidth && line.length) {
        // Trailing spaces belong to the break, not to the line above it.
        while (line.length && line.at(-1).text === " ") { used -= line.pop().width; }
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push({ text: word, bold, italic: run.italic, code: run.code, width });
      used += width;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

// A4, because this ships to a user in India and Letter is not the paper here.
const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const BODY_SIZE = 11;
const LEADING = 15.5;
const HEADING_SIZES = [19, 15.5, 13, 12, 11, 11];

function writePdf({ title, blocks }) {
  const usable = PAGE.width - PAGE.margin * 2;
  const pages = [];
  let ops = [];
  let y = PAGE.height - PAGE.margin;

  const newPage = () => { pages.push(ops); ops = []; y = PAGE.height - PAGE.margin; };
  const room = (needed) => { if (y - needed < PAGE.margin + 28) newPage(); };

  // One line of styled runs at (x, y). A font change needs its own text-showing
  // operator, which is what makes `**bold**` inside a sentence work — but only a
  // font change does.
  //
  // ONE OPERATOR PER STYLE, NOT ONE PER WORD. `wrap` returns the line already
  // split into words, and drawing each of them as its own `Tj` at its own
  // position produced a PDF that LOOKED right and extracted as one word per
  // line: "Building\nan\nAircraft\nfrom\nScratch". Every text extractor, ours
  // included, reads a new positioning operator as a new line, because in a
  // real PDF that is what it means. So a search inside the file finds no
  // phrase, copy-and-paste out of a reader gives a column of words, and the
  // read-back that is supposed to CONFIRM the document holds what was asked for
  // is checking something no human would recognise. Adjacent words in the same
  // style are one operator.
  const drawLine = (line, x, size) => {
    let cursor = x;
    let index = 0;
    while (index < line.length) {
      const style = (piece) => `${piece.code ? 1 : 0}${piece.bold ? 1 : 0}${piece.italic ? 1 : 0}`;
      const key = style(line[index]);
      let text = "";
      let width = 0;
      while (index < line.length && style(line[index]) === key) {
        const piece = line[index];
        text += piece.text;
        width += piece.code ? widthOf(piece.text, size, false) : piece.width;
        index += 1;
      }
      const head = line[index - 1];
      const font = head.code ? "/F4" : head.bold ? "/F2" : head.italic ? "/F3" : "/F1";
      ops.push(`BT ${font} ${size} Tf 1 0 0 1 ${cursor.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(text)}) Tj ET`);
      cursor += width;
    }
  };

  const paragraph = (inlineRuns, { size = BODY_SIZE, indent = 0, gap = 6, bold = false, marker = null } = {}) => {
    const lines = wrap(inlineRuns, size, usable - indent, bold);
    const leading = size <= BODY_SIZE ? LEADING : size * 1.34;
    for (const [at, line] of lines.entries()) {
      room(leading);
      if (at === 0 && marker) {
        drawLine([{ text: marker, width: widthOf(marker, size, false) }], PAGE.margin + indent - 16, size);
      }
      drawLine(line, PAGE.margin + indent, size);
      y -= leading;
    }
    y -= gap;
  };

  if (title) {
    paragraph(runs(title), { size: 22, gap: 4, bold: true });
    // A rule under the title, which is the cheapest thing that makes a generated
    // document look composed rather than dumped.
    room(10);
    ops.push(`0.72 0.75 0.80 RG 0.8 w ${PAGE.margin} ${(y + 6).toFixed(2)} m ${(PAGE.width - PAGE.margin).toFixed(2)} ${(y + 6).toFixed(2)} l S`);
    y -= 14;
  }

  for (const block of blocks) {
    if (block.kind === "heading") {
      const size = HEADING_SIZES[Math.min(5, block.level - 1)];
      room(size * 2.4);
      y -= block.level === 1 ? 8 : 6;
      paragraph(block.runs, { size, gap: 3, bold: true });
      continue;
    }
    if (block.kind === "paragraph") { paragraph(block.runs, { gap: 7 }); continue; }
    if (block.kind === "bullet" || block.kind === "numbered") {
      for (const [at, item] of block.items.entries()) {
        paragraph(item.runs, {
          indent: 20 + item.indent * 18,
          gap: 2,
          marker: block.kind === "numbered" ? `${at + 1}.` : "•"
        });
      }
      y -= 5;
      continue;
    }
    if (block.kind === "code") {
      const lines = String(block.text).split("\n");
      room(lines.length * 13 + 12);
      const top = y + 9;
      const height = lines.length * 13 + 10;
      ops.push(`0.96 0.96 0.97 rg ${PAGE.margin} ${(top - height).toFixed(2)} ${usable.toFixed(2)} ${height.toFixed(2)} re f`);
      for (const line of lines) {
        room(13);
        ops.push(`0 g BT /F4 9.5 Tf 1 0 0 1 ${(PAGE.margin + 8).toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(line)}) Tj ET`);
        y -= 13;
      }
      y -= 10;
      continue;
    }
    if (block.kind === "rule") {
      room(14);
      ops.push(`0.8 0.8 0.84 RG 0.8 w ${PAGE.margin} ${y.toFixed(2)} m ${(PAGE.width - PAGE.margin).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 14;
      continue;
    }
    if (block.kind === "table") {
      const columns = block.head.length || 1;
      const columnWidth = usable / columns;
      const row = (values, bold) => {
        room(LEADING + 4);
        // Cells are clipped rather than wrapped: a table in a generated document
        // is a summary, and a wrapped cell needs row heights this does not track.
        for (const [at, value] of values.entries()) {
          let text = String(value ?? "");
          while (widthOf(text, 10, bold) > columnWidth - 8 && text.length > 1) text = text.slice(0, -1);
          ops.push(`BT ${bold ? "/F2" : "/F1"} 10 Tf 1 0 0 1 ${(PAGE.margin + at * columnWidth + 2).toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(text)}) Tj ET`);
        }
        y -= LEADING;
      };
      if (block.head.length) {
        row(block.head, true);
        ops.push(`0.8 0.8 0.84 RG 0.6 w ${PAGE.margin} ${(y + 10).toFixed(2)} m ${(PAGE.width - PAGE.margin).toFixed(2)} ${(y + 10).toFixed(2)} l S`);
      }
      for (const values of block.rows) row(values, false);
      y -= 8;
    }
  }
  pages.push(ops);

  // ---- the object graph ----
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const fontIds = {
    F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
    F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
    F4: add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
  };
  const resources = `<< /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R /F4 ${fontIds.F4} 0 R >> >>`;
  const pagesId = objects.length + pages.length * 2 + 1;

  const pageIds = [];
  for (const [at, content] of pages.entries()) {
    // The page number, drawn last so it is never pushed off by the body.
    const number = `0.45 g BT /F1 9 Tf 1 0 0 1 ${(PAGE.width / 2 - 8).toFixed(2)} ${(PAGE.margin - 22).toFixed(2)} Tm (${at + 1}) Tj ET 0 g`;
    // UNCOMPRESSED ON PURPOSE. It costs a few kilobytes and it means the text
    // is legible in the file itself — which is what settles an argument about
    // whether a document really holds what it was told to hold, without
    // trusting either this writer or the extractor that checks it.
    const stream = `0 g\n${content.join("\n")}\n${number}`;
    const streamId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources ${resources} /Contents ${streamId} 0 R >>`
    ));
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const infoId = add(`<< /Title (${pdfString(title ?? "")}) /Producer (SYSCORA) >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const [at, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${at + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return { buffer: Buffer.from(out, "latin1"), pages: pages.length };
}

// ---- DOCX --------------------------------------------------------------------

const CONTENT_TYPES = (parts) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' + parts + "</Types>";

const ROOT_RELS = (target, type) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  `<Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;

function docxRuns(inlineRuns, { bold = false } = {}) {
  return inlineRuns.map((run) => {
    const properties = [
      bold || run.bold ? "<w:b/>" : "",
      run.italic ? "<w:i/>" : "",
      run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""
    ].join("");
    // xml:space="preserve" or Word eats the spaces between styled runs and the
    // sentence closes up into onelongword.
    return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}` +
      `<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
  }).join("");
}

function writeDocx({ title, blocks }) {
  const body = [];
  if (title) body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${docxRuns(runs(title))}</w:p>`);

  for (const block of blocks) {
    if (block.kind === "heading") {
      body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(3, block.level)}"/></w:pPr>${docxRuns(block.runs)}</w:p>`);
    } else if (block.kind === "paragraph") {
      body.push(`<w:p>${docxRuns(block.runs)}</w:p>`);
    } else if (block.kind === "bullet" || block.kind === "numbered") {
      // Real Word numbering needs numbering.xml and an abstract definition per
      // list; the marker is written into the text instead. It reads and prints
      // identically and it cannot produce a document Word refuses to open.
      for (const [at, item] of block.items.entries()) {
        const marker = block.kind === "numbered" ? `${at + 1}. ` : "• ";
        body.push(
          `<w:p><w:pPr><w:ind w:left="${360 + item.indent * 360}" w:hanging="360"/></w:pPr>` +
          docxRuns([{ text: marker }, ...item.runs]) + "</w:p>"
        );
      }
    } else if (block.kind === "code") {
      for (const line of String(block.text).split("\n")) {
        body.push(
          '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' +
          docxRuns([{ text: line || " ", code: true }]) + "</w:p>"
        );
      }
    } else if (block.kind === "rule") {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>');
    } else if (block.kind === "table") {
      const row = (values, bold) => "<w:tr>" + values.map((value) =>
        '<w:tc><w:tcPr><w:tcBorders>' +
        '<w:top w:val="single" w:sz="4" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/>' +
        '<w:left w:val="single" w:sz="4" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:color="CCCCCC"/>' +
        `</w:tcBorders></w:tcPr><w:p>${docxRuns([{ text: String(value ?? "") }], { bold })}</w:p></w:tc>`
      ).join("") + "</w:tr>";
      body.push(
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
        (block.head.length ? row(block.head, true) : "") +
        block.rows.map((values) => row(values, false)).join("") + "</w:tbl><w:p/>"
      );
    }
  }

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="200"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="1F3864"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="240" w:after="100"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="2E5496"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>';

  return {
    buffer: zip([
      {
        name: "[Content_Types].xml",
        data: CONTENT_TYPES(
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        )
      },
      {
        name: "_rels/.rels",
        data: ROOT_RELS("word/document.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument")
      },
      {
        name: "word/_rels/document.xml.rels",
        data: ROOT_RELS("styles.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles")
      },
      { name: "word/styles.xml", data: styles },
      {
        name: "word/document.xml",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
          '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
      }
    ]),
    pages: null
  };
}

// ---- XLSX --------------------------------------------------------------------

const COLUMN = (index) => {
  let name = "";
  let n = index;
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return name;
};

/**
 * Rows for a spreadsheet. A markdown table is the obvious source; failing that,
 * CSV lines; failing that, one column of whatever the lines are — which is still
 * a spreadsheet, and is a great deal better than refusing.
 */
export function tabulate(source, blocks) {
  const table = blocks.find((block) => block.kind === "table");
  if (table) return [table.head, ...table.rows].filter((row) => row.length);
  const lines = String(source ?? "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length && lines.every((line) => line.includes(","))) {
    // Quoted CSV, because a cell containing a comma is the entire reason quotes
    // exist and splitting on commas alone silently shifts every column after it.
    return lines.map((line) => {
      const values = [];
      let value = "";
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
          if (character === '"' && line[index + 1] === '"') { value += '"'; index += 1; }
          else if (character === '"') quoted = false;
          else value += character;
        } else if (character === '"') quoted = true;
        else if (character === ",") { values.push(value.trim()); value = ""; }
        else value += character;
      }
      values.push(value.trim());
      return values;
    });
  }
  return lines.map((line) => [line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")]);
}

function writeXlsx({ title, rows }) {
  const widths = [];
  const sheetRows = rows.map((values, rowIndex) => {
    const cellsXml = values.map((value, columnIndex) => {
      const text = String(value ?? "");
      widths[columnIndex] = Math.min(60, Math.max(widths[columnIndex] ?? 10, text.length + 2));
      const reference = `${COLUMN(columnIndex)}${rowIndex + 1}`;
      // A number stays a number, or every total in the sheet is text and the
      // user's first SUM returns zero. Written from the value, not guessed:
      // "007" and "1-2" are not numbers and must stay strings.
      const numeric = text.trim() !== "" && Number.isFinite(Number(text)) && !/^0\d|^\+|\s/.test(text.trim());
      if (numeric) return `<c r="${reference}"${rowIndex === 0 ? ' s="1"' : ""}><v>${Number(text)}</v></c>`;
      return `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
  }).join("");

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<cols>" + widths.map((width, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("") + "</cols>" +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs></styleSheet>';

  return {
    buffer: zip([
      {
        name: "[Content_Types].xml",
        data: CONTENT_TYPES(
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        )
      },
      {
        name: "_rels/.rels",
        data: ROOT_RELS("xl/workbook.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument")
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
      },
      {
        name: "xl/workbook.xml",
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${xmlEscape((title || "Sheet1").slice(0, 31).replace(/[\\/?*[\]:]/g, " "))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
      },
      { name: "xl/styles.xml", data: styles },
      { name: "xl/worksheets/sheet1.xml", data: sheet }
    ]),
    pages: null
  };
}

// ---- HTML, markdown, plain text ---------------------------------------------

function writeHtml({ title, blocks }) {
  const inline = (inlineRuns) => inlineRuns.map((run) => {
    const text = xmlEscape(run.text);
    if (run.code) return `<code>${text}</code>`;
    if (run.bold && run.italic) return `<strong><em>${text}</em></strong>`;
    if (run.bold) return `<strong>${text}</strong>`;
    if (run.italic) return `<em>${text}</em>`;
    return text;
  }).join("");

  const parts = [];
  for (const block of blocks) {
    if (block.kind === "heading") parts.push(`<h${Math.min(6, block.level)}>${inline(block.runs)}</h${Math.min(6, block.level)}>`);
    else if (block.kind === "paragraph") parts.push(`<p>${inline(block.runs)}</p>`);
    else if (block.kind === "bullet") parts.push(`<ul>${block.items.map((i) => `<li>${inline(i.runs)}</li>`).join("")}</ul>`);
    else if (block.kind === "numbered") parts.push(`<ol>${block.items.map((i) => `<li>${inline(i.runs)}</li>`).join("")}</ol>`);
    else if (block.kind === "code") parts.push(`<pre><code>${xmlEscape(block.text)}</code></pre>`);
    else if (block.kind === "rule") parts.push("<hr>");
    else if (block.kind === "table") {
      parts.push("<table><thead><tr>" + block.head.map((c) => `<th>${xmlEscape(c)}</th>`).join("") +
        "</tr></thead><tbody>" + block.rows.map((row) =>
          "<tr>" + row.map((c) => `<td>${xmlEscape(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
    }
  }
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${xmlEscape(title ?? "Document")}</title>\n` +
    "<style>\nbody{max-width:46rem;margin:3rem auto;padding:0 1.5rem;font:16px/1.65 -apple-system,Segoe UI,system-ui,sans-serif;color:#1a1d21}\n" +
    "h1{font-size:2rem;margin:0 0 .4em;border-bottom:1px solid #e3e6ea;padding-bottom:.3em}\nh2{margin:2em 0 .5em;font-size:1.35rem}\nh3{margin:1.6em 0 .4em;font-size:1.1rem}\n" +
    "code{background:#f2f4f7;border-radius:4px;padding:.1em .35em;font-size:.9em}\npre{background:#f6f8fa;border:1px solid #e3e6ea;border-radius:8px;padding:1rem;overflow-x:auto}\n" +
    "pre code{background:none;padding:0}\ntable{border-collapse:collapse;width:100%}\nth,td{border:1px solid #dfe3e8;padding:.5em .7em;text-align:left}\nth{background:#f6f8fa}\n</style>\n" +
    `</head>\n<body>\n${title ? `<h1>${xmlEscape(title)}</h1>\n` : ""}${parts.join("\n")}\n</body>\n</html>\n`;
  return { buffer: Buffer.from(html, "utf8"), pages: null };
}

// ---- the one entry point -----------------------------------------------------

export const DOCUMENT_FORMATS = ["pdf", "docx", "xlsx", "csv", "html", "md", "txt"];

/**
 * Build a document from markdown. Returns `{ buffer, pages, format }`.
 *
 * Throws for a format this cannot honestly produce. A .pptx written badly opens
 * as a repair dialog, and "here is your deck" over a file PowerPoint refuses is
 * worse than saying it is not supported.
 */
export function makeDocument({ format, title = "", content = "" }) {
  const kind = String(format ?? "").replace(/^\./, "").toLowerCase();
  if (!DOCUMENT_FORMATS.includes(kind)) {
    throw new Error(
      `Cannot build a .${kind} here. This writes ${DOCUMENT_FORMATS.map((f) => `.${f}`).join(", ")}. ` +
      "For anything else, build it with a command instead."
    );
  }
  const source = String(content ?? "");
  const blocks = parseBlocks(source);

  if (kind === "pdf") return { ...writePdf({ title, blocks }), format: "pdf" };
  if (kind === "docx") return { ...writeDocx({ title, blocks }), format: "docx" };
  if (kind === "xlsx") return { ...writeXlsx({ title, rows: tabulate(source, blocks) }), format: "xlsx" };
  if (kind === "html") return { ...writeHtml({ title, blocks }), format: "html" };
  if (kind === "csv") {
    const quote = (value) => (/[",\n]/.test(String(value ?? "")) ? `"${String(value).replace(/"/g, '""')}"` : String(value ?? ""));
    const text = tabulate(source, blocks).map((row) => row.map(quote).join(",")).join("\r\n");
    return { buffer: Buffer.from(`${text}\r\n`, "utf8"), pages: null, format: "csv" };
  }
  // Markdown is kept exactly as written — it is already the source. Plain text
  // is the markdown with its syntax taken off, because `**bold**` in a .txt is
  // four characters nobody asked for.
  if (kind === "md") {
    const text = title ? `# ${title}\n\n${source}` : source;
    return { buffer: Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8"), pages: null, format: "md" };
  }
  const flat = [];
  if (title) flat.push(title, "=".repeat(Math.min(70, title.length)), "");
  for (const block of blocks) {
    const plain = (inlineRuns) => inlineRuns.map((run) => run.text).join("");
    if (block.kind === "heading") flat.push(plain(block.runs).toUpperCase(), "");
    else if (block.kind === "paragraph") flat.push(plain(block.runs), "");
    else if (block.kind === "bullet") { for (const item of block.items) flat.push(`  - ${plain(item.runs)}`); flat.push(""); }
    else if (block.kind === "numbered") { block.items.forEach((item, at) => flat.push(`  ${at + 1}. ${plain(item.runs)}`)); flat.push(""); }
    else if (block.kind === "code") { flat.push(block.text, ""); }
    else if (block.kind === "rule") flat.push("-".repeat(70), "");
    else if (block.kind === "table") {
      flat.push(block.head.join("\t"));
      for (const row of block.rows) flat.push(row.join("\t"));
      flat.push("");
    }
  }
  return { buffer: Buffer.from(`${flat.join("\r\n").trimEnd()}\r\n`, "utf8"), pages: null, format: "txt" };
}
