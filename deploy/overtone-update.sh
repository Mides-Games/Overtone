#!/bin/sh
# Bring the server's Overtone up to the stable branch on GitHub.
#
# Run as root by overtone-update.service: on a push (GitHub Actions starts it)
# and every few minutes (its timer). It deploys one branch only (BRANCH),
# fast-forward only: a checkout that has moved on its own is left alone and
# said so. It waits while the server runs a measurement, the gates or the
# suite, so a push never cuts one short. Once the code on disk has moved, the
# service is always restarted, whatever else failed: new files under an old
# process is the one state never to leave behind. Nothing runs on GitHub's side.
#
# The body is one function, read whole before it runs: the merge below
# rewrites this very file, and sh reads a script as it goes.
set -u

main() {
    REPO=${OVERTONE_REPO:-/opt/overtone}
    BRANCH=${OVERTONE_BRANCH:-feature/library-api}
    SERVICE=${OVERTONE_SERVICE:-overtone-api}
    TOKEN_FILE=${OVERTONE_TOKEN_FILE:-/var/lib/overtone/Overtone/api-token}
    API=${OVERTONE_API:-http://127.0.0.1:8765}
    CARGO=${OVERTONE_CARGO:-/root/.cargo/bin/cargo}

    cd "$REPO" || return 1
    # A mode change made by hand (chmod +x) is not a change worth keeping,
    # and counting it as one blocks every fast-forward that touches that file.
    git config core.fileMode false
    git fetch --quiet origin "$BRANCH" || return 1
    old=$(git rev-parse HEAD)
    new=$(git rev-parse "origin/$BRANCH")
    [ "$old" = "$new" ] && return 0

    if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
        echo "overtone-update: $REPO is on $(git rev-parse --abbrev-ref HEAD), not $BRANCH; left alone"
        return 0
    fi

    # A run in progress or waiting: the next tick deploys.
    if [ -r "$TOKEN_FILE" ]; then
        busy=$(curl -fsS --max-time 10 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
                   "$API/api/v1/runs" 2>/dev/null |
               python3 -c 'import json, sys; q = json.load(sys.stdin)["queue"]; print(1 if q["running"] or q["queued"] else 0)' \
               2>/dev/null || echo 0)
        if [ "$busy" = 1 ]; then
            echo "overtone-update: a run is going; $(git rev-parse --short "$new") waits for the next tick"
            return 0
        fi
    fi

    if ! git merge --quiet --ff-only "origin/$BRANCH"; then
        echo "overtone-update: $BRANCH cannot fast-forward to $(git rev-parse --short "$new"); left alone"
        return 1
    fi

    # From here the code on disk is new: every step runs, and the service
    # restarts at the end even when one of them failed.
    failed=0
    # The Beat This! model is a Git LFS file: without this, a pointer.
    if git lfs version >/dev/null 2>&1; then
        git lfs pull >/dev/null || { echo "overtone-update: git lfs pull failed"; failed=1; }
    fi
    if ! git diff --quiet "$old" "$new" -- crates Cargo.toml Cargo.lock; then
        echo "overtone-update: the Rust code changed; rebuilding overtone-cli"
        "$CARGO" build --release --quiet -p overtone-cli ||
            { echo "overtone-update: overtone-cli did not build; the old binary stays"; failed=1; }
    fi
    systemctl restart "$SERVICE" || { echo "overtone-update: $SERVICE did not restart"; return 1; }
    echo "overtone-update: $(git rev-parse --short "$old") -> $(git rev-parse --short "$new")"
    return "$failed"
}

main "$@"
exit $?
