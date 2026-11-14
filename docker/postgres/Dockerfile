# PostgreSQL 17 + pgvector + pgBackRest (plan §8.3, phase 8): continuous WAL archiving and
# full/differential backups into an encrypted repository (volume /var/lib/pgbackrest).
FROM pgvector/pgvector:pg17

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
# The archive command runs before the stanza exists on a new volume: the init script creates it.
COPY 10-pgbackrest.sh /docker-entrypoint-initdb.d/10-pgbackrest.sh
