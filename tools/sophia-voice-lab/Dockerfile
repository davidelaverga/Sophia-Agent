FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build

USER root
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
WORKDIR /app/tools/sophia-voice-lab

COPY tools/sophia-voice-lab/package.json tools/sophia-voice-lab/pnpm-lock.yaml tools/sophia-voice-lab/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tools/sophia-voice-lab/ ./
RUN pnpm build && pnpm prune --prod

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
USER root
RUN corepack enable \
    && corepack prepare pnpm@10.26.2 --activate

WORKDIR /app/tools/sophia-voice-lab
COPY --from=build --chown=node:node /app/tools/sophia-voice-lab/package.json /app/tools/sophia-voice-lab/pnpm-lock.yaml /app/tools/sophia-voice-lab/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/tools/sophia-voice-lab/node_modules ./node_modules
COPY --from=build --chown=node:node /app/tools/sophia-voice-lab/dist ./dist
COPY --from=build --chown=node:node /app/tools/sophia-voice-lab/fixtures ./fixtures
COPY --chown=node:node backend/migrations/2026_08_23_sophia_voice_lab.sql /app/backend/migrations/2026_08_23_sophia_voice_lab.sql

# Install the Chromium revision pinned by package.json together with its Debian
# dependencies. The base image is deliberately Node 22; Playwright's convenience
# image does not itself promise this package's exact Node major.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng=1.51+dfsg-10+deb12u2 dumb-init=1.2.5-2 \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R node:node /ms-playwright /app

ENV NODE_ENV=production \
    SOPHIA_VOICE_LAB_ESPEAK_VERSION=1.51 \
    SOPHIA_VOICE_LAB_MIGRATION_PATH=/app/backend/migrations/2026_08_23_sophia_voice_lab.sql \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER node
EXPOSE 8787
# The same immutable image runs the HTTP service and the non-HTTP evaluator
# worker. Render owns the web readiness probe through healthCheckPath; baking a
# localhost probe into this shared image would make every worker container
# report unhealthy even while its evaluation loop is live.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/bin/migrate.js && node dist/bin/web.js"]
