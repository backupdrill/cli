// 快照位置接口(SnapshotStore):备份、演练、恢复传入自己的实现时,引擎只经它读写快照,
// 不碰 config.storage。这里用一个内存实现把三条路径各走一遍;S3 实现的行为由其余测试
// (它们一条没改)继续钉住。数据库与 pg_dump 的打桩方式同 backup-part-size.test.js。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { runBackup } from "../dist/backup.js";
import { runDrill } from "../dist/drill.js";
import { runRestore } from "../dist/restore.js";

const DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/db";

/** 内存里的快照位置:记下每次写入的顺序与内容。canHoldStorage=false 模拟只放数据库的目标。 */
function memoryStore({ canHoldStorage = true } = {}) {
  const writes = [];
  const store = {
    writes,
    uploadCalls: 0,
    async createSnapshot(name) {
      return {
        dumpKey: `memory/${name}/dump.pgcustom`,
        storageFiles: canHoldStorage ? { s3: null, bucket: "memory", base: `memory/${name}` } : null,
        describe: (file) => `memory://${name}/${file}`,
        uploadDump(body) {
          store.uploadCalls += 1;
          const chunks = [];
          const done = (async () => {
            for await (const chunk of body) chunks.push(chunk);
            writes.push({ file: "dump.pgcustom", body: Buffer.concat(chunks) });
          })();
          return { done, abort: async () => {} };
        },
        async writeRecoveryDoc() {
          writes.push({ file: "RECOVERY.md" });
        },
        async writeManifest(manifest) {
          writes.push({ file: "manifest.json", manifest });
        },
      };
    },
    async openSnapshot() {
      throw new Error("not used");
    },
  };
  return store;
}

async function withFakeDatabase(run) {
  const dir = mkdtempSync(join(tmpdir(), "bd-fake-pgdump-"));
  const fakePgDump = join(dir, "pg_dump");
  writeFileSync(
    fakePgDump,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.2"; exit 0; fi\nprintf "PGDMP-fake"\n'
  );
  chmodSync(fakePgDump, 0o755);
  const previousPgDump = process.env.BACKUPDRILL_PG_DUMP;
  process.env.BACKUPDRILL_PG_DUMP = fakePgDump;
  const mocks = [
    mock.method(pg.Client.prototype, "connect", async () => {}),
    mock.method(pg.Client.prototype, "end", async () => {}),
    mock.method(pg.Client.prototype, "query", async (sql) => {
      if (sql === "show server_version") return { rows: [{ server_version: "17.2" }] };
      if (sql === "show server_version_num") return { rows: [{ server_version_num: "170002" }] };
      if (sql.includes("pg_total_relation_size")) return { rows: [{ bytes: "1024" }] };
      return { rows: [] };
    }),
    mock.method(console, "error", () => {}),
  ];
  try {
    return await run();
  } finally {
    for (const m of mocks) m.mock.restore();
    if (previousPgDump === undefined) delete process.env.BACKUPDRILL_PG_DUMP;
    else process.env.BACKUPDRILL_PG_DUMP = previousPgDump;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runBackup 写进传入的 store:不需要 config.storage,manifest 最后写,校验和对得上", async () => {
  const store = memoryStore();
  const manifest = await withFakeDatabase(() =>
    runBackup({ databaseUrl: DATABASE_URL, projectName: "p", schemas: ["public"] }, { store })
  );
  assert.deepEqual(store.writes.map((w) => w.file), ["dump.pgcustom", "RECOVERY.md", "manifest.json"]);
  const dump = store.writes[0].body;
  assert.equal(dump.toString(), "PGDMP-fake");
  assert.equal(manifest.dump.bytes, dump.length);
  assert.equal(manifest.dump.sha256, createHash("sha256").update(dump).digest("hex"));
  assert.match(manifest.dump.key, /^memory\/.+\/dump\.pgcustom$/);
  assert.deepEqual(store.writes[2].manifest, manifest);
});

test("runBackup:目标放不了 Storage 文件却配了 Storage → 转储之前就拒绝", async () => {
  const store = memoryStore({ canHoldStorage: false });
  await assert.rejects(
    withFakeDatabase(() =>
      runBackup(
        {
          databaseUrl: DATABASE_URL,
          projectName: "p",
          schemas: ["public"],
          supabaseStorage: {
            endpoint: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
            region: "us-east-1",
            accessKeyId: "a",
            secretAccessKey: "b",
          },
        },
        { store }
      )
    ),
    /Storage file backup needs an S3-compatible bucket/
  );
  assert.equal(store.uploadCalls, 0);
  assert.equal(store.writes.length, 0);
});

test("没有 config.storage 也没传 store:报没配桶,而不是读 undefined", async () => {
  await assert.rejects(
    runDrill({ databaseUrl: DATABASE_URL, projectName: "p", schemas: ["public"] }),
    /No S3-compatible bucket configured/
  );
});

function readerStore({ manifest, dumpBytes, canHoldStorage = true }) {
  const calls = { download: 0 };
  return {
    calls,
    async createSnapshot() {
      throw new Error("not used");
    },
    async openSnapshot(name) {
      return {
        name: name ?? "2026-10-18T00-00-00-000Z",
        readManifest: async () => JSON.stringify(manifest),
        async downloadDump(_manifest, dest) {
          calls.download += 1;
          await writeFile(dest, dumpBytes);
          return { bytes: dumpBytes.length, sha256: createHash("sha256").update(dumpBytes).digest("hex") };
        },
        storageFiles: () => (canHoldStorage ? { s3: null, bucket: "memory", base: "memory" } : null),
      };
    },
  };
}

function manifestFor(dumpBytes, storage = null) {
  return {
    tool: "backupdrill-cli",
    toolVersion: "test",
    createdAt: new Date().toISOString(),
    projectName: "p",
    database: { serverVersion: "17", pgDumpVersion: "17", schemas: ["public"], tableCount: 0, tables: [] },
    dump: {
      key: "memory/x/dump.pgcustom",
      format: "custom",
      bytes: dumpBytes.length,
      sha256: createHash("sha256").update(Buffer.from("something else")).digest("hex"),
    },
    storage,
  };
}

test("runDrill 从传入的 store 读快照:下载走 store,校验和不符照常判 FAIL", async () => {
  const dumpBytes = Buffer.from("archive bytes");
  const store = readerStore({ manifest: manifestFor(dumpBytes), dumpBytes });
  const report = await runDrill(
    { databaseUrl: DATABASE_URL, projectName: "p", schemas: ["public"] },
    { snapshot: "s1", store }
  );
  assert.equal(store.calls.download, 1);
  assert.equal(report.snapshot, "s1");
  assert.equal(report.pass, false);
  assert.equal(report.checks[0].name, "archive integrity");
  assert.match(report.checks[0].detail, /MISMATCH/);
});

test("runRestore:快照列了 Storage 文件但 store 放不了 → 写入任何东西之前拒绝", async () => {
  const dumpBytes = Buffer.from("archive bytes");
  const storage = { fileCount: 1, totalBytes: 1, files: [{ bucket: "b", key: "k", bytes: 1, sha256: "0".repeat(64) }] };
  const store = readerStore({ manifest: manifestFor(dumpBytes, storage), dumpBytes, canHoldStorage: false });
  await assert.rejects(
    runRestore({ databaseUrl: DATABASE_URL, projectName: "p", schemas: ["public"] }, { dryRun: true, store }),
    /cannot hold them/
  );
  assert.equal(store.calls.download, 0);
});
