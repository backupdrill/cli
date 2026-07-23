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

// ---- 结构校验(v2 评审 Blocker:纯 cast 会让坏 manifest 在 pg_restore 中途才炸)----

test("v2 带 buckets 与文件元数据的 storage 正常解析", () => {
  const m = parseManifest(
    JSON.stringify({
      ...base,
      schemaVersion: 2,
      storage: {
        buckets: [{ name: "avatars", public: false, fileSizeLimit: null, allowedMimeTypes: null }],
        fileCount: 1,
        totalBytes: 3,
        files: [
          {
            bucket: "avatars",
            key: "a.png",
            bytes: 3,
            sha256: "x",
            contentType: "image/png",
            metadata: { origin: "app" },
          },
        ],
      },
    })
  );
  assert.equal(m.storage.buckets[0].name, "avatars");
});

test("dump 段缺 sha256 → malformed,不得放行到恢复/演练", () => {
  const bad = { ...base, dump: { key: "k", format: "custom", bytes: 1 } };
  assert.throws(() => parseManifest(JSON.stringify(bad)), /malformed: dump\.sha256/);
});

test("storage.files 条目缺校验和 → malformed", () => {
  const bad = {
    ...base,
    storage: { fileCount: 1, totalBytes: 1, files: [{ bucket: "b", key: "k", bytes: 1 }] },
  };
  assert.throws(() => parseManifest(JSON.stringify(bad)), /malformed: storage\.files\[\]/);
});

test("storage.buckets 条目无 name → malformed", () => {
  const bad = {
    ...base,
    schemaVersion: 2,
    storage: { buckets: [{ public: true }], fileCount: 0, totalBytes: 0, files: [] },
  };
  assert.throws(() => parseManifest(JSON.stringify(bad)), /malformed: storage\.buckets\[\]/);
});

// ---- 复审第 2 轮:根检查前置、版本整数关、v2 属性类型 ----

test("根不是对象(null/数字)→ malformed,不是裸 TypeError", () => {
  assert.throws(() => parseManifest("null"), /malformed: root is not an object/);
  assert.throws(() => parseManifest("42"), /malformed: root is not an object/);
});

test("schemaVersion 0 / 负数 / 小数 / 字符串 → malformed,不得混过版本闸门", () => {
  for (const v of [0, -1, 1.5, "2"]) {
    assert.throws(
      () => parseManifest(JSON.stringify({ ...base, schemaVersion: v })),
      /malformed: schemaVersion/,
      `schemaVersion ${JSON.stringify(v)} should be rejected`
    );
  }
});

test("v2 属性错型(public 是字符串、contentType 是数字)→ malformed", () => {
  const badBucket = {
    ...base,
    schemaVersion: 2,
    storage: {
      buckets: [{ name: "b", public: "false", fileSizeLimit: null, allowedMimeTypes: null }],
      fileCount: 0, totalBytes: 0, files: [],
    },
  };
  assert.throws(() => parseManifest(JSON.stringify(badBucket)), /malformed: storage\.buckets\[\]\.public/);
  const badFile = {
    ...base,
    schemaVersion: 2,
    storage: {
      fileCount: 1, totalBytes: 1,
      files: [{ bucket: "b", key: "k", bytes: 1, sha256: "x", contentType: 5 }],
    },
  };
  assert.throws(() => parseManifest(JSON.stringify(badFile)), /malformed: storage\.files\[\]\.contentType/);
});
