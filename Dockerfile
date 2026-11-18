FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    YTDLP_PATH=/opt/yt/bin/yt-dlp

ARG YTDLP_VERSION=2026.10.26
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && python3 -m venv /opt/yt \
    && /opt/yt/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.js ./
COPY src ./src
COPY scripts ./scripts
RUN npm run check && npm run doctor
CMD ["node", "index.js"]
