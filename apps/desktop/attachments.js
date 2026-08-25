// FILES THE USER ATTACHES, TURNED INTO SOMETHING A MODEL CAN ACTUALLY READ.
//
// A PDF is not text. The agent proved this the hard way: asked to read a resume
// it called `read_file` on the .pdf, got the raw deflate stream back —
// "PTZgi*HUµÏ[­­vtuwy|£®°" for forty-six thousand characters — and had to go
// hunting for `pdftotext` on the machine to recover. That is the model doing
// work the surface should have done before the request was ever sent.
//
// So: a document is extracted BEFORE it goes anywhere, and what travels is text.
// An image is not extracted, because the point of an image is the pixels.
//
// WHERE THE EXTRACTION HAPPENS, AND WHY IT MOVED.
//
// It used to happen entirely in this file, which meant a hand-written PDF reader
// that could only cope with UNCOMPRESSED content streams — so a PDF from any
// modern exporter was refused — and every Word document was turned away with
// "cannot be read in the browser". Both were true statements about a limitation
// that did not need to exist: documents.js on the daemon side already reads
// .pdf, .docx, .xlsx and .pptx properly, and the agent has been using it on
// files it finds on disk all along. There is now ONE extractor, called from both
// ends, over a loopback endpoint that writes nothing to disk.
//
// A plain text file is still read here. It needs no parser, and not making a
// round trip for it is the difference between instant and not.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Enough for a long report, bounded so one attachment cannot fill the model's
// context and push the actual question out of it.
export const MAX_EXTRACTED_CHARS = 200_000;
// A folder is attached as a LISTING, not as its contents. Somebody's Downloads
// folder has forty thousand files in it and none of them is the question.
//
// THREE HUNDRED WAS STILL FAR TOO MANY, AND THEY WERE THE WRONG THREE HUNDRED.
// Live, 23 Aug 2026: a project folder was attached and "can you see the folder?"
// cost 21,285 input tokens. The folder holds 9,142 files and the listing is
// alphabetical, so what travelled was `.git` object hashes, `.pytest_cache`, and
// two hundred lines of `.venv/Lib/site-packages/_pytest/__pycache__/*.pyc` —
// and then it stopped, having never reached a single file the person wrote. The
// agent's summary was accurate about pytest and knew nothing about the project.
//
// The listing is a MAP, and a map leaves out the scaffolding. What is skipped is
// counted and named, because a listing that quietly omits things reads as
// complete.
export const MAX_FOLDER_ENTRIES = 120;

// Directories that are machinery, not content: generated, vendored, or a cache.
// Somebody's own file is never in one, and if the folder is nothing but these
// they are listed anyway rather than answering "nothing here" (see below).
const MACHINERY = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|site-packages|dist|build|target|coverage|\.next|\.nuxt|\.parcel-cache|\.gradle|\.idea|\.terraform|vendor|Pods)(\/|$)/i;

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|bmp|avif)$/i;
const TEXTUAL_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rs|rb|php|sh|ps1|bat|sql|log|ini|toml|env|srt|vtt|rst|tex)$/i;
// What the daemon's extractor handles. Kept in step with isDocumentPath() in
// packages/fast-agent/src/documents.js — a format listed here that it does not
// know comes back as a clear refusal rather than as mojibake.
const EXTRACTABLE_EXTENSIONS = /\.(pdf|docx|xlsx|pptx)$/i;

export function kindOf(file) {
  if (IMAGE_TYPES.test(file.type) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name)) return "image";
  if (EXTRACTABLE_EXTENSIONS.test(file.name) || /pdf$/i.test(file.type)) return "extractable";
  if (TEXTUAL_EXTENSIONS.test(file.name) || /^text\//i.test(file.type)) return "text";
  // The old Office formats and the ODF ones are genuinely different file
  // formats, not older versions of the new ones, and nothing here reads them.
  if (/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages)$/i.test(file.name)) return "document-unsupported";
  return "unknown";
}

const readAsText = (file) => file.text();

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`${file.name} could not be read`));
  reader.onload = () => resolve(String(reader.result));
  reader.readAsDataURL(file);
});

