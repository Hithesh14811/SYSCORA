# SYSCORA — brief for a cold session, 17 Aug 2026

Copy this whole file as the opening message to a new Claude Code session, or
point that session at it. It assumes nothing.

---

## Part 0 — What you are working on

SYSCORA is an agent that operates a real Windows machine from natural language:
Claude Code's shape, pointed at the whole OS instead of a repository. It runs on
the user's actual machine with their actual logins — not a VM, not a sandbox.

Read, in order, before touching anything:

1. `CLAUDE.md` — house style and the non-negotiable rules.
2. `docs/state-of-the-world.md` — what works, measured.
3. `docs/production-plan.md` — the ordered work, and the four target numbers.
4. This file — which supersedes parts of both. Where they disagree, this wins,
   and the disagreements are listed in Part 2.

### The competitive frame — why this work is shaped the way it is

Three systems are ahead of or beside SYSCORA. You need to know exactly how they
work, because the whole strategy below is built on where they are structurally
stuck.

**Anthropic's computer use** is a tool schema, not a product: `screenshot`,
`left_click(x,y)`, `type`, `key`, `scroll`. The loop is written by whoever
consumes it. Every perception step is a full-resolution screenshot — about 1,365
tokens for 1280×800 under the `w*h/750` rule — shipped to a remote model, and
every image stays in the conversation, so cost grows roughly quadratically with
step count. Anthropic's own description: slow, error-prone, a "flipbook" view of
the screen that misses anything short-lived.

**OpenAI's CUA / Operator** is the same shape with the loop moved server-side and
the environment a hosted VM. Launched at 38.1% on OSWorld.

**Pointer** (pointer.ai) is the real competitor and they open-sourced everything.
83.6% on OSWorld with Claude Opus 4.7, 81.5% with Sonnet 4.6, single runs, human
baseline 72.4%. Their harness:

- a **feasibility gate** (cheap model) that probes the live machine with
  read-only bash/python and decides whether the task is possible **before any
  work starts**. Caught 24 of 28 deliberately impossible tasks; false-rejected 2
  of 333 valid ones.
- a **planner** (cheap model) emitting **milestones that describe states, not
  steps** — "the spreadsheet is sorted by date and saved", never "click Data,
  then Sort, then OK". The executor decides the *how*; the planner only fixes the
  *where*.
- one **executor** (strong model) with every tool and no sub-agents: GUI verbs +
  raw Python/Bash + Chrome over CDP + a detached background-process tool.
- a small model compacting context in the background.
- one rule in the system prompt: **two failed attempts at the same mechanism →
  switch approach entirely.**

The number that should drive everything you do here: **the harness took Sonnet
from 72.1% → 81.5% while making it CHEAPER, $0.16 → $0.15 per task.** The
planner's fixed up-front token spend bought back more than it cost, because the
executor wandered less. Their conclusion: the model is a swappable component, the
harness is the system. Their own stated frontier — the thing they say is hard and
unsolved and are writing a later post about — is **verification: producing
evidence the work is correct rather than merely plausible.**

SYSCORA has already built that. `packages/fast-agent/src/evidence.js` makes a
success sentence unreachable without a CONFIRMED verdict from a capability other
than the one that acted. That is the moat, and nothing else on this list matters
if it gets weakened.

### The strategy, in one sentence

**Everyone else pays a full model round trip for every perception step, because
screenshots are the only thing they can see. SYSCORA reads the UIA accessibility
tree, so it can check preconditions locally and for free — which means it can
collapse N round trips into one, and verify without a second model call. Drive
model round trips per completed task toward 1, and toward 0 on repeats.**

That is a harness advantage, not a model advantage, so it survives whatever model
is plugged in. Do not compete on open-ended novel capability; that is model-bound
and the frontier labs win it.

---

## Part 1 — What actually exists (verified by reading the code, 17 Aug 2026)

### The route a request takes

`AgentRuntime.submitIntent` → `_canRunFastAgent` (true whenever the provider
supports chat) → `_submitFastIntent` → `new FastAgent(...)`
(`packages/agent-runtime/src/index.js:528`) → `FastAgent.run`
(`packages/fast-agent/src/index.js:613`).

