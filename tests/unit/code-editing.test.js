// Editing code, and finding the code to edit.
//
// These two verbs are what turn "an agent that can open a file it was told the
// name of" into one that can work on a repository. The behaviour worth pinning
// is not that an edit lands — it is what happens when one DOESN'T:
//
//   a batch that fails part-way must leave the file byte-identical, because a
//   half-migrated file compiles against neither shape and the model cannot tell
//   which of its own edits took;
//
//   a search with no root must refuse rather than default to the home
//   directory, because the tempting default walks somebody's whole profile.
//
// The filesystem here is REAL — a temp directory, read back through node — so
// the evidence receipts are genuine rather than agreed with a stub.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildToolset } from "../../packages/fast-agent/src/tools.js";
import { CONFIRMED } from "../../packages/fast-agent/src/evidence.js";
import { findFiles, searchCode } from "../../packages/code-intel/src/index.js";

let root;

test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-code-editing-"));
});
test.after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function harness({
  workspaceRoots = [],
  ran = [],
  asked = [],
  approve = true,
  exitCode = 0,
  stdout = "",
  stderr = ""
} = {}) {
  const capabilities = {
    "filesystem.read": async ({ filePath }) => ({ filePath, contents: await fs.readFile(filePath, "utf8") }),
    "filesystem.write": async ({ filePath, content }) => {
      await fs.writeFile(filePath, String(content ?? ""));
      return { filePath };
    },
    "filesystem.findFiles": async ({ rootDirectory, ...rest }) => findFiles(rootDirectory, rest),
    "filesystem.searchCode": async ({ rootDirectory, ...rest }) => searchCode(rootDirectory, rest)
  };
  const adapter = {
    findFiles,
    searchCode,
    // Records rather than runs. What is being tested is WHICH command the tool
    // resolved from the manifest — running npm in a unit suite would test npm.
    executeCommand: async (cwd, command) => {
      ran.push({ cwd, command });
      return { stdout, stderr, exitCode, command };
    }
  };
  const registry = { get: (name) => (capabilities[name] ? { execute: capabilities[name] } : null) };
  const toolset = buildToolset({
    registry,
    adapter,
    basePath: root,
    confirm: async (request) => { asked.push(request); return approve; }
  });
  toolset.setAccessPolicy?.({ developerMode: true, workspaceRoots });
  return toolset;
}

async function fileWith(name, contents) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

// ---------------------------------------------------------------------------
// edit_file, several changes at once

test("several edits to one file are applied in one call", async () => {
  const toolset = harness();
  const target = await fileWith("batch.js", "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  const outcome = await toolset.execute("edit_file", {
    path: target,
    edits: [
      { old: "const a = 1;", new: "const a = 10;" },
      { old: "const c = 3;", new: "const c = 30;" }
    ]
  });

  assert.equal(outcome.raw.evidence.verdict, CONFIRMED);
  assert.equal(outcome.raw.edits, 2);
  assert.equal(await fs.readFile(target, "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n");
});

test("one bad edit in a batch changes no bytes at all", async () => {
  const toolset = harness();
  const before = "const a = 1;\nconst b = 2;\n";
  const target = await fileWith("atomic.js", before);

  const outcome = await toolset.execute("edit_file", {
    path: target,
    edits: [
      { old: "const a = 1;", new: "const a = 10;" },
      { old: "const NOPE = 9;", new: "irrelevant" }
    ]
  });

  // THE POINT OF THE WHOLE FEATURE. Edit 1 was perfectly valid; applying it and
  // then failing would leave a file that is neither the old shape nor the new
  // one, and the model would have to work out which of its own edits landed.
  assert.equal(await fs.readFile(target, "utf8"), before, "a failed batch must leave the file untouched");
  assert.match(outcome.text, /edit 2 of 2/, "the refusal must say WHICH edit failed");
  assert.match(outcome.text, /NOTHING was changed/);
});

