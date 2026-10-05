# SESSION HANDOFF — read this first

Written 5 Oct 2026, at the end of a long session, so a cold session can pick up
exactly where it left off. Everything below is measured or decided, not guessed.

---

## 1. THE GOAL (the user's, in their words)

**Get into a good university for a master's — Stanford and MIT are the targets.**
Applications are due **~1 Dec 2026 (Stanford)** and **~15 Dec 2026 (MIT EECS)**.
The user wants to publish a paper from this repository to strengthen that
application, and wants "no crumbs left."

### Facts established about that goal

- **MIT has no terminal master's in CS.** MIT EECS admits to the **PhD** (you earn
  an SM on the way); MEng is for MIT's own undergrads. So "MIT masters in CS" is in
  practice a PhD application. The one genuine terminal research master's at MIT
  that fits this work is **Media Lab (Media Arts and Sciences)** — portfolio-driven
  and funded. **Stanford MSCS** is a real terminal master's.
- **The user is an undergrad with faculty access** and is meeting a professor in
  person (was planning to, as of 5 Oct).
- **A publication alone will not get them in.** Letters, undergrad record and fit
  carry more weight. The paper's main job is to make a strong letter possible. This
  was said plainly and should not be softened in future sessions.
- Advised to apply to **10–12 schools**, not 2 (Stanford, MIT EECS, MIT Media Lab,
  CMU, Berkeley, UW, UIUC, Georgia Tech, Michigan, Cornell, UT Austin).
- The user's professor suggested a conference in Bangalore the user believes is low
  quality. **Advice given: do not submit there** (a weak venue is unremovable and
  net-negative), but **do not fight the professor about it** — say "I'd like to aim
  higher first; could we try a workshop and fall back if rejected?" The letter
  matters more than the venue argument.

---

## 2. THE PAPER — WHERE IT IS

**Path: `docs/paper/evidence-gating.md`** (draft v2, 491 lines, committed, pushed)

**Title:** *Evidence-Gated Tool Results: Making False Success Claims
Unrepresentable in Computer-Use Agents*

### What the paper is about (the user asked this repeatedly — it is ONE paper)

- **The evidence thing = the invention.** A typed receipt on every tool result:
  `{observed, method, verdict, actedVia}`. `method` is the capability that READ the
  machine; `actedVia` is the capability that ACTED. The constructor **refuses** a
  receipt whose reader equals its actor. A success sentence is reachable only
  through `confirmed()`, which throws without a `CONFIRMED` verdict. Three verdicts,
  because `UNCONFIRMED` ("nobody looked") is not failure.
- **The fault-injection thing = the proof it works.** Break the machine underneath
  18 acting tools with 4 fault classes and count what the user gets told.

They are two halves of one paper, not two papers.

### The positioning (this is the most important thing in the paper)

Draft v1 claimed "we are not aware of published measurements of how often an agent
misreports." **That was FALSE and would have sunk the paper.** Corrected on 5 Oct
after web research:

| Work | Approach | Cost | Result |
|---|---|---|---|
| CURA (arXiv:2608.27808) | External runtime monitor, behavioural telemetry + CUSUM | No LLM calls | Detects 42.3% of failures; **documents that 90% of failures (64/71) end in a false success claim on 361 OSWorld tasks** |
| Universal Verifier (arXiv:2604.06240, Microsoft) | Post-hoc trajectory judge | A frontier-model call per trajectory | ~1% FPR vs WebVoyager ≥45%, WebJudge ≥22% |
| **This paper** | **Construction-time invariant inside the agent** | **Zero tokens, no model calls** | **0% — the code path does not exist** |

**The thesis: everyone else DETECTS false success. This PREVENTS it.** Narrower
class, but closed completely and for free. Framed as complementary to monitors, not
competing.

### Decision on UIA / accessibility-tree perception

