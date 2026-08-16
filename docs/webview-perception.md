# Webview perception

**Phase 1. Do this before skills — it decides how many skills can exist.**

> **Measured 15 Aug 2026. The premise below was wrong, and the answer is better
> than the one this document was written to look for.** Read
> `## What the experiment actually found` at the bottom before anything else.
> WhatsApp was never blind: we were reading the wrong window. Everything from
> "The measurement" to "The build" is kept as written, because the reasoning is
> what led to the measurement that corrected it.

A large share of the modern desktop is Chromium in a window: WhatsApp, Slack,
Discord, Teams, Spotify, Notion, VS Code, Linear, Postman. SYSCORA reads those
almost entirely by OCR today, and OCR cannot see an icon.

## The measurement

`node scripts/probe-webview-tree.mjs` — 15 Aug 2026, this machine:

```
application          elements   named    controls
WhatsApp.Root        6          5        3          ← Minimize, Restore, Close
msedgewebview2       1          1        0
electron             0          0        0
```

**Six elements. The window buttons.** The entire conversation UI — chat list,
message bubbles, input box, every icon — is invisible to UIA.

That single line explains every WhatsApp failure on record: names truncated to
`"Chi..."`, sections that had to be inferred from y-coordinates, an emoji react
button hunted across 48 steps and 692,000 tokens, an input box indistinguishable
from a sent bubble.

## Why it's empty

Chromium builds its accessibility tree **lazily**. It stays off until the process
believes an assistive client is present, because maintaining it costs memory and
CPU. A plain UIA query does not always flip that switch.

## The experiment, in order

Run each, re-run the probe, record the `controls` count. Stop at the first that
works.

**1. Launch flag — five minutes, highest odds.**
```powershell
Stop-Process -Name WhatsApp -Force
Start-Process "$env:LOCALAPPDATA\..\WhatsApp.exe" -ArgumentList "--force-renderer-accessibility"
node scripts/probe-webview-tree.mjs whatsapp
```
If `controls` jumps from 3 into the hundreds, **that is the answer** and the rest
of this document is the build.

**2. The screen-reader flag.** Chromium also enables the tree when Windows
reports a screen reader is running (`SPI_SETSCREENREADER`). Testable from the
PowerShell host via `SystemParametersInfo`.
**Weigh this carefully:** it is system-wide, other applications change their
behaviour when it is set, and leaving it set is rude. If it works, set it only
while a reading is in flight and clear it after — and write down that trade.

**3. CDP.** Electron apps launched with `--remote-debugging-port` expose the full
DOM. Same constraint as (1): only for apps SYSCORA starts itself.

**4. Nothing works.** Then the honest position is that these apps are OCR-only,
skills for them will be thin, and the product should say so rather than burning
tokens discovering it per task. The no-progress guard already stops the burn.

## The insight that makes (1) worth building even though it needs a relaunch

You cannot add a flag to an app the user already has open. **But SYSCORA launches
apps itself constantly** — `launch WhatsApp` is the first step of most GUI tasks.
So:

- When SYSCORA launches a known webview app, add the accessibility flag.
- When the app is *already* running with a thin tree, either work with OCR as
  today, or offer: *"I can see much more if I restart WhatsApp — shall I?"*
  Never restart somebody's application without asking.

That covers most real usage without ever touching a window the user owns.

## The build, if the tree appears

**1. Recognise webview windows.** A process list plus the probe's own regex.
Cache per window handle; it does not change under you.

**2. Route them UIA-first.** In `packages/perception/`, a window with a rich tree
should **skip the OCR pass entirely**. This is both the capability win and a
large speed win: OCR is the slowest part of a reading (seconds), and the token
cost of `visibleText` disappears with it.

**3. Keep the fusion path** for native windows and for webviews whose tree is
thin. Two routes, chosen by measurement, not by hope.

**4. Preserve the annotations.** `[under "Chats"]`, `⟨CUT OFF⟩` and the element
table must work identically on the new path — skills depend on them
(`docs/skills.md` §4.1), and a reading that loses them is a regression however
many elements it gained.

