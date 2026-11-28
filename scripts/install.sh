#!/usr/bin/env bash
# HiveVault — installation on a Linux server (Debian 12 / Ubuntu 22.04 or newer).
# See docs/guides/installation.md. Run from the repository folder as the user that runs the
# service (not root):
#
#   bash scripts/install.sh --host brain.azienda.local [--port 3700] [--tls-cert f --tls-key f]
#                           [--data-dir /srv/brain/data] [--systemd auto|system|user|none]
#
# What it does:
#  1. checks Node.js >= 22.19, Docker with compose, free disk
#  2. writes .env with random secrets (database, backup passphrase, metrics token)
#  3. installs the dependencies, builds the web app, starts PostgreSQL, applies the migrations
#  4. creates the pgBackRest stanza and the first full backup
#  5. installs the service and the backup timers: system units (needs sudo) or, without
#     sudo, user units of the service account (systemctl --user, with linger)
#  6. prints the next steps (first administrator, TLS, copy of the keys)
# Running it again keeps an existing .env and its secrets.
set -euo pipefail

HOST=""; PORT=3700; CERT=""; KEY=""; DATA_DIR=""; SYSTEMD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --tls-cert) CERT="$2"; shift 2 ;;
    --tls-key) KEY="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --systemd) SYSTEMD="$2"; shift 2 ;;
    --no-systemd) SYSTEMD=none; shift ;;
    -h|--help) sed -n 2,17p "$0"; exit 0 ;;
    *) echo "Opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo "Indica il nome del server: --host brain.azienda.local" >&2; exit 2; }
case "$SYSTEMD" in auto|system|user|none) ;; *) echo "--systemd: auto, system, user o none" >&2; exit 2 ;; esac

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERRORE: %s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------- 1. checks
say "Controlli"
[ "$(id -u)" -ne 0 ] || fail "non eseguire lo script come root: usa l'utente del servizio"
command -v node >/dev/null || fail "Node.js non trovato (serve la versione 22.19 o successiva)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' || fail "Node.js $(node -v): serve la 22.19 o successiva"
command -v docker >/dev/null || fail "Docker non trovato"
docker compose version >/dev/null 2>&1 || fail "manca il plugin docker compose"
docker info >/dev/null 2>&1 || fail "l'utente $(whoami) non può usare Docker (aggiungilo al gruppo docker)"
FREE_GB=$(df -Pk "$ROOT" | awk 'NR==2 {print int($4/1024/1024)}')
[ "$FREE_GB" -ge 20 ] || fail "spazio libero ${FREE_GB} GB: ne servono almeno 20 (vedi la formula del piano, §2.5)"
if [ -n "$CERT" ] || [ -n "$KEY" ]; then
  [ -r "$CERT" ] && [ -r "$KEY" ] || fail "certificato o chiave TLS non leggibili"
fi
if [ "$SYSTEMD" = auto ]; then
  if ! command -v systemctl >/dev/null; then SYSTEMD=none
  elif sudo -n true 2>/dev/null; then SYSTEMD=system
  elif systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ]; then SYSTEMD=user
  else SYSTEMD=none; fi
fi
echo "Node $(node -v), $(docker compose version --short 2>/dev/null || echo compose), ${FREE_GB} GB liberi, servizi: ${SYSTEMD}"

# --------------------------------------------------------------------------- 2. .env
say "Configurazione (.env)"
rand() { node -e "console.log(require('crypto').randomBytes($1).toString('base64url'))"; }
if [ -f .env ]; then
  echo ".env esiste già: lo lascio com'è"
else
  DBPASS=$(rand 24); BKPASS=$(rand 32); MTOKEN=$(rand 32)
  SCHEME=http; [ -n "$CERT" ] && SCHEME=https
  # .env may be a symbolic link to a shared file (scripts/deploy.sh): write through it
  # The sed program and the grep pattern come on stdin (-f -), never in the command line:
  # every local user can read the arguments of a process (/proc/<pid>/cmdline).
  sed -f - \
      ${DATA_DIR:+-e "s#^DATA_DIR=.*#DATA_DIR=${DATA_DIR}#"} \
      .env.example > .env <<EOF
s#^DATABASE_URL=.*#DATABASE_URL=postgres://brain:${DBPASS}@127.0.0.1:5432/brain#
s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=${DBPASS}#
s#^HOST=.*#HOST=0.0.0.0#
s#^PORT=.*#PORT=${PORT}#
s#^PUBLIC_URL=.*#PUBLIC_URL=${SCHEME}://${HOST}$( [ "$PORT" = 443 ] || echo ":${PORT}")#
s#^TLS_CERT_FILE=.*#TLS_CERT_FILE=${CERT}#
s#^TLS_KEY_FILE=.*#TLS_KEY_FILE=${KEY}#
s#^METRICS_TOKEN=.*#METRICS_TOKEN=${MTOKEN}#
s#^MODELS_OFFLINE_MODE=.*#MODELS_OFFLINE_MODE=queue#
s#^PGBACKREST_CIPHER_PASS=.*#PGBACKREST_CIPHER_PASS=${BKPASS}#
EOF
  grep -q -f - .env <<EOF || fail ".env senza passphrase dei backup"
