# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
FROM node:20-alpine

WORKDIR /app

# Install production deps first (cached layer). The lockfile is copied and honoured: `npm ci`
# installs exactly what package-lock.json pins and fails if package.json disagrees, where
# `npm install` without the lockfile resolved every dependency fresh on each build — so two
# builds of the same commit could ship different dependency trees.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App code.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs ./

# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
