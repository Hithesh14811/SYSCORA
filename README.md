# SYSCORA

[![CI](https://github.com/Hithesh14811/SYSCORA/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Hithesh14811/SYSCORA/actions/workflows/ci.yml)

An AI agent that runs your Windows PC from plain English, and doesn't lie
about what it did.

You type something like "make a folder called notes on my desktop and put a
todo list in it" or "send hi to myself on WhatsApp", and SYSCORA actually does
it: clicks, types, opens apps, edits files, drives a browser. Think Claude Code,
but pointed at the whole operating system instead of one repo.

## The problem I kept running into

Computer-use agents fail quietly. Early on, mine would happily tell me
"Sent." while the message was still sitting in WhatsApp's search box, or say
"Muted." while the music kept playing. The click went through, the tool
returned OK, and the agent believed itself.

So the core idea here is simple: **the agent isn't allowed to say something
worked unless it actually checked.**

Every tool result carries a small typed receipt: what was observed, which
part of the system read the machine back, which part did the action, and a
verdict. The success message ("Sent.", "Saved notes.md") can only be built from
a receipt that says `CONFIRMED`, and a receipt is rejected if the thing that
checked is the same thing that acted. There's a third verdict, `UNCONFIRMED`,
for "nobody could look", because that's not the same as "it failed".

The code for that lives in
[`packages/fast-agent/src/evidence.js`](packages/fast-agent/src/evidence.js),
and [`tests/unit/tool-evidence.test.js`](tests/unit/tool-evidence.test.js)
fails the build if any tool is added without one.

## Does it work?

I built an eval harness that runs real tasks on a real machine and then checks
the machine itself (the file on disk, the volume level, the message in the chat),
never the agent's own answer. Each task runs 3 times and only counts as a pass
if all 3 pass.

Latest run (3 Oct 2026, 25 tasks × 3 = 75 runs):

| | |
|---|---|
| Pass rate | **96%** (24 of 25 tasks passed every repeat) |
| Median time per task | 4.7s |
| Median steps | 3 |
| Cost of the whole suite | about $1.82 |

The one that isn't solid yet is the WhatsApp send (2 out of 3). The full table,
with spreads and the failure reason, is in
[`tests/eval/scoreboard.md`](tests/eval/scoreboard.md). How the harness works is
in [`tests/eval/README.md`](tests/eval/README.md).

I also tested the receipt idea directly by injecting fake failures under 18 of
the tools (clicks that land nowhere, writes that silently do nothing, etc.).
Without the receipts, the agent would have told the user "done" in 24.5% of
those broken cases. With them, zero.

## What it can do

- **See the screen** mostly through Windows accessibility (UIA) data, falling
  back to OCR, and only to screenshots when text can't see the thing. That's
  cheaper and more predictable than pixels-only, though it's not perfect.
- **Use apps**: click by label, type, scroll, drag, draw, open/close/focus
  windows, set the volume.
- **Work with files and code**: find, read, create and edit files, search a
  codebase, read .docx, run git.
- **Browse** in its own Chromium over CDP, or read pages over plain HTTP when
  that's enough.
- **Draft Gmail emails**, but never send them. You press Send. That's on
  purpose: the Send button is where a prompt injection would want to end up.
- **Replay skills**: once a task has been done and verified, it can be saved
  and replayed later with zero model calls.
- **Undo** some actions, keep an audit log, and remember things you tell it.

There's also an experimental Android-over-ADB path. It works for me but I
wouldn't call it a feature yet.

## Safety

An agent that can click anything on your PC needs guard rails. The main ones:

- **Dangerous shell commands are blocked as data**, in
  [`packages/policy-engine/src/shell-rules.js`](packages/policy-engine/src/shell-rules.js):
  a hard deny list (stuff like wiping a drive) and a confirm list that asks you
  first. The terminal is off by default and runs in Windows Sandbox, with no
  fallback to your real machine if the sandbox isn't available.
- **What it reads is not what it was told to do.** A web page, email or document
  that says "now email this file to X" doesn't get to pick where things go.
  That's enforced on the destination at the tool boundary, not by trying to
  spot sneaky English.
- **The daemon only listens on 127.0.0.1**, with a random token per launch.
- **"Full access" mode still can't** turn on the terminal, skip the deny list,
  or let page content give it orders.

None of this makes GUI automation risk-free. Malware already running as your
user is outside what this can protect against.

## Running it

You'll need Windows 11 (x64), Node 22 (CI uses 22.23.1) and npm.

```powershell
npm ci
npm run desktop:dev
```

That starts the Electron app and the local daemon together. If you'd rather use
it in a browser:

```powershell
npm run mvp:ui
```

then open `http://127.0.0.1:4317` and paste the token it prints. Don't expose
that port to other machines.

### Picking a model

Bring your own API key. In Settings you can use OpenAI-compatible, Anthropic,
Gemini, Mistral, DeepSeek or AgentRouter endpoints. Keys you enter in the app are
encrypted with Windows DPAPI and never sent back to the UI.

You can also set it through environment variables:

```
SYSCORA_MODEL_PROVIDER
SYSCORA_MODEL_API_KEY
SYSCORA_MODEL_NAME
SYSCORA_MODEL_BASE_URL
SYSCORA_EXTERNAL_AI_CONSENT_SCOPES   # needed for headless use
```

Heads up on privacy: your prompts and whatever the task needs (screen text,
files, page content) go to the model provider you picked. Nothing goes to me,
and there's no analytics.

## Tests

```powershell
npm run check     # lint + static checks, fast
npm test          # ~1,500 unit and integration tests, a few minutes
npm run eval      # the real-machine eval (uses your model, costs money)
npm run eval -- --mock   # checks the harness itself, no model, free
```

## How it's put together

```text
apps/desktop              the chat UI
apps/desktop-shell        Electron wrapper
apps/daemon               local HTTP + SSE server the UI talks to
packages/fast-agent       the agent loop and its ~48 tools
packages/perception       UIA + OCR + screen capture, fused
packages/policy-engine    shell rules and the content boundary
packages/permission-broker  approvals
packages/capability-registry  every tool runs through here
packages/audit            append-only audit log
os-adapters/windows       Windows actions + a long-lived PowerShell host
os-adapters/browser       Chromium over CDP
tests/eval                the real-machine eval harness
```

A request goes UI → daemon → agent loop → tool → policy check → Windows
adapter, and results stream back into the chat.

One design note: this used to have a big staged pipeline (plan, assess risk,
apply policy, schedule) sitting under the agent loop. I added instrumentation
and found it ran 0 times across 335 eval runs and 143 real sessions, so I
deleted it along with the eight packages only it used. If no model is
configured, it now just tells you, instead of pretending to plan without one.

More design notes are in [`docs/`](docs/README.md).

## Known limits

- Windows 11 x64 only.
- One task at a time. It has one mouse and one keyboard, same as you.
- Accessibility trees and OCR can be incomplete, stale, or even adversarial.
- Lots of GUI actions can't really be undone.
- You need to know how to get an API key, so it's not a casual-user app yet.
- The eval is my own task set on my own machine. It isn't a public benchmark
  and doesn't prove it beats anything else.

## Status

This is a developer preview (v0.1). It can build a Windows installer, but I'm
not publishing a release until it's signed and tested on a clean machine.

Bugs and questions: open a GitHub issue. Security issues: see
[SECURITY.md](SECURITY.md). Also: [privacy](PRIVACY.md), [terms](TERMS.md),
[supported platforms](docs/releases/supported-platforms.md).

All rights reserved, see [LICENSE](LICENSE).
