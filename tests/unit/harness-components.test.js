// THE THREE HARNESS COMPONENTS THAT WERE MISSING, HELD TO WHAT THEY CLAIM.
//
// arXiv:2605.13357 identifies eleven component responsibilities of a runtime
// harness. An audit of this codebase against that list on 8 Sep 2026 found eight
// of them strong, and three absent or vestigial: `intervention recording`,
// `entropy auditing`, and the verification/outcome distinction that its five-label
// taxonomy exists to draw.
//
// These are the tests for those three. Each one is written to fail if the
// component is neutered — which is stated per test where the failure is not
// obvious, because this codebase has shipped checks that could not fail three
// times (the `Write-Output 'checked-by-human'` verify, the empty-needle skill
// check, and the volume task that read a module that is not installed).

import test from "node:test";
import assert from "node:assert/strict";

import { InterventionKind, InterventionLog, meaningOf } from "../../packages/fast-agent/src/interventions.js";
import { Severity, auditEntropy, describeEntropy } from "../../packages/fast-agent/src/entropy-audit.js";
import {
  Outcome,
  Verification,
  buildEpisodePackage,
  classifyOutcome,
  classifyVerification,
  describeVerification
} from "../../packages/fast-agent/src/episode.js";

// ---------------------------------------------------------------------------
// INTERVENTION RECORDING
// ---------------------------------------------------------------------------

test("an approval card is not counted as a missing-harness intervention", () => {
  // THE TEST THAT PROTECTS THE GATES. If asking permission counted against the
  // harness, the metric would say the safest run is the worst one, and the way
  // to improve the number would be to ask less. `shell-rules.js` records where
  // that ends: "a gate that refuses arbitrary things trains the thing it is
  // gating to evade it."
  const log = new InterventionLog();
  log.record(InterventionKind.APPROVAL_ASKED, { detail: "send-message" });
  log.record(InterventionKind.APPROVAL_DECLINED, { detail: "delete-for-everyone" });
  assert.equal(log.missingHarnessCount(), 0);
  // But they ARE interventions: the person was involved, so the run is assisted
  // rather than autonomous.
  assert.equal(log.assisted(), true);
});

test("being stuck, stopped or handed over IS counted, and names the component", () => {
  const log = new InterventionLog();
  log.record(InterventionKind.AGENT_ASKED, { detail: "could not find the control" });
  log.record(InterventionKind.USER_STOPPED);
  log.record(InterventionKind.SKILL_HANDOVER, { detail: "daily-note" });
  assert.equal(log.missingHarnessCount(), 3);
  const gaps = log.gaps().map((entry) => entry.gap);
  assert.deepEqual(gaps.sort(), ["context-manager", "project-memory", "task-state"]);
});

test("an unrecognised kind is refused rather than recorded as unknown help", () => {
  const log = new InterventionLog();
  assert.equal(log.record("something-nobody-defined"), null);
  assert.equal(log.summary().recorded, 0);
});

test("the ledger is bounded, and says so rather than silently dropping", () => {
  const log = new InterventionLog();
  for (let index = 0; index < 60; index += 1) log.record(InterventionKind.AGENT_ASKED);
  const summary = log.summary();
  assert.equal(summary.recorded, 40);
  // The total still counts what actually happened. A run that needed help sixty
  // times must not report forty — that is the trimmed-row problem the session
  // store already solved by recording the trim.
  assert.equal(summary.total, 60);
});

test("detail is bounded, because a detail must never become a screen reading", () => {
  const log = new InterventionLog();
  const entry = log.record(InterventionKind.AGENT_ASKED, { detail: "x".repeat(5000) });
  assert.equal(entry.detail.length, 200);
});

test("every declared kind has a meaning", () => {
  for (const kind of Object.values(InterventionKind)) {
    const meaning = meaningOf(kind);
    assert.equal(typeof meaning.avoidable, "boolean");
    assert.ok(meaning.why, `${kind} has no explanation`);
  }
});

// ---------------------------------------------------------------------------
// ENTROPY AUDITING
// ---------------------------------------------------------------------------

const fakeFs = (files) => ({
  readdir: async () => Object.keys(files),
  stat: async (fullPath) => {
    const name = fullPath.split("/").pop();
    if (!files[name]) throw new Error("gone");
    return files[name];
  }
});

