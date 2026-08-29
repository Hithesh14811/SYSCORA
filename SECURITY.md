# Security policy

## Supported versions

Only the latest signed release is eligible for security fixes. Version 0.1.x is
a developer preview and is not approved for sensitive, regulated, safety-
critical, or unattended use.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Security → Report a vulnerability**
for this repository so the report and any proof of concept remain private.
Include the affected version, impact, reproduction steps, and whether the issue
may have exposed credentials or user data.

The project currently has no contractual response-time commitment. Receipt,
triage, remediation, disclosure timing, and credit will be coordinated in the
private advisory. Never include real provider keys, OAuth tokens, private user
content, or third-party data in a report.

## Release security baseline

A public release is blocked unless it is built from a clean, exactly tagged
commit; the installer and executable have valid Authenticode signatures; the
dependency audit has no high or critical findings; the SBOM and license report
exist; live evaluation has no false-success or budget breach; leaked credentials
have external revocation evidence; and independent security and prompt-
injection reviews have no open high or critical findings.

The enforceable checks live in `scripts/release-gate.mjs`. A missing piece of
evidence is a failure, not a warning.
