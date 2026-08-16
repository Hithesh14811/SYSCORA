# The eval harness

What SYSCORA can actually do, how often, how fast, and what it costs — measured
against this machine rather than asserted.

Everything else is guesswork without it. "It feels faster" is not a number, and
the failures that matter most are the ones where the agent reports success: a
message that was never sent, a version number it invented, a song search that
worked but spent 803,000 tokens getting there.

```bash
npm run eval                 # every task, against the real model and this machine
npm run eval -- --only spotify-play-track
npm run eval -- --category files
npm run eval -- --repeat 3   # three runs each, to see variance
npm run eval -- --mock       # harness self-test: no model, no machine, no cost
```

Results land in `tests/eval/results/<timestamp>.json` and the human-readable
`tests/eval/scoreboard.md`.

## The one rule

**`verify` must check the world, not the agent's claim.**

Every verification runs its own PowerShell against the machine, by a different
route than the agent used. If the agent says it created a file, we `Test-Path`
it. If it says a track is playing, we read the Spotify window title from the
process list. The agent never grades its own homework — half the failures found
by hand so far were exactly that.

A task whose outcome cannot be checked independently does not belong here. Write
a different task.

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