The user asked whether to mention that this agent reads UIA trees rather than
screenshots. **Decision: include it as SETTING and ENABLER, never as a
contribution.** Reason: UFO2 (Microsoft, arXiv:2504.14603) already established
UIA+visual-grounding for Windows agents, so claiming it would destroy credibility.
It earns §1.4 because it decides whether per-action verification is *affordable*:
UIA readback costs 66ms (focused control after a click), 16ms (foreground window),
259ms (window list). A screenshot agent would need a second capture plus a vision
call per action. That is an honest constraint-on-transferability argument.

### Verified citations (checked 5 Oct 2026 — these arXiv IDs are real)

| ID | Work |
|---|---|
| arXiv:2608.27808 | CURA: Certified Runtime Alarms for Computer-Use Agents |
| arXiv:2604.06240 | The Art of Building Verifiers for Computer Use Agents (Microsoft) |
| arXiv:2607.28367 | How Benchmarks Mis-Score Computer-Use Agents (15.3% of FAIL verdicts wrong) |
| arXiv:2504.14603 | UFO2: The Desktop AgentOS |
| arXiv:2402.07939 | UFO: A UI-Focused Agent for Windows OS Interaction (NAACL 2025) |

### WHAT IS LEFT IN THE PAPER — exactly one thing

**One `FILL` marker remains: the bibliography (§2 end).** Target 50–80 citations.
Look up OSWorld, WindowsAgentArena, Voyager, Reflexion, ExpeL, WebVoyager, WebJudge,
metamorphic testing, mutation testing, the end-to-end argument — Google Scholar →
Cite → BibTeX. **DO NOT fabricate citations.** This was refused deliberately and
must stay refused; invented references are unrecoverable if caught.

Two earlier FILLs are DONE: the 18-incident catalogue (§3) and the enforcement code
listing (§4).

---

## 3. THE NUMBERS (all measured, all reproducible)

### Fault injection — the paper's main result

```bash
node scripts/probe-fault-injection.mjs --latex
```
Commit `23a680a`. 18 acting tools × 4 fault classes = 72 cells, **49 perturbed**:

| | cells | rate |
|---|---|---|
| Ungated renderer would have claimed success | 12/49 | **24.5%** |
| Evidence-gated renderer claimed success | 0/49 | **0.0%** |
| Returned CONFIRMED against a broken machine | 0/49 | **0.0%** |
| Excluded (fault never reached the tool) | 23/72 | — |

Runs offline in ~1 second. No model, no network, no machine state.
24.5% is a **lower bound** — these renderers were written under the invariant and
already hedge. The field comparison is CURA's 90%.

### The eval suite — descriptive only

```bash
npm run eval -- --repeat 3 --manual
```
Commit `af35fe4`, machine measured quiet at 8.5% of 16 cores first:

```
pass rate   96%   (24 of 25 rows passing EVERY repeat)
runs        75
median      4.7s / 3 steps
cost        $1.818      cache hit 96.6%
```

**Only failing row: `messaging-send-to-self`, 2/3.** The failing run reported
`NO-NEW-MESSAGE before=0 now=0` after 22 steps. The message was not sent and the run
did not claim it was — the invariant working on the highest-stakes action.

**This suite is self-authored, 24 tasks, one machine. Use it DESCRIPTIVELY.** Never
compare it to OSWorld/WindowsAgentArena numbers. The repo's own
`docs/product/pitch-and-paper.md` lists that comparison under "MAY NOT be claimed."

### Perception-modality experiment (paper #2, already built, do not work on it now)

```bash
node scripts/probe-injection-modality.mjs --latex
```
Holds the detector constant, varies only the view. **14 attacks caught by the
accessibility tree alone, 3 by the screenshot alone, 0 missed by both.** The
symmetry is the point: neither modality dominates. Seed corpus is author-written
and labelled as NOT a result; a real run needs ~150 blind-authored cases per
`tests/eval/injection-corpus/README.md`.

---

