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

test("sameDatabaseTarget:源直连、目标 pooler 的同一项目 → 阻断(host/user 都不同也认得出)", () => {
  const direct = "postgresql://postgres:pw@db.abcdefghij0123456789.supabase.co:5432/postgres";
  const pooled = "postgresql://postgres.abcdefghij0123456789:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  const otherPooled = "postgresql://postgres.zzzzzzzzzz9876543210:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  assert.equal(sameDatabaseTarget(direct, pooled), true);
  assert.equal(sameDatabaseTarget(direct, otherPooled), false);
});
