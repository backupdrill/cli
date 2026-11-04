// 带 Auth 的恢复(2.10.0,PRD 增补 §5.2):Auth 用户、identities、应用数据、触发器在同一个事务里写进目标。
// 头一条要求:**任何一步失败,目标原样不动,修好原因原地重跑就成功**。每个阶段都注入一次失败来验证。
// 真实 Postgres(Docker)+ 本机 pg_restore / psql 上跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runBackup } from "../dist/backup.js";
import { runRestore } from "../dist/restore.js";
import { transactionOutcome } from "../dist/auth-restore.js";
import { AUTH_DDL, SETUP, readableMemoryStore, sql, startPostgres } from "./auth-fixtures.js";

const x = promisify(execFile);
const pgDump = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

async function available(cmd, args) {
  try {
    await x(cmd, args);
    return true;
  } catch {
    return false;
  }
}
const canRun =
  (await available("docker", ["version"])) && (await available(pgDump, ["--version"])) && (await available("psql", ["--version"]));
const which = async (cmd) => (await x("sh", ["-c", `command -v ${cmd}`])).stdout.trim();

/** 新项目的样子:平台建好的空 auth 两张表、三个 API 角色,public 是空的 */
const NEW_PROJECT = `
  ${AUTH_DDL}
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
`;

/** 目标里和这次恢复有关的东西:Auth 用户、public 里的对象、auth.users 上的触发器 */
async function targetState(url) {
  const res = await sql(
    url,
    `select (select count(*)::int from auth.users) as users,
            (select count(*)::int from auth.identities) as identities,
            (select count(*)::int from pg_class where relnamespace = 'public'::regnamespace) as public_relations,
            (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace) as public_functions,
            (select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal) as triggers`
  );
  return res.rows[0];
}
const EMPTY = { users: 0, identities: 0, public_relations: 0, public_functions: 0, triggers: 0 };

