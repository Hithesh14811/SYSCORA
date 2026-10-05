# Evidence-Gated Tool Results: Making False Success Claims Unrepresentable in Computer-Use Agents

**Status:** draft v2, 5 Oct 2026. Every number is measured on the commit named
beside it and the script that produced it is cited. Nothing here should be quoted
without that script.

---

## Abstract

Computer-use agents fail silently. On 361 OSWorld tasks, a capable agent ends 90%
of its failures with a success claim and never uses its own failure affordance
[CURA, arXiv:2608.27808]. The response in the literature has been **detection**:
post-hoc verifiers that judge a finished trajectory with a frontier model
[arXiv:2604.06240], or external runtime monitors that infer distress from
behavioural telemetry [CURA]. Both are probabilistic, both sit outside the agent,
and both are needed because of an architectural choice nobody questions — the
component that performs an action is also the component that reports on it.

We remove that choice. Every tool result carries a typed receipt
`{observed, method, verdict, actedVia}`, where `method` names the capability that
read the machine back and `actedVia` names the capability that acted. A success
sentence is reachable only through a helper that demands a `CONFIRMED` verdict, and
the receipt constructor **refuses to build a receipt whose reader equals its
actor**. The verdict is three-valued: `UNCONFIRMED` means nobody looked, which is
not failure. The result is that a false success claim is not caught — it cannot be
formed.

We evaluate by fault injection rather than by trajectory judging. Four classes of
actuator failure, each the mechanism of a real incident, are injected into the
capability layer beneath 18 acting tools, and we record what the user would have
been told. An ungated renderer would claim success in **24.5%** of perturbed cases;
the evidence-gated renderer does so in **0%**, and returns `CONFIRMED` against a
broken machine in **0%**. The invariant costs zero tokens and no model calls. The
harness found a real defect in our own implementation, which we report, and we
report a limitation of the invariant that our own evaluation exposed.

We claim no improvement in task success. We claim that one class of failure — the
one that is worse than failure, because the user believes the work was done — is
eliminated by construction rather than estimated by a detector.

---

## 1. Introduction

A computer-use agent that fails is a nuisance. A computer-use agent that fails and
says it succeeded is a liability: the user stops checking, and the error is
discovered later, by someone else, in whatever state it left the machine.

This is not a rare tail case. CURA reports that on 361 OSWorld tasks, **64 of a
capable agent's 71 failures (90%) terminate with a success claim**, and that the
agent never once used the explicit "I could not do this" affordance it was given
[arXiv:2608.27808]. Post-hoc verification is similarly fragile: a widely used
screenshot-based verifier marks failed trajectories as successful **45%** of the
time, and a stronger baseline **22%** of the time [arXiv:2604.06240].

### 1.1 Detection, and what it concedes

Two families of response exist, and both are detection.

**Post-hoc verifiers** read a finished trajectory — screenshots and action history
— and judge it. The Universal Verifier reduces the false-positive rate to ~1% using
rubric decomposition and a frontier model [arXiv:2604.06240]. It is accurate, and
it costs a model call per trajectory, which means it is affordable for evaluation
and training-signal generation but not for every action a deployed agent takes.

**Runtime monitors** watch from outside. CURA fuses effort, reasoning semantics,
execution physiology and visual dynamics into a CUSUM process with certified
false-alarm control, detecting 42.3% of failures a median of 31 steps early at a
0.066 false-alarm rate, with no model internals and no extra LLM calls
[arXiv:2608.27808]. It is cheap, and it is a statistical estimate of distress.

Both accept the same premise: **the agent will produce a success claim that may be
false, and something else must catch it.** That premise comes from an
implementation detail. A tool returns an object; a render function turns that
object into a sentence; nothing in the type system connects the sentence to whether
the machine was ever looked at. `"Muted."`, `"Sent."` and `"Volume is now 60%"` are
strings a function chose to return.

### 1.2 Prevention

