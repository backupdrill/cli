import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { S3Client } from "@aws-sdk/client-s3";
import type { BackupConfig } from "./config.js";
import type { Manifest } from "./manifest.js";
import {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
  hashObject,
} from "./snapshots.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

// Storage 校验默认抽样上限(避免每次演练重下全部文件产生大量 egress);超限如实记录
const STORAGE_SAMPLE_CAP = 100;

export interface DrillCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface DrillReport {
  snapshot: string;
  pass: boolean;
  checks: DrillCheck[];
  restoreSeconds: number;
  restoredTableCount: number;
  restoredRowTotal: number;
}

// ── 临时 Postgres 容器编排 ──────────────────────────────────────────

interface Ephemeral {
  containerId: string;
  port: string;
  connString: string;
}

async function startEphemeralPostgres(major: number): Promise<Ephemeral> {
  const image = `postgres:${major}-alpine`;
  log.step(`Starting ephemeral ${image}…`);
  const { stdout } = await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "-e",
    "POSTGRES_PASSWORD=drill",
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1:0:5432", // 随机主机端口,避免撞端口
    image,
  ]);
  const containerId = stdout.trim();

  try {
    const portOut = await execFileAsync("docker", [
      "port",
      containerId,
      "5432/tcp",
    ]);
    // 形如 "127.0.0.1:54321"
    const port = portOut.stdout.trim().split(":").pop()!.trim();
    const connString = `postgresql://postgres:drill@127.0.0.1:${port}/postgres`;

    // 等就绪(容器内 pg_isready),最多 ~30s。
    // 必须 -h 127.0.0.1 强制走 TCP:官方镜像 initdb 阶段先起一个只听 unix socket 的临时
    // 服务跑初始化,默认(socket)检查在该阶段就通过,pg_restore 随后连 TCP 正撞上
    // 临时服务停止/正式服务重启的窗口 → "server closed the connection unexpectedly"。
    // 阶段一不听 TCP,所以 TCP 检查首次通过 = 正式服务已就绪。
    for (let i = 0; i < 60; i++) {
      try {
        await execFileAsync("docker", [
          "exec",
          containerId,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-q",
        ]);
        return { containerId, port, connString };
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("ephemeral Postgres did not become ready within 30s");
  } catch (error) {
    await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => {});
    throw error;
  }
}

/** post-data 第二遍恢复的结果:用户对象失败 vs Supabase 托管对象的沙箱预期跳过。 */
interface PostDataResult {
  supabaseSkipped: number;
  failures: string[];
}

function spawnPgRestore(
  bin: string,
  args: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stderr }));
  });
}

// 演练沙箱是裸 Postgres,Supabase 托管的 schema/角色必然缺席。post-data 里
// 引用它们的失败是"环境预期",不是备份坏了;其余失败才是演练要抓的。
const SUPABASE_MANAGED_ERROR =
  /schema "(auth|storage|realtime|vault|extensions|graphql[a-z_]*)" does not exist|role "(authenticated|anon|service_role|supabase_[a-z_]+)" does not exist|\bauth\.uid\b|\bauth\.jwt\b/i;

/** 把 pg_restore 的 stderr 拆成单个错误块并分类(Supabase 托管 vs 用户对象)。 */
export function classifyPostDataErrors(stderr: string): PostDataResult {
  const blocks = stderr
    .split(/(?=pg_restore: error:)/)
    .filter((b) => /pg_restore: error:/.test(b));
  let supabaseSkipped = 0;
  const failures: string[] = [];
  for (const block of blocks) {
    if (SUPABASE_MANAGED_ERROR.test(block)) {
      supabaseSkipped += 1;
    } else {
      failures.push(block.replace(/\s+/g, " ").trim().slice(0, 200));
    }
  }
  return { supabaseSkipped, failures };
}

/**
 * 两遍恢复(真实首演炸出的设计):
 * 1. pre-data+data —— 表结构 + 数据。任何错误都是硬失败:数据回不来 = 演练失败。
 * 2. post-data —— 用户自己的索引/约束/触发器**必须**恢复成功(它们是"备份完整"的
 *    一部分,一刀切跳过会让坏备份漏网);只有引用 Supabase 托管对象的失败
 *    (policy TO authenticated、FK → auth.users)才归类为沙箱预期,记入报告而非失败。
 */
