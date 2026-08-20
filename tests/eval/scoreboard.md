# SYSCORA scoreboard

Generated 2026-08-20T13:38:32.290Z · configured provider

Code under test: `9f02a51 + uncommitted changes`

**What was measured**

- **19 task files** on disk, of which **1 ran** — including 1 of the 4 opt-in `manual` tasks, which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed
- **1 scoreboard row**
- **3 repeats** of each row = **3 runs**
- The pass rate below is out of the **1 row**, and a row counts as passing only when EVERY repeat passed

**Partial run — only messaging-send-to-self. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1 of 1 rows passing every repeat) |
| Median fresh tokens | 3,709 |
| Median time | 28.0s |
| Median steps | 7 |
| Total cost of this run | $0.115 |
| Offline pipeline reached | 0 times |

## Budget breaches

- messaging-send-to-self: 7 steps against a ceiling of 6 (baseline median 4)

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| messaging-send-to-self | messaging | ✅ 3/3 | 7 (6–14) | 3,709 | 3,675–9,922 | 28.0s | 24.0s–78.3s |  |

## The most expensive tasks

- **messaging-send-to-self** — 3,709 fresh tokens over 7 steps. Passed, which is why nobody noticed.
  `launch → screen → click → type → screen → batch → screen → batch → screen → batch → screen → batch → screen`
