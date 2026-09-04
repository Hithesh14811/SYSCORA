// Finding code on this machine, without a terminal.
//
// THE GAP THIS CLOSES. The filesystem verbs were `read`, `write`, `stat` and a
// `filesystem.search` capability that no tool ever exposed. So "where is the
// function that builds the toolset" had exactly one route: PowerShell — which is
// OFF by default, and which the agent is told to prefer a typed tool over. Asked
// to work on a repository the agent could open files it was told the names of
// and nothing else. That is the difference between an assistant that edits code
// and one that can find the code to edit.
//
// TWO QUESTIONS, TWO VERBS, and they are genuinely different:
//   findFiles   — where is the file whose NAME looks like this
//   searchCode  — which lines anywhere under here CONTAIN this
//
// WHY THIS IS NODE AND NOT POWERSHELL. `adapter.searchFiles` shells out to
// `Get-ChildItem -Recurse -Filter`, which cannot express `src/**/*.test.js`,
// cannot skip `node_modules`, and pays ~1,100ms of process start-up. Every bound
// below is enforced in code rather than trusted to a script, and the whole thing
// runs with the terminal switched off, which is the point.
//
// EVERY LIMIT HERE EXISTS BECAUSE THE RESULT GOES INTO A PROMPT.
//
// This is not a shell where a wrong answer scrolls past. A search that returns
// 4,000 matches costs more than the task that asked for it: measured on this
// endpoint a step is ~7,000 billed tokens before it fetches anything, and a
// 4,000-line result is another ~40,000 on top — for an answer nobody can read.
// So results are bounded, lines are clipped, and the caller is TOLD when a bound
// was hit, because a silently truncated search is one the model will trust as
// complete and conclude the wrong thing from.

import fs from "node:fs/promises";
import path from "node:path";

// Directories that are never the answer. Walking them is not merely slow — the
// matches they return are about somebody else's code, and the model cannot tell
// that from the user's own. `node_modules` on this repository alone is ~90,000
// files; a content search across it takes minutes and returns thousands of hits
// for any word in English.
//
// KEPT SHORT AND CONVENTIONAL ON PURPOSE. A long list is one that eventually
// hides a directory somebody meant. Anything project-specific belongs in that
// project's .gitignore, which is read below.
export const IGNORED_DIRECTORIES = Object.freeze(new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  ".next", ".nuxt", ".output", ".turbo", ".parcel-cache", ".cache", "coverage",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  "venv", ".venv", "env", ".gradle", ".idea", ".vs", "bin", "obj",
  "$RECYCLE.BIN", "System Volume Information", "Windows", "AppData"
]));

// Extensions whose contents are not text. Checked before opening the file, so a
// 2 GB video is never read.
//
// AN EXTENSION LIST IS NEVER COMPLETE, which is why it is not the only check:
// `looksBinary` sniffs the first bytes for a NUL as well. The list exists to
// avoid paying for the read at all on the common cases.
export const BINARY_EXTENSIONS = Object.freeze(new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".flac", ".ogg", ".webm",
  ".zip", ".gz", ".tar", ".7z", ".rar", ".bz2", ".xz", ".jar", ".whl",
  ".exe", ".dll", ".so", ".dylib", ".pdb", ".obj", ".lib", ".bin", ".msi",
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".class", ".wasm", ".db", ".sqlite", ".sqlite3", ".pack", ".idx"
]));

// The ceilings. Every one of them is a number the caller can lower and none of
// them can be raised past these, because the caller is a language model and the
// bill is the user's.
const LIMITS = Object.freeze({
  maxDepth: 12,
  maxFiles: 200,
  maxMatches: 200,
  maxFilesScanned: 20000,
  maxFileBytes: 2 * 1024 * 1024,
  maxLineChars: 300,
  maxContextLines: 4
});

const clamp = (value, fallback, ceiling, floor = 1) => {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < floor) return fallback;
  return Math.min(number, ceiling);
};

