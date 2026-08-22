# SYSCORA — brief for the next session

Written 22 Aug 2026. This replaces the previous brief. **Where this conflicts
with any other document, this one wins — it is newest and every number in it was
measured on the machine on the day it was written.**

---

## PART 0 — HOW TO READ THIS

**TREAT EVERY DIAGNOSIS HERE AS A HYPOTHESIS.** Eight have now been wrong and
sent a session the wrong way. The most recent three, all from previous briefs:

- "1,443 MB of session store is 1,830 sessions at ~800 KB each" — that was an
  average, not a measurement. The median session is ~2 KB; 194 rows held 97% of
  the bytes. Following it would have deleted the user's conversations.
- "Move state to %LOCALAPPDATA%" — inside the Claude desktop app that path is
  captured by the app's container. 735 MB of conversations landed inside
  Claude's private storage.
- **"The two stalled eval rows are the user's phone tethering."** They were not.
  144-180s was 2 × 90s: one configured timeout, doubled by the loop's own retry.
  Fixed this session. **When a stall lands on a round multiple of one of your own
  constants, it is your constant.**

The user did not write this codebase by hand and does not read code. Explain in
plain language, never leave them to verify something themselves — verify it and
show them the evidence.

---

## PART 1 — WHAT THIS IS

An agent that operates a real Windows machine from natural language: Claude
Code's shape, pointed at the whole OS. It runs on the user's actual machine with
their actual logins. Not a VM, not a sandbox.

**The strategy in one sentence.** Everyone else pays a full model round trip per
perception step because screenshots are all they can see. SYSCORA reads the UIA
accessibility tree, so it can check preconditions locally and for free —
collapsing N round trips into one, and verifying without a second model call.
That is a harness advantage, so it survives whatever model is plugged in.

**Measured today, so you can quote it:**

| perception, one observation | tokens |
|---|---|
| Anthropic computer use screenshot @1280×800 | ~1,365 |
| SYSCORA `screen` — Settings | ~~~35~~ **267** |
| SYSCORA `screen` — WhatsApp (complex app) | ~~~925~~ **1,029** |

**CORRECTED 22 Aug 2026 — do not quote the struck-through numbers.** The ~35
was a read that FAILED and returned an error message; measured with
`node scripts/probe-one-window.mjs settings`, a successful reading of Settings
is 267 tokens. The honest claim is **1.3×–5× cheaper per observation, not 39×**.
See `docs/state-of-the-world.md`. What survives unchanged is the part that was
never a ratio: text does not accumulate in the conversation the way images do,
and what comes back is already named, clickable controls rather than pixels.

**The moat is verification.** `packages/fast-agent/src/evidence.js` makes a
success sentence unreachable without a CONFIRMED verdict, and refuses at
construction any receipt whose `method` equals its `actedVia`. Pointer.ai's own
stated frontier — the hard thing they say they are still writing about — is
exactly this. It is already built here.

**WHAT YOU MAY NOT CLAIM.** Pointer's 83.6% is OSWorld, a public benchmark.
SYSCORA's 100% is on 23 rows this project wrote about itself. Those numbers are
not comparable and saying "we beat Pointer" is unfounded until SYSCORA runs a
common benchmark. Do not put that claim in a README, a pitch, or a commit.

---

## PART 2 — WHERE THINGS STAND RIGHT NOW

Branch `w1-integration`, **18 commits unmerged onto master**, unpushed. Working
tree clean. Master is at `8546312`.

`npm test`: **1,165 tests, 1,163 pass, 0 fail, 2 skipped.**

Eval on a quiet machine and real wifi, 21 Aug: **100% (23 of 23 rows), median
5.6s, median 2 steps, $1.035, offline pipeline reached 0 times.**

### What was fixed this session

1. **The transport could not tell a thinking model from a dead socket.**
   `sendChatOnce` armed one abort timer and never rearmed it, so it measured
   TOTAL DURATION. A reasoning model streams its whole deliberation before it
   writes a tool call, so a turn thinking for 110s looked identical to a socket
   that died at the first byte — and the healthy one was aborted mid-stream. It
   now measures SILENCE (`STREAM_IDLE_TIMEOUT_MS` 45s), rearmed per chunk, with
   the caller's deadline as an absolute backstop. **This is what the "tethering"
   stalls actually were.**

2. **The output ceiling is shared with reasoning.** `reasoning_content` is billed
   as completion tokens and `max_tokens` bounds thinking and the tool call
   together, thinking first. At 4,096, **3 of 8** turns on one real drawing
   decision returned `finish_reason: length` carrying ZERO tool calls.
   Unconstrained reasoning ran 1,062–11,891, **p50 6,350** — the ceiling sat
   under the median it had to hold.