## 4. WORK DONE THIS SESSION (21 commits, `b51170a..7f3a583`, all pushed)

### Built
- `scripts/probe-fault-injection.mjs` + `tests/unit/fault-injection.test.js` +
  `tests/unit/fixtures/faults.js` — the paper's experiment.
- `tests/unit/fixtures/mock-machine.js` — extracted from `tool-evidence.test.js` so
  the probe and the test cannot drift.
- `packages/policy-engine/src/visible-projection.js`,
  `scripts/probe-injection-modality.mjs`, `tests/eval/injection-corpus/*` — paper #2.
- `docs/paper/evidence-gating.md` — the paper.

### Real defects found and fixed
1. **`volume` reported success on a failed set.** Asked 40%, endpoint reported 5%,
   returned CONFIRMED saying "Volume is 5%." — true, and not an answer. Only the
   explicit `applied === false` path compared the two numbers. Fixed to UNCONFIRMED
   (not REFUTED — both numbers come from the same call) with 2-point tolerance.
   **Found BY the fault-injection harness** — this is the proof the experiment is
   not vacuous, and it is in the paper as §5.3.
2. **winget undetectable.** `inspectCommand` filters WindowsApps aliases (correct for
   a Python Store stub) but winget ships ONLY as an alias. Added
   `ALIAS_IS_THE_REAL_COMMAND = new Set(["winget"])`. Eval row 2/3 → 3/3.
3. **Draw check could not read HEIF.** `ink-of-image.ps1` reported UNREADABLE; the
   file was a complete 10,989-byte HEIF (`ftypmif1`) that Paint saved under a `.bmp`
   name. GDI+ cannot decode HEIF. Added a WIC fallback + stopped it racing the save.
   Eval row 2/3 → 3/3.
4. **Chat auto-scroll** (`apps/desktop/demo.js`) — streaming forced the view down so
   you could not scroll up mid-reply. Now follows only when already at the bottom;
   also listens to wheel/touch/keys because the `scroll` event fires a frame late.

### Infrastructure
- **Model endpoint switched.** Baseten was out of credit (HTTP 402 on every
  completion, key valid). Now `api.deepseek.com`, model `deepseek-flash`,
  DPAPI-encrypted. Old key preserved at
  `secrets/model-primary-baseten-402-2026-10-03.bin`; old settings kept in
  `config.json` under `_disabledPreviousModel`; pre-change config at
  `config.json.bak-before-deepseek-2026-10-03`. A plaintext backup the protect
  script wrote was deleted.
- **`fallbackProviderConfigs` emptied** — both entries pointed at the same dead
  endpoint, so it was never real failover.
- **Budgets re-recorded** against the new model. The old ones were recorded 20 Aug
  against a different tokenizer, which made ~15 rows look like they had regressed
  by ~33% when the prompt was unchanged at 11,342 tokens/step.
  **`budgets.json` now records the model name. Budgets are only comparable within
  one model.**

---

## 5. DECISIONS MADE (do not re-litigate these)

1. **One paper: the evidence/fault-injection one.** The modality paper is #2, for
   next year. Do not work on it before December.
2. **Do NOT run WindowsAgentArena before December.** Costed at $50–80 (subset,
   DeepSeek, local Hyper-V) up to ~$500 full; the real cost is 2–4 weeks of adapter
   work. The paper does not need it.
3. **Do NOT chase the budget breaches.** They were a tokenizer artifact. Resolved.
4. **Do NOT submit to the Bangalore conference.**
5. **No journals.** In CS, conferences outrank journals. Delete that branch.
6. **Never fabricate citations.**
7. The eval is cited descriptively; no comparison to public benchmarks.

---

## 6. THE PLAN / TIMELINE

