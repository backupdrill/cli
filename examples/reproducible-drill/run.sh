#!/usr/bin/env bash
# End-to-end reproduction of the drill report published at
# https://backupdrill.com/drill-report
#
# Builds a Supabase-shaped Postgres 17 source (Auth users and identities in
# GoTrue's own table layout, a profiles table with a foreign key into
# auth.users and a sign-up trigger, RLS policies on platform roles, grants to
# the API roles, a partitioned table, a materialized view, extensions in their
# own schema), seeds ~1.5M rows, puts 250 files in an S3-compatible store, then
# runs a real backup and a real restore drill against them.
#
# --with-login goes one step further: it restores the snapshot with
# `backupdrill restore` into a fresh Supabase Postgres with GoTrue (the Supabase
# Auth server) running on it, then signs in with a password set before the
# backup. It pulls two more images (supabase/postgres, about 1.7 GB, and
# supabase/gotrue) and needs psql next to pg_restore.
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

WITH_LOGIN=0
for arg in "$@"; do
  case "$arg" in
    --with-login) WITH_LOGIN=1 ;;
    *) echo "usage: $0 [--with-login]" >&2; exit 2 ;;
  esac
done

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
# 带 Auth 的恢复由 psql 跑单事务。找法和 CLI 的 resolvePsqlBin() 一样:pg_restore 名字就叫 pg_restore 时
# 换成同目录的 psql,别的名字(pg_restore-17、包装脚本)就用 PATH 上的 psql
if [ "$WITH_LOGIN" = 1 ]; then
  case "$PG_RESTORE" in
    pg_restore | */pg_restore) PSQL="${PG_RESTORE%pg_restore}psql" ;;
    *) PSQL=psql ;;
  esac
  command -v "$PSQL" >/dev/null 2>&1 || { echo "--with-login needs psql ($PSQL), which the CLI uses for the restore" >&2; exit 1; }
  # CLI 的 Auth 恢复(auth-restore.ts 的 psqlProblem)拒绝不带 \restrict 的 pg_restore(17 要 17.6 起)
  # 和比 pg_restore 旧的 psql。在这里先拦,不然要等备份和演练都跑完才在恢复那一步失败
  version_of() { "$1" --version | sed -E 's/.* ([0-9]+)\.([0-9]+).*/\1 \2/'; }
  read -r restore_major restore_minor <<< "$(version_of "$PG_RESTORE")"
  read -r psql_major psql_minor <<< "$(version_of "$PSQL")"
  if [ "$restore_major" -eq 17 ] && [ "$restore_minor" -lt 6 ]; then
    echo "--with-login needs pg_restore 17.6 or newer (found $restore_major.$restore_minor); the CLI's Auth restore refuses older ones" >&2
    exit 1
  fi
  if [ "$psql_major" -lt "$restore_major" ] || { [ "$psql_major" -eq "$restore_major" ] && [ "$psql_minor" -lt "$restore_minor" ]; }; then
    echo "psql $psql_major.$psql_minor is older than pg_restore $restore_major.$restore_minor; --with-login needs psql from the same client package" >&2
    exit 1
  fi
fi

RUN_ID="$$"
SOURCE_CONTAINER="bd-demo-source-$RUN_ID"
S3_CONTAINER="bd-demo-s3-$RUN_ID"
TARGET_CONTAINER="bd-demo-target-$RUN_ID"
AUTH_CONTAINER="bd-demo-auth-$RUN_ID"
NETWORK="bd-demo-net-$RUN_ID"
PG_PORT="${PG_PORT:-15432}"
S3_PORT="${S3_PORT:-19000}"
TARGET_PORT="${TARGET_PORT:-15433}"
AUTH_PORT="${AUTH_PORT:-19999}"

# Per-run credentials. Nothing here is ever written to a tracked file.
PG_PASSWORD="$(openssl rand -hex 16)"
S3_ACCESS_KEY="demo$(openssl rand -hex 6)"
S3_SECRET_KEY="$(openssl rand -hex 24)"
TARGET_PASSWORD="$(openssl rand -hex 16)"
AUTH_DB_PASSWORD="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"

WORKDIR="$(mktemp -d)"
CONFIG="$WORKDIR/backupdrill.config.json"

