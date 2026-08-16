# Skills

The specification for the thing that turns SYSCORA from a demo into infrastructure.

Today "send Chintu a message" costs twelve steps, ~150,000 tokens and a minute —
**every time**. The hundredth time is exactly as expensive as the first. A skill
is the verified route, saved once and replayed deterministically: three seconds,
no model calls, and no re-rolling the dice on which Chintu it picks.

This document is the contract. Read it before writing any of it.

---

## 0. Before you write anything

Four things this spec depends on already exist. Confirm them, because the design
leans on all four and a wrong assumption here is expensive later:

1. **Section annotations.** A screen reading marks each row with the list it
   belongs to — `text "Chintu jeppu" @718,1151 [under "Messages"]`. This is what
   lets a step say *"the contact row, not a message that mentions them"*, and it
   is why §4.1 can forbid coordinates. See `sectionOf` in
   `packages/fast-agent/src/tools.js`.
2. **The focused-value read.** `focusedValue()` in the same file asks the
   application what its focused control currently holds. That is the
   `input-empty` verification in §4.3, and it is how a send is proved.
3. **The gates.** `requiresConfirmation`, `requiresClickConfirmation` and
   `requiresSendConfirmation` in `packages/policy-engine/src/shell-rules.js`.
   §4.2 says a skill must not bypass them.
4. **The eval harness.** `npm run eval -- --mock` should pass its own plumbing
   check. You will need it for §12.

Then run `npm run eval` once, on a machine nobody is using, and keep the
scoreboard. Skills are a performance feature, and you cannot show a performance
win without a before.

---

## 1. What a skill is, and is not

A skill is **not** a recording of what the mouse did. That is a macro, and macros
are why RPA breaks: UiPath records `click(718, 1151)`, somebody resizes a window,
and the robot clicks a blank pixel and reports success.

A skill is **a parameterised description of what was true at each step**, plus
how to re-establish those truths. It stores intent and evidence, never geometry.

| stored | never stored |
|---|---|
| `click the element labelled "{contact}" under "Chats"` | `click(718, 1151)` |
| `verify the chat header reads "{contact}"` | `assume the header is right` |
| `ensure WhatsApp is running, focused, maximised` | `assume the window looks like last time` |

---

## 2. Storage

`.syscora/skills/<id>.json`, one file per skill. Same pattern as
`packages/fast-agent/src/notes.js`: plain, inspectable, editable by the user in
Notepad, deletable without ceremony. **A skill the user cannot read is a skill
they cannot correct.**

```json
{
  "id": "whatsapp-send-message",
  "title": "Send a WhatsApp message",
  "createdAt": 1755264000000,
  "updatedAt": 1755264000000,
  "parameters": [
    { "name": "contact", "description": "who the message goes to" },
    { "name": "text", "description": "what to send" }
  ],
  "match": {
    "examples": [
      "send {contact} a message on whatsapp saying {text}",
      "whatsapp {contact}: {text}"
    ]
  },
  "preconditions": [ ... ],
  "steps": [ ... ],
  "stats": { "runs": 12, "cleanReplays": 11, "fallbacks": 1, "lastRunAt": 0, "retired": false }
}
```

---

## 3. Preconditions — establish, don't assume

The answer to *"what if the window is minimised, or split-screen, or on the other
monitor?"* is that the skill's first act is to make the environment true. It does
not hope.

```json
"preconditions": [
  { "ensure": "app-running",  "application": "WhatsApp" },
  { "ensure": "focused",      "application": "WhatsApp" },
  { "ensure": "window-state", "state": "maximize" }
]
```

| `ensure` | implemented with | on failure |
|---|---|---|
| `app-running` | `launch` | fail fast — a missing app is not something the LLM can rediscover |
| `focused` | `focus` | handover |
| `window-state` | `window_state` | handover |
| `fresh-document` | `new_document` | handover |
| `path-exists` | `run` (`Test-Path`) | fail fast |

Cost: ~300ms. That is the entire price of being layout-independent.

---

## 4. Steps

```json
{
  "tool": "click",
  "args": { "text": "{contact}", "section": "Chats" },
  "irreversible": false,
  "verify": { "kind": "window-title-contains", "value": "{contact}" },
  "onFail": "handover"
}
```

### 4.1 Resolution rules — the ones that make or break this

**Allowed in `args`:** `text` (the element's own label), `section` (the
`[under "…"]` annotation the screen reading now emits), `role`, and any
non-positional tool argument.

**Forbidden:** `x`, `y`, `element` (the index). Indices are valid only for the
reading they came from; coordinates are valid only for the layout they came
from. Both are exactly the brittleness this design exists to avoid.

