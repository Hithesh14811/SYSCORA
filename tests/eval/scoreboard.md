# SYSCORA scoreboard

Generated 2026-08-19T12:47:10.137Z · configured provider

Code under test: `c8e8199 + uncommitted changes`

**What was measured**

- **19 task files** on disk, of which **1 ran** — including 0 of the 4 opt-in `manual` tasks, which touch the volume, WhatsApp and the webview and are skipped unless `--manual` is passed
- **1 scoreboard rows**
- **1 repeats** of each row = **1 runs**
- The pass rate below is out of the **1 rows**, and a row counts as passing only when EVERY repeat passed

**Partial run — only files-read-contents. Not a baseline; the budgets file is only written by a full run.**

Costs are quoted as **fresh** input tokens — what is billed at full rate. The
endpoint serves ~96.6% of the fixed prompt prefix from its cache at roughly a
tenth of the price, so `tokensIn` is bandwidth, not money.

| | |
|---|---|
| **Pass rate** | **100%** (1 of 1 rows passing every repeat) |
| Median fresh tokens | 148 |
| Median time | 5.5s |
| Median steps | 2 |
| Total cost of this run | $0.006 |

## Budget breaches

- files-read-contents: 5.5s against a ceiling of 4.3s (baseline median 3.1s)

## By task

Median of the repeats, with the full spread beside it where the runs disagreed.

| task | category | pass | steps | fresh tokens | spread | time | spread | why it failed |
|---|---|---|---|---|---|---|---|---|
| files-read-contents | files | ✅ 1/1 | 2 | 148 |  | 5.5s |  |  |

## The most expensive tasks

- **files-read-contents** — 148 fresh tokens over 2 steps. Passed, which is why nobody noticed.
  `read_file`