# 只删本次 docker run 真正返回的 ID —— 按名字盲删会在 pid 复用时误伤别人的容器。
# -v:postgres 镜像的数据目录是匿名卷,不带 -v 每跑一次就留一个卷
CREATED_IDS=()
CREATED_NETWORK=""
cleanup() {
  for id in "${CREATED_IDS[@]:-}"; do
    [ -n "$id" ] && docker rm -fv "$id" >/dev/null 2>&1 || true
  done
  [ -n "$CREATED_NETWORK" ] && docker network rm "$CREATED_NETWORK" >/dev/null 2>&1 || true
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

source_sql() {
  docker exec -e PGPASSWORD="$PG_PASSWORD" "$SOURCE_CONTAINER" \
    psql -U source_admin -d appdb -Atq -v ON_ERROR_STOP=1 -c "$1"
}

[ -f ../../dist/index.js ] || { echo "build first: pnpm install && pnpm build" >&2; exit 1; }

echo "==> source Postgres 17"
# 固定 tag:可变 tag 会让同一份代码日后跑在不同软件上。
# 演练沙箱的镜像不在这里 —— 那个由引擎选。
# 源库的超级用户不叫 postgres:--with-login 以 postgres 身份恢复进另一个库,而 restore 拒绝
# 主机和用户名都和源库一样的目标(它不比端口),防的就是恢复回源库
CREATED_IDS+=("$(docker run -d --name "$SOURCE_CONTAINER" -e POSTGRES_USER=source_admin \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=appdb -p 127.0.0.1:"$PG_PORT":5432 postgres:17.6-alpine)")
wait_for "Postgres" 90 docker exec "$SOURCE_CONTAINER" pg_isready -U source_admin -d appdb

echo "==> S3-compatible store (destination bucket + Storage source bucket)"
# versitygw's POSIX backend: each top-level directory under /data is a bucket. The two
# buckets are created up front; storage-setup.mjs then finds them already there.
# --sidecar keeps object metadata (Content-Type, Cache-Control) in files instead of
# extended attributes, which not every Docker storage driver supports.
# (The MinIO image this used before can no longer be pulled: Docker Hub answers
# "denied" and quay.io 401.)
CREATED_IDS+=("$(docker run -d --name "$S3_CONTAINER" -p 127.0.0.1:"$S3_PORT":7070 \
  -e ROOT_ACCESS_KEY="$S3_ACCESS_KEY" -e ROOT_SECRET_KEY="$S3_SECRET_KEY" \
  --entrypoint sh versity/versitygw:v1.9.0 \
  -c "mkdir -p /data/user-uploads /data/acme-backups /meta && exec versitygw posix --sidecar /meta /data")")
# Any HTTP answer (an unsigned request gets 403) means the gateway is up.
wait_for "S3 store" 90 curl -sS -o /dev/null "http://127.0.0.1:$S3_PORT/"

sed -e "s|__PG_PASSWORD__|$PG_PASSWORD|" -e "s|__PG_PORT__|$PG_PORT|" \
    -e "s|__S3_PORT__|$S3_PORT|" -e "s|__S3_ACCESS_KEY__|$S3_ACCESS_KEY|" \
    -e "s|__S3_SECRET_KEY__|$S3_SECRET_KEY|" config.template.json > "$CONFIG"

echo "==> schema + ~1.5M rows + 1,000 Auth users"
docker cp source-schema.sql "$SOURCE_CONTAINER":/tmp/schema.sql
docker cp source-seed.sql "$SOURCE_CONTAINER":/tmp/seed.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$SOURCE_CONTAINER" \
  psql -U source_admin -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$SOURCE_CONTAINER" \
  psql -U source_admin -d appdb -q -v ON_ERROR_STOP=1 -f /tmp/seed.sql
echo "    source database: $(source_sql "select pg_size_pretty(pg_database_size(current_database()))") on disk"

echo "==> 250 Storage files"
BD_DEMO_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
BD_DEMO_S3_ACCESS_KEY="$S3_ACCESS_KEY" \
BD_DEMO_S3_SECRET_KEY="$S3_SECRET_KEY" \
BD_DEMO_PG_URL="postgresql://source_admin:$PG_PASSWORD@127.0.0.1:$PG_PORT/appdb" \
  node storage-setup.mjs

echo "==> backup"
run_cli backup --config "$CONFIG"

echo "==> drill (every file verified, plus business invariants against the sandbox)"
run_cli drill --config "$CONFIG" \
  --verify-all-files --check-cmd "node check-invariants.mjs"

[ "$WITH_LOGIN" = 1 ] || exit 0

# ── --with-login:恢复进一个新的 Supabase 形态项目,再用备份前的密码登录 ──────────
# 目标 = supabase/postgres(托管项目用的同一个镜像)+ GoTrue(Supabase Auth 服务)。GoTrue 启动时
# 自己跑迁移建出 auth 表,和新建的托管项目一样:Auth 表在、里面没有用户。
# 恢复走 backupdrill restore,以 postgres 身份写入(镜像里的 postgres 和托管上一样不是超级用户)。

# restore 的目标库和恢复记录:记录写进本次的临时目录,不留在你的 home 里
run_cli_target() {
  env -i \
    PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    BACKUPDRILL_PG_DUMP="$PG_DUMP" BACKUPDRILL_PG_RESTORE="$PG_RESTORE" \
    BACKUPDRILL_TARGET_DATABASE_URL="postgresql://postgres:$TARGET_PASSWORD@127.0.0.1:$TARGET_PORT/postgres" \
    BACKUPDRILL_STATE_DIR="$WORKDIR/restore-records" \
    node ../../dist/index.js "$@"
}
target_sql() {
  docker exec -e PGPASSWORD="$TARGET_PASSWORD" "$TARGET_CONTAINER" \
    psql -U postgres -h localhost -d postgres -Atq -v ON_ERROR_STOP=1 -c "$1"
}
# POST 到 GoTrue,打印 HTTP 状态码;响应体留在 $WORKDIR/gotrue.json
gotrue_post() {
  curl -sS -o "$WORKDIR/gotrue.json" -w '%{http_code}' -X POST "http://127.0.0.1:$AUTH_PORT$1" \
    -H 'Content-Type: application/json' -d "$2"
}
fail() { echo "  ✗ $1" >&2; exit 1; }

echo "==> fresh Supabase-shaped target: supabase/postgres + GoTrue"
docker network create "$NETWORK" >/dev/null
CREATED_NETWORK="$NETWORK"
CREATED_IDS+=("$(docker run -d --name "$TARGET_CONTAINER" --network "$NETWORK" --network-alias db \
  -e POSTGRES_PASSWORD="$TARGET_PASSWORD" -p 127.0.0.1:"$TARGET_PORT":5432 supabase/postgres:17.6.1.084)")
# 镜像先在只听本地 socket 的临时实例上跑初始化,TCP 能连上才是正式启动
wait_for "target Postgres" 180 docker exec "$TARGET_CONTAINER" pg_isready -U postgres -h localhost
# GoTrue 以 supabase_auth_admin 连库;镜像里这个角色没有密码,托管平台替你设好的这一步在这里手动做
wait_for "target roles" 60 docker exec -e PGPASSWORD="$TARGET_PASSWORD" "$TARGET_CONTAINER" \
  psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 \
  -c "alter role supabase_auth_admin with password '$AUTH_DB_PASSWORD'"
CREATED_IDS+=("$(docker run -d --name "$AUTH_CONTAINER" --network "$NETWORK" -p 127.0.0.1:"$AUTH_PORT":9999 \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL="http://127.0.0.1:$AUTH_PORT" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$AUTH_DB_PASSWORD@db:5432/postgres" \
  -e GOTRUE_SITE_URL=http://127.0.0.1:3000 -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_DISABLE_SIGNUP=false \
  supabase/gotrue:v2.186.0)")
# /health 有回应时迁移已经跑完
wait_for "GoTrue" 120 curl -fsS "http://127.0.0.1:$AUTH_PORT/health"

echo "==> restore (dry run first, then for real)"
run_cli_target restore --config "$CONFIG" --database --storage-dir "$WORKDIR/recovered-files" --dry-run
run_cli_target restore --config "$CONFIG" --database --storage-dir "$WORKDIR/recovered-files" \
  --confirm-target 127.0.0.1

echo "==> sign in on the restored project"
code="$(gotrue_post '/token?grant_type=password' '{"email":"user1@example.com","password":"demo-password-1"}')"
[ "$code" = 200 ] && grep -q '"access_token"' "$WORKDIR/gotrue.json" \
  || fail "user1@example.com could not sign in with its old password (HTTP $code)"
echo "  ✓ user1@example.com signed in with the password it had before the backup (HTTP 200, access token issued)"

code="$(gotrue_post '/token?grant_type=password' '{"email":"user1@example.com","password":"not-the-password"}')"
[ "$code" = 400 ] || fail "a wrong password was not refused (HTTP $code)"
echo "  ✓ the same account with a wrong password is refused (HTTP 400)"

code="$(gotrue_post '/signup' '{"email":"newcomer@example.com","password":"newcomer-password-1"}')"
[ "$code" = 200 ] || fail "a new sign-up failed (HTTP $code)"
profiles="$(target_sql "select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email = 'newcomer@example.com'")"
[ "$profiles" = 1 ] || fail "the new user has no row in public.profiles: the sign-up trigger did not run"
echo "  ✓ a new sign-up through GoTrue got its profiles row from the restored trigger"

pending_before="$(source_sql "select count(*) from auth.users where recovery_token <> ''")"
pending_after="$(target_sql "select count(*) from auth.users where recovery_token <> ''")"
[ "$pending_after" = 0 ] || fail "$pending_after password-reset links survived the restore"
echo "  ✓ password-reset links pending at backup time: $pending_before at the source, $pending_after after the restore"
