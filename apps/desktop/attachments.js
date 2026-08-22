// FILES THE USER ATTACHES, TURNED INTO SOMETHING A MODEL CAN ACTUALLY READ.
//
// A PDF is not text. The agent proved this the hard way: asked to read a resume
// it called `read_file` on the .pdf, got the raw deflate stream back —
// "PTZgi*HUµÏ[­­vtuwy|£®°" for forty-six thousand characters — and had to go
// hunting for `pdftotext` on the machine to recover. That is the model doing
// work the surface should have done before the request was ever sent.
//
// So: a document is extracted HERE, before it goes anywhere, and what travels
// is text. An image is not extracted, because the point of an image is the
// pixels; it travels as data and only to a model that can see.
//
// WHY EXTRACTION IS DONE IN THE PAGE
//
// The alternative is uploading the bytes and extracting server-side, which
// means a file endpoint, a temp directory, and a cleanup story for documents
// that may be somebody's payslip. Extracting here means the bytes never leave
// the machine and only the text the user is already asking about is sent.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Enough for a long report, bounded so one attachment cannot fill the model's
// context and push the actual question out of it.
export const MAX_EXTRACTED_CHARS = 200_000;

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|bmp)$/i;
const TEXTUAL_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|c|cpp|cs|go|rs|rb|php|sh|ps1|sql|log|ini|toml|env)$/i;

export function kindOf(file) {
  if (IMAGE_TYPES.test(file.type)) return "image";
  if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) return "pdf";
  if (/\.(docx?|odt|rtf)$/i.test(file.name)) return "document-binary";
  if (TEXTUAL_EXTENSIONS.test(file.name) || /^text\//i.test(file.type)) return "text";
  return "unknown";
}

const readAsText = (file) => file.text();

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`${file.name} could not be read`));
  reader.onload = () => resolve(String(reader.result));
  reader.readAsDataURL(file);
});

/**
 * Pull readable text out of a PDF without a PDF library.
 *
 * This is deliberately modest and says so. It decompresses nothing: it reads
 * the text-showing operators out of any content stream that is not compressed,
 * which covers PDFs produced by most exporters that do not use object streams.
 * When it finds nothing usable it returns null, and the caller says plainly
 * that the file could not be read here rather than sending forty thousand
 * characters of binary to a model and calling that an attachment.
 */
function extractPdfText(bytes) {
  // latin1 so byte values survive the round trip; the operators being looked
  // for are all ASCII.
  const raw = new TextDecoder("latin1").decode(bytes);
  const out = [];
  // ( ... ) Tj    and    [ (..) -250 (..) ] TJ
  const showText = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]\\]|\\.)*\]\s*TJ/g;
  for (const match of raw.matchAll(showText)) {
    for (const piece of match[0].matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      out.push(
        piece[0]
          .slice(1, -1)
          .replace(/\\([nrtbf])/g, (_, code) => ({ n: "\n", r: "", t: "\t", b: "", f: "\n" }[code] ?? ""))
          .replace(/\\([()\\])/g, "$1")
          .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      );
    }
    out.push(" ");
  }
  const text = out.join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // A handful of stray glyphs is not an extraction. If the file is mostly
  // compressed streams this will find almost nothing, and saying so is the
  // honest outcome.
  return text.length >= 200 ? text : null;
}

/**
 * Prepare one file for sending.
 *
 * Every returned attachment carries `kind`, which is what model routing is
 * decided from — see models.js — and either `text` or `dataUrl`, never both.
 */
export async function prepareAttachment(file) {
  const base = { name: file.name, bytes: file.size, mime: file.type || "application/octet-stream" };
  if (file.size > MAX_FILE_BYTES) {
    return { ...base, kind: "rejected", error: `${file.name} is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_FILE_BYTES / 1048576} MB.` };
  }

  const kind = kindOf(file);

  if (kind === "image") {
    return { ...base, kind: "image", dataUrl: await readAsDataUrl(file) };
  }

  if (kind === "text") {
    const text = (await readAsText(file)).slice(0, MAX_EXTRACTED_CHARS);
    return { ...base, kind: "document", text, extractedBy: "read directly" };
  }

  if (kind === "pdf") {
    const text = extractPdfText(new Uint8Array(await file.arrayBuffer()));
    if (!text) {
      return {
        ...base,
        kind: "rejected",
        error: `${file.name} is a PDF whose text is compressed, so it cannot be read here. ` +
          "Ask SYSCORA to open the file from your machine instead — it can use a PDF tool that is installed."
      };
    }
    return { ...base, kind: "document", text: text.slice(0, MAX_EXTRACTED_CHARS), extractedBy: "extracted from the PDF" };
  }

  if (kind === "document-binary") {
    return {
      ...base,
      kind: "rejected",
      error: `${file.name} is a Word document, which cannot be read in the browser. ` +
        "Ask SYSCORA to open it from your machine — it can read it there."
    };
  }

  return { ...base, kind: "rejected", error: `${file.name} is not a file type this can read.` };
}

/**
 * The text block appended to the user's message for document attachments.
 *
 * Fenced and labelled so the model can tell the user's own words from the
 * file's contents. That boundary is the same one content-boundary.js enforces
 * on the way in: what was READ is not what was ASKED.
 */
export function describeAttachments(attachments) {
  const documents = attachments.filter((file) => file.kind === "document" && file.text);
  if (!documents.length) return "";
  return documents
    .map((file) => `\n\n--- Attached file: ${file.name} (${file.extractedBy}) ---\n${file.text}\n--- end of ${file.name} ---`)
    .join("");
}
