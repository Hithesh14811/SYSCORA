// Can the agent find a folder and then actually open a file inside it?
//
// It could not. Every path it was shown had the home directory rewritten to the
// literal text %USERPROFILE%, so it echoed that back into PowerShell, which does
// not expand %VAR% — and the string was taken as relative:
//
//   Cannot find path 'C:\...\SYSCORA\%USERPROFILE%\OneDrive\Documents\check\...'
//
// This walks the real round trip: run a command, take the path OUT of the result
// exactly as the model would see it, and use it. If the sanitizer breaks paths
// again, the second step fails here instead of in front of the user.
//
//   node scripts/probe-real-paths.mjs

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { sanitizeExternalContext } from "../packages/shared-types/src/external-context.js";

const results = [];
const check = (name, passed, detail) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ").slice(0, 400)}` : ""}`);
};

const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });

// A file of our own under the home directory, so nothing of the user's is touched.
const dir = await fs.mkdtemp(path.join(os.homedir(), "syscora-path-probe-"));
const file = path.join(dir, "sample.txt");
await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

try {
  // 1. Find it the way the agent does — through a command.
  const listed = await toolset.execute("run", {
    command: `Get-ChildItem -Path "${dir}" -File | Select-Object -ExpandProperty FullName`
  });
  // 2. This is the crucial line: what the MODEL receives, not what the tool returned.
  const asModelSees = sanitizeExternalContext(listed.text);
  console.log(`      model is shown: ${asModelSees.trim()}`);
  check("the path the model receives is a real path", !/%USERPROFILE%/.test(asModelSees), asModelSees.trim());

  const quoted = asModelSees.trim().split(/\r?\n/).find((line) => line.includes("sample.txt")) ?? "";

  // 3. Use that exact string, as the model would.
  const read = await toolset.execute("read_file", { path: quoted });
  check("reading the file at that path works", read.ok && /beta/.test(read.text), read.text.slice(0, 200));

  const edited = await toolset.execute("edit_file", { path: quoted, old: "beta", new: "BETA" });
  check("editing the file at that path works", edited.ok, edited.text);

  const after = await fs.readFile(file, "utf8");
  check("the edit really landed on disk", after.includes("BETA") && !after.includes("\nbeta"), JSON.stringify(after));

  // 4. And the same string through the shell, which is where it broke before.
  const shell = await toolset.execute("run", { command: `Get-Content "${quoted}" | Select-Object -First 1` });
  check("the shell accepts the path the model was shown", shell.ok && /alpha/.test(shell.text), shell.text.slice(0, 200));
} catch (error) {
  check("the probe ran to completion", false, error?.stack ?? String(error));
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
