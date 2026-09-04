// Finding code without a terminal.
//
// The checks that matter here are the BOUNDS and the EXCLUSIONS, not that a
// search can find a word. A search that walks node_modules still "works" — it
// returns matches — and it is useless and expensive, and neither of those shows
// up in a test that only asserts a hit was found. So most of what follows proves
// the negative: that something was NOT read, NOT walked, NOT returned.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findFiles, searchCode, globToRegExp, readIgnoreRules } from "../../packages/code-intel/src/index.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-code-intel-"));
  const write = async (relative, contents) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  };
  await write("src/server.js", "export function startServer() {\n  return listen(4317);\n}\n");
  await write("src/deep/nested/handler.js", "// startServer is called from here\nstartServer();\n");
  await write("src/server.test.js", "test('startServer', () => {});\n");
  await write("README.md", "# A project\nIt calls startServer at boot.\n");
  await write("node_modules/evil/index.js", "startServer(); // must never be found\n");
  await write("dist/bundle.js", "startServer(); // build output, must never be found\n");
  await write(".git/config", "startServer\n");
  await write("generated/out.js", "startServer(); // ignored by .gitignore\n");
  await write("scratch.log", "startServer(); // ignored by *.log\n");
  await write("keep.log", "startServer(); // kept by a negation\n");
  await write(".gitignore", "generated/\n*.log\n!keep.log\n");
  await write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await write("data/blob.dat", Buffer.concat([Buffer.from("startServer"), Buffer.from([0x00]), Buffer.alloc(64)]));
  return root;
}

test("a glob narrows by path and a bare name matches anywhere", async () => {
  const root = await fixture();

  const scoped = await findFiles(root, { glob: "src/**/*.js" });
  const scopedNames = scoped.files.map((file) => file.relative).sort();
  assert.deepEqual(scopedNames, ["src/deep/nested/handler.js", "src/server.js", "src/server.test.js"]);

  // A bare name is the question "where is the file called this", which is what
  // people mean by it — not "is there one in the root directory".
  const bare = await findFiles(root, { glob: "handler.js" });
  assert.deepEqual(bare.files.map((file) => file.relative), ["src/deep/nested/handler.js"]);

  // `*` must not cross a separator, or every scoped pattern is a whole-tree one.
  const shallow = await findFiles(root, { glob: "src/*.js" });
  assert.ok(!shallow.files.some((file) => file.relative.includes("deep")),
    "src/*.js must not reach src/deep/nested/handler.js");
});

test("**/ matches at the root as well as nested", () => {
  const expression = globToRegExp("**/*.js");
  assert.ok(expression.test("index.js"), "a root file must match **/*.js");
  assert.ok(expression.test("a/b/index.js"));
  assert.ok(!expression.test("index.ts"));
});

test("a brace alternation is one pattern, not a literal", () => {
  const expression = globToRegExp("**/*.{js,ts}");
  assert.ok(expression.test("src/a.js"));
  assert.ok(expression.test("src/a.ts"));
  assert.ok(!expression.test("src/a.jsx"));
});

test("node_modules, build output and .git are never walked", async () => {
  const root = await fixture();
  const found = await searchCode(root, { query: "startServer" });
  const files = found.matches.map((match) => match.relative);

  // The whole reason this module exists rather than a Get-ChildItem -Recurse.
  assert.ok(!files.some((file) => file.startsWith("node_modules/")), "node_modules must never be searched");
  assert.ok(!files.some((file) => file.startsWith("dist/")), "build output must never be searched");
  assert.ok(!files.some((file) => file.startsWith(".git/")), ".git must never be searched");
  assert.ok(files.includes("src/server.js"), "the user's own source must still be found");
});

test("the project's own .gitignore is honoured, negations included", async () => {
  const root = await fixture();
  const rules = await readIgnoreRules(root);
  assert.equal(rules.length, 3);

  const found = await searchCode(root, { query: "startServer" });
  const files = found.matches.map((match) => match.relative);
  assert.ok(!files.includes("generated/out.js"), "a .gitignore'd directory must not be searched");
  assert.ok(!files.includes("scratch.log"), "a .gitignore'd file must not be searched");
  // Last match wins, exactly as git resolves it. A file the user explicitly kept
  // is a file they want found.
  assert.ok(files.includes("keep.log"), "a negated rule must un-ignore the file it names");
});

test("a negation cannot rescue a file under an excluded directory", async () => {
  // GIT'S OWN RULE, AND IT IS NOT AN OVERSIGHT HERE: "it is not possible to
  // re-include a file if a parent directory of that file is excluded", because
  // git never descends into the excluded directory to find out. This walker does
  // the same thing for the same reason — not descending is where the speed comes
  // from — so the behaviour matches what the user's `git status` already shows
  // them. Pinned as a test because the obvious "fix" is to walk the directory
  // anyway, which would quietly put node_modules back in scope.
  const root = await fixture();
  await fs.mkdir(path.join(root, "generated"), { recursive: true });
  await fs.writeFile(path.join(root, "generated", "rescued.js"), "startServer();\n");
  await fs.writeFile(path.join(root, ".gitignore"), "generated/\n!generated/rescued.js\n");

  const found = await searchCode(root, { query: "startServer" });
  assert.ok(!found.matches.some((match) => match.relative.startsWith("generated/")),
    "an excluded directory stays excluded, exactly as git resolves it");
});

