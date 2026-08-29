import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const npmExecPath = String(process.env.npm_execpath ?? "").trim();
const command = process.platform === "win32" && npmExecPath ? process.execPath : "npm";
const commandArgs = process.platform === "win32" && npmExecPath
  ? [npmExecPath, "sbom", "--sbom-format", "cyclonedx"]
  : ["sbom", "--sbom-format", "cyclonedx"];
const { stdout } = await run(command, commandArgs, { maxBuffer: 64 * 1024 * 1024 });
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/sbom.cdx.json", stdout);
console.log("Generated artifacts/sbom.cdx.json");
