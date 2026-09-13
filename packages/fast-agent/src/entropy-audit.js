// WHAT THIS RUN LEFT BEHIND.
//
// An agent does not only produce results. It produces RESIDUE: temp files,
// background processes, half-written documents, jobs still running after the
// answer was given. None of it breaks the request that created it, and all of it
// accumulates — which is why nobody ever finds it by testing a single task.
//
// THIS PROJECT HAS PAID FOR EXACTLY THIS THREE TIMES, and every one of them was
// found by accident weeks later rather than by anything that was looking:
//
//   76 PNG screenshots of the user's screen in %TEMP%\syscora-m4, going back
//      weeks, three of them 11.4 MB full-desktop captures. Every look that paid
//      for pixels wrote one and nothing ever deleted one. (4 Sep 2026)
//   15 leaked powershell.exe hosts, 801 MB resident, 1,162.7 CPU-seconds, the
//      oldest 170.9 hours old — because nothing on a real path ever called
//      `WindowsAutomationHostClient.close()`. (21 Aug 2026)
//   402 MB of audit.sqlite over 378,680 rows, all live, no bound. (4 Sep 2026)
//
// arXiv:2605.13357 names `entropy auditing` as one of eleven harness
// responsibilities and its argument is the one those three findings make: an
// agent taking on sustained work degrades a machine slowly, and "the agent
// introduced maintenance burden" is a runtime fact that belongs INSIDE the loop
// rather than in whatever somebody notices months later.
//
// THE RULES THIS OBEYS, BECAUSE AN AUDIT THAT COSTS ANYTHING GETS TURNED OFF.
//
//   It runs ONCE, at the end of a run, never per step.
//   It NEVER throws. A run that worked may not be reported as failed because a
//     directory listing did. Every probe is wrapped and a probe that fails is
//     reported as "not checked", which is different from "clean" and says so.
//   It reads; it never deletes. What to do about residue is the user's call —
//     the 76 screenshots were left in place for exactly that reason.
//   It only counts what THIS RUN created, by comparing against the run's own
//     start time. A machine that was already untidy is not this run's doing, and
//     an audit that blames a run for its predecessors is one nobody reads.

import os from "node:os";
import path from "node:path";

// WHERE THE CAPTURES GO, named once.
//
// `WindowsAdapter.captureScreen` builds this same path
// (`os-adapters/windows/src/windows-adapter.js`), and so does the PowerShell
// host. A third hand-written copy would be a third place to disagree, so this is
// exported for the caller to pass in rather than being rebuilt at the call site.
export const CAPTURE_DIR = path.join(os.tmpdir(), "syscora-m4");

/** How bad, on the 0-3 scale the paper uses. 0 is not reported at all. */
export const Severity = Object.freeze({
  NONE: 0,
  NOTE: 1,
  CONCERN: 2,
  SERIOUS: 3
});

// Above this many capture files left by ONE run, something is wrong with the
// cleanup rather than merely untidy — a single run has no reason to keep more
// than a couple of screenshots alive at once.
const CAPTURES_CONCERNING = 3;

function finding(category, severity, summary, detail = null) {
  return Object.freeze({ category, severity, summary, detail });
}

/**
 * Temp captures this run created and did not clean up.
 *
 * `VisionProvider.collect` and `windowLook` both delete their PNG now, so the
 * healthy answer is zero and any other answer is a regression in one of those
 * two sites rather than a new kind of problem. That is the whole value of
 * checking: this is a leak that was invisible for months and is one `readdir`
 * away from being obvious.
 */
async function auditCaptures({ fs, captureDir, startedAt }) {
  if (!fs?.readdir || !captureDir) return { checked: false, findings: [] };
  let names;
  try {
    names = await fs.readdir(captureDir);
  } catch {
    // No directory is the ordinary case on a run that never took a picture.
    return { checked: true, findings: [] };
  }
  let mine = 0;
  let bytes = 0;
  for (const name of names) {
    try {
      const stat = await fs.stat(`${captureDir}/${name}`);
      // Created since this run began. Files older than the run belong to
      // whatever made them, and blaming this run for them would be wrong in the
      // direction that makes the report worthless.
      if (Number(stat?.mtimeMs ?? 0) < startedAt) continue;
      mine += 1;
      bytes += Number(stat?.size ?? 0);
    } catch {
      // A file that vanished between the listing and the stat is a file that was
      // cleaned up, which is the outcome this is checking for.
    }
  }
  if (mine === 0) return { checked: true, findings: [] };
  return {
    checked: true,
    findings: [finding(
      "file-residue",
      mine >= CAPTURES_CONCERNING ? Severity.CONCERN : Severity.NOTE,
      `${mine} screen capture${mine === 1 ? "" : "s"} from this run left in the temp directory`,
      // The bytes matter more than the count: three 11 MB desktop captures are a
      // different problem from three 13 KB window captures.
      `${Math.round(bytes / 1024)} KB in ${captureDir}. These are pictures of the user's screen. ` +
      "Nothing deletes them later; the two capture sites are supposed to remove their own."
    )]
  };
}

/**
 * Work still running after the answer was given.
 *
 * `run {defer:true}` exists precisely so a long command does not block the loop,
 * and the cost of that is that a run can finish while its own job is still going.
 * That is legitimate and is NOT reported as a defect — it is reported as a fact
 * the user needs, because "it said it was done" and "the install is still
 * running" are both true and only one of them is on screen.
 */
