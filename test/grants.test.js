// 恢复后的 Data API 授权(grants.ts):转储不带授权,恢复出来的对象拿到什么授权全看目标的默认授权。
//  - Supabase 新默认(2026-05-30 新项目 / 10-30 老项目):public 里的新表不再自动授权给 anon 等角色,
//    改之前恢复出来的表 supabase-js 读写全部 42501。
//  - 还没切换的老项目:每张恢复出来的表都开放给 anon,源库里刻意不开放的表也一样。
// 两种目标上,恢复完的授权都必须和源库逐项一致;旧快照没有记录,按 Supabase 以前的默认授权补 public。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runRestore } from "../dist/restore.js";
import { captureGrants, grantStatements, recoveryGrantsSql, restoreGrants, revokeApiAccess } from "../dist/grants.js";
import { parseManifest } from "../dist/manifest.js";
import { installSandboxShim, restoreDatabaseArtifact } from "../dist/restore-engine.js";

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

async function withClient(url, work) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
const sql = (url, text) => withClient(url, (c) => c.query(text));

// 和 Supabase 一样:三个角色,public 上给它们 USAGE
const ROLES = `do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop; end $$;
  grant usage on schema public to anon, authenticated, service_role;`;

// Supabase 以前给 public 的默认授权(pg_default_acl 实测)
const OLD_SUPABASE_DEFAULTS = `
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;`;

const SCHEMAS = ["public", "api"];

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

const grantsOf = (url) => withClient(url, (client) => captureGrants(client, SCHEMAS));
const find = (grants, kind, name, extra = {}) =>
  grants.find((g) => g.kind === kind && g.name === name && Object.entries(extra).every(([k, v]) => g[k] === v));

