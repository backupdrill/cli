// checkExternalReferences 在真实 Postgres 上的边角(交叉审查 2026-10-23 第一轮逐条复现的形态):
//  - 被引用的表由扩展创建:dry-run 时扩展还没装,不能当成 blocker;装上之后要真查;
//  - 一条外键在目标端查询出错,不能把另一条外键已经确认的缺行吞掉;
//  - 比较按引用方列的类型(外键自己的比较),不按被引用列的类型(第二轮:float8 → float4);
//  - 目标端的查询都在只读事务里,比较时调到的函数想写也写不进去(第二轮);
//  - 用外键自己的相等运算符(唯一索引的运算符族里找,带 schema):citext 不在 search_path 上也按 citext 比(推送前审查);
//  - 同一张表上两条外键同一批次攒满时一个接一个查,一条报错不连累另一条(推送前审查);
//  - 带引号的名字里有换行,COPY 头跨行,不能静默跳过整块数据报"全找到了";
//  - 目标列带类型修饰符(numeric(2,0)),比较时不能把 1.1 转成 1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { checkExternalReferences } from "../dist/external-refs.js";

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
  // 数据目录放 tmpfs,不建匿名卷(drill.test.js 会数整台机器上新冒出来的匿名卷)
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
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  // 一个自带表的扩展:建 lookup(id) 并放两行,模拟"被引用的表是扩展建的"
  await x("docker", ["exec", "-u", "root", id, "sh", "-c",
    "d=$(pg_config --sharedir)/extension; " +
    "printf \"default_version = '1.0'\\nrelocatable = false\\n\" > $d/bdtest_lookup.control; " +
    "printf 'create table lookup (id int primary key);\\ninsert into lookup values (1), (2);\\n' > $d/bdtest_lookup--1.0.sql"]);
  return { id, url: `postgresql://postgres:pw@127.0.0.1:${port}/postgres` };
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

