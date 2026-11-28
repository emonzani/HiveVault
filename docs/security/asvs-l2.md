# Security Review — OWASP ASVS 4.0.3, Level 2

Date: 2026-11-02 · Version: branch `fase-7-admin` (Phase 8) · Internal code and test review.

This review verifies the Level 2 requirements applicable to HiveVault. For each chapter, the table records status and evidence (file or test). Statuses: **OK** (met and verified), **OPEN** (must be completed before or during installation), **N/A** (does not apply: for example, there are no passwords).

## Summary

| Chapter | Status |
|---|---|
| V1 Architecture | OK |
| V2 Authentication | OK (passwordless: TOTP, passkeys, signature login, API keys) |
| V3 Sessions | OK |
| V4 Access control | OK |
| V5 Validation and encoding | OK |
| V6 Stored cryptography | OK; encrypted backup with pgBackRest (this phase) |
| V7 Error handling and logging | OK (secret redaction added in this phase) |
| V8 Data protection | OK (`no-store` on API responses added in this phase) |
| V9 Communications | OPEN at installation: TLS required outside `localhost` (release checklist) |
| V10 Malicious code | OK; 2 dependency chains with unreachable moderate advisories (below) |
| V11 Business logic | OK |
| V12 Files and resources | OK (zip import expansion limits added in this phase) |
| V13 API | OK |
| V14 Configuration | OK (`Permissions-Policy` and CORP added in this phase) |

## Issues found and fixed in this review

| # | Requirement | Issue | Fix | Test |
|---|---|---|---|---|
| 1 | Invariant 1, V1.1 | An administrator could add an embedding or rerank endpoint on a public IP from the console, which would send document text outside the network | Endpoints must resolve exclusively to private addresses (`isPrivateAddress`) | `ops.e2e.test.ts` (8.8.8.8 rejected, 192.168.x accepted) |
| 2 | V12.1.1, V12.1.3 | Vault zip import did not cap uncompressed size (zip bomb) | Limits of 50,000 files, 50 MB per file, and 2 GB total enforced during decompression | `ops.e2e.test.ts` (100 KB archive expanding past limit: 400) |
| 3 | V8.2.1 | API responses did not forbid browser and proxy caching | Default `Cache-Control: no-store` on `/api`, `/mcp`, `/metrics` | `workspace.e2e.test.ts` |
| 4 | V14.4.4–14.4.7 | `Permissions-Policy` and `Cross-Origin-Resource-Policy` headers were missing | Added to every response | `workspace.e2e.test.ts` |
| 5 | V7.1.1, V7.1.2 | The logger emitted fields verbatim | `redact()`: secret field values (tokens, codes, keys, cookies) and Bearer tokens / API keys inside strings become `[nascosto]` | `log.test.ts` |
| 6 | V2.10.4, V6.2.1 | `/metrics` token was compared using `===` | Constant-time comparison on digests | `ops.e2e.test.ts` |
| 7 | V10.3.2 | `zod` < 4.6.6 (high advisory: memory exhaustion on huge collections) in MCP server | Upgraded to `zod` 4.6.7; verified tool schemas reach the cloud agent with all parameters intact | `mcp.e2e.test.ts` |

## V1 — Architecture

| Requirement | Status | Evidence |
|---|---|---|
| 1.1 Components and trust boundaries documented | OK | `docs/DEVELOPMENT_PLAN.md` §2–§3, `AGENTS.md` (17 invariants) |
| 1.4 Single access control decision point | OK | `Access.can` / `requireAction` (`packages/auth/src/authz.ts`); Invariant 10 |
| 1.5 Server enforces every check, client never decides | OK | Every route calls `requireAction`; the UI only hides controls |
| 1.9 Outbound communications controlled | OK | `EgressGuard` on every socket (`packages/shared/src/egress.ts`): database, model hosts, and allowlisted hosts only; blocked attempts recorded in audit (`egress.blocked`) and metrics |
| 1.14 Database privilege separation | OK | `cb_reader` role with RLS for user and cloud agent reads (`withReader`); system jobs write as the owner role (Invariants 6 and 8) |

## V2 — Authentication

There are no passwords: users sign in with TOTP (RFC 6238), passkeys (WebAuthn), key signatures (Ed25519, P-256, X.509), or API keys for applications.

