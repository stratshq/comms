# syntax=docker/dockerfile:1
# Single image for both the `web` and `worker` services. Railway selects the role
# per service via its start command (see apps/web/railway.json & apps/worker/railway.json).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- Dependencies (cached on manifest changes) ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/enterprise/package.json ./packages/enterprise/
COPY packages/ai/package.json ./packages/ai/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
# The marketing site never ships in this image — `pnpm build` does not include it
# (see build:www). Its manifest is here only so the workspace matches the
# lockfile; without it, --frozen-lockfile fails on a missing importer.
COPY apps/www/package.json ./apps/www/
RUN pnpm install --frozen-lockfile

# ---- Build everything (packages, worker, web) ----
FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/enterprise/node_modules ./packages/enterprise/node_modules
COPY --from=deps /app/packages/ai/node_modules ./packages/ai/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY . .
RUN pnpm build

# ---- Runtime ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
# Default to the web service; the worker service overrides this start command.
CMD ["pnpm", "--filter", "@comms/web", "start"]
