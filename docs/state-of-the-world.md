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

### Fixed 19 Aug 2026, with the measurement

- ~~**The WhatsApp send does not work.**~~ **3/3, median 28.7s.** The cause was
  `autoApprove` never being read on the fast path — see the correction above.
- ~~**A saved route replays cleanly only 2 times in 3.**~~ **3/3, every replay 0
  tokens in 0.8s.** The recorder's fallback for any tool it had no rule for was
  `{kind: "element-present"}` with no needle, and the verifier read an absent
  needle as "did anything come back at all" — so a `write_file` step verified
  because the window behind it had buttons on it. **Auditing the rest of the
  switch found the same hole in `window-title-contains` and `file-contains`**;
  `"anything".includes("")` is true. Fixed in three layers: the recorder derives
  a needle from the step's own arguments or writes no check, `validateSkill`
  refuses a searching check with no needle, and the verifier returns UNCONFIRMED
  rather than VERIFIED when asked to look for nothing.
- **A malformed `.syscora/config.json` is now loud.** `loadModelConfig` caught
  the parse error and silently fell through to the offline Mock provider, so a
  key pasted as a sentence took the whole product off its real model with no
  symptom but strange answers. It still starts — refusing to boot over one comma
  is worse — but it warns on stderr saying exactly that.

### Fixed 20 Aug 2026: perception was slow AND wrong, and it was one line

`New-UiCacheRequest` set the UIA cache request's `TreeScope` to
`Element -bor Descendants`. That property is not how much tree to SEARCH — the
`FindAll` right after it says that — it is how much to PREFETCH around every
element the search returns. So a `FindAll(Descendants)` that found 530 controls
asked UIA to cache 530 subtrees, which is the same tree over and over.

Measured on the real machine, same properties, same patterns, same 530 elements
found and the same 97 usable out the other end:

```
  Element|Descendants   FindAll  2299ms
  Element               FindAll   281ms      8x, for identical output
```

**And on a WebView2 frame it was not merely slow, it was wrong.** The prefetch
walks across the frame's child-HWND boundary into the Chromium provider and UIA
throws `IndexOutOfRangeException` from inside `FindAll`. The host therefore
returned 0 elements on one call and 240 on the next, and the 240 were *other
applications' controls*. A live transcript on 20 Aug 2026 contains a reading
headed `Window: WhatsApp.Root — WhatsApp` holding Visual Studio Code's menus,
Opera's toolbar and Spotify's transport; the agent said it "looks scrambled",
forced focus, read again and recovered — two extra steps and about twelve
seconds, on a request that otherwise worked. Reading that frame took **25.7
seconds to return nothing at all**. It now takes 30ms and returns the six
caption buttons that are really there, which is what makes the redirect to the
content window fire correctly.

`node scripts/probe-screen-p50.mjs`, the `screen` TOOL end to end:

| p50 | before | after |
|---|---|---|
| WhatsApp | 3,134ms | **1,233ms** |
| Spotify | 3,432ms | **1,466ms** |
| Chrome | 3,835ms | **1,408ms** |
| all warm reads | 3,432ms | **1,408ms** |

**The W8 target of 1.2s is NOT met — 1,408ms, over by 17%.** What remains is not
the tree walk: raw UIA `FindAll` on WhatsApp's content window is 281ms, and the
rest is the host serialising elements and the second raw-view pass that Chromium
windows need for text the control view hides. The brief's assumption that
`screen` was "dominated by a whole-tree FindAll" was wrong, and measuring it
first is what found the real cause.

`tests/unit/live-run-regressions.test.js` pins the one line; it fails with the
offending assignment quoted if anyone puts `Descendants` back.

**What it did to the suite** — `npm run eval -- --repeat 3 --manual`, run twice
after the fix, against one run of the same suite before it:

```
                      before        after #1      after #2
  pass rate           100% (20/20)  100% (20/20)  100% (20/20)
  median time         5.4s          4.7s          4.7s
  median fresh        186           225           217
  offline pipeline    0 of 60       0 of 60       0 of 60
```

Median fresh moved by less than the run-to-run noise of the metric itself: the
SAME commit scored 212 and 186 on two runs, so ±26 is the floor of what this
number can resolve, and nothing in a UIA prefetch setting can change the cost of
`files-read-contents`.

**The spreads are where the fix shows.** Per-run, the flagship send went from
`152.6s / 22 steps, 20.1s, 21.7s` to six consecutive runs of **5 steps** at
17.0–21.7s. The 22-step run was the wrong-window recovery — `launch → screen →
windows → focus → screen`, ten of its twenty-one tool calls being `screen`.
`webview-click-icon`, previously the widest-spread row in the suite at
27.1–51.1s, now runs 17.1–19.4s.

### Measured 21 Aug 2026: the drawing hole, and why W2 (the planner) is cancelled

There was **no drawing task in the eval**, so the single worst result this
project ever recorded — a train, 54 steps, "894,000 tokens" — was measured by
nothing, and it was the main argument for building a planner. `20-draw-shape`
now covers it. Seven runs on current code:

```
  steps      15, 15, 23, 23, 39, 40, 48        median 23
  sent      178k … 1,001k                      median 354k
  fresh     7,912 … 103,455                    decided by the cache, see below
  time      70s … 301s                         median 99s   (one run timed out)
```

**Against the stated threshold for building a planner — 500k+ tokens or 40+
steps — drawing does not meet it. W2 IS CANCELLED, on the evidence.**

The tool sequence says why, and it is the same in every run:

```
  launch → new_document → screen → click → screen → draw → …
```

**The circle is on the canvas by step 6, in a single `draw` call.** Every
remaining step is Paint's Save-As dialog — the 48-step run spent eighteen shell
calls flailing at it. That is not a decomposition problem and a planner emitting
milestones would not remove one click of it. If this row's cost ever matters, the
fix is a `save_as` verb of the same shape as `new_document`, which was added for
exactly this reason and is the first thing the agent reaches for.

The old headline was also never what it was used to argue. "894,000 tokens" was
tokens SENT; the same task today sends 178k–1,001k and is billed 7,912.

### Measured 21 Aug 2026: fresh tokens are hostage to someone else's cache

The drawing row, six times, identical code, inside twenty minutes:

```
  cache hit 97.8–98.7%    fresh    7,912 –  12,809
  cache hit 66.6–73.1%    fresh   48,753 – 103,455
```

At the **same 23 steps** that is 7,912 against 103,455 — thirteen times — while
`tokensIn` across that pair moved 8%. Nothing in the code changed; the endpoint's
prefix cache went cold.

So **the eval gate is now on tokens SENT, not fresh tokens**. Fresh tokens are
the money and are still reported, beside the cache hit rate that explains them —
the scoreboard prints that rate and says to read any cost difference against it
before hunting for a bug. Tokens sent are what the agent actually did.

The gate is held to both halves of its claim by
`node scripts/probe-gate-sensitivity.mjs <baseline.json> <later.json>`, against
two real runs of the same code: **0 false alarms**, and a 20% regression injected
one row at a time is caught on 2 of the 7 rows big enough for 20% to mean
anything. The scoreboard names which rows those are, because a gate whose
sensitivity is unstated is one nobody can trust.

### Fixed 21 Aug 2026 (W0): the machine was slow because of US, and the stated cause was wrong

