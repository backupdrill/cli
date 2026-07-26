#!/usr/bin/env bash
# End-to-end reproduction of the drill report published at
# https://backupdrill.com/drill-report
#
# Builds a Supabase-shaped Postgres 17 source (RLS policies on platform roles,
# a partitioned table, a materialized view, extensions in their own schema),
# seeds ~1.5M rows, puts 250 files in an S3-compatible store, then runs a real
# backup and a real restore drill against them.
#
# Requires: Docker, Node >= 20, and pg_dump/pg_restore >= 17.
#
# Safety properties, because this drives a tool that reads databases and writes
# buckets:
#   * credentials are generated per run, never committed, and the containers
#     bind to 127.0.0.1 only;
#   * the CLI is invoked with a scrubbed environment, so a BACKUPDRILL_* or
#     DATABASE_URL already exported in your shell cannot redirect this fixture
#     at a real database or a real bucket;
#   * only container IDs this run actually created are removed, so a concurrent
#     run or an unrelated container is never touched.
set -euo pipefail
cd "$(dirname "$0")"

# pg_dump/pg_restore: PATH by default. PG_BIN only when you point it somewhere.
if [ -n "${PG_BIN:-}" ]; then
  PG_DUMP="${BACKUPDRILL_PG_DUMP:-$PG_BIN/pg_dump}"
  PG_RESTORE="${BACKUPDRILL_PG_RESTORE:-$PG_BIN/pg_restore}"
else
  PG_DUMP="${BACKUPDRILL_PG_DUMP:-pg_dump}"
  PG_RESTORE="${BACKUPDRILL_PG_RESTORE:-pg_restore}"
fi
# 两个都先验,且主版本必须 >= 容器的 PG 17 —— 否则会在灌完 150 万行之后才失败
for bin in "$PG_DUMP" "$PG_RESTORE"; do
  command -v "$bin" >/dev/null 2>&1 || { echo "$bin not found — set PG_BIN or BACKUPDRILL_PG_DUMP/_PG_RESTORE" >&2; exit 1; }
  major="$("$bin" --version | sed -E 's/.* ([0-9]+).*/\1/')"
  [ "${major:-0}" -ge 17 ] 2>/dev/null || { echo "$bin is major $major; needs >= 17 to handle this fixture's PostgreSQL 17 source" >&2; exit 1; }
done

RUN_ID="$$"
SOURCE_CONTAINER="bd-demo-source-$RUN_ID"
S3_CONTAINER="bd-demo-minio-$RUN_ID"
PG_PORT="${PG_PORT:-15432}"
S3_PORT="${S3_PORT:-19000}"

# Per-run credentials. Nothing here is ever written to a tracked file.
PG_PASSWORD="$(openssl rand -hex 16)"
S3_ACCESS_KEY="demo$(openssl rand -hex 6)"
S3_SECRET_KEY="$(openssl rand -hex 24)"

WORKDIR="$(mktemp -d)"
CONFIG="$WORKDIR/backupdrill.config.json"

# 只删本次 docker run 真正返回的 ID —— 按名字盲删会在 pid 复用时误伤别人的容器
CREATED_IDS=()
cleanup() {
  for id in "${CREATED_IDS[@]:-}"; do
    [ -n "$id" ] && docker rm -f "$id" >/dev/null 2>&1 || true
  done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# The CLI runs with only what it needs. env -i drops every inherited
# BACKUPDRILL_*/DATABASE_URL/PG* that could otherwise override the fixture.
run_cli() {
  env -i \
    PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    BACKUPDRILL_PG_DUMP="$PG_DUMP" BACKUPDRILL_PG_RESTORE="$PG_RESTORE" \
    node ../../dist/index.js "$@"
}

wait_for() { # wait_for <label> <seconds> <command...>
  local label="$1" deadline=$(( SECONDS + $2 )); shift 2
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "$label did not become ready in time" >&2; exit 1; }
    sleep 1
  done
}

[ -f ../../dist/index.js ] || { echo "build first: pnpm install && pnpm build" >&2; exit 1; }

echo "==> source Postgres 17"
# 固定 tag:可变 tag 会让同一份代码日后跑在不同软件上。
# 演练沙箱的镜像不在这里 —— 那个由引擎选。
CREATED_IDS+=("$(docker run -d --name "$SOURCE_CONTAINER" -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=appdb -p 127.0.0.1:"$PG_PORT":5432 postgres:17.6-alpine)")
wait_for "Postgres" 90 docker exec "$SOURCE_CONTAINER" pg_isready -U postgres

echo "==> S3-compatible store (destination bucket + Storage source bucket)"
CREATED_IDS+=("$(docker run -d --name "$S3_CONTAINER" -p 127.0.0.1:"$S3_PORT":9000 \
  -e MINIO_ROOT_USER="$S3_ACCESS_KEY" -e MINIO_ROOT_PASSWORD="$S3_SECRET_KEY" \
  minio/minio:RELEASE.2025-04-22T22-12-26Z server /data)")
wait_for "MinIO" 90 curl -fsS "http://127.0.0.1:$S3_PORT/minio/health/live"

sed -e "s|__PG_PASSWORD__|$PG_PASSWORD|" -e "s|__PG_PORT__|$PG_PORT|" \
    -e "s|__S3_PORT__|$S3_PORT|" -e "s|__S3_ACCESS_KEY__|$S3_ACCESS_KEY|" \
    -e "s|__S3_SECRET_KEY__|$S3_SECRET_KEY|" config.template.json > "$CONFIG"

echo "==> schema + ~1.5M rows"
docker cp source-schema.sql "$SOURCE_CONTAINER":/tmp/schema.sql
docker cp source-seed.sql "$SOURCE_CONTAINER":/tmp/seed.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$SOURCE_CONTAINER" \
  psql -U postgres -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$SOURCE_CONTAINER" \
  psql -U postgres -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/seed.sql

echo "==> 250 Storage files"
BD_DEMO_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
BD_DEMO_S3_ACCESS_KEY="$S3_ACCESS_KEY" \
BD_DEMO_S3_SECRET_KEY="$S3_SECRET_KEY" \
BD_DEMO_PG_URL="postgresql://postgres:$PG_PASSWORD@127.0.0.1:$PG_PORT/appdb" \
  node storage-setup.mjs

echo "==> backup"
run_cli backup --config "$CONFIG"

echo "==> drill (every file verified, plus business invariants against the sandbox)"
run_cli drill --config "$CONFIG" \
  --verify-all-files --check-cmd "node check-invariants.mjs"
