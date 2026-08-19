# SYSCORA — state of the world, 19 Aug 2026

Written for a session starting cold. Read this, then `docs/production-plan.md`.

## THE NUMBER IS NOW IN `tests/eval/scoreboard.md`, AND IT IS MEASURED

Every figure below this section dated 17 Aug is an n=1 hand-run. From 19 Aug the
project has a repeated, commit-stamped baseline over the whole task set, and it
is the only number that should be quoted:

```bash
npm run eval -- --repeat 3 --manual                  # hold a change to the baseline
npm run eval -- --repeat 3 --manual --write-budgets  # record a new one
```

**Baseline, 19 Aug 2026, commit `f075fde`, 19 tasks × 3 = 60 runs on this
machine:** pass rate **90%** (18/20 rows passing every repeat), median **156**
fresh tokens, median **4.6s**, median **2** steps, $0.594 for the whole suite.

A task counts as passing only when EVERY repeat passed. The spread is printed
beside every median, because the spread is the thing that made single runs
useless: `app-type-into-notepad-and-save` ranges 4,404–18,334 fresh tokens and
43–94 seconds across three consecutive runs of identical code.

`tests/eval/budgets.json` holds each task's ceiling, recorded from that baseline
and never hand-written. A later run breaches when ITS median exceeds the ceiling,
so one unlucky run cannot fail the build and a task that got quietly twice as
expensive cannot pass it. Any breach exits non-zero.

### What the eval found the first time it was run properly

Three of the numbers this project had been quoting were measuring nothing.

- **The flagship task's verify could not fail.** `messaging-send-to-self` — send
  a WhatsApp message — verified with `Write-Output 'checked-by-human'`. Every
  scoreboard had shown a green tick for the highest-stakes action in the product
  with nothing at all behind it, on the one task whose reason for existing is the
  bug where a message was reported sent while the text sat unsent in a search
  box. Replaced with a count of the text in the CONVERSATION, before and after,
  over the raw UIA view of WhatsApp's content window in its own process.
  **It now fails 0/3: the send does not happen.**
- **The volume task's verify could not pass.** It called `Get-AudioDevice`, from
  a module that is not installed here, so it printed `unreadable` however well
  the agent did. And the machine was already sitting at 42%, the value the task
  asks for, so even a working check would have passed with the agent doing
  nothing. It now reads the endpoint through its own `IAudioEndpointVolume`
  binding and the setup moves the volume away first. It passes 3/3, honestly.
- **`--mock` stopped meaning mock** the moment a real fallback provider was
  configured. `MockModelProvider` does not support `chat`, so failover skipped
  past it and `npm run eval -- --mock` — documented as "no model, no machine, no
  cost" — ran thirty-odd tasks against a paid endpoint and the real machine,
  including one that drives WhatsApp. Asking for mock now yields mock alone.

And one harness defect that made a bad row look like a catastrophe: a task that
hit its timeout did not stop its session, so the daemon's one-request-at-a-time
rule answered 409 to everything after it and two whole rounds recorded as zeros.

### Still open, found by measuring, NOT yet fixed

- **The WhatsApp send does not work.** 0/3, ~137s, 4 steps, `launch → screen →
  click✗`. It settles honestly rather than lying, which is the invariant holding,
  but the task fails.
- **A saved route replays cleanly only 2 times in 3.** The recorder writes a
  first step whose `verify` is `{kind: "element-present"}` with no needle — "a
  check with an empty needle is not a check", from this file's own rules — and
  when it does not hold the replay hands over to the model at step 1 in 62ms.
- **The Baseten account is out of credit** (`HTTP 402: please check your current
  payment status`), which is what made the first baseline attempt unusable. The
  primary is now the DeepSeek endpoint directly, with Baseten kept as the
  fallback entry so the chain is real.
- **The leaked `primaryApiKey` still needs rotating by the user.**

## What this is

An agent that operates this Windows machine from natural language — Claude Code's
shape, pointed at the whole OS. Chat in, real actions out, verified against the
machine. The goal is a product people trust with their computer: **fast, cheap,
and incapable of claiming something it did not do.**

## Where it actually is

A strong prototype with a genuinely good perception layer and an honest action
layer. Not yet a production system. The gap is specific and measured below.

