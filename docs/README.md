# Docs

Design notes, written while building it. Some describe a plan as it stood at
the time; where a plan turned out wrong, the doc says so at the top rather than
being quietly rewritten.

For what works today and how well, the source of truth is the eval:
[`tests/eval/scoreboard.md`](../tests/eval/scoreboard.md).

## Design

- [Skills](skills.md): save a verified route once, replay it with no model calls.
- [WebView perception](webview-perception.md): why WhatsApp looked "blind" to
  accessibility, and how it turned out we were reading the wrong window.
- [Trust and triggers](trust-and-triggers.md): the injection boundary, and what
  has to be true before it can run unattended.
- [From plan-first pipeline to agent loop](architecture/agent-loop-architecture.md):
  how the staged pipeline gave way to a tool-calling loop.

## Decisions

- [ADR 0001: typed actions first](adr/0001-typed-actions-first.md)
- [ADR 0002: Electron for the desktop shell](adr/0002-windows-desktop-shell-electron.md)

## Security

- [Threat model](security/threat-model.md)
- [Prompt-injection red-team protocol](security/prompt-injection-red-team.md)

## Setup and releases

- [Gmail setup](gmail-setup.md)
- [Supported platforms](releases/supported-platforms.md)
- [Release process](releases/release-process.md)
