// A SINGLE BACKSLASH IN A JS STRING IS NOT A WINDOWS PATH.
//
//   node scripts/audit-string-escapes.mjs [file…]
//
// `"C:\tmp\x.txt"` is not a path: `\t` is a tab and `\x` is a hex escape that
// will not even parse. This is the same trap `assertNoControlCharacters` catches
// in the eval's task JSON, and it is worth catching in source too, because here
// it is quieter — `.\build` becomes a backspace and the file still compiles, so
// a test can assert a corrupted string against the same corrupted string and
// pass for the wrong reason. Found 19 Aug 2026 after writing three test files
// through a shell heredoc, which ate one backslash of every pair.
//
// Reports the line and what the escape turns into. Exit code 1 if anything is
// found, so it can gate a commit.

import fs from "node:fs/promises";
import path from "node:path";

// The escapes that silently change a string rather than failing to parse. `\x`
// and `\u` are excluded because they are loud: an invalid one is a SyntaxError,
// which nobody ships by accident.
const SILENT = { t: "a tab", b: "a backspace", n: "a newline", r: "a carriage return", f: "a form feed", v: "a vertical tab" };

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("usage: node scripts/audit-string-escapes.mjs <file…>");
  process.exit(0);
}

let found = 0;
for (const file of files) {
  const source = await fs.readFile(file, "utf8");
  source.split("\n").forEach((line, index) => {
    // ONLY WHERE A PATH IS ACTUALLY BEING WRITTEN, or this cries wolf and gets
    // switched off. Requires a drive letter immediately followed by a backslash
    // — `C:\…` — which is the shape that goes wrong. A deliberate `\n` inside a
    // rendered screen reading, `Window: WhatsApp\n0| text …`, is not that, and
    // the first version of this flagged three of them.
    // ONLY the drive-letter shape, because it is the only one that can be told
    // apart from prose reliably.
    //
    // A relative `.\build` is the same defect and is NOT caught here: `\b` is a
    // backspace, the file still compiles, and a test asserting the corrupted
    // string against the same corrupted string passes. One did, in this repo,
    // and it was found by reading rather than by this script. Widening the rule
    // to `.\` + letter was tried and reverted: it flags every `sentence.\nNext`
    // in the codebase — 45 of them — and a check that cries wolf gets switched
    // off, which costs more than the case it would have caught.
    // A drive letter is ONE letter before the colon. Written `[A-Za-z]:\\` it
    // also matches `Text:\n` and `Visible text:\n` in ordinary template strings,
    // which is 26 false positives across this repo — same lesson as above.
    if (!/(^|[^A-Za-z])[A-Za-z]:\\/.test(line)) return;
    // A raw string literal has no escapes to get wrong; that is what it is for.
    if (/String\.raw`/.test(line)) return;
    for (const [escape, becomes] of Object.entries(SILENT)) {
      // A single backslash — not one of a doubled pair — before the letter.
      const pattern = new RegExp(`(^|[^\\\\])\\\\${escape}`);
      if (!pattern.test(line)) continue;
      found += 1;
      console.log(`${file}:${index + 1}  \\${escape} is ${becomes} here, not a path separator`);
      console.log(`  ${line.trim().slice(0, 140)}`);
    }
  });
}

console.log(found ? `\n${found} suspicious escape(s).` : "No single-backslash path escapes found.");
process.exitCode = found ? 1 : 0;