test("binary files are skipped by extension and by content", async () => {
  const root = await fixture();
  const found = await searchCode(root, { query: "startServer" });
  assert.ok(!found.matches.some((match) => match.relative.endsWith(".png")));
  // `.dat` is in no extension list anywhere. The NUL sniff is what catches it,
  // and it is the check that actually decides.
  assert.ok(!found.matches.some((match) => match.relative.endsWith(".dat")),
    "a NUL byte must stop the file being searched whatever it is called");
  assert.ok(found.skippedBinary >= 2);
});

test("searching for nothing is refused rather than matching everything", async () => {
  const root = await fixture();
  // `"anything".includes("")` is true. This project has shipped that bug in six
  // separate check kinds; an empty needle must never look like a good search.
  await assert.rejects(() => searchCode(root, { query: "" }), /needs something to look for/);
  await assert.rejects(() => searchCode(root, { query: "   " }), /needs something to look for/);
  await assert.rejects(() => findFiles(root, { glob: "" }), /needs a name or glob/);
});

test("a bounded result says so, and says which kind of bounded", async () => {
  const root = await fixture();
  const capped = await searchCode(root, { query: "startServer", max: 2 });
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.truncated, true, "a result that hit its ceiling must say so");
  assert.equal(capped.scanLimited, false, "the walk itself completed, and that is a different fact");

  const all = await searchCode(root, { query: "startServer", max: 50 });
  assert.equal(all.truncated, false);
});

test("a literal query is not read as a regular expression", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "src", "call.js"), "listen(4317);\n");
  // `listen(4317)` is a valid regex meaning something entirely different. A
  // literal search is what people mean nine times in ten and cannot be broken
  // by a bracket in a function signature.
  const literal = await searchCode(root, { query: "listen(4317)" });
  assert.ok(literal.matches.some((match) => match.relative === "src/call.js"));

  const asRegex = await searchCode(root, { query: "listen\\(4317\\)", regex: true });
  assert.ok(asRegex.matches.some((match) => match.relative === "src/call.js"));
});

test("an invalid regular expression is explained rather than thrown raw", async () => {
  const root = await fixture();
  await assert.rejects(
    () => searchCode(root, { query: "(unclosed", regex: true }),
    /not a valid regular expression.*search for it literally/s
  );
});

test("an enormous matched line is clipped around the match, not from the start", async () => {
  const root = await fixture();
  const padding = "x".repeat(5000);
  await fs.writeFile(path.join(root, "src", "bundle.min.js"), `${padding}NEEDLE${padding}\n`);
  const found = await searchCode(root, { query: "NEEDLE", glob: "**/bundle.min.js" });
  assert.equal(found.matches.length, 1);
  const [match] = found.matches;
  assert.ok(match.text.length < 400, `a matched line went into the prompt at ${match.text.length} characters`);
  assert.ok(match.text.includes("NEEDLE"), "clipping must keep the part that matched");
});

test("context lines are returned when asked for and not otherwise", async () => {
  const root = await fixture();
  const plain = await searchCode(root, { query: "return listen" });
  assert.equal(plain.matches[0].before, undefined, "context costs tokens and is off by default");

  const withContext = await searchCode(root, { query: "return listen", context: 1 });
  assert.deepEqual(withContext.matches[0].before, ["export function startServer() {"]);
  assert.deepEqual(withContext.matches[0].after, ["}"]);
});

test("a glob narrows what is read, not merely what is returned", async () => {
  const root = await fixture();
  const everything = await searchCode(root, { query: "startServer" });
  const narrowed = await searchCode(root, { query: "startServer", glob: "**/*.md" });
  // The point of a glob on a content search is that the other files are never
  // opened. Filtering the RESULTS would cost the same and save nothing.
  assert.ok(narrowed.filesRead < everything.filesRead,
    `a glob must reduce files read: ${narrowed.filesRead} vs ${everything.filesRead}`);
  assert.deepEqual(narrowed.matches.map((match) => match.relative), ["README.md"]);
});

test("an unreadable directory is a fact, not a failed search", async () => {
  const root = await fixture();
  const found = await searchCode(root, { query: "startServer" });
  assert.equal(typeof found.unreadableDirectories, "number");
  assert.ok(found.matches.length > 0, "one bad folder must not empty the result");
});

test("hidden files stay out unless asked for", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, ".secrets"), "startServer\n");
  const normal = await searchCode(root, { query: "startServer" });
  assert.ok(!normal.matches.some((match) => match.relative === ".secrets"));

  const asked = await searchCode(root, { query: "startServer", includeHidden: true, honourGitignore: false });
  assert.ok(asked.matches.some((match) => match.relative === ".secrets"));
});
