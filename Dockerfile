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
    python3 \
    python3-pip \
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
    xdg-utils \
    curl \
    gnupg2 \
    unzip \
    ca-certificates

# Install PostgreSQL 18 client to match Render managed PG 18.3.
# Bookworm apt only ships pg_dump 15 which causes "server version mismatch" in backups.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    apt-get update && apt-get install -y --no-install-recommends postgresql-client-18

# yt-dlp: GitHub binary (pip wheels lag; YouTube n-challenge needs current extractor)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Deno: required by yt-dlp EJS JS challenge solver when using YouTube cookies
ARG DENO_VERSION=2.8.3
RUN curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
      -o /tmp/deno.zip \
    && unzip -o /tmp/deno.zip -d /usr/local/bin \
    && chmod a+rx /usr/local/bin/deno \
    && rm -f /tmp/deno.zip \
    && deno --version

# Python deps for Kick Cloudflare bypass (not yt-dlp)
RUN pip3 install --break-system-packages curl-cffi tls-client 2>/dev/null || \
    pip3 install curl-cffi tls-client

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
    PORT=10000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 10000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