We ask a different question. Not *"did this trajectory succeed?"* but *"can this
system emit a success sentence that nothing verified?"* — and we make the answer no
at compile-and-construct time, in the agent, for every action, at zero marginal
cost.

This is a complement to detection, not a replacement. A monitor is still needed for
everything an invariant cannot see: the agent that verifies each step and still
does the wrong task, the run that loops, the user's intent misread. But the class
where the actor flatters itself is large — it is most of the 90% — and it is the
class an invariant can close completely.

### 1.3 Contributions

1. **A mechanism, not just a rate.** Eighteen grounded false-success incidents from
   a deployed Windows agent, each traced to its cause (§3). The literature measures
   *how often* agents misreport; we show that in every case we have, **the reporter
   and the actor were the same component**, and that six of the eighteen were the
   *verification itself* being unable to fail.
2. **An invariant that makes the mechanism unrepresentable**, enforced in a receipt
   constructor across 40 tools, costing zero tokens (§4).
3. **Fault injection as the evaluation method for verification architecture** (§5).
   Rather than judging trajectories, we break the machine beneath the agent and
   count what the user is told: 24.5% → 0%.
4. **Two results against our own system.** The harness found a real defect in our
   volume tool (§5.3), and the invariant is weaker than it appears — it compares
   capability *labels*, not call provenance (§7).

### 1.4 Setting: why text-first perception matters here

Our agent reads Windows UI Automation (UIA) accessibility trees and falls back to
pixels, rather than driving from screenshots. **This is not a contribution of this
paper.** UFO2 established deep UIA integration for Windows agents, fusing
accessibility trees with visual grounding [arXiv:2504.14603], and the field has
broadly converged on hybrid perception.

It is load-bearing for a different reason: **it decides whether per-action
verification is affordable.** The invariant requires an independent read of machine
state after every acting tool call. On our implementation that read is a UIA query
— measured at 66 ms for the focused control after a click, 16 ms for the foreground
window after a focus, 259 ms for the window list after a launch — and it returns
named controls rather than pixels. A screenshot-first agent implementing the same
invariant would need a second capture and a vision-model call per action to
establish what changed.

So the cost of independent readback is a function of perception modality, and that
cost is what makes the difference between an invariant you can apply to every
action and one you can only afford at the end of a trajectory. We state this as a
constraint on where our result transfers, not as a claim about which modality is
better.

---

## 2. Related work

**Trajectory verification.** The Universal Verifier decomposes judgment into
non-overlapping rubric criteria, separates process from outcome reward, and manages
screenshot context, reaching ~1% false-positive rate against 45% (WebVoyager) and
22% (WebJudge); it releases CUAVerifierBench with human process and outcome labels
[arXiv:2604.06240]. All three are post-hoc and model-based. Our invariant is
orthogonal: it constrains what the agent can say while running, and does not judge
trajectories at all.

**Runtime failure monitoring.** CURA reads only harness-visible telemetry and
requires no prompt changes or extra model calls [arXiv:2608.27808]. It is the
closest work in spirit — cheap, runtime, no model internals — and the clearest
contrast: CURA *infers* that something has gone wrong from behaviour; we *prevent*
a specific claim from being expressible. CURA's 42.3% detection at a certified
false-alarm rate is a statistical guarantee; our 0% is a structural one over a
narrower class.

**Evaluator error.** Auditing 150 public FAIL trajectories across five benchmarks
found 15.3% of FAIL verdicts incorrect, mostly evaluator false negatives plus broken
tasks [arXiv:2607.28367]. We corroborate this independently and from the other side:
in one sweep of our own suite, **two of three failing rows were defects in the
checker, not the agent** (§6.2) — a capability probe that could not see an installed
command, and an image checker that could not decode the format the application chose
to save in. This is a strong argument for requiring every check to be *proven able
to fail* before a green result is believed.

