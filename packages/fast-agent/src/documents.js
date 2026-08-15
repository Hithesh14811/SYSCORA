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

// The text-showing operators. `Tj` and `'` take one string; `TJ` takes an array
// of strings and kerning numbers, which is why a line of a PDF is usually a
// dozen fragments rather than a sentence.
const PDF_STRING = /\((?:\\.|[^\\()])*\)/g;

function decodePdfString(raw) {
  return raw
    .slice(1, -1)
    .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (whole, escape) => {
      const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[escape];
      if (simple !== undefined) return simple;
      return String.fromCharCode(Number.parseInt(escape, 8));
    });
}

function readPdf(buffer) {
  // Page content is normally one deflate stream per page. Uncompressed PDFs
  // exist too, so the raw bytes are searched as well.
  const chunks = [];
  const text = buffer.toString("latin1");
  const streamPattern = /stream\r?\n?([\s\S]*?)endstream/g;
  let match = streamPattern.exec(text);
  while (match) {
    const body = Buffer.from(match[1], "latin1");
    try {
      chunks.push(zlib.inflateSync(body).toString("latin1"));
    } catch {
      // Not deflated, or deflated with something else. If it happens to be
      // readable content it is picked up by the raw pass below.
      chunks.push(match[1]);
    }
    match = streamPattern.exec(text);
  }

  const lines = [];
  for (const chunk of chunks) {
    // Only inside a text object; a string elsewhere is a name or a bookmark.
    for (const block of chunk.split(/\bBT\b/).slice(1)) {
      const body = block.split(/\bET\b/)[0];
      const pieces = (body.match(PDF_STRING) ?? []).map(decodePdfString);
      if (pieces.length === 0) continue;
      // A newline in a PDF is a positioning operator, not a character.
      const line = pieces.join("").replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
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
    return text.trim()
      ? { format, text }
      : {
          format,
          text: "",
          reason: "this PDF has no extractable text — it is almost certainly a scan, " +
            "a photograph of a page, or it stores its text in a way this cannot read"
        };
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
