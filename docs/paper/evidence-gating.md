# Unreachable by Construction: Eliminating False Success Claims in Computer-Use Agents

**Status:** draft, 3 Oct 2026. Every number here was measured on the commit named
beside it, and the script that produced it is cited. Nothing in this file should be
quoted without that script.

---

## Abstract

Computer-use agents report their own success. When the report is wrong the failure
is worse than an ordinary one, because the user believes work was done that was
not. We document fifteen such incidents from a deployed Windows agent — a message
reported sent while its text sat in a search box, a mute accepted while audio
still played, a window reported focused while it discarded every keystroke, a file
reported written that was empty — and show that they share one mechanism: the
component that *performed* the action was also the component that *reported* on it.

We make that mechanism unrepresentable. Every tool result carries a typed receipt
`{observed, method, verdict, actedVia}`, where `method` is the capability that read
the machine back and `actedVia` is the capability that acted. A success sentence is
reachable only through a helper that requires a `CONFIRMED` verdict, and the
receipt constructor refuses any receipt whose reader equals its actor. The verdict
is three-valued: `UNCONFIRMED` means nobody looked, which is not failure.

We evaluate by fault injection. Four classes of actuator failure, each drawn from
the incidents above, are injected into the capability layer beneath 18 acting
tools, and we record what the user would have been told. An ungated renderer would
have claimed success in **24.5%** of perturbed cases; the evidence-gated renderer
does so in **0%**, and returns `CONFIRMED` against a broken machine in **0%**. The
harness found a real defect in our own implementation, which we report. On 24
end-to-end tasks (25 rows, 75 runs, strict all-repeats-pass) the system scores 96%.

We claim no improvement in task success. We claim the elimination of a failure mode
that is worse than failure, by construction rather than by inspection.

---

## 1. Introduction

**The gap.** Skill-library agents (Voyager, CUA-Skill) and reflective agents
(Reflexion, ExpeL) assume the environment tells you whether you succeeded. On a
real desktop it does not. Windows will report a window as foreground, visible, at
the correct pixel, with UI-automation focus, while the application shell never
learns it is active and silently discards every keystroke. An audio endpoint will
accept a mute, report itself muted when asked, and keep emitting sound.

So the interesting question is not how an agent should plan, or how it should store
a skill. It is **what counts as evidence that anything happened at all.**

**Contributions.**

1. A catalogue of fifteen grounded false-success incidents from a deployed agent,
   each with its mechanism (Section 2). Published work reports task success rates;
   we are not aware of published measurements of how often an agent misreports.
2. An invariant that makes the shared mechanism unrepresentable, enforced at
   construction across 40 tools (Section 3).
3. A fault-injection evaluation of that invariant — offline, deterministic, and
   reproducible in about a second (Section 4) — including a defect it found in our
   own code.
4. A limitation we did not expect and report against ourselves: the invariant is
   enforced on capability *labels*, not on call provenance (Section 5).

**Non-goals, stated early.** We do not claim higher task success than any other
system. We do not report WindowsAgentArena or OSWorld. Our task-level numbers are
measured on tasks we wrote, on one machine, and are used descriptively.

---

## 2. Fifteen false claims, and their one mechanism

Every row below is a real incident from a deployed agent, recovered from its own
session store and transcripts. The right-hand column is the mechanism, and it is
the same mechanism fifteen times.

### Claims the agent made about actions

| Claimed | What was true | The actor | What read it back |
|---|---|---|---|
| "Sent." | The message text sat unsent in a search box | `keyboard.press` | nothing |
| "Sent." (every keystroke) | Rendered for ctrl+s, escape, f5 alike — wording written for Enter and left as the fallback | `keyboard.press` | nothing |
| "Muted." | Audio still audible. "Volume is 28% (muted)" was reported twice while music played | `audio.endpoint:set` | `GetMute` — the same device, agreeing with itself |
| "Muted." | 1 step, **zero tool calls**, twice in five turns | nothing acted | nothing |
| "Focused." | The app shell never learned it was active and discarded every keystroke | `window.activate` | `window.activate`'s own return value |
| "Wrote notes.md" | The file was empty: the caller sent `contents`, the capability takes `content` | `filesystem.write` | nothing |
| "Done." | No file existed. The model returned an **empty** turn; the word was the loop's own fallback string | nothing acted | nothing |
| Track "playing" | A *different* song was playing; `nowPlaying` disagreed with the request | `spotify.track.play` | the same call's own payload |
| A version number | Invented; no tool had been called | nothing acted | nothing |