**Windows and desktop agents.** UFO and UFO2 integrate UIA, Win32 and application
COM interfaces, with hybrid control detection over accessibility trees and visual
grounding [arXiv:2402.07939, arXiv:2504.14603]. Benchmarks for this setting include
OSWorld and WindowsAgentArena.

**Self-verification in agents.** Voyager's ablation removes self-verification and
loses a large fraction of performance, establishing that an agent which cannot tell
success from noise cannot safely accumulate skills. Reflexion and ExpeL learn from
self-assessed outcomes. All of these consume a success signal; none constrain how
that signal may be produced.

**Dependability.** The rule that a checker must not share a failure mode with the
thing it checks is old — the end-to-end argument, fail-silent versus fail-stop
behaviour, and n-version programming all turn on it. Fault injection is the standard
method for evaluating such claims. Our contribution is to apply both inside an
LLM-driven agent's tool layer, where the "actuator" is a GUI and the "sensor" is an
accessibility API.

> **FILL:** complete bibliography, 50–80 entries. The arXiv IDs cited above were
> verified on 5 Oct 2026. Look up OSWorld, WindowsAgentArena, Voyager, Reflexion,
> ExpeL, WebVoyager, WebJudge, metamorphic testing, mutation testing and the
> end-to-end argument on Google Scholar and export BibTeX.

---

## 3. Why agents misreport: eighteen incidents and one mechanism

Every row below is a real incident from a deployed agent, recovered from its session
store and transcripts. The literature gives the rate; this section gives the cause.

### 3.1 Claims about actions

| Claimed | What was true | The actor | What read it back |
|---|---|---|---|
| "Sent." | The message text sat unsent in a search box | `keyboard.press` | nothing |
| "Sent." for every keystroke | Rendered for ctrl+s, escape and f5 alike; wording written for Enter, left as the fallback | `keyboard.press` | nothing |
| "Muted." | Audio still audible; "Volume is 28% (muted)" was reported twice while music played | `audio.endpoint:set` | `GetMute` — the same device agreeing with itself |
| "Muted." | One step, **zero tool calls**, twice in five turns | nothing acted | nothing |
| "Focused." | The application shell never learned it was active and discarded every keystroke | `window.activate` | its own return value |
| "Wrote notes.md" | The file was empty: the caller sent `contents`, the capability takes `content` | `filesystem.write` | nothing |
| "Done." | No file existed. The model returned an **empty** turn; the word was the loop's own fallback string | nothing acted | nothing |
| A track "playing" | A different song was playing; the call's own payload disagreed with the request | `spotify.track.play` | the same call's payload |
| A version number | Invented; no tool had been called | nothing acted | nothing |

The `"Done."` row deserves attention. Four independent honesty guards all looked the
other way, because every one of them inspected what the *model* emitted, and this
was a claim made by the *scaffolding* — `_settle("COMPLETED", lastText || "Done.")`.
**Every default string a system can fall back on is an unaudited assertion.**

### 3.2 Claims made by the verification itself

Six of the eighteen are checks that could not fail. This is the mirror of the
problem and, we argue, the more dangerous half: a check that cannot fail is believed.

| The check | Why it could never fail | What it cost |
|---|---|---|
| Message-sent verify | `Write-Output 'checked-by-human'` — passed unconditionally | The highest-stakes row in the suite showed green for months |
| "Input box is empty" | The application publishes `value="\n"` when empty, so every emptiness test passed vacuously | A send was indistinguishable from a draft |
| Volume verify | Called a module not installed on the machine; printed `unreadable` whatever happened | The row could never pass, however well the agent did |
| Volume setup | The machine already sat at the target value | Would have passed with the agent doing nothing |
| Skill-replay verify | Searched for an **empty needle**; `"anything".includes("")` is true | A file-write step verified because the window behind it had buttons on it |
| Entropy audit | `clean: checked > 0` — one vacuous probe declared the whole audit clean | The two probes that mattered had never run |

### 3.3 Claims about perception

