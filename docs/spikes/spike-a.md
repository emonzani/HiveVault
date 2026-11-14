# Spike A — task engine under crashes

Run `a-FKW3YYQR` · 2026-10-27T13:41:15.140Z · 300 tasks × 4 phases · 3 worker processes · SIGKILL every 700 ms

| Check | Result |
|---|---|
| Tasks by status | done: 300 |
| Worker processes killed (SIGKILL) | 19 |
| Database effects: copies per task | p1×1: 300 tasks, p3×1: 300 tasks |
| Duplicate database effects | none |
| Missing database effects | none |
| Tasks recovered after an expired lease | 102 |
| Delay from lease expiry to the new claim (lease 1.5 s; detection adds up to the lease time) | p50 17 ms · p95 47 ms · max 2132 ms |
| Claims that resumed an interrupted phase | 30 |
| Journaled effects | 900 |
| Total time | 13.6 s (22.0 tasks/s with the kills) |

**Result: PASS** — every task finished, every database effect ran exactly once.