test("a failed edit names the closest lines actually in the file", async () => {
  const toolset = harness();
  const target = await fileWith("near.js", "function startServer(port) {\n  return listen(port);\n}\n");

  // Reconstructed from memory with the wrong spacing — the commonest way an
  // anchor misses, and the one a plain "not found" leaves the model stuck on.
  const outcome = await toolset.execute("edit_file", {
    path: target,
    old: "function startServer( port ) {",
    new: "function startServer(port, host) {"
  });

  assert.match(outcome.text, /closest lines actually in the file/);
  assert.match(outcome.text, /function startServer\(port\) \{/);
});

test("an ambiguous anchor is refused, and all: true accepts it", async () => {
  const toolset = harness();
  const target = await fileWith("ambiguous.js", "log('x');\nlog('x');\n");

  const refused = await toolset.execute("edit_file", { path: target, old: "log('x');", new: "log('y');" });
  assert.match(refused.text, /appears 2 times/);
  assert.equal(await fs.readFile(target, "utf8"), "log('x');\nlog('x');\n");

  const accepted = await toolset.execute("edit_file", {
    path: target, old: "log('x');", new: "log('y');", all: true
  });
  assert.equal(accepted.raw.evidence.verdict, CONFIRMED);
  assert.equal(await fs.readFile(target, "utf8"), "log('y');\nlog('y');\n");
});

test("edits can build on each other in order", async () => {
  const toolset = harness();
  const target = await fileWith("chain.js", "const name = 'old';\n");

  // The second anchor only exists because the first edit created it. Resolving
  // every edit against the ORIGINAL content would fail here, and that is a real
  // shape: rename a symbol, then change the line that now mentions it.
  await toolset.execute("edit_file", {
    path: target,
    edits: [
      { old: "const name = 'old';", new: "const name = 'new';\nexport { name };" },
      { old: "export { name };", new: "export { name as label };" }
    ]
  });
  assert.equal(await fs.readFile(target, "utf8"), "const name = 'new';\nexport { name as label };\n");
});

test("neither old/new nor edits is a refusal that says which shape to use", async () => {
  const toolset = harness();
  const target = await fileWith("empty-call.js", "anything\n");
  const outcome = await toolset.execute("edit_file", { path: target });
  assert.match(outcome.text, /either `old` and `new`, or an `edits` array/);
  assert.equal(await fs.readFile(target, "utf8"), "anything\n");
});

// ---------------------------------------------------------------------------
// find_files and search_code, through the toolset

test("find_files reports a real match and a real absence differently", async () => {
  const toolset = harness({ workspaceRoots: [root] });
  await fileWith("src/server.js", "export const port = 4317;\n");

  const found = await toolset.execute("find_files", { glob: "src/*.js" });
  assert.equal(found.raw.evidence.verdict, CONFIRMED);
  assert.match(found.text, /src\/server\.js/);

  // FINDING NOTHING IS AN ANSWER. Rendering it as a failure is how a working
  // tool teaches the model to go and try PowerShell instead.
  const missing = await toolset.execute("find_files", { glob: "**/*.rs" });
  assert.equal(missing.raw.evidence.verdict, CONFIRMED, "an honest empty result is still confirmed");
  assert.match(missing.text, /No file matches/);
  assert.doesNotMatch(missing.text, /could not|failed/i);
});

test("search_code groups matches by file and gives line numbers", async () => {
  const toolset = harness({ workspaceRoots: [root] });
  await fileWith("src/one.js", "const port = 4317;\nlisten(port);\n");
  await fileWith("src/two.js", "// port again\n");

  const found = await toolset.execute("search_code", { query: "port" });
  assert.equal(found.raw.evidence.verdict, CONFIRMED);
  assert.match(found.text, /src\/one\.js/);
  assert.match(found.text, /\n\s+1: const port = 4317;/);
  assert.ok(found.raw.fileCount >= 2);
});

test("the attached folder is the default root, and without one it refuses", async () => {
  await fileWith("src/only-here.js", "marker\n");

  const attached = harness({ workspaceRoots: [root] });
  const found = await attached.execute("search_code", { query: "marker" });
  assert.match(found.text, /only-here\.js/);

  // A code search with no root is the one that walks a whole user profile. The
  // refusal costs one step; the walk costs the request.
  const detached = harness({ workspaceRoots: [] });
  const refused = await detached.execute("search_code", { query: "marker" });
  assert.match(refused.text, /needs somewhere to look/);
  assert.match(refused.text, /Attach the folder with \+/);
});

// ---------------------------------------------------------------------------
// project — the edit / run / read loop

async function nodeProject(name, packageJson) {
  const projectRoot = path.join(root, name);
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify(packageJson));
  return projectRoot;
}

test("project runs the command the manifest declares, not one the model chose", async () => {
  const ran = [];
  const projectRoot = await nodeProject("app", { scripts: { test: "node --test", lint: "eslint ." } });
  await fs.writeFile(path.join(projectRoot, "package-lock.json"), "{}");
  const toolset = harness({ ran, workspaceRoots: [projectRoot] });

  await toolset.execute("project", { action: "test" });
  // THE SAFETY PROPERTY IN ONE ASSERTION. The model asked for "test"; the string
  // that reached the shell came from package.json plus the lockfile.
  assert.deepEqual(ran.map((call) => call.command), ["npm test"]);
  assert.equal(ran[0].cwd, projectRoot);
});

