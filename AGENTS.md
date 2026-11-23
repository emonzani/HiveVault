# AGENTS.md — HiveVault

Rules for AI coding agents that develop this repository.
The full plan is in [docs/PIANO_DI_SVILUPPO.md](docs/PIANO_DI_SVILUPPO.md). Read it before a large change.

## 1. Identity

HiveVault is a self-hosted server for the memory of a company, organized as a **hive memory**:
one vault for each cell (person, edge, team, project) and shared hive spaces above them.
Knowledge is **compiled** into linked Markdown pages (LLM-Wiki pattern) and is optimized for cloud agents (MCP, token budgets, stable citations).

Durable tasks, workflows and the wiki are our own implementation. Do not add external agent-framework dependencies for them.

## 2. Invariants

1. **Documents stay local.** Original files (L0) never leave the server. Parsers, embeddings, reranking and compilation use local models only. Only the compiled text of pages classified `pubblico`/`interno` can reach the cloud agent through MCP, filtered by the clearance of the API account.
2. **One model dispatcher.** Every model call goes through `@cb/models` `ModelDispatcher`. Never call llama-server directly. The chat endpoint has parallelism 1.
3. **Same embedding model everywhere.** The dispatcher checks the model of every embedding endpoint (local and remote). Every stored vector records its `embedding_model`.
4. **Host isolation.** A server is changed only through `scripts/deploy.sh`. Model hosts are used only through their HTTP endpoints (chat, embedding, rerank): do not modify their files, models or llama-server processes and configuration.
5. **Durable work.** Long work is a task of `@cb/tasks`: phases with checkpoints, idempotent `requestId`, effects journaled before they run. Do not use in-memory queues for work that must survive a restart.
6. **ACL before ranking.** Queries select the allowed vaults first (partition pruning), Row Level Security is the second defense. Never filter results after ranking.
7. **SQL is explicit.** No ORM. Migrations are numbered SQL files in `packages/db/migrations/`.
8. **Reads for users and API accounts go through `withReader`** (`packages/brain/src/access.ts`): role `cb_reader`, vaults and clearance set for RLS. System jobs write as the owner role.
9. **Vector index expressions are fixed.** Queries must use `vecExpr` / `binExpr` from `vaults.ts`, or Postgres does not use the per-partition indexes.
10. **One authorization function.** Routes call `requireAction` / `Access.can`; the readable vault list for the engine comes from `Access.toReader`, never from request input alone.
11. **Security events are audited at once** (`audit.writeNow`): logins, admin changes, credential changes. API reads use the buffered `audit.write`.
12. **Every outgoing connection passes the egress guard** (`EgressGuard` in `packages/shared`). New outgoing traffic needs an allowed host, or `allowFor` around one user-requested download (links), never a global exception.
13. **Model-written pages must cite.** The compiler refuses a page without citations or with citations to unknown sources; do not relax `Compiler.validate`.
14. **The web app never renders raw HTML from content.** Pages, snippets and previews go through `renderMarkdown` (`html: false`) or are escaped before `{@html}`. The Content-Security-Policy blocks inline scripts: no inline `<script>` in `index.html`.
15. **The hive is rebuilt, never edited.** Hive pages (`hive_subject`) and `_inbox/` pages are written by the dream cycle; the API refuses edits. Private pages (visibility `privato`) are never promoted, and a hive page gets the highest classification of its sources. Every promoted statement cites its page `^[page#block]`.
16. **MCP never returns more than "interno".** `readerOf` caps the clearance at `MCP_MAX_CLASSIFICATION` whatever the account has; generated indexes are rendered under the reader's clearance (`renderIndexes` inside `withReader`), never served from the stored copy. The cloud agent never writes directly: `brain_capture` and `brain_journal` write only to an inbox, `brain_propose_edit` waits for a person. The one direct channel is the project documentation of coding agents (`routes/projects.ts`): an API account with the scope `projects`, only the six pages under `progetto/` of vaults owned by `project:<slug>`, with a version check and an audit row per write. With `read` too, the same key uses MCP and `brain_capture` writes into the inbox of project vaults (as a source for ingestion by default); `requireAction` refuses every other write of a key without `write` or `ingest`. A key bound to a user (`principals.user_id`) never reaches more than that user, and not the user's personal vaults (`Access.apiContext`).
17. **Large automatic changes ask first.** A change that removes or rewrites more than a fifth of a vault (`isMassChange`) does not run by itself: the dream cycle opens a curator item `mass_change`, an import needs a second confirmation and saves a checkpoint first.
18. **Metric labels are bounded.** Use route templates, statuses, task names, endpoint ids, vault ids of hive spaces, the top partitions: never page ids, user ids, queries or free text. The registry stops at 5000 series. Panels read metrics through `MetricsStore.query`; ad-hoc SQL on `metrics_*` is for the benchmark only.
19. **"personale" (classification 4) belongs to its owner.** It exists only in personal vaults (owner `user:<id>`) and only the owner reads or sets it: RLS lets it through only for `cb.personal` (`Principal.personal`, filled by `Access.toReader`). Administrators never see it: every route or job that reads content as the owner role (console lists, exports, imports, checkpoints, merges, stats, stored indexes, claims, crosslinks) excludes `classification = 4`. A deleted user's personal content is deleted (`IngestService.purgePersonal`); the rest goes to a team. See `docs/sicurezza/privacy.md`.
20. **The audit log is append-only.** No UPDATE, no TRUNCATE, security events kept at least 183 days, hash chain over them (migration `014_privacy.sql`, `verifyAuditChain`). Read events (`cb_audit_is_read`) stay outside the chain with their own retention.

