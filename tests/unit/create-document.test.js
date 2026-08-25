// A DOCUMENT COST THIRTEEN TOOL CALLS BECAUSE THERE WAS NO VERB FOR IT.
//
// Measured live, 25 Aug 2026: "create a pdf file properly formatted, write an
// essay about how to make an aircraft from scratch" — 219.7 seconds, 14 steps,
// 13 tool calls, 227,584 tokens. Eleven of those calls were about a toolchain
// rather than an essay: probe for Python, probe for reportlab, probe for fpdf,
// `pip install reportlab`, write a Python SCRIPT with the essay inside it, run
// it, stat the output, fail to read the PDF, dump its header bytes, try
// `open_url` on a local path, Start-Process, list the windows, Start-Process
// again, and finally OCR Microsoft Edge to check the words were there.
//
// Every one of those is a reasonable move for a model with no tool for the job.
// So this file holds the tool to the two things that make it worth having:
//
//   1. ONE CALL. It writes the file itself, in-process, with no interpreter, no
//      package manager and no application — and it verifies the result down a
//      code path that has never heard of the writer, so there is nothing left
//      for the model to go and check afterwards.
//   2. SOMETHING TO CLICK, in a folder people already look in.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { DOCUMENT_FORMATS, makeDocument, parseBlocks, tabulate } from "../../packages/fast-agent/src/make-document.js";
import { extractDocumentText } from "../../packages/fast-agent/src/documents.js";
import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { CONFIRMED } from "../../packages/fast-agent/src/evidence.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SAMPLE = [
  "## Why it is hard",
  "",
  "Building an aircraft means **four** problems at once, and each one *constrains*",
  "the others. Don't skip the load calculations.",
  "",
  "1. Define the mission",
  "2. Size the wing",
  "3. Pick a construction method",
  "",
  "- Wood and fabric is cheap",
  "- Aluminium is the default",
  "",
  "```text",
  "L = 0.5 * rho * V^2 * S * CL",
  "```",
  "",
  "| Material | Weight | Cost |",
  "|---|---|---|",
  "| Spruce | Low | 1200 |",
  "| 6061-T6 | Medium | 3400 |"
].join("\n");

/**
 * One member of an OOXML archive, by name. A .xlsx is a ZIP, so an assertion
 * about the sheet XML has to open it — searching the compressed bytes for a tag
 * finds nothing and passes for the wrong reason, which is how this test first
 * "failed": the writer was correct and the assertion was reading deflate output.
 */
function memberOf(buffer, name) {
  const target = Buffer.from(name, "utf8");
  for (let at = 0; at < buffer.length - 30; at += 1) {
    if (buffer.readUInt32LE(at) !== 0x04034b50) continue;
    const method = buffer.readUInt16LE(at + 8);
    const compressed = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    if (!buffer.subarray(at + 30, at + 30 + nameLength).equals(target)) continue;
    const start = at + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    return (method === 0 ? body : zlib.inflateRawSync(body)).toString("utf8");
  }
  throw new Error(`${name} is not in the archive`);
}

let root = null;
test.before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-makedoc-")); });
test.after(async () => { if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });

// ---- the file is a real file --------------------------------------------

// THE CENTRAL CLAIM, AND IT IS CHECKED THE WAY CLAUDE.md DEMANDS: documents.js
// was written to parse OTHER PEOPLE'S Word files, spreadsheets and PDFs. It has
// never heard of make-document.js. A file this writer believes it produced and
// that parser cannot read is not a document, whatever the writer thinks.
for (const format of ["pdf", "docx", "xlsx"]) {
  test(`a .${format} is readable by a parser that knows nothing about the writer`, async () => {
    const file = path.join(root, `round-trip.${format}`);
    await fs.writeFile(file, makeDocument({ format, title: "Round trip", content: SAMPLE }).buffer);
    const extracted = extractDocumentText(file, await fs.readFile(file));
    assert.ok(extracted.text, `nothing could be read back out of the .${format}: ${extracted.reason}`);
    // A word from the middle, not the first line: a container that opens and is
    // then empty would still pass on a title alone.
    assert.match(extracted.text, /Spruce/, `the .${format} does not contain its own table`);
  });
}

