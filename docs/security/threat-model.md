# SYSCORA Threat Model

Last reviewed: 2026-08-26

## Scope and security objective

SYSCORA is a local Windows agent that can read files, operate graphical applications, browse the web, draft email, load signed capability plugins, and—only after a separate developer opt-in—run arbitrary PowerShell. Its primary security objective is to prevent content that the user did not authorize from becoming an action on the machine or an outbound action to another person.

The application cannot make arbitrary host execution risk-free. It therefore separates ordinary product capabilities from the developer terminal, records approval decisions, keeps a non-bypassable catastrophic-command floor, and offers Windows Sandbox for commands that need a disposable OS boundary.

## Trust boundaries

| Boundary | Trusted statement | Untrusted input |
| --- | --- | --- |
| User → renderer | The current message and access mode are authority for this request only. | Chat history is context, not standing authorization. |
| Renderer → daemon | Requests carrying the per-launch token may call the local API. | Every body field is validated and bounded; localhost alone is not authentication. |
| Daemon → model provider | Only the consented context required for reasoning may cross the provider boundary. | Model output is a proposal, never executable policy. |
| Model → toolset | Only tools visible under the current request policy may be called. | Tool name, arguments, narration, and model-generated command lines are untrusted. |
| Toolset → OS adapter | Typed capabilities and explicit receipts cross this boundary. | A free-form shell line requires Developer terminal access and final-boundary authorization. |
| Perception → model | Screen, browser, file, clipboard, and email contents are data. | Instructions embedded in that content do not inherit the user's authority. |
| Plugin → runtime | Only explicitly enabled, schema-valid plugins signed by a trusted configured key may register capabilities. | Plugin code remains native code in the daemon process and has the daemon user's authority. |
| Email draft → send | The agent may prepare a draft card. | Only the renderer's human-operated Send action can reach the authenticated send endpoint. |

## Access modes

The composer sends one explicit mode on every request. Changing modes does not rebuild the toolset or model provider, so it adds no model call and no normal-path latency.

- **Ask for approval** asks once per turn before internet access or an external file edit, and asks before every mutating shell command.
- **Approve for me** is the recommended default. Read-only work remains immediate; actions classified as unsafe or irreversible ask the user.
- **Full access** supplies standing approval for normal confirmation gates. It cannot bypass the catastrophic shell floor and cannot approve an action whose destination came from an injected instruction in untrusted content.

Arbitrary shell is a separate **Developer terminal access** switch and is off by default in every mode. Full access does not expose it.

## Terminal execution

Every model-authored shell call is classified immediately before process spawn:

- `ALLOW`: an explicit read-only command/subcommand allow-list.
- `ASK`: every mutation, unknown verb, unknown subcommand, inline interpreter, or ambiguous command. The adapter refuses closed if an approval callback does not reach the final spawn boundary.
- `DENY`: disk/boot destruction, protected-root deletion, backup wiping, security-control disabling, fetch-and-execute, machine registry hive deletion, account removal, and fork bombs. No access mode can override this result.

Developer terminal execution modes are:

- **Workspace**: a fast host process whose working directory must be inside an explicitly attached folder for any command that might mutate. Explicitly classified read-only version/status checks may run without a folder because they have no write target to confine. This is a policy/cwd boundary, not an OS sandbox; arbitrary PowerShell can construct paths outside the workspace. Use it only for trusted developer workflows.
- **Disposable Windows Sandbox**: maps the attached workspace and a transient result folder into a fresh Windows Sandbox, disables networking, clipboard, printers, audio/video input and vGPU, and shuts the sandbox down after one command. It fails closed when the Windows optional feature is unavailable. Startup is intentionally slower and no host fallback occurs.
- **Host**: direct execution as the signed-in Windows user. This is the old behavior, now explicitly labelled and opt-in.

All three retain the shell classifier and catastrophic-command floor. Windows Sandbox reduces host exposure; it does not protect the mapped workspace from a command the user approved, and it relies on the security of the Windows hypervisor and Sandbox feature.

The model also has a separate bounded **software diagnostic** for questions such as “is Python installed?”. It validates a single command name, resolves it with `where.exe`, ignores Microsoft Store execution aliases, and may invoke only a reviewed executable with fixed version arguments. If no command is found, it can read the installed-application inventory. It cannot accept arguments or arbitrary code, never opens a terminal window, and intentionally observes the host even when disposable shell execution is selected: the user is asking about the host, not the contents of a fresh sandbox.

## GUI and accessibility automation

GUI tools run as the signed-in user and can act on any visible application. Mitigations include destination binding, focus verification, post-action evidence, an undo journal for supported actions, confirmation before irreversible clicks or sends, and single-flight ownership of the physical pointer.

Residual risks:

- Accessibility labels can be stale, misleading, or supplied by the target application.
- Pixel/OCR fallback is probabilistic and may select the wrong visual target.
- Many GUI actions are not transactionally reversible.
- A hostile application already running as the same user can spoof a window or accessibility tree.

