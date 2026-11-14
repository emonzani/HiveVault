#!/usr/bin/env bash
# HiveVault — installation and update of a server from this computer, over SSH.
# See docs/guide/operatore.md §4. The code goes as an archive of a git commit (no git remote).
#
#   bash scripts/deploy.sh                          update the server to the current commit
#   bash scripts/deploy.sh --install --host <name>  first installation (runs scripts/install.sh)
#   bash scripts/deploy.sh --rollback               back to the previous release
#   bash scripts/deploy.sh --status                 releases on the server and service state
#   bash scripts/deploy.sh --tls <cert> <key>       HTTPS: install (or renew) the certificate
#
# Options: --target user@host (required, or the variable DEPLOY_TARGET), --dir <folder in the home>
# (default hivevault), --ref <commit> (default HEAD), --keep <n> releases (default 3),
# --allow-dirty (deploy HEAD even with uncommitted changes, which are NOT included),
# --working-tree (deploy the files as they are now, new files included and ignored files such
# as .env and data/ excluded, without making a commit: for a test of a deploy).
#
# Layout on the server (~/hivevault):
#   releases/<commit>/   one folder per deployed commit
#   current -> releases/<commit>   the running release (service WorkingDirectory)
#   shared/.env, shared/data/      configuration and data, shared by all releases
# An update builds the new release while the old one serves, makes a differential backup,
# migrates, switches `current`, restarts and checks /api/health; on failure it goes back to the
# previous release by itself. Database migrations are not undone: restore from the backup.
set -euo pipefail

TARGET="${DEPLOY_TARGET:-}"; DIR="hivevault"; REF="HEAD"; KEEP=3
MODE=update; DIRTY=0; WT=0; INSTALL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --allow-dirty) DIRTY=1; shift ;;
    --working-tree) WT=1; shift ;;
    --install) MODE=install; shift ;;
    --rollback) MODE=rollback; shift ;;
    --status) MODE=status; shift ;;
    --tls) MODE=tls; TLS_CERT="$2"; TLS_KEY="$3"; shift 3 ;;
    --host|--port|--tls-cert|--tls-key|--systemd) INSTALL_ARGS+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n 2,22p "$0"; exit 0 ;;
    *) echo "Opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TARGET" ] || { echo "Indica il server: --target utente@host oppure DEPLOY_TARGET=utente@host" >&2; exit 2; }

cd "$(dirname "$0")/.."
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERRORE: %s\033[0m\n' "$*" >&2; exit 1; }
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET")

"${SSH[@]}" true 2>/dev/null || fail "SSH verso $TARGET non riuscito (serve l'accesso con chiave)"

if [ "$MODE" = tls ]; then
  # certificate files go to shared/tls (kept by every release); the key never goes to git
  [ -r "$TLS_CERT" ] && [ -r "$TLS_KEY" ] || fail "certificato o chiave non leggibili"
  "${SSH[@]}" "mkdir -p ~/$DIR/shared/tls && chmod 700 ~/$DIR/shared/tls"
  tr -d '\r' < "$TLS_CERT" | "${SSH[@]}" "umask 077 && cat > ~/$DIR/shared/tls/cert.pem.new"
  tr -d '\r' < "$TLS_KEY" | "${SSH[@]}" "umask 077 && cat > ~/$DIR/shared/tls/key.pem.new"
  # the script of this computer: the mode may be newer than the running release
  tr -d '\r' < scripts/deploy-remote.sh | "${SSH[@]}" "bash -s -- tls --dir $DIR"
  exit
fi

if [ "$MODE" = status ] || [ "$MODE" = rollback ]; then
  # these use the script of the release that runs now
  "${SSH[@]}" "bash ~/$DIR/current/scripts/deploy-remote.sh $MODE --dir $DIR --keep $KEEP"
  exit
fi

# --------------------------------------------------------------------------- the release
if [ "$WT" = 1 ]; then
  # a tree of the current files through a temporary index: no commit, no branch moves
  IDX=$(mktemp); cp "$(git rev-parse --git-dir)/index" "$IDX"
  GIT_INDEX_FILE="$IDX" git add -A
  COMMIT=$(GIT_INDEX_FILE="$IDX" git write-tree); rm -f "$IDX"
  ID="wt-$(git rev-parse --short=10 "$COMMIT")"
elif ! COMMIT=$(git rev-parse --verify "$REF^{commit}" 2>/dev/null); then fail "commit $REF non trovato"
else ID=$(git rev-parse --short=12 "$COMMIT"); fi
if [ "$WT" = 0 ] && [ "$REF" = HEAD ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  [ "$DIRTY" = 1 ] || fail "ci sono modifiche non salvate in un commit: fai il commit (o usa --allow-dirty: le modifiche non sono incluse)"
  echo "Attenzione: le modifiche non salvate in un commit NON sono incluse"
fi
DESC=$([ "$WT" = 1 ] && echo "file attuali, base $(git rev-parse --short HEAD)" || git log -1 --format=%s "$COMMIT")
say "Versione $ID ($DESC) → $TARGET:~/$DIR"

if "${SSH[@]}" "test -f ~/$DIR/releases/$ID/package.json"; then
  echo "La versione $ID è già sul server: non la copio di nuovo"
else
  # the archive contains only committed files: never .env, data/ or node_modules
  git archive --format=tar "$COMMIT" | gzip -1 | "${SSH[@]}" "mkdir -p ~/$DIR/releases/$ID.tmp && tar -xz -C ~/$DIR/releases/$ID.tmp && rm -rf ~/$DIR/releases/$ID && mv ~/$DIR/releases/$ID.tmp ~/$DIR/releases/$ID && echo $COMMIT > ~/$DIR/releases/$ID/REVISION"
  echo "Copiata ($(git archive --format=tar "$COMMIT" | gzip -1 | wc -c | awk '{printf "%.1f MB", $1/1048576}'))"
fi

# --------------------------------------------------------------------------- on the server
"${SSH[@]}" "bash ~/$DIR/releases/$ID/scripts/deploy-remote.sh $MODE --dir $DIR --id $ID --keep $KEEP $(printf '%q ' "${INSTALL_ARGS[@]}")"
