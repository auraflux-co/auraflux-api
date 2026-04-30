# syntax=docker/dockerfile:1.4
# ── Stage 1: Build native deps ────────────────────────────────────────────────
# canvas (Cairo), sharp, and puppeteer all need system libs that aren't in
# Alpine. Debian slim has them via apt and avoids Alpine's musl libc issues.
# BuildKit cache mounts keep apt and npm caches on the builder between runs —
# cuts build time from 30+ min → ~3 min for code-only changes.
FROM node:22-bookworm-slim AS builder

# Cairo (canvas), libvips (sharp), and build tools
# --mount=type=cache persists /var/cache/apt between builds on the same host
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libvips-dev

WORKDIR /app
COPY package*.json ./
# --mount=type=cache persists ~/.npm tarball cache between builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Runtime-only system libs for canvas, sharp, puppeteer Chromium
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 librsvg2-2 \
    libvips \
    ffmpeg \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils

# Tell puppeteer to use the system Chromium, not download its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy built node_modules from builder, then app source
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Runtime directories — these are bind-mounted in production but must exist
# so the container starts cleanly without a mount
RUN mkdir -p output tmp logs data

# Non-root user — drop privileges after setup
RUN chown -R node:node /app
USER node

EXPOSE 10000

ENV NODE_ENV=production \
    PORT=10000 \
    NEW_RELIC_NO_CONFIG_FILE=true

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 10000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
