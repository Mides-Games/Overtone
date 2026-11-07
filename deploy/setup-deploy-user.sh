#!/bin/sh
# One-time, as root: let GitHub Actions start this server's update, and only that.
#
# Run it from a copy root owns and you have read, never from the checkout:
# /opt/overtone belongs to overtone, and root running a file from it is root
# for whoever can write it. Git reads that checkout as overtone too, since
# its config and hooks are overtone's to write (docs/server.md):
#
#   sudo -u overtone -H git -C /opt/overtone show HEAD:deploy/setup-deploy-user.sh > /root/setup-deploy-user.sh
#   less /root/setup-deploy-user.sh
#   sh /root/setup-deploy-user.sh 'ssh-ed25519 AAAA... github-actions-deploy'
#
# Creates overtone-deploy, a user that signs in with that key alone (no
# password, no shell of its own, no forwarding, no terminal) and whose key
# runs one forced command whatever it asks: start overtone-update.service.
# Every other account's sign-in is left exactly as it was. Also installs the
# update timer as the fallback. Safe to run again: it replaces only its own
# line in that user's authorized_keys and keeps the others (the bot's and the
# website's deploy keys, each with its own forced command).
set -eu

KEY=${1:?"usage: $0 'ssh-ed25519 AAAA... comment'"}
case "$KEY" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
    *) echo "That does not look like a public key: $KEY" >&2; exit 2 ;;
esac
# The key's body (its second field): empty is no key, and a body another line
# of authorized_keys already holds would give that key two forced commands.
KEY_BODY=$(printf '%s\n' "$KEY" | awk '{ print $2 }')
if [ -z "$KEY_BODY" ]; then
    echo "That key has no body: $KEY" >&2; exit 2
fi
USER_NAME=overtone-deploy
KEYS="/var/lib/$USER_NAME/.ssh/authorized_keys"
# This script's own line is the one whose forced command starts the update.
OWN='overtone-update.service"'
if [ -f "$KEYS" ] && grep -vF "$OWN" "$KEYS" | grep -qF -- "$KEY_BODY"; then
    echo "That key is already in $KEYS for another command; give this one its own key." >&2
    exit 2
fi

# The update itself, and the timer that runs it when no push does. Written
# from here, not copied from the checkout: what root installs is what this
# reviewed file says. They are deploy/overtone-update.service and .timer,
# byte for byte (tests/test_overtone_bench.py holds the two copies together).
cat > /etc/systemd/system/overtone-update.service <<'UNIT'
[Unit]
Description=Bring Overtone up to its stable branch on GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Never root: see the head of overtone-update.sh.
User=overtone
ExecStart=/bin/sh /opt/overtone/deploy/overtone-update.sh
Nice=15
UNIT
cat > /etc/systemd/system/overtone-update.timer <<'UNIT'
[Unit]
Description=Look for a new Overtone every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=overtone-update.service

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now overtone-update.timer

# The deploy user: no password; its shell exists only to run the forced command.
if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "/var/lib/$USER_NAME" --shell /bin/sh "$USER_NAME"
fi
passwd -l "$USER_NAME" >/dev/null
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/var/lib/$USER_NAME/.ssh"
# Every other line stays as it was; this script's own line is replaced.
# Written beside the file and moved over it, so sshd never reads half a file.
{
    if [ -f "$KEYS" ]; then
        grep -vF "$OWN" "$KEYS" || true
    fi
    printf 'restrict,command="sudo -n /usr/bin/systemctl start --no-block overtone-update.service" %s\n' \
        "$KEY"
} > "$KEYS.new"
chown "$USER_NAME:$USER_NAME" "$KEYS.new"
chmod 600 "$KEYS.new"
mv -f "$KEYS.new" "$KEYS"

# What it may run as root: that one command. The update itself runs as
# overtone (overtone-update.service), whose only root step is restarting the
# service it just updated. Written under a name with a dot in it, which sudo
# ignores, and checked before it takes its real name: a file visudo refuses is
# never installed (a broken sudoers.d file breaks sudo for everyone).
SUDOERS_TMP=$(mktemp /etc/sudoers.d/.overtone-deploy.XXXXXX)
{
    printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block overtone-update.service\n' \
        "$USER_NAME"
    printf 'overtone ALL=(root) NOPASSWD: /usr/bin/systemctl restart overtone-api\n'
} > "$SUDOERS_TMP"
if ! visudo -cf "$SUDOERS_TMP" >/dev/null; then
    rm -f "$SUDOERS_TMP"
    echo "visudo refused the sudoers file; nothing was installed." >&2
    exit 1
fi
chmod 440 "$SUDOERS_TMP"
mv -f "$SUDOERS_TMP" /etc/sudoers.d/overtone-deploy

# Key only for this user; root and everyone else keep what they had.
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/90-overtone-deploy.conf <<EOF
Match User $USER_NAME
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
EOF
if ! grep -qsE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    echo "Note: /etc/ssh/sshd_config does not include sshd_config.d; add the Match block there by hand." >&2
fi
if grep -qsiE '^[[:space:]]*AllowUsers' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; then
    echo "Note: an AllowUsers line exists; add $USER_NAME to it, or GitHub cannot sign in." >&2
fi
# A broken sshd configuration must never be loaded: test it first.
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "Ready: $USER_NAME can start overtone-update.service and nothing else."
systemctl list-timers overtone-update.timer --no-pager | head -3
