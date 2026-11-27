not production ready, require maaaany tests.

# HiveVault

Self-hosted memory server for a company, organized as a **hive memory**: one vault for each person, edge, team and project, and shared company spaces above them. Documents stay on the server. Knowledge is compiled into linked Markdown pages and is optimized for cloud agents (MCP, token budgets, stable citations).

The project follows the LLM-Wiki pattern. Durable tasks, workflows and the wiki are its own implementation.

- Development plan: [docs/PIANO_DI_SVILUPPO.md](docs/PIANO_DI_SVILUPPO.md)
- Rules for coding agents: [AGENTS.md](AGENTS.md)
- Phase reports: [docs/spikes/](docs/spikes/); screens of the web app: [docs/ui/](docs/ui/)

## Cloud agent

A cloud agent reads the company memory through the MCP server at `POST /mcp` with an API key (streamable HTTP). In an agent client with plugins, install the plugin of this repository (MCP server + skills): see [skills/README.md](skills/README.md). For the development server, `scripts/seed-demo.ts` writes a key of the account `agent-demo` in `data/dev-demo.json`. Configure the MCP client with:

- transport: streamable HTTP
- URL: `http://localhost:3700/mcp`
- header: `Authorization: Bearer <mcpKey>`

## Install on a server

To install HiveVault for a company, follow the [installation guide](docs/guide/installazione.md) (Italian). It lists the tasks of each person:

| Person | Guide | Checklist |
|---|---|---|
| Who installs and runs the server | [installation](docs/guide/installazione.md), [operator](docs/guide/operatore.md) | [privacy §4.1](docs/sicurezza/privacy.md#41-chi-installa-e-gestisce-il-server), [release checklist](docs/RILASCIO.md) |
| Company that adopts the software (controller) | [privacy and compliance](docs/sicurezza/privacy.md) | [privacy §4.2](docs/sicurezza/privacy.md#42-azienda-che-adotta-il-software-titolare) |
| Administrators of HiveVault | [administrator](docs/guide/amministratore.md) | [privacy §4.3](docs/sicurezza/privacy.md#43-amministratori-di-hivevault) |
| Users | [user](docs/guide/utente.md) | [privacy §4.5](docs/sicurezza/privacy.md#45-utenti) |

The sections below are for development.

## Requirements (development)

- Node.js 22.19 or newer
- Docker (PostgreSQL 17 + pgvector)
- Optional: a `llama-server` binary and the embedding and reranker models (GGUF) in `data/models/` (`LOCAL_MODELS_ENABLED=true`, `LOCAL_LLAMA_BIN`)

## Start (development)

```bash
npm install
cp .env.example .env
npm run db:up
npm run db:migrate
npm test
```

Server and first administrator:

```bash
npm run cb -- admin create <username> --name "Nome Cognome"
npm run cb -- enroll <activation code>
npm start
```

HTTPS on a LAN (needed for passkeys outside localhost): `bash scripts/dev-ca.sh <host or IP>`, then set `TLS_CERT_FILE`, `TLS_KEY_FILE` and `PUBLIC_URL` in `.env` and import `data/tls/ca.pem` as a trusted root on the client computers.

Web app in development (Vite on port 5310, API on 3700 through the Vite proxy):

```bash
npx tsx scripts/seed-demo.ts
npm start
npm run web:dev
```

Open `http://localhost:5310` and log in as `demo` with the code that `npx tsx scripts/dev-totp.ts` prints. For the console and the dashboards, `npx tsx scripts/dev-admin.ts` creates the administrator `admin` and prints its code. The kitchen sink of the themes is at `http://localhost:5310/kitchen.html`.

In production the server serves the built app (`npm run web:build`, `WEB_DIR=packages/web/dist`) on its own port.

## Commands

| Command | Purpose |
|---|---|
| `bash scripts/deploy.sh [--install --host <name>] [--status] [--rollback]` | Install or update a server from this computer over SSH (`--target user@host` or `DEPLOY_TARGET` is required): release folders, backup, migrations, health check with automatic rollback ([operator guide §4](docs/guide/operatore.md#4-aggiornamento)) |
| `bash scripts/install.sh --host <name>` | Production install on Linux: `.env` with random secrets, build, database, backups, systemd service and timers ([guide](docs/guide/installazione.md)) |
| `npm start` | HTTP server (API) |
| `npm run cb -- <command>` | CLI: `admin create`, `enroll`, `key gen`, `login --key` |
| `npm run lint` | Type check of the Node packages |
| `npm run check -w @cb/web` | Type check of the Svelte app |
| `npm test` | Unit and database tests (database tests skip themselves when Postgres is down) |
| `npm run e2e` | Playwright tests of the web app in the four themes (uses the installed Edge; `E2E_CHANNEL=chrome` for Chrome) |
| `npm run web:build` | Builds the web app into `packages/web/dist` |
| `npx tsx scripts/seed-demo.ts` | Demo data for the web app (user `demo`, development only): two cells and the hive space they feed |
| `npx tsx bench/phase6/eval.ts --ask 30` | Retrieval eval with the real models (stop the server first: it starts its own model processes) |
| `npm run backup -- full\|diff\|info\|check\|verify` | pgBackRest backups; `verify` restores the latest backup to a point in time in a temporary container and checks the data |
| `npx tsx bench/phase8/load-seed.ts` + `bench/phase8/load.js` | Load test with k6 (official Docker image), see the phase 8 report |
| `npx tsx scripts/dev-admin.ts` | Administrator `admin` for the console and the dashboards (development only); prints the current code |
| `npx tsx bench/phase7/metrics-bench.ts --days 7` | 7 days of one-minute metrics, rollups and the queries of the 10 dashboards (own database `brain_bench`; `--db brain` fills the development database) |
| `npx tsx scripts/dream-now.ts <vault slug>` | Runs the dream cycle of one vault now, through the running server (development) |
| `npm run corpus -- --seed 42 --out data/corpus/dev` | Synthetic corpus with facts, contradictions and evaluation questions |
| `npm run spike:a -- 300 3 700` | Task engine with real process kills |
| `npm run spike:c -- --checkpoints 1000000,2000000,5000000` | PostgreSQL + pgvector at scale |
| `npm run spike:d -- --bin <llama-server> --model <model.gguf>` | Embeddings on CPU, local and remote |
| `npm run bench:phase1 -- --chunks 1000000` | Query engine on 1M chunks (data deleted at the end) |
| `npx tsx bench/corpus/formats.ts --per 20` | Test corpus: 20 files for each of 13 formats |
| `npx tsx bench/phase3/crash.ts 60 2 1500` | Ingestion and compilation with worker kills |
| `npx tsx bench/phase3/import.ts 1000000 2 60 --ingest-wait` | Bulk import of N synthetic files with progress |
| `npm run spike:c2 -- --target paradedb` | Full-text: tsvector vs ParadeDB (needs `docker compose --profile spikes up -d paradedb`) |

## License and disclaimer

MIT: see [LICENSE](LICENSE). The software is provided "as is", without warranty of any kind, and the authors are not liable for its use. The authors do not operate any installation and receive no data: the organization that installs and uses the software is responsible for its operation and for the compliance with data protection law. The documents in `docs/` are not legal advice. Details in [DISCLAIMER.md](DISCLAIMER.md).

HiveVault is not affiliated with any product or trademark with a similar name. Obsidian, Qwen, llama.cpp and the other names cited are trademarks of their owners; the project is not affiliated with them.
