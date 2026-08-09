# Runtime V1 Hardening Log

Chronological log of decisions, evidence, and any newly-discovered gaps found during the
V1 hardening pass. One entry per notable decision or finding. Architecture is frozen —
this log records the reasoning behind each fix so the session stays auditable.

Baseline at session start: HEAD `690983c`, full suite `143` passing, clean tree.

---

## Phase 1 — Rollback convergence

### Design decision: how `session.rollback` obtains the RollbackManager

The privileged-execution pattern injects `privilegedHelper` into
`createDefaultCapabilityRegistry(adapter, { privilegedHelper })`. `privilegedHelper` has no
back-reference to the registry, so it can be constructed before the registry.

`RollbackManager`, however, holds a reference to the capability registry (it calls
`registry.get(record.capability)` during `rollback()`), so registry ↔ rollbackManager is a
circular *instance* dependency. There is NO module-level cycle: `rollback-manager.js` has
zero imports, so referencing it from the daemon factory is safe.

Chosen approach (minimal, mirrors the `privilegedHelper` DI, does not redesign anything):
- `createDefaultCapabilityRegistry` accepts an optional `options.rollbackManager` and also
  exposes `registry.setRollbackManager(mgr)` for late binding (needed because the manager
  needs the finished registry).
- The daemon factory constructs one `RollbackManager(registry)` and injects it into BOTH the
  registry (via `setRollbackManager`) and the `AgentRuntime` (new optional constructor arg),
  so manual rollback, auto/recovery rollback, and the `session.rollback` capability all share
  a single manager instance.
- When no manager is wired (lightweight/test registry), `session.rollback` registers but its
  `execute` returns a clean failure and `verify` reports FAILED — same fail-closed shape the
  privileged capabilities use when no helper is wired.

This is dependency injection ordering, not an architecture change: rollback logic still lives
only in `RollbackManager`; the capability just moves the *invocation* behind the capability
boundary as Task 1.2 requires.

---

## Phase 2 — Frontend token exposure

### Finding: the API token was embedded in the unauthenticated served HTML

`index.html` shipped `window.__SYSCORA_API_TOKEN__ = "__SYSCORA_API_TOKEN__"` and the daemon
substituted the real token into that placeholder when serving `GET /` — an unauthenticated
route. Any local process (or any context that can reach the loopback port) could fetch `/`,
scrape the token, and then drive the mutating API. The auth check on `/api/*` was therefore
bypassable by anyone who could read the page it was meant to protect.

Fix: the token is never placed in served assets. It is obtained out-of-band in priority
order — (1) the Electron shell injects it in-process via a `contextBridge` preload
(`--syscora-token=` launch arg → `window.syscora.apiToken`), (2) tab-scoped `sessionStorage`
from an earlier connect, (3) a Connect panel where the user pastes the token printed in the
daemon console. `apiToken` is mutable; a `fetch` wrapper attaches it to every `/api/` request
and re-opens the Connect panel on any `401`, so a stale/rejected token self-heals instead of
failing silently.

Evidence: `tests/integration/daemon-token-exposure.test.js` asserts the token (and the old
placeholder) is absent from `/`, `/app.js`, and every open-route response header, while the
mutating API still returns 401 without a token and 200 with it.

---

## Phase 3a — Audit truncation & tail integrity

### Finding: the hash chain could not detect tail truncation or unsequenced rows

A hash chain makes modification, reordering, mid-deletion, and insertion detectable, but a
*prefix* of a valid chain is itself a valid chain — so lopping off the tail passed
verification. Separately, `verifyChain` filtered `WHERE seq IS NOT NULL`, so a row inserted
with a NULL seq after migration was silently excluded from verification.

Fix (two parts):
- Tail anchor: an authenticated high-water mark `{ maxSeq, entryHash }` is persisted outside
  the DB in `audit.anchor`, HMAC'd under a per-install `audit.key` (0600, created once). Each
  append advances the anchor. `verifyChain` flags `anchor.maxSeq > tail` (truncation) and a
  tail-hash mismatch at equal length (forged tail); `anchor.maxSeq < tail` is accepted as
  legitimate growth (covers a crash between COMMIT and anchor write). A tampered anchor whose
  HMAC does not verify is itself flagged.