test(
  "restore: Data API grants come back exactly as they were in the source, whatever the target's defaults",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 240_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-grants-test-"));
    try {
      const [sourcePort, newDefaultsPort, oldDefaultsPort, legacyPort, sandboxPort] = await Promise.all(
        Array.from({ length: 5 }, () => startPostgres(ids))
      );
      const sourceUrl = `postgresql://postgres:pw@127.0.0.1:${sourcePort}/postgres`;
      const target = (port) => `postgresql://postgres:pw@localhost:${port}/postgres`;

      await sql(
        sourceUrl,
        `${ROLES} ${OLD_SUPABASE_DEFAULTS}
         create extension pg_trgm schema public;
         -- 默认授权:API 能读写,插入要用到序列
         create table public.notes (id bigint generated always as identity primary key, body text);
         insert into public.notes (body) values ('a'), ('b');
         create view public.note_ids as select id from public.notes;
         -- 刻意不开放
         create table public.audit_log (id int, entry text);
         insert into public.audit_log values (1, 'x');
         revoke all on public.audit_log from anon, authenticated, service_role;
         -- 列级授权:匿名只能读两列,登录用户只能改 name
         create table public."User Profiles" (id int primary key, name text, email text);
         insert into public."User Profiles" values (1, 'n', 'e');
         revoke all on public."User Profiles" from anon, authenticated;
         grant select (id, name) on public."User Profiles" to anon;
         grant select, update (name) on public."User Profiles" to authenticated;
         -- 函数:一个关掉了 PUBLIC 的执行权限,一个保持默认
         create function public.admin_only(p_user uuid default null) returns int language sql security definer as 'select 1';
         revoke execute on function public.admin_only(uuid) from public, anon, authenticated;
         create function public.add(a int, b int) returns int language sql as 'select a + b';
         -- 聚合:有序集聚合的 identity arguments 带 ORDER BY,GRANT 不认
         create aggregate public.total(int) (sfunc = int4pl, stype = int);
         create aggregate public.pick(float8 order by anyelement) (
           sfunc = ordered_set_transition, stype = internal, finalfunc = percentile_disc_final, finalfunc_extra);
         revoke execute on function public.pick(float8, anyelement) from public, anon, authenticated, service_role;
         grant execute on function public.pick(float8, anyelement) to authenticated;
         -- 靠 schema 关门:anon 对 public 没有 USAGE,表上的授权它也用不上;目标的 public 却是开放的
         revoke usage on schema public from public, anon;
         -- 自定义 schema:没有默认授权,源库显式开放
         create schema api;
         grant usage on schema api to anon, authenticated;
         create table api.things (id int);
         insert into api.things values (1);
         grant select on api.things to anon;
         -- 两个授权人各给一次 SELECT:ACL 里两条,记录里一条
         create role helper; grant usage on schema public to helper;
         grant select on public.notes to helper with grant option;
         set role helper; grant select on public.notes to anon; reset role;`
      );
      const source = await grantsOf(sourceUrl);
      // 读到的东西先对一遍,后面的"目标与源一致"才有意义
      assert.deepEqual(find(source, "table", "audit_log").privileges, {});
      assert.deepEqual(find(source, "column", "User Profiles", { column: "name" }).privileges, {
        anon: ["SELECT"],
        authenticated: ["UPDATE"],
      });
      assert.deepEqual(find(source, "routine", "admin_only").privileges, { service_role: ["EXECUTE"] });
      assert.equal(find(source, "routine", "admin_only").args, "p_user uuid");
      assert.deepEqual(find(source, "routine", "add").privileges.PUBLIC, ["EXECUTE"]);
      assert.deepEqual(find(source, "schema", undefined, { schema: "api" }).privileges, { anon: ["USAGE"], authenticated: ["USAGE"] });
      assert.equal(find(source, "routine", "similarity"), undefined, "extension functions are not ours to record");
      assert.equal(find(source, "routine", "pick").args, "double precision, anyelement");
      assert.deepEqual(find(source, "routine", "pick").privileges, { authenticated: ["EXECUTE"] });
      assert.equal(find(source, "table", "notes").privileges.anon.filter((p) => p === "SELECT").length, 1);
      assert.deepEqual(find(source, "schema", undefined, { schema: "public" }).privileges, {
        authenticated: ["USAGE"],
        service_role: ["USAGE"],
      });

      const dumpPath = join(work, "source.pgcustom");
      await x(pgDump, [
        "--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--schema=api", "--dbname", sourceUrl, "-f", dumpPath,
      ]);
      const buf = readFileSync(dumpPath);
      const tables = [
        { schema: "api", name: "things", estimatedRows: 1 },
        { schema: "public", name: "User Profiles", estimatedRows: 1 },
        { schema: "public", name: "audit_log", estimatedRows: 1 },
        { schema: "public", name: "notes", estimatedRows: 2 },
      ];
      const pgDumpVersion = (await x(pgDump, ["--version"])).stdout.trim();
      const manifestWith = (grants) =>
        parseManifest(
          JSON.stringify({
            schemaVersion: 2,
            tool: "backupdrill-cli",
            toolVersion: "test",
            createdAt: "2026-10-31T00:00:00.000Z",
            projectName: "grants",
            database: {
              serverVersion: "17.6",
              pgDumpVersion,
              schemas: SCHEMAS,
              tableCount: tables.length,
              estimatedRowTotal: 5,
              tables,
              extensions: [{ name: "pg_trgm", version: "1.6", schema: "public" }],
              ...(grants ? { grants } : {}),
            },
            dump: {
              key: "backupdrill/grants/snap/dump.pgcustom",
              format: "custom",
              bytes: buf.length,
              sha256: createHash("sha256").update(buf).digest("hex"),
            },
            storage: null,
          })
        );
      const config = { databaseUrl: sourceUrl, projectName: "grants", schemas: SCHEMAS, storage: { bucket: "unused" } };
      const restoreInto = (port, manifest) =>
        runRestore(config, { store: localStore(manifest, dumpPath, buf), targetDatabaseUrl: target(port), confirmTarget: "localhost" });

      // 1. Supabase 新默认:角色在,没有默认授权
      await sql(target(newDefaultsPort), ROLES);
      // 转储之后才加的列:记录里有,归档里没有,恢复要略过它而不是失败
      const withLateColumn = [
        ...source,
        { kind: "column", schema: "public", name: "notes", column: "added_later", privileges: { anon: ["SELECT"] } },
      ];
      const newDefaults = await restoreInto(newDefaultsPort, manifestWith(withLateColumn));
      assert.equal(newDefaults.databaseVerified, true);
      assert.match(newDefaults.databaseChecks.find((c) => c.name === "API grants").detail, /as it was at backup time/);
      assert.deepEqual(await grantsOf(target(newDefaultsPort)), source);
      // 扩展自带的函数不碰
      const similarity = await sql(
        target(newDefaultsPort),
        "select proacl from pg_proc where proname = 'similarity' and pronamespace = 'public'::regnamespace"
      );
      assert.equal(similarity.rows[0].proacl, null);

      // 2. 还没切换的老项目:默认授权会把 audit_log 开放出去,恢复要把它关回去
      await sql(target(oldDefaultsPort), `${ROLES} ${OLD_SUPABASE_DEFAULTS}`);
      await restoreInto(oldDefaultsPort, manifestWith(source));
      assert.deepEqual(await grantsOf(target(oldDefaultsPort)), source);

      // 3. 旧快照(没有记录):public 按 Supabase 以前的默认授权补,自定义 schema 不碰
      await sql(target(legacyPort), ROLES);
      const legacy = await restoreInto(legacyPort, manifestWith(undefined));
      assert.match(legacy.databaseChecks.find((c) => c.name === "API grants").detail, /old default access/);
      const legacyGrants = await grantsOf(target(legacyPort));
      // 旧快照不碰 schema:目标的 public 照旧
      assert.deepEqual(find(legacyGrants, "schema", undefined, { schema: "public" }).privileges.anon, ["USAGE"]);
      const all = ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"];
      for (const name of ["notes", "audit_log", "User Profiles", "note_ids"]) {
        assert.deepEqual(find(legacyGrants, "table", name).privileges.anon, all, name);
      }
      assert.deepEqual(find(legacyGrants, "sequence", "notes_id_seq").privileges.authenticated, ["SELECT", "UPDATE", "USAGE"]);
      assert.deepEqual(find(legacyGrants, "routine", "admin_only").privileges.anon, ["EXECUTE"]);
      assert.deepEqual(find(legacyGrants, "table", "things").privileges, {});

      // 4. 演练沙箱:角色由桩预建,走同一段代码,结果一样
      await installSandboxShim(target(sandboxPort), { authFunctions: true });
      await sql(target(sandboxPort), "create extension pg_trgm schema public");
      const drill = await restoreDatabaseArtifact({
        dumpPath,
        connString: target(sandboxPort),
        target: "sandbox",
        dumpedSchemas: SCHEMAS,
        grants: { schemas: SCHEMAS, recorded: source },
      });
      assert.equal(drill.ok, true, JSON.stringify(drill.postData));
      assert.equal(drill.grants.mode, "recorded");
      assert.deepEqual(await grantsOf(target(sandboxPort)), source);
    } finally {
      await Promise.all(ids.map((id) => x("docker", ["rm", "-f", id]).catch(() => {})));
      rmSync(work, { recursive: true, force: true });
    }
  }
);