test("the words of the document survive into a PDF, not just its shape", () => {
  const { buffer } = makeDocument({ format: "pdf", title: "T", content: SAMPLE });
  const extracted = extractDocumentText("x.pdf", buffer);
  for (const phrase of ["Building an aircraft means", "Define the mission", "Aluminium is the default"]) {
    assert.ok(extracted.text.includes(phrase), `"${phrase}" is not in the PDF:\n${extracted.text}`);
  }
});

// ONE OPERATOR PER STYLE, NOT ONE PER WORD.
//
// The first version drew every word at its own position, which LOOKED correct
// and extracted as "Building\nan\nAircraft\nfrom\nScratch" — because a new
// positioning operator is what a new line means in a PDF. Search inside the file
// found no phrase, copy-and-paste gave a column of words, and the read-back that
// is supposed to confirm the document was checking something unrecognisable.
test("a PDF sentence is one run of text, not one operator per word", () => {
  const { buffer } = makeDocument({ format: "pdf", content: "The quick brown fox jumps over the lazy dog." });
  assert.match(buffer.toString("latin1"), /\(The quick brown fox jumps over the lazy dog\.\) Tj/);
});

test("a heading, bold and italic each reach the page as their own font", () => {
  const pdf = makeDocument({ format: "pdf", content: "# Head\n\nplain **bold** and *italic* words" })
    .buffer.toString("latin1");
  assert.match(pdf, /\/F2 [\d.]+ Tf[^(]*\(bold\)/, "bold did not switch to Helvetica-Bold");
  assert.match(pdf, /\/F3 [\d.]+ Tf[^(]*\(italic\)/, "italic did not switch to Helvetica-Oblique");
});

// Seen in a rendered PDF, not in the source: every bullet in every list was a
// hyphen, because the encoding was assumed to have no bullet. WinAnsi has one,
// at 0x95, and the same block holds the curly quotes and dashes a model writes
// constantly.
test("a bullet is the WinAnsi bullet, and a curly quote survives as a curly quote", () => {
  const byte = (code) => String.fromCharCode(code);
  const pdf = makeDocument({
    format: "pdf",
    content: ["- one", "", "It’s fine — really…"].join("\n")
  }).buffer.toString("latin1");
  assert.ok(pdf.includes(byte(0x95)), "the bullet was degraded instead of using WinAnsi 0x95");
  assert.ok(pdf.includes(`It${byte(0x92)}s`), "a right single quote did not become WinAnsi 0x92");
  assert.ok(pdf.includes(byte(0x97)), "an em dash did not become WinAnsi 0x97");
  assert.ok(pdf.includes(byte(0x85)), "an ellipsis did not become WinAnsi 0x85");
});

test("a long document paginates, and every page is numbered", () => {
  const long = Array.from({ length: 40 }, (_, index) =>
    `## Section ${index + 1}\n\nA paragraph of ordinary prose that runs on for long enough to occupy several lines of an A4 page once it has been wrapped at eleven point.`).join("\n\n");
  const { buffer, pages } = makeDocument({ format: "pdf", title: "Long", content: long });
  assert.ok(pages > 2, `40 sections fitted on ${pages} page(s), so nothing is being paginated`);
  assert.equal((buffer.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length, pages);
  for (let number = 1; number <= pages; number += 1) {
    assert.ok(buffer.toString("latin1").includes(`(${number}) Tj`), `page ${number} has no page number`);
  }
});

// A wrapped line that overhangs the margin is the one layout failure a reader
// notices immediately, and it cannot be seen from the text extraction.
test("nothing is drawn outside the page margins", () => {
  const { buffer } = makeDocument({
    format: "pdf",
    title: "Margins",
    content: "Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis " +
      "and then a great many ordinary words after it to force several wraps in a row.\n\n- a bulleted item that is itself long enough to wrap onto a second line of the page"
  });
  const A4_WIDTH = 595.28;
  const MARGIN = 56;
  const placements = [...buffer.toString("latin1").matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)];
  assert.ok(placements.length > 5, "no text was placed at all");
  for (const [, x, y] of placements) {
    assert.ok(Number(x) >= MARGIN - 20, `text starts at x=${x}, left of the margin`);
    assert.ok(Number(x) <= A4_WIDTH - MARGIN, `text starts at x=${x}, past the right margin`);
    assert.ok(Number(y) > 0, `text placed at y=${y}, off the bottom of the page`);
  }
});

// A .docx is a ZIP of XML, and one control character anywhere in it makes Word
// declare the whole file corrupt and offer to repair it — which is what the user
// sees, not a stack trace.
test("a control character in the content cannot make Word refuse the file", () => {
  const nasty = `Before${String.fromCharCode(7)}after and a ${String.fromCharCode(0)} null`;
  const { buffer } = makeDocument({ format: "docx", content: nasty });
  const text = extractDocumentText("x.docx", buffer).text;
  assert.match(text, /Beforeafter/, "the surrounding text was lost along with the control character");
  // Built from codes rather than written as a literal class: a source file with
  // raw control bytes in it is one git treats as binary.
  const CONTROL = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F]");
  assert.ok(!CONTROL.test(text), "a control character reached the document XML");
});

test("XML metacharacters in the text stay text", () => {
  const { buffer } = makeDocument({ format: "docx", content: 'A <w:p> & an "attribute" walk into a bar' });
  assert.match(extractDocumentText("x.docx", buffer).text, /A <w:p> & an "attribute"/);
});

// ---- spreadsheets ----------------------------------------------------------

test("a markdown table becomes the rows of a spreadsheet", () => {
  const rows = tabulate(SAMPLE, parseBlocks(SAMPLE));
  assert.deepEqual(rows[0], ["Material", "Weight", "Cost"]);
  assert.deepEqual(rows[1], ["Spruce", "Low", "1200"]);
});

test("a number in a spreadsheet is a number, or the user's first SUM returns zero", () => {
  const xml = memberOf(makeDocument({ format: "xlsx", content: "| Item | Cost |\n|---|---|\n| Spruce | 1200 |" }).buffer,
    "xl/worksheets/sheet1.xml");
  // A value, not an inline string. Excel adds up the first and ignores the second.
  assert.match(xml, /<v>1200<\/v>/, "1200 was written as text, so it cannot be added up");
  assert.match(xml, /t="inlineStr"[^>]*><is><t[^>]*>Spruce/, "a word was written as a number");
});

test("a leading zero and a date-like code stay text, because they are not numbers", () => {
  const rows = tabulate("id,code\n007,1-2", parseBlocks("id,code\n007,1-2"));
  assert.deepEqual(rows[1], ["007", "1-2"]);
  const xml = makeDocument({ format: "xlsx", content: "id,code\n007,1-2" }).buffer.toString("latin1");
  assert.ok(!xml.includes("<v>7</v>"), '"007" was turned into the number 7');
});

test("a comma inside a quoted CSV cell does not shift every column after it", () => {
  const rows = tabulate('name,note\n"Smith, John",fine', parseBlocks('name,note\n"Smith, John",fine'));
  assert.deepEqual(rows[1], ["Smith, John", "fine"]);
});

// ---- the formats it will not pretend to write ------------------------------

test("a format this cannot honestly produce is refused, by name", () => {
  assert.throws(() => makeDocument({ format: "pptx", content: "x" }), /Cannot build a .pptx/);
  // The refusal has to say what IS available or the model has nothing to do next.
  try { makeDocument({ format: "pptx", content: "x" }); } catch (error) {
    for (const format of DOCUMENT_FORMATS) assert.ok(error.message.includes(`.${format}`), `the refusal never mentions .${format}`);
  }
});

test("plain text does not carry markdown syntax the reader did not ask for", () => {
  const text = makeDocument({ format: "txt", title: "Notes", content: "## Head\n\nsome **bold** words\n\n- a point" })
    .buffer.toString("utf8");
  assert.ok(!text.includes("**"), `asterisks survived into a .txt:\n${text}`);
  assert.match(text, /HEAD/);
  assert.match(text, /- a point/);
});

// ---- the tool ---------------------------------------------------------------

function toolsetIn(directory) {
  return buildToolset({
    registry: { execute: async () => ({}) },
    adapter: { getDownloadsPath: () => directory },
    basePath: directory
  });
}

test("one call writes the file, and the receipt comes from reading it back", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tool-"));
  const toolset = toolsetIn(directory);
  const outcome = await toolset.execute("create_document", {
    filename: "Aircraft essay", format: "pdf", title: "Aircraft essay", content: SAMPLE, folder: directory
  });
  assert.equal(outcome.raw.evidence.verdict, CONFIRMED);
  // NOT `create_document`. The receipt names what actually did the reading, and
  // the whole point is that it was not this tool.
  assert.equal(outcome.raw.evidence.method, "document.extract");
  assert.equal(outcome.raw.evidence.actedVia, "create_document");
  assert.ok(outcome.raw.words > 20, "the read-back found almost no words in the file it just wrote");
  assert.ok((await fs.stat(outcome.raw.filePath)).size > 0);
  await fs.rm(directory, { recursive: true, force: true });
});

