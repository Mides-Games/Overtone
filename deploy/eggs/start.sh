#!/bin/bash
# Start one Overtone server inside its panel container: update, prepare, run.
#
#   bash deploy/eggs/start.sh web|api|worker|bot
#
# This is the egg's whole startup line. Restarting the server in the panel is
# the release gesture: with AUTO_UPDATE=1 the checkout fast-forwards to
# origin/$BRANCH first, the logic deploy/overtone-update.sh used on the VPS.
#
#   - One branch only, fast-forward only. A checkout on another branch, with
#     edited tracked files, or with history the remote no longer has is left
#     alone and said so; it starts on the code it already has.
#   - GitHub unreachable is not a reason to stay down: the current code starts.
#   - New code never runs under old dependencies. Each role's dependencies are
#     keyed by a hash of the files they come from; when that changes they are
#     rebuilt, and if the rebuild fails the server refuses to start rather than
#     run a tree that is half one release and half the other.
#   - A run in progress is never cut by an update: the update only happens at
#     start, after the panel has stopped the old process (^C, then up to ten
#     minutes before Wings kills it), so the worker gets to finish or hand back
#     its job first.
#
# ROLLBACK_COMMIT (a commit on BRANCH) pins the checkout there and skips the
# update; clearing it returns to BRANCH on the next start.
#
# The body is one function, read whole before it runs: the fast-forward below
# can rewrite this very file, and bash reads a script as it goes. When it did,
# the new version is executed instead, once.
set -u

main() {
    role=${1:-}
    case "$role" in
        web | api | worker | bot) ;;
        *) echo "usage: bash deploy/eggs/start.sh web|api|worker|bot"; return 2 ;;
    esac

    # OVERTONE_HOME exists for trying this script against a scratch clone.
    export HOME=${OVERTONE_HOME:-/home/container}
    cd "$HOME" || return 1
    export PATH="$HOME/.local/bin:$PATH"
    export GIT_LFS_SKIP_SMUDGE=1
    mkdir -p .overtone

    AUTH=()
    if [ -n "${GIT_TOKEN:-}" ]; then
        AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)")
    fi

    if [ -d .git ] && [ "${USER_UPLOAD:-0}" != 1 ]; then
        before=$(git rev-parse HEAD)
        place || return 1
        after=$(git rev-parse HEAD)
        if [ "$before" != "$after" ] && [ -z "${OVERTONE_START_AGAIN:-}" ] &&
            ! git diff --quiet "$before" "$after" -- deploy/eggs/start.sh; then
            say "start.sh changed with the checkout; running the new one"
            export OVERTONE_START_AGAIN=1
            exec bash deploy/eggs/start.sh "$role"
        fi
    elif [ ! -d .git ] && [ "${USER_UPLOAD:-0}" != 1 ]; then
        say "ERROR: no clone in /home/container. Reinstall the server, or set USER_UPLOAD=1."
        return 1
    fi
    # The token is for git alone, and git is done with it but for the model's
    # LFS pull, which reads AUTH (built above, never exported). Nothing the
    # server runs from here (pnpm, pip, node, python) inherits it.
    unset GIT_TOKEN

    "prepare_$role" || {
        say "ERROR: the dependencies of $(revision) did not install; not starting."
        say "Fix it on $BRANCH and restart, or set ROLLBACK_COMMIT to the last good commit (.overtone/deployed.log)."
        return 1
    }
    "run_$role"
}

say() { echo "[overtone-$role] $*"; }

revision() {
    if [ -d .git ]; then git rev-parse --short HEAD; else echo "the uploaded files"; fi
}

