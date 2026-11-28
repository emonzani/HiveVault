# Installation Guide

This guide installs HiveVault on a company Linux server. It is written for the person installing the server, even without prior knowledge of the project. Read the entire guide before you start.

HiveVault is free open-source software under the MIT license, provided "as is", without warranty. The authors do not operate installations and receive no data. The installer and the company using the software are responsible for it. Read [DISCLAIMER.md](../../DISCLAIMER.md) before you install.

## 1. Who does what

| Role | Tasks | Where |
|---|---|---|
| Who installs and operates the server (installer, operator) | Prepares the server, installs, configures HTTPS and models, stores keys, runs backups and updates, creates the first administrator | This guide, [operator guide](operator.md), [checklist §4.1](../security/privacy.md#41-who-installs-and-operates-the-server), [release checklist](../RELEASE.md) |
| Company adopting the software (data controller) | Decides purposes, completes the DPIA, informs employees, signs agreements, appoints system administrators | [Personal data protection](../security/privacy.md), [checklist §4.2](../security/privacy.md#42-company-adopting-the-software-controller) |
| HiveVault administrators | Configure privacy settings and notices, create users, teams, vaults, and permissions | [Administrator guide](administrator.md), [checklist §4.3](../security/privacy.md#43-hivevault-administrators) |
| Users | Read, write, upload, and classify documents | [User guide](user.md), [checklist §4.5](../security/privacy.md#45-users) |

Before using the system with real data, the company completes its checklist (§4.2 of [privacy.md](../security/privacy.md)). Technical installation alone is not sufficient for compliant use.

## 2. Requirements

| Item | Minimum | Note |
|---|---|---|
| OS | Debian 12 or Ubuntu 22.04 (or newer) | Development also supports Windows; production uses Linux |
| CPU | 8 cores | More cores speed up document parsing and local models |
| RAM | 32 GB | 64 GB for several million pages (development plan, §2.5) |
| Disk | 20 GB free + 3× the size of documents | Use the formula in the development plan, §2.5 |
| Node.js | 22.19 or newer | |
| Docker | Engine 24 or newer, with the `compose` plugin | The service user must belong to the `docker` group |
| Network | HTTP access to the model hosts | No Internet access needed after installation |
| Models | At least one embedding model and one rerank model (§6) | The chat model is optional |

Prepare the following as well:

- a DNS name for the server (for example, `brain.company.local`);
- a TLS certificate for that name, or the internal CA created by `scripts/dev-ca.sh`;
- the addresses of the model servers on the company network and their API key, or the model files on the server itself (§6).

## 3. Prepare the server

Run these commands as a user with `sudo`.

1. Install base packages and Node.js 22 (NodeSource repository):

   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node -v    # must be v22.19 or newer
   ```

2. Install Docker Engine with the `compose` plugin. Follow the official guide for your distribution: <https://docs.docker.com/engine/install/>. Then verify:

   ```bash
   docker compose version
   ```

3. Create a dedicated service user. Do not use root.

   ```bash
   sudo adduser --disabled-password brain
   sudo usermod -aG docker brain
   ```

4. If the service user does not have `sudo`, enable linger so user services start without an active login:

   ```bash
   sudo loginctl enable-linger brain
   ```

## 4. Installation

1. Switch to the service user and get the code. Use the repository URL or the release archive you want to install:

   ```bash
   sudo -iu brain
   git clone <repository URL> hivevault
   cd hivevault
   ```

   Alternatively, from a workstation that has the repository: `bash scripts/deploy.sh --install --target brain@<server> --host brain.company.local`. The script copies the code over SSH and runs the steps below (operator guide, §4).

2. Run the installation script:

   ```bash
   bash scripts/install.sh --host brain.company.local --port 443 \
     --tls-cert /etc/ssl/brain/cert.pem --tls-key /etc/ssl/brain/key.pem
   ```

   | Option | Meaning | Default |
   |---|---|---|
   | `--host` | Server hostname; becomes `PUBLIC_URL` (required) | — |
   | `--port` | HTTP or HTTPS port of the server | 3700 |
   | `--tls-cert`, `--tls-key` | TLS certificate and key (readable by the service user) | none: HTTP |
   | `--data-dir` | Data directory (encrypted documents, keys, exports) | `data` inside the code folder |
   | `--systemd` | `system` (system service, needs `sudo`), `user` (user service), `none` (no service), `auto` | `auto` |

   The script:
   - checks Node.js, Docker, and free disk space;
   - writes `.env` with random passwords and keys (mode 600) and `MODELS_OFFLINE_MODE=queue`;
   - installs dependencies and builds the web interface;
   - starts PostgreSQL and applies migrations;
   - sets up backups and runs the first full backup;
   - installs the `hivevault` systemd service and backup timers.

   If you run the script again, an existing `.env` file is preserved.

3. Create the first administrator inside the code folder:

   ```bash
   npm run cb -- admin create first.last --name "First Last"
   npm run cb -- enroll <activation code>
   ```

   The second command shows a QR code. Scan it with your authenticator app. Save the recovery codes in a safe place. The first administrator is a person appointed by the company.

## 5. Copy the keys off the server

Do this step immediately. Without these two keys, data cannot be recovered.

| Key | Location | Without the key |
|---|---|---|
| Master key | `data/.master-key` | Encrypted original documents can no longer be read |
| Backup passphrase | `PGBACKREST_CIPHER_PASS` in `.env` | Database backups cannot be restored |

Store both keys in a password vault or on offline media. Do not store them on the same disk as the server. Record who can access them: those people can read all data (privacy.md, §3.8).

## 6. Models

HiveVault never sends documents outside the company network. Models run on the server itself or on hosts inside the company network. The server always connects to the model hosts you configure: use company hosts only.

| Model | Purpose | Without the model |
|---|---|---|
| Embedding | Indexing and semantic search | Documents stay queued and do not become semantically searchable |
| Rerank | Re-ranking search results | Search is less accurate |
| Chat | Page compilation, answers, LLM-assisted nightly cycle | Compilations stay queued; search and reading still work |
| OCR (optional) | Scans and photos | Images stay marked "Needs OCR" |

**Models on network hosts.** Set in `.env`:

```bash
LLAMA_SERVER_URL=http://models.company.local:8000      # chat (optional)
REMOTE_EMBED_URLS=http://models.company.local:8080     # embedding
REMOTE_RERANK_URLS=http://models.company.local:8081    # rerank
MODELS_API_KEY=<llama-server key>
```

**Models on the server itself.** Copy the GGUF files for `EMBED_MODEL_ID` and `RERANK_MODEL_ID` into `data/models/` and set `LOCAL_MODELS_ENABLED=true` and `LOCAL_LLAMA_BIN` (path to `llama-server`).

Then restart the service (`systemctl --user restart hivevault` for user services):

```bash
sudo systemctl restart hivevault
```

Check endpoints in the console: **Console → Models → Test**. For embeddings, the model must match the already-stored vectors (`EMBED_MODEL_ID`). The dispatcher refuses any endpoint serving a different model.

## 7. HTTPS

Outside `localhost`, always use HTTPS. Passkeys and secure cookies do not work without HTTPS.

- With a company certificate: pass `--tls-cert` and `--tls-key` to the script, or set `TLS_CERT_FILE` and `TLS_KEY_FILE` in `.env`.
- Without a company CA: `bash scripts/dev-ca.sh brain.company.local` creates a local CA and a server certificate. Install `data/tls/ca.pem` as a trusted root CA on user computers.
- Behind a reverse proxy: set `TRUST_PROXY` to a comma-separated list of proxy addresses. Each entry is an IP address or a CIDR range. Example for a proxy on the same server: `TRUST_PROXY=127.0.0.1,::1`. With multiple chained proxies, list all proxy addresses. The server takes the client IP from the last address in `X-Forwarded-For` that is not in the proxy list.
- The proxy must overwrite `X-Forwarded-For` with the client IP. It must not append to a client-supplied header. Example for nginx: `proxy_set_header X-Forwarded-For $remote_addr;`.
- Without a reverse proxy, leave `TRUST_PROXY=false`. The server refuses to start with `TRUST_PROXY=true`, with a range matching all addresses (such as `0.0.0.0/0`), or with an invalid value. The error message is written to the service log.

## 8. Final check

1. Open `https://brain.company.local` and sign in as the administrator.
2. Open **Dashboard → Overview**: panels show data after 2 minutes.
3. Run a full restore test:

   ```bash
   npm run backup -- verify
   ```

   The command restores the latest backup into a temporary container and verifies the data. It must finish with "Restore verified" (or "Ripristino verificato").
4. Verify the audit chain: `npm run cb -- audit verify`.
5. Complete the [release checklist](../RELEASE.md) and [checklist §4.1](../security/privacy.md#41-who-installs-and-operates-the-server).

## 9. Handover to the company and administrator

The installer hands over to the company:

- the server URL and the first administrator account;
- the storage location of the two keys (§5) and the list of people who can access them;
- the list of people with OS and database access (system administrators);
- the configured model hosts and the value of `EGRESS_ALLOW`;
- the backup schedule and the result of the restore verification test.

Before creating users, the first administrator completes these steps:

1. **Console → Settings → Privacy**: set read-log retention days and email ingestion according to company decisions ([guide, §9](administrator.md#9-settings)).
2. **Console → Settings**: adapt the cloud agent notice to the company privacy notice and set the nightly cycle window.
3. **Console → Teams**: create teams ([guide, §2](administrator.md#2-users)).
4. **Console → Users**: create users, place them in at least one team, and send them their activation links.
5. **Console → Vaults**: create personal cells (they start as "personal") and shared spaces ([guide, §4](administrator.md#4-vaults-and-spaces)).
6. **Console → Permissions**: assign permissions, to teams whenever possible ([guide, §5](administrator.md#5-permissions)).
7. **Console → API accounts**: create cloud agent accounts only after signing the agreement with its provider ([guide, §3](administrator.md#3-api-accounts-and-cloud-agent)).

## 10. Common issues

| Problem | Cause | Solution |
|---|---|---|
| "user cannot use Docker" | The user is not in the `docker` group | `sudo usermod -aG docker brain`, then sign out and back in |
| Service does not start after a server reboot | User service without linger | `sudo loginctl enable-linger brain` |
| Service refuses to start: `TRUST_PROXY=true is no longer accepted` | `.env` contains `TRUST_PROXY=true`. `TRUST_PROXY` now requires explicit proxy addresses | Set your reverse proxy addresses (§7), or `TRUST_PROXY=false` if there is no proxy |
| Dashboard panels stay empty | The server has been up for less than a minute | Wait 2 minutes; check `journalctl -u hivevault` |
| Documents stay "queued" | No active embedding endpoint | Configure models (§6) and check **Console → Models** |
| "Different model" on the Models page | The endpoint uses a different embedding model | Use the exact same GGUF file across all hosts |
| Passkeys do not work | Site runs over HTTP or hostname does not match `PUBLIC_URL` | Use HTTPS and match `PUBLIC_URL` |
| Node client or cloud agent: HTTP encoding errors toward the server | An antivirus intercepts local HTTP traffic (for example, Avast Web Shield) | Add an exclusion for the server address |