3. **"A CEILING IS NOT A COST" was corrected.** True about billing, false about
   behaviour. Raising it for every turn was measured over a full 69-run eval:
   pass rate 100% → 91%, six budget breaches, `draw-shape-in-paint` 3/3 → 1/3 at
   3× tokens and 2× steps. Given room the model thinks longer and then **attempts
   more**. So the base ceiling stays at 4,096 and extra room goes ONLY to a turn
   already cut off (`MODEL_OUTPUT_CEILING_RETRY` 16,384).

4. **Two miscalibrated eval ceilings**, re-derived from observed spread rather
   than one lucky sweep. `multi-step` 22,838 → 52,699 (its own worst passing run
   was 41,253); `draw-shape` 477,882 → 608,178.

5. **`probe-leaked-hosts.ps1` was counting any old `powershell.exe`.** It
   reported "5 orphaned hosts, 510 MB" when four were the Claude session's own
   shells and the fifth was the running desktop app's host. Nothing had leaked.

6. **The secret redactor was destroying cost metrics.** `/token/i` also matches
   `tokensIn`/`tokensOut`/`tokensFresh`, so 1,673 of 1,998 stored sessions
   recorded their own cost as `***REDACTED***`.

### W2 (un-sending a message) — groundwork done, blocked on something real

`packages/fast-agent/src/undo-message.js` exists with 9 passing tests, including
the one the brief demanded: **undo fails when the deletion lies about having
worked.**

**The switch is NOT flipped.** A send still records `reversal: null` and the
guard test "no message reversal may be recorded until something can carry it
out" is untouched. Nothing is wired into the `undo` tool.

The WhatsApp flow, measured live:
- the per-message menu opens on a **right-click of the bubble's text element**.
  `Open message options` is a named Button but reports `no-invoke-pattern`.
- "Delete" does **not** open a dialog. It enters a **selection mode** whose
  bottom bar carries "Cancel delete" and a second "Delete"; that one opens the
  modal titled "Delete message?".
- the modal's options are the only honest source of whether
  delete-for-everyone is available.

**THE BLOCKER.** A "Message yourself" chat **never** offers "Delete for
everyone" — a message sent seconds earlier was offered only "Cancel" and "Delete
for me", because a self-chat has no everyone. The chat the brief mandates for
testing structurally cannot exercise the path W2 is defined by. The delete
*mechanism* is proven end to end there (right-click → Delete → selection bar →
confirm → verified gone by raw-view re-read, 1 → 0). The "for everyone" variant
is not, and cannot be, without a second party. **Decide this with the user
before writing more code** — see W2 below.

---

## PART 3 — THE AUDIT, AND THE ORDERED WORK

### W1 — SPEED. Do this first; it is the largest measured win in the codebase.

**OCR runs by default and should not.** `capability-registry/src/index.js:1634`
only disables OCR when a caller passes `includeOcr: false`. Measured today
against WhatsApp:

```
screen.read WITH ocr   5,392ms cold / 1,718ms warm   190 elements
screen.read NO  ocr    1,195ms cold / 1,072ms warm   140 elements
```

**38% faster warm, 78% faster cold, 26% fewer elements** — and the code's own
comment already says OCR "returns the same words a second time and misread[s]"
for an application with a real UIA tree. So this is speed, cost AND accuracy in
one change.

Do it as a **fallback, not a deletion**: read UIA first; only capture and OCR
when the tree comes back unusable (no named elements, or a canvas-only surface).
`docs/webview-perception.md` and the drawing work depend on OCR existing for
surfaces that genuinely have no tree.

Two more in the same area:
- **WebView2 apps read the screen twice.** `tools.js` calls `screen.read`, then
  `readViaWebviewWindow` reads again. That is WhatsApp, Spotify, Teams, Discord.
  Saves ~1.1s on the most common real apps.
- **`adapter.listWindows()` costs 533ms and is called up to 3× per `screen`
  call.** Memoise it for the duration of one turn.

**Measure before and after with `scripts/probe-screen-p50.mjs` and a full eval.
Do not merge on the unit tests alone — the last change that looked obviously
right cost 9 points of pass rate.**

### W2 — UN-SENDING. Ask the user one question before writing code.

The self-chat cannot offer "Delete for everyone". So either:
- **(a)** the user nominates a second WhatsApp account or a trusted contact who
  consents to receiving and having deleted a test message, or
