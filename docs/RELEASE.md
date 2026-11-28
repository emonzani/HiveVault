# Release Checklist

Complete every item before deploying HiveVault to production and before every major upgrade. Items marked **[D]** are development checks verified on the codebase by the team. Items marked **[I]** are installation checks verified on the production server by the operator.

Status: development check on 2026-11-02 (Phase 8). Items marked **[I]** must be completed for every installation.

## 1. Code quality [D]

| # | Item | Command or evidence | Result |
|---|---|---|---|
| 1.1 | Type check across all Node packages | `npm run lint` | ✅ |
| 1.2 | Type check for the web interface | `npm run check -w @cb/web` | ✅ |
| 1.3 | Unit and database tests | `npm test` | ✅ (see the Phase 8 report) |
| 1.4 | End-to-end tests across all 4 themes, with axe WCAG 2.1 AA | `npm run e2e` | ✅ |
| 1.5 | Production dependencies free of high or critical vulnerabilities | `npm audit --omit=dev` | ✅ 0 high; unreachable moderate advisories documented in [asvs-l2.md](security/asvs-l2.md#v10--malicious-code-and-dependencies) |
| 1.6 | No secrets in the repository | `git grep -nE "BEGIN [A-Z ]*PRIVATE KEY\|cb_[A-Za-z0-9]+_[A-Za-z0-9_-]{20,}" -- . ':(exclude)package-lock.json'` empty; `.env`, `data/`, `bench/out/` ignored. Signature-login test keys are not stored in the repository: `packages/auth/test/fixtures/generate.ts` generates them with OpenSSL before tests | ✅ |

## 2. Security [D]

| # | Item | Evidence | Result |
|---|---|---|---|
| 2.1 | OWASP ASVS 4.0.3 Level 2 review | [docs/security/asvs-l2.md](security/asvs-l2.md) | ✅ 7 issues found and fixed; remaining open items are installation-only |
| 2.2 | Original documents never leave the network | Egress guard, private-only model endpoints (tested) | ✅ |
| 2.3 | Cloud agent never reads above "internal" (`interno`) | `mcp.e2e.test.ts`, Phase 6 eval | ✅ |
| 2.4 | Security headers and `no-store` on API responses | `workspace.e2e.test.ts` | ✅ |

## 3. Performance [D]

| # | Item | Target (plan §0.2) | Result |
|---|---|---|---|
| 3.1 | Hybrid search without rerank under load | p95 < 200 ms | ✅ 153 ms (uncached searches, 40 users, k6) |
| 3.2 | Token-budgeted page read | p95 < 20 ms | ✅ 14 ms (3,225 reads, 40 users) |
| 3.3 | Dashboards with 7 days of 1-minute data | responsive | ✅ worst median 129 ms (Phase 7) |
| 3.4 | Slowest queries profiled | `pg_stat_statements`, `EXPLAIN ANALYZE` | ✅ Inbox and "To review" reduced from 95/77 ms to 0.15/0.02 ms (migration 012); search filtered by embedding model |

## 4. Backup and restore

| # | Item | Command | Result |
|---|---|---|---|
| 4.1 [D] | Continuous WAL archiving active | `npm run backup -- check` | ✅ |
| 4.2 [D] | Point-in-time recovery verified | `npm run backup -- verify` | ✅ 11 s restore, identical data |
| 4.3 [I] | Backup repository on a separate disk or secondary repository | `docker/postgres/pgbackrest.conf` | ☐ |
| 4.4 [I] | Backup timers active | `systemctl list-timers 'hivevault-*'` | ☐ |
| 4.5 [I] | Restore verification run on the production server | `npm run backup -- verify` | ☐ |
| 4.6 [I] | Original documents (`data/blobs/`) included in company file backup | company backup tool | ☐ |

## 5. Installation [I]

| # | Item | Reference | Result |
|---|---|---|---|
| 5.1 | HTTPS with valid certificate; `PUBLIC_URL` uses `https://` | [installation §7](guides/installation.md#7-https) | ☐ |
| 5.2 | `.env` with random secrets and mode 600 | `scripts/install.sh` | ☐ |
| 5.3 | Master key and backup passphrase copied off the server | [installation §5](guides/installation.md#5-copy-the-keys-off-the-server) | ☐ |
| 5.4 | PostgreSQL and pgbouncer not exposed beyond `127.0.0.1` | `docker-compose.yml` (`127.0.0.1:` port bindings) | ☐ |
| 5.5 | First administrator created, recovery codes safely stored | `npm run cb -- admin create` | ☐ |
| 5.6 | Model endpoints active and running the same embedding model | Console → Models → Test | ☐ |
| 5.7 | `MODELS_API_KEY` set for model hosts | `.env` | ☐ |
| 5.8 | Long, random `METRICS_TOKEN` set (if using Prometheus) | `.env` | ☐ |
| 5.9 | Cloud agent notice reviewed and tailored to the company | Console → Settings | ☐ |
| 5.10 | Nightly cycle window aligned with company working hours | Console → Settings | ☐ |

## 6. Post-startup [I]

| # | Item | Result |
|---|---|---|
| 6.1 | Dashboard → Overview: no critical panels after 1 hour | ☐ |
| 6.2 | First nightly cycle completed (Nightly cycle: "Completed") | ☐ |
| 6.3 | A test user signs in, searches, uploads a document, and sees it reach "Searchable" | ☐ |
| 6.4 | Cloud agent connected via API account: `brain_search` returns results with citations | ☐ |

## 7. Breaking changes [I]

Read this section before upgrading. Each item explains what stops working and what action to take.

| # | Change | Action | Result |
|---|---|---|---|
| 7.1 | Signature sign-in: the client now signs `cb-auth-v2\|<origin>\|<username>\|<nonce>\|<ts>`. The server rejects the legacy `cb-auth-v1` message with `signature_outdated` and does not open a session | Update the CLI and every edge device using signature sign-in. Each client must sign the origin matching `PUBLIC_URL` or `WEBAUTHN_EXTRA_ORIGINS`. After upgrading, search the audit log for `login.signature.outdated`: each event identifies a client that still needs upgrading ([administrator guide](guides/administrator.md#signature-sign-in-command-line-and-edge-devices)) | ☐ |