- Verification observes the DB as-is: `ensureSchema({ backfill })` no longer heals legacy
  rows on the verify path, so an injected NULL-seq row is caught by an explicit
  unsequenced-row check instead of being laundered into the chain before inspection.

Evidence: `tests/unit/audit-integrity.test.js` adds truncation, anchor-tampering, and
stray-unsequenced-row cases; existing modification/reorder/backfill cases still pass.

---

## Phase 3b — Control-intent convergence

Pause and cancel bypassed the runtime's guarantees, mutating session state directly. They now
route through a canonical `submitControlIntent` lane that shares the guarantees which actually
apply to a lifecycle halt — session validation, deterministic authorization via
`PolicyEngine.decideControl` (is the transition legal from the current state?), a chained
`CONTROL_INTENT_EVALUATED` audit record plus the concrete transition record, and persistence.
A halt does not plan, assess risk, perceive, or schedule, so it is deliberately NOT forced
through `submitIntent`'s reasoning pipeline (that would fabricate a plan/risk for a no-op).
`pauseSessionById` / `cancelSessionById` are retained as thin wrappers, preserving the
historical no-op-on-terminal contract — now audited rather than silent.

Evidence: `tests/unit/control-intent.test.js` asserts each transition emits authorization +
transition records, persists the new state, verifies the chain, and that a control command on
a terminal session is denied yet still audited.

---

## Phase 4 — M2 risk model: PermissionBroker + runtime approval binding

> **SUPERSEDED by M2.1 (see below).** The weak `approvalSignature` (DJB2-32 over
> `{capability, inputs}`, redacted before hashing) described here was replaced by a
> cryptographic `ApprovalManifest` + SHA-256/HMAC commitment. The *binding concept* stands;
> the mechanism does not. Retained for history.

### Finding: an approval was not bound to the plan it was shown for

`PermissionBroker.evaluate` gated on the policy decision alone. An approval granted for one
plan could therefore authorize a *different* plan if the session's plan was mutated between
approval and resume ("approve op X, resume into a mutated op Y"). Nothing tied the recorded
approval to the operation's material content.

Fix: an approval is bound to `PermissionBroker.approvalSignature(plan)` — a stable digest over
each task's `{capability, inputs}`. The signature is recorded on the session at approval time
and echoed on the AWAITING_APPROVAL response. On resume, the runtime recomputes the signature
and, if it no longer matches the recorded one, emits `APPROVAL_INVALIDATED` and re-gates the
operation instead of auto-running it on the stale approval.

Key subtlety: the session store redacts secret-shaped fields (`value`, `token`, …) before
persistence, so a signature computed pre-persist would not match its reloaded self. The
signature is therefore computed over the *redaction-normalized* material, so it survives a
restart round trip. A pure secret-value swap is masked (by design — redaction hides it), but
any structural change (different target key, different capability) re-gates approval.

Evidence: `tests/unit/mvp-security.test.js` — resume across restart still completes; a plan
mutated after approval re-gates (`resume voids a prior approval…`). `tests/unit/risk-policy-adversarial.test.js`
covers signature stability across redaction, sensitivity to key/capability changes, and the
broker echoing the operation-scoped signature.

---

## Phase 4b — M2 risk model: adversarial hardening suite

Added `tests/unit/risk-policy-adversarial.test.js` (16 cases) encoding the ways a malicious or
buggy caller could try to run a dangerous operation without its deserved control, each
asserting the system fails CLOSED:

- **Self-certification hole**: a WRITE-surface capability declaring LOW risk / READ_ONLY still
  derives a mutating profile; an explicit `riskProfile` may raise a dimension but a benign
  claim (`DATA_SENSITIVITY: PUBLIC`) never lowers it below the derived floor.
- **Raise-only evidence**: a LOW caller hint cannot lower a capability's authoritative floor;
  a model-derived plan cannot claim `INTERNAL` input trust.