test("grantStatements: revoke first, column grants last, unknown roles and MAINTAIN dropped where unsupported", () => {
  const statements = grantStatements(
    [
      { kind: "column", schema: "public", name: "t", column: 'a"b', privileges: { anon: ["SELECT"] } },
      { kind: "table", schema: "public", name: "t", privileges: { anon: ["SELECT", "MAINTAIN"], service_role: ["SELECT"] } },
      { kind: "routine", schema: "public", name: "f", args: "x integer", privileges: { PUBLIC: ["EXECUTE"] } },
      { kind: "schema", schema: "api", privileges: { anon: ["USAGE"] } },
    ],
    { roles: ["PUBLIC", "anon"], maintain: false }
  );
  assert.deepEqual(statements, [
    'revoke all on table "public"."t" from public, "anon"',
    'grant select on table "public"."t" to "anon"',
    'revoke all on routine "public"."f"(x integer) from public, "anon"',
    'grant execute on routine "public"."f"(x integer) to public',
    'revoke all on schema "api" from public, "anon"',
    'grant usage on schema "api" to "anon"',
    'grant select ("a""b") on table "public"."t" to "anon"',
  ]);
});

test("manifest: grants entries are validated before anything is restored", () => {
  const base = {
    tool: "backupdrill-cli",
    toolVersion: "test",
    createdAt: "2026-10-31T00:00:00.000Z",
    projectName: "p",
    database: { serverVersion: "17.6", pgDumpVersion: "pg_dump (PostgreSQL) 17.6", schemas: ["public"], tableCount: 0, estimatedRowTotal: 0, tables: [] },
    dump: { key: "k", format: "custom", bytes: 1, sha256: "s" },
    storage: null,
  };
  const withGrants = (grants) => JSON.stringify({ ...base, database: { ...base.database, grants } });
  assert.doesNotThrow(() => parseManifest(withGrants([{ kind: "table", schema: "public", name: "t", privileges: { anon: ["SELECT"] } }])));
  assert.doesNotThrow(() => parseManifest(withGrants([])));
  assert.throws(() => parseManifest(withGrants({})), /database\.grants/);
  assert.throws(() => parseManifest(withGrants([{ kind: "table", schema: "public", privileges: {} }])), /grants\[\]\.name/);
  assert.throws(
    () => parseManifest(withGrants([{ kind: "table", schema: "public", name: "t", privileges: { postgres: ["SELECT"] } }])),
    /unknown role/
  );
  assert.throws(
    () => parseManifest(withGrants([{ kind: "table", schema: "public", name: "t", privileges: { anon: ["SELECT; drop table x"] } }])),
    /unknown privilege/
  );
  assert.throws(() => parseManifest(withGrants([{ kind: "routine", schema: "public", name: "f", privileges: {} }])), /args/);
});