async function pgRestore(dumpPath: string, connString: string): Promise<PostDataResult> {
  const pgRestoreBin =
    process.env.BACKUPDRILL_PG_RESTORE ||
    (process.env.BACKUPDRILL_PG_DUMP
      ? process.env.BACKUPDRILL_PG_DUMP.replace(/pg_dump$/, "pg_restore")
      : "pg_restore");
  const common = ["--no-owner", "--no-privileges", "--dbname", connString, dumpPath];

  const first = await spawnPgRestore(pgRestoreBin, [
    "--clean",
    "--if-exists",
    "--section=pre-data",
    "--section=data",
    ...common,
  ]);
  // pg_restore 对无害告警会返回非 0;仅在明确 error 时判失败
  if (first.code !== 0 && /error:/i.test(first.stderr)) {
    throw new Error(`pg_restore failed: ${first.stderr.trim()}`);
  }

  const second = await spawnPgRestore(pgRestoreBin, ["--section=post-data", ...common]);
  return classifyPostDataErrors(second.stderr);
}

// ── 校验 ────────────────────────────────────────────────────────────

async function verifyRestored(
  connString: string,
  manifest: Manifest
): Promise<{ checks: DrillCheck[]; tableCount: number; rowTotal: number }> {
  const client = new Client({ connectionString: connString });
  await client.connect();
  try {
    const schemas = manifest.database.schemas;
    const tablesRes = await client.query<{ schema: string; name: string }>(
      `select schemaname as schema, tablename as name
         from pg_tables where schemaname = any($1::text[])`,
      [schemas]
    );
    const restoredTables = tablesRes.rows;

    // 逐表精确计数(演练要证明数据真回来了,估算值不够)
    const counts = new Map<string, number>();
    let rowTotal = 0;
    for (const t of restoredTables) {
      const c = await client.query<{ n: string }>(
        `select count(*)::bigint as n from "${t.schema}"."${t.name}"`
      );
      const n = Number(c.rows[0].n);
      counts.set(`${t.schema}.${t.name}`, n);
      rowTotal += n;
    }

    const checks: DrillCheck[] = [];

    // 1. 表数量一致
    checks.push({
      name: "table count",
      pass: restoredTables.length === manifest.database.tableCount,
      detail: `restored ${restoredTables.length}, manifest ${manifest.database.tableCount}`,
    });

    // 2. manifest 里的每张表都还原出来了
    const restoredSet = new Set(counts.keys());
    const missing = manifest.database.tables.filter(
      (t) => !restoredSet.has(`${t.schema}.${t.name}`)
    );
    checks.push({
      name: "no missing tables",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? "all manifest tables present"
          : `missing: ${missing.map((t) => `${t.schema}.${t.name}`).join(", ")}`,
    });

    // 3. 备份时有数据的表,还原后不能是空的(最阴险的"备了半个库"故障)
    const emptied = manifest.database.tables.filter(
      (t) => t.estimatedRows > 0 && (counts.get(`${t.schema}.${t.name}`) ?? 0) === 0
    );
    checks.push({
      name: "populated tables came back",
      pass: emptied.length === 0,
      detail:
        emptied.length === 0
          ? "no populated table restored empty"
          : `restored empty despite manifest rows: ${emptied
              .map((t) => `${t.schema}.${t.name}`)
              .join(", ")}`,
    });

    return { checks, tableCount: restoredTables.length, rowTotal };
  } finally {
    await client.end();
  }
}

/**
 * Storage 完整性校验:从备份桶重新读回文件、比对 manifest 里记录的 sha256,
 * 证明备份的文件副本真实存在且未损坏。文件多时抽样(默认上限),避免大量 egress。
 */
