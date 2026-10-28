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
  // Storage 源三项"给一缺二"会让 loadConfig 抛错:开发者 shell 里残留半份
  // 这些变量时,不隔离会与被测逻辑无关地假失败
  "BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT",
  "BACKUPDRILL_SUPABASE_STORAGE_REGION",
  "BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID",
  "BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY",
  "BACKUPDRILL_SUPABASE_STORAGE_BUCKETS",
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

// GitHub Actions 里没配的 secret 展开成空串。examples/scheduled-backup.yml 把
// BACKUPDRILL_PROJECT_NAME 等可选项都这样传,2.7.1 及以前空串被当成真名,快照落进
// backupdrill//<时间戳>/。这组测试锁死:环境变量的空串 = 没设。
function requiredEnv() {
  process.env.BACKUPDRILL_DATABASE_URL = "postgresql://env-db";
  process.env.BACKUPDRILL_S3_BUCKET = "env-bucket";
  process.env.BACKUPDRILL_S3_ACCESS_KEY_ID = "env-key";
  process.env.BACKUPDRILL_S3_SECRET_ACCESS_KEY = "env-secret";
}

test("an empty BACKUPDRILL_PROJECT_NAME falls back to the default name, so keys never get an empty segment", async () => {
  requiredEnv();
  process.env.BACKUPDRILL_PROJECT_NAME = "";

  const config = await loadConfig({ configPath: join(dir, "missing.json"), overrides: cliOverrides() });

  assert.equal(config.projectName, "supabase");
  const { s3SnapshotStore } = await import("../dist/snapshot-store.js");
  const writer = await s3SnapshotStore(config).createSnapshot("2026-10-29T03-00-00Z");
  assert.equal(writer.dumpKey, "backupdrill/supabase/2026-10-29T03-00-00Z/dump.pgcustom");
});

test("an empty BACKUPDRILL_PROJECT_NAME doesn't hide the config file's name", async () => {
  requiredEnv();
  process.env.BACKUPDRILL_PROJECT_NAME = "";
  const path = join(dir, "backupdrill.config.json");
  writeFileSync(path, JSON.stringify({ projectName: "from-file" }));

  const config = await loadConfig({ configPath: path, overrides: cliOverrides() });

  assert.equal(config.projectName, "from-file");
});

test("--project-name '' still reaches snapshots an older version wrote under <prefix>//", async () => {
  // 那些快照的 RECOVERY.md 里写的恢复命令就是 --project-name '',显式的空名必须原样保留
  requiredEnv();
  const config = await loadConfig({
    configPath: join(dir, "missing.json"),
    overrides: cliOverrides({ projectName: "" }),
  });

  assert.equal(config.projectName, "");
  const { renderRecoveryDoc } = await import("../dist/recovery-doc.js");
  const doc = renderRecoveryDoc(
    {
      projectName: "",
      database: { serverVersion: "17.6", pgDumpVersion: "pg_dump (PostgreSQL) 17.6", schemas: ["public"], tableCount: 1, estimatedRowTotal: 1, tables: [] },
      dump: { key: "backupdrill//2026-10-01T03-00-00Z/dump.pgcustom", format: "custom", bytes: 1, sha256: "abc" },
    },
    { snapshot: "2026-10-01T03-00-00Z", bucket: "b", prefix: "backupdrill", projectName: "" }
  );
  assert.ok(doc.includes("--project-name '' \\"), "old runbooks carry --project-name ''");
});

test("empty DATABASE_URL variables don't hide the config file's databaseUrl", async () => {
  process.env.BACKUPDRILL_DATABASE_URL = "";
  process.env.DATABASE_URL = "";
  process.env.BACKUPDRILL_S3_BUCKET = "env-bucket";
  process.env.BACKUPDRILL_S3_ACCESS_KEY_ID = "env-key";
  process.env.BACKUPDRILL_S3_SECRET_ACCESS_KEY = "env-secret";
  const path = join(dir, "backupdrill.config.json");
  writeFileSync(path, JSON.stringify({ databaseUrl: "postgresql://file-db" }));

  const config = await loadConfig({ configPath: path, overrides: cliOverrides() });

  assert.equal(config.databaseUrl, "postgresql://file-db");
});

test("list variables with only commas and spaces don't replace the config file's lists", async () => {
  requiredEnv();
  process.env.BACKUPDRILL_SCHEMAS = " , ";
  process.env.BACKUPDRILL_SUPABASE_STORAGE_BUCKETS = ",";
  const path = join(dir, "backupdrill.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemas: ["public", "app"],
      supabaseStorage: {
        endpoint: "https://ref.storage.supabase.co/storage/v1/s3",
        accessKeyId: "src-key",
        secretAccessKey: "src-secret",
        buckets: ["avatars"],
      },
    })
  );

  const config = await loadConfig({ configPath: path, overrides: cliOverrides() });

  assert.deepEqual(config.schemas, ["public", "app"]);
  assert.deepEqual(config.supabaseStorage.buckets, ["avatars"]);
});

test("empty optional variables from an unset secret leave every default in place", async () => {
  requiredEnv();
  for (const key of [
    "BACKUPDRILL_PROJECT_NAME",
    "BACKUPDRILL_SCHEMAS",
    "BACKUPDRILL_S3_ENDPOINT",
    "BACKUPDRILL_S3_REGION",
    "BACKUPDRILL_S3_PREFIX",
    "BACKUPDRILL_S3_FORCE_PATH_STYLE",
    "BACKUPDRILL_SUPABASE_STORAGE_ENDPOINT",
    "BACKUPDRILL_SUPABASE_STORAGE_REGION",
    "BACKUPDRILL_SUPABASE_STORAGE_ACCESS_KEY_ID",
    "BACKUPDRILL_SUPABASE_STORAGE_SECRET_ACCESS_KEY",
    "BACKUPDRILL_SUPABASE_STORAGE_BUCKETS",
  ]) {
    process.env[key] = "";
  }

  const config = await loadConfig({ configPath: join(dir, "missing.json"), overrides: cliOverrides() });

  assert.equal(config.projectName, "supabase");
  assert.deepEqual(config.schemas, ["public"]);
  assert.equal(config.storage.endpoint, undefined);
  assert.equal(config.storage.region, "auto");
  assert.equal(config.storage.prefix, "backupdrill");
  assert.equal(config.storage.forcePathStyle, false);
  assert.equal(config.supabaseStorage, undefined);
});