### Claims the *verification* made (checks that could not fail)

| The check | Why it could never fail | Cost |
|---|---|---|
| Message-sent verify | `Write-Output 'checked-by-human'` — passed unconditionally | The highest-stakes row in the suite showed green for months |
| "Input box is empty" | WhatsApp publishes `value="
"` when empty, so every emptiness test passed vacuously | A send could not be distinguished from a draft |
| Volume verify | Called a module not installed on the machine, so it printed `unreadable` whatever happened | The row could never pass, however well the agent did |
| Volume setup | The machine already sat at the target value | Would have passed with the agent doing nothing |
| Skill-replay verify | Searched for an **empty needle**; `"anything".includes("")` is true | A `write_file` step verified because the window behind it had buttons on it |
| Entropy audit | `clean: checked > 0` — one vacuous probe declared the whole audit clean | The two probes that mattered had never run |

### Claims made about reading the screen

| Claimed | What was true |
|---|---|
| "IDENTICAL — nothing at all has changed on screen" | Perception was reading the WebView2 **frame**, not the content window; the agent concluded the tool was broken and burned five steps |
| A finished answer | The turn had been **truncated** at the output ceiling; the provider said `finish_reason: "length"` and the loop discarded the signal |
| A finished answer | The reply ended on a colon with `finish_reason: "stop"` — the model announced a list and stopped |

The last row is the one worth dwelling on. Four layers of honesty enforcement all
looked the other way, because every one of them was watching what the *model* said
and this was a claim the *scaffolding* made. Every default string a run can fall
back on is an unaudited assertion.

**The common form.** In all fifteen cases the reporter and the actor are the same
component. `performed: true` from an input injector is the actor describing itself.
The focused control, read back afterwards over UI automation, is the machine
describing the world.

---

## 3. The invariant

```js
evidence({ observed, method, verdict, actedVia })
```

- `observed` — what the machine said, in the machine's own terms. Empty is
  refused: an empty observation is not one.
- `method` — the capability that READ the state back.
- `actedVia` — the capability that ACTED; `null` for a read-only tool.
- `verdict` — `CONFIRMED`, `REFUTED`, or `UNCONFIRMED`.

**Three rules, enforced in the constructor rather than by review.**

1. **`method` may not equal `actedVia`**, unless the verdict is `REFUTED`. A
   capability reporting its own failure has nothing to gain by lying; one reporting
   its own success has everything to gain.
2. **A success sentence is reachable only through `confirmed(result, sentence)`**,
   which throws unless the verdict is `CONFIRMED`. There is no code path from a
   `REFUTED` or `UNCONFIRMED` result to a past-tense success claim.
3. **`UNCONFIRMED` is not failure.** `NOTHING_READ_IT_BACK` is a first-class method
   name, valid only with an `UNCONFIRMED` verdict. Three gates in our own history
   conflated "could not check" with "the check failed", and each one discarded work
   that had actually succeeded.

**Cost.** Zero tokens per step. The invariant is structural, not prompted — it adds
nothing to the system prompt or the tool schema.

The constructor is the whole enforcement point. There is no configuration flag and
no way to opt out:

