# SYSCORA scoreboard

Generated 2026-08-19T08:51:21.435Z · mock · 1 tasks × 2 = 2 runs

**Partial run — only chat-arithmetic. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **0%** (0/1 tasks passing every run) |
| Median fresh tokens | 0 |
| Median time | 34.0s |
| Median steps | 0 |
| Total cost of this run | $0.000 |

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| chat-arithmetic | chat | ❌ 0/2 | 0 | 0 |  | 34.0s | 32.2s–35.8s | expected "391", got "I was interrupted before I could do anything for this reque |

## The most expensive tasks

- **chat-arithmetic** — 0 fresh tokens over 0 steps. Failed.
