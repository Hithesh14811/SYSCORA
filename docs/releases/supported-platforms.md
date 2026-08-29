# Supported platforms and surfaces

Last reviewed: 27 August 2026

## Release target

The 0.1.x developer preview targets **Windows 11 x64 versions 24H2, 25H2, and
26H1 while each version remains in Microsoft support**. The release matrix must
cover Home and Pro for normal desktop use and Pro or Enterprise with Windows
Sandbox enabled for isolated terminal use.

Windows 10, Windows on Arm, macOS, Linux, Windows Server, multi-user remote
desktop hosts, virtual desktop infrastructure, and managed enterprise endpoints
are not supported. Windows 11 23H2 is not a release target even where a specific
Enterprise edition remains in extended support.

Support follows Microsoft's lifecycle, not a hard-coded promise. Every release
candidate must refresh the matrix against Microsoft's supported Windows client
versions and record the exact editions/builds tested.

## Product surfaces

| Surface | Status | Boundary |
| --- | --- | --- |
| Windows desktop shell and local daemon | Preview | One signed-in interactive user; one active intent at a time. |
| Files and folders | Preview | Canonical attached-workspace checks; destructive or external changes can require approval. |
| Windows UI automation | Preview | Accessibility first, OCR/pixels as fallback; application UIs can be ambiguous. |
| Controlled Chromium browser | Preview | Dedicated CDP session; web content is untrusted data. |
| Developer terminal | Experimental, off by default | Disposable Windows Sandbox is the default; host execution is an explicit expert opt-in. |
| Gmail drafting | Experimental | The model drafts; a human Send action is required. |
| Android through ADB | Experimental | Developer-only, separately configured, not included in consumer claims. |
| Third-party plugins | Internal alpha | Disabled unless explicitly configured with trusted signing keys. |

The agent does not understand arbitrary images as a human does, cannot guarantee
that every GUI change is reversible, and must not be marketed as unattended or
universally compatible.

## Machine validation matrix

The signed installer must pass install, first run, model recovery, update,
rollback, uninstall, retained-data behavior, explicit deletion, terminal-off,
Sandbox-available, Sandbox-unavailable, and crash-recovery tests on clean
machines. Results are attested in `release/evidence`; self-testing only on the
developer workstation is not release evidence.