The user asked this product twice why their machine felt slow. Both times it
answered "OneDrive is syncing" — measured, honest, and useless, because nobody
asked what OneDrive was syncing. `.syscora/` sat inside
`C:\Users\hithe\OneDrive\Documents\SYSCORA`: 2,068.6 MB of databases rewritten
every agent turn, re-uploaded continuously, with the plaintext API keys.
OneDrive does not read `.gitignore`.

**The second half of the diagnosis was wrong, and it would have sent the fix the
wrong way.** The standing explanation for the 1,443 MB session store was "1,830
sessions at roughly 800 KB each, because every session keeps its full event
stream including screen readings". That is an average, and the average names the
wrong mechanism. `node scripts/probe-session-store.mjs`:

```
  newest 1,000 sessions        31.4 MB      the median session is ~2 KB
  123 sessions from 8 Aug     843.6 MB      58% of the file, one day
  ONE session                 396.4 MB      27% of the file, one row
```

194 of 1,834 sessions held 1,401.7 MB — **97% of the bytes in 11% of the rows.**
Inside the biggest: `events` 140.7 MB over 35 entries, which is 4 MB per event,
and `interactiveController` 123.1 MB — the offline pipeline's entire result
object assigned onto the session at `agent-runtime/src/index.js:1810`.

A retention policy, the obvious response to "1,830 sessions", would have deleted
the user's conversations and left the actual defect — an unbounded ROW — in
place to write another 400 MB the next time that path ran.

What was built:

- **`resolveStateDir`** (`packages/shared-types/src/state-path.js`) is now the
  one place `.syscora` is resolved: `SYSCORA_STATE_DIR`, then a `.syscora-path`
  pointer file, then the old behaviour. The third rule is what keeps ~40 tests
  on temp roots isolated from each other and from the real installation; a
  machine-global default would have collided every one of them.
- **`scripts/migrate-state-dir.mjs`** copies, verifies every file by SHA-256,
  and writes the pointer only if all of them match. It never moves and never
  deletes. Run on the real machine: **37/37 files byte-identical**, 2,068.6 MB
  to `%LOCALAPPDATA%\SYSCORA`. The original is still in OneDrive, untouched.
- **A 256 KB per-row cap in `SessionStore`** — transcript protected, unprotected
  fields shed largest-first, then long strings truncated, then a guaranteed
  floor. The trim is recorded IN the row and warned about: a session that
  quietly lost its evidence ledger is indistinguishable from one that never had
  one. Plus the DELETE the store never had, a `prune` that refuses to guess a
  number, `listSummaries` that does not deserialise 1,443 MB to build a menu,
  and `stats`. **Retention by count is implemented and OFF** — which
  conversations to delete is the user's call, and they chose to keep all 1,834.
- **`scripts/compact-session-store.mjs`** applied the cap to rows written before
  it existed: **1,447.0 MB → 64.8 MB**, 1,834 sessions before and after, largest
  row **396.4 MB → 0.2 MB**, and all 194 rewritten rows verified to still carry
  their id, their timestamp and the user's own question.

**The measurement, with its confounder stated.** `scripts/probe-idle-load.ps1`,
60-second samples:

```
                          before   after
  OneDrive.Sync.Service    12.3%    1.1%
  OneDrive                 11.3%    0.0%
```

Machine load, both samples: Brave playing YouTube, Chrome and Edge with Colab
notebooks, VS Code, Opera, Copilot. **The SYSCORA desktop app was open for the
"before" and closed for the "after", and neither sample can be re-taken — so
that pair is suggestive, not proof.** The "178.9%" quoted elsewhere was a
`Get-Counter` snapshot taken during activity; the honest idle figure was ~24%.

**The mechanism has no confounder, and is proven separately.**
`node scripts/probe-turn-writes.mjs` snapshots all 484 files under the synced
tree, writes a session five times through `SessionStore` exactly as a turn does,
and snapshots again: **0 files changed inside OneDrive.** Pointed at a scratch
state directory inside OneDrive it reports 1 changed file and names it — so the
check is not vacuous.

`tests/unit/state-bounds.test.js` — 14 tests, held to three injected
regressions: the cap never firing (3 fail), `prune` reporting removals it did
not perform (2 fail), the pointer file being ignored (1 fail).

**Found on the way, not fixed:** `GET /api/sessions` calls `SessionStore.list()`,
which parses every row and returns every session in full. On the real
installation that was 1,443 MB of JSON deserialised to build a menu. The cap
makes the worst case far smaller and `listSummaries()` now exists, but the
endpoint still has no limit and was left alone rather than changing the daemon's
API contract inside a different workstream.

### Found 21 Aug 2026 (W1): `npm run eval` never returned, so the gate could never have gated

The suite finished, wrote its results and its scoreboard at 13:09, and the
process was still sitting there at 0% CPU ninety minutes later.

`WindowsAutomationHostClient.close()` (`os-adapters/windows-host/src/client.js`)
was always correct — kills the child, destroys the pipes, unrefs. **Nothing on a
real path called it.** The only five callers in the tree are probe scripts; not
the daemon, not the eval runner. Two consequences:

```
  15 leaked powershell.exe, 801 MB resident, 1,162.7 CPU-seconds burned,
  the oldest 170.9 hours old — created 14 Aug.
```

And the worse one: an undead child with a live stdio pipe holds a reference in
Node's event loop, and `runner.mjs` sets `process.exitCode` rather than calling
`process.exit()`. So it printed the whole scoreboard and hung forever. **The P1
done-criterion — "`npm run eval` fails CI on a token or latency regression" —
was unreachable, and had been since the runner was written.**

This is the shape this codebase keeps producing: the machinery exists, it is
correct, and it is unreachable. Same as `autoApprove` never read on the hot path.

Fixed: `closeWindowsAutomationHost()` exported and called in the runner's
teardown beside `server.close()`. Measured — **with the fix it exits in 7.4s
with a real exit code and the host count does not move; without it the work
completes and the process hangs, killed at 75s (exit 124).**

**Not fixed:** the daemon and the desktop shell leak the same way when they
stop, which is where the 14–16 Aug hosts came from.

### Measured 21 Aug 2026 (W1): the run itself, and why it does NOT clear W0 to merge

`npm run eval -- --repeat 3 --manual` on `072789c`, 21 rows × 3 = 63 runs:
**pass rate 95% (20 of 21)**, median 248 fresh, median 5.5s, cache hit 98.7%,
$1.884, offline pipeline reached 0 times. Pass rate is unchanged against the
recorded baseline.

**But three rows breached, and all three moved the same way — roughly 2× on
steps and on tokens SENT, which is the endpoint-independent number:**

| row | baseline median sent | its own baseline spread | this run | steps |
|---|---|---|---|---|
| `app-type-into-notepad-and-save` | 97,886 | 81,846–198,205 | **368,071** | 9 → 24 |
| `skill-replay-file-write` | 19,025 | 18,972–19,286 | **29,412** | 2 → 3 |
| `draw-shape-in-paint` | 350,070 | 289,360–415,672 | **773,061** | 24 → 37 |

Every one is outside its own measured spread, and `skill-replay-file-write`'s
baseline spread is 1.7% wide. More tokens sent with more steps is the agent
taking more attempts — behavioural, not a cache artefact.

