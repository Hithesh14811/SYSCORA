# SYSCORA scoreboard

Generated 2026-08-20T19:27:39.236Z · configured provider

Code under test: `0e568f6 + uncommitted changes`

**What was measured**

- **20 task files** on disk, of which **1 ran** — including 0 of the 4 opt-in `manual` tasks, which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed
- **1 scoreboard row**
- **3 repeats** of each row = **3 runs**
- The pass rate below is out of the **1 row**, and a row counts as passing only when EVERY repeat passed

**Partial run — only draw-shape-in-paint. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1 of 1 rows passing every repeat) |
| Median fresh tokens | 59,373 · moved 48,753–1,03,455 (92%) across this run's own 3 sweeps |
| Median time | 72.3s · moved 70.5s–89.4s (26%) across this run's own 3 sweeps |
| Median steps | 15 |
| Total cost of this run | $0.215 |
| Offline pipeline reached | 0 times |

**How much of this is signal**

- The headline median moved **92%** (48,753–1,03,455) across this run's own 3 identical sweeps. **It is not the gate**, and a change smaller than that band cannot be read off it.
- **The gate is the per-row budgets** in `budgets.json`, checked against each row's median, as recorded 2026-08-19T10:42:37.384Z.
- Of the **1 rows costing over 1,000 fresh tokens** — the ones where a 20% regression is real money — **0 would catch one**. 
- **1 of those rows is not gated at all** — `draw-shape-in-paint` has no recorded budget. A row nobody has recorded a baseline for cannot regress, which is the most comfortable kind of green there is. Re-record with `--write-budgets`.

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| draw-shape-in-paint | drawing | ✅ 3/3 | 15 (15–23) | 59,373 | 48,753–1,03,455 | 72.3s | 70.5s–89.4s |  |

## The most expensive tasks

- **draw-shape-in-paint** — 59,373 fresh tokens over 15 steps. Passed, which is why nobody noticed.
  `launch → new_document → screen → click → screen → draw → run → key → screen → click → type → screen → click → run`