High-impact GUI capabilities should eventually move into per-application profiles with scoped grants and stronger before/after verification.

## Browser and web content

The Electron renderer cannot navigate to external sites or create inherited child windows. HTTP(S) links open in the user's real browser. Webviews are prevented, Chromium permission requests are denied, Node integration is off, context isolation and renderer sandboxing are on, and production DevTools are disabled unless the process owner explicitly sets the override.

The local static surface is served with a restrictive Content Security Policy, framing denial, MIME sniffing denial, same-origin resource policy, and no-referrer policy. Inline scripts are not allowed. Inline styles remain allowed for the existing UI and should be removed in a later nonce/hash CSP pass.

Web pages are untrusted model context. Detected instructions aimed at the agent are surfaced and remembered for the turn; an outbound action toward a destination learned from that content requires a real human decision even in Full access.

## Files, documents, clipboard, and model content

Reading a file or clipboard does not authorize obeying it. The same content-injection boundary applies to pages, documents, screen text, messages, and clipboard contents. Writes are read back through a separate path, and supported file changes prepare undo information before mutation.

Ask mode treats a write outside an attached workspace as external. Workspace membership resolves existing components through symlinks, junctions and reparse points, then reconstructs missing leaves from the nearest canonical parent. Plugin entry points and file-card open actions use the same canonical boundary. A same-user process racing a path after validation and applications that write through their own APIs remain residual risks; stronger Windows handle-based execution is future defense in depth.

## Email

The model-facing tool produces a draft UI card only. OAuth credentials and the send route are not tools and are not placed in model context. Sending requires a human click in the renderer; account disconnection and default-account selection are authenticated local API actions.

Residual risks include a user overlooking the recipient or attachment, OAuth scope compromise, provider-side account compromise, and malicious quoted content influencing the draft. Add a recipient/domain warning and attachment manifest confirmation before broader release.

## Plugins

Plugins are opt-in and must pass manifest, runtime-version, dependency, capability-contract, and Ed25519 signature validation against configured trusted keys. With no trusted keys, plugin loading fails closed.

A valid plugin is still native code running with daemon authority. Signature verification establishes publisher identity and integrity, not safety. External alpha should keep third-party plugin loading off by default. A production plugin program needs review policy, provenance/revocation, least-privilege process isolation, update signing, and permission disclosure in the UI.

## Secrets and provider privacy

The first-run screen discloses that prompts and necessary file/screen/browser/email context may go to the selected provider. A newly entered model key is sent once to the authenticated daemon, protected with Windows DPAPI before config is atomically replaced, never returned to the renderer, and applied without restart.

DPAPI protects against another Windows user and an exfiltrated copy; it does not protect a secret from code already running as the same user. Environment-variable credentials override file configuration and cannot be rotated by this application.

The previously documented leaked provider key must be revoked and replaced in the provider dashboard before any external alpha. Code cannot prove or perform that external revocation. The owner has explicitly deferred it while replacing non-working primary/fallback keys; release remains blocked until there is external evidence of revocation.

## Local daemon and Electron shell

- The daemon binds only to `127.0.0.1`.
- A cryptographically random per-launch API token is passed main → preload in-process and compared in constant time.
- API request bodies are bounded; attachment bodies have a separate bounded allowance.
- The renderer gets only the token and the sanctioned path-for-user-selected-file bridge.
- Electron is pinned to a supported release; renderer sandbox, context isolation, web security, navigation denial, permission denial, and production DevTools policy are explicit.
- Only one intent may own the screen and pointer at a time.

Residual local threats include malware already running as the same Windows user, token extraction from the renderer process, local denial of service, Electron/Chromium vulnerabilities, and a compromised daemon dependency.

## Release gates still required

- Revoke and replace the documented leaked provider credential and record evidence outside the repository.
- Code-sign the executable and installer, establish publisher identity, and test SmartScreen behavior.
- Test install, upgrade, uninstall, first run, provider save, Ask/Balanced/Full, developer terminal, Windows Sandbox unavailable/available, and crash recovery on clean supported Windows machines.
- Complete dependency/license/SBOM review and an independent security review focused on the model-to-action boundary.
- Add automated CSP/Electron configuration checks and Windows Sandbox integration tests on a capable CI runner.
- Run the full automated suite on clean `master`. Repeated paid live eval and stale/unwired-file removal were explicitly deferred for this change set and remain release work.

## Security invariants

1. No current desktop request sends blanket `autoApprove`.
2. No access mode alone exposes arbitrary shell.
3. Every model shell mutation is authorized at the final spawn boundary or refused closed.
4. `DENY` is not a confirmation and cannot be overridden.
5. Content cannot grant itself authority.
6. A provider secret is never returned to the renderer or written plaintext to config by the settings route.
7. Disposable isolation never falls back to host execution.
