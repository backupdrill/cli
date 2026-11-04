# syntax=docker/dockerfile:1
# Container image for running `backupdrill backup` on a schedule (Unraid, a NAS,
# any Docker host). Built from this repo's source, so the image always matches
# the commit it was built from. No credentials are baked in: every setting comes
# from environment variables at run time.

FROM node:24-alpine3.24 AS build
WORKDIR /app
# pnpm 9 matches lockfileVersion 9.0; pinned so a pnpm release can't change the install
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod && chmod +x dist/index.js

FROM node:24-alpine3.24
# postgresql17-client: pg_dump/pg_restore/psql 17, the same major version the
# GitHub Action installs. Supabase runs PG 15–17, and a dump made by pg_dump 18
# can't be read by a pg_restore 17 someone may restore with later.
# supercronic runs the schedule in the foreground and passes the container's
# environment to the job; tini forwards SIGTERM so `docker stop` is clean.
RUN apk add --no-cache postgresql17-client supercronic tini tzdata
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/backupdrill-entrypoint
RUN ln -s /app/dist/index.js /usr/local/bin/backupdrill \
  && chmod 755 /usr/local/bin/backupdrill-entrypoint

LABEL org.opencontainers.image.source="https://github.com/backupdrill/cli" \
      org.opencontainers.image.description="Back up a Supabase project's Postgres database and Storage files to your own S3/R2/B2 bucket on a schedule." \
      org.opencontainers.image.licenses="MIT"

USER node
ENTRYPOINT ["/sbin/tini", "--", "backupdrill-entrypoint"]
