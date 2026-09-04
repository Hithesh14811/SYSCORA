// A DELETE THAT NEVER GIVES THE DISK BACK IS NOT A RETENTION POLICY.
//
// Measured on the real installation, 4 Sep 2026: 169 sessions, 3.89 MB of live
// data, and an 89.98 MB file — 21,017 of its 21,967 pages free. The seven-day
// retention sweep had been running at every daemon start and doing its job
// exactly right; it deletes rows, SQLite keeps the pages on its freelist, and the
// file never moves off its high-water mark. So the store looked unbounded to
// anyone reading `du`, and the 256 KB per-row cap that exists to bound it was
// being judged against a number it does not control.
//
// `reclaim` is the missing half, and the thing worth testing is that it REFUSES:
// VACUUM rewrites the whole file, and made unconditional on the startup path it
// would be minutes of blocking I/O on the 1.4 GB store this codebase used to
// have. It has to decide from the numbers, not from a policy.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../../packages/agent-runtime/src/session-store.js";

async function storeWith(sessions) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "syscora-reclaim-"));
  const store = new SessionStore(directory);
  for (const session of sessions) await store.save(session);
  return { store, directory };
}

const session = (id, bytes) => ({
  sessionId: id,
  createdAt: new Date(Date.now() - 1000).toISOString(),
  updatedAt: new Date(Date.now() - 1000).toISOString(),
  currentState: "COMPLETED",
  filler: "x".repeat(bytes)
});

test("a file with little free space is left alone", async () => {
  const { store } = await storeWith([session("a", 1_000), session("b", 1_000)]);
  const result = await store.reclaim();
  assert.equal(result.vacuumed, false);
  assert.match(result.reason, /not enough free space/);
});

// THE COST OF A VACUUM IS THE SIZE OF WHAT SURVIVES, not the size of the file:
// it writes the live pages into a new one. A mostly-empty 4 GB file is cheap to
// reclaim; a full one is not. Without this, the startup sweep on a large store
// blocks the daemon for minutes.
test("a lot of live data is refused, however much free space there is", async () => {
  const { store } = await storeWith(
    Array.from({ length: 12 }, (_, index) => session(`s${index}`, 40_000))
  );
  await store.pruneBefore(new Date(Date.now() + 60_000));
  const result = await store.reclaim({ minFreeFraction: 0, maxLiveBytes: 0 });
  assert.equal(result.vacuumed, false);
  assert.match(result.reason, /too much live data/);
});

test("a mostly-empty file is rewritten, and the disk actually comes back", async () => {
  const { store } = await storeWith(
    Array.from({ length: 40 }, (_, index) => session(`s${index}`, 60_000))
  );
  const before = await store.stats();
  // Everything is older than a cutoff in the future, so this empties the store —
  // which is what the seven-day sweep does to a week-old conversation.
  await store.pruneBefore(new Date(Date.now() + 60_000));
  const afterDelete = await store.stats();
  assert.equal(afterDelete.sessions, 0);
  assert.equal(
    afterDelete.fileBytes, before.fileBytes,
    "SQLite must NOT return pages on DELETE — if this ever fails, reclaim is no longer needed"
  );

  const result = await store.reclaim();

  assert.equal(result.vacuumed, true);
  assert.ok(result.reclaimedBytes > 0, "the file has to actually get smaller");
  const afterVacuum = await store.stats();
  assert.ok(
    afterVacuum.fileBytes < before.fileBytes / 2,
    `the file should shrink a long way: ${before.fileBytes} -> ${afterVacuum.fileBytes}`
  );
});

// The conversations that survive a reclaim must survive it INTACT. A vacuum that
// loses a row is far worse than a file that is too big.
test("reclaiming does not lose a conversation", async () => {
  const { store } = await storeWith(
    Array.from({ length: 30 }, (_, index) => session(`s${index}`, 50_000))
  );
  await store.prune({ keepNewest: 3 });
  const kept = (await store.listSummaries({ limit: 100 })).map((row) => row.sessionId).sort();
  assert.equal(kept.length, 3);

  await store.reclaim({ minFreeFraction: 0 });

  const after = (await store.listSummaries({ limit: 100 })).map((row) => row.sessionId).sort();
  assert.deepEqual(after, kept);
  for (const id of kept) assert.ok(await store.get(id), `${id} must still be readable`);
});