test("captures this run left behind are found and reported in bytes", async () => {
  const audit = await auditEntropy({
    startedAt: 1000,
    captureDir: "/tmp/syscora-m4",
    fs: fakeFs({
      "old.png": { mtimeMs: 500, size: 13_000 },
      "mine-1.png": { mtimeMs: 2000, size: 13_000 },
      "mine-2.png": { mtimeMs: 3000, size: 11_400_000 }
    })
  });
  const residue = audit.findings.find((item) => item.category === "file-residue");
  assert.ok(residue, "the two captures this run made were not reported");
  // The one from before the run started is not this run's doing.
  assert.match(residue.summary, /^2 screen captures/);
  assert.equal(audit.clean, false);
});

test("a run that left nothing behind is clean", async () => {
  const audit = await auditEntropy({
    startedAt: 1000,
    captureDir: "/tmp/syscora-m4",
    fs: fakeFs({ "old.png": { mtimeMs: 500, size: 13_000 } }),
    jobs: [],
    performed: [],
    journalledCount: 0
  });
  assert.equal(audit.findings.length, 0);
  assert.equal(audit.clean, true);
});

test("NOT CHECKED IS NOT CLEAN — the distinction the 76 screenshots hid behind", async () => {
  // With no fs and no jobs list, nothing can look at the two things that matter.
  // Reporting that as "clean" is how a leak stays invisible for months.
  const audit = await auditEntropy({ startedAt: 1000 });
  assert.equal(audit.clean, false);
  assert.ok(audit.checked < audit.probes);
});

test("files written by a run that did not finish are reported; by one that did, they are not", async () => {
  const performed = [{ tool: "write_file", ok: true, args: { path: "C:/x/index.html" } }];
  const failed = await auditEntropy({ performed, completed: false, startedAt: 0 });
  assert.ok(failed.findings.some((item) => item.category === "partial-artifact"));
  // The same write on a run that finished is the deliverable, not residue.
  const succeeded = await auditEntropy({ performed, completed: true, startedAt: 0 });
  assert.equal(succeeded.findings.some((item) => item.category === "partial-artifact"), false);
});

test("a still-running deferred job is reported as a fact, not as a defect", async () => {
  const audit = await auditEntropy({
    startedAt: 0,
    jobs: [{ state: "running", command: "winget install --id Foo" }]
  });
  const found = audit.findings.find((item) => item.category === "background-work");
  assert.ok(found);
  // NOTE, not CONCERN: deferring is what `run {defer:true}` is for.
  assert.equal(found.severity, Severity.NOTE);
});

test("the audit never throws, whatever it is handed", async () => {
  const exploding = {
    readdir: async () => { throw new Error("boom"); },
    stat: async () => { throw new Error("boom"); }
  };
  const audit = await auditEntropy({
    fs: exploding,
    captureDir: "/nope",
    performed: null,
    jobs: "not an array",
    journalledCount: "not a number",
    startedAt: NaN
  });
  assert.ok(audit);
  assert.equal(Array.isArray(audit.findings), true);
});

test("describeEntropy says nothing on a clean run", async () => {
  const audit = await auditEntropy({ startedAt: 0, jobs: [], performed: [], journalledCount: 1 });
  assert.equal(describeEntropy(audit), null);
});

// ---------------------------------------------------------------------------
// VERIFICATION AUTONOMY
// ---------------------------------------------------------------------------

test("a run where nothing acted is NOT_APPLICABLE, not unverified", () => {
  // The median request on this machine is four steps and most only look.
  // Grading "which windows are open?" as unverified makes the metric useless.
  assert.equal(
    classifyVerification({ actingCalls: 0, confirmed: 0, refuted: 0 }),
    Verification.NOT_APPLICABLE
  );
});

test("acted with a confirming receipt and no help is autonomous", () => {
  assert.equal(
    classifyVerification({ actingCalls: 2, confirmed: 2, assisted: false }),
    Verification.AUTONOMOUS_VERIFIED
  );
});

test("the same run with a person asked along the way is assisted, not autonomous", () => {
  assert.equal(
    classifyVerification({ actingCalls: 2, confirmed: 2, assisted: true }),
    Verification.ASSISTED_VERIFIED
  );
});

test("UNVERIFIED IS NOT REFUTED, and neither is failure", () => {
  // `unconfirmed is not failed` is a house rule and three shipped gates have
  // broken it. These two must be different values, and neither may be an error.
  assert.equal(classifyVerification({ actingCalls: 1, confirmed: 0, refuted: 0 }), Verification.UNVERIFIED);
  assert.equal(classifyVerification({ actingCalls: 1, confirmed: 0, refuted: 1 }), Verification.REFUTED);
});