- **Monotonic controls / fail-closed**: a privileged op requires ELEVATE and fails closed
  (`REQUIRED_CONTROL_UNAVAILABLE`, legacy effect DENY) when the helper is not wired, but
  proceeds when it is; a capability demanding SANDBOX fails closed when SANDBOX is unwired;
  critical/untrusted execution is hard-denied regardless of wired controls; the strongest
  control wins across independent rules; high uncertainty escalates a benign decision to AUDIT.
- **Informed approval**: any confirmation-requiring decision carries an `informedApproval`
  descriptor of what is being approved.

Note on plugin `INPUT_TRUST`: the derived floor hardcodes `INTERNAL`, which is sound because
`plugin-loader.js` fails closed at load — an unsigned plugin, or one not signed by a trusted
key, never registers (verified by `tests/unit/plugin-signature.test.js`). Untrusted code never
reaches the risk profile.

Full suite: `181` passing (up from `164`).

---

## M2.1 — Approval, replan, and elevation integrity (independent-audit remediation)

An independent adversarial audit issued NO-GO for M3, citing three HIGH findings and one
MEDIUM. All four were verified against source before any change; all four were accurate.

### HIGH 1 — approval commitment is now cryptographic and exact

The M2 `approvalSignature` (see Phase 4 above) was inadequate: a DJB2 32-bit accumulator over
only `{capability, inputs}`, computed over redaction-normalized material. It omitted
dependencies, ordering, permissions, elevation, rollback, and capability version, and — because
it redacted BEFORE hashing — two distinct secret values (`value:"one"` vs `value:"two"`)
collapsed to the same signature.

Fix (`packages/permission-broker/src/approval-manifest.js`, `installation-key.js`): a versioned
**ApprovalManifest** committed with **SHA-256** over a deterministic canonical serialization.
The manifest binds every security-material field per task — capability, capability version,
sorted dependencies, sorted required permissions, elevation requirement, rollback requirement,
non-secret inputs — plus plan-level `taskOrder` (a pure reorder changes the commitment).
Secret input values are committed via **HMAC-SHA-256 under a per-installation key** (0600,
created once, mirrors the M1 audit-anchor key facility): distinct secrets yield distinct
commitments, and **no plaintext ever enters the manifest, session, audit, or logs**. Secret
fields are stripped from the retained structure (stored only as `{path, hmac}` under the
redaction-inert key `sealedInputs`), so persistence redaction cannot clobber the manifest. A
legitimately-redacted secret round-trips on resume only when the prior manifest is supplied AND
the reloaded field is exactly the redaction marker; tampering a redacted secret to any other
string is hashed fresh and no longer matches. Building without a key fails closed.

### HIGH 2 — replanning re-enters one canonical authorization gate

The replan path validated the new plan and swapped `session.plan`, then minted grants and
executed — with NO fresh risk assessment, policy decision, or approval. A recovery replan could
therefore introduce a HIGH/elevated capability under an approval granted for a LOW plan.

Fix (`packages/agent-runtime/src/index.js`): a single `_authorizePlan(session, plan, {phase})`
gate performs validation → fresh risk assessment (explicit evaluatedAt) → fresh policy decision
→ cryptographic approval commitment → approval evaluation, and is called by BOTH the initial
path and the replan path. A replan is a NEW security decision: it emits `REPLAN_GENERATED`,
`REPLAN_VALIDATED`, `REPLAN_RISK_ASSESSED`, `REPLAN_POLICY_DECIDED`, `REPLAN_COMMITMENT_COMPUTED`,
and either `REPLAN_APPROVED` or `REPLAN_APPROVAL_REQUIRED`. If the replan needs a control the
caller has not granted, the session parks in `AWAITING_APPROVAL` and NO protected work is
scheduled. Grants are minted only AFTER the gate authorizes. Completed VERIFIED tasks are still
preserved across the replan (no repeat of non-idempotent work).

### HIGH 3 — ELEVATE is an execution-routing guarantee, not a boolean

`pipeline.prepare` gated elevation on a `privilegeApproved` boolean and then ran whatever
`capability.execute` the capability defined. A signed plugin declaring `elevation:"ADMIN"` with
an arbitrary `execute` would run as-is once the boolean was set.

