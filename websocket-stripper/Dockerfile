# Multi-arch Node base; the Supervisor builds the right arch from config.yaml.
#
# Declared as BUILD_FROM because that is the arg the Supervisor's builder passes in, so a
# build.yaml can substitute a per-arch base later without touching this file. The default
# keeps `docker build` and docker-compose working unchanged for Container/Core users.
#
# Node 24 is the current LTS line; Node 20 went end-of-life on 2026-03-24 and stopped
# receiving security patches. Alpine stays: nothing here compiles (both deps are pure
# JavaScript, no native bindings), so a larger base would buy nothing.
ARG BUILD_FROM=node:24-alpine
FROM ${BUILD_FROM}

WORKDIR /app

# Install production deps first (cached layer).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App code.
COPY ha_ws_trim_proxy.mjs lovelace_extract.mjs ./

# Supervisor provides SUPERVISOR_TOKEN and mounts user config at /data/options.json.
CMD ["node", "ha_ws_trim_proxy.mjs"]
