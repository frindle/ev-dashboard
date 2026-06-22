FROM node:20-alpine AS base

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
RUN apk add --no-cache openssl curl jq
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Next.js standalone bundle (includes its own node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Telemetry sidecar files + their deps under server/node_modules so they
# don't conflict with Next.js's bundled modules.
COPY --from=builder --chown=nextjs:nodejs /app/server ./server
COPY --from=builder --chown=nextjs:nodejs /app/protos ./protos
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=telemetry-deps --chown=nextjs:nodejs /app/node_modules ./server/node_modules

USER nextjs
EXPOSE 3000 50051
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV TELEMETRY_PORT=50051
CMD ["node", "server/start.js"]