## 3. Code map

| Path | Content |
|---|---|
| `packages/shared` | config from env, ULID ids, token estimate, logger |
| `packages/db` | Postgres client, migration runner, migrations |
| `packages/models` | model dispatcher (priorities, aging, multi-endpoint; kinds chat, embed, rerank, ocr), llama-server provider (OCR: page images as data URLs, `<PAGE>` markers), mock provider, local process supervisor |
| `packages/tasks` | durable task engine on Postgres |
| `packages/blobs` | raw store (L0): content-addressed, AES-256-GCM per vault, streaming |
| `packages/brain` | memory engine: vaults (one chunk partition each), pages (versions, aliases, blocks, links; a compiled page wins a name over a source page), other names of pages (`names.ts`: short forms of standards, document codes), Markdown model and structural chunker, embedding indexer, hybrid search, budgeted reading, graph neighbors, reads for the UI (`browse.ts`), Obsidian export/import, vault checkpoints and the mass-change rule (`checkpoints.ts`) |
| `packages/auth` | principals (users, API accounts, teams with members), TOTP (RFC 6238), passkeys (WebAuthn), signature login (Ed25519 / P-256 / X.509), API keys, sessions, lockout, authorization (`Access`), audit log |
| `packages/server` | Fastify app (`buildApp`), routes `/api/auth`, `/api/me`, `/api/admin`, `/api/search`, `/api/pages`, `/api/projects` (project documentation of coding agents), sources, imports, web interface (`routes/workspace.ts`), console operations and metrics (`routes/ops.ts`, `GET /metrics`); `ops/`: console settings (`settings` table over env), models page, gauge collectors; serves the built web app; CLI `cb` |
| `packages/parsers` | local parsers (PDF, DOCX, XLSX, PPTX, CSV, EML, MSG, MBOX, HTML, ZIP, code, text, images), format detection by content, worker-thread pool (also renders PDF pages for OCR, `render.ts`) |
| `packages/ingest` | source store (encrypted L0, child sources), durable ingestion pipeline I1/I2/I3 (with an OCR phase for scans), compiler (extractive page + model agent with vault tools), links with SSRF check, bulk import from folders |
| `packages/hive` | claims from the "Stato attuale" (`claims.ts`), promotion cell → hive with provenance and conflicts (`promote.ts`), curator queue (`curator.ts`), vault maintenance (`maintenance.ts`), rectification of generated pages by administrators (`rectify.ts`), durable dream cycle and its scheduler (`dream.ts`) |
| `packages/metrics` | metrics of the dashboards: `MetricsStore` (`metrics_1m` partitioned by day, rollups `metrics_1h` / `metrics_1d`, queries with percentiles from histogram buckets), `MetricsService` (writes the in-process registry every minute; one leader by advisory lock samples the gauges and rolls up), host probe. The registry is `metrics` in `@cb/shared` |
| `packages/mcp` | MCP server (`server.ts`: tools, resources, prompts) and the 11 tools as plain functions (`tools.ts`, reused by the eval); mounted at `POST /mcp` by `packages/server/src/routes/mcp.ts` |
| `packages/web` | Svelte 5 SPA: `src/app` (shell, views), `src/lib` (API client, workspace with tabs and panes, safe Markdown renderer, caches, translations `i18n.ts` + `i18n/*.json`), `src/styles/tokens.css` (themes "chiaro" and "scuro" of the Editorial Knowledge design system; values checked at 4.5:1), `src/app/SourceInspector.svelte` (right panel of the inbox); Playwright tests in `e2e/` |
| `docker/postgres` | PostgreSQL 17 + pgvector + pgBackRest image; WAL archiving to an encrypted repository (`scripts/backup.ts`) |
| `docs/guide`, `docs/sicurezza`, `docs/RILASCIO.md` | installation, operator, admin and user guides (ASD-STE 100); OWASP ASVS L2 review; GDPR and Italian law compliance with checklists (`privacy.md`); release checklist |
| `bench/corpus` | deterministic synthetic corpus generator with ground truth |
| `bench/spike-*`, `bench/phase*` | spikes and benchmarks; reports in `docs/spikes/` |
| `skills/`, `.claude-plugin/` | agent skills and the agent plugin (MCP server + skills) |

## 4. Work rules

- TypeScript strict, ESM, relative imports with the `.ts` extension. Run with `tsx`.
- Before you finish: `npm run lint` and `npm test` must pass. Report failures with their output.
- After a change to the web app: `npm run check -w @cb/web` and `npm run e2e` (both themes, includes an axe WCAG 2.1 AA check).
- Database tests need `npm run db:up`. They skip themselves when Postgres is not reachable, and say so.
- UI text is written in Italian, the source language, and wrapped in `t("...")` (or `tHtml` for one sentence with `**bold**`, `[key]`, `` `mono` ``) from `packages/web/src/lib/i18n.ts`. The key is the Italian text and must be a string literal. The page language comes from the browser (it, en, fr, de, es, pt; fallback en). A new or changed text needs its translation in the five catalogs `packages/web/src/lib/i18n/*.json`: `test/i18n.test.ts` fails on a missing key, an extra key or a changed placeholder. Dates and numbers use `intlLocale`, never a fixed `"it-IT"`. Code, comments and identifiers are in English.
- Official documentation follows ASD-STE 100 (short sentences, active voice).
- Do not commit secrets. `.env` and `data/` are ignored.
- Never log secret values: the logger redacts known field names (`redact` in `packages/shared/src/log.ts`); do not put secrets in other field names or in messages.
- A change to `docker-compose.yml`, migrations or backup settings: run `npm run backup -- verify` before you finish.