# Put the checkout where the variables say: pinned, or on BRANCH and updated.
place() {
    case "${BRANCH:-}" in
        master | experimental) ;;
        *) say "ERROR: BRANCH is '${BRANCH:-}', not master or experimental."; return 1 ;;
    esac
    if ! git diff --quiet HEAD --; then
        say "tracked files were edited on the server; left alone at $(revision)"
        git diff --stat HEAD -- | tail -n 10
        return 0
    fi

    if [ -n "${ROLLBACK_COMMIT:-}" ]; then
        if ! git merge-base --is-ancestor "$ROLLBACK_COMMIT" "refs/heads/$BRANCH" 2>/dev/null; then
            say "ERROR: ROLLBACK_COMMIT $ROLLBACK_COMMIT is not a commit this server had on $BRANCH."
            return 1
        fi
        pinned=$(git rev-parse HEAD)
        git checkout --quiet --detach "$ROLLBACK_COMMIT" || return 1
        say "pinned to $(revision) by ROLLBACK_COMMIT; no update while it is set"
        [ "$pinned" = "$(git rev-parse HEAD)" ] || log "pin"
        return 0
    fi

    current=$(git rev-parse --abbrev-ref HEAD)
    if [ "$current" = HEAD ]; then
        # Detached by an earlier ROLLBACK_COMMIT that has since been cleared.
        git checkout --quiet "$BRANCH" || return 1
        say "ROLLBACK_COMMIT cleared; back on $BRANCH at $(revision)"
        log "unpin"
    elif [ "$current" != "$BRANCH" ]; then
        say "the checkout is on $current, BRANCH says $BRANCH; left alone. Reinstall to switch."
        return 0
    fi

    [ "${AUTO_UPDATE:-0}" = 1 ] || return 0
    update
}

update() {
    if ! git "${AUTH[@]}" fetch --quiet origin "$BRANCH"; then
        say "could not reach $(git remote get-url origin); starting $(revision) as it is"
        return 0
    fi
    old=$(git rev-parse HEAD)
    new=$(git rev-parse "origin/$BRANCH")
    [ "$old" = "$new" ] && return 0

    if ! git merge-base --is-ancestor "$old" "$new"; then
        # master's history was rewritten (squashed, 2026-10-28): a commit that
        # is now only in an archive tag (refs/tags/history/*) was published,
        # so a clean checkout moves to the new history. A commit made on the
        # server is in no archive and is left alone, as before.
        git "${AUTH[@]}" fetch --quiet origin "+refs/tags/history/*:refs/tags/history/*" 2>/dev/null || true
        if [ -n "$(git tag --list 'history/*' --contains "$old")" ] && git diff --quiet HEAD --; then
            git reset --quiet --hard "$new" || return 0
            say "$BRANCH was rewritten; moved from the archived $(git rev-parse --short "$old") to $(git rev-parse --short "$new")"
            log "rewrite"
            return 0
        fi
        say "$BRANCH cannot fast-forward from $(git rev-parse --short "$old") to $(git rev-parse --short "$new")" \
            "(history rewritten, or commits made on the server); left alone"
        return 0
    fi
    if ! git merge --quiet --ff-only "$new"; then
        say "the fast-forward to $(git rev-parse --short "$new") failed; left alone at $(revision)"
        return 0
    fi
    say "updated $(git rev-parse --short "$old") -> $(git rev-parse --short "$new")"
    log "update"
}

log() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 $(git rev-parse HEAD) $BRANCH" >>.overtone/deployed.log
}

# A hash of what a set of files contains: the key a role's dependencies were
# built from. Content, not commits, so an uploaded tree (USER_UPLOAD=1) is
# keyed the same way as a clone.
key() {
    find "$@" \( -name node_modules -o -name dist -o -name .venv \) -prune -o -type f -print 2>/dev/null |
        LC_ALL=C sort | xargs -r sha1sum | sha1sum | cut -c1-40
}

