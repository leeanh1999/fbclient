# Built for an ARM64 Synology NAS (CI publishes linux/arm64 only).
FROM node:22-bookworm-slim

# Set by CI so the log says which build is running.
ARG BUILD_VERSION=dev

# CHANNEL empty: use Playwright's Chromium directly. Google Chrome has no
# ARM build, and trying it first on every browser launch only costs time.
# NODE_ENV=production also means no proxy: the NAS reaches Facebook directly.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CHANNEL= \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    BUILD_VERSION=${BUILD_VERSION}

WORKDIR /app

# Copy manifests first so Docker reuses the install layers when only code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# - python3 + yt-dlp: downloads videos for native playback on the phone.
# - fonts-noto-core: Vietnamese text renders correctly in Chromium.
# - tini: reaps Chromium child processes and forwards stop signals.
# - Playwright Chromium and its system libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates fonts-noto-core \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.cache

COPY server.js docker-entrypoint.sh ./

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/app/docker-entrypoint.sh"]
