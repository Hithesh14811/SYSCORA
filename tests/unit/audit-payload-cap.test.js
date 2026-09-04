// AN APPEND-ONLY LOG WITH NO BOUND ON A ROW IS AN UNBOUNDED FILE.
//
// Measured on the real installation, 4 Sep 2026: `audit.sqlite` is 402 MB over
// 378,680 rows, 242 MB of it payload, with ZERO free pages — all of it live. It
// is the largest file this product writes and nothing had ever bounded it. The
// distribution is the same shape the session store had:
//
//   OBSERVATION_COLLECTED   1,034 rows    42 MB    ~40 KB per row
//   FAILURE_DIAGNOSED         351 rows    35 MB   ~100 KB per row
//
// A handful of rows carrying whole screen readings, in a table whose other
// 375,000 rows are small.
//
// The obvious answer — retention — is not available and would be wrong: this is
// a hash chain with an anchor, so deleting from the middle breaks verification by
// design and truncating the tail is what the anchor exists to detect. A cap is
// available, and the property that makes it safe is what the first test here
// pins: THE CHAIN MUST STILL VERIFY. If capping ever moved the hash off what is
// stored, this log would stop being tamper-evident, which is a far worse outcome
// than a large file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditRepository } from "../../packages/audit/src/index.js";

async function repository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-audit-cap-"));
  return { repo: new AuditRepository(directory), directory };
}

test("a capped payload leaves the chain verifiable", async () => {
  const { repo } = await repository();
  await repo.append("s1", "SMALL", { ok: true });
  await repo.append("s1", "OBSERVATION_COLLECTED", { reading: "x".repeat(200_000) });
  await repo.append("s1", "SMALL_AGAIN", { ok: true });

  const verified = await repo.verifyChain();
  assert.equal(verified.valid, true, "capping must not break tamper-evidence");
  assert.equal(verified.length, 3);
  repo.close?.();
});

test("an oversized payload is actually reduced", async () => {
  const { repo } = await repository();
  await repo.append("s1", "OBSERVATION_COLLECTED", { reading: "x".repeat(200_000) });
  const [event] = await repo.readAll();
  assert.ok(
    JSON.stringify(event.payload).length < 64 * 1024,
    `still ${JSON.stringify(event.payload).length} bytes — the cap did nothing`
  );
  repo.close?.();
});

// A ROW THAT QUIETLY LOST ITS EVIDENCE IS INDISTINGUISHABLE FROM ONE THAT NEVER
// HAD ANY. The same rule as the 256 KB cap in SessionStore, and the reason it
// records the trim in the row rather than beside it.
test("a capped payload says so, and says how much is missing", async () => {
  const { repo } = await repository();
  await repo.append("s1", "OBSERVATION_COLLECTED", { reading: "x".repeat(200_000) });
  const [event] = await repo.readAll();
  assert.equal(event.payload.truncated, true);
  assert.ok(event.payload.originalBytes > 200_000);
  assert.match(event.payload.note, /trimmed/i);
  // The beginning survives, so what the event WAS is still readable.
  assert.ok(String(event.payload.head ?? "").length > 1_000);
  repo.close?.();
});

// THE CAP MUST NOT TOUCH ORDINARY EVENTS. Almost every row in that 378,680 is
// small, and a cap that rewrote them would destroy the log's usefulness to save
// nothing.
test("an ordinary event is stored exactly as it was", async () => {
  const { repo } = await repository();
  const payload = { command: "git status", exitCode: 0, tool: "git", nested: { a: [1, 2, 3] } };
  await repo.append("s1", "TOOL_FINISHED", payload);
  const [event] = await repo.readAll();
  assert.equal(event.payload.truncated, undefined);
  assert.deepEqual(event.payload, payload);
  repo.close?.();
});
