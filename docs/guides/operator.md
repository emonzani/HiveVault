# Operator Guide

This guide is for the person who operates the server: service management, backups, restores, updates, and monitoring. To install the server, read the [installation guide](installation.md).

## 1. Service

| Action | Command |
|---|---|
| Status | `systemctl status hivevault` |
| Logs | `journalctl -u hivevault -f` (one JSON line per event) |
| Restart | `sudo systemctl restart hivevault` |
| Database | `docker compose ps` (`postgres` and `pgbouncer` services) |

The server stops tasks cleanly on `SIGTERM`. Durable tasks (document parsing, bulk imports, nightly cycle) resume from their last saved phase after a restart. You do not need to pause work before restarting.

Logs never contain secrets: tokens, codes, keys, and cookies are replaced with `[nascosto]`.

## 2. Backups

### 2.1 What to back up

| Data | Location | Method |
|---|---|---|
| Database (pages, metadata, vectors, users, audit) | `pgdata` volume | pgBackRest: continuous WAL archiving + full and differential backups |
| Original documents (encrypted) | `data/blobs/` | File copy using the company backup tool (already encrypted, including filenames: §4.4) |
| Master key | `data/.master-key` | Offline copy, once (see installation, §5) |
| Configuration | `.env` | Offline copy, after every change |
| Vault exports | `data/exports/` | Optional: readable Markdown without the server |

### 2.2 pgBackRest

The database archives WAL continuously to the pgBackRest repository (`pgbackrest` volume, encrypted with AES-256). With `archive_timeout=300`, at most 5 minutes of changes can be lost.

Systemd timers run:

| Timer | Schedule | Command |
|---|---|---|
| `hivevault-backup-full` | Sunday 02:30 | `npm run backup -- full` |
| `hivevault-backup-diff` | Monday–Saturday 02:30 | `npm run backup -- diff` |
| `hivevault-backup-verify` | 1st of every month, 04:00 | `npm run backup -- verify` |

The repository keeps 2 full backups and the WAL between them: roughly 2 weeks of point-in-time recovery.

**The repository is on the same server.** To survive disk failure, mount the `pgbackrest` volume on a separate disk, or add a second repository (`repo2`, company S3 or SFTP) in `docker/postgres/pgbackrest.conf`.

Check backup status:

```bash
npm run backup -- info
npm run backup -- check
systemctl list-timers 'hivevault-*'
```

### 2.3 Restore verification test

```bash
npm run backup -- verify
```

The command:
1. writes a marker in the database and runs a differential backup;
2. records a timestamp, then writes a second marker;
3. restores the backup into a temporary container and volume up to that timestamp;
4. verifies that the first marker is present, the second is absent, and row counts across 7 tables match;
5. removes the temporary container and volume.

The report is saved to `bench/out/backup-verify-<id>.json`. The monthly timer runs this test automatically. If it fails, `hivevault-backup-verify` enters `failed` state: check with `systemctl --failed`.

## 3. Restore

### 3.1 Full restore (lost disk or corrupted database)

1. Stop the server: `sudo systemctl stop hivevault`.
2. Stop the database. If the data volume still exists, copy it before restoring: keep the copy until you verify the restore.

   ```bash
   docker compose stop postgres
   docker run --rm -v hivevault_pgdata:/from:ro -v hivevault_pgdata_old:/to alpine sh -c 'cp -a /from/. /to/'
   ```

3. Restore (latest available state). `--delta` rewrites only files that differ from the backup:

   ```bash
   docker compose run --rm -u postgres postgres \
     pgbackrest --stanza=brain --delta restore
   ```

   For point-in-time recovery, add `--type=time --target="2026-11-02 10:30:00+01" --target-action=promote`.

4. Start the database: `docker compose up -d postgres`. PostgreSQL replays the WAL and starts accepting connections.
5. Verify: run `npm run db:migrate` (no pending migrations) and sign in to the web interface.
6. Start the server: `sudo systemctl start hivevault`.
7. Immediately take a full backup: `npm run backup -- full`.