/**
 * Translate a glob into a regular expression.
 *
 * Supports the shapes people actually type: `*.ts`, `**\/*.test.js`,
 * `src/**`, `{js,ts,tsx}`, `?`. Everything else is matched literally, which is
 * the safe direction — an unrecognised metacharacter finds nothing rather than
 * matching everything.
 *
 * `**` AND `*` ARE NOT THE SAME AND THE DIFFERENCE IS THE WHOLE POINT: `*` must
 * not cross a directory separator or `src/*.js` would match
 * `src/deep/nested/thing.js` and the pattern would be useless for narrowing.
 * Matched against forward-slash relative paths, so the caller never has to think
 * about which separator this machine uses.
 */
export function globToRegExp(glob, { caseSensitive = false } = {}) {
  const pattern = String(glob ?? "").trim().replace(/\\/g, "/");
  if (!pattern) return null;
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      // `**/` — any number of directories INCLUDING none, so `**/*.js` matches
      // `index.js` at the root as well as `a/b/index.js`. A pattern that only
      // matched nested files would silently miss the top level, which is where
      // the interesting file usually is.
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") { out += "(?:.*/)?"; index += 2; }
        else { out += ".*"; index += 1; }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (character === "?") { out += "[^/]"; continue; }
    if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close > index) {
        const alternatives = pattern.slice(index + 1, close).split(",")
          .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alternatives.join("|")})`;
        index = close;
        continue;
      }
    }
    out += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare name with no separator matches the FILE NAME anywhere in the tree.
  // `find_files {glob: "server.js"}` meaning "only a file called server.js in
  // the root directory" is not what anybody means by it.
  const anchored = pattern.includes("/") ? `^${out}$` : `(?:^|/)${out}$`;
  return new RegExp(anchored, caseSensitive ? "" : "i");
}

/**
 * The root .gitignore, as a last-match-wins list of rules.
 *
 * WHY THIS IS WORTH READING. The built-in directory list covers the
 * conventional cases and nothing else: a repository that builds into `_site`,
 * `public/generated` or `packages/*\/lib` has its build output searched, and the
 * model then reads generated code and edits the wrong file. The project already
 * wrote down which files are not its source; this reads it rather than guessing.
 *
 * ONLY THE ROOT FILE. Nested .gitignore files are real and are deliberately not
 * read: doing it properly means re-evaluating the rule stack at every directory,
 * which is a meaningful cost on every walk, and the root file covers the case
 * this exists for. Stated here rather than discovered later.
 *
 * Negation (`!keep-this`) is honoured because last-match-wins is what makes an
 * ignore file mean what it says — a `*.log` rule with a `!keep.log` under it is
 * a pattern people really write, and ignoring the second half hides a file the
 * user explicitly kept.
 *
 * WITH GIT'S OWN LIMIT ON NEGATION, deliberately: a negation cannot rescue a
 * file whose parent DIRECTORY is excluded, because the walk never descends into
 * an excluded directory. That is exactly what git does and for exactly the same
 * reason, so what this searches matches what the user's `git status` shows them.
 * Fixing it would mean walking excluded directories to check, which is the cost
 * this whole module exists to avoid.
 */
export async function readIgnoreRules(root) {
  let text;
  try {
    text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = (negated ? line.slice(1) : line).replace(/^\/+/, "");
    if (!body) continue;
    // A trailing slash means "the directory and everything in it". Expressed as
    // two patterns so `dist/` matches both `dist` itself and `dist/a/b.js`.
    const bare = body.replace(/\/+$/, "");
    const expression = globToRegExp(bare);
    const subtree = globToRegExp(`${bare}/**`);
    if (expression) rules.push({ negated, expression, subtree });
  }
  return rules;
}

/** Last match wins, exactly as git resolves it. */
function ignoredByRules(relative, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.expression.test(relative) || rule.subtree?.test(relative)) ignored = !rule.negated;
  }
  return ignored;
}

/** Cheap enough to run on every candidate, and it is what makes the walk fast. */
function skipDirectory(name, relative, rules, includeHidden) {
  if (IGNORED_DIRECTORIES.has(name)) return true;
  if (!includeHidden && name.startsWith(".")) return true;
  return ignoredByRules(relative, rules);
}

