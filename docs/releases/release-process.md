# Release process

The release gate is intentionally fail closed. There is no emergency bypass in
the release workflow.

## Candidate preparation

1. Update the version and changelog. Resolve every high/critical security or
   dependency finding.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run license:check`,
   `npm run sbom`, and `npm run security:audit`.
3. Run the complete live evaluation at least three times using the production
   model configuration. Record zero failures, false-success cases, and budget
   breaches against the exact candidate commit.
4. Complete the clean-machine, update/rollback/uninstall, independent-security,
   prompt-injection, legal, and provider-revocation evidence described in
   `release/evidence/README.md`.
5. Commit only reviewed source and safe attestations. The worktree must be clean.
   Create one annotated tag named exactly `v<package version>` and push
   the commit and tag.

## Build and publication

The tag workflow installs from the lockfile, repeats all automated gates, creates
the SBOM/license/audit reports, builds using the configured Authenticode
certificate, verifies both installer and executable signatures, installs and
uninstalls the candidate in a smoke test, and checks that packaged build metadata
matches the tagged commit exactly.

It creates a **draft** GitHub release. A human compares its installer SHA-256 to
the validation evidence, checks SmartScreen publisher presentation on a clean
machine, and publishes the draft only after approval. The updater cannot see a
draft release.

## Update and rollback

Updates are never silently installed while the app is running. The app checks a
signed GitHub release, presents status, downloads only on user request, verifies
the Authenticode publisher through the updater, and installs on explicit user
action.

Rollback is a forward-fix release: restore the last known-good source in a new
commit, increase the version, repeat every release gate, sign it, and publish it
as the latest release. Downgrades are disabled because accepting an older signed
binary would reopen fixed vulnerabilities. If an update cannot start, users may
run the previously archived signed installer after verifying its checksum; this
is an incident procedure, not an automatic downgrade path.

Uninstall keeps data by default. Users who want complete removal delete local
data in Privacy before uninstalling. The clean-machine matrix verifies both
retention and deletion paths.

## Incident stop-ship

On a suspected compromised signing key, provider key, update artifact, or
high-impact false success: do not publish; unpublish the affected release if it
is already public; revoke the affected credential/certificate; disclose through
the security process; and ship only a newly signed, newly versioned candidate.