### Measured, 16–17 Aug 2026, real machine, real model (DeepSeek via Baseten)

| task | steps | time | tokens | outcome |
|---|---|---|---|---|
| WhatsApp send (flagship) | 6 | 35s | 62,417 | sent, confirmed in-conversation |
| WhatsApp send, 16 Aug baseline | 66 | 309s | 1,160,162 | needed manual coordinate click |
| read last 2 messages | 6 | 23s | 67,768 | correct |
| `is python installed?` | 2 | 41s | 19,257 | correct, slow |
| disk space / top RAM | 2 | ~6s | ~18,300 | correct |
| play a song on Spotify | 5–7 | 27–47s | 54k–77k | correct, needs a click fallback |
| draw a train in Paint | 37–54 | 227–365s | 514k–894k | **poor; one run ran out of time** |

### THE COST NUMBER THIS PROJECT HAS BEEN QUOTING IS THE WRONG ONE

Measured 17 Aug 2026, `node scripts/probe-prompt-cache.mjs`: the endpoint caches
prompt prefixes automatically and reports it as
`prompt_tokens_details.cached_tokens`, **including through the streamed channel
the loop uses**. 8,320 of the 8,222-token fixed prefix comes back cached on every
step after the first; a prefix differing at its first token reports 0. A cached
input token costs roughly a tenth of a fresh one.

Every figure this project has quoted counted them the same. The loop now records
`tokensCached` and `tokensFresh`, and every surface shows them. **Reduce
`tokensFresh`.** `tokensIn` is bandwidth, not money.

This rewrote W2 in the plan: **W2.1 needed no work, and W2.2 (tool scoping) is
now actively counter-indicated** — the tool schema sits inside the cached prefix,
so varying it per request is exactly the control case that cached nothing.

### Measured, 17 Aug 2026, after W1 (typed evidence on every tool)

| task | steps | time | tokens | outcome |
|---|---|---|---|---|
| `is python installed?` | 2 | 5.8s | 18,265 | correct (was 41s / 19,257) |
| disk space | 2 | 6.3s | 17,580 | correct |
| read last 2 messages | 3 | 15.2s | 29,759 | correct, chat already open |
| read last 2 messages | 10 | 46s | 122,000 | correct but ANSWER TRUNCATED — see below |

The two message runs bracket the 16 Aug baseline (6 steps / 23s / 67,768). The
spread is which chat WhatsApp starts on, not the evidence work: with the chat
already open it is two tools, and from a different chat it must search and click.

Per-action cost of the new checks, warm p50 (`node scripts/probe-evidence.mjs`):
`adapter.focusedElement` **66ms** per click, `getForegroundWindow` **16ms** per
focus, `listWindows` **259ms** per launch and per window-state change. Prompt
cost unchanged at 8,222 tokens/step — W1 adds nothing to the schema.

### Measured, 17 Aug 2026, after W3.1 (the local fast path)

`node scripts/probe-fast-path.mjs`, warm, on the real machine:

| request | before | after |
|---|---|---|
| `volume 40` | 18,400 tok · 5.5s | **0 tok · 115ms** |
| `what's my volume` | 18,400 tok · 5.5s | **0 tok · 121ms** |
| `mute` | 18,400 tok · 5.5s | **0 tok · 461ms** |
| `turn the volume down a bit` | — | 26,573 tok · 8.0s, **routed to the model, correctly** |

`mute` misses the plan's 400ms by ~60ms and that has been left alone: 300ms of it
is the peak meter proving the endpoint is actually silent, which is the check
that exists because "Volume is 28% (muted)" was reported twice while music
played. An unmuted call skips it, which is why `volume 40` is 115ms.

That needed the **audio endpoint moved into the long-lived PowerShell host**. It
was `Add-Type`d into a fresh `powershell.exe` on every call — 1,400ms, of which
~1,100ms was startup and C# compilation. Guarded by a `try`: a machine where it
fails loses the volume operations and keeps UIA, input and capture, and the
out-of-process route is still the fallback.

Tests: **1022, 1020 pass, 0 fail, 2 skipped** (`npm test`, ~8 min).
Was 989 / 987 at the start of the day.

### Fixed-cost floor (`node scripts/measure-prompt-cost.mjs`)

