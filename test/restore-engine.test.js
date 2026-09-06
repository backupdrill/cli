import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBlocks,
  finalizePass,
  SANDBOX_MANAGED_ERROR,
  SCHEMA_EXISTS_ERROR,
} from "../dist/restore-engine.js";
import { sameDatabaseTarget } from "../dist/restore.js";

// ── 分类器:夹具取自 R0 spike 对真实 Supabase 目标的 pg_restore stderr ──

// spike 尝试 C(不带 --clean 打空目标)实录:dump 自带 CREATE SCHEMA,目标恒有 public
const SCHEMA_CONFLICT = `pg_restore: error: could not execute query: ERROR:  schema "public" already exists
Command was: CREATE SCHEMA public;
`;

// spike 尝试 C 实录:真冲突(非空目标)
const REAL_CONFLICT = `pg_restore: error: could not execute query: ERROR:  function "touch_created_at" already exists with same argument types
Command was: CREATE FUNCTION public.touch_created_at() RETURNS trigger
`;

test("pre-data allowlist:schema already exists 是预期冲突,其余 already exists 是真失败", () => {
  const onlySchema = classifyBlocks(SCHEMA_CONFLICT, SCHEMA_EXISTS_ERROR);
  assert.equal(onlySchema.expectedSkips, 1);
  assert.equal(onlySchema.failures.length, 0);

  const mixed = classifyBlocks(SCHEMA_CONFLICT + REAL_CONFLICT, SCHEMA_EXISTS_ERROR);
  assert.equal(mixed.expectedSkips, 1);
  assert.equal(mixed.failures.length, 1);
  assert.match(mixed.failures[0], /touch_created_at/);
});

test("真实 Supabase 目标的 post-data 零豁免:沙箱 allowlist 不适用", () => {
  const roleError =
    'pg_restore: error: could not execute query: ERROR:  role "authenticated" does not exist\nCommand was: CREATE POLICY x;\n';
  // 沙箱:角色缺席 = 环境预期
  const sandbox = classifyBlocks(roleError, SANDBOX_MANAGED_ERROR);
  assert.equal(sandbox.expectedSkips, 1);
  // 真实目标角色恒在,同样的错误只能是真问题 → NEVER_MATCH 语义用排除法钉住:
  // classifyBlocks 对不匹配 allowlist 的块一律入 failures
  const supabase = classifyBlocks(roleError, /(?!)/);
  assert.equal(supabase.expectedSkips, 0);
  assert.equal(supabase.failures.length, 1);
});

// ── finalizePass:R0 假成功回归钉子(替代已删除的 pgRestoreOutcome 用例)──

test("非零退出且零错误块 → 通用失败(signal kill / 非英文 locale / 空 stderr)", () => {
  const killed = finalizePass(null, "", { expectedSkips: 0, failures: [] });
  assert.match(killed.failures[0], /signal/);

  const german = finalizePass(1, "pg_restore: Fehler: Verbindung fehlgeschlagen", {
    expectedSkips: 0,
    failures: [],
  });
  assert.match(german.failures[0], /code 1/);
  assert.match(german.failures[0], /Fehler/);

  const empty = finalizePass(2, "", { expectedSkips: 0, failures: [] });
  assert.match(empty.failures[0], /code 2.*no stderr/);
});

test("非零退出但全部错误已归类 → 不追加通用失败;退出 0 原样通过", () => {
  const explained = finalizePass(1, "…", { expectedSkips: 2, failures: [] });
  assert.equal(explained.failures.length, 0);
  const clean = finalizePass(0, "", { expectedSkips: 0, failures: [] });
  assert.equal(clean.failures.length, 0);
});

// 评审第 7 轮的假成功路径:真实目标恒有 1 个预期 schema 跳过,若跳过能抵扣
// 信号死亡,中途被杀的半截恢复会被报成功。信号 = 无条件失败。
test("被信号杀死时,已有 expectedSkips 也不能抵扣 → 仍然失败", () => {
  const killed = finalizePass(null, "…partial…", { expectedSkips: 1, failures: [] });
  assert.equal(killed.failures.length, 1);
  assert.match(killed.failures[0], /killed by a signal/);
});

// ── 同源阻断(纯函数)──────────────────────────────────────────────