| When | What | Where |
|---|---|---|
| Now | Meet the professor | in person |
| This week | Fill the bibliography (~2–3 hrs) | `docs/paper/evidence-gating.md` |
| ~Week of 20 Oct | Convert to LaTeX (Overleaf), **post to arXiv** (`cs.SE`) | arxiv.org |
| Late Oct / Nov | Shorten to 4–8 pages, submit to **one workshop** | TBD — pick when deadlines are known |
| Nov–Dec | Applications | — |
| Jan–Feb 2027 | Full version to **DSN** (fault injection is its home subject) or ICSE/ISSTA | after applications |

**Three things to ask the professor:** (1) advise + co-author, (2) **arXiv
endorsement** — a first `cs.SE` submission needs an existing arXiv author to vouch,
(3) a recommendation letter.

**Costs:** arXiv free, workshop submission free, conference submission free.
Registration (~$200–800, student rates, virtual options, travel grants) only if
accepted AND attending. **Attendance is not required for a CV line.**

**arXiv is not a submission** — no review, no acceptance, instant. The workshop/
conference is the reviewed part. It is the SAME paper each time (full → short →
full); workshops are usually non-archival so they do not block the conference
version.

---

## 7. HOUSE RULES THAT GOVERNED ALL WORK HERE

From `CLAUDE.md` and enforced throughout. Future sessions must keep these:

- Never claim something happened without evidence from a tool.
- Unconfirmed is not failed. Three verdict states, never two.
- Verification must not share a code path with the thing it verifies.
- A check with an empty needle is not a check — **and every test must be PROVEN
  ABLE TO FAIL** by neutering what it covers. This was done for every test added
  this session.
- Attribute before blaming: measure the machine's load before trusting eval numbers.
- Comments carry the *reason* — the specific defect observed live.
- **Commit messages: 1–2 lines, no body, no Co-Authored-By.** (User instruction;
  overrides the default attribution reminder.)
- Do not commit unwanted files. `report/` is the user's own documents — leave it
  untracked.

---

## 8. OPEN ITEMS

- **Bibliography** — the only thing blocking the paper.
- **`messaging-send-to-self` fails 1 in 3.** Real, undiagnosed, in the paper as an
  honest finding.
- **`undo-file-overwrite`** failed 2/3 in one sweep, passed 3/3 in the next — flaky,
  undiagnosed.
- **The invariant compares labels, not call provenance** (the `volume` case). In the
  paper's limitations. Fixing it means threading call identity through the
  capability layer.
- **No baseline agent under fault injection.** The single experiment that would turn
  this from a workshop paper into a conference paper: run the same 4 fault classes
  against another agent's tool layer. Days, not weeks. Not needed before December.
- **Rotate the leaked `primaryApiKey`** (`state-of-the-world.md:1851`), and the two
  keys the user pasted into chat this session.
- Git history is clean of secrets (verified). Repo is safe to make public.

---

## 9. STARTING PROMPT FOR THE NEXT SESSION

Copy everything between the lines into the first message of the new session.

---

Read these files before answering, in this order, to get full context:

1. `docs/paper/HANDOFF.md` — what happened in the previous session, my goal, every
   decision made, and all the measured numbers. Read this first and in full.
2. `docs/paper/evidence-gating.md` — the paper we are writing. This is the current
   draft (v2).
3. `CLAUDE.md` — the repo's house rules.
4. `docs/state-of-the-world.md` — only if you need detail on a specific defect; it
   is ~2,300 lines, so grep it rather than reading it whole.

Context in one line: I am an undergrad applying to Stanford and MIT for a master's
with a ~1–15 Dec 2026 deadline, and we are finishing a paper from this repo titled
*"Evidence-Gated Tool Results: Making False Success Claims Unrepresentable in
Computer-Use Agents."* The only thing left in the paper is the bibliography.

Rules for you: commit messages are 1–2 lines with no body and no Co-Authored-By
line. Never fabricate citations. Do not re-litigate the decisions listed in §5 of
the handoff. Tell me plainly when something will not work rather than being
encouraging.

My question is:

---