/**
 * Walk a tree once, handing every file to `visit`.
 *
 * ONE WALKER FOR BOTH VERBS. `findFiles` and `searchCode` ask different
 * questions of the same traversal, and two copies of a bounded recursive walk is
 * two places for a bound to be forgotten — which is exactly how a search ends up
 * inside `node_modules` in one code path and not the other.
 *
 * `visit` returns false to stop the walk. The counters are returned so the
 * caller can say honestly whether it saw everything.
 */
async function walk(root, { maxDepth, includeHidden, rules, maxFilesScanned }, visit) {
  let scanned = 0;
  let stopped = false;
  let unreadable = 0;

  const descend = async (directory, relative, depth) => {
    if (stopped || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      // A folder this account cannot open is a fact about that folder, not a
      // failed search. Counted, reported, and stepped over.
      unreadable += 1;
      return;
    }
    // Files before directories, so a bounded result is the shallowest match
    // rather than whatever the filesystem happened to return first. "Where is
    // the config" should find `./config.json` before `a/b/c/config.json`.
    const files = [];
    const directories = [];
    for (const entry of entries) {
      (entry.isDirectory() ? directories : files).push(entry);
    }
    for (const entry of files) {
      if (stopped) return;
      if (!includeHidden && entry.name.startsWith(".")) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoredByRules(childRelative, rules)) continue;
      scanned += 1;
      if (scanned > maxFilesScanned) { stopped = true; return; }
      if (await visit(path.join(directory, entry.name), childRelative) === false) { stopped = true; return; }
    }
    for (const entry of directories) {
      if (stopped) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (skipDirectory(entry.name, childRelative, rules, includeHidden)) continue;
      await descend(path.join(directory, entry.name), childRelative, depth + 1);
    }
  };

  await descend(root, "", 1);
  return { scanned, unreadable, stopped };
}

/** Reject a file before opening it. The extension is free; the read is not. */
const binaryByName = (relative) => BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase());

/**
 * A NUL byte in the first few kilobytes means this is not text.
 *
 * The extension list cannot cover everything — a `.dat`, a `.model`, a file with
 * no extension at all — and reading one as UTF-8 produces replacement characters
 * that match nothing and cost tokens to carry. This is the check that actually
 * decides; the extension list is only the fast path in front of it.
 */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true;
  return false;
}

/**
 * Where is the file whose name looks like this.
 *
 * Returns paths relative to the root as well as absolute ones: relative is what
 * a person reads and what the model should quote, absolute is what every other
 * tool needs to open it.
 */
export async function findFiles(rootDirectory, {
  glob,
  max = 60,
  maxDepth = 12,
  includeHidden = false,
  honourGitignore = true
} = {}) {
  const root = path.resolve(String(rootDirectory ?? process.cwd()));
  const expression = globToRegExp(glob);
  if (!expression) throw new Error("find_files needs a name or glob to look for — for example `**/*.test.js`.");

  const rules = honourGitignore ? await readIgnoreRules(root) : [];
  const limit = clamp(max, 60, LIMITS.maxFiles);
  const files = [];

  const stats = await walk(root, {
    maxDepth: clamp(maxDepth, 12, LIMITS.maxDepth),
    includeHidden,
    rules,
    maxFilesScanned: LIMITS.maxFilesScanned
  }, async (absolute, relative) => {
    if (!expression.test(relative)) return true;
    let size = null;
    let modified = null;
    try {
      const stat = await fs.stat(absolute);
      size = stat.size;
      modified = stat.mtime.toISOString();
    } catch { /* a file that vanished mid-walk is still a real match */ }
    files.push({ path: absolute, relative, size, modified });
    return files.length < limit;
  });

  return {
    root,
    glob: String(glob),
    files,
    filesScanned: stats.scanned,
    unreadableDirectories: stats.unreadable,
    // TWO DIFFERENT KINDS OF INCOMPLETE, AND THE MODEL MUST BE ABLE TO TELL THEM
    // APART. `truncated` means there are more matches than were returned — ask
    // more narrowly. `scanLimited` means the walk itself gave up before it had
    // seen the whole tree, so there may be matches nobody has looked at yet.
    truncated: files.length >= limit,
    scanLimited: stats.scanned > LIMITS.maxFilesScanned
  };
}