test(
  "restore: Auth users and the database go in one transaction; any failure leaves the target untouched",
  { skip: canRun ? false : "requires Docker, pg_dump and psql", timeout: 900_000 },
  async (t) => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-auth-restore-"));
    const savedEnv = { pgRestore: process.env.BACKUPDRILL_PG_RESTORE, psql: process.env.BACKUPDRILL_PSQL };
    try {
      const port = await startPostgres(ids);
      const admin = `postgresql://postgres:pw@127.0.0.1:${port}/postgres`;
      await sql(admin, SETUP);
      // 一张表的外键指向 auth.users,源库里却有一行找不到用户(绕过外键写进去的,外键本身是有效的):
      // 恢复后这条外键建成 NOT VALID,数据一行不少,报告里列出来
      await sql(admin, `
        create table public.notes (id int primary key, owner uuid references auth.users (id));
        insert into public.notes values (1, '11111111-1111-1111-1111-111111111111');
        set session_replication_role = replica;
        insert into public.notes values (2, '99999999-0000-0000-0000-000000000000');
        reset session_replication_role;
        create table public.links (identity_id uuid references auth.identities (id));
        insert into public.links select id from auth.identities limit 1;`);
      const okUrl = `postgresql://reader_ok:r@127.0.0.1:${port}/postgres`;
      const config = { databaseUrl: okUrl, projectName: "restore", schemas: ["public"], storage: { bucket: "unused" } };
      const mem = readableMemoryStore();
      await runBackup({ ...config, auth: "default" }, { store: mem.store });
      assert.equal(mem.manifest().auth.status, "included");

      let n = 0;
      const freshTarget = async (extra = "") => {
        const name = `target${++n}`;
        await sql(admin, `create database ${name}`);
        const url = `postgresql://postgres:pw@127.0.0.1:${port}/${name}`;
        await sql(url, NEW_PROJECT + extra);
        return url;
      };
      const restore = (url, extra = {}) =>
        runRestore(config, { store: mem.store, targetDatabaseUrl: url, confirmTarget: "127.0.0.1", ...extra });
      const realPgRestore = await which(process.env.BACKUPDRILL_PG_RESTORE || "pg_restore");
      const realPsql = await which("psql");
      // 假的 pg_restore / psql:--version 照真的回答,其余按 body 做
      const wrapper = (name, body) => {
        const real = name === "psql" ? realPsql : realPgRestore;
        const dir = mkdtempSync(join(work, "bin-"));
        const path = join(dir, name);
        writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "${real}" --version; fi\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
      };
      const withEnv = async (env, fn) => {
        Object.assign(process.env, env);
        try {
          return await fn();
        } finally {
          for (const key of Object.keys(env)) {
            const saved = key === "BACKUPDRILL_PG_RESTORE" ? savedEnv.pgRestore : savedEnv.psql;
            if (saved === undefined) delete process.env[key];
            else process.env[key] = saved;
          }
        }
      };

      await t.test("a new project gets the Auth users, the data and the triggers; foreign keys into Auth are checked", async () => {
        const target = await freshTarget();
        const result = await restore(target);
        assert.equal(result.restoredToDatabase, true);
        assert.equal(result.databaseVerified, true, JSON.stringify(result.databaseChecks));
        assert.equal(result.auth.restored, true);
        assert.equal(result.auth.users, 4);
        assert.equal(result.auth.identities, 4);
        assert.deepEqual(result.auth.triggers, ["on_auth_user_created"]);
        assert.ok(result.auth.manual.some((m) => m.includes('policy "self_read"')), JSON.stringify(result.auth.manual));
        assert.ok(result.auth.notes.some((m) => m.includes("anonymous user")), JSON.stringify(result.auth.notes));
        const after = await sql(
          target,
          `select (select count(*)::int from auth.users) as users,
                  (select count(*)::int from auth.identities) as identities,
                  (select count(*)::int from public.profiles) as profiles,
                  (select count(*)::int from auth.users where recovery_token <> '' or recovery_sent_at is not null) as pending,
                  (select count(*)::int from pg_policy where polrelid = 'auth.users'::regclass) as policies,
                  (select convalidated from pg_constraint where conname = 'profiles_id_fkey') as profiles_fk_valid,
                  (select convalidated from pg_constraint where conname = 'notes_owner_fkey') as notes_fk_valid,
                  (select count(*)::int from pg_constraint where conname = 'links_identity_id_fkey') as links_fk`
        );
        assert.deepEqual(after.rows[0], {
          users: 4, identities: 4, profiles: 4, pending: 0, policies: 0,
          profiles_fk_valid: true, // 外键真的校验了,不是跳过
          notes_fk_valid: false, // 源库自带的孤儿行:NOT VALID,数据一行不少
          links_fk: 1, // 指向 auth.identities 的外键也建了
        });
        assert.deepEqual(result.orphanedForeignKeys.map((o) => o.constraint), ["notes_owner_fkey"]);
        // 补建的触发器在:新注册的用户有 profile
        await sql(target, "insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'new@example.test')");
        const profile = await sql(target, "select name from public.profiles where id = '55555555-5555-5555-5555-555555555555'");
        assert.equal(profile.rows[0]?.name, "new@example.test");
      });

      await t.test("dry run: passes on a new project, and stops on a target that already has Auth users", async () => {
        const target = await freshTarget();
        await restore(target, { dryRun: true });
        assert.deepEqual(await targetState(target), EMPTY);
        await sql(target, "insert into auth.users (id) values ('66666666-6666-6666-6666-666666666666')");
        await assert.rejects(restore(target, { dryRun: true }), /already has 1 Auth user\(s\)[\s\S]*--skip-auth/);
        await assert.rejects(restore(target), /already has 1 Auth user\(s\)/);
        const state = await targetState(target);
        assert.deepEqual(state, { ...EMPTY, users: 1 });
      });

      await t.test("--skip-auth restores the way 2.9 did (the foreign keys into auth.users need the users there)", async () => {
        const target = await freshTarget();
        await assert.rejects(restore(target, { skipAuth: true }), /point at auth\.users rows the target doesn't have/);
        assert.deepEqual(await targetState(target), EMPTY);
        // 用户自己先把 Auth 用户复制过去,再用 --skip-auth:老路径照样走得通
        await sql(target, "insert into auth.users (id) select unnest(array['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444']::uuid[])");
        await sql(target, "insert into auth.identities (user_id, provider, provider_id) select id, 'email', id::text from auth.users");
        await assert.rejects(restore(target), /already has 4 Auth user\(s\)/);
        // links 指向源库 identities 的 id,目标上复制出来的 identities 是新 id:这条外键在老路径里照旧拦下
        await assert.rejects(restore(target, { skipAuth: true }), /links_identity_id_fkey|identities/);
      });

      await t.test("a failure while writing the Auth users rolls everything back, and the error carries no row values", async () => {
        const target = await freshTarget("alter table auth.users add constraint no_pw check (email is null or email not like 'pw@%');");
        await assert.rejects(restore(target), (error) => {
          assert.match(error.message, /writing the Auth users failed: a check constraint was violated \(SQLSTATE 23514\)/);
          assert.doesNotMatch(error.message, /example\.test|\$2a\$/);
          assert.match(error.message, /rolled back/);
          return true;
        });
        assert.deepEqual(await targetState(target), EMPTY);
        await sql(target, "alter table auth.users drop constraint no_pw");
        const again = await restore(target);
        assert.equal(again.auth.restored, true);
      });

      await t.test("an Auth row count that doesn't match the snapshot stops the restore", async () => {
        const target = await freshTarget();
        const original = mem.manifest();
        mem.setManifest({ ...original, auth: { ...original.auth, rows: { users: 5, identities: 4 } } });
        try {
          await assert.rejects(restore(target), /checking the Auth users failed: the Auth row counts on the target differ from this snapshot/);
        } finally {
          mem.setManifest(original);
        }
        assert.deepEqual(await targetState(target), EMPTY);
        assert.equal((await restore(target)).auth.restored, true);
      });

      await t.test("an error in the database part or in the triggers rolls the Auth users back too", async () => {
        // 目标上的事件触发器挡掉建表 / 建触发器:模拟应用 schema、触发器两段各自出错
        const blocker = (tag) => `
          create schema test_blockers;
          create function test_blockers.block() returns event_trigger language plpgsql as $$
          begin raise exception 'blocked for the test'; end $$;
          create event trigger block_it on ddl_command_end when tag in ('${tag}') execute function test_blockers.block();`;
        for (const [tag, stage] of [["CREATE TABLE", "restoring the database"], ["CREATE TRIGGER", "recreating your triggers on the Auth tables"]]) {
          const target = await freshTarget(blocker(tag));
          await assert.rejects(restore(target), (error) => {
            assert.match(error.message, new RegExp(`${stage} failed: blocked for the test`));
            return true;
          });
          assert.deepEqual(await targetState(target), EMPTY, stage);
          await sql(target, "drop event trigger block_it");
          assert.equal((await restore(target)).auth.restored, true, stage);
        }
      });

      await t.test("a generator that stops half way never gets committed", async () => {
        const target = await freshTarget();
        // 生成应用数据那一段的 pg_restore 只吐出一部分就以 1 退出
        const fake = wrapper(
          "pg_restore",
          `case "$*" in *restore.list*) "${realPgRestore}" "$@" | head -c 4000; exit 1;; esac\nexec "${realPgRestore}" "$@"`
        );
        await withEnv({ BACKUPDRILL_PG_RESTORE: fake, BACKUPDRILL_PSQL: realPsql }, () =>
          assert.rejects(restore(target), /pg_restore stopped while writing out the database \(exit code 1\)/)
        );
        assert.deepEqual(await targetState(target), EMPTY);
        assert.equal((await restore(target)).auth.restored, true);
      });

      await t.test("COMMIT that never reaches the target: the transaction id says it rolled back", async () => {
        const target = await freshTarget();
        // psql 收到 COMMIT 之前输入就断了(连接断开、进程被杀的同一种形态)
        const fake = wrapper("psql", `awk '/^commit;$/ { exit } { print; fflush() }' | "${realPsql}" "$@"`);
        await withEnv({ BACKUPDRILL_PSQL: fake }, () =>
          assert.rejects(restore(target), /committing failed[\s\S]*rolled back/)
        );
        assert.deepEqual(await targetState(target), EMPTY);
        assert.equal((await restore(target)).auth.restored, true);
      });

      await t.test("someone signing up after the checks is caught inside the lock, before anything is written", async () => {
        const target = await freshTarget();
        // 预检之后、事务加锁之前,目标上来了一个注册
        const fake = wrapper(
          "psql",
          `"${realPsql}" -X -q "$@" -c "insert into auth.users (id) values ('77777777-7777-7777-7777-777777777777')" >/dev/null\nexec "${realPsql}" "$@"`
        );
        await withEnv({ BACKUPDRILL_PSQL: fake }, () =>
          assert.rejects(restore(target), /checking the target is still empty failed: auth\.users is no longer empty/)
        );
        assert.deepEqual(await targetState(target), { ...EMPTY, users: 1 });
      });

      await t.test("Auth columns the backup can't fill, or of another type, stop the restore before it writes", async () => {
        const target = await freshTarget(`
          alter table auth.users add column must_have text not null;
          alter table auth.identities alter column provider type varchar(20);`);
        await assert.rejects(restore(target), (error) => {
          assert.match(error.message, /auth\.users\.must_have on the target is required and has no default/);
          assert.match(error.message, /auth\.identities\.provider is text in the backup but character varying\(20\) on the target/);
          return true;
        });
        assert.deepEqual(await targetState(target), EMPTY);
      });

      await t.test("a target without Supabase Auth tables is refused unless --skip-auth", async () => {
        await sql(admin, "create database bare");
        const bare = `postgresql://postgres:pw@127.0.0.1:${port}/bare`;
        await assert.rejects(restore(bare, { dryRun: true }), /no Supabase Auth tables/);
      });

      await t.test("transactionOutcome reads committed, aborted, in progress and unknown transaction ids", async () => {
        const client = new pg.Client({ connectionString: admin });
        await client.connect();
        try {
          await client.query("begin");
          const committed = (await client.query("select pg_current_xact_id()::text as id")).rows[0].id;
          await client.query("commit");
          await client.query("begin");
          const aborted = (await client.query("select pg_current_xact_id()::text as id")).rows[0].id;
          await client.query("rollback");
          await client.query("begin");
          const open = (await client.query("select pg_current_xact_id()::text as id")).rows[0].id;
          assert.equal(await transactionOutcome(admin, committed), "committed");
          assert.equal(await transactionOutcome(admin, aborted), "rolled_back");
          assert.equal(await transactionOutcome(admin, open, { waitMs: 300, pollMs: 100 }), "unknown");
          await client.query("rollback");
          assert.equal(await transactionOutcome(admin, String(BigInt(open) + 1_000_000n)), "unknown");
          assert.equal(await transactionOutcome("postgresql://postgres:pw@127.0.0.1:1/none", committed), "unknown");
        } finally {
          await client.end();
        }
      });
    } finally {
      process.env.BACKUPDRILL_PG_RESTORE = savedEnv.pgRestore;
      process.env.BACKUPDRILL_PSQL = savedEnv.psql;
      if (savedEnv.pgRestore === undefined) delete process.env.BACKUPDRILL_PG_RESTORE;
      if (savedEnv.psql === undefined) delete process.env.BACKUPDRILL_PSQL;
      for (const id of ids) await x("docker", ["rm", "-f", "-v", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);
