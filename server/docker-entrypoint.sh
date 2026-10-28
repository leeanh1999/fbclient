#!/bin/sh
set -e

mkdir -p "${DATA_DIR:-/data}"

# Facebook changes often and old yt-dlp versions break; update on every start.
if [ "${YTDLP_AUTO_UPDATE}" = "1" ]; then
  echo "Updating yt-dlp..."
  pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp \
    || echo "Could not update yt-dlp (network?), using the bundled version."
fi

echo "fbclient ${BUILD_VERSION:-dev}"
echo "yt-dlp $(yt-dlp --version 2>/dev/null || echo 'missing')"

exec node server.js
