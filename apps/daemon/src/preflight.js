// THE WHOLE PERSISTENCE LAYER IS ON AN EXPERIMENTAL API.
//
// `node:sqlite` backs eight production modules: sessions, audit, memory,
// approval tokens, capability grants, elevation grants, secrets and semantic
// state. Node prints "SQLite is an experimental feature and might change at any
// time" on every start, and it means it — the module landed in 22.5 and its
// surface is not covered by semver.
//
// So the risk is not that it breaks today. It is that somebody upgrades Node,
// `DatabaseSync` has moved or changed shape, and EVERY store fails at once,
// somewhere deep inside a constructor, with a stack trace about a database
// handle. The person reading that has no way to know the cause is their Node
// version.
//
// This turns that into one sentence, checked at start, by actually using the
// API rather than comparing version numbers — a version string is a proxy for
// "does this work", and the thing itself is right here and costs a millisecond.
//
// It WARNS rather than refusing to start. The house rule is that refusing to
// boot is usually worse than booting degraded, and a daemon that starts and
// says exactly what is wrong is more useful than one that will not start at
// all. But this is deliberately louder than the config warning beside it,
// because there is no degraded mode here: without persistence nothing works.

import { createRequire } from "node:module";

export const MINIMUM_NODE = "22.5.0";

/**
 * Does the persistence API this product is built on still behave?
 *
 * Returns `{ ok, reason }` rather than throwing, so the caller decides what a
 * failure means. Exported separately from the reporting so a test can exercise
 * both without a daemon.
 */
export function checkPersistenceSupport({ require: requireModule = createRequire(import.meta.url) } = {}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = requireModule("node:sqlite"));
  } catch (error) {
    return {
      ok: false,
      reason: `node:sqlite could not be loaded (${error?.message ?? error}). It was added in Node ${MINIMUM_NODE}; ` +
        `this process is running Node ${process.versions.node}.`
    };
  }
  if (typeof DatabaseSync !== "function") {
    return { ok: false, reason: `node:sqlite loaded but DatabaseSync is ${typeof DatabaseSync}, not a constructor.` };
  }
  // EXERCISE IT, DO NOT INSPECT IT. A constructor that exists is not a
  // constructor that works, and the shapes that would break this product are
  // exactly the ones a typeof check waves through.
  try {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE preflight (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO preflight (id, value) VALUES (?, ?)").run(1, "ok");
      const row = db.prepare("SELECT value FROM preflight WHERE id = ?").get(1);
      if (row?.value !== "ok") {
        return { ok: false, reason: `node:sqlite returned ${JSON.stringify(row)} for a row that was just written.` };
      }
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      reason: `node:sqlite is present but a write-then-read failed (${error?.message ?? error}). ` +
        "The API is experimental and changes between Node versions."
    };
  }
  return { ok: true, reason: `node:sqlite works on Node ${process.versions.node}` };
}

/**
 * Say so, once, at start. Returns whatever the check found so a caller can act.
 */
export function reportPreflight({ log = console.error, check = checkPersistenceSupport } = {}) {
  const result = check();
  if (!result.ok) {
    log(
      "SYSCORA: THE DATABASE LAYER IS NOT WORKING ON THIS NODE VERSION.\n" +
      `  ${result.reason}\n` +
      "  Sessions, the audit log, memory, approvals and stored secrets all use it, so nothing will be\n" +
      `  saved and most requests will fail. SYSCORA is tested on Node ${MINIMUM_NODE} and later; if you\n` +
      "  have just upgraded Node, that is almost certainly the cause."
    );
  }
  return result;
}
