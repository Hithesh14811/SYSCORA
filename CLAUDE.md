# SYSCORA — orientation

An agent that operates this Windows machine from natural language. Claude Code's
shape, pointed at the whole OS instead of a repository.

## Running it

```bash
npm run mvp:ui        # daemon + web UI on 127.0.0.1:4317 (token printed on startup)
npm run desktop:dev   # Electron shell; injects the token itself
npm test              # ~900 unit + integration tests
npm run eval          # measures the agent against the REAL machine — see tests/eval/README.md
npm run eval -- --mock   # harness self-test, no model, no cost
```

Tests are slow (~10 min). Run the specific file while working:
`node --test --test-timeout=240000 --test-force-exit tests/unit/<file>.test.js`

## Where things are

```
packages/fast-agent/src/index.js    THE AGENT LOOP — the hot path, all of it
packages/fast-agent/src/tools.js    the ~30 tools the model is given
packages/perception/                window capture, OCR and UIA, fused
packages/policy-engine/src/shell-rules.js   the DENY floor and the CONFIRM tables
os-adapters/windows/                the Windows adapter
os-adapters/windows-host/*.ps1      long-lived PowerShell host: UIA, SendInput, capture
os-adapters/browser/                controlled Chromium over CDP
apps/daemon/src/server.js           HTTP + SSE, 127.0.0.1 only
apps/desktop/demo.{html,js,css}     the chat surface
tests/eval/                         the eval harness — pass rate, tokens, time, cost
docs/webview-perception.md          SPEC — Phase 1, do this first
docs/skills.md                      SPEC — Phase 2, the core of the product
docs/trust-and-triggers.md          SPEC — Phase 3
```

There is a second, older route under the loop — a staged pipeline that plans from
typed capabilities without a model. It answers when no model can be reached.
Nothing else reaches it. Do not add features there.

## House style

The comments in this codebase carry the *reasons*, usually a specific defect that
was observed live. When you fix something non-obvious, write down what went wrong
and why the fix is shaped the way it is — that is what stops the next person
undoing it. Match the density of the surrounding code.

Prose in tool descriptions is expensive: the whole tool schema is re-sent on
every step. `node scripts/measure-prompt-cost.mjs` prints the per-step cost.
Prefer putting a lesson in the *result* a tool returns on failure, where it is
read at the moment it matters and costs nothing the rest of the time.

## Rules that are not negotiable

- **Never claim something happened without evidence from a tool.** Most of the
  worst bugs found here were the agent grading its own homework: a message
  reported sent that sat unsent in a search box, an invented version number, a
  song "playing" that never started.
- **Unconfirmed is not failed.** Verdicts need three states, not two.
- **Safety lives in `shell-rules.js` as data**, checked at the tool boundary —
  never as a pipeline stage. The staged engines were removed for speed on
  purpose. A gate that refuses arbitrary things teaches the model to route
  around refusals; that has been observed happening.
- **Verification must not share a code path with the thing it verifies.**

## State

`.syscora/` (gitignored) holds config, notes, skills and the eval workspace.
Secrets live there in plaintext — never print them.
