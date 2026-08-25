// Reading the documents people actually keep.
//
// `read_file` could read text files, and the things a person asks an assistant
// about are almost never text files: they are the .docx their report is in, the
// .xlsx of their expenses, the deck they are presenting on Thursday, the .pdf a
// bank sent them. Asked about any of those, the agent read the raw bytes of a
// zip archive, got a screenful of mojibake, and concluded the file was corrupt.
//
// None of this needs a dependency. A .docx, .xlsx and .pptx are ZIP archives of
// XML — Node has had the inflate half of that built in all along — and a PDF's
// text lives in FlateDecode streams that come apart the same way. The PNG
// decoder in screen-signature.js was written for the same reason and reads the
// same way: a handful of well-documented structures, parsed where they are
// needed, rather than a package to keep up to date.
//
// What it does NOT do is pretend. A scanned PDF is a picture of a page and there
// is no text in it to find; this says exactly that instead of returning empty
// space that reads like an empty document.

import zlib from "node:zlib";

// ---- ZIP ---------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Every file in the archive, by name, decompressed. Null when this is not a ZIP. */
function readZipEntries(buffer) {
  // The end-of-central-directory record is last, after a comment of unknown
  // length, so it is found by searching backwards for its signature.
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset > buffer.length - 66000; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd === -1) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  let position = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    position += 46 + nameLength + extraLength + commentLength;

    // The local header repeats the name and may carry different extra data, so
    // the data offset has to be computed from it rather than from the entry.
    if (localOffset + 30 > buffer.length) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch {
      // One unreadable member does not make the document unreadable.
    }
  }
  return entries;
}

// ---- XML ---------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeXml(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (whole, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (whole, name) => ENTITIES[name]);
}

/** The text of every `<tag>…</tag>`, in document order. */
function textOf(xml, tag) {
  const found = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let match = pattern.exec(xml);
  while (match) {
    found.push(decodeXml(match[1]));
    match = pattern.exec(xml);
  }
  return found;
}

// ---- The formats -------------------------------------------------------------

function readDocx(entries) {
  const document = entries.get("word/document.xml");
  if (!document) return null;
  const xml = document.toString("utf8");
  // A paragraph is the unit of a Word document, and a paragraph is any number of
  // runs — a bolded word is its own run. Splitting on paragraphs and joining the
  // runs inside each is what keeps "the report" from arriving as one long line.
  const paragraphs = xml
    .split(/<\/w:p>/)
    .map((block) => {
      const runs = textOf(block, "w:t").join("");
      // A tab inside a run is real content in a table of contents or a heading.
      return runs.replace(/<w:tab\/>/g, "\t").trim();
    })
    .filter(Boolean);
  return paragraphs.length ? paragraphs.join("\n") : "";
}

