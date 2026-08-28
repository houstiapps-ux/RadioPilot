# Runtime image for the API and the worker. Both services share one image and
# differ only by the command compose gives them.
FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .

# Typechecks api/worker and produces the web bundle. Catches a broken build here
# rather than in a crash loop on the server.
RUN pnpm --filter @radio-pilot/api build && pnpm --filter @radio-pilot/worker build

USER node
ENV NODE_ENV=production

# Both services still start through tsx: @radio-pilot/shared exports raw
# TypeScript, so the compiled output above is a typecheck artefact, not the
# runtime entrypoint. Baking node_modules into the image means the dev-only
# tsx dependency is always present, which a `--prod` install would not be.
CMD ["pnpm", "--filter", "@radio-pilot/api", "start"]
