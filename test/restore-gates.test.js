import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertConfirmedTarget,
  refFromSupabaseUrl,
  validateStorageTargetOrigin,
  assertNoHostOverride,
  sourceProjectRefs,
  NO_SOURCE_DATABASE,
} from "../dist/restore.js";
import { bucketsToRestore, reconcileFiles } from "../dist/storage-restore.js";

const REF = "abcdefghij0123456789";
const POOLER = `postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const API = `https://${REF}.supabase.co`;

test("refFromSupabaseUrl:项目 URL 提取 ref;非 Supabase 域名返回 null", () => {
  assert.equal(refFromSupabaseUrl(API), REF);
  assert.equal(refFromSupabaseUrl("https://example.com"), null);
});

test("确认门:ref 一致放行;缺失/不符拒绝并给出正确的 ref 提示", () => {
  assert.doesNotThrow(() => assertConfirmedTarget(REF, POOLER, API));
  assert.throws(() => assertConfirmedTarget(undefined, POOLER, API), new RegExp(`--confirm-target ${REF}`));
  assert.throws(() => assertConfirmedTarget("wrong-ref", POOLER, API), new RegExp(`--confirm-target ${REF}`));
});

test("确认门:DB 与 API URL 指向不同项目 → 硬错(与确认无关)", () => {
  assert.throws(
    () => assertConfirmedTarget(REF, POOLER, "https://zzzzzzzzzz9876543210.supabase.co"),
    /different projects/
  );
});

test("确认门:非 Supabase 目标退回主机名确认;身份完全不可导出时拒绝", () => {
  const external = "postgresql://user:pw@db.internal.example:5432/app";
  assert.doesNotThrow(() => assertConfirmedTarget("db.internal.example", external, undefined));
  assert.throws(() => assertConfirmedTarget("wrong", external, undefined), /db\.internal\.example/);
  assert.throws(() => assertConfirmedTarget("x", undefined, "https://example.com"), /confirmable target/);
});

test("bucketsToRestore:manifest.buckets(含空桶)∪ files 里的桶;v1 无 buckets 也能推出", () => {
  const withAttrs = {
    storage: {
      buckets: [{ name: "avatars" }, { name: "empty-bucket" }],
      fileCount: 1,
      totalBytes: 1,
      files: [{ bucket: "legacy", key: "k", bytes: 1, sha256: "x" }],
    },
  };
  assert.deepEqual(bucketsToRestore(withAttrs), [
    { name: "avatars", attrs: true },
    { name: "empty-bucket", attrs: true },
    { name: "legacy", attrs: false },
  ]);
  const v1 = { storage: { fileCount: 1, totalBytes: 1, files: [{ bucket: "b", key: "k", bytes: 1, sha256: "x" }] } };
  assert.deepEqual(bucketsToRestore(v1), [{ name: "b", attrs: false }]);
});

test("Storage 目标 URL:只接受 https://<ref>.supabase.co 精确源(key 发出前校验)", () => {
  assert.equal(validateStorageTargetOrigin(`https://${REF}.supabase.co`), `https://${REF}.supabase.co`);
  assert.equal(validateStorageTargetOrigin(`https://${REF}.supabase.co/`), `https://${REF}.supabase.co`);
  for (const bad of [
    `http://${REF}.supabase.co`, // 明文
    "https://evil.example.com", // 任意主机
    `https://${REF}.supabase.co/path`, // 带路径
    `https://${REF}.supabase.co?x=1`, // 带查询
    `https://${REF}.supabase.co.evil.com`, // 后缀伪装
  ]) {
    assert.throws(() => validateStorageTargetOrigin(bad), /must be exactly https/, bad);
  }
});

test("目标连接串拒绝 ?host=/hostaddr= 覆盖(身份判定必须=实际写入目标)", () => {
  assert.doesNotThrow(() => assertNoHostOverride(POOLER));
  assert.throws(() => assertNoHostOverride(`${POOLER}?host=db.other.internal`), /override/);
  assert.throws(() => assertNoHostOverride(`${POOLER}?hostaddr=10.0.0.1`), /override/);
});

test("sourceProjectRefs:库连接串与 Storage 端点都能出 ref;占位符不出", () => {
  const config = {
    databaseUrl: POOLER,
    supabaseStorage: { endpoint: `https://zzzzzzzzzz9876543210.storage.supabase.co/storage/v1/s3` },
  };
  assert.deepEqual([...sourceProjectRefs(config)].sort(), [REF, "zzzzzzzzzz9876543210"].sort());
  assert.equal(sourceProjectRefs({ databaseUrl: NO_SOURCE_DATABASE }).size, 0);
});

test("reconcileFiles:逐键对账——缺失/尺寸不符判失败,多余对象只计数不判失败", () => {
  const files = [
    { bucket: "a", key: "x.txt", bytes: 10, sha256: "h1" },
    { bucket: "a", key: "y.txt", bytes: 20, sha256: "h2" },
    { bucket: "b", key: "z.txt", bytes: 5, sha256: "h3" },
  ];
  const good = new Map([
    ["a", new Map([["x.txt", 10], ["y.txt", 20]])],
    ["b", new Map([["z.txt", 5]])],
  ]);
  assert.deepEqual(reconcileFiles(files, good), {
    verified: 3, missing: [], sizeMismatched: [], extras: 0, matches: true,
  });
  // 多余对象绝不能掩蔽缺失(聚合 >= 比较的老毛病)
  const masked = new Map([
    ["a", new Map([["x.txt", 10], ["stray-1", 99], ["stray-2", 99]])],
    ["b", new Map([["z.txt", 7]])],
  ]);
  const r = reconcileFiles(files, masked);
  assert.equal(r.matches, false);
  assert.deepEqual(r.missing, ["a/y.txt"]);
  assert.match(r.sizeMismatched[0], /b\/z\.txt/);
  assert.equal(r.extras, 2);
});
