import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

// 0.1.0 事故回归:CLI 层 overrides 里未传的 flag 是显式 undefined,曾把
// env/配置文件的 storage 配置整体覆写掉,README 教的两条配置路径 100% 失败。
// 这组测试锁死 flag > env > file 的合并优先级与 undefined 不覆盖的语义。

const ENV_KEYS = [
  "BACKUPDRILL_DATABASE_URL",
  "DATABASE_URL",
  "BACKUPDRILL_PROJECT_NAME",
  "BACKUPDRILL_SCHEMAS",
  "BACKUPDRILL_S3_ENDPOINT",
  "BACKUPDRILL_S3_REGION",
  "BACKUPDRILL_S3_BUCKET",
  "BACKUPDRILL_S3_ACCESS_KEY_ID",
  "BACKUPDRILL_S3_SECRET_ACCESS_KEY",
  "BACKUPDRILL_S3_PREFIX",
  "BACKUPDRILL_S3_FORCE_PATH_STYLE",
];

// 模拟 index.ts 里 backup 命令的 overrides 形状:未传 flag = 显式 undefined
function cliOverrides(extra = {}) {
  return {
    databaseUrl: undefined,
    projectName: undefined,
    schemas: undefined,
    storage: {
      bucket: undefined,
      endpoint: undefined,
      region: undefined,
      prefix: undefined,
      ...extra.storage,
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "storage")),
  };
}

const saved = {};
let dir;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "backupdrill-config-test-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

test("env-only setup works with CLI-shaped undefined overrides (the 0.1.0 regression)", async () => {
  process.env.BACKUPDRILL_DATABASE_URL = "postgresql://env-db";
  process.env.BACKUPDRILL_S3_BUCKET = "env-bucket";
  process.env.BACKUPDRILL_S3_ACCESS_KEY_ID = "env-key";
  process.env.BACKUPDRILL_S3_SECRET_ACCESS_KEY = "env-secret";
  process.env.BACKUPDRILL_S3_ENDPOINT = "https://r2.example.com";

  const config = await loadConfig({
    configPath: join(dir, "missing.json"),
    overrides: cliOverrides(),
  });

  assert.equal(config.databaseUrl, "postgresql://env-db");
  assert.equal(config.storage.bucket, "env-bucket");
  assert.equal(config.storage.endpoint, "https://r2.example.com");
  // endpoint 存在 → path-style 默认开(R2 语义),不能被 undefined 冲掉
  assert.equal(config.storage.forcePathStyle, true);
});

test("config-file-only setup works with CLI-shaped undefined overrides", async () => {
  const path = join(dir, "backupdrill.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      databaseUrl: "postgresql://file-db",
      storage: {
        bucket: "file-bucket",
        accessKeyId: "file-key",
        secretAccessKey: "file-secret",
        prefix: "custom-prefix",
      },
    })
  );

  const config = await loadConfig({ configPath: path, overrides: cliOverrides() });

  assert.equal(config.databaseUrl, "postgresql://file-db");
  assert.equal(config.storage.bucket, "file-bucket");
  assert.equal(config.storage.prefix, "custom-prefix");
});

test("precedence: flag > env > file, and partial flags keep env for the rest", async () => {
  const path = join(dir, "backupdrill.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      databaseUrl: "postgresql://file-db",
      storage: { bucket: "file-bucket", region: "file-region" },
    })
  );
  process.env.BACKUPDRILL_S3_BUCKET = "env-bucket";
  process.env.BACKUPDRILL_S3_ENDPOINT = "https://env-endpoint.example.com";
  process.env.BACKUPDRILL_S3_ACCESS_KEY_ID = "env-key";
  process.env.BACKUPDRILL_S3_SECRET_ACCESS_KEY = "env-secret";

  const config = await loadConfig({
    configPath: path,
    overrides: cliOverrides({ storage: { bucket: "flag-bucket" } }),
  });

  // flag 覆盖 env,env 覆盖 file
  assert.equal(config.storage.bucket, "flag-bucket");
  // 只传了 --bucket:endpoint/凭据必须仍来自 env,region 来自 file
  assert.equal(config.storage.endpoint, "https://env-endpoint.example.com");
  assert.equal(config.storage.accessKeyId, "env-key");
  assert.equal(config.storage.region, "file-region");
  assert.equal(config.databaseUrl, "postgresql://file-db");
});

test("missing required config still errors with a helpful message", async () => {
  await assert.rejects(
    loadConfig({ configPath: join(dir, "missing.json"), overrides: cliOverrides() }),
    /Missing required config/
  );
});