> **If a step can only be expressed with coordinates, it is not skill-able.**
> Recording must abort with that reason rather than saving something that will
> silently misfire later. That is a useful signal, not a limitation — it means
> the perception layer could not name the control, which is a bug to fix
> upstream (see `scripts/probe-webview-tree.mjs`).

### 4.2 `irreversible`

Marks a step that cannot be replayed safely: sending a message, deleting,
uninstalling, paying. Two consequences, both mandatory:

- The existing gates still apply. A skill does **not** bypass
  `requiresConfirmation` / `requiresClickConfirmation` / `requiresSendConfirmation`.
  Replaying is a speed optimisation, never a consent one.
- If a later step fails, the handover payload must state that this one **already
  happened**. Otherwise the model reads a half-finished state, concludes the send
  did not go, and sends it twice. That is somebody's mother getting the message
  again.

### 4.3 `verify`

A step without verification is a step that cannot be trusted to have worked, so
the replayer must not proceed past one.

| `kind` | means | reuses |
|---|---|---|
| `element-present` / `element-absent` | a label is (not) on screen | `screen` |
| `window-title-contains` | the window title changed as expected | `screen` |
| `input-empty` | the focused control no longer holds the text | the focused-value read built for sends |
| `file-exists` / `file-contains` | on disk | `run` |
| `command-output-contains` | shell truth | `run` |
| `undo-available` | the document actually changed | the existing drawing check |

---

## 5. The replayer

**Not the LLM loop.** A separate deterministic executor that calls the same
`toolset.execute`, so every tool keeps its own gates, failure semantics and
progress reporting.

```
for each precondition → establish, or fail fast / handover
for each step         → execute → verify → next
                        verification fails → HANDOVER at this step
```

The fast path is only allowed to keep running **while it can prove it is on
track.** That is the whole safety argument.

---

## 6. Handover — what the model is told

When a replay stops, the model is not asked to start over. It is handed the
situation:

```
You were running the skill "Send a WhatsApp message"
  contact = "Chintu", text = "av byavarsi"

Completed:
  1. WhatsApp launched and focused
  2. window maximised
  3. clicked the search box
  4. typed "Chintu"
  ALREADY DONE AND NOT REPEATABLE: none

Failed at step 5:
  click {text: "Chintu", section: "Chats"}
  → no element labelled "Chintu" under "Chats"

Read the screen and carry on from here.
```

Without this the model redoes finished work and you pay for the replay *and* a
full derivation.

---

## 7. Self-healing

When the LLM works out the new route, that becomes the skill's step 5 and
`updatedAt` moves. **Failures make the skill better rather than making it
garbage** — the thing a recorded macro can never do, and the centre of the
technical pitch.

## 8. Retirement — the metric that keeps it honest

A skill that falls back constantly is the worst of both worlds: replay latency
*plus* full LLM cost, and it will feel like an unexplained slowdown rather than
an error.

```
cleanReplays / runs < 0.7   over at least 5 runs   →   retired: true
```

Retired skills stop auto-replaying and are re-learned from scratch. Surface the
rate in the Skills panel. Without this metric you will not notice.

---

## 9. Recording

A skill is offered **only** when a run finished `COMPLETED`, made at least one
tool call, and every step that had a verification passed it. Never record a
failed or unverified run — a wrong skill is worse than no skill.

Parameterisation: the values the user supplied in their request that appear
verbatim in tool arguments become `{placeholders}`. Everything else is literal.
Start conservative; a skill with too few parameters simply matches less often,
while one with too many corrupts arguments.

---

## 10. Where it plugs in

| concern | file |
|---|---|
| store (read/write/list/retire) | `packages/fast-agent/src/skills.js` — mirror `notes.js` |
| recording | `packages/fast-agent/src/index.js`, at the `COMPLETED` settle |
| matching + replay | before the first model call in `FastAgent.run` |
| execution | existing `toolset.execute` — no new tool paths |
| surfacing | `apps/desktop/demo.js` + `demo.html`, a Skills panel beside Chats |
| measurement | a `skills` category in `tests/eval/tasks/` — same task twice, second must be ≥10× cheaper |

---

## 11. What not to do

- **Do not record coordinates.** Not "as a fallback". They are the failure mode.
- **Do not let a skill skip a confirmation.** Speed optimisation, not consent.
- **Do not replay without preconditions.** That is a macro again.
- **Do not save a skill from a run that was not verified.**
- **Do not hide skills from the user.** Editable JSON, visible in the UI.
- **Do not build a matching model.** String/example matching first; if it needs
  a model call to decide whether to use a skill, the saving is gone.

---

## 12. Definition of done

An eval task that runs the same request twice, where the second run:

- **passes** the same independent verification,
- makes **zero model calls**,
- costs **< 1,000 tokens** against the first run's ~150,000,
- completes in **< 5s** against ~60s,

and a third run, after the target application's UI has been changed, that
**falls back, succeeds, and updates the skill.**
