# syntax=docker/dockerfile:1

# --- deps: compile better-sqlite3 here so the runtime image stays small ------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for most platforms but falls back to
# building from source, which needs a toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- assets: download and normalize the Kenney CC0 avatar pack ---------------
FROM node:22-bookworm-slim AS assets
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY scripts ./scripts
# A clean checkout has no artwork. If the download fails the app still runs and
# falls back to simple avatars, so this must not break the build.
RUN mkdir -p assets/avatars \
  && (bash scripts/fetch-assets.sh || echo 'WARNING: avatar pack download failed; using fallback avatars')

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/plugdj.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js index.html avatar-lab.html ./
COPY lib ./lib
COPY api ./api
COPY assets ./assets
COPY scripts ./scripts
COPY --from=assets /app/assets/avatars ./assets/avatars

# The SQLite file lives on a volume; node must own the mount point.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