**THE MACHINE WAS NOT QUIET AND THE NUMBERS CANNOT BE ATTRIBUTED.** Measured
during the run with `scripts/probe-total-load.ps1` and
`scripts/probe-leaked-hosts.ps1`: seven browser/editor windows open (Brave on
YouTube, Chrome and Edge with Colab, VS Code, Opera, Copilot), 15 leaked
PowerShell hosts holding 801 MB, total CPU 17.1% of 16 cores. Foreground
contention is this project's most expensive documented failure mode — a click
delivered after another window takes the foreground is swallowed — and the
failing row's trace is full of it: `click✗ → click → … → windows → focus`.

So this run establishes that W0 did not break the suite, and **does not**
establish that W0 is free. **A clean re-run on a quiet machine, against the same
rows on master, is what would settle it, and it has not been done.**

### Fixed 22 Aug 2026 (W1): a third of every look was one PowerShell idiom

The brief for this session named three causes of slow perception, in order.
**The first two do not happen on the hot path, and the third was understated.**
Measured before touching anything, with `node scripts/probe-perception-breakdown.mjs`,
which wraps `screen.read` and `adapter.listWindows` and counts what one `screen`
tool call actually issues:

- **"OCR runs by default and should not."** Not on the route the agent takes.
  **0 of 18 real looks paid for capture+OCR.** The `screen` tool has asked for
  `includeOcr: false` first and fallen back to pixels only on an unusable tree
  since it was written — `tools.js:2370`. The audited 5,392ms-vs-1,195ms figure
  is the `screen.read` CAPABILITY called directly, a layer nothing on the hot
  path calls that way.
- **"WebView2 apps read the screen twice."** Only the FIRST look at a window:
  measured 2 reads on the first, 1 on all five warm ones. `state.webviewWindows`
  already memoises which sibling window holds the interface.
- **"`listWindows` costs 533ms and is called up to 3× per `screen` call."** The
  count was wrong — once per look, not three — and the cost was the real thing,
  because **96% of it was `Get-Process -Id` called once per window.**

`Get-Process -Id` reads like a lookup and is an enumeration: it walks every
process on the machine and then filters. `scripts/probe-window-list-cost.ps1`,
28 visible windows:

```
  Get-Process -Id, once per window    290.9ms
  Get-Process once, into a lookup      12.4ms
  Screen.FromHandle, once per window    1.0ms
  GetDpiForWindow, once per window      0.1ms
  the native enumeration itself         0.3ms
```

It cost far more than `window.enumerate`, because `Resolve-Window` calls
`Get-WindowList` and every host request that NAMES a window calls
`Resolve-Window` — so the N+1 was paid again inside every inspect, click, type
and focus. Four lines changed. Measured on the same desktop, 37 windows open:

| | before | after |
|---|---|---|
| `adapter.listWindows` | 405ms | **30ms** |
| one `screen` call, p50 over 18 warm looks | 1,418ms | **442ms** |
| `probe-screen-p50.mjs`, WhatsApp | 1,233ms (20 Aug) | **634ms** |
| `probe-screen-p50.mjs`, all warm reads | 1,408ms (20 Aug) | **418ms** |

**The W8 target of 1.2s is met for the first time**, at 418ms.

Fidelity is the half that matters and is checked separately by
`node scripts/probe-window-list-fidelity.mjs`, which compares every window's
process name against a `Get-Process` run in a SEPARATE powershell.exe — not the
host, not the adapter: **0 mismatches, 0 windows missing a name, bounds or DPI.**
`--break` corrupts one row and the check reports FAIL, so it is a check.
`tests/unit/live-run-regressions.test.js` pins the shape; verified by putting
the per-window call back, which fails it.

**Two things were NOT changed, because measuring them said not to.** Filling the
window's name from the UI inspection that already returned it would now save
~25ms, not the ~300ms it was worth an hour earlier; and the WebView2 first-look
double read is once per window per session, behind a working memo.

### Corrected 22 Aug 2026: the perception-cost table quotes a failed read

`audit.txt` and the session brief carry a pitch table reading "SYSCORA `screen`
— Settings ~35 tokens" against "Anthropic computer use screenshot ~1,365". The
screenshot figure is arithmetic and sound (1280×800 ÷ 750). **The 35 does not
reproduce by any route.** `node scripts/probe-one-window.mjs settings` measures
what the model is actually handed, in the same characters ÷ 4 the rest of the
project uses:

| one look | chars | ~tokens |
|---|---|---|
| Settings, read successfully | 1,066 | **267** |
| Settings, asked for as `SystemSettings` — a FAILED read | 976 | 244 |
| Notepad | 1,954 | 489 |
| WhatsApp | 4,114 | 1,029 |

So the honest claim is **~267–1,029 tokens against a screenshot's ~1,365** —
between 1.3× and 5× cheaper per observation, not 39×. The advantage that does
survive is the one that was never about the ratio: text does not accumulate in
the conversation the way images do, and what comes back is already NAMED,
clickable controls rather than pixels something still has to interpret.

**Why the failed read is 244 tokens of nothing:** there is no window whose
process is `SystemSettings`. Settings is a UWP application, so the desktop
enumerates its frame under `ApplicationFrameHost`, and `_resolveWindow` matches
on process name or title. Asked for `settings` it matches the TITLE and returns
a full 37-element tree; asked for the process name a person would get from Task
Manager it resolves nothing, pays two window enumerations and answers "the
screen could not be captured". Every UWP application — Settings, Calculator,
Photos, Store, Mail — has this shape. Not fixed: it costs a window-ownership
lookup and belongs with the WebView2 frame/content work, not inside a
speed change.

### Measured 22 Aug 2026: the flagship eval row measures the user, not the code

`npm run eval -- --repeat 3 --manual` on the change: **96% (22 of 23)**, median
**4.6s** (was 5.6s), $1.137, offline pipeline reached 0 times. Three breaches,
all `messaging-send-to-self`, and **all three runs PASSED** — the message was
sent and verified every time. What breached was cost: 30, 18 and 5 steps.

The row's cost is decided by which chat WhatsApp opens on, which is decided by
what the user last did in WhatsApp. The runner's own comment says so about the
sibling task. Held to a paired run from an IDENTICAL starting chat — the user's
most recent conversation, confirmed by reading the window between runs:

```
  master   FAIL  10 steps  27.0s  121,405 sent   message not confirmed sent
  changed  PASS  23 steps  56.9s  431,518 sent
```

**Master breaches the same ceiling from the same state and additionally fails
the task.** So the breach is not attributable to the perception change, and on
the one run that started where the recorded baseline started — the chat already
open — the changed code ran the same 5-step shape in **10.0s against the
baseline's 17.0–21.7s.**

**The gate is what is broken here.** The 8-step ceiling was recorded from runs
that all began with the target chat open, while this document already records
the row at 3 steps/15.2s with the chat open and 10 steps/46s from a different
one. **A ceiling below a row's own documented worst passing run is not a gate**
— the fifth instance of that class. Either the task's `setup` must put WhatsApp
in a known chat, or the ceiling must be re-derived from the real spread. Until
one of those happens this row fires on any run where the user touched WhatsApp
first, and cannot tell that from a regression.