test(
  "checkExternalReferences: extension tables, per-FK failures, multi-line COPY headers, type modifiers",
  { skip: canRun ? false : "requires Docker + pg_dump", timeout: 180_000 },
  async () => {
    const ids = [];
    const work = mkdtempSync(join(tmpdir(), "bd-refs-edge-"));
    try {
      const [source, target] = await Promise.all([startPostgres(ids), startPostgres(ids)]);
      await sql(
        source.url,
        `create schema auth;
         create table auth.users (id uuid primary key);
         insert into auth.users values ('00000000-0000-0000-0000-000000000001');
         create table public.profiles (id uuid primary key references auth.users(id));
         insert into public.profiles values ('00000000-0000-0000-0000-000000000001');
         -- 被引用的表是扩展建的
         create schema ext_lookup;
         create extension bdtest_lookup schema ext_lookup;
         create table public.uses_lookup (lookup_id int references ext_lookup.lookup(id));
         insert into public.uses_lookup values (1), (2);
         -- 目标端这张表的列是 int4:按引用方的 bigint 比较(int8 = int4),找不到这一行,外键会失败
         create table auth.big (id bigint primary key);
         insert into auth.big values (30000000000);
         create table public.uses_big (big_id bigint references auth.big(id));
         insert into public.uses_big values (30000000000);
         -- 名字里带换行:COPY 头跨行
         create table public."multi
line" ("user
id" uuid references auth.users(id));
         insert into public."multi
line" values ('00000000-0000-0000-0000-000000000001');
         -- 类型修饰符:目标端是 numeric(2,0),1.1 不能被当成 1
         create table auth.codes (code numeric(3,1) primary key);
         insert into auth.codes values (1.1);
         create table public.uses_code (code numeric(3,1) references auth.codes(code));
         insert into public.uses_code values (1.1);
         -- 跨类型:引用方 float8;目标端被引用列是 float4,按引用方类型比较才是外键的比较
         create table auth.f (id double precision primary key);
         insert into auth.f values (1.23456789);
         create table public.uses_f (v double precision references auth.f(id));
         insert into public.uses_f values (1.23456789);
         -- 引用方列的类型是另一个 schema 里的域,域 CHECK 会调一个写审计表的函数(目标端也有):只读事务必须挡住写
         create schema types;
         create table types.audit (v text);
         create function types.log(v text) returns boolean language plpgsql as $f$ begin insert into types.audit values (v); return true; end $f$;
         create domain types.code as text check (types.log(value));
         create table auth.codes2 (code text primary key);
         insert into auth.codes2 values ('a');
         create table public.uses_dom (c types.code references auth.codes2(code));
         insert into public.uses_dom values ('a');
         -- citext 装在 extensions(不在 search_path 上):得用 citext 自己的相等,ALICE 和 alice 是同一个键
         create schema extensions;
         create extension citext schema extensions;
         create table auth.emails (email extensions.citext primary key);
         insert into auth.emails values ('alice');
         create table public.uses_ci (email extensions.citext references auth.emails(email));
         insert into public.uses_ci values ('ALICE');
         -- 同一张表上两条外键,同一批次一起攒满(> 5000 个键);其中一条在目标上比较会报错
         insert into auth.users select gen_random_uuid() from generate_series(1, 6000);
         insert into auth.codes2 select 'k' || g from generate_series(1, 6000) g;
         create table public.pairs (u uuid references auth.users(id), c types.code references auth.codes2(code));
         insert into public.pairs
           select u.id, 'k' || u.n from (select id, row_number() over () as n from auth.users
                                          where id <> '00000000-0000-0000-0000-000000000001') u;
         -- 引用方列的类型建在备份的 schema 里:恢复之前目标上没有,只能报没查成
         create domain public.uid as uuid;
         create table public.uses_uid (u public.uid references auth.users(id));
         insert into public.uses_uid values ('00000000-0000-0000-0000-000000000001');`
      );
      const dumpPath = join(work, "edge.pgcustom");
      await x(pgDump, ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--dbname", source.url, "-f", dumpPath]);

      // 目标:auth.users 空(profiles 和 multi-line 两条都缺行);auth.big 的列是 int4;auth.codes 是 numeric(2,0) 存着 1;
      // 扩展的文件在,但还没 create extension
      await sql(
        target.url,
        `create schema auth;
         create table auth.users (id uuid primary key);
         create table auth.big (id int primary key);
         create table auth.codes (code numeric(2,0) primary key);
         insert into auth.codes values (1);
         create table auth.f (id real primary key);
         insert into auth.f values (1.23456789);
         create schema types;
         create table types.audit (v text);
         create function types.log(v text) returns boolean language plpgsql as $f$ begin insert into types.audit values (v); return true; end $f$;
         create domain types.code as text check (types.log(value));
         -- 被引用列上唯一索引的运算符类:它的 = 和比较函数每调用一次都想往审计表里写一行
         -- (顺序扫描调 =,索引扫描调比较函数,哪种计划都躲不开)。比较必须在只读事务里
         create function types.eq_logged(a text, b text) returns boolean language plpgsql
           as $f$ begin insert into types.audit values (a); return a = b; end $f$;
         create operator types.= (leftarg = text, rightarg = text, function = types.eq_logged);
         create function types.cmp_logged(a text, b text) returns int language plpgsql
           as $f$ begin insert into types.audit values (a); return bttextcmp(a, b); end $f$;
         create operator class types.logged_ops for type text using btree as
           operator 1 pg_catalog.<, operator 2 pg_catalog.<=, operator 3 types.=,
           operator 4 pg_catalog.>=, operator 5 pg_catalog.>, function 1 types.cmp_logged(text, text);
         create table auth.codes2 (code text);
         create unique index on auth.codes2 (code types.logged_ops);
         insert into auth.codes2 values ('a');
         truncate types.audit;
         create schema extensions;
         create extension citext schema extensions;
         create table auth.emails (email extensions.citext primary key);
         insert into auth.emails values ('alice');`
      );
      const check = (extra = {}) =>
        checkExternalReferences({ dumpPath, dumpedSchemas: ["public"], targetUrl: target.url, ...extra });

      const dry = await check({ pendingExtensionSchemas: ["ext_lookup"] });
      const text = (list) => list.join("\n");
      // 扩展建的表:dry-run 时只报"装完扩展才能查",不拦
      assert.match(text(dry.unchecked), /public\.uses_lookup → ext_lookup\.lookup .*isn't on the target yet/);
      assert.doesNotMatch(text(dry.problems), /uses_lookup/);
      // bigint 引用 int4:跨类型照外键的比较来,30000000000 在目标上没有
      assert.match(text(dry.problems), /public\.uses_big → auth\.big .*: 1 of 1 row\(s\)/);
      // 一条外键在目标端比较出错(下面 uses_dom 的只读报错),别的外键已经确认的缺行照样是 blocker
      assert.match(text(dry.problems), /public\.profiles → auth\.users \(profiles_id_fkey\): 1 of 1 row\(s\)/);
      // 跨行的 COPY 头读出来了,缺行照报
      assert.match(text(dry.problems), /public\."multi\nline" → auth\.users [\s\S]*?: 1 of 1 row\(s\)/);
      // numeric(2,0) 不会把 1.1 变成 1
      assert.match(text(dry.problems), /public\.uses_code → auth\.codes .*: 1 of 1 row\(s\)/);
      // float8 的 1.23456789 不等于 float4 存下来的 1.2345679:外键会失败,检查也要报缺
      assert.match(text(dry.problems), /public\.uses_f → auth\.f .*: 1 of 1 row\(s\)/);
      // 索引运算符的 = 想写审计表:只读事务挡住,这条外键报没查成,目标上什么都没写
      assert.match(text(dry.unchecked), /public\.uses_dom → auth\.codes2 .*could not compare its rows on the target \(.*read-only transaction/);
      const audit = await sql(target.url, "select count(*)::int as n from types.audit");
      assert.equal(audit.rows[0].n, 0, "the check must not write to the target");
      // citext:按外键的运算符(extensions.=)比,大小写不同也找得到
      const ci = dry.checked.find((c) => c.fk.constraint === "uses_ci_email_fkey");
      assert.ok(ci, `uses_ci should be checked; unchecked: ${text(dry.unchecked)}; problems: ${text(dry.problems)}`);
      assert.equal(ci.missingRows, 0);
      // pairs 上两条外键同一批次攒满:c 那条报错只影响它自己,u 那条 6000 行缺 6000 行照报
      assert.match(text(dry.problems), /public\.pairs → auth\.users \(pairs_u_fkey\): 6,000 of 6,000 row\(s\)/);
      assert.match(text(dry.unchecked), /public\.pairs → auth\.codes2 \(pairs_c_fkey\): could not compare its rows on the target/);
      // 引用方类型在恢复之前不存在
      assert.match(text(dry.unchecked), /public\.uses_uid → auth\.users .*uses type public\.uid, which is missing on the target/);

      // 不告诉它扩展待装时,表不在就是 blocker
      const strict = await check();
      assert.match(text(strict.problems), /ext_lookup\.lookup does not exist on the target/);

      // 扩展装上之后(正式恢复的顺序),这条外键能查,两行都找得到
      await sql(target.url, "create schema ext_lookup; create extension bdtest_lookup schema ext_lookup;");
      const afterInstall = await check();
      const lookup = afterInstall.checked.find((c) => c.fk.constraint === "uses_lookup_lookup_id_fkey");
      assert.ok(lookup, `checked: ${afterInstall.checked.map((c) => c.fk.constraint)}`);
      assert.equal(lookup.rows, 2);
      assert.equal(lookup.missingRows, 0);
    } finally {
      for (const id of ids) await x("docker", ["rm", "-fv", id]).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
);