^PGBACKREST_CIPHER_PASS=${BKPASS}
EOF
  grep -q '^PORT=' .env || echo "PORT=${PORT}" >> .env
  chmod 600 "$(readlink -f .env)"
  echo ".env scritto con segreti casuali (permessi 600)"
fi
DATA=$(grep -E '^DATA_DIR=' .env | cut -d= -f2-); DATA=${DATA:-data}
mkdir -p "$DATA"

# --------------------------------------------------------------------------- 3. build and database
say "Dipendenze e build"
npm ci --no-audit --no-fund
npm run web:build

say "Database"
docker compose build postgres
docker compose up -d postgres pgbouncer
for i in $(seq 1 60); do docker compose exec -T postgres pg_isready -U brain -d brain >/dev/null 2>&1 && break; sleep 2; done
docker compose exec -T postgres pg_isready -U brain -d brain >/dev/null || fail "PostgreSQL non risponde"
npm run db:migrate

# --------------------------------------------------------------------------- 4. backup
say "Backup (pgBackRest)"
npm run backup -- stanza
if ! docker compose exec -T -u postgres postgres pgbackrest --stanza=brain info --output=json | grep -q '"label"'; then
  npm run backup -- full
fi

# --------------------------------------------------------------------------- 5. systemd
if [ "$SYSTEMD" != none ]; then
  say "Servizio e timer di backup (systemd, ${SYSTEMD})"
  U=$(whoami); NODE=$(command -v node); NPM=$(command -v npm)
  NODE_PATH_DIR=$(dirname "$NODE")
  if [ "$SYSTEMD" = system ]; then
    unit() { sudo tee "/etc/systemd/system/$1" >/dev/null; }
    ctl() { sudo systemctl "$@"; }
    USER_LINE="User=${U}"; DEPENDS="After=docker.service network-online.target
Requires=docker.service"; WANTED=multi-user.target
    EXTRA="AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full"
  else
    # user units of the service account: they start at boot only with linger
    mkdir -p "$HOME/.config/systemd/user"
    unit() { cat > "$HOME/.config/systemd/user/$1"; }
    ctl() { systemctl --user "$@"; }
    USER_LINE=""; DEPENDS="After=network-online.target"; WANTED=default.target
    EXTRA="NoNewPrivileges=true"
    [ "$(loginctl show-user "$U" -p Linger --value 2>/dev/null)" = yes ] || loginctl enable-linger "$U" 2>/dev/null || \
      echo "ATTENZIONE: linger non attivo: il servizio parte solo dopo un accesso di ${U} (sudo loginctl enable-linger ${U})"
  fi
  unit hivevault.service <<EOF
[Unit]
Description=HiveVault
${DEPENDS}

[Service]
${USER_LINE}
WorkingDirectory=${ROOT}
Environment=PATH=${NODE_PATH_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${NODE} ${ROOT}/node_modules/tsx/dist/cli.mjs ${ROOT}/packages/server/src/index.ts
Restart=on-failure
RestartSec=5
${EXTRA}
LimitNOFILE=65536

[Install]
WantedBy=${WANTED}
EOF
  for kind in full diff verify; do
    unit "hivevault-backup-${kind}.service" <<EOF
[Unit]
Description=HiveVault: backup ${kind}

[Service]
Type=oneshot
${USER_LINE}
WorkingDirectory=${ROOT}
Environment=PATH=${NODE_PATH_DIR}:/usr/local/bin:/usr/bin:/bin
ExecStart=${NPM} run backup -- ${kind}
EOF
  done
  timer() { unit "hivevault-backup-$1.timer" <<EOF
[Unit]
Description=$2

[Timer]
OnCalendar=$3
Persistent=true

[Install]
WantedBy=timers.target
EOF
  }
  timer full "HiveVault: backup completo settimanale" "Sun 02:30"
  timer diff "HiveVault: backup differenziale giornaliero" "Mon..Sat 02:30"
  timer verify "HiveVault: prova di ripristino mensile" "*-*-01 04:00"
  ctl daemon-reload
  ctl enable --now hivevault.service hivevault-backup-full.timer hivevault-backup-diff.timer hivevault-backup-verify.timer
  echo "Servizio hivevault attivo; timer di backup attivi (completo domenica, differenziale gli altri giorni, prova di ripristino il 1° del mese)"
fi

# --------------------------------------------------------------------------- 6. next steps
say "Fatto"
SC="sudo systemctl"; [ "$SYSTEMD" = user ] && SC="systemctl --user"
cat <<EOF
Prossimi passi (docs/guides/installation.md):
  1. Primo amministratore:   npm run cb -- admin create <nome> --name "Nome Cognome"
                             npm run cb -- enroll <codice di attivazione>
  2. Copia FUORI dal server, in un posto sicuro:
       - ${DATA}/.master-key            (senza di essa i documenti originali non si leggono)
       - PGBACKREST_CIPHER_PASS in .env (senza di essa i backup non si ripristinano)
  3. HTTPS: senza --tls-cert/--tls-key il server è in HTTP; le passkey e la sicurezza
     dei cookie richiedono HTTPS fuori da localhost (scripts/dev-ca.sh crea una CA aziendale).
  4. Modelli: LLAMA_SERVER_URL, REMOTE_EMBED_URLS, REMOTE_RERANK_URLS e MODELS_API_KEY in .env,
     poi: ${SC} restart hivevault
  5. Controllo: npm run backup -- verify   (prova di ripristino completa)
EOF
