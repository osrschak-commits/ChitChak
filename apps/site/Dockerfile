# The public site: the landing page, and the web client it hosts at /app.
#
# The web client is not a second application. It is apps/desktop/src - the same
# renderer the Electron app runs - built for a browser instead of for file://.
# See apps/desktop/vite.web.config.ts.

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first, so the dependency layer survives a change to source code.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
COPY apps/site/package.json apps/site/

# The desktop workspace depends on Electron, a ~100 MB binary that a browser
# build has no use for. Only the renderer is being built here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @chitchak/desktop --workspace @chitchak/protocol --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/desktop apps/desktop

# The API and SFU hosts are compiled into the bundle and into its CSP, so they
# have to be known here. Written rather than copied: .env.production is
# deliberately not in the repo, and on the server it does not exist at all - the
# domain does, in .env.production at the root, which compose passes in.
ARG CHITCHAK_DOMAIN
RUN test -n "$CHITCHAK_DOMAIN" || (echo "CHITCHAK_DOMAIN build argument is required" >&2; exit 1)
RUN printf '%s\n' \
    "VITE_API_BASE=https://api.${CHITCHAK_DOMAIN}" \
    "VITE_CONNECT_SRC=https://api.${CHITCHAK_DOMAIN} wss://api.${CHITCHAK_DOMAIN} https://sfu.${CHITCHAK_DOMAIN} wss://sfu.${CHITCHAK_DOMAIN}" \
    "VITE_IMG_SRC=https://api.${CHITCHAK_DOMAIN}" \
    > apps/desktop/.env.production

RUN npm run build --workspace @chitchak/protocol \
 && npm run build:web --workspace @chitchak/desktop

# ---------------------------------------------------------------------------

FROM caddy:2-alpine AS runtime

COPY apps/site/Caddyfile /etc/caddy/Caddyfile
COPY apps/site/public /srv
COPY --from=build /repo/apps/desktop/dist-web /srv/app

# The same webfonts the desktop app bundles, so the page and the app are set in
# the same type. Copied out of the packages rather than fetched from a font CDN:
# the app already refuses to depend on one, and the site should not quietly
# introduce a third-party request that the page's own CSP would have to allow.
COPY --from=build \
  /repo/node_modules/@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2 \
  /srv/fonts/
COPY --from=build \
  /repo/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2 \
  /repo/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2 \
  /srv/fonts/

EXPOSE 80
