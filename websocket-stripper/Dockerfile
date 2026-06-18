# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
FROM node:20-alpine

WORKDIR /app

# Install production deps first (cached layer).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App code.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs ./

# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
