import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { BackupConfig } from "./config.js";
import type { Manifest } from "./manifest.js";
import {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
} from "./snapshots.js";
import { log } from "./log.js";

export interface RestoreResult {
  snapshot: string;
  restoredToDatabase: boolean;
  storageFilesWritten: number;
  storageDir?: string;
}

function pgRestore(dumpPath: string, targetUrl: string): Promise<void> {
  const bin =
    process.env.BACKUPDRILL_PG_RESTORE ||
    (process.env.BACKUPDRILL_PG_DUMP
      ? process.env.BACKUPDRILL_PG_DUMP.replace(/pg_dump$/, "pg_restore")
      : "pg_restore");
  return new Promise((resolve, reject) => {
    const proc = spawn(
      bin,
      ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", targetUrl, dumpPath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 || !/error:/i.test(stderr)
        ? resolve()
        : reject(new Error(`pg_restore failed: ${stderr.trim()}`))
    );
  });
}

/**
 * 把一份快照恢复出来:数据库还原进 --target-database-url;Storage 文件下载到本地目录
 * (拿回文件后你可以按需回传到新 Supabase 项目)。这是 US-5 恢复向导的 DIY 版本。
 */
export async function runRestore(
  config: BackupConfig,
  opts: {
    targetDatabaseUrl?: string;
    snapshot?: string;
    storageDir?: string;
  }
): Promise<RestoreResult> {
  const s3 = targetClient(config);
  const snapshotPrefix = await resolveSnapshot(s3, config, opts.snapshot);
  const snapshot = snapshotPrefix.replace(/\/$/, "").split("/").pop()!;
  const manifest = JSON.parse(
    await getObjectText(s3, config.storage.bucket, `${snapshotPrefix}manifest.json`)
  ) as Manifest;
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");

  const result: RestoreResult = {
    snapshot,
    restoredToDatabase: false,
    storageFilesWritten: 0,
  };

  const workdir = await mkdtemp(join(tmpdir(), "backupdrill-restore-"));
  try {
    // 1. 数据库
    if (opts.targetDatabaseUrl) {
      log.step("Downloading dump…");
      const dumpPath = join(workdir, "dump.pgcustom");
      await downloadToFile(s3, config.storage.bucket, manifest.dump.key, dumpPath);
      log.step("Restoring database into target…");
      await pgRestore(dumpPath, opts.targetDatabaseUrl);
      result.restoredToDatabase = true;
      log.ok(`Database restored (${manifest.database.tableCount} tables)`);
    } else {
      log.warn("No --target-database-url given; skipping database restore.");
    }

    // 2. Storage 文件 → 本地目录
    if (manifest.storage && manifest.storage.files.length) {
      const outDir = opts.storageDir ?? join(process.cwd(), `restored-storage-${snapshot}`);
      log.step(`Downloading ${manifest.storage.files.length} Storage files → ${outDir}`);
      for (const f of manifest.storage.files) {
        const dest = join(outDir, f.bucket, f.key);
        await mkdir(dirname(dest), { recursive: true });
        const res = await s3.send(
          new GetObjectCommand({
            Bucket: config.storage.bucket,
            Key: `${base}/storage/${f.bucket}/${f.key}`,
          })
        );
        await pipeline(res.Body as Readable, createWriteStream(dest));
        result.storageFilesWritten += 1;
      }
      result.storageDir = outDir;
      log.ok(`Storage files written to ${outDir}`);
    }

    return result;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
