import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, MANIFEST_SCHEMA_VERSION } from "../dist/manifest.js";

const base = {
  tool: "backupdrill-cli",
  toolVersion: "1.0.0",
  createdAt: "2026-07-22T00:00:00.000Z",
  projectName: "demo",
  database: { serverVersion: "17.6", pgDumpVersion: "17.10", schemas: ["public"], tableCount: 1, estimatedRowTotal: 1, tables: [] },
  dump: { key: "k/dump.pgcustom", format: "custom", bytes: 1, sha256: "x" },
  storage: null,
};

test("当前版本的 manifest 正常解析", () => {
  const m = parseManifest(JSON.stringify({ ...base, schemaVersion: MANIFEST_SCHEMA_VERSION }));
  assert.equal(m.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(m.projectName, "demo");
});

test("旧快照缺 schemaVersion 时按 1 处理(不能把历史备份读废)", () => {
  const m = parseManifest(JSON.stringify(base));
  assert.equal(m.projectName, "demo");
});

test("更新格式的 manifest 必须明确拒绝,而不是硬解析", () => {
  // 对备份工具来说,"旧程序静默误读新归档"是最不能接受的失败方式:
  // 它会让演练/恢复给出看似成功、实则错误的结果。
  assert.throws(
    () => parseManifest(JSON.stringify({ ...base, schemaVersion: MANIFEST_SCHEMA_VERSION + 1 })),
    /schema version .* understands up to .*Upgrade the CLI/s
  );
});

test("坏 JSON 报可读错误,不是裸 SyntaxError", () => {
  assert.throws(() => parseManifest("{not json"), /manifest\.json is not valid JSON/);
});