- **(b)** W2's acceptance criterion changes to "delete for me, proven gone",
  which the mechanism already does, and delete-for-everyone stays unwired with
  the guard test in place.

**Ask. Do not choose for them, and never test against a real person's chat
without explicit consent for that specific chat.**

All five historical traps are live in the code you will touch, and three were
re-confirmed this session:
1. an empty input box is not evidence of a send — WhatsApp publishes `value="\n"`
   when empty. **Confirmed again today.**
2. message text is hidden from the control view; a raw-view pass is required.
3. synthetic clicks are swallowed after a foreground change — prefer
   InvokePattern, but note `Open message options` does not support it.
4. a WebView2 app is two top-level windows: input to the FRAME, reads from the
   CONTENT window, found by parentage not by title.
5. the working window slides back to the frame.

Plus a new one: **`keyboard.press` with no `chord` falls back to
`SendKeys::SendWait($keys)`, which types "enter" as five literal characters and
still returns `performed: true`.** The message box ended up holding
`syscora-undo-mt409iu6enter` and nothing was sent. Always pass `chord`.
Consider making the host refuse a bare `keys` that names a key rather than
typing it — that is a false-success generator sitting in the input path.

### W3 — PRODUCTION HARDENING. None of this is optional before launch.

- **No crash guards exist anywhere in the repo.** Zero `uncaughtException` /
  `unhandledRejection` handlers. One unhandled rejection kills a daemon that is
  mid-way through changing the user's machine, with no journal close and no
  undo. Add them, flush the journal, and report honestly on restart.
- **The whole persistence layer is on `node:sqlite`, an experimental API** —
  sessions, audit, memory, approval tokens, capability grants, elevation grants,
  secrets, semantic state. Node says it "might change at any time". Pin
  `engines`, and decide whether to vendor a stable driver.
- **No concurrency control.** No queue, mutex or lock. Two overlapping requests
  both drive the one physical mouse. A single-flight lock with an honest "busy"
  response is a small change and a real correctness fix.
- **The model API key is in plaintext `config.json`** while `WindowsSecretBroker`
  (DPAPI) is constructed at `runtime-factory.js:156` and used for other things.
  Move it. **Never print it** — a previous session leaked it into a transcript
  by dumping the config.
- **No shipping path**: `version 0.1.0`, no `main`, no `engines`, no build or
  installer or update script.

### W4 — DELETE THE OFFLINE PIPELINE. Its own session.

**21,347 lines** across `agent-runtime`, `capability-registry`,
`reasoning-engine`, `intent-engine`, `planner`, `risk-engine`,
`task-graph-scheduler`, `recovery-engine`, `troubleshooting-engine`,
`context-engine`, `developer-intelligence`, `semantic-state`, `benchmark`. The
eval reports **offline pipeline reached 0 times**.

**The "delete 20k lines" framing in older briefs is wrong in one way that
matters, verified this session:** `fast-agent` imports `capability-registry`
(5,945 lines) for **exactly one function**, `matchesTrackQuery`, at
`tools.js:41` — and `runCapability` resolves through the registry, so the
capability layer is ON THE HOT PATH. The real move is: relocate one Spotify
helper, keep the capability layer, delete the planner/reasoning/intent/risk/
task-graph stack. **Roughly 12–14k lines are genuinely dead, not 20k.**
`packages/planner` is a standing naming trap — it is not the thing the hot path
plans with.

### W5 — THE ACCURACY CLAIM. This is what makes the product defensible.

21 eval rows, all self-authored. Pointer has 361 verified publicly. Until
SYSCORA runs a **common public benchmark**, every accuracy comparison is an
assertion. Grow the suite toward 50+ weighted to multi-application tasks, and
seriously consider running a public benchmark subset.

### W6 — SECOND VENDOR.

Both configured endpoints serve the same DeepSeek family, so failover survives
an endpoint outage but not a bad model release, a deprecation or a policy
change. If the user supplies an Anthropic or OpenAI key, wire it and re-run
`scripts/probe-failover.mjs`. If not, say so once and move on.

---

## PART 4 — RULES YOU MAY NOT BREAK

- **NEVER CLAIM SOMETHING HAPPENED WITHOUT EVIDENCE FROM A TOOL.** Structural: a
  success sentence is only reachable through `confirmed()`.