`FastAgent.run` in order: skills replay → local fast path → machine profile +
notes → a flat `while (steps < maxSteps)` model/tool loop. **There is no planning
layer of any kind.** Every step re-decides everything from scratch.

### Genuinely good, do not break

- **`evidence.js`** (192 lines). `evidence({observed, method, verdict, actedVia})`
  refuses at construction to build a receipt whose `method` equals its `actedVia`
  — the "verification must not share a code path" rule enforced rather than
  remembered. `confirmed()` throws without a CONFIRMED verdict. Three verdicts,
  never two. `NOTHING_READ_IT_BACK` is a real method name, valid only with
  UNCONFIRMED. `tests/unit/tool-evidence.test.js` executes all ~30 tools.
- **The loop's backstops** (`claimsWithoutEvidence`, `looksUnfinished`,
  `looksLikeMalformedToolCall`, `wasTruncated`). Each was written after a
  specific live lie. The comments name the transcript. Read them before you touch
  the loop.
- **Skills** (`skill-replay.js`, `skill-recorder.js`, `skill-verify.js`).
  Replays at 0 tokens. Has real preconditions (`app-running`, `focused`,
  `window-state`, `fresh-document`, `path-exists`), per-step `verify`, and a
  handover that names `alreadyDone` irreversible steps so a half-replay is not
  restarted from the top and a message is not sent twice. The recorder refuses
  far more than it accepts and says why.
- **`screen-signature.js`**. Pixel-grid brightness diffing, calibrated against
  real 2906×1730 Paint captures, because text perception is blind to drawings and
  a PNG byte hash is too sensitive (the pointer coordinate readout in the status
  bar changes it). Grid 64, threshold 3.
- **The webview frame-vs-content split**
  (`os-adapters/windows-host/restore-host.ps1`, `webview-windows.js`). The single
  costliest bug in the project's history. Do not touch without reading the
  comments.
- **UIA `InvokePattern` for named pressable controls** — ~27ms, immune to
  z-order, foreground and DPI, where a synthetic click is swallowed.

### Already built and BETTER than `docs/state-of-the-world.md` claims

These are the corrections. Do not redo this work.

- **`batch` EXISTS** — `packages/fast-agent/src/tools.js:5311`. Up to 40
  `{tool, args}` steps in one round trip, stops at the first failure (including
  quiet failures, not just thrown ones), each step gated by its own tool's
  evidence. `acts: false`, so it never speaks in its own words. What it lacks is
  per-step *preconditions* — see P3.
- **Failover EXISTS in code** — `FailoverModelProvider`
  (`packages/model-providers/src/index.js:578`) and `createModelProviderChain`
  (`:1809`), already wired through `runtime-factory.js:144`. Implemented
  providers: OpenAI, Anthropic, Mistral, Gemini, AgentRouter gateway, Mock.
  W4.1 "one provider, no failover" is a **configuration** gap of about ten lines
  of JSON, not a workstream. `.syscora/config.json` currently names one DeepSeek
  endpoint on Baseten and no `fallbackProviderConfigs`.
- **`SYSCORA_KEEP_HISTORY=1`** already turns off both `supersedeEarlierReading`
  and `pruneConversation`, and `scripts/probe-history-cost.mjs` already measures
  both ways.

### Missing, and this is the actual gap

1. **No planner. No feasibility gate.** Confirmed by reading `run()`. This is the
   single largest measured win available (Pointer: +9.4pp accuracy at lower cost)
   and it does not exist in any form.
2. **`batch` steps are blind.** A step cannot state what must be true before it
   runs, so the model cannot safely batch across any uncertainty — which is why,
   despite `ONE DECISION, MANY ACTIONS` being shouted in the system prompt, the
   drawing task still spent 54 steps and 894k tokens on individually reasoned
   drags.
