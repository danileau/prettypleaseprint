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
# /uploads is created and handed to the app's uid here, before the app
# starts. The runner serves as uid 1001 and Docker creates a missing
# bind-mount source as root, so a fresh deployment would otherwise come up
# with a store it cannot write to and fail on the first upload. The
# migrator already exists to prepare state at boot, and it runs as root,
# so it is the one place that can. Non-recursive: files the app and the
# storage migration write already belong to 1001, and a recursive chown
# over every model on every boot is work for nothing.
CMD ["sh", "-c", "mkdir -p /uploads && chown 1001:1001 /uploads && ./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/tsx prisma/seed.ts"]

# ---------------------------------------------------------------------------
# One-shot: copy the models out of MinIO onto the filesystem.
#
# Published like the other two, and that is the whole point of it existing as a
# stage rather than a `build:` in the migration overlay. A deployment holds four
# files — docker-compose.prod.yml, an overlay, .env.docker and deploy-wizard.sh
# — and no source tree at all, which docker-compose.prod.yml is built around:
# it consumes images so the host needs no toolchain. An overlay with
# `build: { context: . }` cannot run there, and the first version of this
# migration had exactly that, which made it unusable on the only machine that
# needs it.
#
# Deleted along with the rest of the migration tooling once nobody plausibly has
# a MinIO data directory left.
FROM node:22-alpine AS storage-migrator
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

# Four packages, generated the same way the migrator's three are, and for the
# same reason its comment gives: installing the app's manifest would drag in
# Next, sharp, esbuild and puppeteer-core to copy some files between two
# directories, and put all of them into the published-image Trivy scan.
#
# Measured, because the first guess at these numbers was wrong twice. The full
# tree gave 914 MB; four packages gave 824 MB; dropping the Prisma CLI after
# generate (below) gives 769 MB, which is under the existing migrator's 790 MB.
# Prisma dominates whatever is left. Versions come from the real manifest so
# nothing can drift, and `overrides` come across for the reason the migrator
# documents.
COPY package.json /tmp/package.json
RUN node -e "\
      const p = require('/tmp/package.json'); \
      require('fs').writeFileSync('package.json', JSON.stringify({ \
        name: 'ppp-storage-migrate', private: true, type: 'module', \
        dependencies: { \
          prisma: p.devDependencies.prisma, \
          '@prisma/client': p.dependencies['@prisma/client'], \
          tsx: p.devDependencies.tsx, \
          '@aws-sdk/client-s3': p.devDependencies['@aws-sdk/client-s3'], \
        }, \
        overrides: p.overrides ?? {}, \
      }, null, 2)); \
    " \
 && npm install --ignore-scripts --no-audit --no-fund

COPY prisma ./prisma
# The CLI is a build-time dependency here, unlike in the migrator, which runs
# `prisma migrate deploy` at boot and has to keep it. This only needs the
# generated client, so the CLI and the migration engines come straight back out.
RUN ./node_modules/.bin/prisma generate \
 && rm -rf node_modules/prisma node_modules/@prisma/engines \
           node_modules/@prisma/engines-version

# Only what the script reaches for. src/lib/db.ts imports @prisma/client and
# nothing else, and storage-layout.ts is two constants — so no Next, no sharp,
# and no application source rides along.
COPY scripts/_env.ts scripts/export-storage.ts ./scripts/
COPY src/lib/db.ts src/lib/storage-layout.ts ./src/lib/

# Same reasoning as the other two images: npm is not a runtime dependency here
# and the copy in the base image carries CVEs of its own.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

ENV NODE_ENV=production
CMD ["./node_modules/.bin/tsx", "scripts/export-storage.ts"]


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
