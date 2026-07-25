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
set -euo pipefail
cd "$(dirname "$0")"

PG_BIN="${PG_BIN:-/opt/homebrew/opt/libpq/bin}"
export BACKUPDRILL_PG_DUMP="${BACKUPDRILL_PG_DUMP:-$PG_BIN/pg_dump}"
export BACKUPDRILL_PG_RESTORE="${BACKUPDRILL_PG_RESTORE:-$PG_BIN/pg_restore}"

cleanup() { docker rm -f bd-demo-source bd-demo-minio >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> source Postgres 17"
docker run -d --name bd-demo-source -e POSTGRES_PASSWORD=sourcepw \
  -e POSTGRES_DB=appdb -p 15432:5432 postgres:17-alpine >/dev/null
until docker exec bd-demo-source pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

echo "==> S3-compatible store (destination bucket + Storage source bucket)"
docker run -d --name bd-demo-minio -p 19000:9000 \
  -e MINIO_ROOT_USER=bdreport -e MINIO_ROOT_PASSWORD=bdreport-secret-2026 \
  minio/minio:latest server /data >/dev/null
sleep 4

echo "==> schema + ~1.5M rows"
docker cp source-schema.sql bd-demo-source:/tmp/schema.sql
docker cp source-seed.sql bd-demo-source:/tmp/seed.sql
docker exec -e PGPASSWORD=sourcepw bd-demo-source \
  psql -U postgres -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec -e PGPASSWORD=sourcepw bd-demo-source \
  psql -U postgres -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/seed.sql

echo "==> 250 Storage files"
node storage-setup.mjs

echo "==> backup"
node ../../dist/index.js backup --config backupdrill.config.json

echo "==> drill (every file verified, plus business invariants in the sandbox)"
node ../../dist/index.js drill --config backupdrill.config.json \
  --verify-all-files --check-cmd "node check-invariants.mjs"
