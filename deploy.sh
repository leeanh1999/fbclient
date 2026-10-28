#!/usr/bin/env bash
# Update fbclient on a Synology NAS: pull the new image, restart the
# container, wait until it is healthy, then remove the old image.
# Put this file next to compose.yaml / docker-compose.yml on the NAS.
#
#   sudo ./deploy.sh
#
# Environment variables (all optional):
#   PROJECT  project name in Container Manager      (default: fbclient)
#   PORT     external port in the compose file      (default: 5080)
#   DIR      folder containing the compose file     (default: this script's folder)
#   FILE     compose file name (default: compose.yaml, docker-compose.yml, ...)
#   FORCE    =1 runs 'up -d' even if the image did not change
#   APP_DIR  folder to copy the latest FbClient.jad/.jar release into
#            (default: /share-folder/symbian; "APP_DIR=" skips this step)
set -euo pipefail

# DSM's Task Scheduler runs with a short PATH; docker lives in /usr/local/bin.
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:$PATH"

IMAGE=ghcr.io/leeanh1999/fbclient
CONTAINER=fbclient
PROJECT="${PROJECT:-fbclient}"
PORT="${PORT:-5080}"
DIR="${DIR:-$(cd "$(dirname "$0")" && pwd)}"
APP_DIR="${APP_DIR-/share-folder/symbian}"
RELEASE_URL=https://github.com/leeanh1999/fbclient/releases/latest/download

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# Docker on Synology only runs as root.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E PROJECT="$PROJECT" PORT="$PORT" DIR="$DIR" FILE="${FILE:-}" APP_DIR="$APP_DIR" FORCE="${FORCE:-}" "$0" "$@"
fi

# DSM 7.2 (Container Manager) has 'docker compose'; older ones 'docker-compose'.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "docker compose not found. Install Container Manager from Package Center."
fi

cd "$DIR"
FILE="${FILE:-}"
if [ -z "$FILE" ]; then
  for name in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    if [ -f "$name" ]; then FILE="$name"; break; fi
  done
fi
[ -n "$FILE" ] && [ -f "$FILE" ] || die "No compose.yaml / docker-compose.yml in $DIR"
echo "Compose file: $DIR/$FILE"
COMPOSE+=(-f "$FILE" -p "$PROJECT")

# The image is built for amd64 and arm64 only.
case "$(uname -m)" in
  x86_64|aarch64|arm64) ;;
  *) die "NAS architecture $(uname -m): the image only exists for amd64 and arm64." ;;
esac

OLD=$(docker image inspect -f '{{.Id}}' "$IMAGE:latest" 2>/dev/null || true)

say "Pulling $IMAGE:latest"
"${COMPOSE[@]}" pull

NEW=$(docker image inspect -f '{{.Id}}' "$IMAGE:latest")
RUNNING=$(docker inspect -f '{{if .State.Running}}{{.Image}}{{end}}' "$CONTAINER" 2>/dev/null || true)
if [ "$RUNNING" = "$NEW" ] && [ "${FORCE:-}" != "1" ]; then
  echo "Image unchanged and already running - not restarting (FORCE=1 to force)."
else
  [ "$OLD" = "$NEW" ] && echo "Image unchanged, but the container is not running it yet."
  say "Restarting container (data in ./data is kept)"
  "${COMPOSE[@]}" up -d
fi

say "Waiting for the container to become healthy"
status=""
for _ in $(seq 1 90); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo "?")
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && break
  sleep 2
done
echo "Status: $status"
if [ "$status" != "healthy" ]; then
  docker logs --tail 40 "$CONTAINER" || true
  die "Container is not healthy. The old image is kept so you can roll back."
fi

if curl -fsS "http://127.0.0.1:$PORT/ping" 2>/dev/null | grep -q '^ok'; then
  echo "Server answers on port $PORT: OK"
else
  echo "Warning: /ping did not answer on port $PORT (check PORT)."
fi

say "Removing old $IMAGE images"
OLD_IDS=$(docker images "$IMAGE" --filter dangling=true -q)
if [ -n "$OLD_IDS" ]; then
  echo "$OLD_IDS" | xargs docker rmi 2>/dev/null || true
else
  echo "No old images."
fi

# J2ME app: fetch FbClient.jad/.jar of the latest GitHub release. Download to
# temp files first so a broken connection never leaves a half-written app.
if [ -n "$APP_DIR" ]; then
  say "Copying the latest J2ME app to $APP_DIR"
  if mkdir -p "$APP_DIR" \
    && curl -fsSL -o "$APP_DIR/FbClient.jar.tmp" "$RELEASE_URL/FbClient.jar" \
    && curl -fsSL -o "$APP_DIR/FbClient.jad.tmp" "$RELEASE_URL/FbClient.jad"; then
    mv -f "$APP_DIR/FbClient.jar.tmp" "$APP_DIR/FbClient.jar"
    mv -f "$APP_DIR/FbClient.jad.tmp" "$APP_DIR/FbClient.jad"
    chmod 644 "$APP_DIR/FbClient.jar" "$APP_DIR/FbClient.jad"
    echo "$(grep '^MIDlet-Version' "$APP_DIR/FbClient.jad"), $(wc -c < "$APP_DIR/FbClient.jar") bytes"
  else
    rm -f "$APP_DIR/FbClient.jar.tmp" "$APP_DIR/FbClient.jad.tmp"
    echo "Warning: could not download FbClient.jad/.jar from GitHub - keeping the old ones in $APP_DIR."
  fi
fi

say "Done"
docker ps --filter "name=$CONTAINER" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker images "$IMAGE" --format 'table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}'
