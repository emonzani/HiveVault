# Phase 0 — Spike results

Date: 2026-10-27 · Machine: AMD Ryzen 9 9900X (24 threads), 62 GB RAM, Windows 11, Docker Desktop (32 GB VM) · PostgreSQL 17.11 + pgvector 0.8.7

Full reports: [spike-a.md](spike-a.md) · [spike-c.md](spike-c.md) · [spike-d.md](spike-d.md)

## Spike A — Durable task engine

**Result: confirmed.** 300 4-phase tasks, 3 worker processes, 19 processes killed with SIGKILL during execution:
all tasks completed, every database effect ran **exactly once**, no effects lost.
An interrupted phase resumes from the last checkpoint; recovery after a crash takes at most the lease duration (1.5 s in the test) plus the reaper cycle.

Decision: the Postgres-backed task engine (`FOR UPDATE SKIP LOCKED`, fenced leases, journaled effects) is the foundation for ingestion and the dream cycle. No external queue.

## Spike C — PostgreSQL + pgvector at scale

Synthetic chunks of ~700 characters, `halfvec(1024)`, 20 partitions by vault. p95 latencies from the Node client.

| Chunks | Total size | Hybrid, 3 vaults | Hybrid, all | Vectors, all (ef 40) | Recall@10 (ef 40 / 100) |
|---|---|---|---|---|---|
| 1M | 6.8 GB | 10.7 ms | 69 ms | 35 ms | 99.3% / 100% |
| 2M | 14.7 GB | 24.2 ms | 94 ms | 38 ms | 99.3% / 99.7% |
| 5M | 34.7 GB | 145 ms | 1,560 ms | 886 ms | 93.3% / 97.7% |

What we learned:

1. **The decisive factor is RAM, not row count.** Up to 2M chunks, data and indexes fit in cache (32 GB VM) and all queries stay below 100 ms. At 5M (34.7 GB), they no longer fit and latencies increase 10–20×. Sizing rule: **the HNSW index + hot portion of the table must fit in RAM**.
2. **Partitioning by vault works as expected.** With 3 allowed vaults, the query touches only their partitions (Merge Append of three HNSW scans): it is 4–10× faster than searching all vaults and also serves as the ACL mechanism.
3. **Binary quantization is the path to TB scale.** At 1M chunks: 0.40 GB index instead of 2.54 GB (6× smaller), recall@10 96.7% with rescoring on the top 200 candidates, similar latency with 3 vaults. For 50M chunks: ~20 GB index instead of ~127 GB.
4. **Incremental inserts degrade HNSW slightly** (recall down to 93% at 5M with ef 40). Mitigations: `ef_search` 100 on large partitions and `REINDEX CONCURRENTLY` on partitions during the dream cycle.
5. **Full-text with `ts_rank_cd` is the weak spot** when data is not in cache (p95 1 s across all vaults at 5M): ranking reads the `tsvector` of every matching row. Must be benchmarked against ParadeDB `pg_search` (indexed BM25) before the end of Phase 1.
6. **Loading is not a bottleneck.** Binary COPY: 23k rows/s without indexes, 900–2,100 rows/s with live HNSW updates. CPU embeddings produce ~30 chunks/s, so the database does not slow down ingestion. For bulk import, it is best to load first and build the index afterward, per partition.
7. The `halfvec(512)` comparison (recall 38.7%) **is invalid**: synthetic vectors are not Matryoshka. Must be repeated with the real model.
8. Docker: `shm_size` must exceed `maintenance_work_mem`, otherwise parallel HNSW builds fail (fixed in `docker-compose.yml`).

## Spike D — Embeddings on CPU, local and remote

Stand-in model: `nomic-embed-text-v1.5` Q4 (137M parameters, already present on the machine). The planned model, Qwen3-Embedding-0.6B, is roughly 4× larger: we expect 1–1.5k tokens/s with 12 threads, to be measured after download.

| Threads | Tokens/s | Chunks/s | Process memory |
|---|---|---|---|
| 4 | 2,451 | 16.8 | 577 MB |
| 8 | 3,801 | 26.1 | 579 MB |
| 12 | 4,661 | 32.0 | 581 MB |

1. **Supervisor and dispatcher work with a real llama-server**: startup, health check, two endpoints running together with work distributed by speed (204 / 206), endpoint with a different model rejected (`mismatch`).
2. **Issue found and fixed: query latency during backfill.** llama-server puts the texts of a request into an internal FIFO queue: with batches of 16 texts, an interactive query waited up to 6.2 s. Fixes in the dispatcher:
   - 1 slot per endpoint reserved for interactive queries;
   - background batches split into requests of 2 texts (same throughput, because llama-server merges slots anyway).

   Result: query p95 during backfill **646 ms** (previously 6,154 ms), throughput unchanged (~5,000 tokens/s).
3. **Quality (indicative):** hit@5 65% with nomic vs. 46% for the lexical mock. On questions whose value updated over time, only 30%: vector search alone cannot tell which value is current. Confirms the choice of compiled pages (current state + timeline).

## Decisions and actions for Phase 1

| # | Decision / action |
|---|---|
| 1 | Default vector index on large spaces: **HNSW on `binary_quantize` + rescoring in `halfvec`**; full `halfvec` HNSW only on small, heavily queried spaces. |
| 2 | Production RAM sizing: (HNSW index + hot portion of the table) × 1.2. |
| 3 | Spike C2 (before the end of Phase 1): ParadeDB `pg_search` vs. `tsvector`, and `pgvectorscale` (StreamingDiskANN). Requires different Docker images. |
| 4 | Download Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B (GGUF Q8_0, ~0.65 GB each) and repeat Spike D: real throughput, Italian quality, truncation at 512. **Requires your authorization to download.** |
| 5 | Dream cycle: `REINDEX CONCURRENTLY` on partitions with degraded HNSW; per-partition `ef_search` based on size. |
| 6 | Longer real chunks (300–800 tokens, ~2,000 characters): redo storage estimates with the real Phase 3 corpus. |

---

# Phase 1 — Memory engine

Date: 2026-10-27 · same machine as Phase 0

Reports: [phase1-bench-long.md](phase1-bench-long.md) · [phase1-bench-tiny.md](phase1-bench-tiny.md) · [spike-c2-paradedb.md](spike-c2-paradedb.md) · [spike-c2-timescale.md](spike-c2-timescale.md)

## Acceptance benchmark (full engine, 1M chunks, 20 vaults)

End-to-end measurements of the real `SearchEngine`: query embedding, transaction under role `cb_reader` with RLS, SQL, grouping, snippets, budgeting. Cache disabled.

