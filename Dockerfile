FROM node:24-alpine

# git and openssh-client are the point of the image. git-lfs is small and
# `--mirror` does not carry LFS blobs without it. tini reaps the git children so
# a killed clone cannot leave a zombie behind.
RUN apk add --no-cache git git-lfs openssh-client ca-certificates tini tzdata \
    && git lfs install --system

ENV NODE_ENV=production \
    CONFIG_PATH=/config/config.yml \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/

# The `node` user (uid 1000) already exists in the base image. data_dir must be
# writable by it; mount SSH keys read-only and owned by the same uid.
RUN mkdir -p /data /config && chown -R node:node /data /app

USER node

VOLUME ["/data"]

EXPOSE 9091

# Unhealthy once the last finished run is older than twice the sync interval.
HEALTHCHECK --interval=5m --timeout=20s --start-period=10m --retries=3 \
  CMD node /app/src/index.js --health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/src/index.js"]
CMD []
