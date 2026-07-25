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
import { bucketsToRestore, reconcileFiles, tusThresholdBytes, STANDARD_UPLOAD_LIMIT_BYTES } from "../dist/storage-restore.js";

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

test("reconcileFiles:逐键对账——缺失/尺寸不符/多余对象都破坏 matches", () => {
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

test("?user= 覆盖同样拒绝(pooler 租户在用户名里,覆盖 user = 换项目)", () => {
  assert.throws(() => assertNoHostOverride(`${POOLER}?user=postgres.zzzzzzzzzz9876543210`), /override/);
});

test("sourceProjectRefs:manifest 自记的源 ref 是纯 flag 恢复的最后防线", () => {
  const bare = { databaseUrl: NO_SOURCE_DATABASE };
  assert.equal(sourceProjectRefs(bare).size, 0);
  const withManifest = sourceProjectRefs(bare, { sourceProjectRef: REF });
  assert.deepEqual([...withManifest], [REF]);
});

test("TUS 阈值:默认 6MB(Supabase 建议线);env 覆盖被钳制在 5GB 硬上限内", () => {
  delete process.env.BACKUPDRILL_TUS_THRESHOLD;
  assert.equal(tusThresholdBytes(), 6 * 1024 * 1024, "默认 6MB(Supabase resumable 建议线)");
  assert.ok(STANDARD_UPLOAD_LIMIT_BYTES === 5 * 1024 ** 3, "5GB 常量仍是标准上传的硬上限");
  process.env.BACKUPDRILL_TUS_THRESHOLD = "1";
  assert.equal(tusThresholdBytes(), 1);
  // 调高不许越过标准上传硬上限:>5GB 文件绝不能被送进必败的标准上传
  process.env.BACKUPDRILL_TUS_THRESHOLD = String(10 * 1024 ** 3);
  assert.equal(tusThresholdBytes(), STANDARD_UPLOAD_LIMIT_BYTES);
  delete process.env.BACKUPDRILL_TUS_THRESHOLD;
});

test("projectRefOf:百分号编码的用户名按驱动语义解码后判定(编码不得绕过身份检查)", async () => {
  const { projectRefOf } = await import("../dist/restore.js");
  assert.equal(
    projectRefOf(`postgresql://postgres%2E${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`),
    REF
  );
});

test("credentialSafeDbArgs:authority 与 ?password= 两种形态都出 argv;keyword 内联密码拒绝", async () => {
  const { credentialSafeDbArgs } = await import("../dist/restore-engine.js");
  const auth = credentialSafeDbArgs("postgresql://u:sec%40ret@h:5432/db");
  assert.equal(auth.env.PGPASSWORD, "sec@ret");
  assert.ok(!auth.url.includes("sec"));
  const query = credentialSafeDbArgs("postgresql://u@h:5432/db?password=qsecret&sslmode=require");
  assert.equal(query.env.PGPASSWORD, "qsecret");
  assert.ok(!query.url.includes("qsecret"));
  assert.ok(query.url.includes("sslmode=require"), "其余查询参数保留");
  assert.throws(
    () => credentialSafeDbArgs("host=h user=u password=ksecret dbname=db"),
    /keyword-style.*not accepted/s
  );
});

test("确认门:外部库目标 + Supabase Storage 目标的混搭直接拒绝(一个确认盖不住两个目标)", () => {
  assert.throws(
    () => assertConfirmedTarget("whatever", "postgresql://u:p@db.internal.example:5432/app", API),
    /separately/
  );
});

test("reconcileFiles:extras 也判不匹配(恢复目标应当只含快照内容)", () => {
  const files = [{ bucket: "a", key: "x.txt", bytes: 10, sha256: "h1" }];
  const withExtra = new Map([["a", new Map([["x.txt", 10], ["foreign.bin", 5]])]]);
  const r = reconcileFiles(files, withExtra);
  assert.equal(r.verified, 1);
  assert.equal(r.extras, 1);
  assert.equal(r.matches, false);
});

test("末尾 DNS 根点不绕身份判定:db.<ref>.supabase.co. 与无点形态同一租户", async () => {
  const { projectRefOf, sameDatabaseTarget } = await import("../dist/restore.js");
  const dotted = `postgresql://postgres:pw@db.${REF}.supabase.co.:5432/postgres`;
  assert.equal(projectRefOf(dotted), REF);
  assert.equal(refFromSupabaseUrl(`https://${REF}.supabase.co.`), REF);
  assert.equal(sameDatabaseTarget(dotted, POOLER), true);
});

test("credentialSafeDbArgs:坏的百分号编码 fail-closed;剥 ?password= 不重编码其余参数", async () => {
  const { credentialSafeDbArgs } = await import("../dist/restore-engine.js");
  assert.throws(
    () => credentialSafeDbArgs("postgresql://u:bad%zz@h:5432/db"),
    /malformed percent-encoding/
  );
  const surgical = credentialSafeDbArgs(
    "postgresql://u@h:5432/db?options=-c%20statement_timeout%3D0&password=s3c"
  );
  assert.equal(surgical.env.PGPASSWORD, "s3c");
  assert.ok(surgical.url.includes("options=-c%20statement_timeout%3D0"), "%20 不得变成 +");
  assert.ok(!surgical.url.includes("password="));
});
