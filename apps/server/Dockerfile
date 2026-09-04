# Multi-stage build for the API server.
#
# The repo is an npm workspace, so the build stage needs the root manifest and
# every workspace manifest before installing - that way a change to source code
# does not invalidate the cached dependency layer.

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first: this layer is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/

# The desktop workspace pulls Electron, which is a large download and is not
# needed to build or run the server.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @chitchak/server --workspace @chitchak/protocol --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server

RUN npm run build --workspace @chitchak/protocol \
 && npm run build --workspace @chitchak/server

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev --workspace @chitchak/server --workspace @chitchak/protocol --include-workspace-root

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /repo

# Run as a non-root user: a container that is only ever going to serve HTTP has
# no business being able to write to its own filesystem as root.
RUN addgroup -S chitchak && adduser -S chitchak -G chitchak

COPY --from=build --chown=chitchak:chitchak /repo/node_modules node_modules
COPY --from=build --chown=chitchak:chitchak /repo/package.json package.json
COPY --from=build --chown=chitchak:chitchak /repo/packages/protocol/dist packages/protocol/dist
COPY --from=build --chown=chitchak:chitchak /repo/packages/protocol/package.json packages/protocol/package.json
COPY --from=build --chown=chitchak:chitchak /repo/apps/server/dist apps/server/dist
COPY --from=build --chown=chitchak:chitchak /repo/apps/server/package.json apps/server/package.json
COPY --from=build --chown=chitchak:chitchak /repo/apps/server/node_modules apps/server/node_modules
# Migrations are SQL files, needed at run time by the migrate command.
COPY --from=build --chown=chitchak:chitchak /repo/apps/server/drizzle apps/server/drizzle

USER chitchak
ENV NODE_ENV=production
EXPOSE 4000

# The container reads configuration from the environment, not from a .env file.
CMD ["node", "apps/server/dist/index.js"]
