#!/usr/bin/env bash
# Server side of scripts/deploy.sh (runs on the server, from the release folder). Do not run it
# by hand unless scripts/deploy.sh cannot: `bash releases/<id>/scripts/deploy-remote.sh update
# --dir hivevault --id <id>`.
set -euo pipefail

MODE="$1"; shift
DIR="hivevault"; ID=""; KEEP=3; INSTALL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) INSTALL_ARGS+=("$1"); shift ;;
  esac
done

BASE="$HOME/$DIR"
REL="$BASE/releases"
SHARED="$BASE/shared"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERRORE: %s\033[0m\n' "$*" >&2; exit 1; }
mkdir -p "$REL" "$SHARED/data"

# service manager: user units (systemctl --user) or system units
if [ -f "$HOME/.config/systemd/user/hivevault.service" ]; then SC=(systemctl --user)
elif [ -f /etc/systemd/system/hivevault.service ]; then SC=(sudo -n systemctl)
else SC=(); fi
svc() { [ ${#SC[@]} -gt 0 ] && "${SC[@]}" "$@"; }
current_id() { [ -L "$BASE/current" ] && basename "$(readlink "$BASE/current")" || true; }
port() { grep -E '^PORT=' "$SHARED/.env" 2>/dev/null | cut -d= -f2- || echo 3700; }

env_get() { grep -E "^$1=" "$SHARED/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
env_set() {
  # replaces KEY=... or appends it; the value never contains "|"
  if grep -qE "^$1=" "$SHARED/.env"; then sed -i "s|^$1=.*|$1=$2|" "$SHARED/.env"; else echo "$1=$2" >> "$SHARED/.env"; fi
}

health() {
  local p scheme=http; p=$(port); p=${p:-3700}
  # loopback check of a running server: the certificate names the LAN address, not 127.0.0.1
  [ -n "$(env_get TLS_CERT_FILE)" ] && scheme=https
  for _ in $(seq 1 60); do
    if curl -fsSk -m 3 "${scheme}://127.0.0.1:${p}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

switch_to() {
  ln -sfn "releases/$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
}

link_shared() {
  # every release reads the same configuration and data
  ln -sfn "$SHARED/.env" "$REL/$1/.env"
}

case "$MODE" in
  status)
    echo "Server: $(hostname) · cartella $BASE"
    echo "In esecuzione: $(current_id) ($(cat "$BASE/current/REVISION" 2>/dev/null | cut -c1-12))"
    echo "Versioni:"; ls -1t "$REL" | sed 's/^/  /'
    svc is-active hivevault >/dev/null 2>&1 && echo "Servizio: attivo" || echo "Servizio: NON attivo"
    health && echo "Salute: ok (porta $(port))" || echo "Salute: il server non risponde"
    exit 0 ;;

  tls)
    # certificate and key copied by deploy.sh to shared/tls/*.new: switch the server to HTTPS
    [ -f "$SHARED/.env" ] || fail "manca $SHARED/.env"
    T="$SHARED/tls"
    [ -s "$T/cert.pem.new" ] && [ -s "$T/key.pem.new" ] || fail "certificato o chiave mancanti in $T"
    openssl x509 -in "$T/cert.pem.new" -noout >/dev/null 2>&1 || fail "il certificato non è un PEM valido"
    [ "$(openssl x509 -in "$T/cert.pem.new" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$T/key.pem.new" -pubout | openssl sha256)" ] || fail "la chiave non corrisponde al certificato"
    stamp=$(date +%Y%m%d-%H%M%S)
    cp -p "$SHARED/.env" "$SHARED/.env.bak-$stamp"
    for f in cert.pem key.pem; do [ -f "$T/$f" ] && cp -p "$T/$f" "$T/$f.bak-$stamp"; mv -f "$T/$f.new" "$T/$f"; done
    chmod 600 "$T/key.pem"
    env_set TLS_CERT_FILE "$T/cert.pem"
    env_set TLS_KEY_FILE "$T/key.pem"
    url=$(env_get PUBLIC_URL); env_set PUBLIC_URL "${url/#http:/https:}"
    say "HTTPS: $(openssl x509 -in "$T/cert.pem" -noout -ext subjectAltName | tail -1 | xargs), fino al $(openssl x509 -in "$T/cert.pem" -noout -enddate | cut -d= -f2)"
    svc restart hivevault || true
    if [ ${#SC[@]} -gt 0 ] && ! health; then
      echo "Il server non risponde in HTTPS: torno alla configurazione di prima"
      cp -p "$SHARED/.env.bak-$stamp" "$SHARED/.env"
      for f in cert.pem key.pem; do [ -f "$T/$f.bak-$stamp" ] && mv -f "$T/$f.bak-$stamp" "$T/$f"; done
      svc restart hivevault || true
      fail "HTTPS non attivato; log: journalctl ${SC[*]/systemctl/} -u hivevault -n 50"
    fi
    say "HTTPS attivo: $(env_get PUBLIC_URL)"
    exit 0 ;;

  rollback)
    cur=$(current_id)
    prev=$(ls -1t "$REL" | grep -v "^${cur}$" | grep -v '\.tmp$' | head -1)
    [ -n "$prev" ] || fail "nessuna versione precedente sul server"
    say "Ritorno da $cur a $prev"
    echo "Attenzione: le migrazioni del database applicate da $cur restano. Se servono, ripristina un backup (guida dell'operatore §3)."
    svc stop hivevault || true
    switch_to "$prev"
    svc start hivevault
    health || fail "la versione $prev non risponde: controlla journalctl ${SC[*]/systemctl/} -u hivevault"
    echo "In esecuzione: $prev"
    exit 0 ;;

  install)
    [ -n "$ID" ] || fail "--id mancante"
    [ ! -L "$BASE/current" ] || fail "HiveVault è già installato in $BASE: usa l'aggiornamento"
    link_shared "$ID"
    switch_to "$ID"
    say "Installazione di $ID"
    cd "$BASE/current"
    bash scripts/install.sh --data-dir "$SHARED/data" "${INSTALL_ARGS[@]}"
    exit 0 ;;

  update)
    [ -n "$ID" ] || fail "--id mancante"
    [ -L "$BASE/current" ] || fail "HiveVault non è installato in $BASE: usa --install"
    [ -f "$SHARED/.env" ] || fail "manca $SHARED/.env"
    prev=$(current_id)
    link_shared "$ID"
    new="$REL/$ID"

    # 1. build the new release while the old one serves
    say "Dipendenze e build di $ID (la versione $prev resta in servizio)"
    cd "$new"
    npm ci --no-audit --no-fund
    npm run web:build

    # 2. a restore point before the migrations
    say "Backup differenziale prima dell'aggiornamento"
    cd "$BASE/current"
    npm run backup -- diff

    # 3. database image and settings of the new release (recreated only if they changed)
    say "Database"
    cd "$new"
    docker compose build postgres
    docker compose up -d postgres pgbouncer
    for _ in $(seq 1 60); do docker compose exec -T postgres pg_isready -U brain -d brain >/dev/null 2>&1 && break; sleep 2; done

    # 4. switch: stop, migrate, start
    say "Passaggio da $prev a $ID"
    svc stop hivevault || true
    switch_to "$ID"
    if ! (cd "$BASE/current" && npm run db:migrate); then
      echo "Migrazione non riuscita: torno a $prev"
      switch_to "$prev"; svc start hivevault || true
      fail "migrazione non riuscita (il database è al punto del backup appena fatto se serve ripristinarlo)"
    fi
    svc start hivevault || true

    # 5. health check, rollback on failure
    if [ ${#SC[@]} -gt 0 ] && ! health; then
      echo "La nuova versione non risponde: torno a $prev"
      svc stop hivevault || true
      switch_to "$prev"
      svc start hivevault || true
      health && echo "Versione $prev di nuovo in servizio" || echo "ATTENZIONE: anche $prev non risponde"
      fail "aggiornamento annullato; log: journalctl ${SC[*]/systemctl/} -u hivevault -n 50"
    fi

    # 6. keep the last releases (never the running one or the previous one)
    keep_list=$(ls -1t "$REL" | grep -v '\.tmp$' | head -n "$KEEP")
    for r in $(ls -1t "$REL"); do
      if ! grep -qx "$r" <<<"$keep_list" && [ "$r" != "$ID" ] && [ "$r" != "$prev" ]; then rm -rf "${REL:?}/$r"; fi
    done
    say "Aggiornato a $ID"
    [ ${#SC[@]} -gt 0 ] && echo "Servizio attivo, salute ok (porta $(port))" || echo "Nessun servizio systemd: avvia il server a mano (npm start in $BASE/current)"
    exit 0 ;;

  *) fail "modo sconosciuto: $MODE" ;;
esac
