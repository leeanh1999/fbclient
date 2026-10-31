#!/system/bin/sh
# fbclient server on a rooted Android phone (arm64, e.g. Redmi Note 5).
# The phone has no Docker: 'update' pulls the arm64 image that CI publishes
# (ghcr.io/leeanh1999/fbclient) and runs it as a chroot, so the phone runs
# exactly what the NAS runs. A second small server (port 8090) hands out the
# latest FbClient.jad/.jar from the GitHub release for over-the-air installs.
#
# From Termux (pkg install python curl, once), as root:
#   su -c "sh /sdcard/fbclient/fbclient.sh update"
#
# Commands:
#   update [tag]  pull the image (default: latest) + newest J2ME app, restart
#   app           only refresh FbClient.jad/.jar from the GitHub release
#   deploy <src>  copy local server code (<src>/app) into the rootfs, restart
#   start | stop | restart | status | log [n] | shell | rollback
#
# Environment (optional): PORT (5080), FILES_PORT (8090), ROOT (/data/local/fbclient)

ROOT="${ROOT:-/data/local/fbclient}"
CH="$ROOT/rootfs"
PORT="${PORT:-5080}"
FILES_PORT="${FILES_PORT:-8090}"
IMAGE=ghcr.io/leeanh1999/fbclient
RELEASE_URL=https://github.com/leeanh1999/fbclient/releases/latest/download
DATA="$ROOT/data"
WWW="$ROOT/www"
LOG="$DATA/server.log"
FLOG="$DATA/files.log"
TERMUX=/data/data/com.termux/files/usr/bin
export PATH="$TERMUX:/system/bin:/system/xbin:/sbin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd)