3. **The repeat guard punishes instead of redirecting.** `attempts >= 3` →
   "STOP and ask the user" (`index.js:1098`). Pointer's rule is better and
   cheaper: two failures at the same *mechanism* → switch mechanism. SYSCORA's
   guard also keys on exact arguments, which the model routes around by varying
   them — hence the coordinate bucketing patch.
4. **No delta perception.** `screen` returns a fresh listing up to 240 elements;
   the previous one is collapsed to a stub, which **rewrites a message in the
   middle of the conversation and moves the cache prefix**. Measured: 6 steps,
   24,725 fresh tokens with the collapse on vs 16,196–16,623 with it off.
5. **No cost budget anywhere.** `maxSteps` 80, `maxElapsedMs` 6 minutes. Nothing
   stops a run at 894,000 tokens. The wall clock is the only ceiling.
6. **The fast path is six rules** — mute, unmute, volume set, volume read,
   launch, close.
7. **Nothing visual ever reaches the model.** Perception is text-only. There is a
   `VisionProvider` in `packages/perception/` but it builds UIA entity graphs; it
   is not an image path to a multimodal model. Consequence, measured: an emoji
   react button is an unlabelled icon, invisible to a text reading, and hunting
   for it cost 48 steps and 692,000 tokens.
8. **The eval does not gate anything.** 19 task files in `tests/eval/tasks/`,
   `scoreboard.md` shows 2 runs, no budget assertions, not in CI.
9. **No undo journal.** `docs/trust-and-triggers.md` is unbuilt.

### Dead weight — know it is there, do not feed it

About 20,000 lines of a staged pipeline sit under the loop and only run when no
model can be reached at all: `capability-registry` (4,687), `agent-runtime`
(3,782, most of it), `interactive-agent-controller` (3,162), `reasoning-engine`
(1,565), `planner` (1,381), `intent-engine` (1,326), plus `task-graph-scheduler`,
`risk-engine`, `troubleshooting-engine`, `recovery-engine`, `semantic-state`.

**Trap: `packages/planner/` already exists and is NOT the loop's planner.** When
you build P2, do not put it there and do not import it. Name yours
`packages/fast-agent/src/plan.js`.

---

## Part 2 — Where this brief overrides the existing docs

- `production-plan.md` W4.1 "a second model provider with automatic failover" is
  listed as unbuilt. The code is built; only the config is missing. Demote it to
  a ten-minute task (P0.1).
- `state-of-the-world.md` "Drawing is a demo, not a capability" and the
  "Descope, explicitly" section: **do not descope it.** It is the clearest
  possible test case for P3 (precondition-carrying batches). If one planned
  composition executed as a handful of self-checking batches cannot draw a train,
  P3 has failed and you have learned that cheaply.
- `production-plan.md` W2.4 leaves the history collapse on by default pending
  more data. Turn it **off** by default now (P0.3) — the measurement points one
  way, and P4 replaces it with something strictly better anyway.

---

## Part 3 — The work, in order, with measurable done

Every item is measured on the real machine with a script in `scripts/`. If it
cannot be measured there it is not done. Existing probes:

```
scripts/probe-fast-agent.mjs "<request>"   one real request end to end
scripts/probe-prompt-cache.mjs             does the endpoint cache the prefix
scripts/probe-history-cost.mjs             same task with/without the collapse
scripts/probe-fast-path.mjs                requests that should cost nothing
scripts/probe-evidence.mjs                 every tool's receipt and its cost
scripts/measure-prompt-cost.mjs            per-step fixed prompt cost
```

**FRESH IS WHAT YOU ARE BILLED. SENT IS WHAT THE AGENT DID. Report the first,
gate on the second.**

This used to read "quote `tokensFresh`, never `tokensIn`", full stop. That is
right for reporting COST and wrong for detecting a REGRESSION, and the
distinction was never drawn.

`tokensFresh` is what the endpoint bills at full rate — the money, and the right
number to put in front of a human. It is also **decided by the provider's prefix
cache, which is not in this codebase and does not change when the code does.**
Measured 21 Aug 2026 across three identical sweeps of one suite: cache hit 97.1%,
75.2%, 75.6%, and the headline median moved 206 → 2,598, which is 876%. The
drawing row billed 7,912 and 103,455 at the **same 23 steps**. `files-read-contents`
— reading one file — ranged 45 to 2,558. Nothing in the code differed.

