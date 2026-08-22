// ONE VALUE, ENCRYPTED AT REST, READ BACK WITHOUT AWAIT.
//
// The model API key sat in plaintext in config.json while WindowsSecretBroker
// (DPAPI) was constructed a few lines away and used for other things. Moving it
// mattered for one demonstrated reason above all: an agent session dumped the
// config into a transcript to check something, and the live key went with it.
// A config file holding `dpapi:model-primary.bin` leaks nothing when that
// happens again.
//
// DPAPI is not magic. It protects the file against another user on this machine
// and against a copy of it leaving — a backup, a sync folder, a transcript. It
// does NOT protect against code already running as this user, which can simply
// call Unprotect itself. That is the honest scope, and it is exactly the scope
// of the leak that prompted it.
//
// WHY SYNCHRONOUS. `loadModelConfig` is synchronous and `createRuntime` is
// called synchronously from eight places including the CLI and six test files.
// Making the key async would mean making all of that async, which is a wide
// change to a start path the eval and the desktop shell both depend on, to save
// a few hundred milliseconds once per process against a daemon that already
// spends 2.2s warming its automation host. So: `execFileSync`, once, at start.

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The prefix a config value uses to say "this is a reference, not a secret". */
export const PROTECTED_PREFIX = "dpapi:";

const escapePs = (value) => String(value).replace(/'/g, "''");

export function isProtectedReference(value) {
  return typeof value === "string" && value.startsWith(PROTECTED_PREFIX);
}

/**
 * Encrypt `plaintext` to `filePath` under the current user's DPAPI key.
 *
 * The plaintext is NEVER on the command line, where any process able to
 * enumerate command lines would see it. It goes through the child's environment
 * — not readable by other non-elevated users — and the child exits immediately.
 * Same technique as WindowsSecretBroker.storeSecret, deliberately: two ways of
 * doing this would be two things to get wrong.
 */
export async function protectToFile(filePath, plaintext) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$plain = $env:SYSCORA_SECRET_PLAINTEXT; " +
    "$bytes = [Text.Encoding]::UTF8.GetBytes($plain); " +
    "$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    `[IO.File]::WriteAllBytes('${escapePs(filePath)}',$prot)`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SYSCORA_SECRET_PLAINTEXT: String(plaintext) }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0
      ? resolve()
      // The error text is echoed WITHOUT the plaintext: PowerShell will happily
      // quote the failing value back at you.
      : reject(new Error(`DPAPI protect failed (exit ${code})${stderr ? `: ${stderr.split("\n")[0]}` : ""}`))));
  });

  // READ IT BACK BEFORE ANYONE RELIES ON IT.
  //
  // A protect that "succeeded" and produced a file that cannot be decrypted
  // would be discovered at the next daemon start, with the plaintext already
  // deleted from the config. Verified here, through the read path that will
  // actually be used, while the original is still in hand.
  const roundTripped = readProtectedFileSync(filePath);
  if (roundTripped !== String(plaintext)) {
    throw new Error("DPAPI wrote a file that does not decrypt back to the value it was given");
  }
  return filePath;
}

/**
 * Decrypt a file written by `protectToFile`. Throws with a message that says
 * what to do, because the failure mode people actually hit — a different
 * Windows user, or a restored profile — is unrecoverable and needs saying.
 */
export function readProtectedFileSync(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`the protected value at ${filePath} is missing`);
  }
  const script =
    "Add-Type -AssemblyName System.Security; " +
    `$prot = [IO.File]::ReadAllBytes('${escapePs(filePath)}'); ` +
    "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($prot,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // A hung PowerShell here would hang the daemon's start with no output at
      // all, which is the least debuggable failure this could have.
      timeout: 20000,
      windowsHide: true
    // No .trim() beyond the ends: a key is not whitespace-bearing, but Write
    // rather than Write-Output is used above precisely so nothing is added.
    }).trim();
  } catch (error) {
    throw new Error(
      `the protected value at ${filePath} could not be decrypted — DPAPI values are tied to the Windows ` +
      "user that wrote them, so a different account or a restored profile cannot read this one. " +
      `Re-run scripts/protect-model-key.mjs to write it again. (${error?.message ?? error})`
    );
  }
}

/**
 * Resolve a config value that may be a `dpapi:` reference. A plain value is
 * returned unchanged — migration is opt-in and a config that has not been
 * migrated must keep working exactly as it did.
 */
export function resolveProtectedValue(value, { baseDirectory }) {
  if (!isProtectedReference(value)) return value;
  const name = value.slice(PROTECTED_PREFIX.length);
  // Refuse a reference that tries to escape the directory it is scoped to. This
  // reads a file named by a config the agent itself can be asked to edit.
  if (name.includes("..") || path.isAbsolute(name)) {
    throw new Error(`a protected value reference must be a plain file name, got "${name}"`);
  }
  return readProtectedFileSync(path.join(baseDirectory, name));
}