```
system prompt      3,311 tokens
tool schema        4,912 tokens   (30 tools)
TOTAL PER STEP     8,222 tokens   re-sent on every step, no caching
```

Two model calls is the minimum for any tool-using answer, so **nothing costs
less than ~17k tokens today.** This is the central business problem.

## W1 is done: the honesty invariant is structural (17 Aug)

`packages/fast-agent/src/evidence.js` is new and every tool now goes through it.

- Every `execute` returns `{ ...data, evidence }` — `{ observed, method, at,
  verdict, actedVia }`, verdict one of CONFIRMED / REFUTED / UNCONFIRMED.
- A success sentence is only reachable through `confirmed(result, sentence)`,
  which throws without a CONFIRMED verdict. `refuted`, `unconfirmed` and
  `reported` cover the other three kinds of thing a render can say.
- `evidence()` REFUSES to build a receipt whose `method` equals its `actedVia` —
  the house rule about verification not sharing a code path, enforced at
  construction instead of remembered. The one exception is a REFUTED verdict: a
  capability reporting its own failure has nothing to gain by lying.
- `NOTHING_READ_IT_BACK` is a real method name for the cases where no cheap
  reading exists (a bare keystroke, a pointer move). It is only valid with
  UNCONFIRMED, which the constructor enforces.
- `tests/unit/tool-evidence.test.js` walks all 30 tools, EXECUTES each one, and
  proves: no render can speak from a receipt-free result; no acting tool says the
  same thing on UNCONFIRMED as on CONFIRMED; nothing verifies itself. Verified by
  deleting `close_app`'s wiring — four tests fail.

Checks that did not exist before and now do: a click is confirmed by the focused
control (UIA, not the pointer); `focus` by the desktop's foreground window, not
`window.activate`'s opinion of itself; `launch` by the window list; `write_file`
and `edit_file` by reading the file back; `clipboard` by reading it back;
`window_state` by the window's bounds before and after; `remember` by re-reading
the notes file.

Two live bugs fell out of the pass:

- **`key` rendered the single word "Sent." for EVERY keystroke that was not a
  gated send** — ctrl+s, escape, f5. The send wording was written for Enter in a
  messaging window and left as the fallback for everything else. A test asserted
  it.
- **`web_type` trusted a value read back inside the same evaluate as the write**,
  which is before a controlled React component re-renders. It now re-reads the
  field through `browser.read`.

## Four more defects, found by measuring and fixed the same day

1. **A truncated turn was published as the finished answer.** A run settled
   COMPLETED on "The last two messages in the chat are:" and nothing after the
   colon — 2,062 output tokens against a 2,048 ceiling. The provider had said
   `finish_reason: "length"` all along and both transports already parsed it; the
   loop threw it away. Now: a truncated turn is DISCARDED WHOLE, including its
   tool calls — the arguments of a cut-off call are a JSON object the provider
   stopped writing, and this loop runs `type`, `run` and `click` straight onto
   the user's machine. Retried once, then PARTIALLY_COMPLETED with the fragment
   and a warning. `maxTokens` 2,048 → 4,096; a ceiling is not a cost.

2. **An answer that simply stops.** A second run ended on a colon with
   `finish_reason: "stop"` and 1,359 of 4,096 tokens — the model announced a list
   and ended its turn. Not truncation, and invisible to every existing guard,
   which look for a next step being narrated. `looksUnfinished` now also catches
   a reply ending on punctuation that cannot end a thought.

3. **The working window slid back to the frame.** `launch` and `focus` wrote the
   WebView2 frame handle into the working window, discarding the content window
   perception had paid to find. The next `screen` read the frame, found the same
   caption buttons, and reported "IDENTICAL — nothing at all has changed on
   screen". The agent's own conclusion, live: *"the screen tool isn't returning
   the chat content"* — it read the tool as broken rather than the window as
   wrong, and burned five steps and ~30,000 tokens. `readingWindow` is the mirror
   of `inputWindow`: input goes to the frame, reads go to the content window.

