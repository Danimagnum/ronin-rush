# Production images for Ronin Rush, built from the monorepo root:
#   docker buildx build --platform linux/amd64 --target api   -t ronin-rush-api:<tag> .
#   docker buildx build --platform linux/amd64 --target web   -t ronin-rush-web:<tag> .
#   docker buildx build --platform linux/amd64 --target proxy -t ronin-rush-proxy:<tag> .

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# Dependencies only: cached until a manifest or the lockfile changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile --filter '!@ronin/e2e'

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
# Inlined into the browser bundle at build time. Empty = same origin (nginx serves /api and /socket.io).
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
RUN pnpm --filter @ronin/shared build \
 && pnpm --filter @ronin/api build \
 && pnpm --filter @ronin/web build \
 && pnpm --filter @ronin/api deploy --prod /out/api

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# Same-origin entry point: web app, REST API and Socket.IO behind one port.
FROM nginx:1.27-alpine AS proxy
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=api:3001 WEB_UPSTREAM=web:3000 \
    FRAME_ANCESTORS="https://danielgil.eu https://www.danielgil.eu"
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/nginx-health >/dev/null || exit 1
