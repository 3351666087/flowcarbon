# Two images from one build: `server` (API, worker, migrations, demo seed) and `web` (Next.js).
#   docker build --target server -t flowcarbon-server .
#   docker build --target web -t flowcarbon-web .

ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

# ---- dependencies (cached on the lockfile and manifests only) ----------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/demo/package.json packages/demo/
COPY packages/jobs/package.json packages/jobs/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/security/package.json packages/security/
COPY packages/sim/package.json packages/sim/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- build -------------------------------------------------------------------------------------------
FROM deps AS build
# where the web server forwards /api/v1 (Next.js fixes rewrites at build time)
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=${API_ORIGIN}
COPY . .
RUN node scripts/build-server.mjs && npm run build -w @flowcarbon/web

# ---- production dependencies of the server bundle ----------------------------------------------------
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /repo
COPY --from=deps /repo/package.json /repo/package-lock.json ./
COPY --from=deps /repo/apps /repo/apps
COPY --from=deps /repo/packages /repo/packages
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --no-audit --no-fund \
    -w @flowcarbon/api -w @flowcarbon/worker -w @flowcarbon/db -w @flowcarbon/jobs \
    -w @flowcarbon/pipeline -w @flowcarbon/security -w @flowcarbon/core -w @flowcarbon/sim -w @flowcarbon/demo \
  && rm -rf node_modules/@flowcarbon

# ---- server image ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
LABEL org.opencontainers.image.source="https://github.com/3351666087/flowcarbon" \
      org.opencontainers.image.description="FlowCarbon API, worker and migrations" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production MIGRATIONS_DIR=/app/drizzle NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=server-deps /repo/node_modules ./node_modules
COPY --from=build /repo/dist/server ./
USER node
EXPOSE 4000 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_URL_PORT||process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# api.mjs (default), worker.mjs, migrate.mjs or seed.mjs
CMD ["node", "api.mjs"]

# ---- web image ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
LABEL org.opencontainers.image.source="https://github.com/3351666087/flowcarbon" \
      org.opencontainers.image.description="FlowCarbon web application" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