test("the lockfile decides the package manager", async () => {
  const ran = [];
  const projectRoot = await nodeProject("pnpm-app", { scripts: { build: "tsc" } });
  await fs.writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const toolset = harness({ ran, workspaceRoots: [projectRoot] });

  await toolset.execute("project", { action: "build" });
  // Running `npm run build` here would rewrite the dependency tree into a shape
  // the project does not use, and the eventual error would be about a missing
  // module rather than about the wrong tool.
  assert.deepEqual(ran.map((call) => call.command), ["pnpm run build"]);
});

test("a script the manifest does not declare is refused by name", async () => {
  const ran = [];
  const projectRoot = await nodeProject("scripted", { scripts: { test: "node --test", e2e: "playwright test" } });
  const toolset = harness({ ran, workspaceRoots: [projectRoot] });

  const outcome = await toolset.execute("project", { action: "script", script: "rm -rf /" });
  assert.equal(ran.length, 0, "nothing may run when the script is not declared");
  assert.match(outcome.text, /declares no script called "rm -rf \/"/);
  // Naming what IS available is what lets the model recover in one step rather
  // than guessing again.
  assert.match(outcome.text, /test, e2e/);
});

test("an action the project has no script for says so rather than running something", async () => {
  const ran = [];
  const projectRoot = await nodeProject("bare", { scripts: { start: "node ." } });
  const toolset = harness({ ran, workspaceRoots: [projectRoot] });

  const outcome = await toolset.execute("project", { action: "test" });
  assert.equal(ran.length, 0);
  assert.match(outcome.text, /declares no way to test/);
});

test("a failing check is a confirmed answer, not a failed tool", async () => {
  const projectRoot = await nodeProject("failing", { scripts: { test: "node --test" } });
  const toolset = harness({
    workspaceRoots: [projectRoot],
    exitCode: 1,
    stdout: "not ok 3 - the thing works\n# tests 3\n# fail 1\n"
  });

  const outcome = await toolset.execute("project", { action: "test" });
  // The most useful result this tool produces. A test suite that exits 1 has
  // run and told the truth; rendering that as a broken tool would send the model
  // looking for another way to run the tests.
  assert.equal(outcome.raw.evidence.verdict, CONFIRMED);
  assert.match(outcome.text, /FAILED with exit 1/);
  assert.match(outcome.text, /not ok 3/);
});

test("a passing check says so plainly", async () => {
  const projectRoot = await nodeProject("passing", { scripts: { test: "node --test" } });
  const toolset = harness({ workspaceRoots: [projectRoot], exitCode: 0, stdout: "# pass 12\n" });
  const outcome = await toolset.execute("project", { action: "test" });
  assert.match(outcome.text, /passed \(exit 0\)/);
});

test("inspect lists what a project can run without running anything", async () => {
  const ran = [];
  const projectRoot = await nodeProject("inspectable", { scripts: { test: "node --test", lint: "eslint ." } });
  const toolset = harness({ ran, workspaceRoots: [projectRoot] });

  const outcome = await toolset.execute("project", { action: "inspect" });
  assert.equal(ran.length, 0);
  assert.match(outcome.text, /node project/);
  assert.match(outcome.text, /test: npm test/);
  assert.match(outcome.text, /lint: npm run lint/);
});

test("a folder with no manifest is refused rather than guessed at", async () => {
  const projectRoot = path.join(root, "not-a-project");
  await fs.mkdir(projectRoot, { recursive: true });
  const toolset = harness({ workspaceRoots: [projectRoot] });

  const outcome = await toolset.execute("project", { action: "test" });
  assert.match(outcome.text, /not a project I know how to run/);
});

test("saying no to the approval card stops the command", async () => {
  const ran = [];
  const asked = [];
  const projectRoot = await nodeProject("guarded", { scripts: { test: "node --test" } });
  const toolset = harness({ ran, asked, approve: false, workspaceRoots: [projectRoot] });

  const outcome = await toolset.execute("project", { action: "test" });
  assert.equal(ran.length, 0, "a refused command must not reach the shell");
  assert.ok(asked.length > 0, "running a project command is still an approval, not a bypass");
  assert.match(outcome.text, /said NO/);
});

test("a search glob narrows what is read, through the tool as well", async () => {
  const toolset = harness({ workspaceRoots: [root] });
  await fileWith("src/a.js", "needle\n");
  await fileWith("docs/a.md", "needle\n");

  const scoped = await toolset.execute("search_code", { query: "needle", glob: "**/*.md" });
  assert.match(scoped.text, /docs\/a\.md/);
  assert.doesNotMatch(scoped.text, /src\/a\.js/);
});