Fix (`capability-registry/src/index.js`, `pipeline.js`, `privileged-helpers/src/index.js`):
- An elevated capability must be built-in AND declare a `privilegedOperation` naming a real
  entry in the bounded helper's operation allow-list; enforced at registration BEFORE contract
  validation. A plugin (non-builtin source) declaring elevation is rejected outright —
  provenance is not privilege.
- `pipeline.prepare` fails closed for an elevated capability unless the registry has a LIVE
  bounded route (`privilegedOperations`) for its `privilegedOperation`. The boolean is
  necessary but no longer sufficient.
- Policy ELEVATE availability is OPERATION-SPECIFIC: the runtime computes it per plan from
  whether every elevated capability has a live bounded route, so a plan whose elevated
  capability lacks a route fails closed (`REQUIRED_CONTROL_UNAVAILABLE`) rather than proceeding.
- Actual privileged execution still flows through the single-use, scope-bound, allow-listed
  token-gated helper (unchanged), and still undergoes observe + verify + audit.

### MEDIUM 4 — risk evaluation time is explicit

`RiskEngine._contextStale` read `Date.now()` internally, so identical inputs produced different
assessments over time. `assess(plan, context, { evaluatedAt })` now takes an explicit evaluation
time (epoch ms or ISO), threads it through freshness checks, and records it on the assessment.
The gate passes an explicit `evaluatedAt` and it is captured in the `RISK_ASSESSED` /
`REPLAN_RISK_ASSESSED` audit events. Freshness still varies with time — but time is now an
explicit, auditable input, not a hidden global read.

### Evidence

- `tests/unit/approval-commitment.test.js` (22) — canonicalization, SHA-256 commitment,
  scenarios 1-10: identical/secret/dependency/task-add/remove/capability/version/permission/
  elevation/rollback/key-order/reorder, plus redacted round-trip and tamper detection.
- `tests/integration/m21-authorization-integrity.test.js` (12) — production-path replan
  re-gating (11-18), ELEVATE routing + plugin rejection + operation-specific availability
  (19-25), and explicit deterministic risk time (26-28), all through the real runtime.
- `tests/unit/risk-policy-adversarial.test.js` updated to the cryptographic commitment API.

Full suite: `220` passing (up from `181`).

---

## Feature — bounded Spotify desktop playback (real UI automation)

`spotify.track.play` upgrades the prior open-a-search behavior into genuine, verified
playback of a requested track. It is the first — deliberately narrow — Windows UI
Automation surface: launch/focus Spotify, bounded wait for its window, populate results
through the `spotify:search:` protocol, then invoke the first result "Play <track>" button
via native `UIAutomationClient` (InvokePattern), scoped strictly to the Spotify window. No
blind coordinate clicking.

### Honesty / verification

"Spotify launched" is NOT treated as success. The capability's `verify()` performs an
INDEPENDENT re-read of the live Spotify main-window title (`adapter.readSpotifyPlayback`),
which the client only sets to a track name while audio is actually playing. Success
(`VERIFIED`) requires playback to be live AND the title to match the requested query
(`matchesTrackQuery`). "Playing, but not the requested track" → `PARTIALLY_VERIFIED`;
"opened search but nothing playing" / "not installed" → `FAILED` with a precise message.

### Latency / routing

