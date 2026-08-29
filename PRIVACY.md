# SYSCORA privacy notice

Effective date: 27 August 2026

This notice describes the current developer preview. It must be reviewed by
qualified counsel and the distribution entity must be identified before a
consumer release.

## What stays on the computer

SYSCORA stores conversations, tool events, audit records, approvals, local
memory, semantic state, settings, and protected provider-credential references
on the user's Windows computer. Provider credentials saved through the app are
protected with Windows DPAPI. DPAPI does not protect a secret from malicious
software already running as the same Windows user.

The desktop provides retention choices, a local-data summary, a JSON Lines
export, and deletion of SYSCORA's local state. Uninstall deliberately keeps app
data so an accidental uninstall does not silently destroy it; use the in-app
deletion control before uninstalling when complete removal is desired.

## What can leave the computer

When external AI is enabled, the user's prompts and the context needed to carry
out a request—including relevant file text, screen/accessibility text, browser
content, email draft context, paths, and tool results—may be sent to the model
provider selected by the user. That provider's privacy terms and retention
practices apply. SYSCORA does not currently operate a managed model service.

Browser navigation, email operations, software installation, updates, and other
requested actions can also contact the relevant third-party service. SYSCORA
does not sell personal data and has no advertising or analytics SDK in the
current desktop build.

## User choices

- External AI requires explicit consent and can be disabled by resetting model
  settings.
- Retention can be set to session-only, 7, 30, 90, or 365 days.
- Data can be exported to the user's Downloads folder.
- Local SYSCORA data can be deleted after entering the exact confirmation
  phrase. The app must then restart.

Exports can contain highly sensitive user content and should be protected by the
user. Environment-variable credentials are controlled outside SYSCORA and are
not deleted by its controls.

## Contact and changes

Privacy questions currently use the support channel in `SUPPORT.md`. Material
changes require a new effective date and release note. A commercial launch must
replace this project-level contact with the responsible legal entity and any
jurisdiction-specific rights process.
