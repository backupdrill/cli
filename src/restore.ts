import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Client } from "pg";
import type { BackupConfig } from "./config.js";
import { parseManifest } from "./manifest.js";
import {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
} from "./snapshots.js";
import { restoreDatabaseArtifact, installExtensions } from "./restore-engine.js";
import { verifyRestored, type DrillCheck } from "./drill.js";
import { pgConnectOptions } from "./supabase-ca.js";
import { log } from "./log.js";

export interface RestoreResult {
  snapshot: string;
  restoredToDatabase: boolean;
  /** 表级验证结果(与演练同一套 verifyRestored);未恢复数据库时不存在 */
  databaseChecks?: DrillCheck[];
  /**
   * 验证总裁决(= databaseChecks 全 pass)。库级调用方(worker)必须看它,
   * 不能只看 restoredToDatabase——"恢复完成"与"恢复通过验证"是两个事实。
   */
  databaseVerified?: boolean;
  storageFilesWritten: number;
  storageDir?: string;
}

/**
 * restore 无源库配置时的占位连接串(纯 flag 驱动、没有 backupdrill.config.json 的场景)。
 * 同源阻断门对它不生效——没有可比对的源;有真实源配置时阻断门照常工作。
 */
export const NO_SOURCE_DATABASE = "postgresql://unused";

/**
 * 从连接串提取 Supabase 项目 ref(纯函数):直连主机 `db.<ref>.supabase.co` 或
 * pooler 用户名 `postgres.<ref>`。两种形态指向同一租户——只比 host/user 会漏掉
 * "源填直连、目标填 pooler"的同项目组合(评审第 7 轮)。非 Supabase 形态返回 null。
 */