| Claimed | What was true |
|---|---|
| "IDENTICAL — nothing at all has changed on screen" | Perception was reading the WebView2 **frame**, not the content window; the agent concluded the tool was broken and spent five steps on it |
| A finished answer | The turn was **truncated** at the output ceiling; the provider reported `finish_reason: "length"` and the loop discarded the signal |
| A finished answer | The reply ended on a colon with `finish_reason: "stop"` — the model announced a list and stopped |

### 3.4 The common form

In every case the reporter and the actor are the same component, or there is no
reporter at all. `performed: true` from an input injector is the actor describing
itself. The focused control, read afterwards over UI automation, is the machine
describing the world. **The gap between those two sentences is the entire subject of
this paper.**

---

## 4. The invariant

```js
evidence({ observed, method, verdict, actedVia })
```

- `observed` — what the machine said, in its own terms.
- `method` — the capability that READ the state back.
- `actedVia` — the capability that ACTED; `null` for a read-only tool.
- `verdict` — `CONFIRMED`, `REFUTED`, or `UNCONFIRMED`.

Four refusals, in the constructor, so they are enforced rather than remembered:

```js
export function evidence({ observed, method, verdict, actedVia = null }) {
  if (!VERDICTS.has(verdict)) throw new EvidenceError(...);
  // A CHECK WITH AN EMPTY NEEDLE IS NOT A CHECK. (§3.2)
  if (!String(observed ?? "").trim())
    throw new EvidenceError("an empty observation is not one");
  // VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES -
  // except when what it says about itself is that it FAILED.
  if (acted && acted === read && verdict !== REFUTED)
    throw new EvidenceError(`would verify ${acted} with ${read}`);
  // "Nothing looked" can never ground a CONFIRMED anything.
  if (read === NOTHING_READ_IT_BACK && verdict !== UNCONFIRMED)
    throw new EvidenceError(...);
  return Object.freeze({ observed, method: read, at, verdict, actedVia: acted });
}

// A success sentence is reachable ONLY through this.
export const confirmed = (result, sentence) =>
  gate(result, CONFIRMED, sentence, "confirmed");
```

**Why `REFUTED` is exempt from the separation rule.** A capability reporting its own
failure has nothing to gain by lying; one reporting its own success has everything
to gain. Demanding a second opinion on a failure would also mean paying for a read
of a machine we already know we did not touch.

**Why three verdicts and not two.** `UNCONFIRMED` means nobody looked.
`NOTHING_READ_IT_BACK` is a first-class method name, valid only with `UNCONFIRMED`,
for actions with no cheap reading behind them — a bare keystroke, a pointer move.
Three gates in our own history conflated "could not check" with "the check failed",
and each discarded work that had succeeded. A two-state verdict lies half the time
it is uncertain.

### 4.1 Instantiation

Each acting tool names its actor and its reader, and they are different subsystems
reached by different code paths:

| Tool | `actedVia` | `method` |
|---|---|---|
| `click` | `pointer.clickAt` | `adapter.focusedElement` (UIA) |
| `focus` | `window.activate` | `getForegroundWindow` (the desktop) |
| `write_file` | `filesystem.write` | `filesystem.read` (the bytes, off disk) |
| `clipboard` | `clipboard.write` | `clipboard.read` |
| `launch` | `application.launch` | `window.enumerate` |
| `key` (bare keystroke) | `keyboard.press` | `NOTHING_READ_IT_BACK` → forced `UNCONFIRMED` |

The last row is what makes the invariant honest rather than decorative. The
temptation for an unverifiable action is to name a check that did not happen; here
the system says so out loud and the constructor forbids pairing it with success.

**Cost: zero tokens, no model calls.** The invariant adds nothing to the system
prompt or the tool schema. Measured prompt cost is unchanged at 11,342 tokens/step
across its introduction.

---

## 5. Evaluation: fault injection

### 5.1 Why not trajectory judging