test("recoveryGrantsSql: exact statements when the snapshot recorded grants, Supabase's old defaults when it didn't", () => {
  const recorded = recoveryGrantsSql([{ kind: "table", schema: "public", name: "t", privileges: { anon: ["SELECT"] } }]);
  assert.equal(
    recorded,
    'revoke all on table "public"."t" from public, "anon", "authenticated", "service_role";\n' +
      'grant select on table "public"."t" to "anon";'
  );
  assert.match(recoveryGrantsSql(undefined), /^grant all on all tables in schema public to anon, authenticated, service_role;/);
  assert.match(recoveryGrantsSql([]), /nothing to grant/);
});

test(
  "restoreGrants: a GRANT that only warns (the restoring role doesn't own the object) fails instead of passing silently",
  { skip: canRun ? false : "requires Docker", timeout: 120_000 },
  async () => {
    const ids = [];
    try {
      const port = await startPostgres(ids);
      const admin = `postgresql://postgres:pw@127.0.0.1:${port}/postgres`;
      await sql(
        admin,
        `${ROLES}
         create role restorer login password 'pw';
         create table public.t (id int);
         -- 有一点权限、但不是属主:GRANT/REVOKE 只给 WARNING
         grant select on public.t to restorer;
         grant all on public.t to anon;`
      );
      const asRestorer = `postgresql://restorer:pw@127.0.0.1:${port}/postgres`;
      await assert.rejects(
        withClient(asRestorer, (client) => restoreGrants(client, { schemas: ["public"], recorded: [] })),
        /didn't take effect on .*table public\.t/
      );
      await assert.rejects(
        withClient(asRestorer, (client) => revokeApiAccess(client, ["public"])),
        /didn't take effect/
      );
      // 属主自己来就能收走
      await withClient(admin, (client) => revokeApiAccess(client, ["public"]));
      const after = await withClient(admin, (client) => captureGrants(client, ["public"]));
      assert.deepEqual(find(after, "table", "t").privileges, {});
    } finally {
      await Promise.all(ids.map((id) => x("docker", ["rm", "-f", id]).catch(() => {})));
    }
  }
);
