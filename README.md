# SYSCORA

An agent that operates this Windows machine the way a person does — you say what
you want in ordinary words, and it does it: opens the applications, reads what is
on screen, clicks, types, runs commands, checks its own work, and tells you what
is now true.

It is the shape of an agentic coding assistant, pointed at the operating system
instead of a repository. One conversation, held open for the whole task. The model talks
while it works, calls tools by name, reads the results, and keeps going until the
job is done.

```
you   ▸ install VLC and play the video on my desktop
      ▸ winget shows VLC 3.0.21, 42 MB. Installing it.
  ✓ run     winget install VideoLAN.VLC          ████████░░  78%
      ▸ Installed. Desktop has one video, holiday.mp4. Opening it in VLC.
  ✓ launch  vlc
  ✓ screen  the working window
      ▸ VLC is playing holiday.mp4, 4:31 long, at 0:03.
```

## What it can do

**See the screen without a screenshot.** Every look fuses the window's
accessibility tree with OCR of its pixels and returns text: what the window is,
what is written on it, and every control with the label you can click it by. It
costs a fraction of what an image costs and it is exact — a button's name rather
than a guess at one.

**Act.** `click`, `type`, `key`, `scroll`, `drag`, `draw`, `launch`,
`new_document`, `focus`, `window_state`, `close_app`, `clipboard`, `volume`,
`play_music`, `open_url`, files (`read_file`, `write_file`, `edit_file`), a
PowerShell terminal (`run`), a controlled browser that reads pages through the
DOM (`web_open`, `web_read`, `web_click`, `web_type`, `web_scroll`), and `batch`
to run a decided sequence with no round trip between the steps.

**Check its own work.** A delivered keystroke is not evidence. After acting it
reads the window back; after a drawing it asks the application whether it has
anything to undo; after closing something it looks at the process list. When it
cannot confirm, it says so rather than claiming success.

**Keep more than one conversation.** New chat, and a list of previous ones to
move between — each with its own history, so a long piece of work does not share
a thread with "is python installed". Re-opening a chat replays its transcript,
tool rows and all. There is no account system yet, so these live in this client's
own storage: they belong to this machine, and clearing the browser's storage
clears them.

**Know which machine it is on.** Your real Documents/Desktop/Pictures paths
(including OneDrive redirection), which desktop applications are installed, and
which browser handles links — read once at startup and put in front of the model
before its first decision.

## Running it

```bash
npm run mvp:ui
```

Then open <http://127.0.0.1:4317>. The daemon prints an API token on startup;
paste it into the Connect panel the first time.

As a desktop application (starts the daemon itself and injects the token, so
there is nothing to paste):

```bash
npm run desktop:dev
```

Tests:

```bash
npm test
```

## Configuring the model

Provider settings come from the environment first, then a gitignored
`.syscora/config.json`, then a deterministic offline Mock. Nothing about SYSCORA
is tied to one vendor — any OpenAI-compatible endpoint that supports tool calling
will do.

```json
{
  "model": {
    "provider": "deepseek",
    "baseUrl": "https://inference.baseten.co/v1",
    "primaryApiKey": "…",
    "model": "…",
    "requestTimeoutMs": 30000,
    "maxTokens": 4096
  }
}
```

Or by environment: `SYSCORA_MODEL_PROVIDER`, `SYSCORA_MODEL_API_KEY`,
`SYSCORA_MODEL_NAME`, `SYSCORA_MODEL_BASE_URL`.

**Keys are secrets.** `.syscora/` is gitignored; treat anything in it the way you
would treat a password, and rotate a key that has been shared or pasted anywhere.

## How it is put together

```
apps/desktop          the chat surface — a live transcript, one row per tool call
apps/desktop-shell    the Electron wrapper
apps/daemon           HTTP + server-sent events, on 127.0.0.1 only
packages/fast-agent   THE AGENT LOOP and the tools the model is given
packages/perception   window capture, OCR and the accessibility tree, fused
os-adapters/windows   the Windows adapter
os-adapters/windows-host  a long-lived PowerShell host: UIA, SendInput, capture
os-adapters/browser   the controlled Chromium, driven over CDP
```

A request goes: browser → `POST /api/intents` → `AgentRuntime.submitIntent` →
the agent loop, which streams its events back over
`GET /api/intents/:id/stream`. Every tool call appears in the transcript as it
starts, with its arguments, and resolves in place with its real output.

There is a second, older route underneath — a staged pipeline that plans from
typed capabilities without a model at all. It is what answers when no model can
be reached, and nothing but that reaches it.

## What stops it doing something terrible

- **A hard floor under the terminal.** Formatting a disk, deleting shadow copies,
  disabling Defender or piping a download into a shell is refused outright, below
  any approval, in the one place every command is spawned
  (`packages/policy-engine/src/shell-rules.js`).
- **Nothing destructive happens silently.** A file with something in it is not
  overwritten, and a document that is already open is not typed into, without the
  agent being told first and saying what it means to do.
- **Local only.** The daemon binds 127.0.0.1 and every mutating route needs the
  token.
- **Stop means stop.** The button aborts the model call, the loop settles on what
  it had already done, and a running command is killed.

Credentials are stripped from anything sent to the model. Email addresses and
file paths are not — they are usually the point of the request, and hiding them
broke more than it protected.

## Known limits

- Windows only.
- One task at a time: there is one screen, one pointer, one focused window.
- A task is bounded at 80 steps or six minutes, whichever comes first.
- It cannot see pictures. It reads text and controls, so it judges a drawing by
  the application's undo state, never by looking at it.
