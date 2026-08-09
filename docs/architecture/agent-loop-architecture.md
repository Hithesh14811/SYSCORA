# From Plan-First Pipeline to Agent Loop

**Status:** Partly implemented — see §9. The remaining proposal stands.
**Date:** 2026-08-07

> **Update after implementation.** The premise of §2–§4 was half wrong, in a way
> worth recording. SYSCORA already *has* an agent loop: `InteractiveAgentController`
> plus `ReasoningEngine.decideInteractiveAction` is a genuine perceive-decide-act
> loop with ACT/OBSERVE/RECOVER/COMPLETE decisions, batched local steps, output
> bindings, postconditions, and evidence-gated completion. It was not missing.
> It was **unreachable** for most requests, and it **crashed on entry** for the
> rest. Building a second loop would have been the wrong move. §9 records what
> was done instead; §5's migration path is superseded for that reason.

## 1. Why this document exists

The readiness report diagnoses SYSCORA's failures accurately — false successes, vocabulary drift, missing routes, fragmented environment awareness — and proposes fixes for each. This document argues that several of those symptoms share one structural cause that the report does not name, and that fixing the cause is cheaper than fixing the symptoms one at a time.

The product goal is that SYSCORA should be to the operating system what Claude Code and Codex are to a codebase. Those systems have no intent classifier and no planner. Understanding why they don't is the whole argument here.

## 2. The structural difference

**How coding agents work.** One loop. The model receives a system prompt, a set of tool schemas, and the conversation so far. It emits either text or tool calls. The harness executes the calls, appends results to the conversation, and re-invokes the model. This repeats until the model emits text with no tool calls. That's the entire control flow.

Three properties fall out of that shape:

- **Generality is compositional.** The tools are thin and few — run a command, read a file, edit a file, search. Breadth comes from the model composing them, so an unseen task needs no new code.
- **Conversation is free.** A greeting is just a turn where the model emits no tool calls. There is no separate chat mode, because chat is the loop's default behaviour.
- **Latency to first action is one model call.** Nothing is computed in advance.

**How SYSCORA works today.** Every message runs `IntentEngine.classify` → match against `OPERATION_PLANS` → `GeneralPlanner` builds a task graph → `PlanValidator` → `RiskEngine` → `PolicyEngine` → approval → `TaskGraphScheduler` executes. The plan is fully computed before the first action, and the set of reachable behaviours is bounded by the operation catalog.

This is the architecture of an intent-driven assistant. It is a good architecture — it is why SYSCORA has a real audit trail, real rollback, and real approval commitments, which coding agents mostly lack. It is the wrong architecture for open-ended breadth.

## 3. What the structure explains

| Report symptom | Structural cause |
|---|---|
| "List installed applications" and "render a directory tree" have no route despite the primitives existing | Reaching a primitive requires an operation entry; the model cannot compose primitives directly |
| Planner emitted `ui.type_text` when the registry exposes `ui.action` | The planner writes a whole graph blind, with no result from step *n* to ground step *n+1* |
| Novel-task planning dies when the provider is unavailable mid-task | A monolithic plan is one large commitment; a loop can lose one turn and retry |
| Tasks degrade into generic UI actions with no state transition | The graph was fixed before any observation existed to shape it |
| Phase 2's remedy is "add deterministic compilers" | Compilers are one handler per task shape — the thing loop architectures exist to avoid |

The compiler treadmill is the important one. Each compiler moves the wall without removing it, and the number of task shapes a person can ask an OS agent for is unbounded.

## 4. The proposal

**Keep the entire control plane. Move the planning boundary.**

The capability registry is the right idea in the wrong position. It should be the **execution and authorization boundary** — nothing runs unless it is a registered capability with a validated schema and a policy verdict — while the **planning boundary** becomes a model loop over that same catalog.

Nothing in the safety architecture is given up. Every property in the readiness report's "definition of done" is preserved or strengthened:

| Layer | Today | After |
|---|---|---|
| `CapabilityRegistry` | Target of a compiled plan | Tool schemas handed to the model each turn |
| `PlanValidator` | Validates a whole graph once | Validates each proposed call before it runs |
| `RiskEngine` / `PolicyEngine` | Scores the plan up front | Scores the concrete call with concrete arguments |
| `PermissionBroker` / commitments | Binds to the plan | Binds to the call, with fresh observed state |
| `EvidenceLedger` / `GoalContract` | Checked at the end | Unchanged — still the completion gate |
| `TaskGraphScheduler` | The only executor | Retained for the deterministic routes that already work |
| `RecoveryEngine` | Replans the graph | Becomes a normal loop turn: the failure is an observation |