test("sameDatabaseTarget:pooler 主机区域共享,host+user 都同才算同一租户", () => {
  const src = "postgresql://postgres.aaaa:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  const sameTenant = "postgresql://postgres.aaaa:other@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  const otherTenant = "postgresql://postgres.bbbb:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  assert.equal(sameDatabaseTarget(src, sameTenant), true);
  // 同区 pooler、不同项目:host 相同但租户不同,绝不能误伤(合法恢复的主形态)
  assert.equal(sameDatabaseTarget(src, otherTenant), false);
  assert.equal(sameDatabaseTarget(src, "postgresql://postgres.aaaa:pw@db.aaaa.supabase.co:5432/postgres"), false);
  // 解析不了 → false,交给 pg 报连接错误,不在这里误杀
  assert.equal(sameDatabaseTarget("not a url", src), false);
});

// ── projectRefOf / 同租户识别(直连与 pooler 形态互认)──────────────

test("projectRefOf:直连主机与 pooler 用户名都能提取 ref;非 Supabase 返回 null", async () => {
  const { projectRefOf } = await import("../dist/restore.js");
  assert.equal(projectRefOf("postgresql://postgres:pw@db.abcdefghij0123456789.supabase.co:5432/postgres"), "abcdefghij0123456789");
  assert.equal(projectRefOf("postgresql://postgres.abcdefghij0123456789:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres"), "abcdefghij0123456789");
  assert.equal(projectRefOf("postgresql://user:pw@localhost:5432/db"), null);
});

