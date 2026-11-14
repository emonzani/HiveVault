#!/usr/bin/env bash
# Local certificate authority and server certificate for HTTPS on a LAN (passkeys need a
# secure origin outside localhost).
#
# Usage: scripts/dev-ca.sh [host-or-ip ...]        (default: localhost 127.0.0.1)
# Output: data/tls/ca.pem (import it once as a trusted root on every client computer),
#         data/tls/cert.pem + key.pem (set TLS_CERT_FILE / TLS_KEY_FILE in .env)
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: do not rewrite "/CN=..." as a path

OUT="data/tls"
mkdir -p "$OUT"
cd "$OUT"

NAMES=("$@")
[ ${#NAMES[@]} -eq 0 ] && NAMES=(localhost 127.0.0.1)
SAN=""
for n in "${NAMES[@]}"; do
  if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then SAN+="IP:$n,"; else SAN+="DNS:$n,"; fi
done
SAN="${SAN%,}"

if [ ! -f ca.pem ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
  openssl req -x509 -new -key ca-key.pem -days 3650 -subj "/CN=HiveVault local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem
  chmod 600 ca-key.pem
  echo "CA creata: $OUT/ca.pem"
fi

openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl req -new -key key.pem -subj "/CN=${NAMES[0]}" -out server.csr
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$SAN" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 825 -extfile server.ext -out cert.pem
rm -f server.csr server.ext
chmod 600 key.pem
echo "Certificato server per: $SAN"
echo "Nel file .env:  TLS_CERT_FILE=$OUT/cert.pem  TLS_KEY_FILE=$OUT/key.pem  PUBLIC_URL=https://${NAMES[0]}:3700"
