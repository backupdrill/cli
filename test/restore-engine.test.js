import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyBlocks,
  finalizePass,
  sandboxShimSql,
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

// 沙箱有了 auth 桩之后,缺席的形态从 schema/role 级变成 relation/function 级(2026-09-11)
test("沙箱 allowlist:shim 之后的新形态(FK → auth.users、没桩的 auth 函数)是预期跳过", () => {
  const fkToAuthUsers =
    'pg_restore: error: could not execute query: ERROR:  relation "auth.users" does not exist\nCommand was: ALTER TABLE ONLY public.profile ADD CONSTRAINT profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);\n';
  const unstubbedFn =
    'pg_restore: error: could not execute query: ERROR:  function auth.something(uuid) does not exist\nCommand was: CREATE POLICY p ON t USING (auth.something(id));\n';
  // 签名带空格:多参数、多词类型(交叉审查复现:[^ ]+ 在第一个空格就断,整条变成真失败)
  const multiArg =
    'pg_restore: error: could not execute query: ERROR:  function auth.can_read(uuid, uuid) does not exist\nCommand was: CREATE POLICY p2 ON t USING (auth.can_read(a, b));\n';
  const multiWordType =
    'pg_restore: error: could not execute query: ERROR:  function auth.by_name(character varying) does not exist\nCommand was: CREATE POLICY p3 ON t USING (auth.by_name(n));\n';
  const r = classifyBlocks(fkToAuthUsers + unstubbedFn + multiArg + multiWordType, SANDBOX_MANAGED_ERROR);
  assert.equal(r.expectedSkips, 4);
  assert.equal(r.failures.length, 0);
  // extensions 里缺函数/表 = 扩展没装上或用户把自己的函数放进去了,必须是真失败:
  // 交叉审查复现过 UNIQUE 索引调 extensions.normalize_key(text) 被吞成跳过 → 缺索引却 PASS
  const extFn =
    'pg_restore: error: could not execute query: ERROR:  function extensions.normalize_key(text) does not exist\nCommand was: CREATE UNIQUE INDEX k ON public.t (extensions.normalize_key(v));\n';
  const extRel =
    'pg_restore: error: could not execute query: ERROR:  relation "extensions.lookup" does not exist\nCommand was: ALTER TABLE ONLY public.t ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES extensions.lookup(id);\n';
  const ext = classifyBlocks(extFn + extRel, SANDBOX_MANAGED_ERROR);
  assert.equal(ext.expectedSkips, 0);
  assert.equal(ext.failures.length, 2);
  // 用户自己 schema 里的缺表绝不能被这条规则吞掉
  const userTable =
    'pg_restore: error: could not execute query: ERROR:  relation "public.orders" does not exist\nCommand was: ALTER TABLE ONLY public.items ADD CONSTRAINT fk FOREIGN KEY (o) REFERENCES public.orders(id);\n';
  const u = classifyBlocks(userTable, SANDBOX_MANAGED_ERROR);
  assert.equal(u.expectedSkips, 0);
  assert.equal(u.failures.length, 1);
});

