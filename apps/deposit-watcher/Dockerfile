# Dockerfile for haltmarket-deposit-watcher (Railway).
#
# Built with SERVICE-DIR context (Railway Root Directory = apps/deposit-watcher).
# The service has no workspace-internal deps (all imports are external npm
# packages), so we install straight from this package.json without needing
# the repo-root pnpm-workspace.yaml / pnpm-lock.yaml. `tsconfig.docker.json`
# inlines the options the main tsconfig.json inherits from `../../tsconfig.
# base.json`, which isn't reachable under the scoped build context.

FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---- deps stage ------------------------------------------------------------
FROM base AS deps
COPY package.json ./
# --ignore-workspace: don't look up to find a pnpm-workspace.yaml (there isn't
#   one in the scoped context, and even if pnpm walks up it'd be past the
#   Docker context boundary).
# --no-frozen-lockfile: we don't ship a per-service lockfile, so pnpm resolves
#   from the caret ranges in package.json. Keep the service's dep list narrow
#   and reviewed.
RUN pnpm install --prod --ignore-workspace --no-frozen-lockfile

# ---- build stage -----------------------------------------------------------
FROM base AS build
COPY package.json ./
RUN pnpm install --ignore-workspace --no-frozen-lockfile
COPY tsconfig.docker.json ./tsconfig.json
COPY src ./src
RUN pnpm build

# ---- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

RUN addgroup --system --gid 1001 watcher \
 && adduser  --system --uid 1001 --ingroup watcher watcher

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/package.json ./package.json

USER watcher
EXPOSE 8082 8083
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8082/healthz || exit 1
CMD ["node", "dist/index.js"]