### 4.1 Per-call authorization is a safety improvement

Today risk is assessed against a plan built before anything was observed. In a loop it is assessed against the actual call, with actual arguments, at the moment of execution, against fresh state. The readiness report already asks for this in Phase 4 ("require fresh authorization when a replan changes material inputs, capabilities, risk, target, or external effect"). The loop provides it structurally rather than as a rule that has to be enforced.

The `Place order` defect in the report is instructive: a plan-level verdict was computed and then relaxed downstream. When authorization is computed at the call site there is no window between verdict and execution for a relaxation bug to occupy.

### 4.2 What is genuinely lost

Up-front plan preview. Today a user can approve a whole plan once; a naive loop asks per call, which is worse UX for multi-step work.

Mitigation: keep plan generation as a *presentation and scoping* artifact rather than an execution artifact. Before consequential work, the model proposes a strategy the user sees and approves as a scope; the loop then executes within it, re-prompting only when a call falls outside the approved scope. This is what the readiness report's Phase 7 already describes, and it works better over a loop than over a fixed graph, because the scope is a predicate rather than a list.

## 5. Migration path

Additive, reversible, and gated at every step. The existing pipeline keeps serving every route it serves today until the loop demonstrably beats it.

**Step 1 — Tool-schema projection.** Emit JSON tool schemas from `CapabilityRegistry` metadata. Pure addition; no behaviour change. Also delivers Phase 2's "generate planner vocabulary from registry metadata" and structurally eliminates vocabulary drift, since the model can only name tools it was handed.

**Step 2 — Loop behind a flag.** Implement `AgentLoop` alongside `_submitIntent`, off by default, reachable only with an explicit opt-in. It calls the same validator, risk, policy, permission, and evidence services. No existing path changes.

**Step 3 — Shadow evaluation.** Run the Phase 8 benchmark through both paths. Compare goal success, false-success, unauthorized-action, latency, and model calls per goal. The loop ships only where it wins on success rate with zero regression on false-success and unauthorized-action.

**Step 4 — Route unmatched requests to the loop.** The first real traffic is the requests that currently produce "I couldn't map that request" — pure upside, since the alternative is failure.

**Step 5 — Migrate matched routes selectively.** Deterministic compilers that work stay. They are faster, cheaper, and model-independent, which is exactly the report's Phase 2 goal of common tasks working without a provider. The loop is the fallback, not the replacement.

**Step 6 — Conversation joins the loop.** Chat stops being a separate branch and becomes what it is in every coding agent: a turn with no tool calls.

## 6. Ordering against the readiness report

This work slots in **after Phase 0–1 and alongside Phase 2**, not before. Specifically:

- **Phase 0 (safety) and Phase 1 (evidence semantics) come first, unchanged.** Building a loop on a runtime that can report false success would multiply the false successes. Evidence-gated completion is what makes a loop safe to let run.
- **Phase 2 changes shape.** Step 1 of the migration replaces "generate planner vocabulary and aliases" outright. The deterministic compilers are still worth building, but as the fast path rather than as the only path — so the list should be *short and high-frequency*, not exhaustive.
- **Phases 3–5 become more valuable, not less.** The environment model, durable strategy state, and prerequisite resolution are exactly the tools a loop needs. A loop with poor environment awareness is a loop that guesses.
- **Phase 8 becomes the gate for this migration**, which is what Step 3 depends on.

## 7. Risks

- **Cost and latency per task rise.** A loop makes several model calls where a compiled plan made one or two. Mitigations: keep deterministic compilers for common goals, batch mechanically obvious steps locally (already described in Phase 4), and cache the tool-schema prefix.
- **A loop with 73 tools is not a loop with 5 tools.** Coding agents work partly because the tool set is tiny and general. Schema selection — handing the model a task-relevant subset — becomes a real design problem, and the environment model from Phase 3 is what solves it.
- **Unbounded execution.** The existing step, time, model-call, and repetition budgets must apply to loop turns from day one, not be added later.
- **Regression risk to a working system.** This is why the migration is flagged, shadowed, and benchmarked before it takes traffic. No step removes a working route.

## 8. Recommendation

Do not start this before Phase 0 and Phase 1 are complete and the test suite is a real gate. Do start Step 1 now — projecting tool schemas from the registry is required by Phase 2 regardless of whether the rest of this proposal is adopted, and it is the cheapest way to find out whether the loop is viable.

## 9. What was implemented (2026-08-07)

Measured with `scripts/live-routing-probe.js`, an 11-request read-only harness run
against the real configured model. **Before: 4/11 served. After: 10/11 served.**