### Found 22 Aug 2026, not fixed: a secret on screen reaches the model

The user moved a live model API key between devices through a WhatsApp chat. It
therefore appears in the chat list PREVIEW, so it is in the `screen` reading of
WhatsApp — 131 elements, one of which is the key — and every eval run that read
WhatsApp sent it to the model endpoint. `sanitizeExternalContext` redacts
`sk-`-shaped keys out of what the user types; nothing redacts a credential the
agent READS off a window. This is the injection boundary's mirror image: not
"what it reads must not command it", but "what it reads must not leak".

### Done 22 Aug 2026 (W3): the four things that made this a prototype

**W2 (deleting the ~14k-line offline pipeline) was SKIPPED on purpose.** It is
cleanup with real breakage risk and nothing a user would notice, against four
hardening items that are what stand between this and a product people trust
with their machine. Order was the user's call and they asked for the next big
thing without breaking anything.

**1. A credential the agent READS no longer reaches the model.** The redaction
enumerated vendor prefixes — `sk`, `gsk`, `ghp`, `github_pat`, `xox`, `AKIA` —
and a Baseten key beginning `rn37EXgy.` matched none of them, nor would the next
vendor's. The rule is now the SHAPE: an unbroken run of 28+ letters and digits
carrying upper case AND lower case AND a digit. The threshold is set by what
must SURVIVE, not by what must be caught, because over-redaction has cost this
project more (`***REDACTED_EMAIL***` typed into a login form, `%USERPROFILE%`
typed into PowerShell as a relative path). Separators end a run, so a file path
is seven short runs; all three character classes are required, so a UUID and a
git hash cannot match at any length. Known misses are stated in the comment.
Two tables plus a reachability test that builds the object the loop is actually
handed — `reasoningEngine.modelProvider` — rather than reading the source and
concluding it is wired up.

**2. The daemon has a crash path.** There were zero `uncaughtException` and zero
`unhandledRejection` handlers in the repository, in a process that renames
files, sends messages and changes system settings. A crash now writes down what
had already been done, stops the automation host, and exits non-zero; the next
start reports it in sentences and moves the record aside. **The trap:** from
Node 15 an unhandled rejection already terminates the process, so a handler that
logs and returns REMOVES the only protection there was. `a crash guard that does
not exit is worse than none` is asserted directly, and 5 of 12 tests fail when
the exit is commented out.

**3. One machine, one task at a time — on every route.** The 409 guard existed
and had two ways past it. `?sync=true` called `runtime.submitIntent` directly
and never registered in `intentRuns`, so any number of synchronous requests ran
at once against the one physical mouse; and on the async route the entry was
created by a callback the runtime invokes when it gets round to it, so two
requests arriving together could both read an empty map. Both are one bug: the
lock was DERIVED from the runtime's bookkeeping instead of TAKEN by the thing
accepting the request. Now claimed in the handler before any await, released by
identity, released in a `finally`. Four HTTP-level tests, three of which fail
against the previous code.

**4. The model keys are encrypted at rest.** They sat in plaintext beside a
DPAPI store that was already constructed and used for other things. The
demonstrated cost was not theft — a session dumped that config into a transcript
and the live key went with it. `config.json` now holds `dpapi:model-apikey.bin`
references; `scripts/protect-model-key.mjs` migrates, verifies the round trip
BEFORE deleting any plaintext, and has `--revert`. Plaintext still works, so an
unmigrated config behaves exactly as it did. Synchronous by deliberate choice:
`createRuntime` is sync in eight places including six test files, and making the
key async would be a wide change to the start path the eval and the desktop
shell depend on, to save a few hundred milliseconds once per process.

**The migration's own check caught a real defect in the migration.** The first
run reported "1 key IS STILL IN PLAINTEXT". The config held BOTH `apiKey` and
`primaryApiKey`; the script protected whichever one `loadModelConfig` prefers
and left the other in the file — and every fingerprint it printed afterwards was
correct, because they were read back through the same preference order. **A
migration that moves the value the loader happens to prefer has not moved the
secret out of the file.**

Verified after migration with `node scripts/probe-failover.mjs`: a real request
completed end to end through the encrypted credentials.

**Found while verifying, not caused by any of this: the primary model endpoint
is out of credit.** `https://api.deepseek.com` now answers `HTTP 402
Insufficient Balance` — it served the whole eval an hour earlier. The key is
still valid (402 is a billing answer, not an auth one). The product keeps
working because the Baseten fallback is healthy, which it had not been until
today. This is the first time the failover chain has had somewhere real to fail
over TO, and it is now load-bearing rather than theoretical.

### Fixed 22 Aug 2026: the session list was a 73 MB response to draw a menu

`GET /api/sessions` called `sessionStore.list()`, which parses every stored
session in full, and then `buildSessionResponse` VALIDATED each one. Measured on
the real installation, **2,234 sessions**:

```
  listSummaries()   390ms
  list()          1,238ms      response body 73.0 MB
```

**`listSummaries` had been written for exactly this problem, in the workstream
that found it, and then nothing called it** — the only callers in the tree were
its own unit tests. Ninth instance of correct machinery nothing reaches.

The default is now the summary, bounded to 200 and clamped to 1,000; `?full=true`
still returns whole sessions and is bounded too. Measured end to end against the
real store, through the running daemon:

| request | before | after |
|---|---|---|
| `GET /api/sessions` | 73.0 MB | **94,859 bytes, 163ms** |
| `GET /api/sessions?limit=5` | — | 2,653 bytes |
| `GET /api/sessions?full=true&limit=2` | — | 214,236 bytes, 892ms |

Roughly **790× smaller**. `npm run mvp:status` took the same change, with
`--full` for the old behaviour.

**Found on the way, not fixed:** `audit.sqlite` is **367 MB** and
`semantic-state.sqlite` is **370 MB** in the state directory. The 256 KB per-row
cap added in W0 protects `sessions.sqlite` (78.8 MB for 2,234 sessions) and
nothing else. `semantic-state` belongs to the offline pipeline the eval reports
reached 0 times, so 370 MB of it is worth explaining before it is capped.

### Done 28 Aug 2026: the moat was switched on, and thinking was switched off

Two findings from a full read of the product, both the same shape the project
keeps producing — correct machinery nothing reaches.

**1. NO USER COULD EVER HAVE CREATED A SKILL.** The loop emitted `SKILL_OFFERED`,
the daemon had `POST /api/skills`, `writeSkill` refused unsafe routes correctly,
and `grep -ic skill` over `apps/desktop/demo.{html,js}` returned **0 and 0**. The
only caller of the save endpoint in the entire repository was `tests/eval/runner.mjs`,
whose own comment reads *"accepting it is a separate, explicit step, because in
the product a person does that"* — and in the product there was nowhere to do it.
`.syscora/skills` on the real machine was **empty** after weeks of use. So the
feature `docs/skills.md` calls "the thing that turns SYSCORA from a demo into
infrastructure", and the plan calls "the actual moat", was unreachable, and every
0-token replay figure ever quoted came from the eval harness rather than from the
product.

Built: `apps/desktop/skill-card.js` (the offer, with the steps shown BEFORE the
yes, because that is the thing being agreed to) and a Skills panel that lists
saved routes with their clean-replay rate and deletes them — §8 and §11.
`describeSkills()` remains uncalled and is the next loose end.

