#!/bin/bash
# Install script of the overtone-web, overtone-api and overtone-worker eggs.
#
# Runs once, as root, in the panel's throwaway installer container, with the
# server's disk at /mnt/server. It only puts the repository there: the
# dependencies (pnpm, pip) are installed by deploy/eggs/start.sh on the first
# start, inside the runtime image whose Node or Python they are built for.
#
# egg.py replaces @ROLE@ with web, api or worker when it writes the egg.
#
# Variables the eggs declare:
#   GIT_ADDRESS   the repository, https
#   BRANCH        master (production) or experimental (staging)
#   GIT_TOKEN     read-only token while the repository is private; empty when public
#   USER_UPLOAD   1 = do not clone: the files are uploaded by hand
#
# A reinstall over an existing clone switches it to BRANCH and keeps any file
# git does not track; it refuses, and says so, when a tracked file was edited
# on the server.
set -euo pipefail

ROLE=@ROLE@
say() { echo "[overtone-$ROLE] $*"; }

apt-get update -y >/dev/null
apt-get install -y --no-install-recommends git git-lfs ca-certificates >/dev/null

mkdir -p /mnt/server
cd /mnt/server

if [ "${USER_UPLOAD:-0}" = 1 ]; then
    say "USER_UPLOAD=1: nothing cloned. Upload the repository to the server's root."
    exit 0
fi

case "${BRANCH:-}" in
    master | experimental) ;;
    *) say "ERROR: BRANCH is '${BRANCH:-}', not master or experimental."; exit 1 ;;
esac
if [ -z "${GIT_ADDRESS:-}" ]; then
    say "ERROR: GIT_ADDRESS is empty."
    exit 1
fi

# The token travels in a header for each command and is never written to
# .git/config: anyone who opens the server's file manager would read it there.
# The address is printed; the token never is.
AUTH=()
if [ -n "${GIT_TOKEN:-}" ]; then
    AUTH=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)")
fi
# The files belong to the panel's user, and this script runs as root.
git config --global --add safe.directory /mnt/server
# The model is fetched below, by name, and only for the worker.
export GIT_LFS_SKIP_SMUDGE=1

if [ -d .git ]; then
    say "reinstall: switching the existing clone to $BRANCH"
    git remote set-url origin "$GIT_ADDRESS"
    git "${AUTH[@]}" fetch --quiet origin "$BRANCH"
    if ! git diff --quiet HEAD --; then
        say "ERROR: tracked files were edited on the server:"
        git diff --stat HEAD -- | tail -n 20
        say "Delete them in the file manager, or set USER_UPLOAD=1 to keep them, then reinstall."
        exit 1
    fi
    git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
elif [ -n "$(ls -A)" ]; then
    say "ERROR: /home/container has files but no clone. Empty it, or set USER_UPLOAD=1."
    exit 1
else
    say "cloning $GIT_ADDRESS ($BRANCH)"
    git "${AUTH[@]}" clone --quiet --branch "$BRANCH" "$GIT_ADDRESS" .
fi
git branch --quiet --set-upstream-to "origin/$BRANCH" "$BRANCH"
# A mode change (chmod +x in the file manager) is not a change worth keeping,
# and counting it as one blocks every fast-forward that touches that file.
git config core.fileMode false

if [ "$ROLE" = worker ]; then
    # The Beat This! model is a Git LFS file: without this, a 130-byte pointer.
    # git-lfs is one static binary; start.sh finds it in ~/.local/bin when an
    # update brings a new model, since the runtime image has no git-lfs.
    mkdir -p .local/bin
    cp "$(command -v git-lfs)" .local/bin/git-lfs
    git lfs install --local >/dev/null
    git "${AUTH[@]}" lfs pull
    for m in assets/models/*.onnx; do
        if head -c 40 "$m" | grep -q '^version https://git-lfs'; then
            say "ERROR: $m is still an LFS pointer after git lfs pull."
            exit 1
        fi
    done
fi

say "installed $(git rev-parse --short HEAD) on $BRANCH; the first start installs the dependencies"