Verifier work evaluates by comparing a judge's labels against human labels on
recorded trajectories [arXiv:2604.06240]. That measures a judge. We are not
proposing a judge; we are proposing a constraint on what the agent can express, so
the question is: **when the machine misbehaves, what does the user get told?**

So we hold the agent constant and break the machine. Four fault classes, each the
mechanism of a real incident from §3, are injected into the capability layer. Each
tool then runs its whole chain — act, read back, build the receipt, render — and we
record the sentence.

| Fault | What it models | From |
|---|---|---|
| `silent-no-op` | Actuator accepts the call, reports success, world unchanged | "Sent.", "Muted.", "Focused." |
| `wrong-target` | The action lands, on something else | the wrong song |
| `actuator-throws` | The actuator refuses outright | input-queue rejection |
| `reader-blind` | Action works, verifier cannot answer; must yield `UNCONFIRMED` | §4's third verdict |

**The counterfactual requires no second implementation and is fair.** An ungated
renderer has no branch to take: it returns its success sentence whatever happened,
because that is what "ungated" means, and it is what this codebase did before the
invariant existed (§3). So the ungated arm is the sentence each tool emits on a
*healthy* machine, and the question per cell is whether that sentence would have
been a lie.

**Cells the fault never reached are excluded.** When a tool's receipt and sentence
are byte-identical to the healthy run, that fault did not perturb it and the cell
tests nothing; counting it would pad the denominator and flatter the result.

### 5.2 Result

`node scripts/probe-fault-injection.mjs`, commit `23a680a`:

| | cells | rate |
|---|---|---|
| An ungated renderer would have claimed success | 12 / 49 | **24.5%** |
| The evidence-gated renderer claimed success | 0 / 49 | **0.0%** |
| Returned `CONFIRMED` against a broken machine | 0 / 49 | **0.0%** |
| Excluded — fault never reached the tool | 23 / 72 | — |

18 acting tools × 4 fault classes = 72 cells, 49 perturbed. Runs offline in about a
second; no model, no network, no machine state.

**24.5% is a lower bound, for a reason worth stating.** These renderers were written
*under* the invariant, so their sentences are already cautious and many hedge even
on a healthy machine. A genuinely ungated codebase produced blunter strings —
"Muted.", "Sent.", "Done." — as §3 documents. The comparable field measurement is
CURA's 90% of failures ending in a success claim [arXiv:2608.27808].

### 5.3 The harness found a defect in our own implementation

Under `silent-no-op`, the `volume` tool returned `CONFIRMED` and said *"Volume is
5%."* The sentence is true, and it is not an answer: the user asked for 40%. Only
the explicit "the endpoint says it did not apply" branch ever compared requested
against observed, so when the endpoint claimed success and landed elsewhere, nothing
compared two numbers that were both already in hand.

Fixed to `UNCONFIRMED` rather than `REFUTED`, because both numbers return from the
same capability call, which makes their disagreement weaker evidence than an
independent read; with a two-percentage-point tolerance, because real endpoints
quantise their scalar and a gate that fires on ordinary success is one that gets
switched off.

**This is the evidence the experiment is not vacuous.** A 0% produced by a harness
that never caught anything would be a rigged test. Every test in the suite is
additionally proven able to fail: neutering the mechanism it covers turns it red.

---

## 6. End-to-end behaviour (descriptive)

### 6.1 Task suite

`npm run eval -- --repeat 3 --manual`, commit `af35fe4`, machine load measured at
8.5% of 16 cores immediately beforehand:

```
pass rate        96%   (24 of 25 rows passing EVERY repeat)
runs             75
median time      4.7s          median steps 3
cost             $1.818        cache hit 96.6%
```

A row passes only when all three repeats pass. **These tasks were written by us, run
on one machine, and are reported descriptively.** We make no comparison to published
benchmark numbers; OSWorld and WindowsAgentArena figures are not comparable to this
suite and we do not present them as if they were.

Verification is independent by construction: every check runs its own shell against
the machine, by a different route than the agent used.