**Measured end to end through the real UI and the real daemon, 28 Aug 2026:**

```
  first run    4.1s   1 tool call   24,015 tokens (15,648 fresh)
  replay       0.1s   1 tool call        0 tokens, no model call
```

**41× faster and free**, and verified against the machine rather than the screen:
the file the replay wrote was read back off disk, and the skill's stats moved to
`runs 1, cleanReplays 1`. This is the first skill ever saved by a user in this
product.

**2. THINKING WAS ON FOR EVERY STEP, AND IT WAS COSTING ACCURACY AS WELL AS TIME.**
Nothing in the repository ever sent a reasoning parameter, so the endpoint's
default applied to all 80 steps of every task. Measured against the live endpoint
with the real system prompt and the real 36-tool schema, over seven decisions
this project has actually paid for getting wrong — `node scripts/probe-model-bakeoff.mjs`,
3 repeats:

```
  deepseek-ai/DeepSeek-V4-Flash-0731   thinking ON    6/7 correct   1,576ms
  deepseek-ai/DeepSeek-V4-Flash-0731   thinking OFF   7/7 correct   1,312ms
  deepseek-ai/DeepSeek-V4-Pro-0813     thinking ON    7/7 correct   1,462ms
  zai-org/GLM-5.2-Fast                 thinking OFF   7/7 correct   2,167ms
```

Faster AND more correct, which is not the trade-off anyone expected. The case
thinking LOST was `click the Send button`: given room to deliberate it talked
itself into re-reading a screen it had just read — the same behaviour the output
ceiling measurement found, where more room produced more ATTEMPTS rather than
better ones.

So thinking is off for an ordinary step and back on for a turn that has already
been cut off or arrived malformed — the identical shape to
`MODEL_OUTPUT_CEILING_RETRY`, for the identical reason. `SYSCORA_MODEL_THINKING=
always|never` overrides. One live request, `which windows are open right now`:
**12.2s → 8.9s**, output tokens 471 → 290. (The two runs had different cache
states, so read the latency, not the token totals.)

Held by `tests/unit/model-thinking.test.js`, which asserts on the REQUEST BODY
rather than on the constant — and was proven able to fail by deleting the
forwarding, which fails 5 of its 6 tests. **The first version of the wiring did
not work**: `sendChatOnce` accepted `extraBody` and `openAiCompatibleChat`, which
destructures its options explicitly and builds `attemptOptions` by hand, dropped
it on the floor. The test caught it because it reads the body.

**3. The failure-learning loop works, and had simply never been exercised.**
`recordAdaptivePattern` / `retrieveAdaptiveGuidance` are wired through
`agent-runtime` and the memory database held **0** of them. Exercised on purpose
with a request that must fail — `open the application called zzzqqqfakeapp` — it
recorded `zzzqqqfakeapp: launch / unavailable; recovery none verified` with
counts and a confidence, and retrieval returns it for a related request and
**stays silent for `open spotify` and `play some music`**. That silence is the
half worth keeping: a memory that fires on everything is one that gets switched
off.

**Configuration, same day.** One provider, no fallback: `fallbackProviderConfigs`,
`fallbackProviders`, `apiKeys` and the duplicate `apiKey` removed from
`config.json`; the key replaced and DPAPI-encrypted via
`scripts/protect-model-key.mjs`, verified through the daemon's own loader
(`credentialStatus: protected`, 0 fallbacks). `FailoverModelProvider` is left in
the tree because five scripts and four test files use it and it is inert with one
provider configured — deleting it is a cleanup session, not a side quest.

**Found and not fixed: six config backups in the state directory still hold
plaintext keys** (`config.json.bak`, three `bak-2026-08-22*`, `gemini-backup`,
`kimi-backup`). They are the user's files and some are revert points, so they
were left alone and reported rather than deleted.

### Done 3 Sep 2026: the GUI told the model to do something the prompt forbade, and code was unreadable past line 150

Five defects, from one live music request and one audit. Four of them are the
same shape the project keeps producing — the machinery is correct and something
above it makes it unreachable.

**1. THE REFUSAL AND THE SYSTEM PROMPT CONTRADICTED EACH OTHER, AND THE PROMPT WON.**

A live request, `play apsara ali in spotify`: **7 steps, 31.4s, 102,528 tokens**
for one song. Two of those steps were the identical call `click {text: "Play"}`,
refused both times for ambiguity, followed by a fall back to raw coordinates.

The disambiguation was already doing the right thing. It has said
`Call ONE of these exactly: click {element: 64}` since 28 Aug, when this exact
Spotify loop was first measured, and it names what sits beside each candidate so
the choice can be made. **The system prompt said, of clicking:
`never an index or a coordinate you made up`.** So the model was handed the exact
call to copy and simultaneously told never to make that call — and it obeyed the
prompt, which is the stronger instruction, and went to coordinates instead.

Nothing was wrong with the refusal, the ranker, or the click. The fix is one
paragraph in the prompt naming the disambiguation as the one case where an index
is exact rather than guessed. **This is the general lesson and it is not about
Spotify:** every tool that teaches a recovery in its failure text is competing
with the system prompt, and when the two disagree the prompt wins silently.

**2. `play_music` gave the only attempt that can work 3.5s of a 6s budget.**

`_invokeSpotifyPlayButton` has three attempts; the third — a bare `Play`
DataItem NEAR the requested title — is the shape Spotify actually publishes for
a top result. Measured with `node scripts/probe-spotify-play.mjs "Apsara Ali"`:

```
  attempt 1  semantic, controlType=Button    713ms   no match
  attempt 2  semantic, controlType=null      146ms   no match
  attempt 3  waitForUiTarget, cap 3500ms   1,042ms   MATCHED, track played
```

Warm, it matches in a second. The failing run was a COLD search: Spotify had
just been launched and the results had not been published to the tree before the
cap expired. The budget is now 9,000ms and attempt 3 gets whatever is left of it
(~8s) rather than an arbitrary 3.5s slice. **The asymmetry decides the number:**
three more seconds inside a call that already spends nine, against the six extra
steps and ~60,000 fresh tokens the fallback actually cost.

**NOT VERIFIED END TO END, AND THIS IS WHY.** Two cold runs after the change
disagreed: one matched in 955ms with the raised timeout visible in the trace
(`timeoutMs=8187`) but reported `nowPlaying` as a DIFFERENT track — Spotify
cold-launches and auto-resumes its previous queue — and the next found nothing
in 6.2s. Spotify then exited and stopped appearing in the window list at all, so
the measurement could not be repeated. **The budget change is measured as taking
effect and the unit tests pass (30/30); the cold path remains flaky and is not
fixed by a budget alone.** The honesty layer holds throughout: `matchesTrackQuery`
compares the live window title against the request, so the wrong-track run
reported REFUTED rather than claiming success. The geometry was checked and
cleared — `dy <= sameRowTolerance AND dx <= maxDistance` is enforced in
`restore-host.ps1`, so the transport's own Play button 800px away cannot be
mistaken for a row's.

**3. A SOURCE FILE WAS UNREADABLE PAST ITS FIRST ~150 LINES.**

