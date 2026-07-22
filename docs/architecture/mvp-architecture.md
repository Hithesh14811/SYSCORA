# MVP Architecture

SYSCORA executes requests through one canonical runtime path:

1. classify intent and collect requested context
2. populate the semantic world model through Perception and retrieve relevant memory
3. generate a capability-bound TaskGraph and validate it against the registry
4. assess risk, apply policy, and obtain approval where required
5. execute tasks through the TaskGraphScheduler, then observe and verify each result
6. diagnose failures within a normalized recovery budget, replan when safe, or roll back
7. finalize the goal, snapshot semantic state, update memory, and persist redacted session/audit records

## Current Subsystems

- `apps/daemon`: runtime composition root and token-authenticated local API
- `apps/desktop-shell`: Electron shell that starts and embeds the daemon UI
- `packages/agent-runtime`: canonical orchestration, session control, goal verification, rollback journal
- `packages/task-graph-scheduler`: dependency-aware task execution and task state tracking
- `packages/capability-registry`: one canonical adapter-backed definition per capability, plus the opt-in signed-plugin loader
- `packages/permission-broker`: deny-by-default capability grants (scope, type, lifetime, reuse) issued per session and consumed at execution
- `packages/audit`: append-only SHA-256 hash-chained audit log with tamper-evident `verifyChain()`
- `packages/perception`: sole SemanticState writer, provider normalization, observations, snapshots, and effects
- `packages/semantic-state`: SQLite graph store queried by planner and recovery
- `packages/memory`: redacted SQLite working, episodic, failure, and procedural memory
- `packages/reasoning-engine` and `packages/model-providers`: bounded model boundary with deterministic fallbacks
- `packages/secrets`: DPAPI-backed secret broker; only references enter plans and history
- `packages/recovery-engine` and `packages/troubleshooting-engine`: bounded recovery decisions and diagnosis
- `os-adapters/windows`: Windows system, environment, filesystem, package, and developer-workflow adapters

## Explicit Non-Goals

- unrestricted shell access
- unrestricted browser, Office, or registry automation
- **general-purpose** Windows UI automation (arbitrary apps / blind coordinate clicking).
  A single, bounded, window-scoped UI Automation capability now exists —
  `spotify.track.play` drives the installed Spotify desktop client (launch → wait →
  search → select → activate play) via native Windows UI Automation and verifies
  playback independently from the live window title. It is LOW risk, scoped to the
  Spotify window/process, uses only bounded waits, and reports partial/failed
  honestly. This does not open the door to unscoped UI automation of other apps.
- autonomous privilege escalation
- untyped tool execution