# Runs "$2..." unless .overtone/$1 already holds the key "$KEY"; records it on success.
once() {
    stamp=.overtone/$1
    shift
    [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$KEY" ] && return 0
    rm -f "$stamp"
    "$@" || return 1
    echo "$KEY" >"$stamp"
}

pnpm() {
    # corepack ships with Node 24 and honours package.json's packageManager.
    # CI=1 makes pnpm non-interactive; it is set for pnpm only, never for the app.
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME="$HOME/.cache/corepack" CI=1 \
        corepack pnpm --config.confirmModulesPurge=false "$@"
}

need_lockfile() {
    [ -f pnpm-lock.yaml ] && return 0
    say "ERROR: no pnpm-lock.yaml at the repository root; a server only installs from a lockfile."
    return 1
}

prepare_web() {
    need_lockfile || return 1
    KEY=$(key package.json pnpm-lock.yaml pnpm-workspace.yaml site/web)
    once web-build build_web
}

build_web() {
    say "installing and building site/web"
    pnpm install --frozen-lockfile --filter ./site/web && pnpm --dir site/web build &&
        [ -f site/web/dist/index.html ]
}

prepare_api() {
    need_lockfile || return 1
    KEY=$(key package.json pnpm-lock.yaml pnpm-workspace.yaml site/api/package.json)
    once api-deps install_api
}

install_api() {
    say "installing site/api's production dependencies"
    pnpm install --frozen-lockfile --prod --filter ./site/api
}

prepare_bot() {
    need_lockfile || return 1
    KEY=$(key package.json pnpm-lock.yaml pnpm-workspace.yaml bot/package.json)
    once bot-deps install_bot
}

install_bot() {
    say "installing bot's production dependencies"
    pnpm install --frozen-lockfile --prod --filter ./bot
}

prepare_worker() {
    # The model first: a pointer where the model should be means the beat vote
    # cannot run, and the worker would analyse differently from the app.
    for m in assets/models/*.onnx; do
        head -c 40 "$m" | grep -q '^version https://git-lfs' || continue
        if [ -d .git ] && command -v git-lfs >/dev/null; then
            say "fetching the Beat This! model (Git LFS)"
            git "${AUTH[@]}" lfs pull || return 1
        fi
        if head -c 40 "$m" | grep -q '^version https://git-lfs'; then
            say "ERROR: $m is an LFS pointer, not the model. Reinstall the server to fetch it."
            return 1
        fi
    done
    KEY=$(key python/requirements.lock)
    once worker-venv install_worker || return 1
    # The drums separator for a live band's hint: without it the worker reads
    # the mix and the result says so, so a failed download only warns.
    python deploy/eggs/stemsplit.py .overtone/stemsplit ||
        say "WARNING: the drums separator is not installed; a live band's hint reads the mix."
}

install_worker() {
    say "installing python/requirements.lock into .venv"
    # Only the engine's pins: the lock's last section is the Windows web shell
    # (pywebview, pythonnet), which a server never imports.
    sed '/^# Web shell only/,$d' python/requirements.lock >.overtone/worker-requirements.txt
    rm -rf .venv
    python -m venv .venv &&
        .venv/bin/python -m pip install --quiet --disable-pip-version-check --no-input \
            -r .overtone/worker-requirements.txt
}

run_web() {
    [ -n "${API_UPSTREAM:-}" ] || { say "ERROR: API_UPSTREAM is empty."; return 1; }
    export PORT=$SERVER_PORT WEB_ROOT=site/web/dist
    exec node deploy/web/serve.mjs
}

run_api() {
    export PORT=$SERVER_PORT HOST=0.0.0.0 NODE_ENV=production
    say "migrating"
    node site/api/src/db/migrate.js || { say "ERROR: the migration failed; not starting."; return 1; }
    exec node site/api/src/index.js
}

run_bot() {
    [ -f bot/src/index.js ] || { say "ERROR: bot/src/index.js is not in $(revision)."; return 1; }
    # The slash commands go with the code: registered at every start when the
    # application id is known. One PUT of the whole list, which Discord takes
    # unchanged as a no-op; a failure is said and does not stop the bot.
    if [ -n "${DISCORD_APP_ID:-}" ] && [ -n "${DISCORD_TOKEN:-}" ]; then
        node bot/scripts/register.mjs || say "WARNING: the slash commands were not registered; starting anyway."
    fi
    # Without its secrets the bot says it is off and exits 0 (bot/src/index.js).
    exec node bot/src/index.js
}

run_worker() {
    [ -f worker/main.py ] || { say "ERROR: worker/main.py is not in $(revision)."; return 1; }
    # Every math library sizes its thread pool from the machine's cores, not
    # from the panel's CPU limit: on a shared node that is dozens of threads
    # fighting over four cores' worth of quota. WORKER_THREADS caps them all.
    if [ -n "${WORKER_THREADS:-}" ]; then
        export OMP_NUM_THREADS=$WORKER_THREADS OPENBLAS_NUM_THREADS=$WORKER_THREADS \
            MKL_NUM_THREADS=$WORKER_THREADS NUMBA_NUM_THREADS=$WORKER_THREADS
    fi
    export NUMBA_CACHE_DIR="$HOME/.cache/numba" PYTHONUNBUFFERED=1
    if [ -x .overtone/stemsplit/stemsplit ] && [ -f .overtone/stemsplit/stemsplit.safetensors ]; then
        export STEMSPLIT_CLI="$PWD/.overtone/stemsplit/stemsplit"             STEMSPLIT_MODEL="$PWD/.overtone/stemsplit/stemsplit.safetensors"
        # the separator's thread pool (rayon), capped like the others
        [ -n "${WORKER_THREADS:-}" ] && export RAYON_NUM_THREADS=$WORKER_THREADS
    fi
    exec .venv/bin/python worker/main.py
}

main "$@"; exit $?
