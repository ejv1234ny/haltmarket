FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/deposit-watcher/package.json apps/deposit-watcher/
# Workspace packages this service depends on (none yet, but prepare the tree)
RUN pnpm install --frozen-lockfile --filter @haltmarket/deposit-watcher...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/deposit-watcher/tsconfig.json apps/deposit-watcher/
COPY apps/deposit-watcher/src apps/deposit-watcher/src
RUN pnpm --filter @haltmarket/deposit-watcher build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8082 8083
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8082/healthz || exit 1
WORKDIR /app/apps/deposit-watcher
CMD ["node", "dist/index.js"]