function auditJobs({ jobs }) {
  if (!Array.isArray(jobs)) return { checked: false, findings: [] };
  const running = jobs.filter((job) => job?.state === "running" || job?.running === true);
  if (running.length === 0) return { checked: true, findings: [] };
  return {
    checked: true,
    findings: [finding(
      "background-work",
      Severity.NOTE,
      `${running.length} deferred job${running.length === 1 ? " is" : "s are"} still running`,
      running.map((job) => String(job?.command ?? job?.id ?? "?").slice(0, 80)).join("; ")
    )]
  };
}

/**
 * Files this run created on a run that did not finish.
 *
 * A half-built project is the residue this codebase has actually shipped: the
 * three-file web app that wrote index.html, reported COMPLETED and left style.css
 * and app.js missing (3 Sep 2026). The write itself is not residue when the run
 * succeeded — it is the deliverable. It is residue when the run did NOT.
 */
function auditPartialWrites({ performed, completed }) {
  if (completed || !Array.isArray(performed)) return { checked: Boolean(performed), findings: [] };
  const written = performed
    .filter((call) => call?.ok === true && WRITING_TOOLS.has(call?.tool))
    .map((call) => String(call?.args?.path ?? call?.args?.filename ?? "?"));
  if (written.length === 0) return { checked: true, findings: [] };
  return {
    checked: true,
    findings: [finding(
      "partial-artifact",
      Severity.CONCERN,
      `${written.length} file${written.length === 1 ? " was" : "s were"} written by a run that did not finish`,
      // Named, because the user's next question is "which ones", and a run that
      // cannot answer that has left them to find out by looking.
      `${written.slice(0, 8).join(", ")}${written.length > 8 ? ` and ${written.length - 8} more` : ""}. ` +
      "These are on disk and may be incomplete."
    )]
  };
}

const WRITING_TOOLS = new Set(["write_file", "edit_file", "create_document", "make_document"]);

/**
 * Irreversible things done with nothing recorded that could put them back.
 *
 * The undo journal writes its entry BEFORE the action, so a mismatch here means
 * an acting tool ran on a path the journal does not cover. That is not
 * necessarily wrong — plenty of actions genuinely cannot be reversed and the
 * journal says so at the time — but a run where NOTHING was journalled and
 * several things were changed is a run the user cannot walk back at all, and
 * they should be told that while it is still recent.
 */
function auditReversibility({ performed, journalledCount }) {
  if (!Array.isArray(performed) || typeof journalledCount !== "number") {
    return { checked: false, findings: [] };
  }
  const changed = performed.filter((call) => call?.ok === true && CHANGING_TOOLS.has(call?.tool)).length;
  if (changed === 0 || journalledCount > 0) return { checked: true, findings: [] };
  return {
    checked: true,
    findings: [finding(
      "unreversible-change",
      Severity.NOTE,
      `${changed} change${changed === 1 ? "" : "s"} were made and nothing was journalled to undo them`,
      "`undo` will have nothing to put back for this run."
    )]
  };
}

const CHANGING_TOOLS = new Set([
  "write_file", "edit_file", "create_document", "clipboard", "volume", "window_state", "close_app"
]);

/**
 * Everything this run left behind, in one object, having thrown nothing.
 *
 * Returns `{ clean, checked, findings, worst }`. `clean` is only true when
 * something actually LOOKED and found nothing — a probe that could not run
 * leaves `checked` short and `clean` false, because "not checked" and "clean"
 * being the same value is how the 76 screenshots stayed invisible.
 */
export async function auditEntropy({
  performed = [],
  jobs = null,
  captureDir = null,
  journalledCount = null,
  completed = true,
  startedAt = 0,
  fs = null
} = {}) {
  const probes = [];
  try {
    probes.push(await auditCaptures({ fs, captureDir, startedAt }));
  } catch { probes.push({ checked: false, findings: [] }); }
  try {
    probes.push(auditJobs({ jobs }));
  } catch { probes.push({ checked: false, findings: [] }); }
  try {
    probes.push(auditPartialWrites({ performed, completed }));
  } catch { probes.push({ checked: false, findings: [] }); }
  try {
    probes.push(auditReversibility({ performed, journalledCount }));
  } catch { probes.push({ checked: false, findings: [] }); }

  const findings = probes.flatMap((probe) => probe.findings);
  const checked = probes.filter((probe) => probe.checked).length;
  const worst = findings.reduce((high, item) => Math.max(high, item.severity), Severity.NONE);
  return {
    // EVERY PROBE LOOKED, AND THEY ALL FOUND NOTHING.
    //
    // The first version of this said `checked > 0`, and its own test caught it:
    // called with no arguments, the partial-write probe trivially "checks" an
    // empty list on a completed run, so one vacuous pass declared the whole audit
    // clean while the two probes that actually matter — captures and jobs — had
    // never run. That is the same defect this module exists to catch, arriving
    // through the module's own front door, and it is the fifth time this codebase
    // has produced a check that could not fail.
    //
    // So `clean` requires ALL of them. A caller that cannot supply a probe's
    // input gets `partial`, which is honest, rather than a green tick that means
    // "nobody looked".
    clean: checked === probes.length && findings.length === 0,
    partial: checked > 0 && checked < probes.length,
    checked,
    probes: probes.length,
    findings,
    worst
  };
}

/**
 * The one line a person reads, or null when there is nothing to say.
 *
 * Null on a clean run is deliberate: an audit that announces itself on every
 * successful run is noise, and noise is what gets a check switched off.
 */
export function describeEntropy(audit) {
  if (!audit || audit.findings.length === 0) return null;
  return audit.findings
    .map((item) => `${item.summary}${item.detail ? ` — ${item.detail}` : ""}`)
    .join("\n");
}