// The measured run spent its last five tool calls and most of its tokens proving
// something the read-back had already settled: it opened the PDF, listed the
// windows, opened it again, and OCR'd a browser. The result is where that gets
// stopped, because it is read at the moment it matters and costs nothing on the
// steps that never make a document.
test("the result tells the model the job is finished and not to go looking at it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tool-"));
  const outcome = await toolsetIn(directory).execute("create_document", {
    filename: "Done", format: "pdf", content: "A paragraph.", folder: directory
  });
  assert.match(outcome.text, /THIS STEP IS FINISHED/);
  assert.match(outcome.text, /do NOT open it/);
  assert.match(outcome.text, /do NOT read the screen/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("a second document of the same name does not overwrite the first", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tool-"));
  const toolset = toolsetIn(directory);
  const first = await toolset.execute("create_document", { filename: "Report", format: "txt", content: "one", folder: directory });
  const second = await toolset.execute("create_document", { filename: "Report", format: "txt", content: "two", folder: directory });
  assert.notEqual(first.raw.filePath, second.raw.filePath);
  assert.match(second.raw.uiCard.name, /Report \(2\)\.txt/);
  assert.match(await fs.readFile(first.raw.filePath, "utf8"), /one/, "the first document was overwritten");
  await fs.rm(directory, { recursive: true, force: true });
});