The restored server must have equal or higher settings than the original for `max_connections`, `max_locks_per_transaction`, `max_worker_processes`, `max_wal_senders`, and `max_prepared_transactions`. `docker-compose.yml` already sets these values.

### 3.2 Restoring a single vault

Use a restore point: **Console → Vaults and spaces → vault → Restore points → Restore**. All pages return to that moment; the current state becomes a new automatic restore point so you can undo.

Without a restore point, use a Markdown export: **Import zip**. Pages with the same path receive a new version. Version history remains intact.

### 3.3 Restoring a single page

**Page → History → version → Restore this version**. The chosen version becomes a new version.

## 4. Updates

### 4.1 With the deploy script (recommended)

`scripts/deploy.sh` updates the server from a development workstation over SSH using key authentication. The code arrives as a commit archive: neither git nor a remote repository is needed on the server.

```bash
bash scripts/deploy.sh                    # update to the current commit
bash scripts/deploy.sh --status           # releases on the server, service, health
bash scripts/deploy.sh --rollback         # roll back to the previous release
```

Options: `--target user@host` (required; alternatively set `DEPLOY_TARGET=user@host`), `--ref <commit>`, `--keep <n>` retained releases (default 3).

On the server, the script:
1. unpacks the release into `~/hivevault/releases/<commit>`;
2. installs dependencies and builds the web interface while the current version stays online;
3. takes a differential backup (restore point);
4. updates the database image if it changed;
5. stops the service, applies migrations, switches the `current` symlink, and restarts;
6. checks `/api/health`. If the server does not respond within 2 minutes, it automatically rolls back to the previous release.

`.env` and data live in `~/hivevault/shared/` and persist across releases.

Rolling back does not revert database migrations. If a migration causes an issue, restore the backup taken by the script (§3.1, point-in-time restore to just before the update).

After the first startup of a release with encrypted original document filenames, do not roll back to an older version (§4.4).

First-time installation with the same script:

```bash
bash scripts/deploy.sh --install --host brain.company.local --port 3700
```

Without passwordless `sudo`, the script installs systemd *user* services for the service user (`systemctl --user`, with linger enabled). Commands become `systemctl --user status hivevault` and `journalctl --user -u hivevault`.

### 4.2 HTTPS

`--tls` installs (or renews) the server certificate and switches the service to HTTPS:

```bash
bash scripts/dev-ca.sh brain.company.local    # or a certificate from the company CA
bash scripts/deploy.sh --tls cert.pem key.pem
```

The script:
1. copies the certificate and key to `~/hivevault/shared/tls/` (key with mode 600);
2. verifies that the key matches the certificate;
3. backs up `.env` (`.env.bak-<date>`) and sets `TLS_CERT_FILE`, `TLS_KEY_FILE`, and `PUBLIC_URL` to `https`;
4. restarts and checks `/api/health`. If the server does not respond, it restores the previous configuration.

Every client computer must trust the CA that signed the certificate (`data/tls/ca.pem` for the local CA). Any antivirus that inspects HTTPS traffic (for example, Avast Web Shield) must exclude the server address, otherwise the browser sees the antivirus certificate. Passkeys require a domain name: with an IP address, sign-in uses TOTP codes.

### 4.3 Manual update

1. Read the release notes.
2. Run a full backup: `npm run backup -- full`.
3. Update the code (for example, `git pull`).
4. Install and build:

   ```bash
   npm ci
   npm run web:build
   docker compose build postgres && docker compose up -d postgres
   npm run db:migrate
   ```

5. Restart: `sudo systemctl restart hivevault`.
6. Check **Dashboard → Overview** and the **Models** page.

Migrations are numbered SQL files applied once. Never edit an already-applied migration: add a new one.

