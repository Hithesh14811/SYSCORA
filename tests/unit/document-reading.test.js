import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { extractDocumentText, isDocumentPath } from "../../packages/fast-agent/src/documents.js";

// A real ZIP, written here rather than checked in as a fixture, so the reader is
// tested against the format itself instead of against a file produced by the
// same assumptions it makes.
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, contentText] of Object.entries(files)) {
    const content = Buffer.from(contentText, "utf8");
    const deflated = zlib.deflateRawSync(content);
    const nameBuffer = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + deflated.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

test("only the formats that need unpacking take the document route", () => {
  for (const name of ["report.docx", "budget.XLSX", "deck.pptx", "statement.pdf"]) {
    assert.equal(isDocumentPath(name), true, `${name} is a document`);
  }
  for (const name of ["notes.txt", "index.js", "data.csv", "photo.png", "noextension"]) {
    assert.equal(isDocumentPath(name), false, `${name} is not`);
  }
});

// A Word document arrives as one run per formatting change, so a bolded word is
// its own element. Joined without regard to paragraphs it is one endless line;
// split per run it is one word per line. Neither is the document.
test("a Word document comes back as its paragraphs", () => {
  const docx = zip({
    "word/document.xml":
      "<w:document><w:body>" +
      "<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Revenue rose </w:t></w:r><w:r><w:t>12%</w:t></w:r><w:r><w:t> on last year.</w:t></w:r></w:p>" +
      "</w:body></w:document>"
  });
  const read = extractDocumentText("report.docx", docx);
  assert.equal(read.format, "docx");
  assert.equal(read.text, "Quarterly report\nRevenue rose 12% on last year.");
});

// Cell text lives once in a shared table and the sheet points at it by index, so
// a sheet read on its own is a grid of integers where the words should be.
test("a spreadsheet resolves its shared strings", () => {
  const xlsx = zip({
    "xl/sharedStrings.xml": "<sst><si><t>Rent</t></si><si><t>Food</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>18000</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>6400</v></c></row>' +
      "</sheetData></worksheet>"
  });
  const read = extractDocumentText("budget.xlsx", xlsx);
  assert.match(read.text, /A: Rent \| B: 18000/);
  assert.match(read.text, /A: Food \| B: 6400/);
});

test("a deck comes back slide by slide, in order", () => {
  const pptx = zip({
    "ppt/slides/slide2.xml": "<p:sld><a:t>Results</a:t></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:t>Title slide</a:t><a:t>by Hithesh</a:t></p:sld>"
  });
  const read = extractDocumentText("deck.pptx", pptx);
  assert.match(read.text, /--- Slide 1 ---\nTitle slide\nby Hithesh/);
  assert.match(read.text, /--- Slide 2 ---\nResults/);
  assert.ok(read.text.indexOf("Slide 1") < read.text.indexOf("Slide 2"), "slides must be in their own order, not the archive's");
});

test("text in a PDF is found whether or not the stream is compressed", () => {
  const page = "BT /F1 12 Tf 72 720 Td (Statement of account) Tj ET\n" +
    "BT /F1 12 Tf 72 700 Td (Closing balance 4,210.55) Tj ET";
  const uncompressed = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${page.length} >>\nstream\n${page}\nendstream\nendobj\n`, "latin1");
  const plain = extractDocumentText("statement.pdf", uncompressed);
  assert.match(plain.text, /Statement of account/);
  assert.match(plain.text, /Closing balance 4,210\.55/);

  const deflated = zlib.deflateSync(Buffer.from(page, "latin1"));
  const compressed = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
    deflated,
    Buffer.from("\nendstream\nendobj\n", "latin1")
  ]);
  assert.match(extractDocumentText("statement.pdf", compressed).text, /Statement of account/);
});

// EVERYTHING WORD, CANVA AND GOOGLE DOCS EXPORT LOOKS LIKE THIS.
//
// `/Encoding /Identity-H` puts glyph indices in the content stream — `<002C>`
// where an `H` belongs — and the only way back is the font's `/ToUnicode` CMap.
// A resume of exactly this shape was handed to the composer and came back as
// 52,220 characters of binary, because the reader understood only `(literal)`
// strings and scanned the embedded font programs looking for them.
//
// The font stream here is deliberately the kind that used to poison the output:
// it inflates perfectly, it contains `BT`, and it is full of brackets.
test("a PDF that encodes its text as glyph indices is read through the font's map", () => {
  const cmap =
    "/CIDInit /ProcSet findresource begin begincmap\n" +
    "1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
    "4 beginbfchar\n<0003> <0020>\n<002C> <0048>\n<002F> <0049>\n<0064> <0054>\nendbfchar\n" +
    "endcmap end";
  const content = "BT\n/F1 12 Tf\n1 0 0 -1 72 720 Tm\n[<002C>-0.85<002F>-0.60<0064>2.0<0003><002C>] TJ\nET";
  const fontProgram = Buffer.concat([
    Buffer.from("BT (", "latin1"),
    Buffer.from(Array.from({ length: 400 }, (unused, at) => (at * 37) % 256)),
    Buffer.from(") Tj ET", "latin1")
  ]);

  const parts = [];
  const push = (chunk) => parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1"));
  push("%PDF-1.7\n");
  push("3 0 obj\n<< /Type /Page /Resources 4 0 R /Contents 7 0 R >>\nendobj\n");
  push("4 0 obj\n<< /Font <<\n/F1 5 0 R\n>> >>\nendobj\n");
  push("5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>\nendobj\n");
  push(`6 0 obj\n<< /Length ${cmap.length} >>\nstream\n`);
  push(cmap);
  push("\nendstream\nendobj\n");
  // The font program, carrying an object header inside its bytes — which is how
  // the real file overwrote object 5 and lost every font lookup after it.
  push("8 0 obj\n<< /Length1 400 >>\nstream\n");
  push(Buffer.from("5 0 obj rubbish ", "latin1"));
  push(zlib.deflateSync(fontProgram));
  push("\nendstream\nendobj\n");
  push(`7 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  push(content);
  push("\nendstream\nendobj\n");

  const read = extractDocumentText("resume.pdf", Buffer.concat(parts));
  assert.equal(read.format, "pdf");
  assert.equal(read.text, "HIT H", "the glyph indices must come back as the characters their ToUnicode map names");
  assert.ok(!/[^\x09\x0A\x0D\x20-\x7E]/.test(read.text), `nothing unprintable may reach the caller: ${JSON.stringify(read.text)}`);
});

// The honesty backstop. Whatever gets past the stream filtering, mojibake must
// never be handed over as though it were the document: a refusal can be
// recovered from, and text that is not text cannot.
test("a PDF whose text cannot be decoded is refused rather than returned as noise", () => {
  const noise = Buffer.concat([
    Buffer.from("BT /F9 12 Tf 72 720 Td (", "latin1"),
    Buffer.from(Array.from({ length: 600 }, (unused, at) => 128 + (at % 120))),
    Buffer.from(") Tj ET", "latin1")
  ]);
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${noise.length} >>\nstream\n`, "latin1"),
    noise,
    Buffer.from("\nendstream\nendobj\n", "latin1")
  ]);
  const read = extractDocumentText("scanned.pdf", pdf);
  assert.equal(read.text, "");
  assert.match(read.reason, /scan|could not be decoded/i);
});

// A scan is a photograph of a page. Returning empty space for one would read as
// an empty document, which is a different and much worse answer than "there is
// no text in here to read".
test("a document with nothing readable says which of the two it is", () => {
  const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image >>\nendobj\n", "latin1");
  const read = extractDocumentText("scan.pdf", scan);
  assert.equal(read.text, "");
  assert.match(read.reason, /scan|photograph/i);

  const broken = extractDocumentText("report.docx", Buffer.from("this is not a zip at all"));
  assert.equal(broken.text, "");
  assert.match(broken.reason, /archive could not be read/);
});
