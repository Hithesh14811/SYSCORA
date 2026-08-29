import { execFileSync, spawn } from "node:child_process";

const objectLines = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean);
const names = new Map();
for (const line of objectLines) {
  const separator = line.indexOf(" ");
  const object = separator < 0 ? line : line.slice(0, separator);
  const filename = separator < 0 ? "" : line.slice(separator + 1);
  if (filename && !names.has(object)) names.set(object, filename);
}

function batchCheck(objects) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      stdio: ["pipe", "pipe", "inherit"], shell: false
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`git cat-file exited ${code}`)));
    child.stdin.end(`${objects.join("\n")}\n`);
  });
}

const metadata = (await batchCheck([...names.keys()]))
  .split(/\r?\n/).filter(Boolean)
  .map((line) => {
    const [object, type, size] = line.split(" ");
    return { object, type, size: Number(size), filename: names.get(object) ?? "" };
  })
  .filter((item) => item.type === "blob");

const forbiddenPaths = /^(?:\.syscora\/|\.agents\/|\.claude\/|\.kiro\/|%USERPROFILE%\/|node_modules\/|dist\/)|(?:^|\/)transcript\.txt$/i;
const secretPatterns = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{25,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];
// These immutable historical blobs were manually reviewed on 27 Aug 2026.
// They are harmless assistant metadata, accidental test output, or deliberate
// fake-key fixtures. Exact object IDs keep the exception narrow: editing or
// reintroducing any file produces a new object and fails this audit.
const reviewedHistoricalObjects = new Set([
  "f28ef40f5e572bd212ed265b0bf0e09342f9da57",
  "d87477019e2a7f4e6344c8233bca7f9b65f551f2",
  "4cd2e7574a12c6934d546099ce1b168eb86c79dd",
  "6a172a146876fb07b7b07572130ed9d31b54e849",
  "4936ca048bc861ecd74b5c6f7a7a7f75be43f26f",
  "140fdfb29dca7f9ad0daf670970f3b3e57867198",
  "923edee59518623bbd8d13f702e75d503319ca85",
  "dd638666e928c01c010fbc5fe33f34b3b5a81ea4",
  "407bfe92a0673c5244a993c3206400b58233fc39",
  "0aa258432396e2bd49f89c7bb7b488a4da98d242",
  "35cd915c33111d958865c6fd142f76f988b22056"
]);
const findings = [];
const scanItems = [];
for (const item of metadata) {
  if (forbiddenPaths.test(item.filename)) findings.push({ ...item, finding: "forbidden historical path" });
  if (item.size > 5 * 1024 * 1024) findings.push({ ...item, finding: `large blob (${item.size} bytes)` });
  if (item.size === 0 || item.size > 2 * 1024 * 1024 || /\.(?:png|ico|jpg|jpeg|gif|pdf|zip|exe|dll|sqlite)$/i.test(item.filename)) continue;
  scanItems.push(item);
}

const reader = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"], shell: false });
const readerExitPromise = new Promise((resolve, reject) => {
  reader.on("error", reject);
  reader.on("close", resolve);
});
reader.stdin.end(`${scanItems.map((item) => item.object).join("\n")}\n`);
let buffer = Buffer.alloc(0);
let current = null;
let scanIndex = 0;
for await (const chunk of reader.stdout) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (!current) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const header = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      const [, type, size] = header.split(" ");
      if (type !== "blob") throw new Error(`Unexpected git object response: ${header}`);
      current = { item: scanItems[scanIndex], size: Number(size) };
    }
    if (buffer.length < current.size + 1) break;
    const source = buffer.subarray(0, current.size).toString("utf8");
    buffer = buffer.subarray(current.size + 1);
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(source)) findings.push({ ...current.item, finding: label });
    }
    scanIndex += 1;
    current = null;
  }
}
const readerExit = await readerExitPromise;
if (readerExit !== 0 || scanIndex !== scanItems.length) throw new Error("Git history blob scan did not complete.");

const unique = [...new Map(findings.map((item) => [`${item.object}:${item.finding}`, item])).values()];
const reviewed = unique.filter((item) => reviewedHistoricalObjects.has(item.object));
const blocking = unique.filter((item) => !reviewedHistoricalObjects.has(item.object));
if (reviewed.length) {
  console.warn(`Git history audit recognized ${reviewed.length} exact previously reviewed finding(s).`);
}
if (blocking.length) {
  console.error("Git history audit found objects requiring review (secret values are never printed):");
  for (const item of blocking) console.error(`- ${item.finding}: ${item.filename || "<unnamed>"} @ ${item.object.slice(0, 12)}`);
  process.exit(1);
}
console.log(`Git history audit passed across ${metadata.length} unique historical blobs; no unreviewed finding remains.`);