| Operation | p95, realistic vocabulary | p95, minimal vocabulary (worst case) | Target (§0.2) |
|---|---|---|---|
| Hybrid search, 3 vaults | **30.5 ms** | 31.8 ms | < 200 ms ✅ |
| Hybrid search, 20 vaults (entire hive) | **86.5 ms** | 85.4 ms | < 600 ms ✅ |
| Title search, pages only | 49.4 ms | 48.7 ms | — |
| Budgeted page read (800 tokens) | 4.5 ms | 4.3 ms | < 20 ms ✅ |
| Repeated search (cache) | 1.3 ms | 0.9 ms | — |

Bulk load: ~19,500 chunks/s, then binary index across all 20 partitions in ~75 s. Storage: 5.2 GB for 1M chunks (tables + indexes).

## Three issues found by the benchmark and fixed

| # | Symptom (20 vaults) | Cause | Fix |
|---|---|---|---|
| 1 | 2.7 s | RLS policies called `cb_vaults()` for every candidate row | Migration 003: `(select cb_vaults())`, evaluated once (InitPlan) |
| 2 | 0.9 s | Under RLS, the full-text operator `@@` is not LEAKPROOF: Postgres skipped the GIN index and scanned all partitions | Migration 004: `ts_match_vq` and `similarity_op` marked LEAKPROOF (rationale in file). Requires superuser |
| 3 | — | A `tsquery` coming from a joined subquery is not an index condition | `tsquery` written directly in the `WHERE` clause |

Discarded attempt: prepared statements. Postgres's generic plan for this partitioned query was 2–3× slower.

## Spike C2 — Alternatives for full-text and vectors

**Full-text, 1M chunks, single table** (p95 ms, 20 vaults):

| Method | Rare-term query | Common-word query |
|---|---|---|
| `tsvector`, AND (`websearch_to_tsquery`, used by the engine) | 5.5 | 18.0 |
| `tsvector`, OR | 657 | 990 |
| ParadeDB `pg_search` 0.26 (BM25, OR) | 22.5 | 22.8 |

- Postgres AND semantics are fast with a realistic vocabulary, but require all words: on natural-language questions it misses results that the vector branch currently recovers.
- ParadeDB provides true BM25 with OR semantics at constant latency, but: **AGPL-3.0 license**, image on **PostgreSQL 18**, index 2.3× larger than GIN.

**Vectors, 1M × 1024, single table** (p95 ms / recall@10, 20 vaults):

| Index | Build | Size | Latency | Recall@10 |
|---|---|---|---|---|
| pgvector binary HNSW + rescoring | 35 s | 0.40 GB | 7.6 ms | 76.3% |
| pgvectorscale DiskANN (SBQ) | **1,401 s** | 0.54 GB | 10.3 ms | 89.8% |
| DiskANN with vault labels | build aborted (~1 h 45 min estimated) | — | — | — |

- DiskANN builds 40× slower. On a single table it has better recall, but our vault-partitioned schema already achieves **96.7%** with binary HNSW (Spike C, 50k-row partitions).
- The TimescaleDB image has telemetry enabled by default.

## Decisions

| # | Decision |
|---|---|
| 1 | **Stay on pgvector** (per-partition binary HNSW). DiskANN discarded: build cost is incompatible with bulk import and nightly REINDEX, with no recall advantage once partitioned. |
| 2 | **Full-text: `tsvector` with AND** for now (targets met). ParadeDB remains an option for ranking quality: decision D11, to be evaluated with the real Phase 6 eval. |
| 3 | The vector similarity threshold (`minVectorSimilarity`) must be calibrated with the real model: currently 0 (disabled). |
| 4 | Migrations that touch system functions (004) must be run by a superuser: document in the installation guide. |

---

# Phase 2 — Authentication, authorization, admin API

Date: 2026-10-27

## What was built

| Component | Detail |
|---|---|
| Accounts | Single `principals` table for people and API accounts; roles `admin`, `curator`, `member`; API scopes `read`, `write`, `ingest`, `admin`; clearance 0–3 |
| TOTP | RFC 6238 implemented in-house (verified against official RFC 6238 and RFC 4226 test vectors). Secret encrypted with the master key (AES-256-GCM, bound to the account). Each code is single-use. 10 recovery codes |
| Enrollment | Admin creates the user and receives a one-time code (24 h). User redeems it on the enrollment page or via `npm run cb -- enroll <code>` (QR in terminal) |
| Passkeys | WebAuthn (SimpleWebAuthn 13), "none" attestation, supports usernameless login. Rejects mismatched origins and replayed responses |
| Signature login | `cb-auth-v1\|user\|nonce\|ts` signed with Ed25519, ECDSA P-256, or an X.509 certificate from the company CA. Single-use nonce (60 s), ts ±60 s. CLI `npm run cb -- login --key` |
| API keys | `cb_<id>_<secret>`, hash only in the database; expiration, revocation, allowed IPs (CIDR v4/v6), per-account rate limit |
| Sessions | Random token in `HttpOnly; SameSite=Strict` cookie (plus `Secure` over HTTPS), hash in the database; idle timeout (12 h) and absolute lifetime (7 days); per-session CSRF token (double submit) |
| Protections | Progressive lockout per username (5 failures → 15 min, doubling up to 24 h), identical error message for non-existent users, per-IP rate limit on login and per-account elsewhere, security headers (CSP, HSTS over HTTPS, X-Frame-Options) |
| Authorization | Single function (`Access`): admin = everything; members = per-vault permissions + own cell; API accounts = permissions bounded by their scopes. The list of readable vaults is the exact same list passed to RLS |
| Admin API | CRUD for users, API accounts, keys, passkeys, public keys, vaults, permissions, sessions; audit search. Cannot delete/suspend/demote yourself or the last admin |
| Audit | Every login (success or failure), every admin and credential change (immediate write); every search and read by API accounts (buffered write, recording result classifications) |
| HTTPS | `scripts/dev-ca.sh`: local CA + server certificate with SAN |

## Verification

- 115 tests total (23 new in `auth`, 11 end-to-end HTTP in `server`), all passing, including repeated runs against the same test database.
- End-to-end over HTTP: all three login methods and recovery codes; enrollment; admin safeguards; a member sees only granted vaults (search, read, graph) and loses access as soon as permission is revoked; an API account sees only its vaults up to its clearance, cannot use the admin API, its reads appear in the audit log, and a revoked key stops working immediately.
- Real server (`npm start`) and CLI (`key gen`, `login --key`) tested against the test database.
- TLS: server presents the local CA certificate with HSTS; without the CA, clients reject it.

## Good to know