| Requirement | Status | Evidence |
|---|---|---|
| 2.1 Passwords | N/A | Passwordless architecture |
| 2.2.1 Brute-force protection | OK | Progressive lockout per username in Postgres: 5 failures in 24 h → 15 min, then 30 min, doubling up to 24 h (`lockout.ts`); per-IP rate limiting on login routes (`LOGIN_RATE_LIMIT_PER_MIN`) |
| 2.2.3 Security event logging | OK | Every login, failure, reset, and credential change is written immediately to the audit log (Invariant 11) |
| 2.5.4 No shared or default accounts | OK | First administrator created via CLI (`cb admin create`); no default accounts |
| 2.5.6 Secure recovery | OK | 10 single-use recovery codes stored as hashes; TOTP reset requires an administrator and closes all active sessions |
| 2.7/2.8 One-time codes (TOTP) | OK | ±1 time step window; each code is single-use (`lastStep`, `totp.ts`); secret encrypted with AES-256-GCM |
| 2.9 Cryptographic authentication | OK | Passkeys verify origin and counter; signature login verifies a single-use random challenge |
| 2.10 Service credentials | OK | 256-bit random API keys stored as SHA-256 hashes with constant-time comparison; expiry, IP allowlists, per-account rate limits; key shown once |

## V3 — Sessions

