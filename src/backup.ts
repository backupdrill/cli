import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { Client } from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BackupConfig } from "./config.js";
import type { Manifest, TableStat } from "./manifest.js";
import { syncStorage } from "./storage.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

function majorOf(serverVersionNum: number): number {
  // server_version_num: 150004 → 15,  170002 → 17
  return Math.floor(serverVersionNum / 10000);
}

/**
 * Parse the major version out of `pg_dump --version` output.
 *
 * MUST tolerate a trailing vendor suffix: Homebrew/macOS prints `pg_dump (PostgreSQL) 17.2`, but
 * Debian/PGDG (what the deployed worker image uses) prints
 * `pg_dump (PostgreSQL) 17.10 (Debian 17.10-1.pgdg120+1)`. Anchoring the match to end-of-string
 * therefore breaks in production while passing on a dev Mac. Anchor on the `(PostgreSQL)` marker
 * instead, falling back to the first dotted version token for non-standard builds.
 */
export function parsePgDumpMajor(raw: string): number | null {
  const match = raw.match(/\(PostgreSQL\)\s+(\d+)/) ?? raw.match(/(\d+)(?:\.\d+)+/);
  return match ? Number(match[1]) : null;
}

async function pgDumpVersion(bin: string): Promise<{ raw: string; major: number }> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"]);
    const raw = stdout.trim();
    const major = parsePgDumpMajor(raw);
    if (major === null) throw new Error(`Unrecognized pg_dump version string: ${raw}`);
    return { raw, major };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `pg_dump not found (looked for "${bin}"). Install the PostgreSQL client ` +
          `matching your server's major version, or set BACKUPDRILL_PG_DUMP to its path.`
      );
    }
    throw error;
  }
}

interface DbFacts {
  serverVersion: string;
  serverVersionNum: number;
  tables: TableStat[];
}

async function inspectDatabase(
  databaseUrl: string,
  schemas: string[]
): Promise<DbFacts> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const version = await client.query<{ server_version: string }>(
      "show server_version"
    );
    const versionNum = await client.query<{ server_version_num: string }>(
      "show server_version_num"
    );
    // 只统计将被 dump 的 schema,manifest 才与转储内容一致
    const tables = await client.query<{
      schema: string;
      name: string;
      estimated_rows: string;
    }>(
      `select schemaname as schema, relname as name, n_live_tup as estimated_rows
         from pg_stat_user_tables
        where schemaname = any($1::text[])
        order by schemaname, relname`,
      [schemas]
    );
    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number(versionNum.rows[0].server_version_num),
      tables: tables.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        estimatedRows: Number(r.estimated_rows),
      })),
    };
  } finally {
    await client.end();
  }
}

/** 流式跑 pg_dump,边写 S3 边算 sha256 与字节数。返回校验和与大小。 */
async function dumpToS3(
  config: BackupConfig,
  s3: S3Client,
  key: string,
  pgDumpBin: string
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });

  const schemaArgs = config.schemas.map((s) => `--schema=${s}`);
  const dump = spawn(
    pgDumpBin,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...schemaArgs,
      "--dbname",
      config.databaseUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stderr = "";
  dump.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  dump.stdout.pipe(meter);

  const dumpDone = new Promise<void>((resolve, reject) => {
    dump.on("error", reject); // 启动失败(如 ENOENT)
    dump.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`))
    );
  });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.storage.bucket,
      Key: key,
      Body: meter,
      ContentType: "application/octet-stream",
    },
  });
  const uploadDone = upload.done();

  // 正确性以 pg_dump 退出码为准:dump 失败则中止上传,绝不把半截转储当成功
  try {
    await dumpDone;
  } catch (error) {
    meter.destroy(error as Error);
    await upload.abort().catch(() => {});
    throw error;
  }
  await uploadDone;

  return { bytes, sha256: hash.digest("hex") };
}

export async function runBackup(config: BackupConfig): Promise<Manifest> {
  const pgDumpBin = process.env.BACKUPDRILL_PG_DUMP || "pg_dump";

  log.step("Inspecting database…");
  const db = await inspectDatabase(config.databaseUrl, config.schemas);
  const serverMajor = majorOf(db.serverVersionNum);
  log.ok(
    `Postgres ${db.serverVersion} — schema(s) ${config.schemas.join(", ")}: ` +
      `${db.tables.length} tables, ` +
      `~${db.tables.reduce((n, t) => n + t.estimatedRows, 0).toLocaleString()} rows`
  );

  // pg_dump 主版本必须 ≥ 服务端,否则转储会失败或不完整(PRD §4.2)
  const pgd = await pgDumpVersion(pgDumpBin);
  if (pgd.major < serverMajor) {
    throw new Error(
      `pg_dump is v${pgd.major} but the server is v${serverMajor}. ` +
        `pg_dump must be >= the server major version. Install postgresql-client-${serverMajor} ` +
        `(or newer) and/or point BACKUPDRILL_PG_DUMP at it.`
    );
  }

  const s3 = new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${config.storage.prefix}/${config.projectName}/${timestamp}`;
  const dumpKey = `${base}/dump.pgcustom`;

  log.step(`Dumping → s3://${config.storage.bucket}/${dumpKey}`);
  const { bytes, sha256 } = await dumpToS3(config, s3, dumpKey, pgDumpBin);
  log.ok(`Database dumped (${(bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`);

  // Storage 文件同步(源配置存在才做;否则只备数据库)
  let storageResult: Manifest["storage"] = null;
  if (config.supabaseStorage) {
    log.step("Syncing Storage files…");
    const synced = await syncStorage(config.supabaseStorage, {
      client: s3,
      bucket: config.storage.bucket,
      base, // syncStorage 内部会加 /storage/<bucket>/<key>
    });
    storageResult = {
      fileCount: synced.fileCount,
      totalBytes: synced.totalBytes,
      files: synced.files,
    };
    log.ok(
      `Storage synced (${synced.fileCount} files, ` +
        `${(synced.totalBytes / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  const manifest: Manifest = {
    tool: "backupdrill-cli",
    toolVersion: process.env.npm_package_version || "0.1.0",
    createdAt: new Date().toISOString(),
    projectName: config.projectName,
    database: {
      serverVersion: db.serverVersion,
      pgDumpVersion: pgd.raw,
      schemas: config.schemas,
      tableCount: db.tables.length,
      estimatedRowTotal: db.tables.reduce((n, t) => n + t.estimatedRows, 0),
      tables: db.tables,
    },
    dump: { key: dumpKey, format: "custom", bytes, sha256 },
    storage: storageResult,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: `${base}/manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    })
  );
  log.ok(`Manifest written → s3://${config.storage.bucket}/${base}/manifest.json`);

  return manifest;
}