4. **Provider markup could still reach the user.** The malformed-turn retry was
   guarded on "have I already retried", so a SECOND malformed turn fell straight
   through to `lastText` — which is what the run is settled with. That is exactly
   how `<｜DSML｜invoke …>` reached a live transcript. Detection and refusal are
   now separate decisions: retry once, never publish. `tests/unit/malformed-turn.test.js`
   is the fuzz test W4 asks for — every sentinel, every position, twice running.

## What was fixed on 16–17 Aug (do not regress these)

1. **Activating a webview CONTENT window is not activating the application.**
   The costliest bug in the project's history. A WebView2 app is two unrelated
   top-level windows; perception correctly follows into the Chromium content
   window, and actions then aimed at that handle. Windows reports total success —
   foreground, visible, correct pixel, UIA focus — while the app shell never
   learns it is active and discards every keystroke and click in silence. Fixed in
   `Acquire-Foreground` / `Find-OwningFrame` in `os-adapters/windows-host/restore-host.ps1`.
   **It must be fixed there**, not in the tools layer: a caller that names the
   application instead of the handle bypasses anything done higher up, which is
   exactly how it came back after being fixed once.

2. **Chromium hides message text from the control view.** WhatsApp publishes
   message text with `IsControlElement=false`, so `FindAll` under the control view
   cannot return it at any limit. A second, condition-filtered raw-view pass costs
   ~339ms and adds the conversation. `Get-HiddenTextTargets`, same file.

3. **A synthetic click is the least reliable way to press a control.** Reproduced
   3/3: a click delivered after any other window held the foreground is swallowed;
   no settle fixes it. Named pressable controls now go through UIA `InvokePattern`
   (~27ms, immune to z-order/foreground/DPI). Only `button|menuitem|link|checkbox` —
   Invoke on a list row can succeed and mean nothing.

4. **Superseding old screen readings collapsed only ONE earlier reading**, and it
   usually found a 3-line diff summary rather than the 110-line listing behind it.
   Six full listings accumulated in the 1.16M-token run.

5. **An empty input box is not evidence of a send.** WhatsApp's message box
   publishes `value="\n"` when empty, so every "input-empty" check passed
   vacuously. Sends are now confirmed by finding the words in the CONVERSATION
   with a timestamp, via a different code path from the one that sent them.

6. **The loop settled COMPLETED on a turn that narrated the next step.** Now
   nudged once, then reported PARTIALLY_COMPLETED.

7. **Bare acknowledgements with no tool call.** `"mute"` → `"Muted."` in 1 step
   with zero tool calls, twice in five turns, both false. The evidence backstop was
   anchored on phrases like "I've set". Now catches bare past participles and state
   assertions; a repeated claim with still no tool call settles FAILED.

8. **Mute is proven by silence, not by a flag.** The endpoint accepted `SetMute`
   and reported muted while the user still heard audio. `IAudioMeterInformation`
   now samples the actual output for ~300ms; a muted endpoint that is still
   emitting is reported as the contradiction it is.

9. Repeat guard resets when the screen changes; `focus` keeps the working window;
   a tool click records the tool immediately; section headings must be static text;
   a network blip no longer routes to the offline pipeline's raw Win32 codes.

## What is still wrong — with evidence

- ~~**Cost.** 8,222 tokens/step fixed, no caching.~~ The caching was there all
  along and unmeasured; see the cache section above. **W2.4 is decided:** the
  history collapse is OFF by default from 19 Aug, behind
  `SYSCORA_COLLAPSE_HISTORY=1`. Three paired live runs at six steps: 24,725 fresh
  with it on against 16,623 and 16,196 with it off. It saves tokens and spends
  cache, and on this endpoint the cache is worth more. Both code paths stay until
  P4 replaces them — n=3 moves a default, it does not delete a code path — and
  the eval measures both settings across the whole task set.
- ~~**No cost budget anywhere.**~~ `maxFreshTokens`, default 150,000, sits beside
  `maxSteps` and `maxElapsedMs` from 19 Aug. Counted in FRESH tokens, because a
  ceiling on `tokensIn` would fire on runs that cost almost nothing. On breach it
  settles PARTIALLY_COMPLETED with both numbers in the sentence.
- **Latency.** `screen` on WhatsApp is ~2–4s, dominated by a full-tree `FindAll`
  (W3.2, untouched). A shell command is now ~6s end to end, not 41s. Requests
  that need no model at all now take 115–461ms and no tokens (W3.1, done).
