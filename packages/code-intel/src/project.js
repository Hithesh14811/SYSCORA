// What kind of project is this, and how do you run its tests.
//
// THE LOOP THAT WAS MISSING. The agent could read a file and change a file, and
// had no way to find out whether the change worked. That is not a small gap: it
// is the difference between an assistant that edits code and one that can be
// trusted to have finished. Every coding tool people compare this to closes the
// same loop — edit, run the project's own checks, read what broke, fix it.
//
// THE MODEL DOES NOT GET TO CHOOSE THE COMMAND, AND THAT IS THE SAFETY PROPERTY.
//
// The obvious way to do this is a shell tool, and the shell is off by default
// for good reasons. So `project` takes an ACTION — test, lint, build, install —
// and resolves it against the project's own manifest. `npm test` is whatever the
// user already wrote in their package.json; the agent cannot invent a command,
// only pick from the ones the repository declares. A `script` that is not in the
// manifest is refused by name rather than passed through.
//
// That makes this narrower than a terminal in exactly the way that matters:
// the set of runnable strings is finite, enumerable, and written by the user.

import fs from "node:fs/promises";
import path from "node:path";

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
};

const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

// WHICH PACKAGE MANAGER, DECIDED BY THE LOCKFILE RATHER THAN BY PREFERENCE.
//
// Running `npm ci` in a pnpm workspace does not merely fail — it rewrites the
// dependency tree into a shape the project does not use, and the error the user
// eventually sees is about a missing module rather than about the wrong tool.
// The lockfile is the project saying which one it is, and it is never ambiguous.
const NODE_LOCKFILES = Object.freeze([
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"]
]);

async function nodeRunner(root) {
  for (const [lockfile, runner] of NODE_LOCKFILES) {
    if (await exists(path.join(root, lockfile))) return runner;
  }
  return "npm";
}

/**
 * What this project is and what can be run in it.
 *
 * Returns `null` when there is no manifest at all, which the tool reports as
 * "this is not a project I know how to run" rather than guessing at `make`.
 */
export async function detectProject(rootDirectory) {
  const root = path.resolve(String(rootDirectory ?? process.cwd()));

  const packageJson = await readJson(path.join(root, "package.json"));
  if (packageJson) {
    const runner = await nodeRunner(root);
    const scripts = packageJson.scripts ?? {};
    // `npm run test` and `npm test` are not the same to every runner, and the
    // lifecycle names are the ones with a shorthand. Using the shorthand is what
    // the user types themselves.
    const invoke = (name) => (["test", "start"].includes(name)
      ? `${runner} ${name}`
      : `${runner} run ${name}`);
    return {
      root,
      kind: "node",
      manifest: "package.json",
      runner,
      scripts: Object.keys(scripts),
      commands: {
        install: runner === "npm" ? "npm install" : `${runner} install`,
        // Only offered when the project actually declares them. A `test` action
        // on a project with no test script must say "there is no test script"
        // rather than run something that exits 1 for an unrelated reason.
        test: scripts.test ? invoke("test") : null,
        lint: scripts.lint ? invoke("lint") : null,
        build: scripts.build ? invoke("build") : null,
        start: scripts.start ? invoke("start") : (scripts.dev ? invoke("dev") : null)
      },
      invoke
    };
  }

  const pyproject = await exists(path.join(root, "pyproject.toml"));
  const requirements = await exists(path.join(root, "requirements.txt"));
  if (pyproject || requirements) {
    return {
      root,
      kind: "python",
      manifest: pyproject ? "pyproject.toml" : "requirements.txt",
      runner: "python",
      scripts: [],
      commands: {
        install: requirements ? "python -m pip install -r requirements.txt" : "python -m pip install -e .",
        test: "python -m pytest",
        lint: "python -m ruff check .",
        build: pyproject ? "python -m build" : null,
        start: null
      },
      invoke: null
    };
  }

  if (await exists(path.join(root, "Cargo.toml"))) {
    return {
      root,
      kind: "rust",
      manifest: "Cargo.toml",
      runner: "cargo",
      scripts: [],
      commands: {
        install: "cargo fetch",
        test: "cargo test",
        lint: "cargo clippy",
        build: "cargo build",
        start: "cargo run"
      },
      invoke: null
    };
  }

  if (await exists(path.join(root, "go.mod"))) {
    return {
      root,
      kind: "go",
      manifest: "go.mod",
      runner: "go",
      scripts: [],
      commands: {
        install: "go mod download",
        test: "go test ./...",
        lint: "go vet ./...",
        build: "go build ./...",
        start: "go run ."
      },
      invoke: null
    };
  }

  // Makefile last, because a repository with a Makefile usually has a real
  // manifest too and the manifest is the more specific answer.
  if (await exists(path.join(root, "Makefile"))) {
    return {
      root,
      kind: "make",
      manifest: "Makefile",
      runner: "make",
      scripts: [],
      commands: { install: null, test: "make test", lint: "make lint", build: "make", start: null },
      invoke: null
    };
  }

  return null;
}

// Lines worth pulling out of a thousand-line test run.
//
// WHY THE TAIL IS NOT ENOUGH ON ITS OWN. A failing test suite prints its
// failures as it goes and its summary at the end, and the summary says "3
// failing" without saying which. Handing the model the last 2,000 characters
// gives it the count and not one of the reasons. Handing it the whole log costs
// more than the task. So: the failing lines, then the tail.
const FAILURE_LINE =
  /^(?:\s*)(?:not ok\b|FAIL\b|FAILED\b|ERROR\b|error\b|✗|✖|×|AssertionError|Error:|\S+Error:|\s+at .*Error)|(?:^|\s)(?:\d+\s+(?:failing|failed|error))|(?:^|\s)error(?:\[[A-Z0-9]+\])?:/;

/**
 * Turn a command's output into something a model can act on.
 *
 * `exitCode` is the verdict and the text is the reason. The two are kept
 * separate on purpose: a test run that exits 1 has FAILED even if nothing in its
 * output matched a pattern here, and a run that exits 0 has passed even if the
 * word "error" appears in a filename.
 */
export function summariseRun({ stdout = "", stderr = "", exitCode = 0, maxChars = 2400 } = {}) {
  const whole = [String(stdout ?? ""), String(stderr ?? "")].filter((part) => part.trim()).join("\n");
  const lines = whole.split(/\r?\n/);
  if (whole.length <= maxChars) return { text: whole.trim(), clipped: false, failureLines: [] };

  const failures = [];
  for (const line of lines) {
    if (failures.length >= 40) break;
    if (FAILURE_LINE.test(line) && line.trim()) failures.push(line.trim().slice(0, 300));
  }
  // The end of the log, which is where every runner puts its summary.
  const tail = [];
  let budget = Math.max(600, maxChars - failures.join("\n").length);
  for (let index = lines.length - 1; index >= 0 && budget > 0; index -= 1) {
    const line = lines[index];
    budget -= line.length + 1;
    tail.unshift(line);
  }
  return {
    text: [
      failures.length ? `${failures.length} line(s) that look like failures:\n${failures.join("\n")}` : null,
      `…last ${tail.length} line(s) of ${lines.length}:\n${tail.join("\n")}`
    ].filter(Boolean).join("\n\n"),
    clipped: true,
    failureLines: failures
  };
}