// The user's own answer to "where should these go", 25 Aug 2026: "the files
// should by default be stored in downloads unless the user specifies a specific
// location". Downloads is also where every other program on this machine puts a
// file it made for you.
test("with no folder given the document goes to Downloads", async () => {
  const downloads = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-downloads-"));
  // The adapter's Downloads, which is the fallback used when the machine profile
  // has not resolved yet — the case a first-turn request actually hits. The
  // profile is preferred when it is there; both point at the same folder on a
  // real machine, and this proves the file does not land in the daemon's own
  // working directory either way.
  const outcome = await buildToolset({
    registry: { execute: async () => ({}) },
    adapter: { getDownloadsPath: () => downloads },
    basePath: path.join(downloads, "not-here")
  }).execute("create_document", { filename: "Loose", format: "txt", content: "x" });
  assert.equal(path.dirname(outcome.raw.filePath), downloads);
  await fs.rm(downloads, { recursive: true, force: true });
});

test("a filename with characters Windows will not accept is cleaned, not failed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tool-"));
  const outcome = await toolsetIn(directory).execute("create_document", {
    filename: 'Q4: profit/loss <draft>?', format: "txt", content: "x", folder: directory
  });
  assert.ok(!/[<>:"/\\|?*]/.test(path.basename(outcome.raw.filePath).replace(/\.txt$/, "")));
  assert.ok((await fs.stat(outcome.raw.filePath)).size > 0);
  await fs.rm(directory, { recursive: true, force: true });
});