1. **TLS-intercepting antivirus.** On this machine, Avast (Web/Mail Shield) intercepts HTTPS connections—even to `localhost` and from Docker containers—and replaces certificates Windows does not trust with an "Avast Untrusted Root". Consequence: browsers and the CLI reject the server until the local CA (`data/tls/ca.pem`) is imported into Windows Trusted Root Certification Authorities; the Node CLI also needs the Avast root or an antivirus exception for the server address. The same applies on corporate machines with similar antivirus software: document in the installation guide.
2. **The master key also protects TOTP secrets.** Without `BRAIN_MASTER_KEY` (or `data/.master-key` in development), nobody can sign in with TOTP anymore: back it up off-server, just like for encrypted documents.
3. **Rate limiting is in-memory**, per process. Multiple server instances will require a shared counter (Postgres or Redis). Login lockout is already in Postgres.
4. **The audit table is not yet partitioned by month** (BRIN index on timestamp). Partitioning and retention arrive with the nightly cycle.
5. `PUBLIC_URL` fixes the passkey RP ID: changing it later invalidates registered passkeys.

# Phase 3 — Ingestion and bulk import

Date: 2026-10-27

## What was built

| Component | Detail |
|---|---|
| Local parsers | `@cb/parsers`: PDF (unpdf, pages, flags `needs_ocr`), DOCX (mammoth + tables), XLSX and CSV (Markdown tables, summary beyond 200 rows), PPTX (slides and notes), EML, MSG, MBOX (quoted replies stripped), HTML (Readability), ZIP (zip-bomb limits), code (symbols as headings), text (UTF-8 / Windows-1252). Format detected from content, not file extension |
| Worker pool | Separate worker threads with per-file timeout: a hung parser cannot stall the server |
| Sources | Per-vault encrypted L0, per-vault hash deduplication, child sources (attachments, ZIP entries) up to depth 4 |
| `ingest` pipeline | Durable task with phases `parse → index → embed → compile`: I1 = chunks and full-text, I2 = embeddings, I3 = compiled pages. Permanent errors → `unsupported` / `failed`, no retries |
| Compiler | Extractive source page (always, no model) + model agent with tools `source_read`, `wiki_search`, `wiki_read`, `wiki_write`. `validate` rejects pages without citations, "Stato attuale" bullets without citations, and citations to unknown sources |
| On-demand compilation | I1/I2 sources frequently returned by search are promoted to I3 (`demand` counter) |
| Links | http/https only, no credentials in URL, DNS checked against private addresses, manual redirects (max 5), 20 MB, 30 s |
| Bulk import | `import` task with scan and store phases, `import_files` table for incremental scanning, include/exclude globs, system files skipped, rate limit, time window, pause/resume/cancel/rescan. Folders restricted under `IMPORT_ROOTS` (real path, no symlink escape) |
| API | Multipart upload, links, source list and detail, original download (people only, never API accounts), reingest, compile now, SSE events; `/api/admin/imports` |
| Network guard | `EgressGuard`: every outgoing connection passes a check (database, model servers, `EGRESS_ALLOW`); downloaded links receive a permit scoped to that single request. Blocked connections are written to the audit log |

## Verification

| Acceptance criterion | Result |
|---|---|
| Test corpus, 20 files across 13 formats | 260 files parsed with no errors, matching expected markers and child sources ([test](../../packages/parsers/test/parsers.test.ts)) |
| Kill during compilation → resume without duplicates | PASS: 72 sources, 7 SIGKILLs, 33 recovered tasks, 0 missing or duplicate pages, shared page has 1 copy and 85 versions ([report](phase3-crash.md)) |
| Import of 1 million files with accurate progress | PASS: 1,000,000 stored, 0 duplicates, 0 errors, all indexed (I1), monotonically increasing progress and matching sums, 134.8 min, 4.4 GB in the database ([report](phase3-import-1000000.md)) |
| No unauthorized outgoing connections | Guard tests (disallowed host blocked, `allowFor` scoped to request), links to internal addresses rejected, real server started with guard active |

Tests: 154 total, all passing (two consecutive runs on the same database).

## Import performance

| Run | Files/s |
|---|---|
| 20,000 files, serial storage | 60 |
| Parallel storage (16 per task), vault version updated outside transaction | 145 |
| 4 worker processes instead of 2 | 128 (no gain: commit is the bottleneck) |
| `synchronous_commit = off` on the worker pool | 535 |
| 1,000,000 files (average) | 125 |

During the 1-million-file import, throughput drops from ~460 files/s (first minutes) to ~90 files/s (last minutes). The root cause has not yet been measured. Hypotheses: growing `tasks` and `task_events` tables (1 task per file), single-partition full-text GIN index receiving all chunks, storage and indexing competing for the same worker slots. To be profiled in Phase 8 (`pg_stat_statements`, `EXPLAIN ANALYZE`); candidate fixes: batched indexing tasks instead of one task per file, cleanup of completed tasks.

## Decisions

1. **Asynchronous commits for workers only.** Task phases are idempotent: if the database stops, the last lost commits are simply replayed. Login, sessions, admin, and audit remain on the synchronous-commit pool.
2. **The source page is extractive.** Every source immediately gets a citable page without invoking a model; the model only adds entity pages, with mandatory citations.
3. **Originals are never exposed to API accounts.** Cloud agents receive compiled text only (invariant 1).

## Not yet implemented

- OCR: images and scanned PDFs are flagged (`ocr_unavailable`, `needs_ocr`), not read.
- Docling (complex PDFs) and readpst (PST) sidecars; legacy `.doc` / `.xls` formats.
- No MSG file generator: the MSG parser does not yet have an automated test.
- Compilation with the real model has not been tested: the model host is powered off. Planned for Phase 6 alongside the retrieval eval.

# Phase 4 — Obsidian-style user interface

Date: 2026-10-28

## What was built