test("projectRefOf:任意角色的 pooler 用户名(<role>.<ref>)都按最后一段提取 ref;非 pooler 主机不认", async () => {
  const { projectRefOf } = await import("../dist/restore.js");
  const ref = "abcdefghij0123456789";
  assert.equal(projectRefOf(`postgresql://backupdrill_ab12cd34ef56.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), ref);
  // Supavisor 在最后一个点切租户:大写 / 连字符 / 带点的角色名都是合法租户身份
  assert.equal(projectRefOf(`postgresql://Backup.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), ref);
  assert.equal(projectRefOf(`postgresql://backup-role.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), ref);
  assert.equal(projectRefOf(`postgresql://svc.reader.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), ref);
  // 同样形状的用户名落在非 Supabase 主机上不是租户身份
  assert.equal(projectRefOf(`postgresql://backup_reader.${ref}:pw@db.internal.example:5432/postgres`), null);
  assert.equal(projectRefOf(`postgresql://postgres.${ref}:pw@db.internal.example:5432/postgres`), null);
});

test("sameDatabaseTarget:免密接入的角色串与用户手输的 postgres 串指向同一项目 → 同源保护必须认得出", () => {
  const ref = "abcdefghij0123456789";
  const roleSource = `postgresql://backupdrill_ab12cd34ef56.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  const postgresTarget = `postgresql://postgres.${ref}:pw2@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  const otherProject = `postgresql://postgres.zyxwvutsrq9876543210:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.equal(sameDatabaseTarget(roleSource, postgresTarget), true);
  assert.equal(sameDatabaseTarget(roleSource, otherProject), false);
  const upperRoleSource = `postgresql://Backup-Reader.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.equal(sameDatabaseTarget(upperRoleSource, postgresTarget), true);
});

test("assertNoHostOverride:pooler 主机上任何 ?options= 都拒(含双重编码/大小写);非 pooler 主机的 options 放行", async () => {
  const { assertNoHostOverride } = await import("../dist/restore.js");
  const ref = "abcdefghij0123456789";
  const other = "zyxwvutsrq9876543210";
  const pooler = `postgresql://svc.reader.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.throws(() => assertNoHostOverride(`${pooler}?options=reference%3D${other}`), /options/);
  // 双重编码:URL 层解一次得 %72eference,Supavisor 再解一次得 reference —— 不追它的解析器,整参数拒绝
  assert.throws(() => assertNoHostOverride(`${pooler}?options=%2572eference%3D${other}`), /options/);
  assert.throws(() => assertNoHostOverride(`${pooler}?OPTIONS=-c%20statement_timeout%3D0`), /options/);
  assert.throws(() => assertNoHostOverride(`${pooler}?options=-c%20application_name%3Dreference%3Dbackup`), /options/);
  // 编码过的 pooler 主机同样按解码后判定
  assert.throws(() => assertNoHostOverride(`postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase%2Ecom:5432/postgres?options=reference%3D${other}`), /options/);
  assert.doesNotThrow(() => assertNoHostOverride(pooler));
  // 普通 Postgres 目标:options 没有租户语义,连 "reference" 这个词也不应误伤
  const plain = `postgresql://app:pw@db.example.com:5432/app`;
  assert.doesNotThrow(() => assertNoHostOverride(`${plain}?options=-c%20application_name%3Dreference%3Dbackup`));
  assert.doesNotThrow(() => assertNoHostOverride(`${plain}?options=-c%20statement_timeout%3D0`));
});

test("projectRefOf / assertNoHostOverride:解码后含 NUL 的用户名不认、且被拒(启动包字段注入)", async () => {
  const { projectRefOf, assertNoHostOverride } = await import("../dist/restore.js");
  const source = "abcdefghij0123456789";
  const target = "zyxwvutsrq9876543210";
  const smuggled = `postgresql://postgres%00options%00reference%3D${source}%00application_name%00.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.equal(projectRefOf(smuggled), null);
  assert.throws(() => assertNoHostOverride(smuggled), /NUL/);
  assert.throws(() => assertNoHostOverride(`postgresql://postgres.${target}:p%00w@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), /NUL/);
  // query 值 / 路径里的 NUL 同样是启动包注入
  const viaQuery = `postgresql://postgres.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?application_name=x%00user%00postgres%00options%00reference%3D${source}`;
  assert.throws(() => assertNoHostOverride(viaQuery), /NUL/);
  assert.equal(projectRefOf(viaQuery), null);
  assert.throws(() => assertNoHostOverride(`postgresql://postgres.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres%00x`), /NUL/);
  assert.doesNotThrow(() => assertNoHostOverride(`postgresql://postgres.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`));
  // WHATWG URL 解析不了、pg 却接受的形态(空主机 + ?host=):不能放行,身份判定为空
  assert.throws(() => assertNoHostOverride("postgresql://postgres.cluster.alias@/postgres?host=aws-0-us-east-1.pooler.supabase.com"), /parsed|override/);
  assert.throws(() => assertNoHostOverride("host=aws-0-us-east-1.pooler.supabase.com user=postgres"), /parsed/);
  // 非法百分号编码:pg 会部分解码(%75→u),按原样看会漏掉 .cluster. —— 解不开就拒
  assert.throws(() => assertNoHostOverride(`postgresql://role%GG.cl%75ster.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), /percent-encoding/);
  assert.equal(projectRefOf(`postgresql://role%GG.cl%75ster.${target}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), null);
});

test("Supavisor 的 <user>.cluster.<alias> 保留语法:不当 ref,且连接在 I/O 前被拒;大写 CLUSTER 是普通角色", async () => {
  const { projectRefOf, assertNoHostOverride } = await import("../dist/restore.js");
  const ref = "abcdefghijklmnopqrst";
  const pooler = "aws-0-us-east-1.pooler.supabase.com";
  const alias = `postgresql://postgres.cluster.${ref}:pw@${pooler}:5432/postgres`;
  const dottedAlias = `postgresql://postgres.cluster.alias.${ref}:pw@${pooler}:5432/postgres`;
  assert.equal(projectRefOf(alias), null);
  assert.equal(projectRefOf(dottedAlias), null);
  assert.throws(() => assertNoHostOverride(alias), /cluster/);
  assert.throws(() => assertNoHostOverride(dottedAlias), /cluster/);
  // Supavisor 只认小写 .cluster.:大写是普通角色名,身份照常
  const upper = `postgresql://postgres.CLUSTER.${ref}:pw@${pooler}:5432/postgres`;
  assert.equal(projectRefOf(upper), ref);
  assert.doesNotThrow(() => assertNoHostOverride(upper));
  // 非 pooler 主机上 ".cluster." 没有特殊含义
  assert.doesNotThrow(() => assertNoHostOverride(`postgresql://app.cluster.x:pw@db.example.com:5432/app`));
});

test("projectRefOf:角色名含编码换行(加引号的 Postgres 角色可以)也按最后一段取 ref", async () => {
  const { projectRefOf } = await import("../dist/restore.js");
  const ref = "abcdefghij0123456789";
  assert.equal(projectRefOf(`postgresql://svc%0Areader.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`), ref);
});

test("projectRefOf / sameDatabaseTarget:百分号编码的主机名按驱动语义解码后判定(%2E 不得绕过同源保护)", async () => {
  const { projectRefOf } = await import("../dist/restore.js");
  const ref = "abcdefghij0123456789";
  const encodedPooler = `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase%2Ecom:5432/postgres`;
  const encodedDirect = `postgresql://postgres:pw@db.${ref}.supabase%2Eco:5432/postgres`;
  const plain = `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.equal(projectRefOf(encodedPooler), ref);
  assert.equal(projectRefOf(encodedDirect), ref);
  assert.equal(sameDatabaseTarget(encodedPooler, plain), true);
  assert.equal(sameDatabaseTarget(encodedPooler, encodedPooler), true);
});

test("sameDatabaseTarget:源直连、目标 pooler 的同一项目 → 阻断(host/user 都不同也认得出)", () => {
  const direct = "postgresql://postgres:pw@db.abcdefghij0123456789.supabase.co:5432/postgres";
  const pooled = "postgresql://postgres.abcdefghij0123456789:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  const otherPooled = "postgresql://postgres.zzzzzzzzzz9876543210:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  assert.equal(sameDatabaseTarget(direct, pooled), true);
  assert.equal(sameDatabaseTarget(direct, otherPooled), false);
});

test("pg_restore 的连接串经 dumpUrlFor:Supabase 主机 verify-full+CA,沙箱透传,密码仍出 argv", async () => {
  const { credentialSafeDbArgs } = await import("../dist/restore-engine.js");
  const { dumpUrlFor } = await import("../dist/supabase-ca.js");
  const pooler = "postgresql://postgres.abcdefghij0123456789:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";
  const { url, env } = credentialSafeDbArgs(dumpUrlFor(pooler));
  assert.ok(url.includes("sslmode=verify-full"), "Supabase 主机必须 verify-full");
  assert.ok(url.includes("sslrootcert="), "必须带打包 CA 路径");
  assert.ok(!url.includes("pw"), "密码不进 argv");
  assert.equal(env.PGPASSWORD, "pw");
  const sandbox = credentialSafeDbArgs(dumpUrlFor("postgresql://postgres:drill@127.0.0.1:54321/postgres"));
  assert.ok(!sandbox.url.includes("sslrootcert"), "非 Supabase 主机不套 CA");
});

test("libpqChildEnv:只剔除改写目标/身份的 PG* 变量;TLS 策略、超时、PGPASSWORD 保留;PGOPTIONS 只在 Supabase 主机剔除", async () => {
  const { libpqChildEnv } = await import("../dist/restore-engine.js");
  const base = {
    PATH: "/usr/bin", HOME: "/h",
    PGHOST: "evil", PGHOSTADDR: "1.2.3.4", PGPORT: "65432", PGDATABASE: "evil", PGUSER: "evil",
    PGPASSFILE: "/x", PGSERVICE: "s", PGSERVICEFILE: "/sf", PGTARGETSESSIONATTRS: "any",
    PGOPTIONS: "reference=evil",
    PGSSLMODE: "require", PGSSLROOTCERT: "/ca.pem", PGCONNECT_TIMEOUT: "10", PGAPPNAME: "x", PGPASSWORD: "envpw",
  };
  const plain = libpqChildEnv({}, { supabaseHost: false }, base);
  for (const k of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGTARGETSESSIONATTRS"]) {
    assert.equal(plain[k], undefined, `${k} should be stripped`);
  }
  // 不改目标的变量保留:外部 Postgres 靠 PGSSLMODE=require 上 TLS,不能被降级成 prefer
  assert.equal(plain.PGSSLMODE, "require");
  assert.equal(plain.PGSSLROOTCERT, "/ca.pem");
  assert.equal(plain.PGCONNECT_TIMEOUT, "10");
  assert.equal(plain.PGAPPNAME, "x");
  assert.equal(plain.PGPASSWORD, "envpw");
  assert.equal(plain.PATH, "/usr/bin");
  // 非 Supabase 主机:Node 侧也读 PGOPTIONS,子进程同样保留 → 两边一致
  assert.equal(plain.PGOPTIONS, "reference=evil");
  // Supabase 主机:Node 侧已钉死 options,子进程剔除 PGOPTIONS → 两边一致
  const supa = libpqChildEnv({}, { supabaseHost: true }, base);
  assert.equal(supa.PGOPTIONS, undefined);
  assert.equal(supa.PGSSLMODE, "require");
  // 显式给的覆盖环境
  assert.equal(libpqChildEnv({ PGPASSWORD: "explicit" }, { supabaseHost: true }, base).PGPASSWORD, "explicit");
});
