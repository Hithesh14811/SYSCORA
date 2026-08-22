# SYSCORA scoreboard

Generated 2026-08-22T08:41:47.688Z · configured provider

Code under test: `6ebd181 + uncommitted changes`

**What was measured**

- **22 task files** on disk, of which **1 ran** — including 1 of the 5 opt-in `manual` tasks, which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed
- **1 scoreboard row**
- **1 repeat** of each row = **1 run**
- The pass rate below is out of the **1 row**, and a row counts as passing only when EVERY repeat passed

**Partial run — only messaging-send-to-self. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1 of 1 rows passing every repeat) |
| Median fresh tokens | 88,862 |
| Median time | 56.9s |
| Median steps | 23 |
| Total cost of this run | $0.134 |
| Offline pipeline reached | 0 times |

**How much of this is signal**

- **The endpoint served 79.4% of the input from its cache on this run.** Fresh tokens are the money and that share decides them: the drawing row measured 7,912 fresh at 98% and 103,455 fresh at 68% on identical code twenty minutes apart, while tokens SENT moved 8%. **Read any cost difference against this number before looking for a bug**, and compare fresh tokens only between runs whose cache rates are close.
- **The gate is the per-row budgets** in `budgets.json`, on tokens SENT rather than fresh, checked against each row's median, as recorded 2026-08-20T20:03:44.384Z.
- Of the **1 rows sending over 25,000 tokens** — the ones doing enough work for 20% to mean something — **1 would catch one**: `messaging-send-to-self`. 

## Budget breaches

- messaging-send-to-self: 4,31,518 tokens sent against a ceiling of 77,871 (baseline median 65,954)
- messaging-send-to-self: 56.9s against a ceiling of 29.2s (baseline median 22.5s)
- messaging-send-to-self: 23 steps against a ceiling of 8 (baseline median 6)

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| messaging-send-to-self | messaging | ✅ 1/1 | 23 | 88,862 |  | 56.9s |  |  |

## The most expensive tasks

- **messaging-send-to-self** — 88,862 fresh tokens over 23 steps. Passed, which is why nobody noticed.
  `launch → screen → batch → screen → click → screen → scroll → screen → batch → screen → batch → screen → click → screen → click → screen → click → screen → click → screen → batch → screen`