```js
export function evidence({ observed, method, verdict, actedVia = null }) {
  if (!VERDICTS.has(verdict)) throw new EvidenceError(...);
  // A CHECK WITH AN EMPTY NEEDLE IS NOT A CHECK.
  if (!String(observed ?? "").trim()) throw new EvidenceError(
    "an empty observation is not one");
  // VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES.
  // Except when what it says about itself is that it FAILED.
  if (acted && acted === read && verdict !== REFUTED) throw new EvidenceError(
    `would verify ${acted} with ${read} - the action grading its own homework`);
  // "Nothing looked" can never be the basis of a CONFIRMED anything.
  if (read === NOTHING_READ_IT_BACK && verdict !== UNCONFIRMED) throw new EvidenceError(...);
  return Object.freeze({ observed, method: read, at, verdict, actedVia: acted });
}

// A success sentence is reachable only through this.
export const confirmed = (result, sentence) =>
  gate(result, CONFIRMED, sentence, "confirmed");
```

A representative tool, with the two capabilities side by side. The click is
delivered by the pointer; it is confirmed by asking the accessibility tree which
control now holds focus — a different subsystem, reached by a different code path:

| Tool | `actedVia` (performed it) | `method` (read it back) |
|---|---|---|
| `click` | `pointer.clickAt` | `adapter.focusedElement` (UI automation) |
| `focus` | `window.activate` | `getForegroundWindow` (the desktop) |
| `write_file` | `filesystem.write` | `filesystem.read` (the bytes, off disk) |
| `clipboard` | `clipboard.write` | `clipboard.read` |
| `launch` | `application.launch` | `window.enumerate` |
| `key` (bare keystroke) | `keyboard.press` | `NOTHING_READ_IT_BACK` -> forced `UNCONFIRMED` |

The last row is the one that makes the invariant honest rather than decorative.
Some actions have no cheap reading behind them, and the temptation is to name a
check that did not happen. `NOTHING_READ_IT_BACK` says so out loud, and the
constructor refuses to pair it with any verdict but `UNCONFIRMED`.

---

## 4. Evaluation: fault injection

### 4.1 Design

The detector is held constant and the *machine* is broken underneath it. Four
fault classes, each the mechanism of a real incident from Section 2, are injected
into the capability layer. Each tool then runs its entire chain — act, read back,
build the receipt, render — and we record what the user would have been told.

| Fault | What it models |
|---|---|
| `silent-no-op` | The actuator accepts the call, reports success, world unchanged |
| `wrong-target` | The action lands, on something else |
| `actuator-throws` | The actuator refuses outright |
| `reader-blind` | The action works and the verifier cannot answer (must yield `UNCONFIRMED`) |

**The counterfactual is fair and requires no second implementation.** An ungated
renderer has no branch to take: it returns its success sentence whatever happened,
because that is definitionally what "ungated" means, and it is precisely what this
codebase did before the invariant existed. So the ungated arm is the sentence each
tool emits on a *healthy* machine, and the question for each cell is whether that
sentence would have been a lie.

**Cells where the fault never reached the tool are excluded.** When a tool's
receipt and sentence are byte-identical to the healthy run, that fault did not
perturb it and the cell tests nothing. Counting such cells would pad the
denominator and make the headline rate look better than it is.

### 4.2 Result

`node scripts/probe-fault-injection.mjs`, commit `23a680a`:

| | cells | rate |
|---|---|---|
| An ungated renderer would have claimed success | 12 / 49 | **24.5%** |
| The evidence-gated renderer claimed success | 0 / 49 | **0.0%** |
| Returned `CONFIRMED` against a broken machine | 0 / 49 | **0.0%** |
| Excluded — the fault never reached the tool | 23 / 72 | — |

18 acting tools times 4 fault classes is 72 cells, of which 49 were perturbed.

**Why 24.5% is a lower bound.** These renderers were written *under* the
invariant, so their success sentences are already cautious and many hedge even on a
healthy machine. A genuinely ungated codebase produced blunter sentences —
"Muted.", "Sent.", "Done." — as Section 2 documents.

### 4.3 The harness found a defect in our own code

