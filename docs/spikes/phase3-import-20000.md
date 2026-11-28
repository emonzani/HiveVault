# Phase 3 — Bulk import of 20,000 files

Run `jd7yy6` · 2026-10-27T19:38:19.209Z · 2 worker processes × 8 tasks · ~80-byte text files in folders of 1,000

| Metric | Value |
|---|---|
| File generation (one-time) | 0 s |
| Scan | 1 s (20,000 files) |
| Storage (read, encryption, source, task) | 534.9 files/s |
| Files stored / duplicates / skipped / errors | 20000 / 0 / 0 / 0 |
| Indexed sources (I1+) at end of run | 20,000 |
| Run duration | 1.2 min |
| Database storage (`import_files`, `sources`, `tasks`, events, chunks) | 355 MB |
| Progress consistency | OK (stored count monotonically increasing, sums match) |

## Sampled progress

| t (s) | Status | Stored | Pending | Files/s | ETA (s) | Indexed |
|---|---|---|---|---|---|---|
| 10 | running | 4500 | 15500 | 574.9 | 27 | 1890 |
| 20 | running | 10000 | 10000 | 563.6 | 18 | 4118 |
| 30 | running | 15500 | 4500 | 548.8 | 8 | 6326 |
| 40 | done | 20000 | 0 | 534.9 | 0 | 8719 |
| 50 | done | 20000 | 0 | 534.9 | 0 | 12870 |
| 60 | done | 20000 | 0 | 534.9 | 0 | 16913 |
| 70 | done | 20000 | 0 | 534.9 | 0 | 20000 |
