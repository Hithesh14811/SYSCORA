# M4 implementation map

This map reflects the code, not the older MVP documentation.

## Existing path

`POST /api/intents` -> `AgentRuntime.submitIntent` -> `IntentEngine` ->
`GeneralPlanner` -> risk/policy/grants -> `TaskGraphScheduler` -> capability
`execute/observe/verify` -> Perception/SemanticState -> goal verification.

## M4.1 Windows automation

- `WindowsAdapter` delegates desktop operations to one persistent STA
  PowerShell/.NET host over JSON-lines IPC, retaining process-isolated fallbacks.
- Generic window, UIA, keyboard, pointer, clipboard, capture, OCR, and visual
  target primitives are capability-registered and planner-visible.
- UIA targets carry window identity, selectors, bounds, supported patterns and
  observation time. Visual targets carry confidence, window-relative geometry,
  and observation time.
- UIA actions re-find controls after state changes and reacquire foreground
  focus. Visual actions re-ground window-relative coordinates before use.
- Window capture activates the requested window first so OCR cannot silently
  perceive an overlapping application.

## Adaptive controller

- `InteractiveAgentController` is a bounded perceive → decide → act → observe →
  verify loop for goals that do not fit a reliable static task graph.
- Budgets cover steps, model calls, elapsed time, repeated actions, failures, and
  recovery. Repeated action/state signatures terminate safely.
- One structured model decision may provide a small deterministic local sequence;
  mechanically obvious steps run locally without another model call.
- Every proposed action must name a registered capability and pass its input
  schema. UI/DOM mutation targets must appear in runtime-observed state.
- Each action becomes a one-task plan and re-enters the canonical runtime
  validation, risk, policy, permission, grant, execute, observe, verify and audit
  path.
- Known typed operations and complete model-generated task graphs retain the fast
  static path. Healthy-model deterministic fallbacks enter the adaptive path
  first so a partial keyword match cannot truncate a novel goal.

## Browser and external reasoning

- `CdpBrowserAdapter` supplies structured Chromium launch/connect, navigation,
  state, inspect, find, click, type, select, scroll, wait, read, and verified
  download primitives without a mouse.
- Browser DOM targets are issued and remembered by the adapter; fabricated or
  stale target ids are rejected.
- Machine context is classified and sanitized before external reasoning:
  credentials, clipboard contents, personal paths, email addresses, and private
  file-like window titles are removed. Screenshots remain local by default.

## Remaining scope

- Foreground GUI actions stay serialized.
- Optional local object detection beyond text/UIA is not bundled; external visual
  reasoning remains policy-gated and disabled by default.
- Natural-language adaptive operation requires a healthy configured model
  provider; provider outages fail boundedly and truthfully.

The canonical runtime, permission broker, risk engine, observations, verification,
rollback, and audit path remain authoritative.
