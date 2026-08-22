# SYSCORA OS-Agent Readiness Audit

**Assessment date:** 2026-08-09  
**Scope:** Entire repository, capability registry, runtime/planning/control paths, policy and evidence gates, automated suite, and live Windows UI probes.  
**Decision:** **Ready as a capability-bounded, general-purpose Windows agent foundation; not—and no honest software can be—an unrestricted agent that can literally do anything or know everything on a computer.**

## Direct answers

| Question | Answer | Evidence and boundary |
|---|---|---|
| Can SYSCORA see the screen and its elements? | **Yes.** | `screen.read` fuses a live screenshot, Windows OCR, and UI Automation. It returns visible text plus typed elements. A live diagnostic read 240 elements from the active desktop window. Secure desktop, protected/DRM surfaces, occluded pixels, password values, and inaccessible sessions remain outside ordinary process authority. |
| Can it know an element's exact coordinates? | **Yes, when the element is currently observable.** | Every fused element carries screen-space bounds and a computed clickable center. OCR-only labels and UIA controls use the same shape. It refuses to invent an unobserved point. |
| Can it click an exact point? | **Yes.** | `pointer.clickAt` verifies that the point lies inside a live resolved window before sending input. The live coordinate probe grounded Calculator's **Seven** button at `(314, 1092)`, clicked that point, and independently observed `7` in the display. |
| Can it scroll arbitrarily far, slowly or quickly, while perceiving? | **Yes, as a bounded repeated loop.** | `pointer.wheel` sends real wheel notches at slow, normal, or fast cadence. With `observe:true`, it takes a fresh screen/OCR/UIA reading throughout the motion; `untilText` stops when requested visible text appears. One call is bounded to 120 notches and at most about 30 automatic frames by default; the controller can repeat it. This is interleaved action/perception, not continuous video cognition during the few milliseconds of a wheel event. |
| Can the LLM run any command it wants for the user's task? | **Broadly yes, but not without authority boundaries.** | `command.run` executes model-authored PowerShell/command lines with working-directory and 90-second bounds, captures stdout/stderr/exit code, supports cancellation, and fails verification on nonzero exit. It is still subject to Windows permissions, policy/approval, executable availability, and the user/session's authority. “Any command without confirmation” would be a remote-code-execution vulnerability, not a readiness feature. |
| Can it interact with the OS and know system state? | **Yes, through live snapshots.** | Typed reads cover system information, processes, services, ports, installed applications, packages, environment, volumes, windows, browser state, files, projects, Git, Docker, clipboard, and UI/vision state. It can launch/close apps, manage windows, operate UI controls, type, press keys, click, drag, scroll, browse, and run commands. It cannot continuously know every kernel, device, network, application-internal, or protected state without querying it or having permission to observe it. |
| Can it do everything a human can, faster and more efficiently? | **No literal guarantee is possible.** | It has broad digital reach and is often faster through typed commands, but cannot bypass UAC secure desktop, credentials, MFA/CAPTCHAs, hardware/physical tasks, inaccessible drivers, disconnected devices, application anti-automation, or OS/user policy. Live GUI tasks also showed 30–170 second model latency, so it is not uniformly faster than a human. |
| Can it work like an agentic coding assistant with the whole OS as its environment? | **Architecturally yes, within the registered and permission-accessible capability surface.** | It has catalog-constrained planning, a bounded perceive-decide-act-observe-verify controller, structured bindings, policy/approval, rollback, semantic state, memory, recovery, evidence ledgers, and goal-contract verification. Its environment is Windows rather than only a repository. Its reliability and ecosystem maturity are not equivalent to claiming universal OS control. |
| Can it chat like ChatGPT and use tools when needed? | **Yes.** | The same runtime has conversational classification/answer synthesis and agent execution. A live real-model probe served greeting, identity, capability, and general-knowledge prompts 4/4 without taking OS actions; tool-requiring prompts entered typed plans or the adaptive controller. |

## Why it was not reliably general-purpose

The capability breadth already existed, but several cross-layer defects broke ordinary composition:

1. Structural planning erased valid typed plans when a temporarily unavailable dependency was checked too early.
2. PowerShell registry writes could print an access error while exiting zero, so PATH mutation falsely reported success.
3. A launched app session could drift to another window from the same process name.
4. “Type exactly: …” included the word `exactly` in the payload.
5. “Maximize the window” was parsed but never compiled to `window.maximize`, allowing false completion after an unrelated UI action.
6. Packaged Windows apps exposed both a `CoreWindow` and an `ApplicationFrameWindow`; PID-heavy launch scoring selected the less-actionable surface.
7. Scrolling delivered wheel events but did not return perception frames captured throughout the motion.
8. Common read-only process and folder questions depended on variable model planning even though typed capabilities already existed.
9. A model could correctly name `filesystem.list` but use intuitive entity aliases (`path`, `directory`) that the deterministic plan did not consume.
10. Read-result synthesis reported total/list data instead of the exact file count the user asked for.
11. The live GUI verifier could mistake a small Notepad popup for its main document window and add a virtual-desktop x-offset to display width.

