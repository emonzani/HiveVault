# Personal Data Protection: Compliance and Obligations

This document explains how HiveVault processes personal data. It lists which requirements of the GDPR and Italian law the software addresses, what the server installer must do, and what the adopting company must do. Checklists for each role appear at the end.

This document is not legal advice. The company's Data Protection Officer (DPO) or legal counsel must review it before production use. The software is provided "as is", without warranty and without liability of the authors: see §5 and [DISCLAIMER.md](../../DISCLAIMER.md).

## 1. Applicable regulations

| Regulation | What it requires for HiveVault |
|---|---|
| Regulation (EU) 2016/679 (GDPR) | Principles (Art. 5), privacy by design and by default (Art. 25), data subject rights (Art. 15–22), security (Art. 32), records of processing (Art. 30), DPIA (Art. 35), breach notification (Art. 33–34), processors (Art. 28), transfers outside the EU (Chapter V) |
| Italian Legislative Decree 196/2003 (Privacy Code), as amended by Legislative Decree 101/2018 | National rules; Art. 113 and 114 reference the Workers' Statute |
| Italian Law 300/1970 (Workers' Statute), Art. 4 and Art. 8 | Remote monitoring of employees: trade union agreement or Labor Inspectorate authorization, except for work tools; adequate notice; prohibition on investigating personal opinions |
| Italian Legislative Decree 152/1997, Art. 1-bis | Notice regarding automated decision-making or monitoring systems |
| Italian Law 132/2025 (Artificial Intelligence), Art. 11 | The employer must inform employees about the use of AI systems |
| Regulation (EU) 2024/1689 (EU AI Act) | AI literacy for staff (Art. 4); additional high-risk obligations if a system evaluates workers (Annex III, point 4). Verify applicable effective dates |
| Italian Garante, Provision of 27 November 2008 (System Administrators) | Individual appointment, up-to-date list, immutable access logs retained for at least 6 months, annual review of administrator activity |
| Italian Legislative Decree 138/2024 (NIS2 Directive transposition) | If the company is an essential or important entity, HiveVault falls within its cybersecurity risk management and incident notification scope |
| Directive (EU) 2024/2853 (Product Liability Directive) | Covers software. Does not apply to free and open-source software developed or supplied outside a commercial activity (Art. 2(2)). Transposition deadline: 9 December 2026 |
| Regulation (EU) 2024/2847 (Cyber Resilience Act) | Obligations for products with digital elements made available in the course of a commercial activity; excludes free software outside commercial activity. Reporting obligations from 11 September 2026, remaining obligations from 11 December 2027 |
| Italian Civil Code, Art. 1229 | Any clause excluding liability for willful misconduct or gross negligence is void: the license disclaimer applies to the extent permitted by law |
| Italian Garante, Guidelines of 1 March 2007 and Guidance Document of 6 June 2024 (email and metadata) | Limits on processing employee emails and email metadata |

## 2. Roles

| Role | GDPR role | Who it is |
|---|---|---|
| Company adopting the software | Data Controller | Determines purposes and means; bears legal responsibility for processing |
| Who installs and operates the server | Data Processor (Art. 28) if an external vendor; Controller's staff if internal | Installs, upgrades, runs backups, has OS and database access |
| HiveVault administrators | Authorized personnel of the Controller; System Administrators under the Garante provision | Manage users, vaults, permissions, and the administration console |
| Cloud agent provider | Data Processor (Art. 28) | Receives, via MCP, the compiled text of "public" (`pubblico`) and "internal" (`interno`) pages |
| Employees and other people named in documents | Data Subjects | Users of the system and individuals mentioned in documents, emails, and pages |
| Software authors (MIT license) | No role | Do not install, host, operate, or access any installation; receive no data; the software never phones home (§5) |
| Vendor installing or supporting for a fee | Data Processor (Art. 28) for the company; manufacturer or distributor under Directive 2024/2853 and the Cyber Resilience Act if placing the software on the market in a commercial activity | Responsible for its own service to the company; the authors' disclaimer does not cover it |

## 3. How the software handles data

### 3.1 Where data lives

- Original documents stay on the server, encrypted with AES-256-GCM using a per-vault key (`data/blobs/`). They never leave the server.
- Parsers, embeddings, reranking, OCR, and compilation use local models only.
- Every outbound connection passes through the egress guard: only allowlisted hosts are reachable.
- Model hosts (`LLAMA_SERVER_URL`, `REMOTE_EMBED_URLS`, `REMOTE_RERANK_URLS`, `OCR_URLS`) receive document text and are always allowed. The software ships with no default model host: the installer configures them, and they must be company-owned hosts.
- The cloud agent reads via MCP only the compiled text of "public" and "internal" pages. The MCP server never serves any higher classification, regardless of the API account's clearance (`MCP_MAX_CLASSIFICATION`).

### 3.2 Classification levels

| Level | Who can read it | Cloud agent |
|---|---|---|
| 0 `pubblico` (public) | Anyone with vault access | Yes, via an authorized API account |
| 1 `interno` (internal) | Anyone with vault access | Yes, via an authorized API account |
| 2 `riservato` (confidential) | Anyone with vault access and clearance ≥ confidential | Never |
| 3 `segreto` (secret) | Anyone with vault access and secret clearance | Never |
| 4 `personale` (personal) | Only the owner of the personal vault | Never |

**Personal (`personale`).** The "personal" level applies exclusively inside personal vaults (owner `user:<id>`). Only the owner can read or set it. Administrators cannot see personal content anywhere in the application:

- search, pages, folder tree, graph, and APIs hide it (Row Level Security with `cb_personal()`);
- the console does not list, edit, or delete personal documents;
- exports, imports, and restore points exclude, never overwrite, and never delete them;
- page merges and console statistics exclude them;
- changing the owner of a vault containing personal content is blocked;
- the nightly cycle never promotes them to the Hive and never cross-links to them from other pages;
- any page compiled from a personal document stays personal.

**What remains after deleting a user.** Everything not marked "personal" remains. The non-personal content of the user's vaults transfers to the team chosen by the administrator, which becomes the new owner. Any vault containing only personal content is deleted.

### 3.3 Privacy by default

- A personal vault starts with default classification "personal": without an explicit choice, only the owner reads its content. Neither administrators, nor colleagues, nor the cloud agent can read it, and it never enters the Hive. To share a page or document, the owner selects a lower level.
- Anyone with write permission in another person's personal vault who leaves the default level creates "personal" content belonging to the owner: after saving, the writer can no longer see it. Dialogs warn them beforehand.
- If a personal vault transfers to a team (upon account deletion), its default classification becomes "confidential".
- Emails (EML, MSG, MBOX) and their attachments automatically become at least "confidential".
- Administrators can disable email ingestion (Console → Settings → Privacy, or `INGEST_EMAIL=false`). Mail files then return "unsupported".
- On first sign-in, every user reads and acknowledges the cloud agent notice. The acknowledgment is recorded in the audit log.
- Pages written by the nightly cycle and Hive pages display the banner "Page written by the nightly cycle". Pages compiled by a local model cite their sources and display compilation confidence, but do not carry an explicit "AI-written" badge: explain this to users during training (EU AI Act Art. 4).
- Every page indicates whether the cloud agent can read it. The "What the cloud agent read" panel lists every MCP read of the user's pages.

### 3.4 Data subject rights

| Right | How it is exercised |
|---|---|
| Access (Art. 15) and portability (Art. 20) | Users read and download their pages as Markdown. There is no single-click export of all data concerning a person: the administrator compiles it using search, vault exports, and the audit log. Administrators cannot export "personal" content: the data subject downloads it themselves. |
| Rectification (Art. 16) | Regular pages can be edited immediately. Pages generated by the nightly cycle (Hive, `_inbox/`) can be rectified immediately by an administrator. The server opens a "Rectification" item in the curator queue listing the source pages and documents behind the statement. While open, the nightly cycle will not overwrite the page. Once the sources are fixed, a curator closes the item. |
| Erasure (Art. 17) | Pages and documents can be deleted together with their versions, chunks, and original encrypted files. Deleting an account erases all "personal" content and transfers the rest to a team. Deleting a vault also deletes its original files. |
| Restriction and objection (Art. 18, 21) | Raise the classification of a page or document, or revoke permissions. |

**Data that remains after deletion:**

- The audit log retains the account ID (not the person's name) for the security event retention period.
- Non-personal page version histories retain the author's account ID.
- Database backups retain deleted data until backup expiration (§3.5).
- Manual vault exports in `data/exports/` remain until an operator deletes them.

### 3.5 Retention

| Data | Period | Setting |
|---|---|---|
| Audit security events (sign-ins, admin changes, credentials) | 400 days; never less than 183 (6 months) | `AUDIT_RETENTION_DAYS` (minimum 183) |
| Audit read events (`page.read`, `source.read`, `source.download`, `search`, MCP reads) | 30 days | Console → Settings → Privacy, or `AUDIT_READ_RETENTION_DAYS` |
| Failed login attempts (username, IP) | 24 hours | Nightly cleanup |
| Completed tasks | 30 days | `TASK_RETENTION_DAYS` |
| Sessions | Until expiry (12 hours idle, 7 days max) | `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` |
| Database backups (pgBackRest) | 2 weekly full backups plus WAL between them: deleted data stays in backups for at most ~3 weeks | `repo1-retention-full=2` in `docker/postgres/pgbackrest.conf` |
| Original files in `data/blobs/` | Until document deletion; in filesystem copies per company backup policy | Company backup tool |
| Vault exports in `data/exports/` | Until manually deleted | Operator |
| Metrics | No personal data: labels never contain users, pages, or free text | — |

**Restoring from backup.** A restore brings back data deleted after the backup timestamp. After a restore, the administrator replays deletions recorded in the audit log after the restored point (`admin.principal.delete`, `source.delete`, `page.delete`, `admin.source.delete`).

### 3.6 Audit log and system administrators

- The audit log is append-only. The database rejects `UPDATE` and `TRUNCATE`, and rejects deleting any security event younger than 6 months (triggers from migration `014_privacy.sql`).
- Every security event includes the SHA-256 hash of the previous event (hash chain). Any altered, deleted, or injected row breaks the chain.
- Verification: `npm run cb -- audit verify`, or `GET /api/admin/audit/verify`. Verification itself is logged.
- Every night, the server writes the latest chain head (`audit chain head`) to the application log. Ship this log off the server so any tampering by someone with database access is detectable.
- Read events (who read what) stay outside the hash chain and follow their own short retention period (§3.5).

### 3.7 Remote monitoring of employees

The read log records which pages each person reads. It serves security auditing and page importance scoring (last 30 days). Because it could also be used to monitor employee activity, Art. 4 of the Italian Workers' Statute applies.

- Default retention is 30 days. Reduce it to the shortest agreed period.
- Never use the read log to evaluate performance or make employment decisions.
- Never use HiveVault to evaluate, screen, or monitor workers: doing so would classify it as a high-risk AI system under the EU AI Act.

### 3.8 Residual limits

The software protects data inside the application and database. Certain people can still access data through technical privileges. These controls are organizational, not technical:

- Anyone with OS root access, database superuser access, or the master key (`data/.master-key`) can read all data — including "personal" content — and disable audit triggers. Keep this group as small as possible, formally appoint them as system administrators, and ship the application log containing the audit chain head off-server.
- An administrator can reset a user's credentials and sign in as that user. The action is logged in the audit log and locks out the real user, who discovers it on their next login attempt. Prohibit this in internal policy except at the user's explicit request.
- Backups also contain "personal" content, encrypted with the same keys.
- The system does not automatically detect personal data inside uploaded documents: the person uploading chooses the classification.

## 4. Checklists

### 4.1 Who installs and operates the server

- [ ] Sign a Data Processing Agreement (Art. 28) with the company if acting as an external provider.
- [ ] Install the server on the company network or in an EU data center.
- [ ] Generate the master key and store an offline copy accessible only to a small list of named individuals.
- [ ] Enable HTTPS (`TLS_CERT_FILE`, `TLS_KEY_FILE`) or a TLS reverse proxy (`TRUST_PROXY`).
- [ ] Configure only company-owned servers as model hosts (§3.1).
- [ ] Restrict `EGRESS_ALLOW` to required hosts only.
- [ ] Enable backup timers and monthly restore verification (`npm run backup -- verify`).
- [ ] Include `data/blobs/` in company file backups; exclude `data/exports/` or delete exports immediately after use.
- [ ] Forward application logs (including `audit chain head`) to an off-server log collector.
- [ ] Run `npm run cb -- audit verify` at least once a month and archive the result.
- [ ] Set `AUDIT_READ_RETENTION_DAYS` and `INGEST_EMAIL` according to company decisions.
- [ ] Maintain the list of personnel with access to the OS, database, and master key.
- [ ] Update the server using `scripts/deploy.sh` and log every release.
- [ ] Notify the company immediately of any suspected breach (Art. 33(2)).

### 4.2 Company adopting the software (controller)

- [ ] Add this processing activity to the Record of Processing Activities (Art. 30): purposes, categories of data and data subjects, recipients, transfers, retention periods (§3.5), and security measures.
- [ ] Complete a Data Protection Impact Assessment (DPIA, Art. 35) before go-live: systematic processing of employee data using new technology.
- [ ] Sign an Art. 28 DPA with the cloud agent provider and verify the legal basis for transfers outside the EU (EU-US Data Privacy Framework adequacy decision for certified providers, or Standard Contractual Clauses).
- [ ] Decide which vaults the cloud agent may read and grant API accounts the minimum necessary clearance (at most "internal").
- [ ] Execute a trade union agreement or obtain Labor Inspectorate authorization (Art. 4 Workers' Statute) where read logs or system usage enable remote monitoring.
- [ ] Provide employees with the privacy notice (GDPR Art. 13, Workers' Statute Art. 4(3), Legislative Decree 152/1997 Art. 1-bis, Law 132/2025 Art. 11): what the system logs, for how long, who reads it, and how AI and the cloud agent are used.
- [ ] Establish an email ingestion policy: which mailboxes may be uploaded, whose, and on what legal basis; disable email ingestion if not needed.
- [ ] Establish a classification policy: when to use "confidential", "secret", and "personal".
- [ ] Formally appoint system administrators in writing and maintain an up-to-date list (Garante 2008 provision).
- [ ] Review system administrator activity annually using the audit log.
- [ ] Document procedures for data subject rights (§3.4) and post-restore re-deletions (§3.5).
- [ ] Document the personal data breach procedure (Art. 33–34): notification to the supervisory authority within 72 hours.
- [ ] Train users on AI usage and document classification (EU AI Act Art. 4).
- [ ] Never use the system to evaluate or surveil employees.

### 4.3 HiveVault administrators

- [ ] Create a personal vault for every user who needs one: it starts as "personal".
- [ ] Place every user in at least one team so an heir team exists upon account deletion.
- [ ] Grant permissions to teams rather than individuals whenever possible.
- [ ] Never reset a user's credentials to sign in on their behalf.
- [ ] Before deleting an account, choose the team that receives its non-personal content.
- [ ] Rectify Hive pages on request and track "Rectification" items in the curator queue until underlying sources are fixed.
- [ ] Verify the audit chain (console or CLI) and report any break to the controller.

### 4.4 DPO (if appointed)

- [ ] Review this document and the DPIA.
- [ ] Review legal bases, employee privacy notice, and union/works council agreements.
- [ ] Review Art. 28 DPAs and international transfer mechanisms.
- [ ] Participate in the annual system administrator review.

### 4.5 Users

- [ ] Read and acknowledge the cloud agent notice.
- [ ] Classify documents upon upload: "personal" for your own private data, "confidential" or "secret" for other people's data.
- [ ] Never upload another person's mailbox or documents without authorization.
- [ ] Check the "What the cloud agent read" panel to monitor reads of your pages.

## 5. License and disclaimer

- HiveVault is licensed under the MIT License ([LICENSE](../../LICENSE)). The software is provided "as is", without warranty of any kind, express or implied.
- To the maximum extent permitted by law, the authors are not liable for any damage, data loss, personal data breach, fine, or third-party claim connected to the software or its use.
- The authors have no role in data processing: they are neither controller nor processor. Every obligation in this document rests with the company adopting the software and whoever installs and operates it.
- The software is distributed as free open-source software outside any commercial activity of the authors. Anyone supplying, installing, or supporting it commercially is responsible for their own service.
- This exclusion does not apply where prohibited by law (for example, willful misconduct or gross negligence under Art. 1229 of the Italian Civil Code).

The full text in both English and Italian is in [DISCLAIMER.md](../../DISCLAIMER.md).