### 4.4 Encrypted filenames for original documents (one-way)

Every filename in `data/blobs/` is an HMAC of the document's SHA-256 digest using a per-vault key derived from the master key. Without the key, a copy of `data/blobs/` does not reveal whether it contains any known document. Older versions named files directly with the SHA-256 digest (`<vault>/ab/cd/<sha256>`).

1. The first startup of the new release renames legacy files to encrypted names. The server runs the migration in the background after startup: it responds immediately to `/api/health` and users. During the migration, the server reads files under both old and new names.
2. The service log reports progress (`blob name migration in progress`) and completion (`blob name migration done`) with file counts. The log never prints filenames. If the service stops before completion, the next startup resumes the migration.
3. If the master key cannot open a vault's files, the server skips renaming that vault and logs a warning with the vault ID (`the master key does not open its blobs`). The server continues reading files under their legacy names. Verify `BRAIN_MASTER_KEY` (or `data/.master-key`) and restart the service.
4. This change is one-way: older versions cannot read encrypted filenames. After the first startup, do not run `bash scripts/deploy.sh --rollback` and do not manually install an older version. If the deploy script rolls back automatically, search the log for `blob name migration`. If the migration started, deploy the new release again.
5. Backups of `data/blobs/` taken before the upgrade keep the legacy filenames. The new version still reads them after a restore and migrates their names on the next startup. Those older backups still reveal which known documents each vault contains: protect them like server data, or replace them with a fresh copy after migration.

## 5. Monitoring

### 5.1 Dashboards

**Dashboards** (administrators only) provide 10 views: Overview, Ingestion, Search, Memory health, Hive, Nightly cycle, Models, Database, Access and security, and Host. A panel showing "Check" or "Critical" crossed a threshold: **Open →** jumps directly to the filtered list.

| Signal | Action |
|---|---|
| Failed tasks | **Console → Tasks**: read the error, then click **Retry** |
| High search p95 | "Time by branch" panel: if `embed` or `rerank` is slow, check the model host |
| Offline endpoints | **Console → Models → Test** |
| Blocked connections | **Console → Audit**, action `egress.blocked`: a component tried to connect to a disallowed host |
| Low database cache hit ratio | Increase `shared_buffers` in `docker-compose.yml` |

### 5.2 Prometheus

`GET /metrics` with header `Authorization: Bearer <METRICS_TOKEN>`. Each process exposes its own counters.

### 5.3 Slow queries

**Dashboard → Database → Slowest queries** displays queries from `pg_stat_statements`. To inspect a query plan:

```bash
docker compose exec postgres psql -U brain -d brain -c "explain (analyze, buffers) <query>"
```

## 6. Automatic maintenance

The nightly cycle (window configured in **Console → Settings**) maintains vaults: re-parsing with updated parsers, computing missing vectors, deduplicating entities, linking mentions, generating summaries, promoting to the Hive, rebuilding indexes, and running `VACUUM (ANALYZE)` on partitions when more than 10% of rows are dead. The scheduler also prunes completed tasks (30 days) and expired audit rows (400 days).

The cycle links mentions and writes summaries only for pages changed since the previous cycle. After an update that changes these rules, trigger a full cycle on the server:

```bash
cd ~/hivevault/current && npm run cb -- dream --all --full
```

Instead of `--all`, you can pass one or more vault IDs. The cycle starts immediately, even outside the nightly window; time and token budgets still apply.

One-minute metrics are kept for 14 days; hourly rollups for 400 days.

## 7. Operational security

- Change `POSTGRES_PASSWORD` and `PGBACKREST_CIPHER_PASS` only while the database is stopped, and update your offline copy.
- Revoke unused API keys (**Console → API accounts**).
- Review **Dashboard → Access and security** every month: denied logins, blocked hosts, and unused keys.
- The security review (OWASP ASVS L2) is in [docs/security/asvs-l2.md](../security/asvs-l2.md).