async function verifyStorage(
  s3: S3Client,
  config: BackupConfig,
  manifest: Manifest,
  verifyAll: boolean
): Promise<DrillCheck> {
  const files = manifest.storage!.files;
  const sample = verifyAll ? files : files.slice(0, STORAGE_SAMPLE_CAP);
  // 备份写入时的键:<snapshot base>/storage/<bucket>/<key>,base 从 dump.key 反推
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");
  const mismatches: string[] = [];
  for (const f of sample) {
    const objectKey = `${base}/storage/${f.bucket}/${f.key}`;
    try {
      const { sha256 } = await hashObject(s3, config.storage.bucket, objectKey);
      if (sha256 !== f.sha256) mismatches.push(`${f.bucket}/${f.key}`);
    } catch {
      mismatches.push(`${f.bucket}/${f.key} (unreadable)`);
    }
  }
  const scope = verifyAll
    ? `all ${files.length}`
    : `${sample.length}/${files.length} sampled`;
  return {
    name: "storage file integrity",
    pass: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? `${scope} files match their manifest checksums`
        : `${mismatches.length} of ${scope} failed: ${mismatches.slice(0, 5).join(", ")}`,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 演练核心:把一份本地 dump 恢复进临时 Postgres 并对照 manifest 校验,然后销毁容器。
 * 与 S3 解耦,便于离线测试。`preChecks` 用于把下载阶段的校验(如归档校验和)带进报告。
 */
export async function drillDump(
  dumpPath: string,
  manifest: Manifest,
  snapshot: string,
  preChecks: DrillCheck[] = []
): Promise<DrillReport> {
  const checks: DrillCheck[] = [...preChecks];
  const major = parseInt(manifest.database.serverVersion, 10);
  const pg = await startEphemeralPostgres(major);
  try {
    const started = Date.now();
    log.step("Restoring into ephemeral Postgres…");
    const postData = await pgRestore(dumpPath, pg.connString);
    const restoreSeconds = Math.round((Date.now() - started) / 100) / 10;
    checks.push({ name: "pg_restore", pass: true, detail: `completed in ${restoreSeconds}s` });
    // 用户自己的 post-data 对象(索引/约束/触发器)必须全部恢复;Supabase 托管对象
    // 的沙箱预期跳过如实写进报告(演练不假装它们恢复了)。
    checks.push({
      name: "post-data objects",
      pass: postData.failures.length === 0,
      detail:
        postData.failures.length > 0
          ? `${postData.failures.length} failed: ${postData.failures[0]}`
          : postData.supabaseSkipped > 0
            ? `user objects restored; ${postData.supabaseSkipped} Supabase-managed object(s) skipped (auth schema/roles do not exist in the drill sandbox)`
            : "all post-data objects restored",
    });

    const verify = await verifyRestored(pg.connString, manifest);
    checks.push(...verify.checks);

    return {
      snapshot,
      pass: checks.every((c) => c.pass),
      checks,
      restoreSeconds,
      restoredTableCount: verify.tableCount,
      restoredRowTotal: verify.rowTotal,
    };
  } finally {
    log.step("Tearing down ephemeral Postgres…");
    await execFileAsync("docker", ["rm", "-f", pg.containerId]).catch(() => {});
  }
}

/** 演练一份快照:从桶里下载→drillDump(含 Storage 校验)→报告。 */
export async function runDrill(
  config: BackupConfig,
  opts: { snapshot?: string; verifyAllFiles?: boolean } = {}
): Promise<DrillReport> {
  const s3 = targetClient(config);
  const snapshotPrefix = await resolveSnapshot(s3, config, opts.snapshot);
  const snapshot = snapshotPrefix.replace(/\/$/, "").split("/").pop()!;
  log.step(`Drilling snapshot ${snapshot}`);

  const manifest = JSON.parse(
    await getObjectText(s3, config.storage.bucket, `${snapshotPrefix}manifest.json`)
  ) as Manifest;

  const workdir = await mkdtemp(join(tmpdir(), "backupdrill-"));
  const dumpPath = join(workdir, "dump.pgcustom");
  try {
    log.step("Downloading dump…");
    const { sha256: sha } = await downloadToFile(
      s3,
      config.storage.bucket,
      manifest.dump.key,
      dumpPath
    );
    const preChecks: DrillCheck[] = [
      {
        name: "archive integrity",
        pass: sha === manifest.dump.sha256,
        detail:
          sha === manifest.dump.sha256
            ? `sha256 matches (${sha.slice(0, 12)}…)`
            : `sha256 MISMATCH — got ${sha.slice(0, 12)}…, manifest ${manifest.dump.sha256.slice(0, 12)}…`,
      },
    ];

    // Storage 文件完整性(备份含 Storage 时才校验)
    if (manifest.storage && manifest.storage.files.length) {
      log.step("Verifying Storage files…");
      preChecks.push(
        await verifyStorage(s3, config, manifest, opts.verifyAllFiles ?? false)
      );
    }

    return await drillDump(dumpPath, manifest, snapshot, preChecks);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