| Component | Detail |
|---|---|
| Login | TOTP, passkeys (including usernameless), recovery code, enrollment with QR and recovery codes. Passkey and session management on the "My account" page |
| Shell | Action bar, sidebar (vaults, inbox, "To review", favorites, recent, folders by type), tabs with per-tab history, two side-by-side panes, detail panel. Workspace state persists in the browser; URL hash reflects the active view (`#/p/<id>`, `#/cerca?q=…`) |
| Keyboard | `Ctrl K` commands, `Ctrl O` open page, `Ctrl Shift F` search, `Ctrl \` split, `Alt ←/→` history, `Ctrl E` edit, `Ctrl S` save, `Alt N` new page, `Alt T`/`Alt W` tabs, `Ctrl B` sidebars. Browser-reserved shortcuts (`Ctrl T`, `Ctrl W`, `Ctrl N`) remain with the browser |
| Reading | `[[links]]` resolved via the links table (including cross-vault links when readable), missing links styled dashed with click-to-create, numbered citations showing the source on hover and opening the source at the cited location, callouts, task lists, heading and block anchors, "Sources" list |
| Detail panel | Outline, backlinks and unlinked mentions (full-text search of title and aliases), local graph (depth 1–2), properties |
| Previews | Hovering a link shows a budgeted read (260 tokens) of the target page; the page is also prefetched |
| Editor | CodeMirror 6 on the full Markdown file, `[[` autocomplete from vault titles and aliases, side-by-side preview, `Ctrl S`; concurrent save returns 409 and lets the user reload or overwrite. Version history with line-by-line diffs |
| Search | Server-side vault and type filters applied before ranking; facets by kind (page/document) and level (I1/I2/I3); matching passage previews; keyboard navigation |
| Graph | Force-directed canvas, zoom, pan, drag, keyboard navigation; vault and type filters; progressive loading (most connected pages first) |
| Source viewer | Original rendered by the browser (PDF, images, text: `?inline=true`, same-origin framing only, sandboxed for images and text) alongside extracted text with the cited passage highlighted; reprocess, compile now |
| Upload | Drag-and-drop anywhere in the window, files or links, vault and classification picker with the cloud-agent notice before submission, upload progress, live document status via server events |
| D1 notices | First-login disclosure (cannot be dismissed without confirmation, confirmation logged in audit), "☁ Readable by cloud agent" badge whenever at least one active API account can read the page, "What the cloud agent read" panel listing reads of pages in the user's cell |
| Server | Routes in `routes/workspace.ts` and reads in `brain/src/browse.ts` (always via `withReader`), migration 008, brotli/gzip compression, 1-year cache on hashed app assets, `robots.txt` disallowing indexing |

## Verification

| Acceptance criterion | Result |
|---|---|
| Playwright tests of primary flows across all 4 themes | 33 tests (8 flows × 4 themes + login), all passing across two consecutive runs: TOTP login and disclosure, wrong code, quick switcher, wikilinks, hover preview, history, faceted search, editing with autocomplete and save, upload with live events, split panes, graph, command palette, axe WCAG 2.1 AA check across 5 views |
| Lighthouse ≥ 90 | Performance 92–99, accessibility 100, best practices 100 across login, home, page, search, graph, and inbox (desktop, paper theme). SEO 63 by design: `robots.txt` excludes an internal app from search engines |
| Perceived page open < 100 ms | 1.6–1.9 ms from click to painted page for a previously visited or hovered page (cache and prefetch); a cold page costs one request (`/api/pages/:id/full`, tens of ms on LAN) with a page skeleton shown immediately |

Tests: 166 unit and database tests (8 new on the Markdown renderer, 4 on workspace APIs), all passing. Initial bundle 248 KB (91 KB compressed); editor (566 KB) and graph (21 KB) load on first open or when the browser is idle.

Screenshots: [docs/ui/](../ui/) (`SCREENSHOTS=1 npm run e2e` regenerates them).

## Issues found by tests and fixed

1. **Cross-vault links.** The engine resolved a `[[link]]` inside the page's own vault; a link from "Technical" to a client in "Clients" stayed unresolved. Reads now resolve these links against titles and aliases of all readable vaults: page view, backlinks, counts, global and local graph.
2. **Quick switcher too fast.** Pressing `Enter` before the server responded opened the row from the previous search. `Enter` now waits for results matching the typed query.
3. **Contrast.** `--text-dim` and link colors in the original themes fell below 4.5:1 for small text (down to 3.19:1 in the night theme). Copied token blocks remain unchanged; `base.css` shifts those colors toward `--text-main` just enough to pass AA in all themes. Redesigned I1/I2/I3 level badges and search-term highlighting.
4. **Search snippets.** The server returns `snippet` with terms wrapped in `«»`; the UI renders them safely (escaped text, then `<mark>`).

## Good to know

1. **Screenshots instead of mockups.** The plan (§9.3) called for mockups to approve before building views. Views were built directly on the Phase 0 design system; real screenshots in `docs/ui/` serve for review.
2. **Side-by-side preview editor**, not inline "live preview" like Obsidian: CodeMirror displays Markdown while the adjacent preview updates as you type.
3. **Embeddings for hand-written pages.** Edited text is immediately searchable by keywords; vectors for editor-modified pages arrive with the nightly cycle (Phase 5), since the indexer currently runs only in the source pipeline.
4. **Signature login** is CLI-only (`npm run cb -- login --key`): browsers have no access to private keys.
5. **Tests use the installed browser.** Playwright uses Edge (`E2E_CHANNEL=chrome` for Chrome): no browser downloaded. Tests run against the development database and clean up their data at the end.
6. **In development**, sources remain at I1: the mock embedding model does not match the configured model identity, and the dispatcher refuses to mix vectors (invariant 3). This is intentional.

# Phase 5 — Hive and nightly cycle

Date: 2026-10-28

## What was built

| Component | Detail |
|---|---|
| Claims | `@cb/hive/claims.ts`: every bullet under "Stato attuale" becomes a claim (`Label: value`, or a quantity such as "250 seats"; anything else is a note that never triggers a conflict). Synonymous labels map to a single predicate (`number of seats` = `seats`); values are normalized (`1.250` = `1250`, wikilinks become plain text). Sync reads only changed pages (`pages.claims_at`) and retracts removed bullets |
| Cells and spaces | `hive_feeds`: defines which cells feed a space and for which page types (default: entity). Configured via `PUT /api/admin/vaults/:id/feeds` |
| Promotion | Cell pages on the same subject are merged by title and aliases. One value → a single line with sources (`· 2 agreeing sources`); multiple values → a `> [!conflict]` block and a curator queue item. Every sentence cites its origin page `^[page#block]`; "Provenance" section lists cells and pages. `privato` (private) pages never leave the cell; the hive page inherits the highest classification of its sources. The page is rebuilt every time from active claims: a retracted fact in a cell disappears from the hive, and a subject with no remaining claims removes the hive page |
| Curator queue | `curator_items`: conflicts, possible duplicates, low-confidence values (below 0.6), contradictions within a cell. A decision (pick a value, enter a custom value, "all are valid") updates the page immediately and carries across subsequent promotions until cell values change—at which point a new item opens. Duplicates are merged from the queue (alias + redirect, no broken links). Requires `curate` permission on the space; every decision is audited |
| Nightly cycle | Durable task per vault and night running the 12 steps from the plan (see below). Each phase call processes a bounded batch and saves step, cursor, and report: a killed worker resumes from the next batch. Runs only within the configured window (`DREAM_WINDOW`, default 22:00–06:00) and per-vault nightly budget (`DREAM_BUDGET_MINUTES`, `DREAM_BUDGET_TOKENS`); otherwise sleeps until the next night and resumes from the same spot |
| Scheduler | A task that wakes at the start of each window: one cycle per vault (cells first, then spaces), never spawns a second cycle for a vault still paused, plus global cleanup (completed tasks older than 30 days, audit entries older than 400 days) |
| Local models | Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B (Q8_0) in `data/models/`, started and supervised by the server with the same llama-server used in Spike D (CPU, 8 threads) |
| UI | "Curator queue" (pick a value, enter a value, keep all; merge duplicates), "Nightly cycle" (report per vault and night, per-step details), "Hive · N cells" badge on hive pages, sources from inaccessible cells displayed as such (not as errors), generated pages read-only |

### The 12 steps

| # | Step | What it does | Model |
|---|---|---|---|
| 1 | `reparse` | Sources parsed by an older parser version → re-ingest | — |
| 2 | `backlog` | Missing vectors (sources and hand-written pages), I3 compilation of demanded sources (`DREAM_COMPILE_PER_NIGHT`) | local embed |
| 3 | `dedup` | Similar titles (trigrams) of the same type: same entity up to legal form → auto-merge; otherwise model judges; if uncertain (< 0.9) → curator queue | chat, JSON |
| 4 | `crosslink` | First unlinked mention of a title or alias → `[[link]]` (never inside code, headings, links, or citations; ambiguous names skipped) | — |
| 5 | `lint` | Sync claims; orphans, broken links, pages older than their sources, contradictions → `_inbox/manutenzione.md` and queue | — |
| 6 | `tldr` | Summary of changed pages missing `tldr`; discarded if it contains numbers not present in the page | chat, JSON |
| 7 | `promote` | Cell → hive promotion (only in spaces with linked cells) | — |
| 8 | `importance` | `ln(1+backlinks) + 0.7·ln(1+30-day reads) + recency` | — |
| 9 | `indexes` | Category index and `llms.txt` (most important pages first) in `vault_indexes`; `GET /api/vaults/:id/index/llms` | — |
| 10 | `database` | `VACUUM (ANALYZE)` on the chunk partition if > 10% dead tuples; `ANALYZE` if older than 7 days | — |
| 11 | `backup` | Read and hash-verify 5 random originals from the encrypted raw store; pgBackRest arrives in Phase 8 | — |
| 12 | `report` | Row in `vault_log` (type `dream`) and `dream_runs` marked done | — |

## Verification

| Acceptance criterion | Result |
|---|---|
| Two cells with agreeing and disagreeing facts → hive page with provenance and open conflict | PASS ([test](../../packages/hive/test/hive.test.ts)): "Postazioni: 250 ^[A] ^[B] · 2 agreeing sources", conflict block on the technical contact with each cell's value, open item in the queue; curator decision applied immediately and preserved; new value in a cell → old decision expires and a new conflict opens; retracted fact → disappears; private pages and unlinked types not promoted; repeated promotion creates no spurious versions |
| Interrupted cycle → resumes the next night | PASS ([test](../../packages/hive/test/dream.test.ts)): with a simulated clock and 60-minute budget, the cycle stops mid-way, sleeps until 22:00 the next day (`dream_runs` paused on the exact step), resumes from there and finishes; completed steps do not repeat (duplicate merged once, link added once, summary written once); report in `vault_log`, indexes generated; space promotes the merged company |

Additional checks: Curator HTTP API (only curators see and decide, merge updates links, linked cells editable by admins only, generated pages reject edits with 409); Playwright tests of the queue across all 4 themes (37 tests total, passing).

Real-model run on demo data: the cell cycle computed vectors with local embeddings and wrote a summary with the 27B chat model (252 tokens); the "Clients" space cycle confirmed 12 hive pages with no new versions and 1 open conflict (the other had been decided in the UI).

## Issues found and fixed

1. **Chat model spent its entire token budget on reasoning.** Qwen3.8 has a reasoning mode: with a 300-token limit it returned an empty answer (`finish_reason: length`); `/no_think` in the prompt is not enough. `ChatRequest.thinking: false` sends `chat_template_kwargs.enable_thinking = false` to llama-server: the summary arrives in 55 tokens. The Phase 3 compiler keeps reasoning enabled.
2. **Lost microseconds.** A `timestamptz` parameter passed through a JavaScript `Date` (millisecond precision): `claims_at` always appeared older than `updated_at`, causing every page to be re-read every night. Timestamps are now passed back to the database as text.
3. **Per-connection trigram threshold.** `set_limit` is connection-scoped: setting the threshold and running the dedup query now stay in the same transaction.
4. **Lost edits.** Hive pages showed an "Edit" button, even though promotion overwrites them: they are now read-only in both the API and the UI.

## Good to know

1. **Deterministic claim extraction.** Works on pages written with the compiler's `Label: value` convention. Free-form sentences become notes and never trigger conflicts. Model-based extraction for free-form text is possible, but would make claims less stable from night to night.
2. **Promotion re-reads all claims of the space** on each batch. Fine up to tens of thousands of subjects; beyond that, a per-subject index and per-subject batching will be needed.
3. **HNSW `REINDEX` and future partitions** are not yet implemented: each vault gets its partition at creation; vector index degradation will be measured in Phase 8.
4. **Demo data**: client sheets now live in the cells of `Nome CognomeBBB` and `Nome CognomeIII`; the "Clients" space receives them via promotion (2 intentional conflicts in `Nome CognomeBBB`'s queue). `npx tsx scripts/dream-now.ts demo-cella` triggers a cycle immediately.
5. **Local configuration updated**: in `.env`, `LOCAL_MODELS_ENABLED=true` and `LOCAL_LLAMA_BIN` point to Docker Desktop's llama-server. Models live in `data/models/` (git-ignored).

# Phase 6 — MCP server, skills, and plugin for the cloud agent

Date: 2026-10-28

## What was built

| Component | Detail |
|---|---|
| MCP server | `@cb/mcp`, mounted at `POST /mcp` (stateless streamable HTTP: each request creates a server bound to the account, any server process can handle it). API accounts only, with Bearer key and `read` scope. Official `@modelcontextprotocol/sdk` 1.32.1 |
| 9 tools | `brain_overview`, `brain_search`, `brain_read` (compiled pages and uncompiled documents, budgeted), `brain_neighbors`, `brain_timeline` (entity or date range), `brain_source` (extracted text of a citation, never the raw file), `brain_ask` (local model answer with citations; citations to unprovided IDs flagged), `brain_capture` (note in `inbox/`), `brain_propose_edit` (proposal queued for curators). Every item reports its token cost; every tool accepts a budget |
| Resources and prompts | `brain://<vault>/index`, `brain://<vault>/llms.txt`, `brain://<vault>/page/<id>`; prompts `cosa-sappiamo-di`, `stato-cliente`, `prepara-riunione` |
| Classification filter | The MCP reader caps clearance at `interno` (`MCP_MAX_CLASSIFICATION`), regardless of the account's own clearance; RLS enforces it a second time. Agent indexes are rendered per reader under RLS: the stored copy built by the nightly cycle (containing all pages) is never served, neither over MCP nor over REST |
| Audit | Reads in the buffered log: `page.read` (feeds "What the cloud agent read"), `search`, `source.read`, `mcp.<tool>`, all tagged `via: mcp`. Writes (`mcp.capture`, `mcp.propose_edit`) and approvals (`curator.apply`) are written immediately |
| Edit proposals | New `proposal` item type in the curator queue (migration 010): line-by-line diff, "Approve and apply" (requires write permission on the vault) or "Reject". If the page changes after the proposal is created, the proposal expires |
| Skills and plugin | `skills/hivevault-query` (workflow: overview → search → budgeted read → neighbors/timeline → source; how to cite; when to say the memory does not know), `skills/hivevault-ingest` with client `scripts/brain.mjs` (Node 18+, zero dependencies); `.claude-plugin/` turns the repository into a cloud-agent plugin registering the MCP server (`$HIVEVAULT_URL/mcp`, key in `$HIVEVAULT_API_KEY`) and skills |
| `llms.txt` | Public `GET /llms.txt`: how to connect and which tools exist (no private data) |
| Demo data | `scripts/seed-demo.ts` creates a key for the `agent-demo` account (read and write, `interno` clearance) in `data/dev-demo.json`, to connect a cloud agent to the dev server |

## Verification

| Acceptance criterion | Result |
|---|---|
| recall@5 ≥ 0.85 | PASS: **0.992** reranking 20 candidates (default), 0.962 with 10. Synthetic corpus (seed 42): 388 documents, 131 questions with expected sources, indexed with the local embedding model; queried via `brain_search` as an API account ([20-candidate report](phase6-eval-rerank20.md), [10-candidate report](phase6-eval-rerank10.md)) |
| Zero `riservato` pages returned at `interno` clearance | PASS: 10 `riservato` (confidential) canary documents loaded in the same vault, API account holding `segreto` (secret) clearance: 0 returned by targeted search or read-by-id, 0 of 131 responses containing items above `interno`. HTTP tests with the official MCP client: `riservato` and `segreto` pages absent from search, read, resources, and `llms.txt` |

| Metric (eval, 131 questions) | 20 candidates | 10 candidates |
|---|---|---|
| recall@5 | 0.992 | 0.962 |
| hit@1 | 0.733 | 0.748 |
| MRR | 0.833 | 0.837 |
| Mean tokens per `brain_search` response | 838 | 857 |
| Median latency (reranker on CPU) | 5.3 s | 2.7 s |

`brain_ask` with the real chat model (Qwen3.8 27B, 30 questions): 90% correct answers (for lists, at least 80% of items), 0 citations to unprovided IDs, 58% of citations contain the expected value, 8.3 s average. The 5 intentional contradictions in the corpus: 5 of 5 answers report both values with their sources, though only 1 flags the conflict explicitly. The 3 wrong answers are list questions (a person's projects) scattered across many documents: for those, the skill directs agents to `brain_neighbors`.

Tests: 181 unit and database tests (3 new files: MCP server with the official client, `llms.txt`, proposals), 41 Playwright tests across all 4 themes (new: approving a cloud-agent proposal from the curator queue).

## Issues found and fixed

1. **Indexes leaking confidential titles.** The index saved by the nightly cycle is built with full privileges: served as-is, it would expose titles and summaries of `riservato` pages to readers without clearance (over MCP and `GET /api/vaults/:id/index/:name`). Indexes are now rendered per reader under RLS; the stored copy is used only for exports and administrators.
2. **Eval scoring.** The first version matched the entire expected sentence ("SQL Server: infrastructure constraint…") and scored 70% correct; matching the key value and list items brings accuracy to 90%. Every full answer is saved for inspection.
3. **Lock exhaustion with many vaults.** The test database had accumulated 1,100 vaults, meaning 1,100 chunk partitions and their indexes: queries across many partitions exhausted the lock table ("out of shared memory", `max_locks_per_transaction` = 64). With one cell per person, production will also have thousands of vaults: `docker-compose.yml` raises the limit to 1024. Test-database creation now tolerates races between test processes.
4. **Scripts not loading `.env`.** `seed-demo`, `dream-now`, and the eval did not load `.env` (only the server entrypoint did), so local models appeared disabled. They now load it as their first import.

## Good to know

1. **Antivirus and local HTTP.** On this machine, Avast Web Shield (`wsc_proxy.exe`) also intercepts HTTP to `127.0.0.1` and rewrites Node server responses: it strips `Content-Length`, adds `transfer-encoding: chunked`, and leaves the body unchunked. Browsers tolerate it, strict clients (Node `fetch`, used by coding agents and the MCP client) do not. The server itself is correct (verified at the socket level); MCP tests use `app.inject`. Using a coding agent against the dev server on this machine requires an antivirus exception for the address. Document in the installation guide alongside the Phase 2 TLS note.
2. **Reranking latency.** The 0.6B reranker on CPU costs ~0.25 s per candidate: with 20 candidates, `brain_search` takes ~5 s. `MCP_RERANK_TOP=10` halves latency for a small recall drop. A reranker on GPU or on a dedicated host (D10) removes the trade-off.
3. **Contradictions.** The model reports conflicting values but rarely states the conflict explicitly; on compiled pages, contradictions are already flagged by the nightly cycle (`[!conflict]`, curator queue), so search + read remains the recommended path for cloud agents.
4. **`npm audit`.** Existing advisories remain in dev dependencies (`vitest`, Svelte plugin, `pptxgenjs` for the corpus generator): none are in the server runtime and fixing them requires major upgrades. Revisit in Phase 8.
5. **Eval compilation.** The eval measures search over indexed documents (I2) without compiling them into entity pages: compiling 388 documents with the 27B model would take hours. Measurements on compiled pages will come from a corpus compiled overnight by the dream cycle.

# Phase 7 — Administration console and dashboards

Date: 2026-11-02

## What was built

| Component | Detail |
|---|---|
| Console (`#/admin/…`) | 11 sections for administrators: users (create with enrollment link, role, clearance, suspend, reset TOTP, revoke sessions, passkeys and signing keys), API accounts (key shown once, rotate, revoke, allowed IPs, expiry), vaults and spaces (settings, cells feeding a space, run dream cycle now, export/import zip, delete with slug confirmation), account × vault permission matrix, sources across all vaults (retry, compile, delete including child files and encrypted originals), bulk imports, tasks (counts, journal, retry, cancel), models, searchable audit log, settings, backups. Every change is written immediately to the audit log |
| "Models" page | Status, latency, items/s, requests, and errors for each dispatcher endpoint; endpoint probe (health, model identity, minimal request); per-priority queues. Local processes: start, stop, restart, logs; thread count and schedule (always, time window, on demand) applied without restarting the server. Remote endpoints added and removed from the console (saved in settings, allowed by the egress guard) |
| Settings | `settings` table (migration 011) overriding `.env` values: dream cycle window and budgets (read on each step and scheduler wakeup), default classification for new vaults, cloud-agent disclosure text, local processes, remote endpoints |
| Page history | "Restore this version": the chosen version becomes a new version while keeping history intact (`POST /api/pages/:id/restore`, audit `page.restore`) |
| Metrics | In-process registry (`@cb/shared`: counters, gauges, ms histograms). Every minute each process flushes its slice to `metrics_1m` (daily partitions, 14-day retention). A single leader process elected via advisory lock samples gauges (host, database, tasks, sources, models, logins; partitions and memory health every 15 minutes) and computes `metrics_1h` (400-day retention) and `metrics_1d` rollups. Instrumented: HTTP, search by branch, dispatcher, task phases, document reads, dream cycle, promotions, audit, blocked egress |
| Panel queries | `POST /api/admin/metrics/query` (up to 40 queries per request). The server selects the table from the time range (up to 36 hours at 1-minute resolution, up to 45 days at 1-hour, then daily) and returns ~300 points per series. Aggregations: rate, sum, avg, max, min, last, count, plus p50, p95, p99 percentiles from histogram buckets. Tabular panels use `GET /api/admin/stats/:name` (slow queries from `pg_stat_statements`, partitions, coverage, parser errors, dream runs, hive, health lists, security) |
| Dashboards (`#/dashboard/…`) | All 10 from §8.4: Overview, Ingestion & import, Search, Memory health, Hive, Dream cycle, Models, Database, Logins & security, Host. Global time range (1 hour to 90 days), auto-refresh, `$spazio` variable, 12-column grid with movable and resizable panels (mouse or keyboard, per-user layout persistence), table view for every chart, thresholds with icon and label, links into filtered console lists |
| Charts | Custom SVG using theme tokens: single zero-based axis, 2 px lines, gaps for missing data, crosshair and tooltip, legend toggling series without shifting colors of remaining series, max 6 colored series (remainder grouped into "Other"). Series 4–6 extend the original 3; the palette check script verified them across all 4 themes (lightness, chroma, color-blind separation, contrast) |
| Prometheus | `GET /metrics` with `METRICS_TOKEN` (Bearer) or an admin session: cumulative counters, gauges, histograms with `le` buckets |

## Verification

| Acceptance criterion | Result |
|---|---|
| Every entity manageable from the UI | PASS: users, API accounts, keys and passkeys, sessions, vaults and spaces, hive feeds, permissions, sources, imports, tasks, pages (edit, history, restore, merge from queue), curator queue, local and remote models, settings, backups, and exports. Playwright tests across all 4 themes: creating an API account with key shown once, toggling a permission in the matrix, saving settings, opening every section |
| Smooth dashboards with 7 days of 1-minute data | PASS: 7 days at 1-minute granularity across 264 series (1,665,183 rows, 269 MB including rollups; writes at 52,000 rows/s, 7-day hourly rollup in 3.9 s). Benchmark executes all queries of a dashboard concurrently, matching the UI: worst median **129 ms** (Ingestion, 24 h at 1-minute), worst p95 137 ms; at 7 days max 72 ms, at 30 days max 20 ms. Report lives in `bench/out/` (not tracked); `npx tsx bench/phase7/metrics-bench.ts` repeats the run |

| Range (10 dashboards) | Table | Worst median | Worst p95 |
|---|---|---|---|
| 1 hour | `1m` | 30 ms | 33 ms |
| 24 hours | `1m` | 129 ms | 137 ms |
| 7 days | `1h` | 58 ms | 72 ms |
| 30 days | `1h` | 20 ms | 20 ms |

Tests: 191 unit and database tests. New: registry, quantiles, flush, rollup and query, leader election; console API executing every panel against the real schema, Prometheus, tasks, settings, models, source deletion, vault export/import; version restore. 58 Playwright tests across all 4 themes. New: console, dashboard with a panel moved by keyboard and layout persisted, axe WCAG 2.1 AA across 7 console and dashboard views.

## Issues found and fixed

1. **Double-encoded labels.** Series labels passed as `jsonb[]` arrived as JSON strings inside JSON. Now passed as `text[]` and cast in SQL.
2. **Blank page after a rebuild.** An open tab requested a JavaScript asset from the previous build. The server replied with the SPA HTML page and the browser stalled. Missing files (paths with a file extension) now return 404.
3. **Console inside the main bundle.** Console and dashboards added 130 KB to every user's load. They now lazy-load only when an administrator opens them: the main bundle drops from 398 to 270 KB.
4. **Dashboard horizontal space.** At 1440 px, the grid had only 574 px left (sidebar, right panel, dashboard list). Because the right panel shows outline and links for the active page, it no longer opens on console and dashboard views. The grid adapts to 6 or 1 column on narrow viewports.
5. **Badge contrast.** Colored text on soft backgrounds dipped to 4.3:1 in the Paper theme. Text now uses the standard text color; semantic color stays in the background and a status dot.
6. **Date-coupled dream-cycle test.** The test hardcoded the night of October 28, 2026: after that date, the engine woke the paused task immediately. The test now uses a night in the following year.

## Good to know

1. **`/metrics` reports a single process.** Prometheus scrapes the counters of whichever process handles the request. With multiple processes, scrape each process individually or use the dashboards, which aggregate across all processes from the database.
2. **Host network stats are Linux-only.** The "Network" panel reads `/proc/net/dev`: on Windows (development), it is empty.
3. **Continuous database backup.** The "Backup" page exports vaults to Markdown and shows storage usage. pgBackRest and point-in-time recovery arrive in Phase 8.
4. **Development administrator.** `npx tsx scripts/dev-admin.ts` creates `admin` and writes the TOTP secret to `data/dev-admin.json` (git-ignored).

# Phase 8 — Hardening and release

Date: 2026-11-02

## What was built

| Component | Detail |
|---|---|
| Security review | OWASP ASVS 4.0.3 Level 2, chapter by chapter, with evidence for each requirement: [docs/security/asvs-l2.md](../security/asvs-l2.md). 7 issues found and fixed (below) |
| Backups | PostgreSQL image with pgBackRest (`docker/postgres`): continuous WAL archiving (at most 5 minutes of data loss), AES-256 encrypted repository with zstd compression, 2 full backups retained. `npm run backup -- stanza\|full\|diff\|info\|check\|verify` |
| Verified restore | `npm run backup -- verify`: point-in-time recovery into a temporary container and volume, data verification, cleanup. Monthly timer included in the installer script |
| Load test | k6 (official `grafana/k6` image), 40 users for 3 minutes: search, budgeted read, full page, recent (`bench/phase8/`) |
| Profiling | `pg_stat_statements` and `EXPLAIN ANALYZE`: two UI lists fixed with partial indexes (migration 012) |
| Remote model host | Embedding (port 8080) and rerank (port 8081) connected with API key, verified by the dispatcher (same model as stored vectors) and benchmarked (`bench/phase8/models-hosts.ts`) |
| Installation | `scripts/install.sh`: preflight checks, `.env` with random secrets, build, database, backup, systemd service, and backup timers |
| Documentation (ASD-STE 100) | [installation](../guides/installation.md), [operator](../guides/operator.md), [administrator](../guides/administrator.md), [user](../guides/user.md) |
| Release checklist | [docs/RELEASE.md](../RELEASE.md): development items verified, deployment items to check off on the production server |

## Verification

| Acceptance criterion | Result |
|---|---|
| Complete release checklist | PASS for development items (quality, security, performance, backups): all verified with the listed command or test. Deployment items (HTTPS, keys copied off-server, backup repository on a separate disk) are checked off on the production server |

| Metric | Result | Target (plan §0.2) |
|---|---|---|
| Hybrid search without rerank, uncached, 40 users | **p95 153 ms** (233 searches; median 112 ms) | < 200 ms |
| Budgeted page read, 40 users | **p95 14 ms** (3,225 reads) | < 20 ms |
| Full page / recent | p95 20 ms / 14 ms | — |
| Cached search | p95 12 ms | — |
| HTTP errors under load | **0** out of 7,970 requests (35 req/s) | < 1% |
| Full backup of dev database (5.4 GB) | 15 s, 1 GB encrypted and compressed | — |
| Point-in-time recovery | **11 s** restore, 26 s total; pre-target marker present, post-target marker absent; row counts across 7 tables identical (1.1M sources and vectors), 0 orphan pages | identical data |
| Inbox / "To review" (1.1M sources) | from 95 / 77 ms down to **0.15 / 0.02 ms** | — |

| Model host (same 0.6B Q8_0 models) | Embedding (300–400-word chunks) | Rerank of 20 candidates (median) |
|---|---|---|
| Remote host (CPU) | 2.5 chunks/s | 2.0 s |
| This PC (local processes, CPU) | 1 chunk/s | 5.1 s |

Tests: 193 unit and database tests (new: log redaction, private-only model endpoints, zip bomb, headers and `no-store`, search across vaults indexed by another model, MCP tool schemas with zod 4), 58 Playwright tests across all 4 themes.

## Issues found and fixed

1. **Search failed when any vault was indexed by a different model.** The first load test produced 100% errors on search: 7 vaults from Phase 3 benchmarks held 1.1M vectors from the mock model (16 dimensions) and search compared the query vector (1024 dimensions) against them too. The same would happen in production after an embedding-model upgrade until old vectors are recomputed. Vector branches now compare only vectors produced by the query's model (invariant 3). The model name must be normalized the same way the indexer does: otherwise the filter silently excludes every vector. A regression test reproduces the failure (fails with the exact error without the fix).
2. **Model endpoints pointing to the public Internet.** An administrator could add a public-IP endpoint from the console, sending document text outside the network (invariant 1). Endpoint hostnames must now resolve exclusively to private addresses.
3. **Zip bomb in vault import.** Previously had no cap on uncompressed size; now enforces 50,000 files, 50 MB per file, and 2 GB total, counted during decompression.
4. **Restore failed on the first attempt.** The restore drill uncovered two procedure bugs: the restored server reads WAL from the repository and needs both the passphrase and the repository volume; and recovery rejects lower settings (`max_connections`, etc.) than the original server. Both the script and the operator guide now handle this.
5. **Two UI lists scanned the entire `sources` table** on every open (Inbox and "To review", parallel scan of 1.1M rows). Added partial indexes matching each list's sort order; for single-vault users, the plan stays on the vault index (verified).
6. **Minor security fixes**: API responses could be cached by browsers (`no-store` added), `Permissions-Policy` and CORP were missing, the logger could emit secrets (now redacted), `/metrics` token comparison was not constant-time, `zod` had a high-severity advisory (upgraded to 4.6.7, tool schemas verified).
7. **Local reranker 512-token batch limit.** Longer query + document pairs failed; search only sends title and snippet (much shorter), but the local reranker now uses the same batch size as the embedding process (2048).
8. **Race condition in end-to-end test.** The permission matrix saves immediately; the test reloaded the page before the server responded and failed in 1 of 4 themes. Now awaits the response.

## Good to know

1. **Backup repository on the same disk.** In development, the `pgbackrest` volume lives on the same disk as the database. In production, mount it on a separate disk or add a second repository (`repo2`): checklist item 4.3.
2. **First search after restart.** The first search on each connection prepares plans and statements and warms up the model: 2–3 s once, then 50–110 ms.
3. **Benchmark data in the development database.** The 7 `crash3-…` and `imp3-…` vaults (Phase 3) still hold mock-model vectors: they no longer break search, but add ~40 ms to searches for users who can read them (sequential scan of their partitions). They can be deleted from the console.
4. **Migration 012 indexes on large tables.** The migration runs inside a transaction: on tens of millions of sources, index builds block writes. In that case, create them manually beforehand with `CONCURRENTLY` (instructions in the migration file).
5. **Dependencies with moderate advisories.** 9 advisories in two unreachable chains (`glob` in `@fastify/static`, `archiver` in `exceljs`): rationale in the ASVS review, recheck on every release.
6. **24-hour continuous ingestion.** Skipped in this phase by request; the Phase 3 benchmark (crash test and 1-million-file import) remains the reference measurement.
7. **Model host credentials.** The server only talks to the remote host's HTTP endpoints using the API key in `.env`; SSH access is not needed.
