#!/usr/bin/env bash
# Manage the server on a rooted Android phone from this PC over SSH (Termux sshd).
# Run from the repo root (Git Bash on Windows):
#
#   PHONE=10.15.188.180 SSH_USER=u0_a167 bash android/deploy-phone.sh          # copy scripts + update from GitHub
#   PHONE=... bash android/deploy-phone.sh scripts   # only copy scripts to /sdcard/fbclient
#   PHONE=... bash android/deploy-phone.sh local     # run this working copy's server code
#   PHONE=... bash android/deploy-phone.sh status    # or: log, stop, start, restart, rollback, app
#
# The scripts land in /sdcard/fbclient on the phone, so Termux alone can also run:
#   su -c "sh /sdcard/fbclient/fbclient.sh update"
#
# Environment: PHONE (required), SSH_USER, SSH_PORT (8022), PORT (5080), FILES_PORT (8090)
set -euo pipefail

PHONE="${PHONE:?set PHONE=<phone IP>}"
SSH_PORT="${SSH_PORT:-8022}"
PORT="${PORT:-5080}"
FILES_PORT="${FILES_PORT:-8090}"
TARGET="${SSH_USER:+$SSH_USER@}$PHONE"
ROOT=/data/local/fbclient
SD=/sdcard/fbclient
cd "$(dirname "$0")/.."

ssh_phone() { ssh -p "$SSH_PORT" -o ConnectTimeout=10 "$TARGET" "$@"; }
# Termux expands $HOME before su; Magisk su runs the script as root.
root_run() { ssh_phone "su -c \"PORT=$PORT FILES_PORT=$FILES_PORT sh $1 ${*:2}\""; }

# Upload to Termux's home, then copy to internal storage as root.
upload() {
  echo "==> Copying scripts to $SD on $TARGET"
  tar -C android -cf - fbclient.sh pull-image.py files.py \
    | ssh_phone 'rm -rf "$HOME/fbclient-up" && mkdir -p "$HOME/fbclient-up" && tar -xf - -C "$HOME/fbclient-up"'
  ssh_phone "su -c \"mkdir -p $SD && cp \$HOME/fbclient-up/* $SD/\""
  # pull-image.py needs Termux's python (installed as the Termux user, not root).
  ssh_phone 'command -v python >/dev/null || pkg install -y python'
}

case "${1:-update}" in
  update)
    upload
    root_run "$SD/fbclient.sh" update "${2:-}"
    ;;
  scripts)
    upload
    ;;
  local)
    upload
    echo "==> Uploading local server code"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    mkdir -p "$tmp/app"
    cp server/server.js server/package.json server/package-lock.json server/docker-entrypoint.sh "$tmp/app/"
    cp -r server/fonts "$tmp/app/"
    tar -C "$tmp" -cf - app | ssh_phone 'rm -rf "$HOME/fbclient-src" && mkdir -p "$HOME/fbclient-src" && tar -xf - -C "$HOME/fbclient-src"'
    root_run "$SD/fbclient.sh" deploy "\$HOME/fbclient-src"
    ;;
  *)
    root_run "$ROOT/fbclient.sh" "$@"
    ;;
esac
