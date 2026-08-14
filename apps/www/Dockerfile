# syntax=docker/dockerfile:1
# Image for the marketing site only.
#
# Deliberately separate from the root Dockerfile. apps/www shares no workspace
# package with the app, so rebuilding (and redeploying) the inbox to ship a copy
# change would be absurd — and the app image carries the AWS, BullMQ and
# Anthropic SDKs that a static marketing site has no use for.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- Dependencies ----
# Every workspace manifest has to be present or --frozen-lockfile fails on a
# missing importer, but --filter keeps the install itself to www and its deps.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/enterprise/package.json ./packages/enterprise/
COPY packages/ai/package.json ./packages/ai/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/www/package.json ./apps/www/
RUN pnpm install --frozen-lockfile --filter "@comms/www..."

# ---- Build ----
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/www/node_modules ./apps/www/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/www ./apps/www
# NEXT_PUBLIC_* is inlined at build time, not read at runtime, so the canonical
# URL used for metadata and Open Graph tags has to be present here.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN pnpm --filter @comms/www build

# ---- Runtime ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
# Railway injects PORT; the start script falls back to 3001 for local runs.
EXPOSE 3001
CMD ["pnpm", "--filter", "@comms/www", "start"]