Under `silent-no-op`, the `volume` tool returned `CONFIRMED` and reported
*"Volume is 5%."* That sentence is true, and it is not an answer, because the user
had asked for 40%. Only the explicit "the endpoint says it did not apply" path ever
compared the requested value against the observed one; when the endpoint claimed
success and landed elsewhere, nothing compared two numbers that were both already
in hand.

We fixed it to `UNCONFIRMED` rather than `REFUTED`, because both numbers come back
from the same capability call, which makes their disagreement a weaker signal than
an independent read would be. A tolerance of two percentage points, because real
endpoints quantise their scalar and a gate that fires on ordinary success is one
that gets switched off.

**This is the evidence that the experiment is not vacuous.** A 0% produced by a
harness that never caught anything would be a rigged test.

### 4.4 Task-level evaluation (descriptive)

`npm run eval -- --repeat 3 --manual`, commit `af35fe4`, with machine load measured
at 8.5% of 16 cores immediately beforehand:

```
pass rate        96%   (24 of 25 rows passing EVERY repeat)
runs             75
median time      4.7s         median steps 3
cost             $1.818       cache hit 96.6%
```

A row passes only when all three repeats pass. **The single failing row is the
flagship:** sending a message passed 2 of 3, and the failing run reported
`NO-NEW-MESSAGE before=0 now=0` after 22 steps. The message was not sent, **and the
run did not claim that it was.**

Verification is independent by construction: every check runs its own shell against
the machine, by a different route than the agent used.

**In an earlier sweep the same day, two of three failures were the checker rather
than the agent** — a capability probe that could not see an installed command, and
an image checker that could not decode the format the application chose to save in.
Both are cases where the measurement was wrong and the agent was right. We believe
this class is under-reported in agent evaluation generally, and it is an argument
for making every check prove it can fail before trusting a green result.

---

## 5. Limitations

**The invariant is enforced on labels, not on provenance.** `evidence()` compares
the `method` string against the `actedVia` string. It cannot see that both values
originated in a single capability call. Our own `volume` tool passes
`audio.endpoint:get+meter` and `audio.endpoint:set` — distinct strings, and in the
real adapter genuinely distinct Win32 interfaces — but that separation is
maintained by convention inside the adapter and is **not** verified by the check.

**The task evaluation is self-authored**, 24 tasks on one machine, and is used
descriptively rather than comparatively. We report no public benchmark.

**There is no baseline agent.** The 24.5% is a counterfactual about our own
renderers, not a measurement of another system. Running these fault classes against
another agent's tool layer is the obvious next experiment, and it is not done.

**One model, one vendor, one machine.**

---

## 6. Related work

> **FILL — target 50 to 80 citations.** Suggested grouping:
>
> - **Computer-use agents:** OSWorld, WindowsAgentArena, CUA-Skill, OpenCUA, the
>   Operator system card, UFO, Windows-Use
> - **Self-verification and reflection:** Voyager (whose ablation loses 73% without
>   self-verification), Reflexion, ExpeL, self-consistency
> - **Test oracles and fault injection:** the oracle problem, metamorphic testing,
>   mutation testing, chaos engineering, Jepsen
> - **Dependability:** fail-stop versus fail-silent, Byzantine reporting, the
>   end-to-end argument
> - **Honesty and calibration in language models:** hallucination detection,
>   abstention, selective prediction
>
> The framing to aim for: this is **the oracle problem**, applied to an agent that
> acts on a real machine, where the oracle must not share a code path with the actor.

---

## 7. Conclusion

An agent that cannot tell success from noise cannot be trusted, and cannot safely
learn from its own runs. We did not make our agent better at tasks. We made it
incapable of telling you it did something it did not do, and we measured that claim
by breaking the machine underneath it.

---

## Artifact

- `packages/fast-agent/src/evidence.js` — the invariant
- `scripts/probe-fault-injection.mjs` — the experiment (`--latex` emits the table)
- `tests/unit/fault-injection.test.js` — the result, held in CI
- `tests/eval/` — the task suite, its recorded budgets, and the scoreboard

Every test is proven able to fail: neutering the mechanism it covers turns it red.
