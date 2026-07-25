# SYSCORA RC1 Validation Report

Date: 2026-07-25  
Branch: `codex/rc1-validation`  
Baseline: `5620b3993cb4d079c21126244afa7c29f1aaeb84`  
Decision: **NOT READY**

## 1. RC1 Readiness

NOT READY. The live campaign stopped at 7/20 tasks after five independent desktop tasks reproduced the same interactive-control architectural weakness. The full automated suite also has two failures.

## 2. Live Task Matrix

| # | Goal / surface | Planner / modality | Model / latency | Execution | Evidence and result | False result | Bug |
|---|---|---|---|---|---|---|---|
| 1 | Report Windows version, CPU, and memory without changes | Direct operation; PowerShell-backed system reads | Intent and parallel interpretation observed; direct-path aggregate unavailable | 9.6 s; 3 actions; 0 recoveries | Three independent verifications; useful values displayed | Initial UI result was a false success before fix | RC1-001, RC1-002; final PASS |
| 2 | Create/read exact file under `C:\tmp` | Deterministic filesystem fallback | Model intent succeeded; plan rejected | 15.0 s; 0 actions | Safe failure; independent disk check found no file | No | RC1-003; FAIL |
| 3 | Calculator arithmetic and visible result | Local interactive controller; launch + UIA | 0 model calls; 0 ms | 56.4 s; 23 UI actions; 0 recoveries | Calculator remained at `0`; truthful `max-steps` | No | RC1-004; FAIL |
| 4 | Settings Display scale, read-only | Adaptive interactive; launch + UIA | 6 calls; 9.8 s model latency | 64.4 s; 19 UI actions; 2 recovery calls | Opened Accounts, looped on wrong targets, truthful failure | No | RC1-005; FAIL |
| 5 | Task Manager highest-memory process | Hybrid internal process read + GUI | 6 calls; 13.0 s model latency | 27.1 s; 2 local actions | Process list verified, but requested UI flow failed | No | RC1-006; FAIL |
| 6 | Notepad two-line typing | Local interactive; launch + UIA | 0 model calls; 0 ms | 83.3 s; 23 UI actions | Re-selected an existing tab; no requested text entered | No | RC1-007; FAIL |
| 7 | Edge navigation and heading read | Adaptive interactive; browser + UIA | 5 calls; 14.0 s model latency | 84.3 s; 12 UI actions | Address bar found, unsupported `set_value`, truthful failure | No | RC1-008; FAIL |
| 8–20 | Not run | — | — | — | Mandatory stop rule triggered | — | — |

Five independent tasks (3–7) exposed one shared weakness: interactive action vocabulary, target selection, and progress detection do not converge on supported UI operations.

## 3. Bugs Found

- RC1-001: routed read-only plans were classified as mutating and mixed requests were misclassified as prohibitions.
- RC1-002: aggregate read succeeded internally but the UI returned only a task count, creating a false success.
- RC1-003: the frozen filesystem fallback cannot safely honor the explicit `C:\tmp` target/grammar.
- RC1-004: Calculator controller repeatedly invoked the read-only display.
- RC1-005: Settings controller looped on the profile/search controls and emitted unsupported `set_text`.
- RC1-006: Task Manager hybrid flow verified internal data but could not complete the GUI goal.
- RC1-007: Notepad controller repeatedly selected an existing tab and never typed.
- RC1-008: Edge controller alternated around the address bar and emitted unsupported `set_value`.
- RC1-009: automated structured-browser DOM test returns an empty title.
- RC1-010: automated Windows user-PATH verification returns false.

## 4. Bugs Fixed

- RC1-001: corrected standalone-prohibition handling, registry-declared read permissions, and system-summary plan evidence.
- RC1-002: added bounded, deterministic read-result presentation that excludes raw command output and fails closed for mutation results.
- Focused regression: 14/14 passing.

## 5. Remaining Bugs

RC1-003 through RC1-010 remain. RC1-004 through RC1-008 require coordinated work on the interactive action contract, supported edit operations, target ranking, and no-progress detection. That work is broader than a safe release-freeze patch.

## 6. Technical Debt

- No installed/discoverable SYSCORA application was present; validation used the repository Electron entry point.
- Worktree contained pre-existing uncommitted M4.4.1 changes before QA began.
- Developer mode renders very large raw session payloads, including raw command/process details.
- Provider switching, settings persistence, installer behavior, cleanup, downloads, clipboard, environment-variable UI, music, focus movement, and permission prompts were not reached after the stop rule.
- Existing Calculator, Settings, Notepad, Edge, and Task Manager windows/processes were left for inspection; no destructive cleanup was attempted.

## 7. Performance

Successful task 1 took 9.6 s. Failed interactive tasks took 27.1–84.3 s. First action was fast (270–1,781 ms), but repeated non-progressing actions dominated total time. Model latency accounted for 9.8–14.0 s on adaptive failures.

## 8. Reliability

Executed: 7/20. Final pass: 1. Final failures: 6. False successes observed: 1, fixed and re-run successfully. The system failed closed on all remaining failures, but usable desktop task reliability is inadequate.

## 9. Regression Status

- Focused regression: 14 passed, 0 failed.
- Capability contract validation: 6 passed, 0 failed.
- Full suite: 377 passed, 2 failed, 2 skipped (381 tests).
- Failures: `m41-browser-dom.test.js`; `windows-adapter-path.test.js`.
- Skips: real-model credit-gated test (`SYSCORA_REAL_MODEL_TEST=1`); durable-state smoke test (`SYSCORA_DURABLE_SMOKE=1`).

## 10. Investor Demo Script

Not executed. A zero-retry, zero-terminal five-minute demo is not credible while Calculator, Settings, Task Manager, Notepad, and Edge all fail their live flows. Proposed demo remains blocked until the shared interactive defect is corrected and the full 20-task campaign passes.

## 11. Recommendation

**Continue bug fixing.** Do not release RC1.

