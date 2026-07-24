import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { Client } from "pg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BackupConfig } from "./config.js";
import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
import type { BucketAttrs, ExtensionInfo, Manifest, TableStat } from "./manifest.js";
import { syncStorage } from "./storage.js";
import { inspectBucketAttrs } from "./storage-catalog.js";
import { log } from "./log.js";
import { TOOL_VERSION } from "./version.js";
import { pgConnectOptions, dumpUrlFor } from "./supabase-ca.js";

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
  extensions: ExtensionInfo[];
}

async function inspectDatabase(
  databaseUrl: string,
  schemas: string[]
): Promise<DbFacts> {
  // Supabase 主机 → 用打包的根 CA 做 verify-full(pooler 证书自签、不在系统信任库);
  // 非 Supabase(本 CLI 不限制目标)→ 保持默认,别把开源用户挡在门外
  const client = new Client(pgConnectOptions(databaseUrl));
  await client.connect();
  try {
    const version = await client.query<{ server_version: string }>(
      "show server_version"
    );
    const versionNum = await client.query<{ server_version_num: string }>(
      "show server_version_num"
    );
    // 只统计将被 dump 的 schema,manifest 才与转储内容一致。
    // 口径 = pg_class relkind in ('r','p','m'):普通表 + 分区父表 + 物化视图,
    // 与 pg_dump 实际转储的关系集合一致,且必须与 drill 校验端(verifyRestored)
    // 用同一查询——两端口径不同曾导致含 matview 的库演练必然误报 FAIL。
    // 行数估算仍取 n_live_tup(planner 统计);分区父表本身不存行,天然为 0。
    const tables = await client.query<{
      schema: string;
      name: string;
      estimated_rows: string;
    }>(
      `select n.nspname as schema, c.relname as name,
              coalesce(s.n_live_tup, 0) as estimated_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_all_tables s on s.relid = c.oid
        where c.relkind in ('r', 'p', 'm')
          and n.nspname = any($1::text[])
        order by 1, 2`,
      [schemas]
    );
    // 非内置扩展清单(排除必装的 plpgsql):--schema 转储不含 CREATE EXTENSION,
    // 演练沙箱要靠它在恢复前把扩展类型(如 vector)装回来
    const extensions = await client.query<ExtensionInfo>(
      `select e.extname as name, e.extversion as version, n.nspname as schema
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname <> 'plpgsql'
        order by e.extname`
    );
    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number(versionNum.rows[0].server_version_num),
      tables: tables.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        estimatedRows: Number(r.estimated_rows),
      })),
      extensions: extensions.rows,
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
  // pg_dump(libpq):Supabase 主机才改写成 sslmode=verify-full + sslrootcert=<打包CA临时文件>
  const dumpDbUrl = dumpUrlFor(config.databaseUrl);
  const dump = spawn(
    pgDumpBin,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      ...schemaArgs,
      "--dbname",
      dumpDbUrl,
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

  // 失败双向联动:dump 失败要中止上传(绝不把半截转储当成功);上传失败也必须
  // 杀掉 pg_dump —— 否则上传侧停止消费后,背压会让 pg_dump 永远阻塞在 stdout
  // 写入上,调用方(worker 的串行队列)随之永久挂起。Promise.all 会订阅两侧,
  // 先失败的一方抛出后,另一方稍后的 rejection 也已被视为 handled。
  try {
    await Promise.all([dumpDone, uploadDone]);
  } catch (error) {
    dump.kill("SIGKILL");
    meter.destroy();
    await upload.abort().catch(() => {});
    throw error;
  }

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
    // v2 bucket 属性采集,通道 = 已有的只读库连接(per-file 元数据已随 GetObject
    // 响应在 syncStorage 内原子捕获)。失败只降级不报错:storage schema 读不到
    // (如收紧的 backup_reader 角色)时,manifest 缺 buckets 字段,恢复端把缺失
    // 如实标 not captured(PRD §5.1.3)。
    let bucketAttrs: BucketAttrs[] | undefined;
    try {
      bucketAttrs = await inspectBucketAttrs(config.databaseUrl, synced.buckets);
    } catch (error) {
      log.warn(
        `Bucket attributes not captured (${(error as Error).message}); ` +
          `this manifest will record them as absent — restore will say so instead of guessing.`
      );
    }
    storageResult = {
      ...(bucketAttrs ? { buckets: bucketAttrs } : {}),
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
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: "backupdrill-cli",
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    projectName: config.projectName,
    database: {
      serverVersion: db.serverVersion,
      pgDumpVersion: pgd.raw,
      schemas: config.schemas,
      tableCount: db.tables.length,
      estimatedRowTotal: db.tables.reduce((n, t) => n + t.estimatedRows, 0),
      tables: db.tables,
      extensions: db.extensions,
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