`read_file` returned the whole file through `clip`, which cuts at 6,000
characters and says only `[N more characters]`. **There was no argument that
could reach line 200.** So on any real repository the agent could read the top of
a file and nothing else, and `search_code` reporting the interesting line as
6,326 was useless because nothing could then go and look at 6,326.

It now takes `offset`/`limit`, defaults to 400 lines, numbers every line
(`6326\tname: "edit_file",`) and — the half that matters — **names the exact call
that fetches the rest**: `read_file {path: "…", offset: 401}`. A truncated read
that does not say how to continue is one the model treats as the whole file.

The numbering has a mirror-image failure, and it is handled where it is read
rather than where it is caused: an anchor copied out of a numbered window carries
prefixes that are in no file, so `edit_file` now detects that shape on the anchor
itself and says so, instead of reporting a wrong snippet. The first version put
the warning at the end of every read — ~25 tokens on every read of every file for
a whole session — which is the house rule about lessons belonging in the failure,
got wrong and then corrected.

**4. `git` — the agent could not see what it had just changed.**

`github` reads repositories on github.com. **Nothing read the one on this disk.**
So after editing four files the agent could not produce a diff, could not say
what was uncommitted, and could not review its own work; the only route was
`run`, and the terminal is OFF by default.

New `git` tool, read-only by design: `status`, `diff`, `log`, `branch`, `show`.
No commit, no push, no checkout, no reset — those are irreversible or they move
work the user has not finished, and this codebase already draws that line once
(the agent drafts, a person sends). The action picks a fixed string from a table;
the only caller-supplied fragment is a path, refused by shape if it could end the
command, and the composed line still goes through the shell floor.

**And it needed a new origin at the spawn boundary, which is a safety decision
rather than a detail.** `project`'s comment claims it "does not need Developer
terminal access"; it passes `shellOrigin: "model"`, which the adapter refuses
unless `developerMode === true`, so **that claim has never been true** — measured
here, `project {action: "lint"}` on a default install does not run. `git` uses
`shellOrigin: "readonly-verb"`, and the adapter **re-derives read-only from the
floor instead of believing the label**: the command must independently classify
`ALLOW`. So the label cannot be borrowed. Held by
`tests/unit/git-tool.test.js`, and **proven able to fail** — changing the gate to
trust the label makes `git push`, `git reset --hard`, `npm run lint` and
`Remove-Item -Recurse` all run, and the test goes red.

**`project` was deliberately NOT given the same treatment.** `npm test` runs
whatever the repository's manifest says, which is arbitrary code with the user's
permissions — finite and enumerable, but not read-only. **That it cannot run on a
default install is now a known, stated gap rather than a false claim in a
comment**, and widening it is a decision for whoever owns the security model, not
a side effect of adding a git verb.

**5. The honesty backstop could not see the passive voice.**

`claimsWithoutEvidence` is the last line — it runs only on a turn that called
ZERO tools. Every pattern in it was anchored on the first person or on a verb
plus an object. Probed against the live export:

```
  CAUGHT  "Done — volume is now 20%."     MISSED  "The file has been created."
  CAUGHT  "The app was closed."           MISSED  "The volume has been set to 20%."
  CAUGHT  "Node v22.14.0 is installed."   MISSED  "Your file is saved."
```

The right column is the left column with the agent taken out of the sentence —
and the passive is what a model reaches for when it is being careful, which is
the turn where it has done nothing. Anchored on a DEFINITE subject, because that
is what separates a claim from a definition: "A pull request is opened by pushing
a branch" is somebody being told how GitHub works, and nudging it costs a step.
`tests/unit/evidence-claims.test.js` holds both halves — 15 claims that must be
caught, 11 ordinary sentences that must not.

Found on the way: the verb list was written out three times and the copies had
**already drifted** — `renamed it` was uncaught while `I renamed it` was caught.
One shared list now, with a test that checks each verb in all three arrangements.

**6. The eval had no coding row at all.** 22 tasks, none of which exercised
`search_code`, `find_files` or `project`. The capability being compared to
dedicated coding tools was measured by nothing. Two rows added — `code-find-and-fix`
(a bug the prompt does not locate: search, read, edit one line, run the project's
own tests) and `code-read-long-file` (a marker at line 700 of 900, unreachable
by the old read). Both fixtures were built and checked by hand: the first FAILS
before the fix and PASSES after, and the second's marker really is at line 700.
`code-find-and-fix` asserts the TEST FILE is unchanged, because "fix the failing
test" has an obvious wrong solution. **Not run — the suite needs a quiet machine
and a full baseline, and neither was available.**

**Cost of all of this:** the fixed prefix went 10,501 → **11,157 tokens/step**
(+656: three prompt rules and the `git` schema). Inside the cached prefix, so
~66 fresh-token-equivalents per step after the first — against the six steps and
~60,000 tokens one music request paid. **But the system prompt is now 4,392
tokens and about seventy-five directives, and nothing has ever measured whether
any given section still earns its place.** `scripts/probe-model-bakeoff.mjs` is
the tool for that and has never been pointed at prompt sections.

`npm test`: **1,659 tests, 1,657 pass, 0 fail, 2 skipped** (was 1,648 / 1,646).

### Fixed 3 Sep 2026: it could not write a second file, and it reported the job done

**A user asked for a folder and a three-file web app. It wrote `index.html`, said
"Now the CSS:" and called nothing — three times across three requests, ~215
seconds and ~218,000 tokens, and `style.css` never existed.** Asked twice why it
had stopped, it apologised, re-read the HTML it had already written, said "Let me
write both files now", and called nothing again.

Reproduced end to end on a scratch folder: **the run settled `COMPLETED`** — a
green tick — on the sentence *"Now the CSS — this is where the beauty comes in."*
with one of three files on disk. The user's runs got `PARTIALLY_COMPLETED`; the
difference is only whether `looksUnfinished` happens to match the last sentence.

**THE LOOP'S HANDLING WAS CORRECT AND WAS NOT THE BUG.** The nudge, the wrap-up
ask and the settle all did exactly what they say. Nothing above the model can fix
a turn the model was never allowed to make.

**The cause is the output ceiling, and the endpoint lies about hitting it.** A
stylesheet for that page is ~14 KB, which is ~5,000 output tokens in one
`write_file` call — above `MODEL_OUTPUT_CEILING`, which was 4,096. Measured
directly against the configured endpoint, streaming, the shape the loop uses:

```
  max_tokens  4,096   21-31s, [DONE], finish_reason NULL, usage 1 token,
                      no tool call, no text.  The turn is thrown away silently.
  max_tokens 16,384   finish_reason "tool_calls", 5,020 tokens,
                      write_file carrying 14,647 bytes of CSS.  It works.
```

Non-streaming, the same ceiling answers **HTTP 500, 4/4**. Neither shape ever says
`length`, so `wasTruncated` — which matches `length|max_tokens` — **cannot fire**,
the retry-with-more-room path is unreachable, and the loop reads "no tool calls"
as the model having finished. Every request needing a file over ~11 KB lost the
turn, burned 20–30 seconds, and reported success.

**This is the tenth instance of the class this project keeps producing: the
machinery is correct and something above it makes it unreachable.** The truncation
retry was written for exactly this event and had never once run on it.

**Two fixes, because one of them does not scale.**