- **UNCONFIRMED IS NOT FAILED.** Three states, never two.
- **VERIFICATION MUST NOT SHARE A CODE PATH WITH THE THING IT VERIFIES.**
- **A CHECK THAT CANNOT FAIL IS NOT A CHECK. PROVE IT BY BREAKING IT ON PURPOSE.**
  This session wrote a test for the idle timeout that passed with the mechanism
  deleted, because its fetch stub ignored `signal`. It was caught only by
  deliberately breaking the code. Do this every time.
- **A GUARD THAT ENUMERATES PHRASINGS IS A RACE AGAINST A MODEL'S SYNONYMS.**
  Change the shape, not the vocabulary.
- **AN AVERAGE NAMES THE WRONG MECHANISM.** Print the distribution.
- **A FIX CAN BE UNREACHABLE.** This session's retry ceiling needed ~153s at the
  measured ~107 tokens/s against a hard 90s cap; it would have measured as no
  fix at all. Check a fix can physically run inside every limit before measuring
  whether it works.
- **AGE IS NOT ORPHANHOOD, AND PIDS ARE REUSED.** A leaked host is one whose
  OWNER is gone. Believe a parent only when it also started before the child.
- **A CEILING BELOW A ROW'S OWN WORST PASSING RUN IS NOT A GATE.**
- **BLUNT IS NOT BLIND.** `detects20` is a report, not a switch. Suppressing
  ceilings on noisy rows leaves the most expensive rows unguarded at any
  magnitude — tried this session, caught immediately by an existing test.
- Safety lives in `shell-rules.js` as data, at the tool boundary, never as a
  pipeline stage. `content-boundary.js` is the same shape for injection.
- Comments carry the REASON — the specific defect observed live. Match density.
- Ask before restarting or closing an app the user has open. **The desktop app is
  usually running and owns a PowerShell automation host; do not kill it.**
- State holds secrets in plaintext. **Never print them.**

---

## PART 5 — THE PATTERN

**Ten consecutive sessions, the biggest find was NOT a capability defect.** It
was correct machinery nothing reached, or a measurement measuring the wrong
thing. This session alone produced four:

- a timeout measuring total duration instead of silence
- a leak probe computing `IsHost` and then ignoring it
- a redactor destroying the cost metrics of 1,673 sessions
- an eval ceiling set below its row's own ordinary worst run

Every time, the loop reported CORRECTLY, and that accuracy is what made it look
like a broken capability. **An honest failure report tells you what did not
happen. It never tells you why.**

`scripts/audit-reachability.mjs` hunts this class on purpose; its `--self-test`
must catch 5/5.

---

## PART 6 — HOW TO WORK

- Branch per workstream. Never commit to master directly.
- **MERGING AND PUSHING ARE THE USER'S DECISIONS.** Prepare, report, ask.
- Do not merge until the eval shows NOT WORSE on pass rate and median time, with
  no per-row budget breach, on a quiet machine and a real connection.
- If a change makes the numbers worse, say so plainly and revert it. That
  happened this session and saying so was the right call.
- **NEVER RUN TWO HEAVY THINGS AT ONCE.**
- **ASK ABOUT TETHERING BEFORE THE EVAL.** One run costs ~$1.03 and 40 minutes,
  drives the screen, and the `--manual` rows message the user's own WhatsApp and
  change audible volume. Tell them to walk away.

```
npm run eval -- --repeat 3 --manual     the scoreboard
npm test                                 ~8 min, never pipe the summary away
node --test --test-timeout=240000 --test-force-exit tests/unit/<file>.test.js
scripts/audit-reachability.mjs           correct code nothing calls
scripts/probe-reasoning-budget.mjs       reasoning vs the output ceiling
scripts/probe-leaked-hosts.ps1           orphaned hosts (fixed this session)
scripts/probe-idle-load.ps1              what the machine does at rest
scripts/probe-whatsapp-menu.mjs          WhatsApp message menu, read-only
scripts/probe-whatsapp-unsend.mjs        the full un-send round trip
scripts/probe-screen-p50.mjs             one look at the screen, per app
scripts/measure-prompt-cost.mjs          8,619 tokens/step fixed cost
```

**ORDER: W1 (perception speed — measure, change, re-measure, full eval), then
ask the user the W2 question, then W3 hardening. Stop and report.**

For each item report: what changed, before and after numbers from a NAMED
script, the machine load and connection when you took them, and what you did not
do. Never report a target as met on an argument — only on a measurement.

**If you find another check that measures nothing, another metric measuring the
wrong thing, or another piece of correct machinery nothing calls — that finding
is more valuable than the feature you were working on. Stop and report it. Ten
sessions running, that has been the most important thing found each time.**
