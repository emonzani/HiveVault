# Administrator Guide

This guide is for HiveVault administrators. Open the console using the **Administration console** icon in the left bar. Only accounts with the "Administrator" role see the console and dashboards.

Every change you make in the console is recorded immediately in the audit log.

## 1. Concepts

| Concept | Meaning |
|---|---|
| Cell | The vault of a person, edge device, team, or project |
| Hive space | A shared vault. Linked cells feed it every night |
| Permission | Read, Write, Curate, or Administer, per account and per vault |
| Clearance level | The highest classification an account can read: public (`pubblico`), internal (`interno`), confidential (`riservato`), secret (`segreto`) |
| Classification | The sensitivity level of a vault, document, or page: public, internal, confidential, secret, personal (`personale`) |
| Team | A group of users. Team permissions apply to all its members |

An account reads a page only if it has permission on the vault **and** its clearance is equal to or higher than the page's classification. The cloud agent never reads above "internal", regardless of the account's clearance.

The **personal** (`personale`) level sits outside this scale. It applies only inside a person's own cell, and only that person can read it. Administrators never see personal content in any section of the console. See the full rules in [Personal data protection](../security/privacy.md).

Every console section and dashboard includes an **Explained simply** box describing what the page does in a few lines. Close it when you no longer need it: it stays closed.

## 2. Users

**Console → Users → New user**

1. Enter the username (lowercase letters, digits, dots, hyphens), display name, role, and clearance level.
2. Select **Create**. The console displays an activation link.
3. Send the link to the person. They open the link, set up their authenticator app, and save their recovery codes.

The link expires. If it expires, select the user and click **Reset authentication**: the console generates a new link.

| Action | Where | Effect |
|---|---|---|
| Change role or clearance | User detail → **Save** | Takes effect on the next request |
| Suspend | **Suspend** | Sessions and keys stop working until reactivated |
| Lost phone | **Reset authentication** | Closes active sessions and creates a new activation link |
| Stolen session | **Close all sessions**, or a single session | The person must sign in again |
| Lost passkey or signing key | **Remove** or **Revoke** | The credential stops working immediately |
| Delete | **Delete**, choose the receiving team, click **Delete permanently**, and confirm with the username | Irreversible. The person's "personal" content is deleted. The rest of their cells transfers to the chosen team; an empty cell is deleted |

You cannot delete or suspend your own account. The console prevents removing the last administrator.

If the person belongs to only one team, that team is preselected. If they belong to multiple teams or none, choose the team manually. Deleted data remains in database backups for roughly 3 weeks.

**Console → Teams** creates teams and manages members. A user can belong to multiple teams. To grant permissions to a team, open **Edit permissions** from the team page. A team cannot sign in and has no keys. A team that owns cells cannot be deleted: reassign its cells to another owner first.

### Signature sign-in (command line and edge devices)

A script or edge device signs in with a private key: Ed25519, ECDSA P-256, or a certificate from the company CA. Register the user's public key on the server (`POST /api/admin/principals/<id>/public-keys`). The console lists registered keys under **Signing keys**.

The client signs the message `cb-auth-v2|<origin>|<username>|<nonce>|<ts>`. The origin is the scheme, host, and port of the server URL, for example `https://brain.company.local`. The client takes the origin from its own configuration, never from the server. The server accepts only the origin in `PUBLIC_URL` and origins listed in `WEBAUTHN_EXTRA_ORIGINS`. This ensures a signature is valid only for the exact server the client intends to reach.

From the command line, pass the server's public URL:

```bash
npm run cb -- login --user <username> --key <private-key.pem> --url https://brain.company.local
```

| Error | Cause | Action |
|---|---|---|
| `signature_outdated` | The client signs the legacy `cb-auth-v1` message | Update the client |
| `origin_mismatch` | The client signed an origin the server does not accept | Pass `--url` matching `PUBLIC_URL` |

On both errors, the server refuses the session and does not count the attempt toward user lockout. The audit log records them as `login.signature.outdated` and `login.signature.origin` along with the key used.

## 3. API accounts and cloud agent

**Console → API accounts → New API account**

1. Enter the name, choose key scopes (read, write, ingest, admin), and set the clearance level.
2. Optional: expiration date, allowed IP addresses, and rate limit (requests per minute).
3. Select **Create**. The console shows the key **only once**. Copy it immediately.

For the cloud agent, `read` scope and "internal" clearance are enough. Then grant the account read permission on the spaces the cloud agent may consult (§5).

**Coding agents:** each coding agent installation uses its own key bound to the person using it. Create the account with scopes "read" and "project documentation" (`read`, `projects`) and choose the person under **Acts for user**. The key:

