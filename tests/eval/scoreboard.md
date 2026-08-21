# SYSCORA scoreboard

Generated 2026-08-21T08:29:00.290Z · configured provider

Code under test: `072789c + uncommitted changes`

**What was measured**

- **20 task files** on disk, of which **1 ran** — including 0 of the 4 opt-in `manual` tasks, which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed
- **1 scoreboard row**
- **1 repeat** of each row = **1 run**
- The pass rate below is out of the **1 row**, and a row counts as passing only when EVERY repeat passed

**Partial run — only files-read-contents. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1 of 1 rows passing every repeat) |
| Median fresh tokens | 143 |
| Median time | 4.7s |
| Median steps | 2 |
| Total cost of this run | $0.006 |
| Offline pipeline reached | 0 times |

**How much of this is signal**

- **The endpoint served 99.3% of the input from its cache on this run.** Fresh tokens are the money and that share decides them: the drawing row measured 7,912 fresh at 98% and 103,455 fresh at 68% on identical code twenty minutes apart, while tokens SENT moved 8%. **Read any cost difference against this number before looking for a bug**, and compare fresh tokens only between runs whose cache rates are close.
- **The gate is the per-row budgets** in `budgets.json`, on tokens SENT rather than fresh, checked against each row's median, as recorded 2026-08-20T20:03:44.384Z.
- Of the **0 rows sending over 25,000 tokens** — the ones doing enough work for 20% to mean something — **0 would catch one**. 

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| files-read-contents | files | ✅ 1/1 | 2 | 143 |  | 4.7s |  |  |

## The most expensive tasks

- **files-read-contents** — 143 fresh tokens over 2 steps. Passed, which is why nobody noticed.
  `read_file`