`tokensIn` moved 8% across that same pair. It is steps × how much conversation
each one carried: it moves when the AGENT changes and holds still when only the
endpoint does. So the eval gate is on tokens sent, and the scoreboard prints the
cache hit rate beside the fresh figure so any cost difference can be read against
it before anyone goes hunting for a bug.

Do not re-derive the old rule from the old sentence: gating on fresh tokens fires
when someone else's cache went cold, and a gate that cries wolf gets switched off.

---

### P0 — Free wins. Hours, not days. Do these first.

**P0.1 — Rotate the leaked key and wire failover.** The Baseten key in
`.syscora/config.json` under `primaryApiKey` has been exposed in a chat
transcript; it must be rotated by the user (do not attempt this yourself). Then
add a second and third provider via `fallbackProviderConfigs` — the plumbing in
`createModelProviderChain` already handles it.
*Done:* kill the primary endpoint mid-run → provider B completes the run, proven
with `probe-fast-agent.mjs`.

**P0.2 — A hard cost ceiling on a run.** Add `maxFreshTokens` beside `maxSteps`
and `maxElapsedMs` in `FastAgent`. On breach, settle PARTIALLY_COMPLETED with an
honest sentence naming the number. Default 150,000.
*Done:* a deliberately looping task stops at the ceiling instead of at 894k.

**P0.3 — Default the history collapse off.** Invert `KEEPS_HISTORY_INTACT` to an
opt-in `SYSCORA_COLLAPSE_HISTORY=1`. Keep both paths and both tests until P4
lands and the eval settles it.
*Done:* `probe-history-cost.mjs` run three times each way, median `tokensFresh`
recorded in the scoreboard.

---

### P1 — The eval must exist before anything else changes behaviour

You are about to change the loop's shape. Without a baseline you cannot tell
improvement from regression, and every number in this project has been an n=1
hand-run.

Wire all 19 tasks in `tests/eval/tasks/` into `npm run eval`. Add budget
assertions per task: pass/fail, median `tokensFresh`, median wall time, median
steps. Record a baseline before touching P2.

*Done:* `npm run eval` fails CI on a token or latency regression, and
`tests/eval/scoreboard.md` shows 19 rows.

---

### P2 — The LAZY planner

The highest-value change available — but only for long tasks, and the obvious
implementation makes short tasks worse. Read the whole of this section before
writing any code.

**WHY UPFRONT PLANNING IS THE WRONG SHAPE HERE.** Pointer measured planning as a
clear win, and it is — on OSWorld, whose largest category is 93 multi-application
tasks and whose typical task is long. SYSCORA's real distribution is the
opposite: most requests are short. A model round trip on this setup is roughly
2–3 seconds, so a gate plus a planner bolted onto the front costs every request
two extra round trips before anything happens.

Applied to the measured numbers, that turns `is python installed?` from 2 steps
and 5.8s into roughly 4 steps and 10–12s. Planning is a straight LOSS below about
six steps, and a large win above about fifteen. Taking Pointer's result and
applying it to a different task distribution is the mistake this section exists
to stop.

**THE SHAPE THAT ACTUALLY WINS: TWO TRIGGERS, AND NEITHER IS TRUSTED ALONE.**

Do not plan before starting. Let the executor begin immediately — the first
sentence on screen in under a second with the work already underway is the
product's whole feel, and it must not be traded away. Planning is then reached
two ways:

*Trigger 1 — the model asks, via a `plan` tool it MAY call.* This costs nothing
extra: the executor's first model round trip happens regardless, so choosing to
call `plan` inside that turn is free. It catches the obviously-large job on turn
one, before six steps are wasted discovering it. Roughly 100 tokens of tool
schema, which sits inside the cached prefix — about 10 fresh-token-equivalents
per run.