- ~~**One provider, no failover.**~~ Two endpoints are configured from 19 Aug —
  `model.fallbackProviderConfigs` in `.syscora/config.json`. The code was always
  there; the gap was ten lines of JSON. `node scripts/probe-failover.mjs` proves
  it by pointing the primary at a dead port and checking a real request finishes
  anyway, naming the endpoint that served it from `FailoverModelProvider`'s own
  receipt rather than inferring it from success.
  **Caveat: both endpoints serve the same model family and one of them has no
  credit left.** That is resilience against an endpoint, not against a vendor.
- **Drawing is a demo, not a capability.** 54 steps, 894k tokens, incomplete.
- **No undo.** It cannot un-send a message. `docs/trust-and-triggers.md` unbuilt.
  **This and the next item are what an enterprise buyer asks about first, and
  neither has been started.**
- ~~**No injection boundary.**~~ Built 17 Aug — W5.2 in the plan, and
  `packages/policy-engine/src/content-boundary.js`. Detection and surfacing on
  every reading; enforcement anchored on DESTINATIONS, so acting on a phone
  number, address, URL or wallet that came out of content rather than out of the
  user's request is refused and quoted. 24 red-team cases caught, 18 innocent
  ones untouched, and `node scripts/probe-injection.mjs` proves it on the real
  machine. **Its limits are stated in the plan** — an instruction with no
  destination is not covered by the enforcement tier.
- ~~**Provider markup leaks.**~~ Fixed 17 Aug — see defect 4 above.
- ~~**The honesty invariant is enforced by a growing pile of regexes.**~~ Done,
  17 Aug — see W1 above. The loop-level backstops in `index.js`
  (`claimsWithoutEvidence`, `looksUnfinished`) are deliberately unchanged: they
  are the second line now, catching what the MODEL says, while the tool layer
  catches what the TOOLS say.

## The house rules that are not negotiable

- Never claim something happened without evidence from a tool.
- Unconfirmed is not failed. Three verdict states, never two.
- Verification must not share a code path with the thing it verifies.
- A check with an empty needle is not a check.
- Safety lives in `shell-rules.js` as data, checked at the tool boundary.
- Comments carry the *reason* — the specific defect observed live.
- Ask before restarting or closing an app the user has open.
- `npm test` is ~9 minutes; never pipe it through `tail`/`grep` in a way that
  buries the summary.

## Where things are

```
packages/fast-agent/src/index.js     THE AGENT LOOP — the hot path
packages/fast-agent/src/tools.js     the ~30 tools, and the screen renderer
packages/fast-agent/src/evidence.js  the receipt every tool result carries
packages/fast-agent/src/fast-path.js the requests answered with no model at all
packages/fast-agent/src/skill-*.js   record / replay / verify a saved route
packages/perception/                 capture, OCR and UIA, fused
packages/policy-engine/src/shell-rules.js   the DENY floor and CONFIRM tables
packages/policy-engine/src/content-boundary.js  what we READ is not who we work for
os-adapters/windows/src/windows-adapter.js  the Windows adapter, audio shim
os-adapters/windows-host/restore-host.ps1   long-lived host: UIA, SendInput, capture
os-adapters/windows/src/webview-windows.js  frame vs content window
apps/daemon/src/server.js            HTTP + SSE, 127.0.0.1 only
tests/eval/                          pass rate, tokens, time, cost
scripts/probe-*.{mjs,ps1}            live measurement — the honest way to check
```

`scripts/probe-fast-agent.mjs "<request>"` runs one real request end to end and
prints steps, tokens (fresh and cached) and time. `--approve` answers
irreversible-action cards. The others, all measuring the real machine:

```
probe-evidence.mjs      every tool's receipt, and what each new check costs
probe-prompt-cache.mjs  does the endpoint cache the prefix, and can we see it
probe-history-cost.mjs  the same task with and without the history collapse
probe-fast-path.mjs     the requests that should cost nothing, timed
probe-injection.mjs     a hostile document, read by the real agent
```

There is a second, older staged pipeline under the loop. It answers only when no
model can be reached. **Do not add features there.** It is a candidate for
deletion — see the plan.
