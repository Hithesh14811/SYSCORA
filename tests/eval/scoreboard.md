# SYSCORA scoreboard

Generated 2026-08-19T12:21:57.616Z · configured provider · 2 tasks × 1 = 2 runs

Code under test: `7a0bbd7 + uncommitted changes`

**Partial run — only skill-replay-file-write. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (2/2 tasks passing every run) |
| Median fresh tokens | 50 |
| Median time | 3.1s |
| Median steps | 2 |
| Total cost of this run | $0.006 |

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| skill-replay-file-write | skills | ✅ 1/1 | 2 | 100 |  | 5.4s |  |  |
| skill-replay-file-write-replay | skills | ✅ 1/1 | 1 | 0 |  | 0.8s |  |  |

## The most expensive tasks

- **skill-replay-file-write** — 100 fresh tokens over 2 steps. Passed, which is why nobody noticed.
  `run`
- **skill-replay-file-write-replay** — 0 fresh tokens over 1 steps. Passed, which is why nobody noticed.