*Trigger 2 — the loop decides, on a step threshold.* Start at 6 and tune it from
the eval. This one is not optional and must not be removed once trigger 1 works.

**WHY BOTH.** Trigger 1 alone will fail, and this codebase has already run that
experiment twice. The system prompt has demanded `ONE DECISION, MANY ACTIONS`
since the beginning and the model does not comply — `tools.js:5303` says so
outright: *"the models do not comply; that is not something a stronger sentence
fixes."* Same for the five separate shipments of `"Muted."` with no tool call,
against a prompt that forbade exactly that.

There is also a known direction to the error. Models are optimistic about their
own competence — Pointer named it "unbounded optimism" and measured it: their run
installed a password cracker to break a password that did not exist, and
installed Tor to route around a blocked site. Asked "is this big enough to need a
plan?", the model will answer *no* more often than it should, and it will be
wrong precisely on the expensive tasks.

So: prompt/model guidance for speed, deterministic enforcement for correctness.
That is the pattern the rest of this codebase already uses — `claimsWithoutEvidence`
is exactly this shape, the prompt asks and the backstop catches.

The threshold trigger already half-exists: the loop counts steps, and
`unchangedReadings` and the repeat guard already detect a run going nowhere.
Today their response is to give up and ask the user (`index.js:1098`, `:1183`).
Planning is a far better response to the same signal. Consider replacing the
give-up branch rather than adding a parallel one.

Instrument both: record which trigger fired on every run. If trigger 2 is firing
on tasks where trigger 1 declined, that is the optimism above, measured — and it
is the evidence for keeping the backstop.

**The planner itself.** A cheap model emits 2–6 **milestones, each describing a
state the machine should be in**, never a sequence of clicks. "The Amma chat is
open and the message is visible in the conversation with a timestamp", not "click
search, type Amma, click the result". The executor is free to reach a milestone
any way it can; a milestone survives a moved menu, a click sequence does not. The
executor may revise the plan mid-task when evidence says the route is wrong.

**THE FEASIBILITY GATE IS DEMOTED — do not build the model-powered version.**
1 in 13 OSWorld tasks is *deliberately* impossible; that is a property of the
benchmark, put there on purpose. In production a user's request is almost always
possible, so a model round trip on every request to catch a near-zero base rate
is a bad trade. Keep only the FREE checks — is the application installed, does
the path exist — which cost no model call and which the machine profile
(`machine-profile.js`) already partly performs. Extend that instead.

**THE CACHING TRAP, and it will silently cost you money if you get it wrong.**
The planner must run as a **separate conversation with its own stable prefix**.
The executor's system prompt and tool schema must stay byte-identical to what
they are today, because that 8,222-token prefix is what the endpoint caches. Do
not prepend the plan to the executor's system message — that changes the prefix
at its start, which is the control case in `probe-prompt-cache.mjs` that returned
`cached_tokens: 0`. **APPEND the plan as a new message** at the point the run
paused, so everything before it stays cached.

For the same reason: do not scope tools per request. The tool schema is inside
the cached prefix. `production-plan.md` W2.2 has the measurement.

*Done, and all four are required:*
- short tasks UNCHANGED — `is python installed?` and `disk space` show no
  increase in steps, time or `tokensFresh` against the P1 baseline. If they
  regress at all, the trigger threshold is wrong.
- the drawing task finishes, in under half the steps of the baseline.
- eval median `tokensFresh` down, pass rate not down.
- the planner fires on fewer than a third of eval tasks. If it fires on most of
  them, it has become upfront planning by another name.

---

### P3 — Precondition-carrying batches. This is the unfair advantage.

Nobody else can copy this, because a screenshot agent has no way to check "is the
Sort dialog open" without asking the model. SYSCORA has UIA.

Extend `batch` (`tools.js:5311`) so each step may carry an `expect`: a cheap,
local, deterministic predicate over UIA state — an element with this label is
present / focused / the window title contains this / this field's value is empty.
Before each step, evaluate `expect` locally. If it holds, run the step. If it
fails, stop the batch and return **which precondition failed and what was
actually there** — that message is what the model reads, and it costs nothing
until it is needed.

