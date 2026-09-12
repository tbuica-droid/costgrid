# CostGrid gateway + control plane.
#
# Multi-stage so the runtime image carries no compiler, no test framework and
# no source — a smaller surface for something that holds customers' provider
# credentials.

FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native addon; these are build-only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json    packages/core/
COPY packages/db/package.json      packages/db/
COPY packages/gateway/package.json packages/gateway/
COPY packages/cli/package.json     packages/cli/
RUN npm ci

COPY packages ./packages
RUN npm run build && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    COSTGRID_HOST=0.0.0.0 \
    COSTGRID_PORT=8787 \
    COSTGRID_DB=/data/costgrid.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json

# The database lives on a volume; losing it loses the billing record.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Never run as root: this process decrypts customer credentials.
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COSTGRID_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/gateway/dist/main.js"]
