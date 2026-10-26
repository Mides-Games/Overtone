#!/bin/bash
# Install script of the overtone-db egg.
#
# Nothing to download: the official postgres image initialises PGDATA on its
# first start, as the panel's user, with POSTGRES_USER, POSTGRES_PASSWORD and
# POSTGRES_DB. This only checks that a reinstall will not hide an existing
# cluster behind a new password: the image reads those variables when PGDATA
# is empty and never again.
set -euo pipefail

mkdir -p /mnt/server
if [ -f /mnt/server/pgdata/PG_VERSION ]; then
    echo "[overtone-db] /home/container/pgdata already holds a PostgreSQL $(cat /mnt/server/pgdata/PG_VERSION) cluster; kept as it is."
    echo "[overtone-db] POSTGRES_PASSWORD and POSTGRES_DB are not applied to it again."
else
    echo "[overtone-db] empty; the first start creates the cluster in /home/container/pgdata."
fi