Then the model can safely emit ten steps in one call, because every step is
self-checking. Twelve calculator digits become one round trip. A form becomes
one. A menu path becomes one.

Two rules that keep it honest:
- `expect` predicates are evaluated by a capability that did not perform the
  previous step. Same rule as `evidence.js`, same reason.
- A batch still never speaks in its own words. `acts: false` stays.

*Done:* the calculator task and the form task each complete in ≤3 model round
trips; the drawing task completes at all, under 100k `tokensFresh`; measured with
`probe-fast-agent.mjs`.

---

### P4 — Delta perception and append-only history

Two problems, one fix.

Today a re-read returns a full listing and the old one is rewritten in place,
which moves the cache prefix and turns every later message back into full-price
tokens. That is where a GUI task's money goes.

Give elements stable ids per window and return, on any read after the first,
**only what changed**: appeared, disappeared, changed value, changed focus. Never
rewrite an earlier message. If an old reading must be marked stale, **append** a
line saying so; do not edit the message that holds it.

`pruneConversation` has the same defect and the same fix — when the conversation
genuinely must be cut, cut once, deeply, and accept that one step pays full
price rather than every step paying it.

*Done:* the WhatsApp read task's `tokensFresh` under 15,000 (from 26,766); the
prefix cache hit rate stays above 90% across a 10-step run, proven from
`prompt_tokens_details.cached_tokens` in the loop's own counters.

---

### P5 — Two strikes, then switch

Replace the punish-at-3-identical-calls guard with Pointer's rule, which is
strictly better because it redirects rather than terminates.

Count failures per **mechanism**, not per exact call: "clicking in this window",
"this shell command", "this browser route". Two failures of the same mechanism →
inject a message that names the mechanism as exhausted and demands a *different*
one, with the alternatives spelled out (keyboard instead of mouse, command
instead of GUI, direct URL instead of a form). Only after two different
mechanisms have failed does it stop and ask the user.

Keep the existing coordinate bucketing and the screen-changed reset — both were
written after real failures and both still apply.

*Done:* the emoji-react task stops in under 10 steps having tried keyboard and
menu routes, not 48 steps of coordinate guessing.

---

### P6 — Role-based model routing, fixed for the run

The user's instinct here is right but the obvious implementation is wrong. Read
this carefully.

**Do not build a per-request classifier that picks a model.** Two reasons. A
classifier that calls a model to decide which model to call has already spent the
saving. And switching models within a run gives you a cold prefix on every
switch, destroying the 96.6% cache hit that is currently the single biggest thing
keeping costs down.

**Build role-based routing instead**, exactly as Pointer did: gate and planner on
a cheap model, executor on a strong one, compaction on the cheapest available.
Each role has its own conversation and therefore its own stable prefix, so
nothing is broken.

If the executor's model must also vary by task difficulty, choose it **once,
before the first executor request, from a deterministic signal** — the number of
milestones the planner emitted, whether any milestone touches the GUI, whether
the task names an irreversible action. Deterministic, same shape as
`fast-path.js`. Never mid-run.

Pointer's measured result for this: 98% of the strong model's accuracy at 43% of
total cost.

*Done:* the eval suite runs end to end on a cheap executor within 3 percentage
points of the strong one, at under half the cost; cache hit rate unchanged.

---

### P7 — A narrow vision escape hatch. NOT a general fallback.

The user asked about screenshots as a backup. The right version is much narrower
than that, and the wrong version imports the exact cost curve that makes Claude
computer use and OpenAI CUA expensive.

The real, measured problem it solves: an unlabelled icon is invisible to a text
reading, and no amount of hovering or coordinate guessing reveals it — 48 steps
and 692,000 tokens on one emoji react.

Build it with four constraints, all of which matter:

1. **Cropped, never full-screen.** Send the region of interest — a toolbar strip,
   a message row — not 1280×800. Image tokens are roughly `w*h/750`.
2. **One shot, never accumulated.** The image is dropped from the conversation
   after the turn that consumed it. This is the whole difference between an
   escape hatch and a screenshot agent.
