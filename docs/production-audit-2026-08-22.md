SYSCORA production audit — 22 Aug 2026

All numbers below are measured on this machine today, not estimated. Where I could not measure something, I say so.

1. Is this production-grade? No — but the gaps are shallow and nameable

What is genuinely production-quality:

Zero runtime dependencies (dependencies: {}), npm audit: 0 vulnerabilities. Almost no supply-chain surface.
1,165 tests, 1,163 passing, 0 failing. Zero TODO/FIXME/HACK markers in 47k lines of source.
The evidence architecture — a success sentence is unreachable without a CONFIRMED verdict from a different capability than the one that acted.
Daemon binds 127.0.0.1 only, token auth with constant-time comparison.
Secrets have a DPAPI-backed store (packages/secrets).

What blocks production:

Gap	Evidence
No crash guards at all	Zero uncaughtException / unhandledRejection handlers in the entire repo. One unhandled rejection in a tool kills a daemon that is mid-way through changing someone's machine, with no journal close.
Entire persistence layer on an experimental API	node:sqlite in 8 production modules: sessions, audit, memory, approval tokens, capability grants, elevation grants, secrets, semantic state. Node prints "might change at any time". A Node upgrade can break all persistence at once.
No concurrency control	No queue, mutex or lock anywhere. Two overlapping requests both drive the one physical mouse and keyboard.
The most sensitive credential is in plaintext	WindowsSecretBroker (DPAPI) is instantiated in runtime-factory.js:156, but the model API key is read straight from fileConfig.apiKey. The encrypted store exists and the one credential that matters doesn't use it.
No shipping path	version 0.1.0, private: true, no main, no engines, no build/package/installer/update script. desktop:dev is the only way to run it.
Windows-only	os-adapters/ has windows, windows-host, browser. No macOS/Linux.
2. Is it "much much better" than Anthropic computer use / OpenAI CUA / Pointer.ai?

On cost and perception efficiency — yes, and I can prove it. A perception step measured today:

	tokens per observation
Anthropic computer use screenshot @1280×800	~1,365
SYSCORA screen — Settings	~35   <-- WRONG, see correction below
SYSCORA screen — WhatsApp (complex)	~925

CORRECTION, 22 Aug 2026 — do not quote the ~35. Re-measured with
`node scripts/probe-one-window.mjs settings`, characters ÷ 4, the same
approximation the rest of the project uses:

	Settings, read successfully	1,066 chars	~267 tokens
	Settings, asked for as "SystemSettings" — a FAILED read	976 chars	~244 tokens
	Notepad	1,954 chars	~489 tokens
	WhatsApp	4,114 chars	~1,029 tokens

The ~35 was not a cheap reading of Settings; it does not reproduce by either
route. The honest claim is ~267–1,029 tokens against a screenshot's ~1,365 —
between 1.3x and 5x cheaper per observation, NOT 39x. The screenshot figure
itself is sound (1280×800 ÷ 750). What survives unchanged is the part that was
never a ratio: text does not accumulate in the conversation the way images do,
and what comes back is already named, clickable controls rather than pixels
something still has to interpret. See docs/state-of-the-world.md.

And text doesn't accumulate the way images do, so their cost grows roughly quadratically with steps while this doesn't. Whole 69-run suite: $1.035. Median task: 2 steps, 227 fresh tokens, 5.6s.

On verification — yes, and it's the real moat. Pointer's own stated frontier is producing evidence work is correct. evidence.js refuses at construction any receipt whose verification method equals the thing it verified.

On accuracy — I cannot honestly claim it, and neither should the pitch. Pointer's 83.6% is OSWorld, a public benchmark. SYSCORA's 100% is 23 rows this project wrote about itself. Those numbers are not comparable, and 21 rows against Pointer's 361 verified means the suite mostly tests what we already knew worked. Until SYSCORA runs a common benchmark, "beats Pointer" is unfounded.

On reliability — no. No crash guards, no concurrency control, experimental persistence.

Honest verdict: a genuine and defensible architectural advantage in cost, perception and verification; an unproven claim on accuracy; a real deficit on operational reliability.

3. Old code that isn't used

21,347 lines across the offline-pipeline packages (agent-runtime, capability-registry, reasoning-engine, intent-engine, planner, risk-engine, task-graph-scheduler, recovery-engine, troubleshooting-engine, context-engine, developer-intelligence, semantic-state, benchmark). The eval reports offline pipeline reached 0 times.

But the "delete 20k lines" framing in the briefs is wrong in one important way I verified: fast-agent imports capability-registry (5,945 lines) for exactly one function — matchesTrackQuery, a Spotify helper, at tools.js:41. And runCapability resolves through the registry, so the registry is on the hot path. The deletion is therefore: move one helper, keep the capability layer, delete the planner/reasoning/intent/risk/task-graph stack. Roughly 12–14k lines are genuinely dead, not 20k.

4 & 5. Things actively making it worse

The big one, measured today:

screen.read WITH ocr   5,392ms cold / 1,718ms warm   190 elements
screen.read NO  ocr    1,195ms cold / 1,072ms warm   140 elements

OCR defaults to ON (capability-registry.js:1634 — it only turns off when explicitly false). The code's own comment says it: "the capture and the OCR over it are the slow half of every look and, for an application with a real UIA tree, they return the same words a second time and misread." It costs ~650ms warm / ~4.2s cold, +36% more elements (tokens), and by its own admission reduces accuracy through duplicate misreads.

Others found:

WebView2 apps read the screen twice — tools.js calls screen.read, then readViaWebviewWindow reads again. That's WhatsApp, Spotify, Teams, Discord — a large share of real traffic.
adapter.listWindows() costs 533ms and is called up to 3× inside one screen tool call.
PowerShell host cold start is 2.2s, paid on the first action of every session.
6. Changes that would dramatically improve cost, speed and accuracy

Ranked by measured impact:

Default OCR off; fall back to it only when UIA returns an unusable tree. Measured: 38% faster warm, 78% faster cold, 26% fewer elements, and removes a known source of misreads. This is the single highest-value change in the codebase.
One screen read per perception step on WebView2. Saves ~1.1s on the most common real apps.
Memoise listWindows for the duration of a turn. Saves ~1s per screen call.
Attack STEPS, not tokens. Fixed prompt is 8,619 tokens/step (3,604 system + 5,015 tool schema); tokens sent ≈ steps × 8.6k. Step distribution across 69 runs: 3 runs at 0 steps, 36 at 1–2, and a tail at 27 and 29. The tail is where the money is — batching and skills are worth more than any prompt trimming.
saw/say costs 1,294 tokens/step — 26% of the whole tool schema. It buys honesty and user-visible reasoning. Worth keeping, but it should be a deliberate, measured decision, not an accident.
7. Before launch

Crash guards; pin engines and treat node:sqlite as a migration risk with a fallback; a request lock; move the model key into DPAPI; a packaging/update path; a second model vendor (both endpoints are the same DeepSeek family today — failover survives an outage, not a bad release); and run a public benchmark so the accuracy claim stops being an assertion.