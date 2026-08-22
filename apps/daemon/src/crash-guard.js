// WHEN THE DAEMON DIES HALFWAY THROUGH CHANGING SOMEBODY'S COMPUTER.
//
// There were no crash guards anywhere in this repository — zero
// `uncaughtException` handlers, zero `unhandledRejection` handlers. That is
// tolerable in a web service, where a dead process means a failed request. It is
// not tolerable here: this process renames files, overwrites documents, sends
// messages and changes system settings. One rejected promise inside a tool and
// it vanishes, mid-action, holding the only record of what it had already done —
// the undo journal is in memory by design, and it dies with the process.
//
// The user is then left with a machine that has been changed, an agent that
// never said so, and a PowerShell automation host that outlives its parent.
// That last one is not hypothetical: 15 orphaned hosts holding 801 MB were
// found on this machine, from exactly this shape of exit.
//
// SO A CRASH MUST DO THREE THINGS, IN THIS ORDER, AND THEN STOP:
//
//   1. write down what had been done to the machine, so the next start can say
//      so — the journal's summaries, never its reversal descriptors, which
//      carry paths and backup locations;
//   2. stop the automation host, or the crash leaks one;
//   3. exit non-zero.
//
// IT MUST NOT KEEP RUNNING. This is the trap in the whole idea, and it is worth
// being explicit about: from Node 15 an unhandled rejection ALREADY terminates
// the process. Adding a handler turns that into a no-op unless the handler
// exits itself — so a "crash guard" written carelessly does not harden the
// daemon, it removes the only protection it had and lets it carry on in a state
// nobody can reason about. `tests/unit/crash-guard.test.js` pins that: the
// handler must call exit, and it must be non-zero.
//
// Everything here takes its dependencies as arguments so the behaviour can be
// tested without killing the test runner.

import fsSync from "node:fs";
import path from "node:path";
import { sanitizeExternalContext } from "../../../packages/shared-types/src/external-context.js";

export const CRASH_RECORD = "interrupted-run.json";

/**
 * What the process knew at the moment it died, as a plain object.
 *
 * Separate from writing it so a test can check the CONTENT without a
 * filesystem, and so the error's own text goes through the same credential
 * redaction everything else leaving this process does — a stack trace can
 * quote a URL with a key in it, and a crash file is written to a directory the
 * user syncs.
 */
export function describeCrash({ reason, error, actions = [], at = new Date().toISOString(), pid = process.pid }) {
  return {
    at,
    pid,
    reason,
    error: {
      name: String(error?.name ?? "Error"),
      message: sanitizeExternalContext(String(error?.message ?? error ?? "")),
      stack: sanitizeExternalContext(String(error?.stack ?? "")).split("\n").slice(0, 12).join("\n")
    },
    actions
  };
}

/**
 * Turn a crash record into something worth reading. Plain sentences, because
 * the person this is for does not read JSON and the whole point of writing it
 * was that somebody would be told.
 */
export function describeInterruptedRun(record) {
  if (!record?.at) return null;
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const reversible = actions.filter((action) => action.reversible === true).length;
  const unfinished = actions.filter((action) => action.finished === false).length;
  const lines = [
    `SYSCORA stopped unexpectedly at ${record.at} (${record.reason}: ${record.error?.message ?? "no message"}).`
  ];
  if (actions.length === 0) {
    lines.push("It had not changed anything on this machine at that point.");
    return lines.join("\n");
  }
  lines.push(`It had already done ${actions.length} thing${actions.length === 1 ? "" : "s"} to this machine:`);
  for (const action of actions.slice(0, 20)) {
    lines.push(
      `  - ${action.tool}: ${action.summary}` +
      (action.finished === false ? "  [never reported back — it may or may not have completed]" : "") +
      (action.reversible ? "" : `  [cannot be undone${action.why ? `: ${action.why}` : ""}]`)
    );
  }
  if (actions.length > 20) lines.push(`  ... and ${actions.length - 20} more`);
  lines.push(
    `${reversible} of these could have been put back, but the record of HOW was lost with the process — ` +
    "the undo journal is in memory on purpose, so that a reversal is never offered against a machine that has moved on."
  );
  if (unfinished > 0) {
    lines.push(
      `${unfinished} never reported back. That is not evidence they did not happen — it is evidence we stopped knowing.`
    );
  }
  return lines.join("\n");
}

/**
 * Report a previous crash once, at startup, then move the record aside.
 *
 * Renamed rather than deleted: the record is the only account of a run that
 * changed somebody's machine and then disappeared, and deleting it to keep the
 * directory tidy would throw away the evidence this whole file exists to
 * produce. Renaming is also what stops it being reported forever.
 */
export function reportInterruptedRun({ stateDir, log = console.warn, fs = fsSync } = {}) {
  const recordPath = path.join(stateDir, CRASH_RECORD);
  let record = null;
  try {
    if (!fs.existsSync(recordPath)) return null;
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    // A crash record we cannot parse is still evidence that there WAS a crash,
    // and saying nothing would be the quiet failure this file is against.
    log("SYSCORA: the previous run left a crash record that could not be read.");
    return null;
  }
  const summary = describeInterruptedRun(record);
  if (summary) log(summary);
  try {
    fs.renameSync(recordPath, path.join(stateDir, `interrupted-run-${String(record.at).replace(/[:.]/g, "-")}.json`));
  } catch {
    // Reported is the important half. A record that cannot be renamed will be
    // reported again next time, which is noisy and not wrong.
  }
  return record;
}

/**
 * Install the handlers.
 *
 * `exit`, `fs` and `closeHost` are injected so a test can prove the ORDER and
 * the exit code without terminating the test runner.
 */
export function installCrashGuards({
  runtime = null,
  stateDir,
  closeHost = () => false,
  log = console.error,
  exit = (code) => process.exit(code),
  fs = fsSync,
  on = (event, handler) => process.on(event, handler)
} = {}) {
  let crashing = false;

  const onFatal = (reason, error) => {
    // A second failure while handling the first must not re-enter: that turns
    // one crash into a loop and buries the error that started it.
    if (crashing) return;
    crashing = true;

    let actions = [];
    try { actions = runtime?.interruptedWork?.() ?? []; } catch { actions = []; }
    const record = describeCrash({ reason, error, actions });

    // The log first, because it is the only part that works when the state
    // directory is unwritable.
    try {
      log(`SYSCORA daemon crashed (${reason}): ${record.error.message}`);
      log(record.error.stack);
      if (actions.length) log(`It had changed ${actions.length} thing(s) on this machine; writing them to ${CRASH_RECORD}.`);
    } catch { /* a logger that throws must not stop the shutdown */ }

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, CRASH_RECORD), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch (writeError) {
      try { log(`SYSCORA: the crash record could not be written: ${writeError?.message ?? writeError}`); } catch { /* nothing left to try */ }
    }

    // Always attempted, even if the write failed — a leaked PowerShell host
    // outlives the user's session and is the more expensive of the two.
    try { closeHost(); } catch { /* exiting regardless */ }

    exit(1);
  };

  on("uncaughtException", (error) => onFatal("uncaughtException", error));
  // An unhandled rejection already terminates the process in modern Node. This
  // handler REPLACES that, so it has to end in the same place — see the note at
  // the top of this file.
  on("unhandledRejection", (error) => onFatal("unhandledRejection", error));

  return { onFatal };
}
