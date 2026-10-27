#!/bin/bash
# Install script of the overtone-db egg.
#
# Nothing to download: the official postgres image initialises PGDATA on its
# first start, as the panel's user, with POSTGRES_USER, POSTGRES_PASSWORD and
# POSTGRES_DB. This checks that a reinstall will not hide an existing cluster
# behind a new password (the image reads those variables when PGDATA is empty
# and never again), and writes who may connect.
#
# pg_hba.overtone.conf, next to pgdata: the image's own pg_hba.conf lets any
# address try the superuser's password, and every container on the node can
# reach this port. Ours lets the superuser in only through the container's own
# socket (in /tmp, where nothing else reaches), each environment's role only to
# its own database with its password, and refuses everything else. Wings points
# postgresql.conf at it and rewrites its lines before every start
# (deploy/eggs/egg.py), so an edit does not survive a restart; this script is
# what creates it, so a server made before it needs one reinstall.
set -euo pipefail

mkdir -p /mnt/server
if [ -f /mnt/server/pgdata/PG_VERSION ]; then
    echo "[overtone-db] /home/container/pgdata already holds a PostgreSQL $(cat /mnt/server/pgdata/PG_VERSION) cluster; kept as it is."
    echo "[overtone-db] POSTGRES_PASSWORD and POSTGRES_DB are not applied to it again."
else
    echo "[overtone-db] empty; the first start creates the cluster in /home/container/pgdata."
fi

superuser=${POSTGRES_USER:-postgres}
hba=/mnt/server/pg_hba.overtone.conf
{
    echo "# Who may connect to overtone-db. Written by the egg's install (deploy/eggs/install-db.sh);"
    echo "# Wings rewrites these lines before every start (deploy/eggs/egg.py). See docs/deploy.md, section 4."
    echo "local all all trust"
    for pair in "overtone:${DB_ROLE:-}" "overtone_experimental:${DB_ROLE_STAGING:-}"; do
        database=${pair%%:*}
        role=${pair#*:}
        if [ -z "$role" ]; then
            echo "[overtone-db] no role set for $database: nothing may connect to it over the network." >&2
        elif [ "$role" = "$superuser" ]; then
            echo "[overtone-db] ERROR: the role for $database is the superuser; give each environment its own role." >&2
            exit 1
        else
            echo "host $database $role all scram-sha-256"
        fi
    done
    echo "host all all all reject"
} >"$hba.new"
chmod 600 "$hba.new"
mv "$hba.new" "$hba"
echo "[overtone-db] wrote pg_hba.overtone.conf: the superuser by socket only, each role to its own database."