export function projectRefOf(connString: string): string | null {
  try {
    const url = new URL(connString);
    const direct = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.co$/);
    if (direct) return direct[1];
    const pooled = url.username.match(/^postgres\.([a-z0-9]{16,})$/);
    if (pooled) return pooled[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * 两个连接串是否指向同一数据库租户(纯函数,可测)。
 * Supabase 双方以项目 ref 为准(直连/pooler 形态互认);其余退回 host+user 比对
 * ——只比 host 不够:pooler 主机是区域级共享的,租户身份在用户名里。
 * 任一解析失败 → false(pg 侧会给出自己的连接错误,这里不误伤)。
 */
export function sameDatabaseTarget(a: string, b: string): boolean {
  const refA = projectRefOf(a);
  const refB = projectRefOf(b);
  if (refA !== null && refB !== null) return refA === refB;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (!ua.hostname || !ub.hostname) return false;
    return ua.hostname === ub.hostname && ua.username === ub.username;
  } catch {
    return false;
  }
}

/**
 * 空目标门(PRD §5.3.3 / 决策 D5):目标 schema 里存在任何用户对象即拒绝写入。
 * "空"的定义来自 R0 spike:不是"schema 不存在"(Supabase 恒有 public),而是
 * schema 内零用户对象——关系、函数/过程、独立类型(enum/domain/range/composite)
 * 全部计入:只查关系时,"目标里只有函数"会放行,然后在 pre-data 中途撞冲突,
 * 留下半截目标(评审第 7 轮)。
 */
async function assertEmptyTarget(targetUrl: string, schemas: string[]): Promise<void> {
  const client = new Client(pgConnectOptions(targetUrl));
  await client.connect();
  try {
    const res = await client.query<{ n: string }>(
      `select
         (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = any($1::text[]) and c.relkind in ('r','p','m','v','S','f','c'))
       + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = any($1::text[]))
       + (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = any($1::text[]) and t.typtype in ('e','d','r'))
         as n`,
      [schemas]
    );
    const objectCount = Number(res.rows[0].n);
    if (objectCount > 0) {
      throw new Error(
        `target schema(s) ${schemas.join(", ")} contain ${objectCount} existing object(s) — ` +
          `restore only writes into an empty target. Create a fresh Supabase project ` +
          `(or empty these schemas) and retry.`
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * 把一份快照恢复出来:数据库经统一引擎还原进 --target-database-url(与演练同一条
 * pg_restore 路径与错误分类),恢复后跑同一套表级验证;Storage 文件下载到本地目录
 * (回传到新 Supabase 项目的自动化是 P0-D,未到)。这是 US-5 恢复向导的 CLI 形态。
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
  const manifest = parseManifest(
    await getObjectText(s3, config.storage.bucket, `${snapshotPrefix}manifest.json`)
  );
  const base = manifest.dump.key.replace(/\/dump\.pgcustom$/, "");

  const result: RestoreResult = {
    snapshot,
    restoredToDatabase: false,
    storageFilesWritten: 0,
  };

  const workdir = await mkdtemp(join(tmpdir(), "backupdrill-restore-"));
  try {
    // 1. 数据库(写入前依次过安全门:同源阻断 → 空目标 → 归档校验 → 扩展预装)
    if (opts.targetDatabaseUrl) {
      const targetUrl = opts.targetDatabaseUrl;
      // 同源阻断(PRD §9.3):恢复绝不写回备份的源库。误把生产源当目标是
      // 恢复流程里代价最不对称的失误。
      if (
        config.databaseUrl !== NO_SOURCE_DATABASE &&
        sameDatabaseTarget(config.databaseUrl, targetUrl)
      ) {
        throw new Error(
          "target database resolves to the same host and user as the backup source — " +
            "restoring onto the source project is blocked. Point --target-database-url " +
            "at a fresh Supabase project."
        );
      }

      log.step("Checking target is empty…");
      await assertEmptyTarget(targetUrl, manifest.database.schemas);

      log.step("Downloading dump…");
      const dumpPath = join(workdir, "dump.pgcustom");
      const { sha256 } = await downloadToFile(s3, config.storage.bucket, manifest.dump.key, dumpPath);
      // 归档完整性是恢复的前提:哈希不符还继续,只会把"备份坏了"变成一堆误导性
      // 恢复错误(演练侧同一裁决:integrity FAIL 即短路)
      if (sha256 !== manifest.dump.sha256) {
        throw new Error(
          `archive integrity check failed: downloaded sha256 ${sha256.slice(0, 12)}… ` +
            `does not match manifest ${manifest.dump.sha256.slice(0, 12)}… — refusing to restore a corrupted dump`
        );
      }

      // 扩展预装:沙箱装不上只能记录(环境局限),真实目标装不上必须阻断——
      // 用户在 dashboard 一键可开,恢复残缺副本则要人工收拾(引擎头注的裁决分工)
      const extensions = manifest.database.extensions ?? [];
      if (extensions.length) {
        log.step(`Installing ${extensions.length} extension(s) on target…`);
        const unavailable = await installExtensions(targetUrl, extensions);
        if (unavailable.length) {
          throw new Error(
            `target cannot install extension(s): ${unavailable.join(", ")} — enable them in ` +
              `the Supabase dashboard (Database → Extensions) and retry.`
          );
        }
      }

      log.step("Restoring database into target…");
      const engine = await restoreDatabaseArtifact({ dumpPath, connString: targetUrl, target: "supabase" });
      if (!engine.ok) {
        const failures = [...engine.preData.failures, ...engine.postData.failures];
        throw new Error(`database restore failed: ${failures.join(" | ")}`);
      }
      result.restoredToDatabase = true;

      // 与演练同一套表级验证:两条路径对同一快照必须同一结论(PRD §5.2 验收)
      log.step("Verifying restored tables…");
      const verified = await verifyRestored(targetUrl, manifest);
      result.databaseChecks = verified.checks;
      result.databaseVerified = verified.checks.every((c) => c.pass);
      for (const check of verified.checks) {
        (check.pass ? log.ok : log.warn)(`${check.name}: ${check.detail}`);
      }
      log.ok(
        `Database restored (${verified.tableCount} tables, ` +
          `${verified.rowTotal.toLocaleString()} rows)`
      );
    } else {
      log.warn("No --target-database-url given; skipping database restore.");
    }

    // 2. Storage 文件 → 本地目录
    if (manifest.storage && manifest.storage.files.length) {
      const outDir = opts.storageDir ?? join(process.cwd(), `restored-storage-${snapshot}`);
      // 输出目录必须是新的/空的:路径锚定检查是词法层面的,防不住目录里**已有**的
      // 符号链接把写入引到别处;保证目录从空开始 = 所有子路径都由本进程创建,无链接可循
      await mkdir(outDir, { recursive: true });
      if ((await readdir(outDir)).length > 0) {
        throw new Error(
          `storage output directory is not empty: ${outDir} — restore only writes into a fresh directory`
        );
      }
      log.step(`Downloading ${manifest.storage.files.length} Storage files → ${outDir}`);
      for (const f of manifest.storage.files) {
        const dest = join(outDir, f.bucket, f.key);
        // 纵深防御:parseManifest 已拒绝穿越段,这里仍锚定最终路径必须落在 outDir 内
        // ——两道防线独立失效才会发生"篡改的 manifest 写穿输出目录"
        if (!resolve(dest).startsWith(resolve(outDir) + sep)) {
          throw new Error(`unsafe storage path escapes output directory: ${f.bucket}/${f.key}`);
        }
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