| Requirement | Status | Evidence |
|---|---|---|
| 3.2.1 New token on every sign-in | OK | `sessions.create` generates 256 random bits on every sign-in |
| 3.3.1/3.3.2 Session expiration | OK | 12 h idle timeout, 7-day absolute maximum (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`); server-side logout and revocation |
| 3.3.4 Session listing and termination | OK | "My account" and admin console (user → sessions) |
| 3.4 Cookies | OK | `HttpOnly`, `Secure` under HTTPS, `SameSite=Strict`, `Path=/` |
| 3.5 API tokens | OK | Bearer tokens for API accounts; session cookies are not accepted for API accounts |
| 4.2.2 CSRF | OK | Session-bound CSRF token required on every cookie-authenticated write |

## V4 — Access control

| Requirement | Status | Evidence |
|---|---|---|
| 4.1.1 Server enforces permissions | OK | `requireAction` on every route; RLS as second line of defense |
| 4.1.3 Least privilege | OK | Per-vault permissions (read, write, curate, administer); per-account clearance; cloud agent capped at "internal" (Invariant 16) |
| 4.2.1 Direct object references | OK | Pages and sources read under RLS: an ID in an inaccessible vault returns 404. Tests: `workspace.e2e.test.ts`, `mcp.e2e.test.ts` |
| 4.3.1 Protected admin interfaces | OK | `admin.*` restricted to administrator role; no API key access to the console. Test: `ops.e2e.test.ts` (403 for members) |
| Filter before ranking | OK | Allowed vault partitions pruned before search ranking (Invariant 6) |

## V5 — Validation, sanitization, and encoding

| Requirement | Status | Evidence |
|---|---|---|
| 5.1 Input validation | OK | JSON Schema on every request body and query string (Fastify/Ajv, `additionalProperties: false`); zod schemas on MCP tools |
| 5.2/5.3 Output encoding (XSS) | OK | Markdown rendered with `html: false`, no unsanitized `{@html}` (Invariant 14); CSP blocks inline scripts |
| 5.3.4 SQL injection | OK | Parameterized queries only (`postgres` tagged templates); dynamic identifiers (partition names) are server-generated |
| 5.2.6 SSRF | OK | Imported URLs must resolve to public Internet addresses (DNS checked before and after redirects); model endpoints must be private (Fix 1) |

## V6 — Stored cryptography

| Requirement | Status | Evidence |
|---|---|---|
| 6.2.1 Approved algorithms | OK | AES-256-GCM for original files (per-vault key derived via HKDF from master key) and TOTP secrets; SHA-256 for API keys |
| 6.4.1 Key management | OK | Master key in `DATA_DIR/.master-key`, mode 0600, stored outside the database; must be backed up offline (operator guide) |
| Backups | OK | pgBackRest with AES-256 repository encryption (this phase) |

## V7 — Error handling and logging

| Requirement | Status | Evidence |
|---|---|---|
| 7.1.1/7.1.2 No secrets in logs | OK | `redact()` (Fix 5) |
| 7.2 Security events logged | OK | Audit log covers logins, failures, credentials, permissions, settings, cloud agent reads, and blocked outbound connections |
| 7.3 Log protection | OK | `cb_reader` role cannot read `audit_log`; 400-day retention (`AUDIT_RETENTION_DAYS`) |
| 7.4.1 Generic error messages | OK | Internal errors return a generic message; stack details stay in server logs |

## V8 — Data protection

| Requirement | Status | Evidence |
|---|---|---|
| 8.1 Sensitive data excluded from cache | OK | `no-store` (Fix 3) |
| 8.2.2 Browser storage | OK | Browser stores UI preferences only (theme, layout, open tabs); no document content |
| 8.3 Classification | OK | Classification per vault, document, and page; cloud agent sees only "public" and "internal", with user notice (D1) |
| Local documents | OK | Invariant 1: originals never leave the server; models run locally or inside the company network |

## V9 — Communications

| Requirement | Status | Evidence |
|---|---|---|
| 9.1.1 TLS for all client connections | OPEN at installation | Server supports HTTPS (`TLS_CERT_FILE`, `TLS_KEY_FILE`) and sends HSTS; `scripts/dev-ca.sh` creates an internal CA. Release checklist requires HTTPS outside `localhost` |
| 9.2 Internal service links | Accepted | Postgres and model hosts run over HTTP/TCP on the internal network; on untrusted networks, enable Postgres TLS and place a TLS proxy in front of `llama-server` |

## V10 — Malicious code and dependencies

| Requirement | Status | Evidence |
|---|---|---|
| 10.3.2 Dependencies free of known vulnerabilities | OK with exceptions | `npm audit --omit=dev`: `zod` fixed. 9 moderate advisories remain in two unreachable dependency chains: `glob`/`minimatch` in `@fastify/static` (triggered only when `wildcard: true`, we set `false`); `archiver` in `exceljs` (used only for writing `.xlsx`, we only read them). Re-check on every release |

## V11 — Business logic

| Requirement | Status | Evidence |
|---|---|---|
| 11.1.2 Rate limits | OK | Per-account and per-IP limits; configurable per-account API rate limit |
| 11.1.4 Resource limits | OK | Upload size cap (`UPLOAD_MAX_MB`), 2 MB JSON body cap, time and token budgets for the nightly cycle, metric series cap (5,000) |
| Cloud agent never writes directly | OK | `brain_capture` writes only to the inbox; `brain_propose_edit` enters the curator queue |

## V12 — Files and resources

| Requirement | Status | Evidence |
|---|---|---|
| 12.1 File size and count limits | OK | Upload limits and zip expansion limits (both parser and vault import) |
| 12.3 Paths | OK | Client filenames are never used as filesystem paths; zip import enforces path-traversal checks; bulk imports restricted under `IMPORT_ROOTS` |
| 12.4 Uploaded content | OK | File type detected from content magic bytes, not extension; parsers run in worker threads; originals download as attachments |

## V13 — API

| Requirement | Status | Evidence |
|---|---|---|
| 13.1.3 No secrets in URLs | OK | API keys passed only in `Authorization` header; activation code passed in URL `#` fragment |
| 13.2 REST | OK | Proper HTTP methods, JSON schema validation on all bodies, CSRF protection on cookie-authenticated writes |

## V14 — Configuration

| Requirement | Status | Evidence |
|---|---|---|
| 14.4 Security headers | OK | Inline-free CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, CORP, `Permissions-Policy`, HSTS over HTTPS |
| 14.3 No debug info leaked | OK | No stack traces sent to clients; source maps restricted to static assets |
| 14.1 Reproducible builds | OK | `package-lock.json`; automated installation script (this phase) |

## Installation action items (from the release checklist)

1. Enable HTTPS with a company CA certificate; set `PUBLIC_URL` to `https://`.
2. Set a non-development `POSTGRES_PASSWORD`; bind Postgres and pgbouncer exclusively to `127.0.0.1` or the internal network.
3. Back up the master key (`DATA_DIR/.master-key`) and pgBackRest repository passphrase off the server.
4. Set a long, random `METRICS_TOKEN` if using Prometheus.
5. Configure model host API keys (`MODELS_API_KEY`).
