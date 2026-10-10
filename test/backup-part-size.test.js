// 转储分片的接线回归:part-size.test.js 只测算式,这里把 runBackup 整条跑一遍,
// 看真正交给 Upload 的 partSize 对不对——包括量不出体积时退回保底。
// 数据库、pg_dump、S3 全部打桩:pg 的查询按 SQL 返回假数据,pg_dump 换成一个
// 只会报版本、吐几个字节的 shell 脚本,Upload.done 只记下分片大小并把流读完。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { runBackup } from "../dist/backup.js";
import { partSizeFor } from "../dist/part-size.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

async function dumpPartSizeUsedByRunBackup(relationSizeQuery) {
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
      if (sql.includes("pg_total_relation_size")) return relationSizeQuery();
      return { rows: [] }; // 表清单、扩展清单
    }),
    mock.method(S3Client.prototype, "send", async () => ({})), // RECOVERY.md 与 manifest 的 PutObject
    mock.method(console, "error", () => {}), // 吞掉进度日志
  ];
  const partSizes = [];
  mocks.push(
    mock.method(Upload.prototype, "done", async function () {
      partSizes.push(this.partSize);
      for await (const _chunk of this.params.Body); // 读完转储流,pg_dump 才能正常退出
      return {};
    })
  );
  try {
    await runBackup({
      databaseUrl: "postgresql://u:p@127.0.0.1:5432/db",
      projectName: "part-size-test",
      schemas: ["public"],
      storage: {
        endpoint: "http://127.0.0.1:1",
        region: "us-east-1",
        bucket: "target",
        accessKeyId: "k",
        secretAccessKey: "s",
        prefix: "backupdrill",
        forcePathStyle: true,
      },
    });
  } finally {
    for (const m of mocks) m.mock.restore();
    if (previousPgDump === undefined) delete process.env.BACKUPDRILL_PG_DUMP;
    else process.env.BACKUPDRILL_PG_DUMP = previousPgDump;
    rmSync(dir, { recursive: true, force: true });
  }
  return partSizes;
}

test("小库:转储按 200 GiB 保底分片(21 MiB)", async () => {
  const sizes = await dumpPartSizeUsedByRunBackup(async () => ({ rows: [{ bytes: String(1 * GIB) }] }));
  assert.deepEqual(sizes, [21 * MIB]);
});

test("大库:按磁盘占用 × 2 放大分片", async () => {
  const sizes = await dumpPartSizeUsedByRunBackup(async () => ({ rows: [{ bytes: String(500 * GIB) }] }));
  assert.deepEqual(sizes, [partSizeFor(1000 * GIB)]);
  assert.ok(sizes[0] > 21 * MIB);
});

test("量体积失败:备份照常进行,分片退回保底", async () => {
  const sizes = await dumpPartSizeUsedByRunBackup(async () => {
    throw new Error("permission denied for function pg_total_relation_size");
  });
  assert.deepEqual(sizes, [21 * MIB]);
});
