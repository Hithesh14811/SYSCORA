import fs from "node:fs/promises";
import path from "node:path";

const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const forbidden = /\b(?:AGPL|SSPL|BUSL|Commons Clause)\b/i;
const records = [];
const failures = [];
for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
  if (!location.startsWith("node_modules/")) continue;
  const manifestPath = path.join(location, "package.json");
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch {}
  const name = manifest.name ?? metadata.name ?? location.slice("node_modules/".length);
  const license = manifest.license ?? metadata.license ?? "UNKNOWN";
  records.push({ name, version: manifest.version ?? metadata.version ?? "unknown", license, location });
  if (String(name).startsWith("@syscora/")) continue;
  if (license === "UNKNOWN" || forbidden.test(String(license))) failures.push(`${name}@${manifest.version ?? metadata.version}: ${license}`);
}
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/licenses.json", `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: records }, null, 2)}\n`);
if (failures.length) {
  console.error(`Dependency license review failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`Reviewed ${records.length} dependency licenses; report: artifacts/licenses.json`);