say() { echo "==> $*"; }
die() { echo "!! $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root: su -c \"sh $0 $*\""

# Keep this script and its helpers in ROOT, wherever it was started from
# (e.g. /sdcard/fbclient), so the boot script and later runs find them.
install_self() {
  mkdir -p "$ROOT"
  [ "$HERE" = "$ROOT" ] && return
  for f in fbclient.sh pull-image.py files.py; do
    [ -f "$HERE/$f" ] && cp "$HERE/$f" "$ROOT/$f"
  done
}

is_mounted() { grep -q " $1 " /proc/mounts; }

mount_all() {
  [ -x "$CH/bin/sh" ] || die "no rootfs at $CH (run: update)"
  mkdir -p "$DATA" "$WWW" "$CH/proc" "$CH/sys" "$CH/dev" "$CH/data" "$CH/www" "$CH/tmp"
  is_mounted "$CH/proc"    || mount -t proc proc "$CH/proc"
  is_mounted "$CH/sys"     || mount -t sysfs sys "$CH/sys"
  is_mounted "$CH/dev"     || mount -o bind /dev "$CH/dev"
  is_mounted "$CH/dev/pts" || mount -o bind /dev/pts "$CH/dev/pts"
  # Android has no /dev/shm; Chromium needs it.
  mkdir -p "$CH/dev/shm"
  is_mounted "$CH/dev/shm" || mount -t tmpfs -o size=512m,mode=1777 tmpfs "$CH/dev/shm"
  # Logins and video cache live outside the rootfs, so updates keep them.
  is_mounted "$CH/data"    || mount -o bind "$DATA" "$CH/data"
  is_mounted "$CH/www"     || mount -o bind "$WWW" "$CH/www"
  chmod 1777 "$CH/tmp"
  # Docker normally provides these; a symlink here would point into the void.
  rm -f "$CH/etc/resolv.conf"
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$CH/etc/resolv.conf"
  grep -q localhost "$CH/etc/hosts" 2>/dev/null || printf '127.0.0.1 localhost\n::1 localhost\n' > "$CH/etc/hosts"
  [ -f "$ROOT/files.py" ] && cp "$ROOT/files.py" "$CH/fbc-files.py"
}

umount_all() {
  for m in www data dev/shm dev/pts dev sys proc; do
    is_mounted "$1/$m" && umount -l "$1/$m"
  done
}

# Delete a rootfs directory, but never through a mount (a bound /dev!).
safe_rm() {
  [ -d "$1" ] || return 0
  umount_all "$1"
  if cat /proc/[0-9]*/mountinfo 2>/dev/null | grep -q " $1/"; then
    die "$1 still has mounts (reboot, then retry)"
  fi
  rm -rf --one-file-system "$1" 2>/dev/null || rm -rf "$1"
}

# Run a command inside the rootfs with the image's environment.
inch() {
  chroot "$CH" /usr/bin/env -i HOME=/root TERM="${TERM:-xterm}" LANG=C.UTF-8 /bin/sh -c \
    ". /.fbc-env; export PORT=$PORT; cd \"\$FBC_WORKDIR\"; exec \"\$@\"" sh "$@"
}

ping_ok() { curl -fsS -m 3 "http://127.0.0.1:$PORT/ping" 2>/dev/null | grep -q '^ok'; }

# PIDs of every process whose root is the rootfs (server, Chromium, yt-dlp).
chroot_pids() {
  for p in /proc/[0-9]*; do
    [ "$(readlink "$p/root" 2>/dev/null)" = "${1:-$CH}" ] && echo "${p#/proc/}"
  done
}

ip_addr() { ip -4 addr show wlan0 2>/dev/null | grep -oE 'inet [0-9.]+' | cut -d' ' -f2; }

# Logins from the first install (Debian chroot) move to $DATA once.
migrate_legacy() {
  if [ -d "$ROOT/debian/data" ] && [ ! -d "$DATA/profiles" ]; then
    say "Moving data (Facebook logins) from the old Debian chroot"
    mkdir -p "$DATA"
    cp -a "$ROOT/debian/data/." "$DATA/" || die "could not copy old data"
  fi
}

fetch_app() {
  say "Downloading the latest FbClient.jad/.jar from GitHub"
  mkdir -p "$WWW"
  if curl -fsSL -o "$WWW/FbClient.jar.tmp" "$RELEASE_URL/FbClient.jar" \
      && curl -fsSL -o "$WWW/FbClient.jad.tmp" "$RELEASE_URL/FbClient.jad"; then
    mv -f "$WWW/FbClient.jar.tmp" "$WWW/FbClient.jar"
    mv -f "$WWW/FbClient.jad.tmp" "$WWW/FbClient.jad"
    ver=$(grep '^MIDlet-Version' "$WWW/FbClient.jad" | cut -d' ' -f2 | tr -d '\r')
    cat > "$WWW/index.html" <<EOF
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width">
<title>FbClient $ver</title></head><body>
<h3>FbClient $ver</h3>
<p><a href="FbClient.jad">Install (FbClient.jad)</a></p>
<p><a href="FbClient.jar">FbClient.jar</a> ($(wc -c < "$WWW/FbClient.jar") bytes)</p>
<p>Server: http://$(ip_addr):$PORT</p>
</body></html>
EOF
    echo "FbClient $ver -> http://$(ip_addr):$FILES_PORT/"
  else
    rm -f "$WWW/FbClient.jar.tmp" "$WWW/FbClient.jad.tmp"
    echo "Warning: could not download the app from GitHub, keeping the old files."
  fi
}

update() {
  tag="${1:-latest}"
  install_self
  command -v python >/dev/null || die "python missing: in Termux run 'pkg install python' (not as root)"
  cur=""
  [ -f "$CH/.fbc-image" ] && cur=$(cut -d' ' -f2 "$CH/.fbc-image")
  safe_rm "$ROOT/rootfs.new"
  say "Pulling $IMAGE:$tag"
  python "$ROOT/pull-image.py" "$IMAGE:$tag" "$ROOT/rootfs.new" ${cur:+--skip-digest "$cur"}
  rc=$?
  if [ $rc = 3 ]; then
    echo "Image unchanged."
    fetch_app
    ping_ok || start
    return
  fi
  [ $rc = 0 ] || { safe_rm "$ROOT/rootfs.new"; die "image pull failed"; }
  stop
  migrate_legacy
  umount_all "$CH"
  safe_rm "$ROOT/rootfs.old"
  [ -d "$CH" ] && mv "$CH" "$ROOT/rootfs.old"
  mv "$ROOT/rootfs.new" "$CH"
  fetch_app
  install_boot
  start || { echo "New image failed: run 'rollback' to go back."; exit 1; }
  # The first install's Debian chroot is no longer used.
  if [ -d "$ROOT/debian" ]; then
    say "Removing the old Debian chroot"
    ( safe_rm "$ROOT/debian" ) || echo "Could not remove $ROOT/debian yet (reboot, then: rm -rf $ROOT/debian)"
  fi
  say "Updated to $(cut -d' ' -f2 "$CH/.fbc-image")"
}

rollback() {
  [ -d "$ROOT/rootfs.old" ] || die "no previous image"
  stop
  umount_all "$CH"
  mv "$CH" "$ROOT/rootfs.bad" && mv "$ROOT/rootfs.old" "$CH" && mv "$ROOT/rootfs.bad" "$ROOT/rootfs.old"
  start
}

deploy() {
  src="$1"
  [ -f "$src/app/server.js" ] || die "usage: deploy <dir containing app/server.js>"
  install_self
  [ -f "$src/android/fbclient.sh" ] && cp "$src/android/"*.sh "$src/android/"*.py "$ROOT/" 2>/dev/null
  [ -x "$CH/bin/sh" ] || update
  mount_all
  say "Copying local server code into the rootfs"
  same=0
  cmp -s "$src/app/package-lock.json" "$CH/app/package-lock.json" && same=1
  cp -r "$src/app/." "$CH/app/"
  if [ $same = 0 ]; then
    say "package-lock.json changed: npm ci"
    inch sh -c 'npm ci --omit=dev && npm cache clean --force' || die "npm ci failed"
  fi
  restart
}

# Magisk runs service.d scripts at boot.
install_boot() {
  [ -d /data/adb/service.d ] || return
  cat > /data/adb/service.d/fbclient.sh <<EOF
#!/system/bin/sh
until [ "\$(getprop sys.boot_completed)" = 1 ]; do sleep 5; done
sleep 20
PORT=$PORT FILES_PORT=$FILES_PORT ROOT=$ROOT sh $ROOT/fbclient.sh start > $ROOT/boot.log 2>&1
EOF
  chmod 755 /data/adb/service.d/fbclient.sh
}

loop() { # name, command line run inside the rootfs
  setsid sh -c "
    while :; do
      chroot '$CH' /usr/bin/env -i HOME=/root LANG=C.UTF-8 /bin/sh -c '. /.fbc-env; export PORT=$PORT; cd \"\$FBC_WORKDIR\"; $2'
      echo \"$1 exited (\$?), restarting in 5 s\"
      sleep 5
    done" fbclient-loop >> "$3" 2>&1 < /dev/null &
}

start() {
  install_self
  mount_all
  [ -f "$CH/app/server.js" ] || die "no server in $CH (run: update)"
  for f in "$LOG" "$FLOG"; do
    [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 5000000 ] && mv -f "$f" "$f.1"
  done
  # Keep the CPU awake with the screen off.
  echo fbclient > /sys/power/wake_lock 2>/dev/null
  if ping_ok; then
    echo "already running on :$PORT"
  else
    say "Starting server on :$PORT"
    # Restart loop: Chromium on a phone can get killed by low memory.
    loop server "exec sh /app/docker-entrypoint.sh" "$LOG"
  fi
  if ! curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$FILES_PORT/" 2>/dev/null; then
    say "Starting app download server on :$FILES_PORT"
    loop files "exec python3 /fbc-files.py $FILES_PORT /www" "$FLOG"
  fi
  i=0
  while [ $i -lt 45 ]; do
    if ping_ok; then
      echo "OK: server http://$(ip_addr):$PORT  app http://$(ip_addr):$FILES_PORT/"
      return 0
    fi
    sleep 2; i=$((i + 1))
  done
  tail -n 30 "$LOG"
  echo "!! server did not answer /ping" >&2
  return 1
}

stop() {
  # The restart loops run outside the chroot; find them by their $0 marker.
  for p in /proc/[0-9]*; do
    tr '\000' ' ' < "$p/cmdline" 2>/dev/null | grep -q "fbclient-loop" && kill "${p#/proc/}" 2>/dev/null
  done
  for dir in "$CH" "$ROOT/debian"; do
    pids=$(chroot_pids "$dir")
    [ -n "$pids" ] && kill $pids 2>/dev/null && sleep 3
    pids=$(chroot_pids "$dir")
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  echo fbclient > /sys/power/wake_unlock 2>/dev/null
  say "Stopped"
}

restart() { stop; start; }

status() {
  [ -f "$CH/.fbc-image" ] && echo "image: $(cat "$CH/.fbc-image")"
  [ -f "$WWW/FbClient.jad" ] && echo "app: $(grep '^MIDlet-Version' "$WWW/FbClient.jad" | tr -d '\r')"
  if ping_ok; then echo "server: running on http://$(ip_addr):$PORT"; else echo "server: not answering on :$PORT"; fi
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$FILES_PORT/" 2>/dev/null; then
    echo "app download: http://$(ip_addr):$FILES_PORT/"
  else
    echo "app download: not answering on :$FILES_PORT"
  fi
  echo "rootfs processes: $(chroot_pids | wc -l)"
}

cmd="$1"; [ $# -gt 0 ] && shift
case "$cmd" in
  update) update "$@" ;;
  app) install_self; fetch_app ;;
  deploy) deploy "$@" ;;
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  rollback) rollback ;;
  status) status ;;
  log) tail -n "${1:-100}" "$LOG" ;;
  shell) mount_all; inch /bin/bash ;;
  *) sed -n '2,18p' "$0"; exit 1 ;;
esac