test("a confirmation outranks nothing, but a refutation alone outranks silence", () => {
  // One thing worked and one thing did not: still verified, because something
  // was proved. The loop's own caution guard handles the claim about the rest.
  assert.equal(
    classifyVerification({ actingCalls: 2, confirmed: 1, refuted: 1 }),
    Verification.AUTONOMOUS_VERIFIED
  );
});

test("COMPLETED is no longer one word — the five outcomes are distinguishable", () => {
  assert.equal(
    classifyOutcome("COMPLETED", Verification.AUTONOMOUS_VERIFIED),
    Outcome.AUTONOMOUS_VERIFIED_SUCCESS
  );
  assert.equal(
    classifyOutcome("COMPLETED", Verification.ASSISTED_VERIFIED),
    Outcome.ASSISTED_VERIFIED_SUCCESS
  );
  // THE CELL THIS WHOLE MODULE EXISTS FOR: the run says it finished and nothing
  // read the machine back. Previously indistinguishable from a verified success.
  assert.equal(classifyOutcome("COMPLETED", Verification.UNVERIFIED), Outcome.UNVERIFIED_SUCCESS);
  assert.equal(classifyOutcome("COMPLETED", Verification.NOT_APPLICABLE), Outcome.ANSWERED);
});

test("declined and cancelled are their own endings, not failures", () => {
  assert.equal(classifyOutcome("DECLINED", Verification.NOT_APPLICABLE), Outcome.DECLINED);
  assert.equal(classifyOutcome("CANCELLED", Verification.NOT_APPLICABLE), Outcome.CANCELLED);
});

test("unsafe_invalid is only ever set deliberately, never inferred", () => {
  assert.notEqual(classifyOutcome("FAILED", Verification.REFUTED), Outcome.UNSAFE_INVALID);
  assert.equal(classifyOutcome("COMPLETED", Verification.AUTONOMOUS_VERIFIED, { unsafe: true }), Outcome.UNSAFE_INVALID);
});

test("the sentence for UNVERIFIED says it is not a failure", () => {
  const said = describeVerification(Verification.UNVERIFIED);
  assert.match(said, /not the same as it having failed/i);
});

// ---------------------------------------------------------------------------
// EPISODE PACKAGE
// ---------------------------------------------------------------------------

test("the package carries every trace the protocol names", () => {
  const log = new InterventionLog();
  log.record(InterventionKind.APPROVAL_ASKED);
  const pack = buildEpisodePackage({
    request: "send amma a message",
    status: "COMPLETED",
    verification: Verification.ASSISTED_VERIFIED,
    outcome: Outcome.ASSISTED_VERIFIED_SUCCESS,
    steps: 5,
    toolCalls: 6,
    performed: [
      { tool: "launch", ok: true, verified: true },
      { tool: "screen", ok: true, verified: null },
      { tool: "click", ok: false, verified: false }
    ],
    failures: [{ tool: "click", failureClass: "ambiguous-target" }],
    interventions: log,
    entropy: { clean: true, findings: [] }
  });
  for (const trace of [
    "actionTrace", "toolTrace", "verificationTrace",
    "failureAttribution", "interventionLog", "entropyAudit", "outcomeRecord"
  ]) {
    assert.ok(pack[trace] !== undefined, `${trace} is missing from the episode package`);
  }
  assert.equal(pack.toolTrace.byTool.screen, 1);
  assert.equal(pack.toolTrace.failed, 1);
  // Three states kept as three, all the way through.
  assert.equal(pack.verificationTrace.confirmed, 1);
  assert.equal(pack.verificationTrace.refuted, 1);
  assert.equal(pack.verificationTrace.unread, 1);
});

test("the package is bounded, and says how much it dropped", () => {
  const performed = Array.from({ length: 200 }, () => ({ tool: "screen", ok: true, verified: null }));
  const pack = buildEpisodePackage({ performed });
  assert.ok(pack.actionTrace.length <= 60);
  assert.equal(pack.actionTraceDropped, 200 - 60);
  // The tool trace still counts ALL of them — the summary must not shrink with
  // the trace, or a runaway looks small.
  assert.equal(pack.toolTrace.byTool.screen, 200);
});

test("the request is bounded so a package cannot carry a whole document", () => {
  const pack = buildEpisodePackage({ request: "y".repeat(5000) });
  assert.equal(pack.episode.request.length, 500);
});
