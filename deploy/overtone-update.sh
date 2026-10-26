#!/bin/sh
# Bring the server's Overtone up to the stable branch on GitHub.
#
# Run as root by overtone-update.timer every few minutes. It deploys one
# branch only (BRANCH), fast-forward only: a checkout that has moved on its
# own is left alone and said so. It waits while the server runs a measurement,
# the gates or the suite, so a push never cuts one short, and rebuilds
# overtone-cli when the Rust code changed. Nothing runs on GitHub's side.
set -eu

REPO=${OVERTONE_REPO:-/opt/overtone}
BRANCH=${OVERTONE_BRANCH:-feature/library-api}
SERVICE=${OVERTONE_SERVICE:-overtone-api}
TOKEN_FILE=${OVERTONE_TOKEN_FILE:-/var/lib/overtone/Overtone/api-token}
API=${OVERTONE_API:-http://127.0.0.1:8765}
CARGO=${OVERTONE_CARGO:-/root/.cargo/bin/cargo}

cd "$REPO"
git fetch --quiet origin "$BRANCH"
old=$(git rev-parse HEAD)
new=$(git rev-parse "origin/$BRANCH")
[ "$old" = "$new" ] && exit 0

if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
    echo "overtone-update: $REPO is on $(git rev-parse --abbrev-ref HEAD), not $BRANCH; left alone"
    exit 0
fi

# A run in progress or waiting: the next tick deploys.
if [ -r "$TOKEN_FILE" ]; then
    busy=$(curl -fsS --max-time 10 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
               "$API/api/v1/runs" 2>/dev/null |
           python3 -c 'import json, sys; q = json.load(sys.stdin)["queue"]; print(1 if q["running"] or q["queued"] else 0)' \
           2>/dev/null || echo 0)
    if [ "$busy" = 1 ]; then
        echo "overtone-update: a run is going; $(git rev-parse --short "$new") waits for the next tick"
        exit 0
    fi
fi

if ! git merge --quiet --ff-only "origin/$BRANCH"; then
    echo "overtone-update: $BRANCH cannot fast-forward to $(git rev-parse --short "$new"); left alone"
    exit 1
fi

if ! git diff --quiet "$old" "$new" -- crates Cargo.toml Cargo.lock; then
    echo "overtone-update: the Rust code changed; rebuilding overtone-cli"
    "$CARGO" build --release --quiet -p overtone-cli
fi

systemctl restart "$SERVICE"
echo "overtone-update: $(git rev-parse --short "$old") -> $(git rev-parse --short "$new")"
