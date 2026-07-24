import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRecoveryDoc } from "../dist/recovery-doc.js";

const manifest = {
  schemaVersion: 2,
  tool: "backupdrill-cli",
  toolVersion: "1.1.0",
  createdAt: "2026-07-25T00:00:00.000Z",
  projectName: "demo",
  database: {
    serverVersion: "17.6",
    pgDumpVersion: "pg_dump (PostgreSQL) 18.4",
    schemas: ["public"],
    tableCount: 7,
    estimatedRowTotal: 398,
    tables: [{ schema: "public", name: "customers", estimatedRows: 50 }],
    extensions: [{ name: "pg_trgm", version: "1.6", schema: "extensions" }],
  },
  dump: {
    key: "backupdrill/demo/2026-07-25T00-00-00-000Z/dump.pgcustom",
    format: "custom",
    bytes: 19111,
    sha256: "abc123def456",
  },
  storage: {
    buckets: [{ name: "avatars", public: false, fileSizeLimit: null, allowedMimeTypes: null }],
    fileCount: 3,
    totalBytes: 4096,
    files: [],
  },
};
const ctx = {
  snapshot: "2026-07-25T00-00-00-000Z",
  bucket: "my-backups",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  prefix: "backupdrill",
  projectName: "demo",
};

test("手册与 manifest 一致:对象键、校验和、扩展、快照坐标全部出现", () => {
  const doc = renderRecoveryDoc(manifest, ctx);
  assert.ok(doc.includes(manifest.dump.key), "dump 对象键");
  assert.ok(doc.includes(manifest.dump.sha256), "归档校验和(供 shasum 对照)");
  assert.ok(doc.includes('create extension if not exists "pg_trgm" schema "extensions" cascade;'), "扩展预装 SQL");
  assert.ok(doc.includes("--snapshot 2026-07-25T00-00-00-000Z"), "CLI 命令带快照坐标");
  assert.ok(doc.includes("--confirm-target <target-ref>"), "命令含确认门(2.0 必填)");
  assert.ok(doc.includes("--database"), "命令用意图旗标而非凭据 flag");
  assert.ok(!doc.includes("--target-database-url"), "凭据 flag 已移除,手册不得再教");
  assert.ok(doc.includes('export BACKUPDRILL_TARGET_DATABASE_URL="<target-session-pooler-url>"'), "凭据走环境变量占位");
  assert.ok(doc.includes("--endpoint https://acct.r2.cloudflarestorage.com"), "CLI 命令带端点");
  assert.ok(doc.includes("storage/<bucket>/<key>"), "Storage 布局说明");
});

test("恢复命令是引擎口径:无 --clean,写明 schema public 预期错误与授权抹除坑", () => {
  const doc = renderRecoveryDoc(manifest, ctx);
  const pgRestoreBlock = doc.slice(doc.indexOf("pg_restore --no-owner"));
  assert.ok(!pgRestoreBlock.slice(0, 200).includes("--clean"), "手动命令不得含 --clean");
  assert.ok(doc.includes('schema "public" already exists'), "预期错误说明");
  assert.ok(doc.includes("401"), "授权抹除后果说明");
});

test("诚实边界:未覆盖项明示;零秘密(占位符而非真实连接串)", () => {
  const doc = renderRecoveryDoc(manifest, ctx);
  assert.ok(/Auth users\/sessions, secret values, Edge Function/.test(doc), "未覆盖清单");
  assert.ok(doc.includes("<target-session-pooler-url>"), "目标连接串只以占位符出现");
  assert.ok(!/postgresql:\/\/[^<\s]+:[^<\s]+@/.test(doc), "不得出现带凭据形态的连接串");
});

test("DB-only 快照与无端点(AWS)形态:对应行如实变化", () => {
  const dbOnly = renderRecoveryDoc(
    { ...manifest, storage: null },
    { ...ctx, endpoint: undefined }
  );
  assert.ok(dbOnly.includes("database-only snapshot"));
  assert.ok(!dbOnly.includes("--endpoint"), "无端点时 CLI 命令不带 --endpoint");
});