- reads, via MCP, only the vaults the person can read (including via team permissions), never above "internal" and never the person's personal vaults;
- writes only to project vaults (owner `project:<slug>`) where the person has write permission: the six documentation sections (specifications, functional analysis, technical analysis, architectural analysis, code index, documents, under `progetto/`) and notes in the inbox, which ingestion compiles into pages;
- cannot write anywhere else via the API;
- grants the person write permission when creating a new project vault;
- stops working immediately if the person is suspended or deleted.

To let coding agents reuse analyses and concepts across projects, grant teams read permission on project vaults (§5). If a person edits a section, the agent must read it again before overwriting it. To create the account from the server without printing the key to the terminal:

```bash
npm run -s cb -- api create agent-first.last --scopes read,projects --user first.last > key.txt
```

An account with only the `projects` scope (without `read`) writes only the six project sections and cannot use MCP.

**Rotating a key:** select the account → **New key (rotation)**. Update the client with the new key. Then revoke the old key.

## 4. Vaults and spaces

**Console → Vaults and spaces → New vault**

- **Type**: cell or Hive space.
- **Slug (identifier)**: short name used in URLs (lowercase letters, digits, hyphens). Cannot be changed after creation.
- **Owner type** (cells only): user, project, team, or edge. After choosing the type, type at least 2 characters of the name and pick from suggestions. Users and teams must be chosen from suggestions; for other types you can also enter a new name. A user owner administers their cell without extra grants; members of an owning team have write access.
- **Default classification**: classification assigned to new documents. Empty = value from **Settings**; for a user's cell, "personal". "Personal" is only allowed on a user's cell.
- A cell containing personal content cannot change owner.
- **Vector index**: "binary + rerank" is the recommended setting.

For a Hive space, the **Cells that feed the space** section chooses source cells. Without page types specified, the cell feeds all eligible pages; with types selected, only those types. Private pages never enter the Hive. Promotion runs during the nightly cycle; **Nightly cycle now** triggers it immediately.

On the vault detail page you can also edit the **owner** (who sees the cell as their own) and **SCHEMA.md**, the rules the model follows when compiling pages in that vault. The slug cannot change: it is embedded in `brain://` URIs and links.

**Page review interval** sets how many days after confirmation, latest cited document, or creation an entity, concept, decision, or synthesis page must be reviewed. Empty = never. The nightly cycle puts overdue pages into the curator queue (type "To review") and onto the "Vault maintenance" page. Individual pages can set their own schedule using `review_after: YYYY-MM-DD` or `review_every: <days>` in frontmatter.

**Export zip** downloads pages as Markdown. **Import zip** restores them. Before importing, the server saves a restore point. If the import rewrites more than one fifth of the vault's pages, the console asks for a second confirmation.

**Restore points**: snapshots of a vault's pages at a point in time.

- **Save a point** creates a named snapshot, for example before a reorganization.
- **Restore** returns all pages to that snapshot: modified pages revert (as new versions), newer pages are removed, and deleted pages return with their original IDs. Before restoring, the server saves the current state in an automatic restore point so you can undo.
- The server keeps the last 5 automatic restore points per vault. Manual restore points remain until you delete them.
- Hive pages are excluded from restore points: the nightly cycle rebuilds them.

**Delete vault** removes all pages, documents, and vectors. Type the vault slug to confirm. This action is irreversible.

## 5. Permissions

**Console → Permissions** displays one account or one vault at a time.

1. Choose **By account** or **By vault**.
2. Search the list on the left and pick a row.
3. On the right you see current permissions. Change a permission in the dropdown or click **Remove**.
4. To add a permission, search the other side under **Add a permission** (at least 2 characters), choose the level, and click **Add**.

Every change takes effect immediately and is logged in the audit log. Cells owned by a user show the **Owner** badge. Administrators see all vaults. From a user's detail page, **Edit permissions** jumps directly here for that user.

| Permission | Allows |
|---|---|
| Read | Search and read |
| Write | Also create, edit, and upload documents |
| Curate | Also resolve Hive conflicts and cloud agent proposals |
| Administer | Also manage the vault |

Administrators see all vaults. Every person always sees their own cell.

## 6. Sources and imports

**Console → Sources** lists documents across all vaults with their status and ingestion level:

| Level | Meaning |
|---|---|
| I0 | Stored (encrypted original) |
| I1 | Text searchable (full-text) |
| I2 | Vectors ready (semantic search) |
| I3 | Compiled into wiki pages by the local model |

**Retry** re-processes the document. **Compile** compiles the page immediately. **Delete** deletes the document, any contained files (ZIP entries, attachments), and the encrypted original. Compiled pages remain.