**1. `MODEL_OUTPUT_CEILING` 4,096 → 8,192.** The comment on that constant said
`DO NOT RAISE THIS ONE`, and it was right about what it measured: on 21 Aug a
global 16,384 dropped the eval 100% → 91% because *reasoning* expanded to fill the
room. **Thinking has been off by default since 28 Aug and this endpoint really
does return `reasoning_tokens: 0`, so that mechanism cannot operate** — which is
an argument, so it was measured. `node scripts/probe-output-ceiling.mjs
--repeat 3`, thinking off, streaming, median output tokens:

| decision | 4,096 | 8,192 | 16,384 |
|---|---|---|---|
| `needs-room` (write the stylesheet) | **1t · 0/3, 2 DISCARDED** | 4,981t · 3/3 | 5,018t · 3/3 |
| `click-by-label` | 106t · 3/3 | 105t · 3/3 | 108t · 3/3 |
| `draw-a-shape` — **the row that regressed** | 120t | 119t | 121t |
| `installed-question` | 94t · 3/3 | 95t · 3/3 | 95t · 3/3 |
| `arithmetic` (must call NO tool) | 9t · 2/3 | 9t · 2/3 | **92t · 0/3** |

Every ordinary decision is **flat to within 2%** across a 4× range of room,
`draw-a-shape` included. **8,192 and not 16,384 because of the last row**: at
16,384 the arithmetic case stopped answering without a tool. n=3 is thin and it is
the same "more room, more attempts" shape the original warning names, so it is
taken at face value rather than explained away. 8,192 is the smallest ceiling
measured to fit a real file write and the largest measured to change nothing else.

**2. `wasDiscarded()` — because a bigger number is not a fix.** A 30 KB file will
not fit in 8,192 either, and the next endpoint will lie in its own way. So the
detection is anchored on **what arrived**, never on what the provider says about
itself — the house rule about verification not sharing a code path with the thing
it verifies, applied to the provider. A turn with no `finishReason`, no tool calls
and no text consumed real time and delivered nothing; it is retried once with the
bigger ceiling, and on a second failure the run settles `PARTIALLY_COMPLETED` and
**tells the user the recovery they can act on** — write the file in parts with
`write_file {existing: "append"}`. It shares `retriedTruncatedTurn` deliberately:
a run does not get one free retry per failure *name* for what is one failure.

**Measured after the fix, same request, same folder, clean:** 30 steps, 182s,
166,997 fresh tokens — **`index.html` 8,103 B, `style.css` 18,027 B, `app.js`
13,153 B, all three on disk.** Verified independently of the agent's own report,
by serving the folder and driving the page: 12 product cards render, Add-to-cart
moves the badge 0 → 2 and persists the right item and price to `localStorage`, the
Audio filter narrows 12 → 3, and the console is clean.

Four tests in `tests/unit/fast-agent.test.js`, **proven able to fail**: neutering
`wasDiscarded` turns 3 of them red. The ceiling test now pins a *band* — at least
5,000 so a real file fits, at most 8,192 so the arithmetic row is not disturbed —
rather than the bare number, because the number without its bounds is what got
raised wrongly last time.

`scripts/probe-multifile-stall.mjs` is kept even though it never reproduced the
stall: it is what ruled out the prompt and the conversation shape, and re-testing
those is the expensive way to learn it twice.

`npm test`: **1,663 tests, 1,661 pass, 0 fail, 2 skipped** (was 1,659 / 1,657).

### Still open

- **`project` cannot run on a default install.** Its own comment says it "does
  not need Developer terminal access"; it passes `shellOrigin: "model"`, which
  the adapter refuses unless `developerMode === true`. Measured 3 Sep 2026. So
  the edit-run-read loop — the thing that makes a coding assistant trustworthy —
  is behind the most dangerous switch in the product. `git` was fixed with a
  read-only origin; `project` cannot use it, because `npm test` runs whatever the
  manifest says. **The options are: leave it (a coding user turns the switch on),
  or give manifest commands their own approval path that does not imply arbitrary
  terminal access. This is a security-model decision and has not been made.**
- **The cold Spotify path is still flaky.** The attempt budget was raised and
  measured as taking effect, but two cold runs after the change disagreed — one
  played the previous queue's track (reported REFUTED, correctly), one found
  nothing. `node scripts/probe-spotify-play.mjs` is how to see it. What is not
  yet understood is what Spotify does to its own tree in the seconds after a cold
  launch, and no budget change fixes that.
- **The system prompt has never been ablated.** 4,392 tokens, ~75 directives,
  every one of them added because of a specific observed defect and none of them
  ever measured for whether it still earns its place. Adding a rule is cheap and
  reversible; nobody has checked whether the twentieth "NEVER" weakens the first.
- **The eval has not been run since 22 Aug**, and the scoreboard on disk is a
  partial 1-row run. Roughly 2,250 uncommitted lines predate this session and
  ~1,000 more were added in it, none of it measured against the gate.
- **The Baseten account is out of credit** (`HTTP 402: please check your current
  payment status`). The primary is the DeepSeek endpoint directly, with Baseten
  kept as the fallback entry so the chain is real, but there is nothing healthy
  to fail over TO. `node scripts/probe-failover.mjs` reports the machinery and
  the billing separately and says which is missing.
- **There is still no second VENDOR.** Two endpoints serving the same DeepSeek
  family survive an endpoint outage, not a bad model release.
- **The leaked `primaryApiKey` still needs rotating by the user.**
- ~~**A declined irreversible action still settles COMPLETED.**~~ **Fixed, and
  this entry was stale.** Checked end to end on 22 Aug 2026: the loop settles
  `DECLINED` keyed on the `refusedByUser` RECEIPT rather than on the model's
  words (`fast-agent/src/index.js`), `agent-runtime` maps it onto a COMPLETED
  runtime state on purpose — a user saying no is a run that ended properly,
  nothing went wrong and nothing should be coloured red — and `apps/desktop/demo.js`
  renders it. No skill is offered from a declined run, which is right: a route
  whose irreversible step was refused is exactly the one that must not be
  replayed for free.

- ~~**`keyboard.press` types the key's NAME and reports success.**~~ **Fixed 22
  Aug 2026.** SendKeys types anything that is not its own notation literally, so
  `keys: "enter"` with no `chord` typed e-n-t-e-r and returned
  `performed: true` — a WhatsApp box left holding `syscora-undo-mt409iu6enter`
  with nothing sent. `WindowsAdapter.keyboardAction` translates the name into a
  chord, so this only ever bit a caller reaching the host directly; the host now
  refuses anyway, because it must be honest about what it did whoever asked.
  The guard is the shape — one character is a real keystroke, notation is a
  brace group anywhere or a modifier AT THE START — and that last clause is the
  whole subtlety: `+` is both SendKeys' shift modifier and how people spell a
  combination, so a first version testing for a modifier anywhere let `ctrl+s`
  through, which SendKeys delivers as `ctrlS`. **Caught by the probe, not by
  reasoning.** `node scripts/probe-key-refusal.mjs` drives the real host against
  its own scratch Notepad and reads the document back: 6 of 6 cases correct, and
  the single-character case shows the document CHANGING, which is what proves
  the check is not vacuous.

## What this is

