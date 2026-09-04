// DOES `screen {vision: true}` ACTUALLY PRODUCE A PICTURE OF A REAL WINDOW?
//
//   node scripts/probe-screen-vision.mjs notepad
//
// The unit tests prove the plumbing with a stub. This proves the half a stub
// cannot: that `adapter.captureScreen` returns a real PNG of the named window,
// that it survives the base64 round trip, and — the part worth checking — that
// the temp file is GONE afterwards. That file is a screenshot of the user's
// screen; leaving it in %TEMP% is a privacy leak nobody would ever go looking
// for, and it is exactly the kind of thing that works in a test and not in life.
//
// It also prints what the picture COSTS against what the reading costs, because
// the whole design rests on that ratio: text is the default and pixels are the
// exception, and the numbers are how anybody checks that is still the right way
// round.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildToolset } from "../packages/fast-agent/src/tools.js";
import { createDefaultCapabilityRegistry } from "../packages/capability-registry/src/index.js";
import { WindowsAdapter } from "../os-adapters/windows/src/windows-adapter.js";
import { IMAGE_TOKENS } from "../packages/fast-agent/src/context-budget.js";

const application = process.argv[2] ?? "notepad";
const adapter = new WindowsAdapter();
const toolset = buildToolset({ registry: createDefaultCapabilityRegistry(adapter), adapter, basePath: process.cwd() });
await adapter.automationHost?.warm?.();

const captureDir = path.join(os.tmpdir(), "syscora-m4");
const before = new Set(await fs.readdir(captureDir).catch(() => []));

// The text reading on its own, for the comparison.
const readStarted = Date.now();
const textOnly = await toolset.execute("screen", { application });
const readMs = Date.now() - readStarted;

// AND THE SAME LOOK WITH PIXELS. Told the toolset it may, exactly as the agent
// loop does on a vision-capable model.
toolset.setVisionAvailable(true);
const visionStarted = Date.now();
const withVision = await toolset.execute("screen", { application, vision: true });
const visionMs = Date.now() - visionStarted;

const attachment = withVision.raw?.imageAttachment ?? null;
const textTokens = Math.round(String(textOnly.text ?? "").length / 4);

console.log(`window            ${application}`);
console.log(`text reading      ${readMs}ms, ~${textTokens} tokens`);
console.log(`with a picture    ${visionMs}ms, ~${textTokens + IMAGE_TOKENS} tokens (the image is ~${IMAGE_TOKENS})`);
console.log("");

if (!attachment) {
  console.log("NO PICTURE.");
  const why = withVision.raw ?? {};
  console.log(
    why.visionUnavailable
      ? "  visionUnavailable — the toolset was told the model cannot see. That is this probe's bug, not the product's."
      : why.visionTooLarge
        ? `  visionTooLarge — ${why.visionTooLarge.toLocaleString()} bytes. The whole desktop, not one window, and over what any provider accepts.`
        : "  visionFailed — adapter.captureScreen returned nothing for that window.");
} else {
  const bytes = Buffer.from(attachment.data, "base64");
  // A PNG starts with these eight bytes. Checking the magic number rather than
  // the length, because a zero-length or truncated capture is exactly the shape
  // of failure that a length check would pass.
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log(`picture           ${attachment.mediaType}, ${bytes.length.toLocaleString()} bytes`);
  console.log(`valid PNG header  ${isPng ? "yes" : "NO — the capture is truncated or empty"}`);
  console.log(`base64 round trip ${bytes.length === (attachment.bytes ?? -1) ? "exact" : "MISMATCH"}`);
}

const after = new Set(await fs.readdir(captureDir).catch(() => []));
const left = [...after].filter((name) => !before.has(name));
console.log("");
console.log(`temp files left   ${left.length === 0 ? "none — the capture was deleted" : `LEAKED: ${left.join(", ")}`}`);

// And the refusal path, which is the one that must never be silent: a model with
// no eyes must be told plainly, not handed the same reading with nothing said.
toolset.setVisionAvailable(false);
const blind = await toolset.execute("screen", { application, vision: true });
console.log(`blind model says  ${/cannot look at images/.test(blind.text) ? "so, in the result" : "NOTHING — silent failure"}`);

adapter.close?.();
process.exit(0);
