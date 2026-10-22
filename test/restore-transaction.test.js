// 真实 Postgres 上的恢复回归(2026-10-22 实验的复现):只备 public 的快照,public 表有外键指向
// auth.users,恢复进一个 auth.users 为空的新项目。
//  - 改之前:dry-run 全绿;正式恢复在 profiles_id_fkey 上失败,表和数据已经落库,重跑被空目标门挡住。
//  - 改之后:dry-run 和正式恢复都在写入之前报出缺哪些行;恢复中途失败整体回滚,本次装上的扩展也删掉,
//    同一个目标修好原因就能重跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runRestore } from "../dist/restore.js";

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
const canRun = (await available("docker", ["version"])) && (await available(pgDump, ["--version"]));

async function startPostgres(ids, settings = []) {
  // 数据目录放 tmpfs:不建匿名卷。node --test 并行跑各个测试文件,drill.test.js 会数整台机器上
  // 新冒出来的匿名卷,这里建卷会让它误报泄漏
  const { stdout } = await x("docker", [
    "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD=pw",
    "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
    ...(settings.length ? ["postgres", ...settings.flatMap((kv) => ["-c", kv])] : []),
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

/** public 里不属于任何扩展的关系、函数、类型 = 空目标门数的那些对象。 */
async function publicUserObjects(url) {
  const res = await sql(
    url,
    `select count(*)::int as n from (
       select c.oid, 'pg_class'::regclass as cls from pg_class c where c.relnamespace = 'public'::regnamespace
       union all select p.oid, 'pg_proc'::regclass from pg_proc p where p.pronamespace = 'public'::regnamespace
       union all select t.oid, 'pg_type'::regclass from pg_type t
         where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','r','c') and t.typrelid = 0
     ) o where not exists (select 1 from pg_depend d where d.deptype = 'e'
                             and ((d.classid = o.cls and d.objid = o.oid)
                               or (o.cls = 'pg_class'::regclass and d.classid = 'pg_type'::regclass
                                   and d.objid = (select reltype from pg_class where oid = o.oid))))`
  );
  return res.rows[0].n;
}

/** public 里的关系、函数、类型总数(含扩展自带的)。 */
async function publicObjects(url) {
  const res = await sql(
    url,
    `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public')
          + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')
          + (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public' and t.typtype in ('e','d','r','c') and t.typrelid = 0) as n`
  );
  return Number(res.rows[0].n);
}

test(
  "restore: FK into auth.users is caught before any write; a failed restore is rolled back and can be rerun",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-refs-test-"));
    try {
      const [sourcePort, targetPort] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      // localhost 而不是 127.0.0.1:同源阻断按主机+用户比,两个容器只能靠写法区分
      const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;

      await sql(
        sourceUrl,
        `create schema auth;
         create table auth.users (id uuid primary key);
         insert into auth.users values
           ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'),
           ('00000000-0000-0000-0000-000000000003');
         create extension pg_trgm schema public;
         create table public.profiles (id uuid primary key references auth.users(id), name text);
         insert into public.profiles select id, 'u' || row_number() over () from auth.users;
         create table public.items (id int primary key, owner uuid references public.profiles(id));
         insert into public.items select g, (select id from public.profiles order by id limit 1) from generate_series(1, 50) g;
         -- 分区父表上的外键,数据在分区里;外键列名带空格
         create table public.events (id int, "Actor Id" uuid references auth.users(id)) partition by range (id);
         create table public.events_a partition of public.events for values from (0) to (1000);
         insert into public.events select g, '00000000-0000-0000-0000-000000000002' from generate_series(1, 20) g;
         -- NOT VALID:源库里本来就有不合规的行,恢复也不校验,检查必须放过它
         create table public.legacy (owner uuid);
         insert into public.legacy values ('00000000-0000-0000-0000-0000000000ff');
         alter table public.legacy add constraint legacy_owner_fkey foreign key (owner) references auth.users(id) not valid;
         -- 备份之外的函数:dry-run 看不出来,恢复要在灌完数据之后的 post-data 里才失败
         create schema private;
         create function private.touch() returns trigger language plpgsql as $$ begin return new; end $$;
         create trigger items_touch before update on public.items for each row execute function private.touch();`
      );
      const dumpPath = join(work, "source.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
      const buf = readFileSync(dumpPath);
      const manifest = {
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-22T00:00:00.000Z",
        projectName: "refs",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          tableCount: 6,
          estimatedRowTotal: 77,
          tables: [
            { schema: "public", name: "events", estimatedRows: 0 },
            { schema: "public", name: "events_a", estimatedRows: 20 },
            { schema: "public", name: "items", estimatedRows: 50 },
            { schema: "public", name: "legacy", estimatedRows: 1 },
            { schema: "public", name: "profiles", estimatedRows: 3 },
          ],
          extensions: [{ name: "pg_trgm", version: "1.6", schema: "public" }],
        },
        dump: {
          key: "backupdrill/refs/snap/dump.pgcustom",
          format: "custom",
          bytes: buf.length,
          sha256: createHash("sha256").update(buf).digest("hex"),
        },
        storage: null,
      };
      manifest.database.tableCount = manifest.database.tables.length;
      const store = localStore(manifest, dumpPath, buf);
      const config = { databaseUrl: sourceUrl, projectName: "refs", schemas: ["public"], storage: { bucket: "unused" } };
      const restore = (extra) =>
        runRestore(config, { store, targetDatabaseUrl: targetUrl, confirmTarget: "localhost", ...extra });

      // 目标 1:没有 auth schema 的裸 Postgres —— 被引用的表根本不在
      await assert.rejects(restore({ dryRun: true }), (error) => {
        assert.match(error.message, /auth\.users does not exist on the target/);
        return true;
      });

      // 目标 2:新项目的样子 —— auth.users 在,但一行都没有。再在 public 里开一个 dblink(像在控制台里开的):
      // 它带着扩展自己的复合类型,空目标门不能把它当成已有对象
      await sql(targetUrl, "create schema auth; create table auth.users (id uuid primary key); create extension dblink schema public;");
      await assert.rejects(restore({ dryRun: true }), (error) => {
        assert.doesNotMatch(error.message, /existing object/, "extension objects don't make the target non-empty");
        assert.match(error.message, /public\.profiles → auth\.users \(profiles_id_fkey\): 3 of 3 row\(s\)/);
        // 分区父表的外键按分区里的数据算
        assert.match(error.message, /public\.events → auth\.users \(events_Actor Id_fkey\): 20 of 20 row\(s\)/);
        assert.doesNotMatch(error.message, /legacy_owner_fkey/, "NOT VALID foreign keys are not validated on restore");
        return true;
      });
      await assert.rejects(restore({}), /nothing from the snapshot was written/);
      assert.equal(await publicUserObjects(targetUrl), 0, "refused restore must not write anything from the snapshot");

      // 只补上两个用户:还差一个,dry-run 必须报 1 of 3
      await sql(
        targetUrl,
        "insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002')"
      );
      await assert.rejects(restore({ dryRun: true }), /profiles_id_fkey\): 1 of 3 row\(s\)/);
      await sql(targetUrl, "insert into auth.users values ('00000000-0000-0000-0000-000000000003')");
      const dry = await restore({ dryRun: true });
      assert.equal(dry.dryRun, true);

      // 扩展的配置表(pg_extension_config_dump)照样算已有对象:转储会带它的数据,恢复会插重复行
      const targetId = (await x("docker", ["ps", "-q", "--filter", `publish=${targetPort}`])).stdout.trim();
      await x("docker", ["exec", "-u", "root", targetId, "sh", "-c",
        "d=$(pg_config --sharedir)/extension; " +
        "printf \"default_version = '1.0'\\nrelocatable = false\\n\" > $d/bdtest_cfg.control; " +
        "printf \"create table cfg (k text);\\nselect pg_catalog.pg_extension_config_dump('cfg', '');\\n\" > $d/bdtest_cfg--1.0.sql"]);
      await sql(targetUrl, "create extension bdtest_cfg schema public");
      await assert.rejects(restore({ dryRun: true }), /contain 1 existing object/);
      await sql(targetUrl, "drop extension bdtest_cfg");

      // 外键都对上了,但 private.touch() 不在目标上:恢复在 post-data 失败,必须整体回滚。
      // 本次装进 public 的 pg_trgm 留着(下次还要用),空目标门不数扩展自带的函数,下一次照样能跑
      await assert.rejects(restore({}), (error) => {
        assert.match(error.message, /schema "private" does not exist/);
        assert.match(error.message, /rolled back/);
        return true;
      });
      const trgm = await sql(targetUrl, "select count(*)::int as n from pg_extension where extname = 'pg_trgm'");
      assert.equal(trgm.rows[0].n, 1, "the extension stays installed");
      assert.ok((await publicObjects(targetUrl)) > 0, "pg_trgm's own functions live in public");
      assert.equal(await publicUserObjects(targetUrl), 0, "nothing from the snapshot is left in public");
      // 和扩展同时存在、又不属于扩展的对象照样挡门
      await sql(targetUrl, "create table public.stray (id int)");
      await assert.rejects(restore({ dryRun: true }), /contain 1 existing object/);
      await sql(targetUrl, "drop table public.stray");

      // 修好原因,同一个目标直接重跑
      await sql(
        targetUrl,
        "create schema private; create function private.touch() returns trigger language plpgsql as $$ begin return new; end $$;"
      );
      const done = await restore({});
      assert.equal(done.restoredToDatabase, true);
      assert.equal(done.databaseVerified, true);
      const constraints = await sql(
        targetUrl,
        "select conname from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1"
      );
      assert.ok(constraints.rows.some((r) => r.conname === "profiles_id_fkey"));
      assert.ok(constraints.rows.some((r) => r.conname === "legacy_owner_fkey"));
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);

/** 一份只读的本地快照,给 runRestore 当 store 用。 */
function localStore(manifest, dumpPath, buf) {
  return {
    createSnapshot: async () => {
      throw new Error("read-only test store");
    },
    openSnapshot: async () => ({
      name: "snap",
      readManifest: async () => JSON.stringify(manifest),
      downloadDump: async (_m, dest) => {
        copyFileSync(dumpPath, dest);
        return { bytes: buf.length, sha256: manifest.dump.sha256 };
      },
      storageFiles: () => null,
    }),
  };
}

test(
  "restore: a target that runs out of lock slots is rolled back and the error says how to raise them",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-locks-test-"));
    try {
      // 目标的锁表故意开得很小(10 × 约 40 个后端槽位):150 张表、每张连同主键、序列、TOAST 六个关系,
      // 在一个事务里一定放不下
      const [sourcePort, targetPort] = await Promise.all([
        startPostgres(ids),
        startPostgres(ids, ["max_connections=20", "max_locks_per_transaction=10"]),
      ]);
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;
      await sql(
        sourceUrl,
        `do $$ begin for i in 1..150 loop
           execute format('create table public.t%s (id bigint generated always as identity primary key, v text)', i);
           execute format('insert into public.t%s (v) values (''x'')', i);
         end loop; end $$;`
      );
      const dumpPath = join(work, "many.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
      const buf = readFileSync(dumpPath);
      const tables = Array.from({ length: 150 }, (_, i) => ({ schema: "public", name: `t${i + 1}`, estimatedRows: 1 }));
      const manifest = {
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-23T00:00:00.000Z",
        projectName: "many",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          tableCount: tables.length,
          estimatedRowTotal: tables.length,
          tables,
        },
        dump: { key: "backupdrill/many/snap/dump.pgcustom", format: "custom", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") },
        storage: null,
      };
      const config = { databaseUrl: sourceUrl, projectName: "many", schemas: ["public"], storage: { bucket: "unused" } };
      await assert.rejects(
        runRestore(config, { store: localStore(manifest, dumpPath, buf), targetDatabaseUrl: targetUrl, confirmTarget: "localhost" }),
        (error) => {
          assert.match(error.message, /out of shared memory/);
          assert.match(error.message, /rolled back/);
          assert.match(error.message, /max_locks_per_transaction=256/);
          return true;
        }
      );
      assert.equal(await publicObjects(targetUrl), 0, "nothing may be left behind");
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);

test(
  "restore: when pg_restore reports a failure after the transaction committed, the error doesn't claim a rollback",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-commit-test-"));
    const previous = process.env.BACKUPDRILL_PG_RESTORE;
    try {
      const [sourcePort, targetPort] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;
      await sql(sourceUrl, "create table public.t (id int primary key); insert into public.t values (1);");
      const dumpPath = join(work, "t.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
      const buf = readFileSync(dumpPath);
      // 模拟 COMMIT 的回复丢了:真 pg_restore 跑完(已提交),包装脚本再报一个连接断开的错
      const realPgRestore = (await x("sh", ["-c", "command -v pg_restore"])).stdout.trim();
      const wrapper = join(work, "pg_restore");
      writeFileSync(
        wrapper,
        `#!/bin/sh\ncase " $* " in *" --single-transaction "*)\n  "${realPgRestore}" "$@" || exit $?\n` +
          `  echo "pg_restore: error: could not execute query: server closed the connection unexpectedly" >&2\n  exit 1;;\n` +
          `*) exec "${realPgRestore}" "$@";;\nesac\n`
      );
      chmodSync(wrapper, 0o755);
      process.env.BACKUPDRILL_PG_RESTORE = wrapper;
      const manifest = {
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-23T00:00:00.000Z",
        projectName: "t",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          tableCount: 1,
          estimatedRowTotal: 1,
          tables: [{ schema: "public", name: "t", estimatedRows: 1 }],
        },
        dump: { key: "backupdrill/t/snap/dump.pgcustom", format: "custom", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") },
        storage: null,
      };
      const config = { databaseUrl: sourceUrl, projectName: "t", schemas: ["public"], storage: { bucket: "unused" } };
      await assert.rejects(
        runRestore(config, { store: localStore(manifest, dumpPath, buf), targetDatabaseUrl: targetUrl, confirmTarget: "localhost" }),
        (error) => {
          assert.match(error.message, /server closed the connection unexpectedly/);
          assert.match(error.message, /may have committed/);
          assert.doesNotMatch(error.message, /was rolled back/);
          return true;
        }
      );
      assert.ok((await publicUserObjects(targetUrl)) > 0, "the wrapper let the restore commit");
    } finally {
      if (previous === undefined) delete process.env.BACKUPDRILL_PG_RESTORE;
      else process.env.BACKUPDRILL_PG_RESTORE = previous;
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);

test(
  "restore: a foreign-key failure installs nothing, so the retry after copying users isn't blocked by an extension's config table",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-cfg-test-"));
    try {
      const [sourcePort, targetPort] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      const targetUrl = `postgresql://postgres:pw@localhost:${targetPort}/postgres`;
      // 带配置表的扩展,两边都放好文件
      for (const port of [sourcePort, targetPort]) {
        const id = (await x("docker", ["ps", "-q", "--filter", `publish=${port}`])).stdout.trim();
        await x("docker", ["exec", "-u", "root", id, "sh", "-c",
          "d=$(pg_config --sharedir)/extension; " +
          "printf \"default_version = '1.0'\\nrelocatable = false\\n\" > $d/bdtest_cfg.control; " +
          "printf \"create table cfg (k text);\\nselect pg_catalog.pg_extension_config_dump('cfg', '');\\n\" > $d/bdtest_cfg--1.0.sql"]);
      }
      await sql(
        sourceUrl,
        `create schema auth;
         create table auth.users (id uuid primary key);
         insert into auth.users values ('00000000-0000-0000-0000-000000000001');
         create table public.profiles (id uuid primary key references auth.users(id));
         insert into public.profiles values ('00000000-0000-0000-0000-000000000001');
         create extension bdtest_cfg schema public;`
      );
      const dumpPath = join(work, "cfg.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", sourceUrl, "-f", dumpPath]);
      const buf = readFileSync(dumpPath);
      const manifest = {
        schemaVersion: 2,
        tool: "backupdrill-cli",
        toolVersion: "test",
        createdAt: "2026-10-23T00:00:00.000Z",
        projectName: "cfg",
        database: {
          serverVersion: "17.6",
          pgDumpVersion: (await x(pgDump, ["--version"])).stdout.trim(),
          schemas: ["public"],
          // 备份端按 public 里的表数,扩展的配置表也在其中
          tableCount: 2,
          estimatedRowTotal: 1,
          tables: [
            { schema: "public", name: "cfg", estimatedRows: 0 },
            { schema: "public", name: "profiles", estimatedRows: 1 },
          ],
          extensions: [{ name: "bdtest_cfg", version: "1.0", schema: "public" }],
        },
        dump: { key: "backupdrill/cfg/snap/dump.pgcustom", format: "custom", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") },
        storage: null,
      };
      const config = { databaseUrl: sourceUrl, projectName: "cfg", schemas: ["public"], storage: { bucket: "unused" } };
      const restore = () =>
        runRestore(config, { store: localStore(manifest, dumpPath, buf), targetDatabaseUrl: targetUrl, confirmTarget: "localhost" });

      await sql(targetUrl, "create schema auth; create table auth.users (id uuid primary key);");
      await assert.rejects(restore(), /nothing from the snapshot was written/);
      const installed = await sql(targetUrl, "select count(*)::int as n from pg_extension where extname = 'bdtest_cfg'");
      assert.equal(installed.rows[0].n, 0, "the foreign-key check runs before any extension is installed");

      await sql(targetUrl, "insert into auth.users values ('00000000-0000-0000-0000-000000000001')");
      const done = await restore();
      assert.equal(done.databaseVerified, true, "the retry on the same target goes through");
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);
