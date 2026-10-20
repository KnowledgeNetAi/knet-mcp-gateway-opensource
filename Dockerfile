# mcp-gateway: Next.js standalone image. Runs on any container platform.
#
# Multi-stage so the runtime image carries the traced standalone output rather
# than the full node_modules tree. No build args: the app has no NEXT_PUBLIC_*
# variables, and its Supabase settings are read at request time, so the build
# needs no credentials and the image carries none.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Run unprivileged; the node image ships a `node` user for this.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

# `orgs/` is the git-reviewed config plane — api.json + roles.json per org/app.
# Read off disk at runtime (readdirSync at `process.cwd()/orgs`), not via a static
# import. Next 16.3.5 does trace it into .next/standalone (measured, not assumed),
# so this COPY is redundant *today* and deliberately kept anyway: if a future Next
# release stops tracing a dynamic read, nothing here fails loudly. The build still
# succeeds, the catalog loads empty, and every tools/list returns zero tools — which
# reads as a policy bug and gets debugged in the wrong file. There is no public/ dir.
COPY --from=build --chown=node:node /app/orgs ./orgs
# `plugins/` holds the Claude plugins members download from the home page
# (lib/plugins/catalog.ts, zipped per request). Read off disk like `orgs/`, and
# copied for the same reason: a missing directory fails silently, as an org
# whose plugin card just never appears.
COPY --from=build --chown=node:node /app/plugins ./plugins

USER node
EXPOSE 8080

# `next start` does not serve standalone output — the traced server is the entrypoint.
CMD ["node", "server.js"]
