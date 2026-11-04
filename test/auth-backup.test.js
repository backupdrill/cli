// Auth 用户备份(2.10.0)。头一条要求是不打扰现有备份:
//  - 库调用方不传 auth(= 关闭)时,pg_dump 的参数、上传的文件、manifest 都和之前逐字一致;
//  - 主 dump 永远不被 Auth 拖累:读不到、存储不支持、schemas 已含 auth、auth dump 失败、快照导入失败,
//    数据库备份都照常完成,Auth 段只记 skipped/failed。
// 真实 Postgres 上跑:auth 两张表照 Supabase 开着 RLS,只有 BYPASSRLS 的角色能读到行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runBackup, mainDumpArgs, AUTH_TIMEOUTS } from "../dist/backup.js";
import { schemasMayIncludeAuth, restorableAuthObjects, manualAuthObjects } from "../dist/auth-backup.js";
import { parseManifest } from "../dist/manifest.js";
import { renderRecoveryDoc } from "../dist/recovery-doc.js";

const x = promisify(execFile);
const realPgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const canRun = (await available("docker", ["version"])) && (await available(realPgDump, ["--version"]));
const canRunPsql = canRun && (await available("psql", ["--version"]));

test("schemasMayIncludeAuth: false only when every entry is a plain schema name other than auth", () => {
  for (const schemas of [
    ["public", "auth"], ["AUTH"], ['"auth"'], ["*"], ["a*"], ["au?h"], ["public", "[a]uth"], ["(auth|audit)"],
    ["mydb.auth"], // "库.schema" 的写法算不清,按"会"处理
    ["[[:alpha:]]uth"], // PostgreSQL 的 POSIX 字符类,JavaScript 正则不认:按"会"处理
  ]) {
    assert.equal(schemasMayIncludeAuth(schemas), true, JSON.stringify(schemas));
  }
  for (const schemas of [["public"], ["public", "audit"], ["authz"], ["public", "private"]]) {
    assert.equal(schemasMayIncludeAuth(schemas), false, JSON.stringify(schemas));
  }
  // 模式写法、加引号的名字、带 $ 的名字一律不另备 Auth(说不准选中哪些 schema,也不让它们进 RECOVERY.md)
  for (const schemas of [["pub*"], ["p*"], ["auth?"], ['"Auth"'], ['"a*"'], ["audit$$archive"], ['"SQL\nx"']]) {
    assert.equal(schemasMayIncludeAuth(schemas), true, JSON.stringify(schemas));
  }
});

test("mainDumpArgs: without a snapshot the arguments are exactly the pre-2.10 ones", () => {
  assert.deepEqual(mainDumpArgs(["public"]), ["--format=custom", "--no-owner", "--no-privileges", "--schema=public"]);
  assert.deepEqual(mainDumpArgs(["public", "audit"], "00000003-1"), [
    "--format=custom", "--no-owner", "--no-privileges", "--snapshot=00000003-1", "--schema=public", "--schema=audit",
  ]);
});

