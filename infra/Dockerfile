# syntax=docker/dockerfile:1.7
#
# The three application processes, as three targets over one shared build.
#
# `infra/docker-compose.yml` deliberately holds the four BACKING services only,
# and says so: the two application processes "run from the host during
# development so a code change does not need an image rebuild". That is the
# right arrangement for a laptop and the wrong one for a machine that has to
# come back up after a power cut. These targets are the production half.
#
# ## One build stage, three targets
#
# `pnpm run build:apps` builds api, realtime-gateway and web in one invocation
# because they share `packages/*` — splitting them into three independent builds
# would compile `packages/domain` three times from the same sources. The three
# runtime targets below therefore differ only in working directory and command.

FROM node:24.20.0-trixie-slim AS build

# `engines.node` in the root package.json is `>=24.14.1`, and `packageManager`
# pins pnpm to this exact version. Neither number is chosen here.
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run build:packages

# `NEXT_PUBLIC_API_BASE_URL` is inlined into the BROWSER bundle at build time —
# `apps/web/next.config.ts` documents this, and it is the reason the E2E suite
# needs its own `distDir`. Passing it as a runtime environment variable changes
# nothing: the value is already baked into the JavaScript the browser downloads.
# So it has to arrive as a build argument, and rebuilding is the only way to
# point a built image at a different API origin.
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN pnpm run build:apps

# ─────────────────────────────────────────────────────────────────────────────
# Runtime targets.
#
# Each keeps the whole workspace rather than copying `dist` into a slim image,
# and that is a constraint rather than laziness: AGENTS.md forbids
# `node-linker=hoisted`, so `node_modules` is pnpm's symlink tree into a content
# addressed store. A `COPY --from=build /app/apps/api/dist` would land a
# directory whose `@stuwith/*` imports resolve to links with no targets.
#
# The cost is an image around 1.5-2 GB. `pnpm deploy --filter` would cut that,
# and is the first thing to reach for if these ever run somewhere billed by the
# gigabyte.
# ─────────────────────────────────────────────────────────────────────────────

FROM build AS api
WORKDIR /app/apps/api
# `API_PORT` is read by `loadApiConfig()`; EXPOSE documents it for a reader and
# for `docker inspect`, and publishes nothing on its own.
EXPOSE 3001
# `node dist/main.js`, not `pnpm start`: pnpm would sit between the init system
# and the process, and SIGTERM has to reach `main.ts` directly — the shutdown
# hook it enables is what closes the Valkey client whose reconnect strategy
# otherwise keeps the event loop alive past the signal.
CMD ["node", "dist/main.js"]

FROM build AS gateway
WORKDIR /app/apps/realtime-gateway
EXPOSE 3002
CMD ["node", "dist/main.js"]

FROM build AS web
WORKDIR /app/apps/web
EXPOSE 3000
# `next` resolves through this package's own `node_modules/.bin`, which pnpm
# links even though the package itself lives in the root virtual store.
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
