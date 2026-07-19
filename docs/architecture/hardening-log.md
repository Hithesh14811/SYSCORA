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
