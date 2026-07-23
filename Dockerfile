FROM node:20-alpine AS base

# Build Tesla's vehicle-command HTTP proxy from source. Required for any
# Fleet API endpoint that demands a signed request (fleet_telemetry_config,
# vehicle commands on modern firmware, etc.).
FROM golang:1.23-alpine AS proxy-builder
RUN apk add --no-cache git
WORKDIR /build
RUN git clone --depth 1 https://github.com/teslamotors/vehicle-command.git .
RUN cd cmd/tesla-http-proxy && CGO_ENABLED=0 go build -o /out/tesla-http-proxy

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# /api/version falls back to comparing this against the latest main commit
# date when BUILD_SHA wasn't passed (e.g. a plain `docker-compose build`
# without a script setting it).
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > .build-time

# Produce a slim node_modules with only the deps the telemetry server needs.
# Next.js's standalone output bundles everything Next-side itself, but our
# telemetry sidecar imports ws + protobufjs which standalone doesn't include.
FROM base AS telemetry-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl curl jq ffmpeg
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Bake the git commit SHA into the image so /api/version can compare it
# against GitHub main to flag the dashboard as out-of-date.
# Pass via: BUILD_SHA=$(git rev-parse --short HEAD) docker-compose build
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA

# Next.js standalone bundle (includes its own node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.build-time ./

# Telemetry sidecar files + their deps under server/node_modules so they
# don't conflict with Next.js's bundled modules.
COPY --from=builder --chown=nextjs:nodejs /app/server ./server
COPY --from=builder --chown=nextjs:nodejs /app/protos ./protos
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=telemetry-deps --chown=nextjs:nodejs /app/node_modules ./server/node_modules

# Tesla vehicle-command HTTP proxy binary
COPY --from=proxy-builder /out/tesla-http-proxy /usr/local/bin/tesla-http-proxy

USER nextjs
EXPOSE 3000 50051
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV TELEMETRY_PORT=50051
ENV PROXY_PORT=4443
CMD ["node", "server/start.js"]