/**
 * Which lines under here contain this.
 *
 * `regex: true` takes the query as a regular expression; otherwise it is a
 * literal, which is what people mean nine times in ten and cannot be broken by a
 * bracket in a function signature.
 */
export async function searchCode(rootDirectory, {
  query,
  regex = false,
  glob = null,
  ignoreCase = true,
  max = 60,
  maxDepth = 12,
  context = 0,
  includeHidden = false,
  honourGitignore = true
} = {}) {
  const root = path.resolve(String(rootDirectory ?? process.cwd()));
  const needle = String(query ?? "");
  // The empty needle, again. `"anything".includes("")` is true, so a search for
  // nothing would return the first N lines of the repository and read as a
  // successful search for whatever the model thought it asked. This project has
  // shipped that bug in six different check kinds; it does not ship it here.
  if (!needle.trim()) throw new Error("search_code needs something to look for.");

  let expression;
  try {
    expression = regex
      ? new RegExp(needle, ignoreCase ? "gi" : "g")
      : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "gi" : "g");
  } catch (error) {
    throw new Error(`That is not a valid regular expression: ${error.message}. Drop \`regex\` to search for it literally.`);
  }

  const fileFilter = glob ? globToRegExp(glob) : null;
  const rules = honourGitignore ? await readIgnoreRules(root) : [];
  const limit = clamp(max, 60, LIMITS.maxMatches);
  const contextLines = clamp(context, 0, LIMITS.maxContextLines, 0);
  const matches = [];
  const filesWithMatches = new Set();
  let filesRead = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;

  const stats = await walk(root, {
    maxDepth: clamp(maxDepth, 12, LIMITS.maxDepth),
    includeHidden,
    rules,
    maxFilesScanned: LIMITS.maxFilesScanned
  }, async (absolute, relative) => {
    if (fileFilter && !fileFilter.test(relative)) return true;
    if (binaryByName(relative)) { skippedBinary += 1; return true; }

    let buffer;
    try {
      const stat = await fs.stat(absolute);
      if (stat.size > LIMITS.maxFileBytes) { skippedLarge += 1; return true; }
      buffer = await fs.readFile(absolute);
    } catch {
      return true;
    }
    if (looksBinary(buffer)) { skippedBinary += 1; return true; }
    filesRead += 1;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      const hit = expression.exec(lines[index]);
      if (!hit) continue;
      filesWithMatches.add(relative);
      matches.push({
        relative,
        path: absolute,
        line: index + 1,
        column: hit.index + 1,
        // A MATCHED LINE IS NOT ALWAYS A LINE. One hit inside a minified bundle
        // or a data URI is hundreds of kilobytes on its own, and it goes
        // straight into the prompt. Clipped from the match rather than from the
        // start, so what the model is shown is the part that matched.
        text: clipAround(lines[index], hit.index, LIMITS.maxLineChars),
        before: contextLines ? lines.slice(Math.max(0, index - contextLines), index).map(clipLine) : undefined,
        after: contextLines ? lines.slice(index + 1, index + 1 + contextLines).map(clipLine) : undefined
      });
      if (matches.length >= limit) return false;
    }
    return true;
  });

  return {
    root,
    query: needle,
    regex: Boolean(regex),
    glob: glob ? String(glob) : null,
    matches,
    fileCount: filesWithMatches.size,
    filesRead,
    filesScanned: stats.scanned,
    skippedBinary,
    skippedLarge,
    unreadableDirectories: stats.unreadable,
    truncated: matches.length >= limit,
    scanLimited: stats.scanned > LIMITS.maxFilesScanned
  };
}

const clipLine = (line) => (line.length > LIMITS.maxLineChars
  ? `${line.slice(0, LIMITS.maxLineChars)}…`
  : line);

/** Keep the match in view when the line around it is enormous. */
function clipAround(line, at, width) {
  if (line.length <= width) return line;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(line.length, start + width);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}