A document cited by other pages cannot be deleted directly. In the inbox you can **retract** it (`POST /api/sources/<id>/retract`): statements cited only by that document are removed from vault pages, compiled pages with no remaining sources are removed, earlier versions citing it are removed, and then the document is deleted. Hive pages rebuild overnight. Restore points do not change: if the text must disappear completely (right to erasure), also delete restore points saved prior to retraction. A document cited by pages in other vaults cannot be retracted.

Documents added from a URL are re-downloaded during the nightly cycle after `LINK_REFRESH_DAYS` days (default 7; 0 = never), up to 20 per vault per night. Updated content becomes a new document under the same URL; the old version is removed once the new one compiles if no page still cites it.

**Edit** changes a document's title and classification:

- Classification also applies to child files and searchable text: search and the cloud agent see the new level immediately.
- If you **raise** the classification, the page compiled from that document rises to the same level (as a new page version).
- If you **lower** it, the console asks for confirmation: more people will find the document and, with "public" or "internal", the cloud agent can read its text too. The compiled page is not lowered automatically: lower it on the page itself if needed.

**Console → Bulk imports** ingests a folder on the server (for example, a mounted network share). The folder must reside under `IMPORT_ROOTS`. You can cap files per second and restrict the active time window. **Rescan** processes only new or modified files.

**Edit** updates an import's settings even while running: speed limit, time window, classification, and compilation take effect immediately; include/exclude filters take effect on the next scan. Classification applies to files ingested from that moment forward. The folder and target vault cannot change: create a new import for another folder.

## 7. Tasks

**Console → Tasks** monitors long-running server work. A failed task shows its error; **Retry** queues it again. **Cancel** stops a running task; effects already recorded remain.

For a queued or waiting task, its detail view lets you change its **priority** (0 runs first, 9 runs last) and trigger it immediately with **Run now**.

A compilation waiting on the chat model (single concurrency slot) stays "Waiting" and frees the worker for other documents: this is normal and resumes automatically. The same applies to the OCR phase when the OCR model is unavailable.

## 8. Models

**Console → Models** displays every endpoint: status, latency, items per second, and errors.

- **Test** checks the endpoint with a minimal request.
- **OCR (images)**: a vision model that reads images. The server uses it for photos and scanned PDF pages (pages without embedded text). Works with `llama-server` running a vision model (`--mmproj`), or Baidu Unlimited-OCR on SGLang (`OCR_PROMPT=unlimited-ocr`; requires an NVIDIA GPU). The server sends `OCR_PAGES_PER_REQUEST` pages together so tables spanning two pages stay intact. When you add the first OCR endpoint, the nightly cycle re-processes documents waiting for OCR.
- **Local processes**: start, stop, restart; thread count and schedule apply without restarting the server.
- **Add a remote endpoint**: the address must be inside the company network. The console rejects public IP addresses so document text never leaves the network.
- **Edit** changes a remote endpoint's address under the same rule; the dispatcher re-checks model identity. For endpoints defined in `.env`, the console saves the override in settings (badge "address changed from console") and keeps it across restarts; to revert to `.env`, enter the original address again.

The **audit log** cannot be edited or deleted from the console: a mutable log is not valid evidence.

## 9. Settings

| Setting | Effect |
|---|---|
| Nightly cycle | Time window, minute and token budgets per vault, compilations per night, chat model usage |
| Default classification | Default level for new vaults |
| Privacy | Retention days for read logs (who read what); enable or disable mail file ingestion (EML, MSG, MBOX) |
| Notice about the cloud agent | Text every user reads and confirms on first sign-in |

## 10. Audit

**Console → Audit** searches events by account, action, outcome, and time range. Example actions: `login*` (sign-ins), `admin.*` (administrator changes), `page.read` with `via: mcp` (cloud agent reads), `egress.blocked` (blocked outbound connections).

The log is append-only: nobody can alter it from the application or database, and security events stay for at least 6 months. To verify integrity, run `npm run cb -- audit verify` on the server, or request `GET /api/admin/audit/verify`.

### Rectifying a generated page

Hive pages and `_inbox/` pages are generated by the nightly cycle. An administrator can correct them immediately with **Edit**. After saving, the curator queue displays a **Rectification** item listing the source pages and documents behind the data. While the item stays open, the nightly cycle does not overwrite the page. Fix the underlying sources, then click **Sources corrected**: from the next night onward, the page rebuilds from its sources again.

## 11. Dashboards

The **Dashboards** icon opens 10 dashboards. Choose the time range and auto-refresh at the top. **Table** displays the raw values behind any chart. **Open →** jumps to the filtered list in the console. The pencil icon lets you drag and resize panels; your layout is saved per user.