## Implemented repairs

- Separated structural plan validation from runtime capability availability; the authorization/execution gate remains authoritative for live availability.
- Made user-PATH mutation fail closed on non-terminating PowerShell registry errors.
- Persisted and prioritized the exact launched window identity across an interactive session.
- Corrected exact-text parsing and added deterministic window-state compilation.
- Preferred an app's titled interactive frame over its UI-thin packaged core window.
- Added observe-as-you-scroll frames, cadence control, and `untilText` stopping.
- Added deterministic read routing for process inventory/ranking and directory inventory/counting.
- Added `filesystem.list` to operation plans and canonicalized model entity aliases before planning.
- Added exact `fileCount`/`directoryCount` answer synthesis.
- Added independent live coordinate-click and stronger GUI verification probes.

## Verification evidence

### Automated

- Baseline: 635 tests, 631 passed, 2 failed, 2 skipped.
- Final full suite: **644 tests, 641 passed, 0 failed, 3 skipped** in 318 seconds.
- Skips are environment-dependent: the current sandbox denies live user-PATH registry mutation, while a mocked non-terminating registry error is explicitly tested.
- `git diff --check` and syntax checks for every edited JavaScript probe/module completed without errors.

### Live Windows UI and real-model runs

- Desktop senses: **14/14 passed**—real window enumeration, screenshot/OCR/UIA fusion, coordinates, visual target location, both scroll directions, interleaved scroll perception, rejection of invented coordinates, arbitrary PowerShell execution, and system inspection.
- Exact click: Calculator **Seven** located at `(314, 1092)`, clicked, and `7` independently observed.
- Calculator arithmetic: `17 × 23` produced independently verified `391` through application + pointer + screen actions.
- Highest-memory process: repaired typed route returned the same current leader as an independent PowerShell measurement.
- Downloads: repaired typed route returned **372 files** and **13 directories**; independent truth expected 372 files.
- Screen readback: Notepad text was typed and independently read back.
- GUI actions: Notepad launch, exact text entry, maximize, and Calculator launch each have a passing live run. Maximize measured 2906/2906 pixels after correcting the independent verifier's popup selection.
- Chat: **4/4** live conversational prompts served by the real model.

The complete generalization run before the last two routing repairs scored 3/5. Each of those two failures was then reproduced, fixed, and passed independently. This distinction is retained rather than presenting the earlier run as if it had already been green.

## Remaining hard boundaries and operational risks

1. Model latency is variable and can dominate simple GUI tasks; typed internal routes are materially faster.
2. Screen/state knowledge is fresh but snapshot-based. Long-running monitoring must keep polling or subscribe to a supported event source.
3. UI Automation and OCR depend on what Windows and the application expose. Custom, protected, minimized, remote, or rapidly changing surfaces may require different adapters.
4. System authority never exceeds the Windows account, integrity level, policy, and granted approval. Secure desktop and credential boundaries are intentionally not bypassed.
5. Consequential operations must remain approval-gated. Removing confirmation globally would make the product less trustworthy and cannot be equated with general intelligence.
6. “All software and all hardware” requires adapters, installed executables, drivers, network access, and application compatibility that no fixed codebase can guarantee in advance.
7. The external model can still make inefficient choices. Deterministic typed routes now cover the failures observed here, but unseen-task reliability must continue to be measured with a growing release corpus.

## Current definition of ready

SYSCORA is ready for supervised use as a **general-purpose, capability-bounded Windows agent** when the requested task is reachable through its catalog, observable on the current desktop or OS APIs, and permitted by Windows and policy. It can converse, reason, use commands, manipulate desktop/browser UI, verify outcomes, recover within budgets, and report uncertainty.

It is not accurately described as omnipotent, omniscient, universally faster than a person, or able to bypass operating-system/user security. Those are impossible or unsafe requirements, not missing checkboxes.

## Next release plan

1. Make the 644-test bounded suite and the live desktop/generalization probes release gates.
2. Add multi-monitor/DPI, minimized-window, protected-surface, and long-scroll fixtures.
3. Expand typed read/query operations so harmless system questions avoid external-model latency.
4. Run the unseen-task corpus on clean standard-user and administrator Windows installations.
5. Add performance budgets by route and prefer deterministic/API execution whenever it satisfies the same goal.
6. Keep zero tolerance for false completion, unauthorized consequential actions, fabricated targets, and unbounded execution.
