# Runs on Synology NAS (x86_64) as well as ARM64 boxes.
FROM node:22-bookworm-slim

ARG TARGETARCH
# Set by CI so the log says which build is running.
ARG BUILD_VERSION=dev

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

# Copy manifests first so Docker reuses the install layers when only code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# - python3 + yt-dlp: downloads videos for native playback on the phone.
# - fonts-noto-core: Vietnamese text renders correctly in Chromium.
# - tini: reaps Chromium child processes and forwards stop signals.
# - Playwright Chromium (+ its system libraries) for amd64/arm64. Google Chrome,
#   which has the H.264 codec Facebook videos need for Live view, only exists
#   for amd64; on ARM the server falls back to Chromium automatically.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates fonts-noto-core \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && npx playwright install --with-deps chromium \
 && if [ "$TARGETARCH" = "amd64" ]; then npx playwright install --with-deps chrome; fi \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY server.js docker-entrypoint.sh ./

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/app/docker-entrypoint.sh"]
