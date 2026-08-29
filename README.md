# SYSCORA

SYSCORA is a supervised Windows agent that can inspect applications and files,
operate graphical interfaces, use a controlled browser, run approved tools, and
verify what happened before it reports success.

The product thesis is simple: **the Windows agent that proves what it changed**.
It prefers structured accessibility and DOM state over pixels, separates
untrusted content from user authority, shows tool activity in the conversation,
and uses independent post-action evidence where a capability supports it.

## Release status

Version 0.1.x is a **developer preview candidate**, not a production or universal
consumer release. The repository can build an x64 Windows installer, but public
release is deliberately blocked until the signed candidate passes clean-machine
validation, repeated live evaluation, independent security and prompt-injection
review, provider-key revocation, lifecycle testing, and legal approval.

See [supported platforms](docs/releases/supported-platforms.md), the
[release process](docs/releases/release-process.md), [security policy](SECURITY.md),
[privacy notice](PRIVACY.md), and [preview terms](TERMS.md).

## What it can do

- Fuse Windows accessibility data with OCR fallback to identify visible text and
  controls; this is often more compact and deterministic than screenshot-only
  perception, but it is not infallible.
- Click, type, scroll, drag, launch and manage windows; read, create and edit
  files; control volume; and use selected application-specific capabilities.
- Drive a dedicated Chromium session through the DOM for supported browser work.
- Draft Gmail messages while keeping Send as a human-operated action.
- Run PowerShell only after Developer terminal access is enabled. Terminal is off
  by default; disposable Windows Sandbox is the default execution mode, and no
  host fallback occurs when isolation is unavailable.
- Keep an audit trail, local memory, supported undo information, and separate
  conversation histories.
- Export local data, choose a retention period, reset provider credentials, and
  delete local state.

Experimental Android-over-ADB and third-party plugin paths exist for developers
but are not consumer claims.

## Developer setup

Requirements: a currently supported x64 Windows 11 release, Node.js 22.23.1 or a
compatible pinned 22.x environment, and npm.

```powershell
npm ci
npm run desktop:dev
```

The desktop starts its authenticated loopback daemon and injects the random
per-launch token through Electron's isolated preload. For browser-only debugging:

```powershell
npm run mvp:ui
```

Then open `http://127.0.0.1:4317` and use the daemon token printed in the
terminal. Do not expose that port or token to another machine.

## Model setup and privacy

The preview is bring-your-own-provider. Settings accepts supported
OpenAI-compatible, Anthropic-compatible, Gemini, Mistral, DeepSeek, and
AgentRouter configurations. A key entered through the app is protected with
Windows DPAPI and is never read back into the renderer. Existing plaintext
config can be migrated, unreadable protected state can be reset, and the active
configuration can be health-tested.

Environment configuration has precedence for the active provider:

- `SYSCORA_MODEL_PROVIDER`
- `SYSCORA_MODEL_API_KEY`
- `SYSCORA_MODEL_NAME`
- `SYSCORA_MODEL_BASE_URL`
- `SYSCORA_EXTERNAL_AI_CONSENT_SCOPES` (must explicitly include the required
  external-AI scopes for headless use)

External AI requires explicit consent. Prompts and task-relevant file, screen,
browser, email and tool context can be sent to the selected provider. Local-first
does not mean that provider-bound context remains local. The preview has no
analytics or advertising SDK and no managed SYSCORA model service.

## Safety boundaries

- Renderer navigation, child windows, Chromium permissions, Node integration,
  production DevTools, and webviews are restricted.
- The daemon binds to `127.0.0.1`, uses a random per-launch token, bounds request
  bodies, compares credentials in constant time, and permits only one active
  intent to own the physical pointer.
- Model output is an untrusted proposal. Internal authorization, destination
  binding, shell classification, and catastrophic-command denial are enforced at
  the action boundary.
- Missing or failed confirmation rejects the action.
- Attached-workspace checks canonicalize existing path components through
  symlinks, junctions and reparse points before testing containment.
- “Full access” cannot enable the developer terminal, bypass catastrophic shell
  denial, or turn instructions found in untrusted content into authority.

These controls reduce risk; they cannot make arbitrary GUI automation or host
execution risk-free. Malware already running as the same Windows user remains
outside this product's isolation boundary.

## Quality and release commands

```powershell
npm run check
npm test
npm run license:check
npm run sbom
npm run security:audit
npm run dist -- --publish never
npm run release:gate
```

`release:gate` is expected to fail during ordinary development. It requires a
clean exactly tagged commit, a package made from that commit, valid Authenticode
signatures, one exact installer, and complete external attestations. The tag
workflow creates a draft GitHub release; publication remains a human decision.

## Architecture

```text
apps/desktop              conversation, onboarding, safety and privacy UI
apps/desktop-shell        hardened Electron wrapper and signed updater
apps/daemon               authenticated loopback API and runtime lifecycle
packages/fast-agent       current model/tool loop
packages/permission-broker authorization and approval state
packages/policy-engine    content and shell policy
packages/perception       accessibility/OCR perception
packages/audit            append-only local audit trail
os-adapters/windows       Windows actions and Sandbox execution
os-adapters/browser       dedicated Chromium/CDP automation
```

A request goes from the renderer to the authenticated daemon, through the agent
loop and visible tools, then through policy and the OS adapter. Results stream
back into the same conversation. A legacy typed pipeline remains for offline
fallback and migration work; it should not be confused with the primary path.

## Known limits

- Windows 11 x64 only; see the precise support matrix.
- One active task, screen, pointer and focused window at a time.
- Tasks are bounded at 80 steps or six minutes.
- Accessibility, OCR and DOM representations can be incomplete, stale, or
  adversarial.
- Many GUI actions cannot be transactionally rolled back.
- The current preview requires model-provider knowledge and is therefore not a
  casual-user product.
- Product-market fit, common-benchmark leadership, and comparative accuracy are
  not established by this repository's private test suite.

Support is best effort through GitHub Issues. Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).