function readPptx(entries) {
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => {
      const number = (name) => Number(name.match(/slide(\d+)\.xml$/)[1]);
      return number(left) - number(right);
    });
  if (slides.length === 0) return null;
  return slides
    .map((name, index) => {
      const lines = textOf(entries.get(name).toString("utf8"), "a:t")
        .map((line) => line.trim())
        .filter(Boolean);
      return `--- Slide ${index + 1} ---\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function readXlsx(entries) {
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  if (sheets.length === 0) return null;

  // Cell text is stored once in a shared table and referenced by index, so the
  // sheet on its own is a grid of numbers pointing at strings that live here.
  const shared = entries.has("xl/sharedStrings.xml")
    ? textOf(entries.get("xl/sharedStrings.xml").toString("utf8"), "si")
      .map((block) => textOf(block, "t").join("").trim())
    : [];

  const columnOf = (reference) => String(reference ?? "").replace(/\d+/g, "");
  return sheets
    .map((name, index) => {
      const xml = entries.get(name).toString("utf8");
      const rows = [];
      for (const row of textOf(xml, "row")) {
        const cells = [];
        const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let match = cellPattern.exec(row);
        while (match) {
          const attributes = match[1] ?? "";
          const body = match[2] ?? "";
          const type = attributes.match(/\bt="([^"]+)"/)?.[1] ?? "n";
          const reference = attributes.match(/\br="([^"]+)"/)?.[1] ?? "";
          let value = "";
          if (type === "s") {
            const pointer = Number(textOf(body, "v")[0] ?? -1);
            value = shared[pointer] ?? "";
          } else if (type === "inlineStr") {
            value = textOf(body, "t").join("").trim();
          } else {
            value = (textOf(body, "v")[0] ?? "").trim();
          }
          if (value) cells.push(`${columnOf(reference)}: ${value}`);
          match = cellPattern.exec(row);
        }
        if (cells.length) rows.push(cells.join(" | "));
      }
      const heading = sheets.length > 1 ? `--- Sheet ${index + 1} ---\n` : "";
      return `${heading}${rows.join("\n")}`;
    })
    .filter((sheet) => sheet.trim())
    .join("\n\n");
}

// ---- PDF ---------------------------------------------------------------------
//
// THE FIRST VERSION OF THIS RETURNED BINARY AND CALLED IT TEXT.
//
// A resume attached to the composer on 23 Aug 2026 came back as 52,220
// characters that were 19.7% printable — "PTZgi*HUµÏ[­­vtuwy|£®°" — and the
// composer sent every one of them to the model as "text pulled out of the PDF".
// The agent, reading its own garbage, went hunting for `pdftotext` on the
// machine. Three separate defects, each enough on its own:
//
//   1. EVERY stream was scanned, including the four embedded font programs
//      (539 KB, 328 KB, 589 KB, 322 KB of compressed TrueType). They inflate
//      perfectly — being unreadable is not the same as being broken — and a
//      font program contains the letters `BT` and plenty of brackets, so the
//      text scanner found "strings" in it all day. A content stream is ASCII
//      operators; a font is not. That is the test, and it is cheap.
//   2. THE TEXT WAS NOT IN BRACKETS AT ALL. This PDF, like everything Word,
//      Canva and Google Docs export, uses `/Encoding /Identity-H`: the content
//      stream says `[<002C>-0.859<002F>...] TJ`, where `002C` is a GLYPH index
//      in a subsetted font, not a character. The old reader only understood
//      `(literal)` strings, so it found nothing in the one stream that mattered
//      and everything in the four that did not. Each font carries a `/ToUnicode`
//      CMap — an ASCII table mapping those glyph codes back to characters — and
//      following it is what turns `<002C>` into `H`.
//   3. `/\((?:\\.|[^\\()])*\)/g` HANGS on binary input. Two nested quantifiers
//      over 500 KB of font program backtracks for minutes; a diagnostic run had
//      to be killed at two. The scanner below is a single linear pass and has no
//      backtracking to do.
//
// The result on the file that started it: 2,932 characters, 99.2% printable,
// which is the resume. `tests/unit/document-reading.test.js` builds a PDF of
// this exact shape rather than checking one in.

const UNPRINTABLE = /[^\x09\x0A\x0D\x20-\x7E]/g;

/**
 * Is this a stream of PDF operators, or is it a font, an image or a colour
 * profile? Sampled rather than measured whole: the answer never changes after
 * the first few thousand characters and these streams run to half a megabyte.
 */
function looksTextual(text) {
  if (!text) return false;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  return sample.replace(UNPRINTABLE, "").length / sample.length > 0.9;
}

function inflateOrRaw(body) {
  try {
    return zlib.inflateSync(Buffer.from(body, "latin1")).toString("latin1");
  } catch {
    // Not deflated, or deflated with a filter this does not implement. An
    // uncompressed content stream is readable as it stands; anything else is
    // caught by looksTextual and dropped.
    return body;
  }
}

/**
 * The file with every stream body blanked, same length so every offset still
 * lines up.
 *
 * Objects have to be found by scanning for `N 0 obj`, and half a megabyte of
 * compressed font contains that byte sequence by chance. Indexing the raw file
 * therefore overwrites the real object 11 with a fragment of a typeface, and
 * every font lookup after it silently fails — which is exactly what happened
 * the first time this was written.
 */
function blankStreams(text) {
  let out = "";
  let at = 0;
  const opening = /stream\r?\n?/g;
  let match;
  while ((match = opening.exec(text))) {
    const from = match.index + match[0].length;
    const to = text.indexOf("endstream", from);
    if (to === -1) break;
    out += text.slice(at, from) + " ".repeat(to - from);
    at = to;
    // Past the whole of "endstream" — its last six letters are "stream", so
    // resuming any earlier matches it and swallows every object up to the next
    // stream. That cost an afternoon.
    opening.lastIndex = to + "endstream".length;
  }
  return out + text.slice(at);
}

/** Where each indirect object's body begins and ends, by object number. */
function indexObjects(skeleton) {
  const objects = new Map();
  const header = /(\d+)\s+\d+\s+obj/g;
  let match;
  while ((match = header.exec(skeleton))) {
    const start = match.index + match[0].length;
    const end = skeleton.indexOf("endobj", start);
    objects.set(Number(match[1]), { start, end: end === -1 ? skeleton.length : end });
  }
  return objects;
}

/** The decompressed stream inside one object, or null when it holds none. */
function streamIn(text, range) {
  if (!range) return null;
  const slice = text.slice(range.start, range.end);
  const opening = /stream\r?\n?/.exec(slice);
  if (!opening) return null;
  const from = opening.index + opening[0].length;
  const to = slice.indexOf("endstream", from);
  return to === -1 ? null : inflateOrRaw(slice.slice(from, to));
}

const HEX_PAIR = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/;
const HEX_TRIPLE = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/;

/** UTF-16BE hex, as ToUnicode always writes its destinations. */
function fromHex(hex) {
  let out = "";
  for (let at = 0; at + 4 <= hex.length; at += 4) out += String.fromCharCode(Number.parseInt(hex.slice(at, at + 4), 16));
  return out;
}

/** glyph code → the character it stands for, from one `/ToUnicode` CMap. */
function parseToUnicode(cmap) {
  const map = new Map();
  for (const section of cmap.split("beginbfchar").slice(1)) {
    for (const pair of section.split("endbfchar")[0].match(new RegExp(HEX_PAIR.source, "g")) ?? []) {
      const [, code, value] = HEX_PAIR.exec(pair);
      map.set(Number.parseInt(code, 16), fromHex(value));
    }
  }
  for (const section of cmap.split("beginbfrange").slice(1)) {
    for (const row of section.split("endbfrange")[0].match(new RegExp(HEX_TRIPLE.source, "g")) ?? []) {
      const [, low, high, value] = HEX_TRIPLE.exec(row);
      const from = Number.parseInt(low, 16);
      const to = Number.parseInt(high, 16);
      const base = Number.parseInt(value, 16);
      // Bounded: a corrupt range saying 0000–FFFF must not build 65,536 entries
      // per font on a file nobody asked to be slow.
      for (let code = from; code <= to && code - from < 4096; code++) {
        map.set(code, String.fromCharCode(base + (code - from)));
      }
    }
  }
  return map;
}

/**
 * Every font named in the file's resource dictionaries, with its ToUnicode
 * table.
 *
 * Keyed by the RESOURCE name (`/F1`) because that is what the content stream
 * selects with `Tf`. Where two pages give the same name to different fonts the
 * tables are merged, first one winning: imperfect, and far better than decoding
 * with no table at all. A document whose fonts carry no ToUnicode cannot be
 * decoded by anyone without the font program itself, and says so below.
 */
function fontsByName(text, skeleton, objects) {
  const fonts = new Map();
  const dictionaries = /\/Font\s*<<([\s\S]{0,4000}?)>>/g;
  const reference = /\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/;
  let dictionary;
  while ((dictionary = dictionaries.exec(skeleton))) {
    for (const entry of dictionary[1].match(new RegExp(reference.source, "g")) ?? []) {
      const [, name, number] = reference.exec(entry);
      const font = objects.get(Number(number));
      if (!font) continue;
      const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(skeleton.slice(font.start, font.end));
      if (!toUnicode) continue;
      const cmap = streamIn(text, objects.get(Number(toUnicode[1])));
      if (!cmap) continue;
      const parsed = parseToUnicode(cmap);
      const known = fonts.get(name);
      if (!known) fonts.set(name, parsed);
      else for (const [code, value] of parsed) if (!known.has(code)) known.set(code, value);
    }
  }
  return fonts;
}

const ESCAPE = /\\([nrtbf()\\]|[0-7]{1,3})/g;

function decodePdfString(raw) {
  return raw.replace(ESCAPE, (whole, escape) => {
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[escape];
    return simple === undefined ? String.fromCharCode(Number.parseInt(escape, 8)) : simple;
  });
}

/**
 * One content stream, read left to right.
 *
 * A single pass, because the alternative is a regex with nested quantifiers and
 * that is what used to hang. It tracks only what is needed to read words in the
 * right order: which font is selected, and where a line ends.
 */
function readContentStream(chunk, fonts) {
  const lines = [];
  let line = "";
  let font = null;
  const endLine = () => {
    const text = line.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    line = "";
  };

  for (let at = 0; at < chunk.length; at++) {
    const character = chunk[at];

    if (character === "(") {
      let depth = 1;
      let cursor = at + 1;
      let raw = "";
      while (cursor < chunk.length && depth > 0) {
        const next = chunk[cursor];
        if (next === "\\") { raw += next + (chunk[cursor + 1] ?? ""); cursor += 2; continue; }
        if (next === "(") depth++;
        else if (next === ")") { depth--; if (depth === 0) break; }
        raw += next;
        cursor++;
      }
      if (depth === 0) { line += decodePdfString(raw); at = cursor; }
      continue;
    }

    // `<...>` is a hex string; `<<` opens a dictionary and is not one.
    if (character === "<" && chunk[at + 1] !== "<") {
      const close = chunk.indexOf(">", at);
      if (close === -1) continue;
      const hex = chunk.slice(at + 1, close).replace(/[^0-9A-Fa-f]/g, "");
      at = close;
      const table = font ? fonts.get(font) : null;
      if (table) {
        // Identity-H: two bytes per glyph, and the table says which character.
        for (let cursor = 0; cursor + 4 <= hex.length; cursor += 4) {
          line += table.get(Number.parseInt(hex.slice(cursor, cursor + 4), 16)) ?? "";
        }
      } else {
        // No table for this font. One byte per character is the common simple
        // encoding; anything that is not printable is dropped rather than
        // guessed at, because a guess here is mojibake in the answer.
        for (let cursor = 0; cursor + 2 <= hex.length; cursor += 2) {
          const byte = Number.parseInt(hex.slice(cursor, cursor + 2), 16);
          if (byte >= 32 && byte < 127) line += String.fromCharCode(byte);
        }
      }
      continue;
    }

    if (character === "/") {
      const selected = /^\/([A-Za-z0-9]+)\s+[\d.-]+\s+Tf/.exec(chunk.slice(at, at + 48));
      if (selected) font = selected[1];
      continue;
    }

    // A newline in a PDF is a positioning operator, not a character: Td, TD, T*
    // and Tm all move the cursor, and ET ends the text object.
    if (character === "T" && "dD*m".includes(chunk[at + 1])) endLine();
    else if (character === "E" && chunk[at + 1] === "T") endLine();
  }
  endLine();
  return lines.join("\n");
}

function readPdf(buffer) {
  const text = buffer.toString("latin1");
  const skeleton = blankStreams(text);
  const objects = indexObjects(skeleton);
  const fonts = fontsByName(text, skeleton, objects);

  const pages = [];
  const streams = /stream\r?\n?([\s\S]*?)endstream/g;
  let stream;
  while ((stream = streams.exec(text))) {
    const body = inflateOrRaw(stream[1]);
    // A font, an image or an ICC profile. Skipping these is the whole first
    // defect: they are the streams that produced the mojibake.
    if (!looksTextual(body)) continue;
    if (!/\bBT\b/.test(body)) continue;
    const page = readContentStream(body, fonts);
    if (page) pages.push(page);
  }
  return pages.join("\n");
}

// ---- The one entry point -----------------------------------------------------

const EXTENSION = /\.([a-z0-9]+)$/i;

export function isDocumentPath(filePath) {
  const extension = EXTENSION.exec(String(filePath ?? ""))?.[1]?.toLowerCase();
  return ["docx", "xlsx", "pptx", "pdf"].includes(extension);
}

/**
 * Pull the readable text out of a document.
 *
 * @returns {{format: string, text: string, reason?: string}}
 *   `text` empty with a `reason` when there is genuinely nothing to read — which
 *   is a different answer from "the file is broken", and the caller says so.
 */
export function extractDocumentText(filePath, buffer) {
  const format = EXTENSION.exec(String(filePath ?? ""))?.[1]?.toLowerCase() ?? "";
  if (format === "pdf") {
    const text = readPdf(buffer);
    if (!text.trim()) {
      return {
        format,
        text: "",
        reason: "this PDF has no extractable text — it is almost certainly a scan, " +
          "a photograph of a page, or it stores its text in a way this cannot read"
      };
    }
    // THE BACKSTOP, AND THE REASON IT EXISTS. Everything above is careful about
    // which streams it reads, and a PDF nobody has thought of yet will get past
    // all of it. Mojibake handed over as text is the worst of the three possible
    // answers: the reader cannot tell it from a badly written document, and the
    // agent spends its budget trying to make sense of noise. Refusing is
    // recoverable — the file is still on the machine and can be opened.
    if (!looksTextual(text)) {
      return {
        format,
        text: "",
        reason: "the text in this PDF could not be decoded — its fonts carry no readable " +
          "character map, so what came out was not text"
      };
    }
    return { format, text };
  }

  const entries = readZipEntries(buffer);
  if (!entries) {
    return { format, text: "", reason: `this does not look like a ${format} file — its archive could not be read` };
  }
  const text = format === "docx" ? readDocx(entries)
    : format === "xlsx" ? readXlsx(entries)
      : format === "pptx" ? readPptx(entries)
        : null;
  if (text === null) {
    return { format, text: "", reason: `this ${format} file does not contain the part that holds its text` };
  }
  return text.trim()
    ? { format, text }
    : { format, text: "", reason: `this ${format} file is empty` };
}