## Proving it

Add to `tests/eval/tasks/`:

- **`webview-click-icon`** — an action reachable only through an unlabelled-in-OCR
  control. Impossible today; must pass after. This is the headline.
- **`webview-reading-cost`** — read the same window before and after. Expect a
  large drop in tokens and seconds from dropping OCR.
- The existing `messaging-send-to-self` should get cheaper and more reliable for
  free.

## Definition of done

- The probe reports **≥ 100 named controls** for at least two of WhatsApp, Slack,
  Discord, Spotify.
- `webview-click-icon` passes.
- A reading of a webview window is **faster** than it is today, not slower.
- Native windows are unchanged — verified by the existing eval tasks.

---

## What the experiment actually found

Run in the order above, 15 Aug 2026, this machine.

### The desktop splits by runtime, not by application

| application | runtime | flag | elements | named controls |
|---|---|---|---|---|
| WhatsApp | WebView2 | none | 90 | 34 |
| WhatsApp | WebView2 | `SPI_SETSCREENREADER` | 90 | 34 |
| VS Code | Electron | none | 4 | 3 |
| VS Code | Electron | `--force-renderer-accessibility` | 157 | 90 |
| SYSCORA's own shell | Electron | none | 0 | 0 |

**WebView2 applications publish their tree unasked.** Experiment 2 was run and
cleared inside five seconds and moved nothing at all: 90/34 with the system
screen-reader flag set, 90/34 with it clear. Experiment 1 cannot even be run
against WhatsApp here — it is an MSIX package activated by AppUserModelId, so it
never sees an argument list.

**Electron applications publish nothing without the flag**, and there is no way
to ask a running one. That is now applied at launch (`accessibilityLaunchArgs`),
which is why the flag belongs in the launcher and not in perception.

### The real defect was window resolution, not accessibility

```
WhatsApp.Root   "WhatsApp"        hwnd 198130   6 elements   Minimize/Restore/Close
msedgewebview2  "(139) WhatsApp"  hwnd 197286  90 elements   the entire application
```

Two unrelated **top-level** windows: no shared handle, no parent, no owner. Only
the process tree connects them (msedgewebview2 23468 is a child of
WhatsApp.Root 21256). Asking to read "whatsapp" scored the process name, landed
on the frame, got three caption buttons, concluded the surface was pixels, and
paid for OCR. **Every WhatsApp failure on record follows from that** — the
truncated `"Chi..."`, the y-coordinate guessing, the 692,000-token emoji hunt.

The tree contains, with no flag and no restart: `Attach`,
`Emojis, GIFs, Stickers`, `Voice message`, `Edit "Type a message to +91 …"`,
`Scroll to bottom`, and every chat name in full with its unread count.

### Against the definition of done

- **≥ 100 named controls** — not met, and it is the wrong measure. Accessibility
  is demonstrably ON for WhatsApp; 34 is simply how many controls are on screen.
  Chasing 100 would be chasing a number.
- **`webview-click-icon`** — written (`tests/eval/tasks/17-…`), manual, and its
  verify is confirmed not to false-pass but its open-state names are unconfirmed.
  See the caution in the task.
- **Faster, not slower** — **not met on wall clock.** A warm look costs 1612ms
  against the old route's 1444ms, because reading 90 real elements through
  Chromium's UIA provider costs about as much as capture+OCR of a 6-element
  frame. What did drop is the payload: **20,250 characters of garbled OCR
  (`"E' Eat Sure"`, `"00."`) to 3,743 characters of accurate labels**, an 82%
  cut in what every later step re-sends. The honest summary is *far cheaper and
  it can see, at the same speed* — not faster.
- **Native windows unchanged** — a window with a usable tree never enters the
  redirect path, and an Electron app with no child process finds no candidate and
  falls back exactly as before. 910 unit tests pass.

### Still open

- The per-element cost of Chromium's UIA provider (~15ms) is what the remaining
  wall clock is. Batching with `CacheRequest` is the obvious next lever.
- Slack and Discord are not installed here, so the "at least two applications"
  half of the bar is untested.
