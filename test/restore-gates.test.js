import { test } from "node:test";
import assert from "node:assert/strict";
import { assertConfirmedTarget, refFromSupabaseUrl } from "../dist/restore.js";
import { bucketsToRestore } from "../dist/storage-restore.js";

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
