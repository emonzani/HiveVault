#!/bin/sh
# First start of a new data volume: creates the pgBackRest stanza, so that WAL archiving works
# from the start. An existing volume runs `npm run backup -- stanza` once instead.
set -e
pgbackrest --stanza=brain --pg1-port=5432 --pg1-socket-path=/var/run/postgresql stanza-create || echo "pgbackrest: stanza non creata (lo farà npm run backup -- stanza)"
