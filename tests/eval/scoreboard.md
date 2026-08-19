# SYSCORA scoreboard

Generated 2026-08-19T11:24:28.781Z · configured provider · 1 tasks × 5 = 5 runs

Code under test: `ee6f4ae + uncommitted changes`

**Partial run — only chat-arithmetic. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1/1 tasks passing every run) |
| Median fresh tokens | 20 |
| Median time | 1.5s |
| Median steps | 1 |
| Total cost of this run | $0.014 |

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| chat-arithmetic | chat | ✅ 5/5 | 1 | 20 |  | 1.5s | 1.5s–3.9s |  |

## The most expensive tasks

- **chat-arithmetic** — 20 fresh tokens over 1 steps. Passed, which is why nobody noticed.