3. **It returns LABELS, not actions.** The model looks at the crop and names what
   it sees and where. The click still goes through the ordinary path and still
   produces an ordinary evidence receipt read back over UIA. **The vision path
   must never become the action path** — if it does, you have given up the
   verification invariant, which is the moat.
4. **Triggered by the existing `unchangedReadings >= 3` counter**
   (`index.js:1183`), which currently just tells the model to give up. That is
   precisely the right trigger and precisely the wrong response.

Note the coupling: this needs a multimodal model, and the configured DeepSeek
executor may not be one. So P7 depends on P6 — vision is a role, like the others.

*Done:* the emoji-react task succeeds; a task that never triggers the hatch shows
zero image tokens; total run cost for the react task under 40,000 `tokensFresh`.

---

### P8 — Perception speed

`screen` on WhatsApp is ~2–4s, dominated by a whole-tree `FindAll`. Cache the
tree per window and invalidate on UIA structure-changed events; or scope
`FindAll` to the focused pane rather than the window root. Measure before
choosing.

Do not put pixel loops in `restore-host.ps1` — the machine's antivirus flagged
the entire script as malicious last time, which broke every GUI action. The
comment at the top of `screen-signature.js` has the story.

*Done:* p50 `screen` under 1.2s on WhatsApp, Spotify and Chrome.

---

### P9 — Skills self-healing

Pointer's stated objection lands directly on this feature and must be answered:
"the moment you hand an agent a sequence of clicks, you've made it brittle — an
unexpected dialog box or a slightly moved menu becomes fatal."

The answer already half-exists: preconditions, per-step `verify`, and a handover
that names what has already happened. Finish it. When a step's precondition
fails, fall back to the model **at that step only**, let it find the new route,
and then **rewrite that one step in the saved skill** and record what changed so
the user can see it. Not the whole task, not silently.

*Done:* a skill broken by a deliberate layout change repairs itself once, records
the diff, and the user can see, edit and delete skills in the panel.

---

### P10 — Undo journal

`docs/trust-and-triggers.md`. Every irreversible action writes a compensating
entry before it acts: what was done, how to reverse it, how long the reversal
stays possible. Where nothing can reverse it, the journal says so — that is also
information the user needs.

This is what an enterprise buyer asks about first, and it has not been started.

*Done:* `undo` reverses the last reversible action and refuses honestly when it
cannot; a test sends a message and un-sends it.

---

## Part 4 — Rules you may not break

From `CLAUDE.md`, and every one of them was written after a specific defect:

- **Never claim something happened without evidence from a tool.** Structural,
  not conventional. A new tool without a receipt fails
  `tests/unit/tool-evidence.test.js`.
- **Unconfirmed is not failed.** Three verdict states, never two.
- **Verification must not share a code path with the thing it verifies.**
- **A check with an empty needle is not a check.**
- **Safety lives in `shell-rules.js` as data**, checked at the tool boundary,
  never as a pipeline stage. `content-boundary.js` is the same shape for
  injection: what the agent READS is never what it was asked to do, enforced on
  the DESTINATIONS an instruction names rather than by recognising English.
- **Comments carry the reason** — the specific defect observed live. Match the
  density of the surrounding code.
- Ask before restarting or closing an app the user has open.
- `npm test` is ~9 minutes. Never pipe it through `tail`/`grep` in a way that
  buries the summary. While working, run the single file:
  `node --test --test-timeout=240000 --test-force-exit tests/unit/<file>.test.js`
- Prose in tool descriptions is re-sent on every step.
  `node scripts/measure-prompt-cost.mjs` prints the price. Prefer putting a
  lesson in the **result a tool returns on failure**, where it is read at the
  moment it matters and costs nothing the rest of the time.
- `.syscora/` holds secrets in plaintext. Never print them.

## Part 5 — How to report progress

For each item: what changed, the before and after numbers from a named script,
and what you did not do. Never report a target as met on an argument; only on a
measurement. If something is blocked, finish everything else and say plainly what
was left and why.