`play … on Spotify` phrasing is extracted deterministically in the IntentEngine BEFORE any
model call and mapped to the `spotify.track.play` operation, so it skips LLM planning
(`DIRECT_OPERATION`). It is also added to the runtime fast path so no perception/memory
sweep runs, and the operation plan composes exactly one task — no WinGet check or
process-list scan. The demo surface acknowledges immediately ("Opening Spotify and playing
'<track>'…").

### Safety / bounded recovery

LOW risk, `SESSION`/`READ` permission model (identical posture to `application.launch` /
`spotify.track.open`) → policy `ALLOW`, no confirmation. Every wait is clamped to an integer
bound; the capability declares `recoveryHints: ["ABORT_ON_FAILURE"]` and `retryBudget 0`, so
a failed UI interaction stops after one bounded attempt instead of replanning forever.

### Evidence

- `tests/unit/spotify-play.test.js` — deterministic intent extraction (play vs open),
  DIRECT_OPERATION routing (skips model), LOW/ALLOW risk+policy, `matchesTrackQuery`, and
  playback-title interpretation.
- `tests/integration/spotify-play.test.js` — mocked adapter through the real runtime:
  successful play, not-installed, result-not-found, UI timeout, playback-verification
  failure, and a bounded no-infinite-replan assertion.

---

## Phase M — Desktop senses: the agent could act but could not see

### Finding: every visual subsystem was built, tested, and unreachable

Measured on this machine, the visual stack works and always did: capturing a
window takes ~0.4s, OCR of that capture ~0.2s and returns per-line text with
absolute screen coordinates, and the UI Automation tree ~0.5s including each
control's live `value`. None of it reached the agent loop.

- `VisionProvider` was constructed only inside test files. `createDefaultProviders`
  omitted it, so `PerceptionEngine.captureVisionSnapshot` returned
  `vision-provider-not-registered` in every real session.
- `InteractiveAgentController` accepts a `captureScreenSnapshot` callback and
  contains a complete before/after screen-diff path built on
  `diffScreenSnapshots`. The runtime never passed the callback, so that path was
  dead code.
- The loop's `perceive()` filtered visible windows down to those whose title or
  process name shared a word with the user's request, then grounded only those.
  A request that named no window grounded nothing and never called UI Automation
  at all — the agent reasoned about an empty desktop with applications open in
  front of it.
- No capability answered "what is on the screen?". `screen.capture` writes a PNG
  the agent cannot read; `ocr.read` needs a path it must have captured first.

Live consequence, reproduced before the fix: asked to type "Ultron online" into
Notepad, the agent typed "Ultron online into it", reported the keystroke
`VERIFIED` because the keystroke was delivered, and then could not say what the
document contained. UI Automation had `value: "Ultron online into it"` available
the entire time.

### Fixes

- `VisionProvider` joins `createDefaultProviders`; the capability registry is
  threaded through `PerceptionEngine.withDefaultProviders` so it can check
  `screen.capture` / `ocr.read` / `ui.inspect` availability. It stays inert for an
  ordinary perception sweep (`vision-not-requested`) and captures only when asked.
- The runtime passes `captureScreenSnapshot`, so before/after screen diffing is
  live. `ADAPTIVE_SCREEN_DIFF` now carries real pixel, text and element deltas.
- `perceive()` ranks windows by goal match instead of filtering by it, always
  grounds something, and attaches an OCR reading of the grounded window for
  UI-facing work.
- New `screen.read` capability: capture + OCR + UIA fused into one reading, with
  every element's text and the exact screen coordinates of its clickable centre.
  READ / LOW risk, so an informational goal may use it.
- New `pointer.clickAt`: clicks a raw coordinate, which is the only way to reach
  a canvas, map, video, game or remote session. Invented coordinates are refused
  because the point must lie inside a window that exists at that moment.
- `vision.locate` falls back to scored fuzzy matching (exact > prefix > substring
  > token overlap, with one-character OCR tolerance), and a miss now reports what
  WAS on screen instead of only "not found".
- `keyboard.type` verifies by reading the window back. It reports `FAILED` with
  the window's actual contents when the text is not there, and
  `PARTIALLY_VERIFIED` when nothing can be read back (password boxes) rather than
  claiming a verification that did not happen.

### Finding: scrolling down had never worked

`mouse_event`'s `dwData` is declared `uint`, and a downward wheel delta is
negative. `[uint32]$delta` is a checked cast in PowerShell, so every downward
scroll threw `Cannot convert value "-120" to type "System.UInt32"` before a
single wheel event was sent. Scrolling up worked; scrolling down — the direction
almost every real task needs — could not. Fixed by reinterpreting the bits
(`BitConverter`) rather than converting the value.

`pointer.wheel` was also posting the wheel event wherever the cursor happened to
be resting rather than over the target window, and clamped to one burst. It now
parks the pointer over the window, takes `notches` and a `speed`, and delivers
one real wheel event per notch — so the agent can scroll slowly and read what
goes past.

### Finding: three more unreachable-by-wiring defects

- **Aliases never resolved for interactive decisions.** The registry defines the
  synonyms models actually reach for (`keyboard.typeText`, `cli.exec`,
  `ui.getText`). Resolution looks the alias up in the catalog handed to the
  model, and `_catalog()` dropped the `aliases` field — so not one alias had ever
  resolved. Live, a session that had correctly launched Notepad was killed by the
  single word `keyboard.typeText`.
- **One malformed decision ended the session.** Any `ok:false` from the model was
  terminal, so `maxMalformedProposals` was unreachable. `_reasonStructured` now
  distinguishes "answered, but wrongly" (recoverable — re-ask with fresh
  observations) from "never answered" (terminal), and the loop books the former
  as a malformed proposal.
- **The wall-clock budget could not interrupt a model call.** An interactive
  decision is 70s × 2 transport attempts × 2 repair attempts, so one slow
  endpoint could spend 280s of a 420s session inside a single `await`, and the
  budget is only checked between steps. Reasoning calls now carry the caller's
  remaining budget as a hard ceiling (half the remainder, capped at 150s).

### Finding: the host was never warmed, and the bill landed on the first action

`startServer` has accepted a `warmHost` parameter all along and never read it.
The automation host loads UI Automation, WinForms and the OCR engine on first
use, so every session paid several seconds of cold start inside its first real
action — where it looks like that action being slow. Measured: first window
enumeration 1.3s vs 0.3s warm; first screen reading 11s vs 1.2s warm, long enough
that `application.launch` could exceed its own 24s timeout and be recorded as a
failure on a healthy machine. The daemon now warms the host at startup,
best-effort.

A duplicate reading was also removed: the loop reads the screen at the top of
each step and the controller then took a "before" reading of the same window,
paying twice. A reading younger than 2.5s now serves as the before-state. The
"after" reading is never served from that memo — seeing what changed is the whole
point of taking it.

### Evidence

- `tests/unit/screen-perception.test.js` — 22 tests covering vision registration,
  window resolution by application name, `screen.read` output shape and
  coordinates, fuzzy visual matching, coordinate-click refusal, per-notch
  scrolling, typed-text read-back in all three outcomes, window pinning, alias
  survival, recoverable vs terminal decisions, reasoning budget enforcement, the
  screen memo, and host warming.
- `scripts/diag/desktop-senses.mjs` — live end-to-end check of all thirteen
  senses against a real window. These defects were all in the wiring BETWEEN
  subsystems that each passed their own tests; only a real desktop finds them.
- Live, after the fixes: asked to type a sentence into Notepad and read it back,
  the session completed with `ui.verifyValue` reporting "The control value
  exactly matches the expected value", and an independent `screen.read` confirmed
  the document contents matched the claim.

### Finding: "could not confirm" was treated as "did not work"

`_executeTaskGraph` gated on `verification.status !== "VERIFIED"`, so an action
that PERFORMED but produced no independent evidence went into diagnosis,
replanning and abort alongside genuine failures. The scheduler already drew the
line correctly (UNCERTAIN, not FAILED) and the interactive loop budgets thirty
unconfirmed actions per session, because a UI click with no declared
postcondition is the ordinary case.

Live: a session that had launched Notepad, found the document control and typed
into it was aborted on `PARTIALLY_VERIFIED: "no explicit postcondition was
supplied"` and reported to the user as "Did not work" — about work that had been
done. The identical request had succeeded minutes earlier purely because the
model happened to attach a postcondition that time.

Unconfirmed steps now continue and are recorded as `VERIFICATION_UNCONFIRMED`.
Nothing is claimed by this: the verification stays in the record, feeds the
summary's remaining problems, and the goal contract — which requires evidence per
criterion — remains the gate on completion. Only a genuine FAILED is handled as a
failure.

Fixing that exposed a latent deadlock. `getReadyTasks` required a dependency to
be exactly VERIFIED, so an UNCERTAIN step left every dependent task PENDING
forever — never ready, never skipped, never complete — and the scheduling loop
spun on a graph that could not finish. The state had been unreachable only
because the runtime aborted first. A dependency that ran but could not be
confirmed now satisfies its dependents, which is what a person does after an
action they could not verify: carry on, and judge by the outcome.