test("restorable Auth objects: only enabled triggers with plain names whose function schema is backed up; never policies", () => {
  const trig = (name, enabled, functionSchema = "public") => ({ table: "users", name, enabled, functionSchema, functionName: "f" });
  const auth = {
    triggers: [
      trig("ok", "O"), trig("always", "A"), trig("off", "D"), trig("replica", "R"), trig("priv", "O", "private"), trig("it's", "O"),
      trig("ext", "O", "extensions"), // 平台 schema 里的函数可能是用户自己建的,新项目里没有
      { ...trig("when_private", "O"), dependencySchemas: ["public", "private"] }, // WHEN 里调了 private 的函数
    ],
    policies: [{ table: "users", name: "p", functionSchemas: [] }],
  };
  assert.deepEqual(restorableAuthObjects(auth, ["public"]).triggers.map((t) => t.name), ["ok"]);
  // 不加引号的名字按 pg_dump 的规则折成小写
  assert.deepEqual(restorableAuthObjects(auth, ["Public"]).triggers.map((t) => t.name), ["ok"]);
  // private 也备了:触发函数在 private 的、WHEN 里调 private 函数的,都能建了
  assert.deepEqual(restorableAuthObjects(auth, ["public", "private"]).triggers.map((t) => t.name), ["ok", "priv", "when_private"]);
  const notes = manualAuthObjects(auth, ["public"]).join("\n");
  for (const name of ["always", "off", "replica", "priv", "it's", "ext", "when_private"]) {
    assert.ok(notes.includes(JSON.stringify(name)), name);
  }
  assert.match(notes, /policy "p" on auth\.users isn't recreated automatically/);
});

test("RECOVERY.md never puts an object name into a shell command unless it is a plain identifier", () => {
  const evil = "x' ; touch /tmp/pwned ; '";
  const auth = {
    ...includedAuth(),
    triggers: [
      { table: "users", name: "on_signup", enabled: "O", functionSchema: "public", functionName: "f" },
      { table: "users", name: evil, enabled: "O", functionSchema: "public", functionName: "f" },
    ],
  };
  const doc = renderRecoveryDoc({ ...baseManifest(), auth }, { snapshot: "s", bucket: "b", prefix: "p", projectName: "p" });
  const bash = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  assert.ok(bash.includes("TRIGGER auth users on_signup"));
  assert.equal(bash.includes("pwned"), false);
  assert.ok(doc.includes(JSON.stringify(evil)), "the odd name is listed as a manual step instead");
  assert.equal(doc.includes("backupdrill restore \\"), false, "no CLI restore recipe until the CLI restores Auth users");
});

const baseManifest = () => ({
  schemaVersion: 2,
  tool: "backupdrill-cli",
  toolVersion: "2.10.0",
  createdAt: "2026-11-04T00:00:00.000Z",
  projectName: "p",
  database: { serverVersion: "17.6", pgDumpVersion: "pg_dump (PostgreSQL) 17.6", schemas: ["public"], tableCount: 0, estimatedRowTotal: 0, tables: [] },
  dump: { key: "backupdrill/p/s/dump.pgcustom", format: "custom", bytes: 1, sha256: "x" },
  storage: null,
});
const includedAuth = () => ({
  status: "included",
  dump: { key: "backupdrill/p/s/auth.dump", format: "custom", bytes: 10, sha256: "y" },
  rows: { users: 2, identities: 3 },
  passwordHashes: { none: 1, portable: 1, encrypted: 0, unrecognized: 0 },
  anonymousUsers: 0,
  ssoUsers: 0,
  mfaUsers: null,
  triggers: [{ table: "users", name: "t", enabled: "O", functionSchema: "public", functionName: "f" }],
  policies: [],
});

test("manifest: a valid included auth section parses; a broken one is rejected before anything is written", () => {
  const ok = parseManifest(JSON.stringify({ ...baseManifest(), auth: includedAuth() }));
  assert.equal(ok.auth.status, "included");
  const noRows = includedAuth();
  delete noRows.rows;
  assert.throws(() => parseManifest(JSON.stringify({ ...baseManifest(), auth: noRows })), /auth\.rows/);
  const badTrigger = includedAuth();
  badTrigger.triggers[0].enabled = "X";
  assert.throws(() => parseManifest(JSON.stringify({ ...baseManifest(), auth: badTrigger })), /auth\.triggers/);
});

test("manifest: statuses and reasons this version doesn't know are accepted, so a newer writer never breaks this reader", () => {
  for (const auth of [
    { status: "skipped", reason: "some_future_reason" },
    { status: "deferred" },
    { status: "failed", reason: "Auth archive not written: whatever" },
  ]) {
    assert.doesNotThrow(() => parseManifest(JSON.stringify({ ...baseManifest(), auth })), JSON.stringify(auth));
  }
  // 旧快照没有这个字段,照旧通过
  assert.equal(parseManifest(JSON.stringify(baseManifest())).auth, undefined);
});

// ---------- 真实 Postgres ----------

async function startPostgres(ids) {
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD=pw",
    "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
  ]);
  const id = stdout.trim();
  ids.push(id);
  const port = (await x("docker", ["port", id, "5432/tcp"])).stdout.trim().split("\n")[0].split(":").pop();
  for (let i = 0; i < 60; i++) {
    try {
      await x("docker", ["exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"]);
      return port;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

async function sql(url, text) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

// 新项目里平台建好的 auth 两张表(空的),源库和恢复目标都用它
const AUTH_DDL = `
  create schema auth;
  create table auth.users (
    instance_id uuid, id uuid primary key, email text, encrypted_password text,
    is_anonymous boolean not null default false, is_sso_user boolean not null default false,
    raw_user_meta_data jsonb,
    confirmation_token varchar(255) default '', recovery_token varchar(255) default '',
    email_change_token_new varchar(255) default '', email_change_token_current varchar(255) default '',
    phone_change_token varchar(255) default '', reauthentication_token varchar(255) default '',
    email_change varchar(255) default '', phone_change text default '', email_change_confirm_status smallint default 0,
    confirmation_sent_at timestamptz, recovery_sent_at timestamptz, email_change_sent_at timestamptz,
    phone_change_sent_at timestamptz, reauthentication_sent_at timestamptz
  );
  create table auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    provider text not null, provider_id text not null, identity_data jsonb
  );
  alter table auth.users enable row level security;
  alter table auth.identities enable row level security;
`;

// 和 Supabase 同形的最小 auth:两张表开 RLS、identities 外键指向 users;public.profiles 外键指向 auth.users,
// auth.users 上挂注册时建 profile 的触发器;auth.users 上一条策略引用了不在备份里的 private schema 的函数
const SETUP = `
${AUTH_DDL}
  create table public.profiles (id uuid primary key references auth.users (id), name text);
  create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
  begin insert into public.profiles (id, name) values (new.id, new.email); return new; end $$;
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
  create schema private;
  create function private.uid() returns uuid language sql stable as 'select null::uuid';
  create policy self_read on auth.users for select using (id = private.uid());
  insert into auth.users (id, email, encrypted_password, is_anonymous) values
    ('11111111-1111-1111-1111-111111111111', 'pw@example.test', '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123', false),
    ('22222222-2222-2222-2222-222222222222', 'oauth@example.test', null, false),
    ('33333333-3333-3333-3333-333333333333', 'enc@example.test',
     '{"key_id":"k1","alg":"aes-gcm-hkdf","data":"AAAA","nonce":"AAAAAAAAAAAAAAAA"}', false),
    ('44444444-4444-4444-4444-444444444444', null, '', true);
  update auth.users set recovery_token = 'pending-reset', recovery_sent_at = now()
   where id = '11111111-1111-1111-1111-111111111111';
  insert into auth.identities (user_id, provider, provider_id) values
    ('11111111-1111-1111-1111-111111111111', 'email', '11111111-1111-1111-1111-111111111111'),
    ('22222222-2222-2222-2222-222222222222', 'google', '1000001'),
    ('22222222-2222-2222-2222-222222222222', 'github', '2000002'),
    ('33333333-3333-3333-3333-333333333333', 'email', '33333333-3333-3333-3333-333333333333');
  create table public."archived SCHEMA - public data" (x int);
  insert into public."archived SCHEMA - public data" values (1);
  create role reader_limited login password 'r' bypassrls connection limit 2;
  grant pg_read_all_data to reader_limited;
  create role authenticated nologin;
  grant select on auth.users to authenticated;
  create role reader_ok login password 'r' bypassrls;
  grant pg_read_all_data to reader_ok;
  create role reader_norls login password 'r';
  grant pg_read_all_data to reader_norls;
  create role reader_nousage login password 'r';
  grant select on all tables in schema public to reader_nousage;
`;

/** 记下每次 pg_dump 的参数(--dbname 后面的连接串去掉),按环境变量注入失败,然后交给真的 pg_dump */
function writeWrapper(dir) {
  const log = join(dir, "argv.log");
  const wrapper = join(dir, "pg_dump");
  writeFileSync(
    wrapper,
    `#!/bin/sh
args=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$a" = "--dbname" ]; then skip=1; continue; fi
  args="$args $a"
done
echo "$args" >> "${log}"
case "$args" in
  *--table=auth.users*) if [ -n "$BD_TEST_FAIL_AUTH" ]; then echo "pg_dump: error: injected auth failure" >&2; exit 1; fi ;;
  *--snapshot=*--schema=*) if [ -n "$BD_TEST_FAIL_MAIN_SNAPSHOT" ]; then echo "pg_dump: error: query failed: ERROR:  invalid snapshot identifier" >&2; exit 1; fi ;;
esac
case "$args" in
  *--schema=*) if [ -n "$BD_TEST_FAIL_MAIN" ]; then echo "pg_dump: error: connection lost" >&2; exit 1; fi ;;
esac
case "$args" in
  *--snapshot=*--schema=*) if [ -n "$BD_TEST_MAIN_QUEUED_SECONDS" ]; then sleep "$BD_TEST_MAIN_QUEUED_SECONDS"; fi ;;
esac
exec "${realPgDump}" "$@"
`
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, log };
}

/** 内存快照存储:记下写了哪些文件;authCapable=false 模拟还没适配 auth.dump 的存储;stallAuth=上传永远完不成 */
function memoryStore({ authCapable = true, stallAuth = false, lateWrites = false, hangAuthAbort = false, hangMainAbort = false } = {}) {
  const files = new Map();
  let manifest;
  const stalled = () => ({ done: new Promise(() => {}), abort: async () => {} });
  const collect = (name) => (body) => ({
    done: (async () => {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (lateWrites) setTimeout(() => files.set(name, data), 300); // 晚到的写入会盖掉之前的
      else files.set(name, data);
    })(),
    abort: async () => {},
  });
  return {
    files,
    manifest: () => manifest,
    store: {
      createSnapshot: async () => ({
        dumpKey: "backupdrill/t/snap/dump.pgcustom",
        storageFiles: null,
        describe: (file) => file,
        uploadDump: hangMainAbort
          ? (body) => ({ ...collect("dump.pgcustom")(body), abort: () => new Promise(() => {}) }) // 中止永远不返回
          : collect("dump.pgcustom"),
        ...(authCapable
          ? {
              authDumpKey: "backupdrill/t/snap/auth.dump",
              uploadAuthDump: stallAuth
                ? stalled
                : hangAuthAbort
                  ? (body) => ({ ...collect("auth.dump")(body), abort: () => new Promise(() => {}) }) // 中止永远不返回
                  : collect("auth.dump"),
            }
          : {}),
        writeRecoveryDoc: async () => {},
        writeManifest: async (written) => {
          manifest = written;
        },
      }),
      openSnapshot: async () => {
        throw new Error("write-only test store");
      },
    },
  };
}

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test(
  "Auth users backup: off is byte-for-byte the old backup; default backs up what it can and never touches the main dump",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 240_000 },
  async (t) => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-auth-backup-"));
    try {
      const port = await startPostgres(ids);
      const admin = `postgresql://postgres:pw@127.0.0.1:${port}/postgres`;
      await sql(admin, SETUP);
      await sql(admin, "create database plain"); // 不能和别的语句同在一个事务里
      const okUrl = `postgresql://reader_ok:r@127.0.0.1:${port}/postgres`;
      const noRlsUrl = `postgresql://reader_norls:r@127.0.0.1:${port}/postgres`;
      const plainUrl = `postgresql://postgres:pw@127.0.0.1:${port}/plain`;
      const { wrapper, log } = writeWrapper(work);
      const LEGACY = " --format=custom --no-owner --no-privileges --schema=public";

      const run = async (
        name, config, { env = {}, authCapable = true, stallAuth = false, lateWrites = false, hangAuthAbort = false, hangMainAbort = false } = {}
      ) => {
        writeFileSync(log, "");
        const mem = memoryStore({ authCapable, stallAuth, lateWrites, hangAuthAbort, hangMainAbort });
        const manifest = await withEnv({ BACKUPDRILL_PG_DUMP: wrapper, ...env }, () =>
          runBackup({ projectName: name, schemas: ["public"], ...config }, { store: mem.store })
        );
        return { manifest, files: mem.files, argv: readFileSync(log, "utf8").trim().split("\n").filter((l) => l && l.trim() !== "--version") };
      };

      await t.test("off (library default): same pg_dump call, no extra file, no auth field", async () => {
        const r = await run("off", { databaseUrl: okUrl });
        assert.deepEqual(r.argv, [LEGACY]);
        assert.deepEqual([...r.files.keys()], ["dump.pgcustom"]);
        assert.equal("auth" in r.manifest, false);
      });

      await t.test("default + a role that can read everything: Auth archive included, counts right", async () => {
        const r = await run("ok", { databaseUrl: okUrl, auth: "default" });
        const a = r.manifest.auth;
        assert.equal(a.status, "included", JSON.stringify(a));
        assert.deepEqual(a.rows, { users: 4, identities: 4 });
        assert.deepEqual(a.passwordHashes, { none: 2, portable: 1, encrypted: 1, unrecognized: 0 });
        assert.equal(a.anonymousUsers, 1);
        assert.equal(a.ssoUsers, 0);
        assert.equal(a.mfaUsers, null, "no auth.mfa_factors table → unknown, not a failure");
        assert.deepEqual(a.triggers, [
          {
            table: "users", name: "on_auth_user_created", enabled: "O",
            functionSchema: "public", functionName: "handle_new_user", dependencySchemas: ["public"],
          },
        ]);
        assert.deepEqual(a.policies, [{ table: "users", name: "self_read", functionSchemas: ["private"] }]);
        assert.ok(a.grants.some((g) => g.table === "users" && g.grantee === "authenticated" && g.privilege === "SELECT"), JSON.stringify(a.grants));
        assert.ok(r.files.get("auth.dump").length > 0);
        assert.equal(a.dump.bytes, r.files.get("auth.dump").length);
        // 两份 dump 用的是同一个快照
        const snap = (line) => line.match(/--snapshot=(\S+)/)?.[1];
        const mainLine = r.argv.find((l) => l.includes("--schema=public"));
        const authLine = r.argv.find((l) => l.includes("--table=auth.users"));
        assert.ok(snap(mainLine) && snap(mainLine) === snap(authLine), r.argv.join("\n"));
        // auth.dump 里有两张表的数据,也带着触发器和策略(恢复时据此补建)
        const archive = join(work, "auth.dump");
        writeFileSync(archive, r.files.get("auth.dump"));
        const listing = (await x(process.env.BACKUPDRILL_PG_RESTORE || "pg_restore", ["--list", archive])).stdout;
        assert.match(listing, /TABLE DATA auth users/);
        assert.match(listing, /TABLE DATA auth identities/);
        assert.match(listing, /TRIGGER auth users on_auth_user_created/);
        assert.match(listing, /POLICY auth users self_read/);
        // 主 dump 不受影响:就是一份正常的 public 备份
        assert.ok(r.files.get("dump.pgcustom").length > 0);
        assert.equal(r.manifest.dump.bytes, r.files.get("dump.pgcustom").length);
      });

      await t.test("the RECOVERY.md steps restore Auth users and data in one transaction, as written", { skip: canRunPsql ? false : "requires psql" }, async () => {
        const r = await run("runbook", { databaseUrl: okUrl, auth: "default" });
        const doc = renderRecoveryDoc(r.manifest, {
          snapshot: "snap", bucket: "b", region: "auto", prefix: "backupdrill", projectName: "runbook",
        });
        // 第 4 步的两段 bash:先生成 restore.sql,再用一个事务执行
        const step4 = doc.slice(doc.indexOf("4. Restore the Auth users"));
        const blocks = [...step4.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
        assert.equal(blocks.length >= 2, true, step4);
        const dir = mkdtempSync(join(work, "runbook-"));
        writeFileSync(join(dir, "dump.pgcustom"), r.files.get("dump.pgcustom"));
        writeFileSync(join(dir, "auth.dump"), r.files.get("auth.dump"));
        // 先拿一个坏掉的 auth.dump 试:任何一步失败都不能打印 complete
        const broken = mkdtempSync(join(work, "runbook-broken-"));
        writeFileSync(join(broken, "dump.pgcustom"), r.files.get("dump.pgcustom"));
        writeFileSync(join(broken, "auth.dump"), r.files.get("auth.dump").subarray(0, 64));
        const bad = await x("bash", ["-c", blocks[0]], { cwd: broken }).catch((e) => e);
        assert.equal(/restore\.sql is complete/.test(bad.stdout ?? ""), false, "a failed generation must not say complete");
        const generated = await x("bash", ["-c", blocks[0]], { cwd: dir });
        assert.match(generated.stdout, /restore\.sql is complete/);

        // 目标 = 一个新项目:平台建好的空 auth 两张表,public 是空的
        await sql(admin, "create database target");
        const targetUrl = `postgresql://postgres:pw@127.0.0.1:${port}/target`;
        await sql(targetUrl, AUTH_DDL);
        const psqlLine = blocks[1].split("\n").find((l) => l.startsWith("psql "));
        assert.match(psqlLine, /^psql -X --single-transaction -v ON_ERROR_STOP=1/);
        const restoreOnce = () =>
          x("psql", ["-X", "--single-transaction", "-v", "ON_ERROR_STOP=1", "--dbname", targetUrl, "-f", "restore.sql"], { cwd: dir });
        await restoreOnce();

        const after = await sql(
          targetUrl,
          `select (select count(*)::int from auth.users) as users,
                  (select count(*)::int from auth.identities) as identities,
                  (select count(*)::int from public.profiles) as profiles,
                  (select count(*)::int from auth.users where recovery_token <> '' or recovery_sent_at is not null) as pending,
                  (select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created') as trig,
                  (select count(*)::int from pg_policy where polrelid = 'auth.users'::regclass) as policies,
                  (select bool_and(convalidated) from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'f') as fk_valid,
                  (select count(*)::int from public."archived SCHEMA - public data") as odd_table`
        );
        assert.deepEqual(after.rows[0], {
          users: 4, identities: 4, profiles: 4, pending: 0, trig: 1, policies: 0, fk_valid: true,
          odd_table: 1, // 名字里恰好带 "SCHEMA - public" 的表不能被筛掉
        });
        assert.match(doc, /policy "self_read" on auth\.users isn't recreated automatically/);
        assert.match(doc, /SELECT on auth\.users to authenticated/);

        // 再跑一次:目标里已经有 Auth 用户,脚本在写任何东西之前就拒绝,整个事务回滚,目标原样不动
        await assert.rejects(restoreOnce(), /auth\.users is not empty/);
        // 没有 Auth 用户、但已有应用表的目标也拒绝,不把快照合并进去
        await sql(admin, "create database target2");
        const target2 = `postgresql://postgres:pw@127.0.0.1:${port}/target2`;
        await sql(target2, AUTH_DDL + "create table public.existing (x int);");
        await assert.rejects(
          x("psql", ["-X", "--single-transaction", "-v", "ON_ERROR_STOP=1", "--dbname", target2, "-f", "restore.sql"], { cwd: dir }),
          /the target already has tables in the restored schemas/
        );
        const t2 = await sql(target2, "select (select count(*)::int from auth.users) as users");
        assert.equal(t2.rows[0].users, 0);
        // Auth 表上已有触发器(会悄悄改掉恢复进去的数据)的目标也拒绝
        await sql(admin, "create database target3");
        const target3 = `postgresql://postgres:pw@127.0.0.1:${port}/target3`;
        await sql(
          target3,
          AUTH_DDL +
            `create function public.touch() returns trigger language plpgsql as 'begin return new; end';
             create trigger touch before insert on auth.users for each row execute function public.touch();`
        );
        await assert.rejects(
          x("psql", ["-X", "--single-transaction", "-v", "ON_ERROR_STOP=1", "--dbname", target3, "-f", "restore.sql"], { cwd: dir }),
          /already have triggers or policies/
        );
        const again = await sql(targetUrl, "select (select count(*)::int from auth.users) as users, (select count(*)::int from public.profiles) as profiles");
        assert.deepEqual(again.rows[0], { users: 4, profiles: 4 });
      });

      await t.test("default + a role without BYPASSRLS: skipped, nothing extra, main dump exactly as before", async () => {
        const r = await run("norls", { databaseUrl: noRlsUrl, auth: "default" });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "no_permission" });
        assert.deepEqual(r.argv, [LEGACY]);
        assert.deepEqual([...r.files.keys()], ["dump.pgcustom"]);
      });

      await t.test("default + a role that can't even see the auth schema: skipped (no permission), not failed", async () => {
        const r = await run("nousage", { databaseUrl: `postgresql://reader_nousage:r@127.0.0.1:${port}/postgres`, auth: "default" });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "no_permission" });
        assert.deepEqual(r.argv, [LEGACY]);
      });

      await t.test("on + a role without BYPASSRLS: failed, but the database backup still completes", async () => {
        const r = await run("norls-on", { databaseUrl: noRlsUrl, auth: "on" });
        assert.deepEqual(r.manifest.auth, { status: "failed", reason: "no_permission" });
        assert.ok(r.files.get("dump.pgcustom").length > 0);
      });

      await t.test("default + not a Supabase database: skipped quietly", async () => {
        const r = await run("plain", { databaseUrl: plainUrl, auth: "default" });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "no_auth_schema" });
        assert.deepEqual(r.argv, [LEGACY]);
      });

      await t.test("default + schemas that may already include auth: skipped, main dump untouched", async () => {
        for (const schemas of [["public", "auth"], ["*"]]) {
          const r = await run("in-schemas", { databaseUrl: okUrl, auth: "default", schemas });
          assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "schemas_may_include_auth" });
          assert.deepEqual(r.argv, [" --format=custom --no-owner --no-privileges" + schemas.map((s) => ` --schema=${s}`).join("")]);
          assert.deepEqual([...r.files.keys()], ["dump.pgcustom"]);
        }
      });

      await t.test("on + a schema pattern that can't be worked out: failed (exit 3), never a silent success", async () => {
        const r = await run("ambiguous-on", { databaseUrl: okUrl, auth: "on", schemas: ["public", "[p]ublic"] });
        assert.deepEqual(r.manifest.auth, { status: "failed", reason: "schemas_may_include_auth" });
        const d = await run("ambiguous-default", { databaseUrl: okUrl, auth: "default", schemas: ["public", "[p]ublic"] });
        assert.deepEqual(d.manifest.auth, { status: "skipped", reason: "schemas_may_include_auth" });
        const sure = await run("auth-on", { databaseUrl: okUrl, auth: "on", schemas: ["public", "auth"] });
        assert.deepEqual(sure.manifest.auth, { status: "skipped", reason: "schemas_may_include_auth" }, "auth is in the main dump");
      });

      await t.test("default + a destination that can't hold auth.dump: skipped, behaves as before", async () => {
        const r = await run("no-dest", { databaseUrl: okUrl, auth: "default" }, { authCapable: false });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "unsupported_destination" });
        assert.deepEqual(r.argv, [LEGACY]);
      });

      await t.test("the Auth dump failing doesn't affect the main dump", async () => {
        const r = await run("auth-fails", { databaseUrl: okUrl, auth: "default" }, { env: { BD_TEST_FAIL_AUTH: "1" } });
        assert.equal(r.manifest.auth.status, "failed");
        assert.match(r.manifest.auth.reason, /^Auth archive not written: pg_dump exited with code 1/);
        assert.ok(r.files.get("dump.pgcustom").length > 0);
        assert.equal(r.files.has("auth.dump"), false);
      });

      await t.test("the main dump can't import the snapshot: it is redone the old way, Auth marked unavailable", async () => {
        const r = await run("snap-fails", { databaseUrl: okUrl, auth: "default" }, { env: { BD_TEST_FAIL_MAIN_SNAPSHOT: "1" } });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "snapshot_unavailable" });
        assert.ok(r.argv.includes(LEGACY), r.argv.join("\n"));
        assert.ok(r.files.get("dump.pgcustom").length > 0);
        assert.equal(r.manifest.dump.bytes, r.files.get("dump.pgcustom").length);
      });

      await t.test("the failed snapshot attempt never writes the dump, so it can't overwrite the redone one", async () => {
        const r = await run("late", { databaseUrl: okUrl, auth: "default" }, {
          env: { BD_TEST_FAIL_MAIN_SNAPSHOT: "1" },
          lateWrites: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 800)); // 等所有晚到的写入落定
        assert.ok(r.manifest.dump.bytes > 0);
        assert.equal(r.files.get("dump.pgcustom").length, r.manifest.dump.bytes);
      });

      await t.test("a connection limit the Auth export exhausts: the database backup still succeeds the usual way", async () => {
        const r = await run("limited", { databaseUrl: `postgresql://reader_limited:r@127.0.0.1:${port}/postgres`, auth: "default" }, {
          stallAuth: true,
        });
        // 谁先拿到名额看时机:主 dump 抢到就照共享快照导完,没抢到就按今天的方式重导。
        // 两种都必须是一份完整的数据库备份,Auth 都不能报成已备上
        assert.ok(r.manifest.dump.bytes > 0);
        assert.equal(r.files.get("dump.pgcustom").length, r.manifest.dump.bytes);
        assert.notEqual(r.manifest.auth.status, "included");
      });

      await t.test("a main dump stuck behind the Auth connections: Auth makes way, the backup finishes within seconds", async () => {
        // 模拟连接池排队:带共享快照的主 dump 要"排"3 秒才轮到;Auth 的上传卡住、占着名额不放
        const previous = AUTH_TIMEOUTS.mainStartGraceMs;
        AUTH_TIMEOUTS.mainStartGraceMs = 500;
        try {
          const started = Date.now();
          const r = await run("queued", { databaseUrl: okUrl, auth: "default" }, {
            env: { BD_TEST_MAIN_QUEUED_SECONDS: "3" },
            stallAuth: true,
          });
          assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
          assert.ok(r.manifest.dump.bytes > 0);
          assert.equal(r.files.get("dump.pgcustom").length, r.manifest.dump.bytes);
          assert.notEqual(r.manifest.auth.status, "included");
        } finally {
          AUTH_TIMEOUTS.mainStartGraceMs = previous;
        }
      });

      await t.test("an Auth cleanup that never returns can't keep the fallback dump from running", async () => {
        const started = Date.now();
        const r = await run("hung-abort", { databaseUrl: okUrl, auth: "default" }, {
          env: { BD_TEST_FAIL_AUTH: "1", BD_TEST_FAIL_MAIN_SNAPSHOT: "1" },
          hangAuthAbort: true,
        });
        assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
        assert.ok(r.manifest.dump.bytes > 0);
        assert.equal(r.files.get("dump.pgcustom").length, r.manifest.dump.bytes);
      });

      await t.test("a stuck upload abort after the shared-snapshot attempt fails can't keep the fallback from running", async () => {
        const started = Date.now();
        const r = await run("hung-main-abort", { databaseUrl: okUrl, auth: "default" }, {
          env: { BD_TEST_FAIL_MAIN_SNAPSHOT: "1" },
          hangMainAbort: true,
        });
        assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
        assert.ok(r.manifest.dump.bytes > 0);
        assert.equal(r.files.get("dump.pgcustom").length, r.manifest.dump.bytes);
      });

      await t.test("any schema pattern means no separate Auth backup; the main dump is untouched", async () => {
        const r = await run("pattern", { databaseUrl: okUrl, auth: "default", schemas: ["pub*"] });
        assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "schemas_may_include_auth" });
        assert.deepEqual(r.argv, [" --format=custom --no-owner --no-privileges --schema=pub*"]);
      });

      await t.test("someone else holding a lock on auth.users: Auth gives up within seconds, database backup completes", async () => {
        const locker = new pg.Client({ connectionString: admin });
        await locker.connect();
        try {
          await locker.query("begin; lock table auth.users in access exclusive mode");
          const started = Date.now();
          const r = await run("locked", { databaseUrl: okUrl, auth: "default" });
          assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
          assert.equal(r.manifest.auth.status, "failed");
          assert.match(r.manifest.auth.reason, /lock timeout/);
          assert.ok(r.files.get("dump.pgcustom").length > 0);
        } finally {
          await locker.query("rollback").catch(() => {});
          await locker.end();
        }
      });

      await t.test("an Auth upload that never finishes doesn't hold up the backup", async () => {
        const previous = AUTH_TIMEOUTS.waitAfterMainMs;
        AUTH_TIMEOUTS.waitAfterMainMs = 1500;
        try {
          const r = await run("stall", { databaseUrl: okUrl, auth: "default" }, { stallAuth: true });
          assert.equal(r.manifest.auth.status, "failed");
          assert.match(r.manifest.auth.reason, /timed out/);
          assert.ok(r.files.get("dump.pgcustom").length > 0);
        } finally {
          AUTH_TIMEOUTS.waitAfterMainMs = previous;
        }
      });

      await t.test("the preparation deadline drops the Auth connections at once and lets the database backup go ahead", async () => {
        const locker = new pg.Client({ connectionString: admin });
        await locker.connect();
        const previous = AUTH_TIMEOUTS.prepareDeadlineMs;
        AUTH_TIMEOUTS.prepareDeadlineMs = 500;
        try {
          await locker.query("begin; lock table auth.users in access exclusive mode");
          const started = Date.now();
          const r = await run("deadline", { databaseUrl: okUrl, auth: "default" });
          // 走的是"到点放弃"这条路(而不是 5 秒后的锁超时):原因是 snapshot_unavailable。
          // 时间只做宽松的上限,整套测试并行、机器很忙时也不误报
          assert.deepEqual(r.manifest.auth, { status: "skipped", reason: "snapshot_unavailable" });
          assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
          assert.ok(r.files.get("dump.pgcustom").length > 0);
          // 客户端已断开;服务端在等锁的那个进程每秒检查一次,很快就会收手
          let left = 1;
          for (let i = 0; i < 45 && left > 0; i++) {
            left = (await sql(admin, "select count(*)::int as n from pg_stat_activity where usename = 'reader_ok'")).rows[0].n;
            if (left > 0) await new Promise((r) => setTimeout(r, 100));
          }
          assert.equal(left, 0, "no Auth connection is left behind (well before the 5 s lock timeout)");
        } finally {
          AUTH_TIMEOUTS.prepareDeadlineMs = previous;
          await locker.query("rollback").catch(() => {});
          await locker.end();
        }
      });

      await t.test("the main dump failing while the Auth upload is stuck reports the failure promptly", async () => {
        const started = Date.now();
        await assert.rejects(
          run("main-fails", { databaseUrl: okUrl, auth: "default" }, { env: { BD_TEST_FAIL_MAIN: "1" }, stallAuth: true }),
          /connection lost/
        );
        assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
      });

      await t.test("the snapshot connection is gone once both dumps have started", async () => {
        await run("released", { databaseUrl: okUrl, auth: "default" });
        const idle = await sql(
          admin,
          `select count(*)::int as n from pg_stat_activity where usename = 'reader_ok' and state like 'idle in transaction%'`
        );
        assert.equal(idle.rows[0].n, 0);
      });
    } finally {
      for (const id of ids) await x("docker", ["rm", "-f", id]).catch(() => {});
      if (existsSync(work)) rmSync(work, { recursive: true, force: true });
    }
  }
);
