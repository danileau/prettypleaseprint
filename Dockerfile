# syntax=docker/dockerfile:1
#
# Pretty Please Print
#
# Three images out of one file:
#   builder   — full toolchain, produces the Next standalone bundle
#   migrator  — keeps the toolchain; runs `prisma migrate deploy` and the seed
#   runner    — slim runtime, the only one that serves traffic
#
# The migrator exists so the runtime does not have to carry the Prisma CLI and
# devDependencies just to apply a migration at boot.

# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Prisma's query engine is a native binary: it needs OpenSSL, and glibc shims
# on Alpine.
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate

# `next build` imports modules that read DATABASE_URL at module scope. Nothing
# connects during the build; this only has to parse.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
# Never used to sign anything: the auth module is imported during the build to
# collect route data, and Better Auth wants a secret present when it is. The
# real one arrives as runtime environment, and server code reads process.env at
# request time rather than having it inlined.
ENV BETTER_AUTH_SECRET="build-time-placeholder-never-signs-anything"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# Runs once per deploy, before the app starts.
#
# Built from scratch rather than FROM builder: it needs the Prisma CLI and the
# seed, not the compiled app or the test toolchain. Inheriting the build stage
# would ship well over a gigabyte to apply one migration.
FROM node:22-alpine AS migrator
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

# Exactly three packages, not the whole dependency tree: the seed imports
# @prisma/client and nothing else, and installing the app's manifest here
# would drag in Next and sharp just to apply a migration.
#
# A generated manifest rather than `npm install <pkg>` in a bare directory,
# because the root package.json's `overrides` have to come across. Without
# them the Prisma CLI pulls a vulnerable deepmerge-ts through @prisma/config
# — which is a HIGH that only shows up when you scan the published image.
# Versions are read from the real manifest so nothing can drift.
COPY package.json /tmp/package.json
RUN node -e "\
      const p = require('/tmp/package.json'); \
      require('fs').writeFileSync('package.json', JSON.stringify({ \
        name: 'ppp-migrate', private: true, \
        dependencies: { \
          prisma: p.devDependencies.prisma, \
          '@prisma/client': p.dependencies['@prisma/client'], \
          tsx: p.devDependencies.tsx, \
        }, \
        overrides: p.overrides ?? {}, \
      }, null, 2)); \
    " \
 && npm install --ignore-scripts --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

# npm is not a runtime dependency here either, and the copy bundled in the
# node base image carries CVEs of its own (sigstore 3.1.0, CVE-2026-48815 —
# found by scanning the published image, which no filesystem scan of this
# repo could ever have seen). The CMD below calls node_modules/.bin directly:
# those entries are scripts with a node shebang and need no npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
# `migrate deploy` applies pending migrations and never generates or resets —
# it is the one migrate subcommand safe to run unattended against real data.
# The seed is an upsert of the single admin, so re-running it is a no-op that
# also keeps ADMIN_NAME in step with the environment.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx prisma/seed.ts"]

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# The standalone bundle carries its own minimal node_modules; static assets and
# public/ are not traced into it and have to come across separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma's generated client and its native engine. `serverExternalPackages`
# keeps @prisma/client out of the bundle, so it is copied in whole.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Nothing in the runtime shells out to npm — the CMD is `node server.js` — so
# it is 17 MB of attack surface for no benefit. Removing it also drops the
# vulnerable sigstore that ships inside npm's own bundled dependencies.
# ci.yml pins this: "images ship no npm".
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER nextjs
EXPOSE 3000

# Compose also declares a healthcheck; this one makes the image self-describing
# for anything that runs it without compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