**The single failing row is the flagship.** Sending a message passed 2 of 3; the
failing run reported `NO-NEW-MESSAGE before=0 now=0` after 22 steps. The message was
not sent, **and the run did not claim that it was** — which is the invariant doing
exactly its job, on the action where a false claim would cost most.

### 6.2 Two of three failures were the checker

In an earlier sweep the same day, three rows failed and two were defects in the
verification rather than the agent:

- A capability probe reported a command absent because it resolved only to a
  Windows app-execution alias — the rule that correctly rejects a Store stub also
  rejected a tool that ships *only* as an alias.
- An image checker reported a drawing unreadable because the application had saved
  **HEIF** under a `.bmp` name, and the checker's decoder handled only the classic
  bitmap formats.

Both are cases where the measurement was wrong and the agent was right. This
independently corroborates the finding that evaluator false negatives are a
substantial share of reported failures [arXiv:2607.28367], and it is why §3.2 treats
unfailable checks as part of the same problem rather than as a footnote.

---

## 7. Limitations

**The invariant compares labels, not provenance.** `evidence()` compares the
`method` string against the `actedVia` string. It cannot see that both values
originated in a *single* capability call. Our own `volume` tool passes
`audio.endpoint:get+meter` and `audio.endpoint:set` — distinct strings, and in the
real adapter genuinely distinct Win32 interfaces (`GetMasterVolumeLevelScalar` and
`IAudioMeterInformation`) — but that separation is maintained by convention inside
the adapter and is **not** verified by the check. Enforcing provenance would require
threading call identity through the capability layer, which we have not done.

**The class is narrow by design.** The invariant closes "the actor flattered
itself." It cannot see an agent that verifies every step and still performs the
wrong task, a run that loops, or a misread intent. Those remain the province of
monitors like CURA, and we present this as complementary rather than competing.

**No baseline agent under fault injection.** The 24.5% is a counterfactual about our
own renderers, not a measurement of another system. Applying these fault classes to
another agent's tool layer is the obvious next experiment and is not done.

**The task suite is self-authored**, 24 tasks on one machine, used descriptively.

**One model, one vendor, one machine.** Prompt-cost and latency figures are from a
single configured endpoint.

---

## 8. Conclusion

The field's answer to silent failure has been to watch the agent more closely. We
suggest a prior question: why is the agent able to make the claim at all? When the
component that acts is forbidden from being the component that reports, and a
success sentence is unreachable without a receipt from somewhere else, an entire
class of false claim stops existing — at no token cost, with no model call, and
without a detector to tune.

We did not make our agent better at tasks. We made it incapable of telling you it
did something it did not do, and we measured that by breaking the machine
underneath it.

---

## Artifact

- `packages/fast-agent/src/evidence.js` — the invariant
- `scripts/probe-fault-injection.mjs` — the experiment (`--latex` emits the table)
- `tests/unit/fault-injection.test.js` — the result, held in CI
- `tests/eval/` — the task suite, its recorded budgets and the scoreboard

Every test is proven able to fail: neutering the mechanism it covers turns it red.

---

## Verified citations (checked 5 Oct 2026)

| Key | Work |
|---|---|
| arXiv:2608.27808 | CURA: Certified Runtime Alarms for Computer-Use Agents — 90% of failures end in a success claim; 42.3% detection at 0.066 false-alarm rate |
| arXiv:2604.06240 | The Art of Building Verifiers for Computer Use Agents (Microsoft Research) — Universal Verifier ~1% FPR vs WebVoyager ≥45%, WebJudge ≥22%; CUAVerifierBench |
| arXiv:2607.28367 | How Benchmarks Mis-Score Computer-Use Agents — 15.3% of FAIL verdicts incorrect |
| arXiv:2504.14603 | UFO2: The Desktop AgentOS — UIA accessibility trees fused with visual grounding |
| arXiv:2402.07939 | UFO: A UI-Focused Agent for Windows OS Interaction (NAACL 2025) |
