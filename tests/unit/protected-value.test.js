// The model key used to sit in plaintext in config.json, beside a DPAPI store
// that was already constructed and used for other things. The demonstrated cost
// was not theft — a session dumped that config into a transcript to check a
// setting, and the live key went with it.
//
// These pin the two halves that can go wrong: the reference form (which is pure
// string handling and must refuse to read outside its directory, because it
// reads a file named by a config the agent itself can be asked to edit), and
// the actual encrypt/decrypt round trip, which is the only thing that proves a
// migrated key can still be read back.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROTECTED_PREFIX, isProtectedReference, protectToFile, readProtectedFileSync, resolveProtectedValue
} from "../../packages/secrets/src/protected-value.js";

test("a plain value is left alone, because migration is opt-in", () => {
  assert.equal(isProtectedReference("sk-abc123"), false);
  assert.equal(resolveProtectedValue("sk-abc123", { baseDirectory: "C:\\nowhere" }), "sk-abc123");
  assert.equal(resolveProtectedValue(null, { baseDirectory: "C:\\nowhere" }), null);
  assert.equal(resolveProtectedValue(undefined, { baseDirectory: "C:\\nowhere" }), undefined);
});

test("a reference is recognised by its prefix and nothing else", () => {
  assert.equal(isProtectedReference(`${PROTECTED_PREFIX}model-primary.bin`), true);
  assert.equal(isProtectedReference("DPAPI:model-primary.bin"), false, "the prefix is exact, not fuzzy");
  assert.equal(isProtectedReference(42), false);
});

test("a reference cannot name a file outside the secrets directory", () => {
  // This reads a path out of a config file, and the agent can be asked to edit
  // config files. A reference is a NAME, not a path.
  for (const escape of ["../../config.json", "..\\..\\config.json", "C:\\Windows\\win.ini", "/etc/passwd"]) {
    assert.throws(
      () => resolveProtectedValue(`${PROTECTED_PREFIX}${escape}`, { baseDirectory: os.tmpdir() }),
      /plain file name/,
      `"${escape}" should be refused`
    );
  }
});

test("a missing protected file says so rather than returning nothing", () => {
  assert.throws(
    () => resolveProtectedValue(`${PROTECTED_PREFIX}not-there.bin`, { baseDirectory: os.tmpdir() }),
    /missing/
  );
});

// The real thing. Windows-only by nature — DPAPI is a Windows API — so it is
// skipped rather than failed elsewhere, and the skip is visible.
test("a value survives the round trip through DPAPI and back", { skip: process.platform !== "win32" ? "DPAPI is Windows-only" : false }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-dpapi-"));
  try {
    const target = path.join(directory, "round-trip.bin");
    const secret = "ab12CDef.QrsT7uVwXy9zAbCdEf1GhIjKlMnOpQr";
    await protectToFile(target, secret);

    // The file on disk must not be the value. This is the entire point.
    const onDisk = fsSync.readFileSync(target);
    assert.ok(!onDisk.toString("utf8").includes(secret), "the file still contains the plaintext");
    assert.ok(onDisk.length > 0);

    assert.equal(readProtectedFileSync(target), secret);
    assert.equal(resolveProtectedValue(`${PROTECTED_PREFIX}round-trip.bin`, { baseDirectory: directory }), secret);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a corrupted protected file fails loudly and says what to do", { skip: process.platform !== "win32" ? "DPAPI is Windows-only" : false }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-dpapi-bad-"));
  try {
    const target = path.join(directory, "corrupt.bin");
    await fs.writeFile(target, Buffer.from([1, 2, 3, 4, 5]));
    assert.throws(
      () => readProtectedFileSync(target),
      // The message has to name the recovery, because the failure people
      // actually hit — a different Windows user, a restored profile — is
      // unrecoverable and silent otherwise.
      /could not be decrypted[\s\S]*protect-model-key/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
