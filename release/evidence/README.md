# Release evidence

These attestations bind external work to one candidate. They contain no secrets,
raw test data, user content, or full certificate material. Dates are ISO 8601 UTC
timestamps; digests and installer hashes are lowercase SHA-256 hex.

Required files (copy the matching `.example.json`, remove `.example`, and have
the named reviewer complete it):

- `provider-credential-revocation.json`: provider, revocation time, and a short
  non-secret key fingerprint.
- `independent-security-review.json`: independent assessor, report digest, and
  zero open high/critical issues.
- `prompt-injection-red-team.json`: independent assessor, at least 100 cases,
  and zero escaped actions, false successes, or open high/critical issues.
- `clean-machine-validation.json`: all supported OS/edition cases, candidate
  commit, installer SHA-256, and zero failures.
- `update-rollback-uninstall-validation.json`: the same installer SHA-256 and
  successful signed update, forward rollback, uninstall-retain, and
  uninstall-after-delete paths.
- `live-evaluation.json`: candidate commit, at least 22 task rows and three
  repeats, with zero failures, false successes, and budget breaches.
- `legal-approval.json`: named reviewer approval of LICENSE, PRIVACY, TERMS,
  SECURITY, SUPPORT, and NOTICE.

For a future `consumer` release channel, `consumer-onboarding-validation.json`
is also required and must prove onboarding works without API-provider concepts
or user-supplied provider credentials.

The repository includes examples only. Missing real attestations deliberately
block release.