An agent that operates this Windows machine from natural language — the shape of
an agentic coding assistant, pointed at the whole OS. Chat in, real actions out, verified against the
machine. The goal is a product people trust with their computer: **fast, cheap,
and incapable of claiming something it did not do.**

## Where it actually is

A strong prototype with a genuinely good perception layer and an honest action
layer. Not yet a production system. The gap is specific and measured below.

### Measured, 16–17 Aug 2026, real machine, real model (DeepSeek via Baseten)

**These are single hand-runs and several of them are now known to be wrong.**
Read the scoreboard section above instead; this table is kept because the
production plan refers to it, not because it should be quoted.

| task | steps | time | tokens | outcome |
|---|---|---|---|---|
| ~~WhatsApp send (flagship)~~ | ~~6~~ | ~~35s~~ | ~~62,417~~ | **see the correction below** |
| WhatsApp send, 16 Aug baseline | 66 | 309s | 1,160,162 | needed manual coordinate click |
| read last 2 messages | 6 | 23s | 67,768 | correct |
| `is python installed?` | 2 | 41s | 19,257 | correct, slow |
| disk space / top RAM | 2 | ~6s | ~18,300 | correct |
| play a song on Spotify | 5–7 | 27–47s | 54k–77k | correct, needs a click fallback |
| draw a train in Paint | 37–54 | 227–365s | 514k–894k SENT | **the units are tokens SENT — see the 21 Aug correction; billed was a fiftieth of this** |

#### The flagship row was wrong, and the way it was wrong is the lesson

"6 steps, 35s, 62,417 tokens, sent, confirmed in-conversation" came from a
`probe-fast-agent.mjs --approve` run — a probe that ANSWERS the approval card.
Nothing unattended could reproduce it, and the eval task that should have caught
that verified with `Write-Output 'checked-by-human'` and passed unconditionally.
So the number was true of one attended run and false of the product, and it sat
at the top of this document for two days being planned around.

Measured 19 Aug 2026 with an honest check that counts the message text in the
conversation over the raw UIA tree, in its own process:

| | pass | time | steps | fresh tokens |
|---|---|---|---|---|
| before | **0 of 3** | 136.7s · 137.0s · 149.9s | 4–5 | 1,751–3,915 |
| after | **3 of 3** | 28.0s · 34.9s · 28.7s | 5–7 | 3,270–3,817 |

**The cause was not the click, and not a regression.** `autoApprove` — the
caller's standing authorization — has never been read on the fast-agent path, in
any commit, since `d91fd43` first put an approval gate there. The staged pipeline
honoured it; the route every real request takes did not. So the card went to
nobody and the 120s timeout read the silence as a refusal, which is the correct
reading of silence. `probe-fast-agent.mjs` on the send, before the fix:

```
[ 25470ms] APPROVAL ASKED: send this message
      rule: send-message — it cannot be unsent once it arrives
[145470ms] APPROVAL_RESOLVED          <- exactly APPROVAL_TIMEOUT_MS later
[145471ms] x batch (123706ms)
```

The agent's own behaviour through all of this was right — it reported the draft
unsent, named the chat, and refused to retry by another route. **That is what
disguised it:** an honest report of a plumbing failure reads like a broken click,
which is why the brief for this session named five click defects and the answer
was none of them. Diagnose before fixing.

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
   and a warning. `maxTokens` 2,048 → 4,096.

   **"A ceiling is not a cost" used to be written here as a general licence, and
   it is wrong.** It is true about the invoice — the provider bills what it
   generates — and false about behaviour. Raising the per-turn ceiling to 16,384
   for every turn, to fix a drawing request that was truncating, was measured
   over a full 69-run eval on 21 Aug 2026: pass rate 100% → 91%, six budget
   breaches, `draw-shape-in-paint` 3/3 → 1/3 at 3× the tokens and 2× the steps.
   Given more room a reasoning model thinks longer and then ATTEMPTS MORE — it
   elaborated instead of drawing one circle and ran out of time before saving.
   The ceiling now stays at the baseline 4,096 and the extra room goes only to a
   turn that has ALREADY been cut off (`MODEL_OUTPUT_CEILING_RETRY` 16,384).

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
- ~~**Research tasks cost a fortune and do not finish.**~~ Fixed 29 Aug. The
  cause was not search, which is fast and cheap: a live request for fifteen
  internships issued twenty searches ONE AT A TIME across eighteen steps, spent
  154,590 fresh tokens and hit the ceiling with nothing to show. Only ~14,000 of
  those tokens were results. **The step is the expensive unit, not the request:**
  `scripts/probe-prompt-cache.mjs` shows this endpoint caches prefixes in
  8,192-token blocks, so every round trip re-buys its incomplete tail block —
  about 4,000 billed tokens — before it fetches anything at all.
  So `search` now takes `queries` (up to 8, run 4-wide) and `web_open` takes
  `urls` (up to 6, fetched at once). Measured on identical data, eight searches:
  8 steps → 1, 38,332 → 9,674 billed tokens (**4.0x**), 7.8s → 2.4s.
  Four-wide is a measurement, not a guess: DuckDuckGo enforces a rolling budget
  and starts answering 202 once it is spent, and it is the best of the three
  indexes, so losing it collapses the consensus the ranker is built on. At 4-wide
  7 of 8 queries kept all three indexes.
- ~~**A page arrives as furniture wrapped around the answer.**~~ Fixed 29 Aug.
  `web_open` takes `find`, and returns the lines and links that match it instead
  of 2,500 characters from the top plus sixty links in document order.
  `bestPassages` had been written for exactly this on 23 Aug and was never called
  by anything. Measured on three real careers pages: **3,907 → 1,018 tokens,
  3 steps → 1, 4.2s → 1.1s** — and the focused read surfaced
  `amazon.jobs/applicant/jobs/3116030/apply` and Microsoft's "Yes, Microsoft
  provides visa sponsorship", both of which the blind read had buried.
- **The domain-authority ranking signal is worse, and is now measured as worse.**
  It shipped dark on 29 Aug with a note saying two queries suggested it helped.
  `node scripts/bench-rank.mjs` fetches one candidate pool and A/Bs rankings
  against it offline — which is what every previous attempt got wrong, because
  refetching between arms measures DuckDuckGo's rate limit rather than the
  ranking. Over all fourteen benchmark queries: hit@1 79% → 71%, MRR
  0.869 → 0.833, one query moved and it moved the wrong way. It stays off.
- ~~**One provider, no failover.**~~ Two endpoints are configured from 19 Aug —
  `model.fallbackProviderConfigs` in `.syscora/config.json`. The code was always
  there; the gap was ten lines of JSON. `node scripts/probe-failover.mjs` proves
  it by pointing the primary at a dead port and checking a real request finishes
  anyway, naming the endpoint that served it from `FailoverModelProvider`'s own
  receipt rather than inferring it from success.
  **Caveat: both endpoints serve the same model family and one of them has no
  credit left.** That is resilience against an endpoint, not against a vendor.
- ~~**Drawing is a demo, not a capability.** 54 steps, 894k tokens, incomplete.~~
  **Wrong, corrected 21 Aug 2026: 894k was tokens SENT.** The eval row measures
  23 steps median and 7,912 fresh tokens billed, and the circle is on the canvas
  by step 6 in one `draw` call. What costs is Paint's Save-As dialog after it.
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