A warning about the "before" figure: the first baseline was invalid. `createRuntime(basePath)`
resolves the model config from `basePath`, so a probe pointed at a bare temp
directory silently ran against the Mock provider, which answers every prompt with
a canned intent fixture. It looked like it was working. Any harness that builds a
runtime outside the repo root must copy `.syscora/config.json` in, and assert the
provider is not Mock — the probe now does both, and says which it used.

### 9.1 Nothing could reach the loop, and it crashed when it did

1. **The loop crashed on entry.** `_runInteractiveController` persisted the session
   while `session.plan` still held the empty task graph a failed planner had left
   behind. `validateTaskGraph` threw, the error handler tried to persist the same
   session and threw again, and a raw `ValidationError` escaped `submitIntent`.
   Five of eleven probes died this way — it was the single largest failure mode.
   Fixed in two layers: the controller drops a stale plan it supersedes, and
   `persistSession` now drops an unexecutable plan rather than throwing, because
   saving a session must never be what destroys it.

2. **Routing reached the loop by keyword.** `earlyInteractiveGoal` and
   `needsClosedLoopInteraction` gated on `open|launch|click|type|navigate|browser`
   and the APPLICATION/BROWSER categories. Every non-GUI goal — "list the running
   processes", "why is my computer slow" — missed, and was refused on the strength
   of a fallback plan that was never going to run. Replaced with the coverage
   signal already being computed: a candidate plan that does not cover the goal
   means the planner found no route, which is exactly what the loop is for. This
   only ever converts a refusal into an attempt; if the loop does not complete,
   the static plan is restored and the same check still fails closed.

3. **The loop could only see keyword-selected capabilities.** `_catalog(goal)`
   filtered 81 capabilities down by matching the goal text, so `system.inspect`
   was not offered for "how much free disk space do I have". The model proposed it
   anyway — correctly — and was told it was an unknown capability. Now every
   capability the registry marks `LOW` risk and `confirmationPolicy: NEVER` (45 of
   81) is always offered, because those can widen what the agent knows but not what
   it can do. Everything that mutates still has to earn its place by relevance.

4. **Perception could kill a session.** `this.adapter.listWindows().catch(...)`
   handles a rejected probe but not an adapter that lacks the method, so a
   `TypeError` escaped perception. Now treated like the UIA and browser probes
   beside it: being unable to observe is not a failure of the task.

### 9.2 Conversation became a route instead of a leftover

Chat previously required the full classify → context → plan pipeline to complete
and return nothing before `converse()` was called, and the answered session was
then recorded as `FAILED`. Live, a greeting took ~19s.

The intent schema gained a `CONVERSATION` category and a `directAnswer` field, so
a message that asks nothing of the computer is recognised and answered in the
classification call itself. Greetings now settle in **~2s**, and `ANSWERED` is a
first-class `LifecyclePhase` rather than a failure rendered under "this did not
work". A classification that claims conversation while naming a typed operation
loses to the executable route, so a real task cannot be answered with a guess.

### 9.3 Enum drift was the reason categories never worked

`category` was declared `{ type: "string" }` and the allowed values lived only in
prose. Models answered `communication`, `information_retrieval`, `system` — none
of which match any route. `validateSchema` ignored `enum` entirely, so adding one
would have changed nothing.

`validateSchema` now enforces `enum`, and `INTENT_SCHEMA.category` declares one.
Providers supporting strict `json_schema` enforce it at generation time; the
validator catches the rest and drives the existing bounded repair. This is the
general form of the readiness report's "vocabulary drift" finding: **a closed value
set is only a constraint if something checks it.**

### 9.4 What is still open

- **`read-slow` is nondeterministic** — it completed on one run and was refused on
  the next. Same input, same build. The loop's reliability on open-ended
  diagnostic goals is not yet a property you can depend on.
- **No capability lists installed applications.** `package.winget.search` queries
  the repository, not the machine. The request is currently served by a
  deterministic route of debatable relevance; the honest fix is an
  `application.listInstalled` primitive.
- **Provider fragility is load-bearing.** One probe run lost a request to `HTTP 429`.
  A loop makes several model calls per task, so rate limits hit harder than they
  did with one-shot planning.
- **Latency.** Read-only tasks run 17-28s. Most of that is model round-trips inside
  the loop; the `localSteps` batching already in `decideInteractiveAction` is the
  lever, and it is under-used.
- **The §5 migration path is superseded.** The loop is now the default route for
  uncovered goals. What remains from this document is §4.1 (per-call authorization)
  and §7 (risks), neither of which has been acted on.