/** Base64 without the `data:` prefix, for the extraction endpoint. */
async function readAsBase64(file) {
  const dataUrl = await readAsDataUrl(file);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Where this file lives on the machine, when that can be known.
 *
 * The desktop shell exposes it (see preload.js); a plain browser cannot and
 * returns null, which every caller treats as "send the contents instead".
 */
export function pathOf(file) {
  try {
    return window.syscora?.pathForFile?.(file) ?? null;
  } catch {
    return null;
  }
}

const humanBytes = (bytes) => {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Hand the bytes to the daemon's document extractor.
 *
 * The daemon holds them in memory, pulls the text out and drops them; nothing
 * is written to disk. Returns `{ ok, text, format, reason }`.
 */
async function extractOnDaemon(file) {
  const response = await fetch("/api/attachments/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, base64: await readAsBase64(file) })
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    return { ok: false, text: "", reason: detail.reason ?? `the extractor answered HTTP ${response.status}` };
  }
  return response.json();
}

/** How a document's text got here, for the line under the chip. */
const EXTRACTED_BY = {
  pdf: "text pulled out of the PDF",
  docx: "read from the Word document",
  xlsx: "read from the spreadsheet",
  pptx: "read from the slides"
};

/**
 * Prepare one file for sending.
 *
 * Every returned attachment carries `kind`, which is what model routing is
 * decided from — see models.js — and its payload in exactly one of `text`,
 * `dataUrl` or `entries`.
 */
export async function prepareAttachment(file) {
  const base = {
    name: file.name,
    bytes: file.size,
    mime: file.type || "application/octet-stream",
    // Null in a plain browser. When it is set, the agent can go and look at the
    // real file rather than working only from what was pasted into the prompt.
    path: pathOf(file)
  };
  if (file.size > MAX_FILE_BYTES) {
    return {
      ...base,
      kind: "rejected",
      error: `${file.name} is ${humanBytes(file.size)} — the limit is ${MAX_FILE_BYTES / 1048576} MB.` +
        (base.path ? " It is on this machine, so ask SYSCORA to open it from disk instead." : "")
    };
  }

  const kind = kindOf(file);

  if (kind === "image") {
    return { ...base, kind: "image", dataUrl: await readAsDataUrl(file) };
  }

  if (kind === "text") {
    const whole = await readAsText(file);
    const text = whole.slice(0, MAX_EXTRACTED_CHARS);
    return {
      ...base,
      kind: "document",
      text,
      truncated: whole.length > text.length,
      extractedBy: "read as text"
    };
  }

  if (kind === "extractable") {
    let extracted;
    try {
      extracted = await extractOnDaemon(file);
    } catch (error) {
      return {
        ...base,
        kind: "rejected",
        error: `${file.name} could not be sent for reading: ${error?.message ?? error}. ` +
          "Is the SYSCORA daemon still running?"
      };
    }
    if (!extracted.ok || !extracted.text) {
      // "There is no text in it" and "it could not be read" are different
      // answers with different next moves, and the extractor says which.
      return {
        ...base,
        kind: "rejected",
        error: `${file.name}: ${extracted.reason ?? "no readable text was found in it"}.` +
          (base.path ? " Ask SYSCORA to look at the file on disk if you want it tried another way." : "")
      };
    }
    const text = extracted.text.slice(0, MAX_EXTRACTED_CHARS);
    return {
      ...base,
      kind: "document",
      text,
      truncated: extracted.text.length > text.length,
      extractedBy: EXTRACTED_BY[extracted.format] ?? `read from the ${extracted.format}`
    };
  }

  if (kind === "document-unsupported") {
    return {
      ...base,
      kind: "rejected",
      error: `${file.name} is an older or non-Office format that cannot be read here. ` +
        "Save it as .docx, .xlsx, .pptx or .pdf — or ask SYSCORA to open it from your machine."
    };
  }

  return { ...base, kind: "rejected", error: `${file.name} is not a file type this can read.` };
}

/**
 * Prepare a whole folder.
 *
 * A FOLDER IS A PLACE, NOT A PAYLOAD. Uploading the contents of somebody's
 * project directory would be tens of megabytes of node_modules to answer a
 * question about one file — and this agent drives the machine the folder is on,
 * so what it needs is the path and a map, not the bytes. When the desktop shell
 * can give the real path, the agent reads whatever it decides it needs with the
 * filesystem tools it already has. In a plain browser it still gets the listing,
 * which is enough to answer "what is in here".
 */
export function prepareFolder(files) {
  const list = [...files];
  if (list.length === 0) return null;
  // webkitRelativePath is "TopFolder/sub/file.txt" for every file in the pick,
  // so its first segment is the folder the user actually chose.
  const rootName = String(list[0].webkitRelativePath ?? list[0].name).split("/")[0] || "folder";

  // The folder's own path, derived from its first file's — Electron gives paths
  // for FILES, never for directories, so this is the only way to it.
  //
  // Note what the relative path contains: "InvestorDemo/src/app.js", INCLUDING
  // the chosen folder's own name. Stripping the whole of it leaves the folder's
  // PARENT, which is not what was attached — get this wrong and the agent is
  // handed C:\Users\me for a folder called InvestorDemo and goes looking through
  // the whole profile. So the parent is found first and the name put back.
  let path = null;
  const firstPath = pathOf(list[0]);
  const relative = String(list[0].webkitRelativePath ?? "");
  if (firstPath && relative) {
    const tail = relative.replace(/\//g, "\\");
    if (firstPath.toLowerCase().endsWith(`\\${tail.toLowerCase()}`)) {
      const parent = firstPath.slice(0, firstPath.length - tail.length - 1);
      path = `${parent}\\${rootName}`;
    }
  }

  const all = list
    .map((file) => ({ path: String(file.webkitRelativePath ?? file.name), bytes: file.size }))
    .sort((left, right) => left.path.localeCompare(right.path));

  // What the person wrote, as opposed to what their tools generated. If that is
  // empty the folder IS its machinery — somebody attached node_modules on
  // purpose — and showing them an empty map would be a lie about their folder.
  const skipped = all.filter((entry) => MACHINERY.test(entry.path));
  const everythingIsMachinery = skipped.length === all.length;
  const content = everythingIsMachinery ? all : all.filter((entry) => !MACHINERY.test(entry.path));

  // Shallow first. A folder's own README, package.json and source directory say
  // more about it than anything nested six levels down, and alphabetical order
  // buries them under whatever begins with a dot.
  const depth = (entry) => entry.path.split("/").length;
  const ranked = [...content].sort((left, right) => depth(left) - depth(right) || left.path.localeCompare(right.path));

  return {
    kind: "folder",
    name: rootName,
    path,
    fileCount: list.length,
    bytes: list.reduce((total, file) => total + file.size, 0),
    entries: ranked.slice(0, MAX_FOLDER_ENTRIES),
    // Named rather than silently dropped: a listing that stops without saying so
    // reads as a complete listing, and the model would answer "there is no
    // README in it" about a folder it was shown a third of.
    omitted: Math.max(0, ranked.length - MAX_FOLDER_ENTRIES),
    // The two summaries that replace two hundred lines of `.pyc`: which folders
    // were left out, and what the folder is mostly made of.
    machinery: summariseMachinery(everythingIsMachinery ? [] : skipped),
    mostly: summariseKinds(content)
  };
}

/** The machinery directories that were left out, with their file counts. */
function summariseMachinery(skipped) {
  const counts = new Map();
  for (const entry of skipped) {
    const name = MACHINERY.exec(entry.path)?.[2];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));
}

/** The extensions this folder is mostly made of — what kind of project it is. */
function summariseKinds(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(entry.path)?.[1]?.toLowerCase();
    if (!extension) continue;
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([extension, count]) => ({ extension, count }));
}

/**
 * The text block appended to the user's message for everything that travels as
 * text — documents and folder listings.
 *
 * Fenced and labelled so the model can tell the user's own words from the file's
 * contents. That boundary is the same one content-boundary.js enforces on the
 * way in: what was READ is not what was ASKED.
 */
export function describeAttachments(attachments) {
  const blocks = [];
  for (const item of attachments) {
    if (item.kind === "document" && item.text) {
      const where = item.path ? ` at ${item.path}` : "";
      // WHOLE OR CLIPPED, SAID EXPLICITLY.
      //
      // The header used to say only how the text was obtained, and a live
      // transcript on 24 Aug 2026 shows what that cost: asked "did you read my
      // resume before searching?", the agent answered "I should read the file
      // itself rather than rely on the attachment summary" and spent a step
      // reading the same PDF off disk. It was never a summary — it was the
      // complete text — but nothing in front of it said so, and a model handed
      // an unlabelled extract is right to wonder what was left out.
      const clipped = item.truncated
        ? `\n[… the rest of ${item.name} was not sent — it is longer than ${MAX_EXTRACTED_CHARS.toLocaleString()} characters` +
          (item.path ? ", so read the file itself if you need the rest" : "") + "]"
        : "";
      const completeness = item.truncated
        ? "the first part of its text"
        : "its COMPLETE text, not a summary — there is no need to open the file to read it";
      blocks.push(
        `\n\n--- Attached file: ${item.name}${where} — ${completeness} (${item.extractedBy}) ---\n` +
        `${item.text}${clipped}\n--- end of ${item.name} ---`
      );
    }
    if (item.kind === "folder") {
      // The PATH first and on its own line, because it is the actionable part:
      // with it the agent can list, read and search the folder itself instead of
      // reasoning only from this snapshot.
      const lines = [
        `\n\n--- Attached folder: ${item.name} ---`,
        item.path
          ? `Full path on this machine: ${item.path}\n` +
            "You can read, list and search inside it with the filesystem tools."
          : "This browser cannot give the folder's path, so only the listing below is available.",
        `${item.fileCount} file${item.fileCount === 1 ? "" : "s"}, ${humanBytes(item.bytes)}.`
      ];
      // What kind of thing this is, in one line, before the map of it.
      if (item.mostly?.length) {
        lines.push(`Mostly: ${item.mostly.map((kind) => `.${kind.extension} × ${kind.count}`).join(", ")}.`);
      }
      // Said out loud. The agent must be able to tell "there is no .git here"
      // from "the .git was not shown to you" — it can go and look either way,
      // and only one of those is worth looking at.
      if (item.machinery?.length) {
        const total = item.machinery.reduce((sum, group) => sum + group.count, 0);
        lines.push(
          `Not listed: ${total.toLocaleString()} generated or vendored files in ` +
          `${item.machinery.map((group) => group.name).join(", ")}. They are still on disk.`
        );
      }
      // The sizes went with the per-file lines. A map does not need them — the
      // total is above, and anything more precise is one `run` away — and they
      // were a third of the characters.
      lines.push(...item.entries.map((entry) => `  ${entry.path}`));
      if (item.omitted) lines.push(`  … and ${item.omitted} more files not listed here.`);
      lines.push(`--- end of ${item.name} ---`);
      blocks.push(lines.join("\n"));
    }
  }
  return blocks.join("");
}
