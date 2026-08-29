import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["apps", "packages", "os-adapters", "scripts", "tests"];
const extensions = new Set([".js", ".mjs", ".cjs"]);
const files = [];

async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "artifacts"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(target);
  }
}

for (const root of roots) await visit(root);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}\n${result.stderr || result.stdout}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Syntax-checked ${files.length} JavaScript modules.`);
