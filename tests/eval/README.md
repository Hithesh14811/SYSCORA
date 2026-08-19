# The eval harness

What SYSCORA can actually do, how often, how fast, and what it costs — measured
against this machine rather than asserted.

Everything else is guesswork without it. "It feels faster" is not a number, and
the failures that matter most are the ones where the agent reports success: a
message that was never sent, a version number it invented, a song search that
worked but spent 803,000 tokens getting there.

```bash
npm run eval                 # the automatic tasks, against the real model and this machine
npm run eval -- --manual     # …and the four that touch volume, WhatsApp and the webview
npm run eval -- --only messaging-send-to-self
npm run eval -- --category files
npm run eval -- --repeat 3   # three runs each — this is the honest way to run it
npm run eval -- --mock       # harness self-test: no model, no cost
```

Results land in `tests/eval/results/<timestamp>.json` and the human-readable
`tests/eval/scoreboard.md`.

`--mock` exercises the plumbing, not the agent: the Mock provider cannot answer
an arithmetic question or find a file, so most tasks fail. It proves the runner
loads, expands, runs, verifies, aggregates and gates. It is not a pass rate.

## One run is not a measurement

The same request has measured 29,759 and 122,000 fresh tokens on the same code on
the same day, decided by which chat WhatsApp happened to open on. At that spread
a single run cannot tell a 30% improvement from luck.

So every task is repeated and reported as a **median with the spread beside it**,
and a task counts as passing only when **every** repeat passed — a flake is a
defect that has not been diagnosed yet, and grading it green is how it stays
undiagnosed. Use `--repeat 3` for anything you intend to believe.

## Budgets: what makes this a gate rather than a report

A change that makes a task pass while doubling what it costs is a regression, and
the scoreboard used to show that as two green ticks.

```bash
npm run eval -- --repeat 3 --manual --write-budgets   # record a baseline
npm run eval -- --repeat 3 --manual                   # hold a change to it
```

`--write-budgets` records each task's measured median × `--slack` (default 1.4)
into `tests/eval/budgets.json`, along with the baseline it came from. Later runs
breach a budget when **their median** exceeds that ceiling, so one unlucky run
cannot fail the build. A task that passed at baseline and no longer does is a
breach too. Any breach exits non-zero.

Budgets are **recorded, never hand-written** — a hand-picked ceiling is an
opinion, and the point of this file is to hold opinions to a measurement. A
partial run (`--only`, `--category`) refuses to write them: a baseline is the
whole suite or it is not a baseline.

Costs are quoted as **fresh** tokens. The endpoint serves ~96.6% of the fixed
prompt prefix from its cache at roughly a tenth of the price, so `tokensIn` is
bandwidth and `tokensFresh` is money.

## The one rule

**`verify` must check the world, not the agent's claim.**

Every verification runs its own PowerShell against the machine, by a different
route than the agent used. If the agent says it created a file, we `Test-Path`
it. If it says a track is playing, we read the Spotify window title from the
process list. The agent never grades its own homework — half the failures found
by hand so far were exactly that.

A task whose outcome cannot be checked independently does not belong here. Write
a different task.

**And a check that cannot fail is worse than no check, because it is believed.**
`messaging-send-to-self` — the highest-stakes task in the suite — shipped with
`verify: Write-Output 'checked-by-human'` and passed unconditionally for months.
`system-set-volume` had the opposite defect: it called `Get-AudioDevice`, from a
module not installed on this machine, so it printed `unreadable` and could never
pass however well the agent did. Both were found on 19 Aug 2026 by running them
and reading the output. Before you trust a green row, make the thing fail on
purpose once.

Watch for the check that is **already satisfied before the agent starts**, too.
The volume task asks for 42%, and the machine was sitting at 42% from the
previous run — so it would have passed with the agent doing nothing at all. Its
setup now moves the volume away first.

Helper scripts live in `fixtures/` and are reachable from any task string as
`{fixtures}/name.ps1`, alongside `{workspace}`.

## Safety

These run for real, on your machine, unattended. So:

- All file work happens under `.syscora/eval-workspace/`, created and emptied by
  the runner. Nothing outside it is written or deleted.
- No task sends a message to another human. Messaging is exercised against your
  own "message yourself" chat, and is marked `manual` so it only runs when you
  ask for it.
- No task installs, uninstalls, or changes a system setting that is not restored
  by its own `teardown`.
- **A teardown closes what its own task opened, and nothing else.** The Notepad
  task used to end with `Get-Process notepad | Stop-Process -Force`, which on
  15 Aug 2026 force-killed a Notepad the user had open with unsaved work in it.
  Record the pids in `setup` and kill only the new ones. These run unattended:
  assume every application on the machine belongs to somebody.

## Windows paths in task JSON

Write `{workspace}\\file.txt`, **never** `{workspace}\file.txt`. JSON reads
`\t` as a tab and `\r` as a carriage return, so a single backslash silently
turns the path into something that cannot exist — in the prompt the agent is
given *and* in the verify that checks it. Three of fourteen tasks were failing
this way, including the headline GUI task at 213,000 tokens, with the agent
doing the work correctly every time. `loadTasks` now refuses any task string
containing a control character.

If you add a task that breaks one of those rules, it will eventually run at 3am
while you are not watching.

## Task format

```json
{
  "id": "files-create-and-read",
  "category": "files",
  "prompt": "Create a folder called notes in my eval workspace and put a file inside it saying hello",
  "timeoutMs": 120000,
  "setup":    [],
  "verify":   [{ "run": "Test-Path '{workspace}\\notes\\*.txt'", "expect": "True" }],
  "teardown": [],
  "manual":   false
}
```

- `{workspace}` expands to the eval workspace path in prompts and scripts.
- `verify` entries pass when the command's trimmed stdout **contains** `expect`
  (case-insensitive). Use `expectNot` for the opposite.
- Every `verify` entry must pass for the task to pass.
- `manual: true` keeps a task out of the default run.

## What the numbers mean

| column | why it matters |
|---|---|
| pass | the only one that matters first — a fast wrong answer is worthless |
| tokens | your unit economics. 800k on one song is not a business |
| seconds | your product promise |
| steps | how much the loop flailed; the tell for a broken subsystem |
| cost | tokens × the configured rate, so it is comparable across models |
