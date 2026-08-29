# Repository hygiene audit

Last run: 27 August 2026

## Removed from the current tree

- `.kiro/specs/syscora/.config.kiro` and `requirements.md`: local assistant
  metadata and stale Ubuntu/Tauri requirements for a Windows/Electron product.
- `apps/desktop/index.html`, `app.js`, and `styles.css`: a superseded developer
  console that remained reachable as an unauthenticated static URL but was not
  the application UI.
- `apps/daemon/src/privileged-helper.js`: a test-only subprocess entry point;
  production uses the reviewed privileged-helper package directly.
- `packages/fast-agent/src/undo-message.js`: an isolated WhatsApp experiment
  reached only by its own test and never wired into the current agent.
- `packages/benchmark/src/index.js`: an obsolete release-scoring module reached
  only by its own test; the active evaluation runner and fail-closed release gate
  supersede it.
- The two tests that existed only to exercise those removed modules.

The generated installer also excludes tests, Markdown source, local state,
development scripts, and dependencies already supplied by Electron packaging.

## Intentionally retained non-runtime files

Unit/integration/live tests, evaluation tasks, diagnostic probes, architecture
records, migration tools, and release scripts are not loaded by the installed
application. They remain engineering evidence or reproducibility tools and are
therefore not classified as unwanted merely because runtime reachability is
zero. The manual probes should be consolidated over time, but deleting them
without replacing their unique observations would reduce diagnosability.

## Local ignored material

`node_modules`, `dist`, `.npm-cache`, `.syscora`, test results, transcripts,
logs, local assistant/editor configuration, the historical literal
`%USERPROFILE%` bug footprint, and duplicate logo assets are ignored. They must
not be staged.

## Pushed history

Deleting a file removes it from future checkouts but not from Git history. The
`history:audit` command inspects all reachable blobs for forbidden paths, large
objects, and secret shapes without printing secret values. Ordinary stale files
should remain in history; rewriting public history is disruptive and is reserved
for actual credentials, private user data, or materially harmful large blobs.

If such a finding is confirmed: revoke the credential first, coordinate a
freeze, use `git filter-repo` with an exact path or replacement map, force-push
all affected refs, invalidate caches/releases, and require every collaborator to
fresh-clone. History rewriting is not performed automatically by this project.

The current pushed history contains exact, reviewed remnants of old `.kiro` and
`.claude` metadata, four tiny literal-`%USERPROFILE%` test-output files, and fake
provider-key strings in secret-redaction tests. They contain no live secret or
material private data. Their blob IDs are narrowly allow-listed so a
reintroduction or modification fails the audit. Rewriting public history for
these harmless remnants would create more operational risk than leaving them.
