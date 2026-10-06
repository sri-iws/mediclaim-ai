# Build from the repository root: docker build -f server/Dockerfile -t mediclaim-api .
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Toolchain for compiling better-sqlite3 when no prebuilt binary matches
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3001 \
    SQLITE_DB_PATH=/data/mediclaim.sqlite

WORKDIR /app/server

RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 python3 python3-venv tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data \
    && python3 -m venv /opt/ai-venv

COPY ai-service/requirements.txt /tmp/ai-requirements.txt
RUN /opt/ai-venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/ai-requirements.txt \
    && rm /tmp/ai-requirements.txt

ENV PYTHON_BIN=/opt/ai-venv/bin/python

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server/package.json server/db.js server/index.js ./
COPY --chown=node:node ai-service/app /app/ai-service/app

USER node

VOLUME ["/data"]
EXPOSE 3001

# Set JWT_SECRET at runtime
CMD ["node", "index.js"]