// 转储自带 auth(BACKUPDRILL_SCHEMAS=public,auth)时不建函数桩,否则 pg_restore 的
// CREATE FUNCTION auth.uid() 撞 "already exists" 把本来能过的演练弄挂(交叉审查 2026-09-11)
test("sandboxShimSql:转储带 auth 就只建角色,不带才建 auth 函数桩", () => {
  const withFns = sandboxShimSql({ authFunctions: true });
  assert.match(withFns, /create schema if not exists auth/);
  assert.match(withFns, /function auth\.uid\(\)/);
  assert.match(withFns, /'anon', 'authenticated', 'service_role'/);
  const rolesOnly = sandboxShimSql({ authFunctions: false });
  assert.doesNotMatch(rolesOnly, /auth\.uid|create schema/);
  assert.match(rolesOnly, /'anon', 'authenticated', 'service_role'/);
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
  assert.throws(() => assertNoHostOverride("postgresql://postgres.cluster.alias@/postgres?host=aws-0-us-east-1.pooler.supabase.com"), /parsed|override|no host/);
  assert.throws(() => assertNoHostOverride("host=aws-0-us-east-1.pooler.supabase.com user=postgres"), /parsed/);
  // ?service= / ?servicefile=:libpq 从 pg_service.conf 整段加载 host/options,node-postgres 不认 → 拒绝
  assert.throws(() => assertNoHostOverride(`postgresql://app:pw@db.example.com/app?service=prod`), /service/);
  assert.throws(() => assertNoHostOverride(`postgresql://app:pw@aws-0-us-east-1.pooler.supabase.com/postgres?servicefile=%2Fetc%2Fpg_service.conf`), /servicefile/);
  // ?dbname= 覆盖:libpq 用它压过路径,node-postgres 不认 → 两个客户端连到不同的库 → 拒绝(含编码键)
  assert.throws(() => assertNoHostOverride(`postgresql://app:pw@db.example.com/app?dbname=postgres`), /dbname/);
  assert.throws(() => assertNoHostOverride(`postgresql://app:pw@db.example.com?%64bname=postgres`), /dbname/i);
  assert.throws(() => assertNoHostOverride(`postgresql://app:pw@db.example.com/app?DBNAME=postgres`), /dbname/i);
  // 空 authority:主机只能来自环境变量,Node 与子进程各自回退 → 拒绝
  assert.throws(() => assertNoHostOverride("postgresql:///postgres"), /no host/);
  // 带 userinfo 却空主机的形态 WHATWG 直接解析失败:同样是拒绝,只是文案不同
  assert.throws(() => assertNoHostOverride("postgresql://u:p@/postgres"), /no host|parsed/);
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
    PGPASSFILE: "/x", PGSERVICE: "s", PGSERVICEFILE: "/sf", PGSYSCONFDIR: "/etc/pg", PGTARGETSESSIONATTRS: "any",
    PGOPTIONS: "reference=evil",
    PGSSLMODE: "require", PGSSLROOTCERT: "/ca.pem", PGCONNECT_TIMEOUT: "10", PGAPPNAME: "x", PGPASSWORD: "envpw",
  };
  const plain = libpqChildEnv({}, base, { supabaseHost: false });
  for (const k of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR", "PGTARGETSESSIONATTRS"]) {
    assert.equal(plain[k], undefined, `${k} should be stripped`);
  }
  // PGPASSFILE 是密码来源不是目标:node-postgres 经 pgpass 也读它,保留才两边一致
  assert.equal(plain.PGPASSFILE, "/x");
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
  const supa = libpqChildEnv({}, base, { supabaseHost: true });
  assert.equal(supa.PGOPTIONS, undefined);
  assert.equal(supa.PGSSLMODE, "require");
  // 显式给的覆盖环境
  assert.equal(libpqChildEnv({ PGPASSWORD: "explicit" }, base, { supabaseHost: true }).PGPASSWORD, "explicit");
  // 既有的两参签名(extraEnv, base)不变:第三个参数缺省 = 非 Supabase 主机
  assert.equal(libpqChildEnv({}, base).PGOPTIONS, "reference=evil");
  assert.equal(libpqChildEnv({}, base).PGHOST, undefined);
  // node-postgres 独有的 no-verify 翻译成 libpq 认识的 require,并去掉会让 require 升级/拒连的证书变量
  const { NO_VERIFY_ROOTCERT_SENTINEL } = await import("../dist/restore-engine.js");
  const translated = libpqChildEnv({}, { PGSSLMODE: "no-verify", PGSSLROOTCERT: "system", PGSSLCRL: "/crl", PGSSLCRLDIR: "/crls", PGSSLCERT: "/c.pem" });
  assert.equal(translated.PGSSLMODE, "require");
  // 指向不存在的路径:libpq 在 require 下跳过验证且不再去找 ~/.postgresql/root.crt
  assert.equal(translated.PGSSLROOTCERT, NO_VERIFY_ROOTCERT_SENTINEL);
  assert.ok(!fs.existsSync(NO_VERIFY_ROOTCERT_SENTINEL));
  // 没有 PGSSLROOTCERT 的 no-verify 同样要设哨兵(默认发现 root.crt 也会升级成 verify-ca)
  assert.equal(libpqChildEnv({}, { PGSSLMODE: "no-verify" }).PGSSLROOTCERT, NO_VERIFY_ROOTCERT_SENTINEL);
  // URL 自带 sslmode(压过环境变量)时不翻译、不设哨兵:verify-full 还得靠 ~/.postgresql/root.crt
  const urlPinned = libpqChildEnv({}, { PGSSLMODE: "no-verify", PGSSLROOTCERT: "/ca.pem" }, { supabaseHost: false, urlSslMode: "verify-full" });
  assert.equal(urlPinned.PGSSLMODE, "no-verify");
  assert.equal(urlPinned.PGSSLROOTCERT, "/ca.pem");
  const { urlSslModeOf } = await import("../dist/restore-engine.js");
  assert.equal(urlSslModeOf("postgresql://u:p@h/db?sslmode=verify-full"), "verify-full");
  assert.equal(urlSslModeOf("postgresql://u:p@h/db"), null);
  assert.equal(urlSslModeOf("not a url"), null);
  // 重复参数取最后一个(libpq 与 pg 同);最后一个为空视同没写
  assert.equal(urlSslModeOf("postgresql://u:p@h/db?sslmode=&sslmode=verify-full"), "verify-full");
  // 末尾空 sslmode 在 normalizeConnectionTarget 已被拒绝,这里只保证取值函数不崩
  assert.equal(urlSslModeOf("postgresql://u:p@h/db?sslmode=verify-full&sslmode="), null);
  assert.equal(translated.PGSSLCRL, undefined);
  assert.equal(translated.PGSSLCRLDIR, undefined);
  assert.equal(translated.PGSSLCERT, "/c.pem"); // 客户端证书不影响"验不验服务器",保留
  // 其它 sslmode 原样,证书变量也原样
  const full = libpqChildEnv({}, { PGSSLMODE: "verify-full", PGSSLROOTCERT: "/ca.pem" });
  assert.equal(full.PGSSLMODE, "verify-full");
  assert.equal(full.PGSSLROOTCERT, "/ca.pem");
});