test("the card carries what is IN the document, not just how big it is", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-tool-"));
  const { raw } = await toolsetIn(directory).execute("create_document", {
    filename: "Card", format: "pdf", title: "Card", content: SAMPLE, folder: directory
  });
  assert.equal(raw.uiCard.kind, "file");
  assert.equal(raw.uiCard.format, "pdf");
  assert.ok(raw.uiCard.pages >= 1);
  assert.ok(raw.uiCard.words > 20);
  assert.equal(raw.uiCard.name, path.basename(raw.filePath));
  await fs.rm(directory, { recursive: true, force: true });
});

// ---- the card, and the route behind its buttons -----------------------------
//
// Static source checks, in the shape desktop-chrome.test.js uses and for the
// same reason: the tool that emits the card, the surface that draws it and the
// daemon route its buttons call are three files edited independently, and when
// they drift the control is simply dead — which is exactly how the one-click
// suggestions broke.

const source = (relative) => fsSync.readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

test("the card the tool emits is the card the surface draws", () => {
  assert.match(source("apps/desktop/demo.js"), /d\.card\?\.kind === "file"/,
    "create_document emits a file card and nothing on the surface listens for it");
  assert.match(source("apps/desktop/demo.js"), /turn\.append\(fileCard\(d\.card\)\)/);
  assert.match(source("apps/desktop/demo.css"), /\.file-card \{/,
    "the card has no style of its own");
});

// THE BUTTONS ARE NOT A LICENCE TO OPEN FILES.
//
// A route that opens "the path in the request" opens any file on the machine,
// and the page calling it renders text the agent read out of web pages,
// documents and messages. So the same boundary the Send button has: the daemon
// opens a path it has seen a tool report creating, or nothing. Verified live
// against a running daemon on 25 Aug 2026 — an authorised POST for
// C:\Windows\System32\calc.exe came back 403 "That file was not created here".
test("the daemon will only open a file it watched a tool create", () => {
  const server = source("apps/daemon/src/server.js");
  assert.match(server, /const openableFiles = new Set\(\)/);
  assert.match(server, /card\?\.kind === "file"/, "nothing fills the set, so nothing can ever be opened");
  assert.match(server, /if \(!openableFiles\.has\(wanted\.toLowerCase\(\)\)\)/,
    "the open route does not check the path against what this daemon actually made");
  // `start` is a cmd.exe builtin, so it needs a shell, and a shell needs the
  // path quoted — which is how a filename with an ampersand in it becomes a
  // command. explorer.exe takes the path as one argument with no shell.
  assert.ok(!/spawn\("cmd"|exec\(`start/.test(server), "the open route reaches a shell");
  assert.match(server, /spawn\("explorer\.exe"/);
});

test("a file card replayed from a saved chat does not offer a button that will be refused", () => {
  assert.match(source("apps/desktop/demo.js"), /sealReplayedFile\(card\)/,
    "an old chat's cards keep live Open buttons for files this daemon never made");
});

// The prompt line and the tool description are the two things that decide
// whether the model reaches for this at all — and the measured failure was the
// prompt actively pointing the other way ("the terminal is almost always
// fastest… files… use `run`").
test("the prompt sends a document request here rather than to the terminal", () => {
  const prompt = source("packages/fast-agent/src/index.js");
  // A plain substring, not a pattern: the prompt is a template literal, so the
  // backticks around the tool name are escaped in the source and a regex here
  // has to agree with that escaping as well as with the sentence.
  assert.ok(prompt.includes("MAKING A DOCUMENT IS \\`create_document\\`, NOT THE TERMINAL"),
    "the prompt no longer names the tool, and the line above it still points every file request at `run`");
  for (const wrongTurn of ["Python", "install a library", "script that writes a file", "read the screen"]) {
    assert.ok(prompt.includes(wrongTurn), `the prompt does not rule out "${wrongTurn}", which the measured run did`);
  }
});
