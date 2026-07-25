import { mkdtemp, mkdir, rm, readdir, lstat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Client } from "pg";
import type { BackupConfig } from "./config.js";
import { parseManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import {
  targetClient,
  resolveSnapshot,
  getObjectText,
  downloadToFile,
} from "./snapshots.js";
import {
  restoreDatabaseArtifact,
  installExtensions,
  projectRefOf,
  refFromStorageEndpoint,
  assertNoHostOverride,
  normalizeHost,
} from "./restore-engine.js";
import { verifyRestored, type DrillCheck } from "./drill.js";
import {
  restoreStorage,
  type StorageRestoreSummary,
  type StorageRestoreTarget,
} from "./storage-restore.js";
import { pgConnectOptions } from "./supabase-ca.js";
import { resolvePgRestoreBin } from "./pgbin.js";
import { parsePgDumpMajor } from "./backup.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

/** 本地 pg_restore 主版本(拿不到 → null,由引擎自己的报错兜底)。 */
async function localPgRestoreMajor(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(resolvePgRestoreBin(), ["--version"]);
    return parsePgDumpMajor(stdout.trim());
  } catch {
    return null;
  }
}

/** 归档可读性要求:pg_restore 必须 ≥ max(写入工具版本, 源服务端版本)——格式跟随写入工具。 */
export function requiredRestoreToolMajor(manifest: Manifest): number {
  return Math.max(
    parsePgDumpMajor(manifest.database.pgDumpVersion) ?? 0,
    parseInt(manifest.database.serverVersion, 10) || 0
  );
}

export interface RestoreResult {
  snapshot: string;
  /** dry-run:只做只读预检,未发生任何写入 */
  dryRun?: boolean;
  restoredToDatabase: boolean;
  /** 表级验证结果(与演练同一套 verifyRestored);未恢复数据库时不存在 */
  databaseChecks?: DrillCheck[];
  /**
   * 验证总裁决(= databaseChecks 全 pass)。库级调用方(worker)必须看它,
   * 不能只看 restoredToDatabase——"恢复完成"与"恢复通过验证"是两个事实。
   */
  databaseVerified?: boolean;
  /** Storage 回传摘要(提供了目标 Storage 凭据时);本地下载模式不存在 */
  storageSummary?: StorageRestoreSummary;
  storageFilesWritten: number;
  storageDir?: string;
}

/**
 * restore 无源库配置时的占位连接串(纯 flag 驱动、没有 backupdrill.config.json 的场景)。
 * 同源阻断门对它不生效——没有可比对的源;有真实源配置时阻断门照常工作。
 */
export const NO_SOURCE_DATABASE = "postgresql://unused";

// projectRefOf 上移到引擎层(备份端写 manifest.sourceProjectRef 也要用);此处转出口
export { projectRefOf } from "./restore-engine.js";

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
    // 用户名按驱动语义(解码后)比较,与 projectRefOf 同一口径
    return (
      normalizeHost(ua.hostname) === normalizeHost(ub.hostname) &&
      decodeURIComponent(ua.username) === decodeURIComponent(ub.username)
    );
  } catch {
    return false;
  }
}

/**
 * 从目标 Project URL(https://<ref>.supabase.co)提取 ref。 */
export function refFromSupabaseUrl(supabaseUrl: string): string | null {
  try {
    const match = normalizeHost(new URL(supabaseUrl).hostname).match(/^([a-z0-9]{16,})\.supabase\.co$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 目标 Storage URL 的严格校验:必须是 https 且恰为 <ref>.supabase.co 源(无路径/查询)。
 * service-role key 会作为请求头发往这个地址——校验必须发生在**第一次 fetch 之前**,
 * 否则任意主机(或明文 http)都能收到 key(评审第 8 轮)。返回规范化 origin。
 */
export function validateStorageTargetOrigin(supabaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    throw new Error(`--target-supabase-url is not a valid URL: ${supabaseUrl}`);
  }
  const ref = normalizeHost(url.hostname).match(/^([a-z0-9]{16,})\.supabase\.co$/);
  if (url.protocol !== "https:" || !ref || (url.pathname !== "/" && url.pathname !== "") || url.search) {
    throw new Error(
      `--target-supabase-url must be exactly https://<project-ref>.supabase.co — got "${supabaseUrl}". ` +
        `The service-role key is only ever sent to a verified Supabase project origin.`
    );
  }
  return url.origin;
}

// assertNoHostOverride 上移到引擎层(备份侧的源身份自记也要用);此处转出口
export { assertNoHostOverride } from "./restore-engine.js";

/**
 * 备份配置能导出的全部源项目 ref:数据库连接串 + Storage 读取端点
 * (https://<ref>.storage.supabase.co/...)。storage-only 恢复没有目标库连接串,
 * 同源阻断必须同样覆盖"目标 Storage = 源项目"的组合(评审第 8 轮)。
 */
export function sourceProjectRefs(config: BackupConfig, manifest?: Manifest): Set<string> {
  const refs = new Set<string>();
  if (config.databaseUrl !== NO_SOURCE_DATABASE) {
    const ref = projectRefOf(config.databaseUrl);
    if (ref) refs.add(ref);
  }
  const endpoint = config.supabaseStorage?.endpoint;
  if (endpoint) {
    const ref = refFromStorageEndpoint(endpoint);
    if (ref) refs.add(ref);
  }
  // manifest 自记的源 ref(评审第 9 轮):纯 flag 恢复没有 config 可比对,
  // 快照自己就是最后一道源身份来源
  if (manifest?.sourceProjectRef) refs.add(manifest.sourceProjectRef);
  return refs;
}

/**
 * 请求与快照内容必须相交(评审第 15 轮,纯函数可测):什么都不会做的调用
 * 不得走到"Restore complete"——自动化会把 no-op 记成一次成功恢复。
 */
export function assertRequestApplies(
  manifest: Manifest,
  wantsDatabase: boolean,
  wantsStorageUpload: boolean
): void {
  if (wantsStorageUpload && manifest.storage === null) {
    throw new Error(
      "this snapshot is database-only — there is no Storage to upload. Drop --target-supabase-url " +
        "(and pass --database if the database restore is what you want)."
    );
  }
  if (!wantsDatabase && !wantsStorageUpload && manifest.storage === null) {
    throw new Error(
      "nothing to do: no database restore was requested (--database) and this snapshot has no " +
        "Storage files to download."
    );
  }
}

/**
 * 正式执行的确认门(PRD §5.3.3):用户必须键入目标 project ref(或非 Supabase 目标的
 * 主机名)与实际连接目标一致。误把生产源当目标是恢复流程里代价最不对称的失误,
 * 这道门要求人把目标身份亲手打一遍。
 */
export function assertConfirmedTarget(
  confirmTarget: string | undefined,
  targetDatabaseUrl?: string,
  targetSupabaseUrl?: string
): void {
  const dbRef = targetDatabaseUrl ? projectRefOf(targetDatabaseUrl) : null;
  const apiRef = targetSupabaseUrl ? refFromSupabaseUrl(targetSupabaseUrl) : null;
  // 两个入口都给了且指向不同项目 → 直接硬错,和确认无关
  if (dbRef && apiRef && dbRef !== apiRef) {
    throw new Error(
      `the target database URL points at project "${dbRef}" but --target-supabase-url at "${apiRef}" — ` +
        `these are different projects; fix one of them.`
    );
  }
  // 外部(非 Supabase)库目标 + Supabase Storage 目标:一个确认值盖不住两个不相干
  // 的目标(评审第 12 轮)——这种混搭直接拒绝,分两次跑各自确认
  if (targetDatabaseUrl && !dbRef && apiRef) {
    throw new Error(
      "the database target is not a Supabase project while the Storage target is — one confirmation " +
        "cannot cover two unrelated targets. Run the database restore and the Storage restore separately."
    );
  }
  let expected = dbRef ?? apiRef;
  if (!expected && targetDatabaseUrl) {
    try {
      expected = new URL(targetDatabaseUrl).hostname || null;
    } catch {
      expected = null;
    }
  }
  if (!expected) {
    throw new Error(
      "cannot derive the target's identity from the given URLs — refusing to write without a confirmable target."
    );
  }
  if (confirmTarget !== expected) {
    throw new Error(
      `restore writes to target "${expected}" — confirm by re-running with --confirm-target ${expected} ` +
        `(use --dry-run first to preview all checks without writing).`
    );
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
          `(or empty these schemas) and retry. If a previous run already restored the ` +
          `database and only Storage was interrupted, re-run WITHOUT the database target ` +
          `to retry Storage alone.`
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * dry-run 只读预检(PRD §5.3.2):零写入,把正式执行会撞的墙全部提前撞一遍。
 * 逐项打印,任何 blocker 汇总后抛出(退出码非零 = "现在执行不会成功")。
 */
async function dryRunPreflight(
  config: BackupConfig,
  manifest: Manifest,
  targetUrl: string | undefined,
  storageTarget: StorageRestoreTarget | null
): Promise<void> {
  const blockers: string[] = [];
  const db = manifest.database;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  log.ok(
    `coverage: schemas ${db.schemas.join(", ")} — ${db.tableCount} tables, ` +
      `~${db.estimatedRowTotal.toLocaleString()} rows, dump ${mb(manifest.dump.bytes)} MB`
  );
  log.ok(
    manifest.storage
      ? `storage: ${manifest.storage.fileCount} files, ${mb(manifest.storage.totalBytes)} MB` +
          (manifest.storage.buckets ? `, ${manifest.storage.buckets.length} bucket(s) with attributes` : ", bucket attributes not captured")
      : "storage: none (database-only snapshot)"
  );
  log.warn(
    "not covered: Auth users/sessions, secret values, Edge Functions, most platform settings"
  );

  // 双目标一致性(dry-run 也要查,不能绿灯放行到正式执行才拒):库与 Storage
  // 两个入口指向不同项目 = 配置错了一个
  const dbRef = targetUrl ? projectRefOf(targetUrl) : null;
  const apiRef = storageTarget ? refFromSupabaseUrl(storageTarget.supabaseUrl) : null;
  if (dbRef && apiRef && dbRef !== apiRef) {
    blockers.push(`database URL targets "${dbRef}" but Storage URL targets "${apiRef}"`);
    log.error(`target consistency: database → ${dbRef}, storage → ${apiRef} — different projects`);
  } else if (dbRef || apiRef) {
    log.ok(`target project: ${dbRef ?? apiRef}`);
  }

  if (targetUrl) {
    if (config.databaseUrl !== NO_SOURCE_DATABASE && sameDatabaseTarget(config.databaseUrl, targetUrl)) {
      blockers.push("target database is the backup SOURCE (same project)");
      log.error("target identity: SAME AS SOURCE — would be blocked");
    } else {
      log.ok("target identity: distinct from source");
    }
    try {
      await assertEmptyTarget(targetUrl, db.schemas);
      log.ok(`target schemas (${db.schemas.join(", ")}) are empty`);
    } catch (error) {
      blockers.push((error as Error).message);
      log.error(`empty-target check: ${(error as Error).message}`);
    }
    const client = new Client(pgConnectOptions(targetUrl));
    await client.connect();
    try {
      // SHOW 的结果列名是 server_version;用 current_setting 显式起别名,
      // 否则取错列得 NaN,而 NaN < x 恒 false = 版本降级永远查不出来
      const version = await client.query<{ v: string }>(
        "select current_setting('server_version') as v"
      );
      const targetMajor = parseInt(version.rows[0].v, 10);
      const sourceMajor = parseInt(db.serverVersion, 10);
      if (!Number.isFinite(targetMajor)) {
        blockers.push(`cannot determine target PostgreSQL version (got "${version.rows[0].v}")`);
        log.error("postgres version: undeterminable — refusing to guess");
      } else if (targetMajor < sourceMajor) {
        blockers.push(`target PostgreSQL ${targetMajor} < source ${sourceMajor}`);
        log.error(`postgres version: target ${targetMajor} < source ${sourceMajor} — would fail`);
      } else {
        log.ok(`postgres version: target ${targetMajor} ≥ source ${sourceMajor}`);
      }
      const toolMajor = await localPgRestoreMajor();
      const requiredMajor = requiredRestoreToolMajor(manifest);
      if (toolMajor === null) {
        blockers.push("local pg_restore missing or version unparseable");
        log.error("pg_restore tool: not found / version unparseable — set BACKUPDRILL_PG_RESTORE");
      } else if (toolMajor < requiredMajor) {
        blockers.push(`local pg_restore v${toolMajor} < archive requirement v${requiredMajor}`);
        log.error(`pg_restore tool: local v${toolMajor} cannot read a v${requiredMajor} archive`);
      } else {
        log.ok(`pg_restore tool: local v${toolMajor} ≥ archive requirement v${requiredMajor}`);
      }
      const extensions = db.extensions ?? [];
      if (extensions.length) {
        const available = await client.query<{ name: string }>(
          `select name from pg_available_extensions where name = any($1::text[])`,
          [extensions.map((e) => e.name)]
        );
        const availableNames = new Set(available.rows.map((r) => r.name));
        const missing = extensions.filter((e) => !availableNames.has(e.name)).map((e) => e.name);
        if (missing.length) {
          blockers.push(`extensions unavailable on target: ${missing.join(", ")}`);
          log.error(`extensions: ${missing.join(", ")} unavailable — enable in dashboard first`);
        } else {
          log.ok(`extensions: all ${extensions.length} available on target`);
        }
      }
    } finally {
      await client.end();
    }
  } else {
    log.warn("no target database URL — database restore would be skipped");
  }

  if (storageTarget) {
    const res = await fetch(`${storageTarget.supabaseUrl}/storage/v1/bucket`, {
      headers: {
        Authorization: `Bearer ${storageTarget.serviceRoleKey}`,
        apikey: storageTarget.serviceRoleKey,
      },
    });
    if (res.ok) {
      log.ok("target Storage API reachable (service key accepted)");
    } else {
      blockers.push(`target Storage API returned HTTP ${res.status}`);
      log.error(`target Storage API: HTTP ${res.status} — check the URL and service-role key`);
    }
  } else if (manifest.storage) {
    log.warn("no Storage target credentials — files would be downloaded locally, not uploaded");
  }

  if (blockers.length) {
    throw new Error(
      `dry run found ${blockers.length} blocker(s):\n  - ${blockers.join("\n  - ")}`
    );
  }
  log.ok("dry run passed — nothing was written; re-run with --confirm-target to execute");
}

/**
 * 把一份快照恢复出来:数据库经统一引擎还原进目标(与演练同一条 pg_restore 路径与
 * 错误分类),恢复后跑同一套表级验证;Storage 提供目标凭据时回传+对账(P0-D),
 * 否则下载到本地目录。这是 US-5 恢复向导的 CLI 形态。
 */
export async function runRestore(
  config: BackupConfig,
  opts: {
    targetDatabaseUrl?: string;
    targetSupabaseUrl?: string;
    targetServiceRoleKey?: string;
    confirmTarget?: string;
    dryRun?: boolean;
    /** 源身份不可考(v1 快照 + 无配置)时的显式风险认知——没有它一律拒绝写入 */
    acknowledgeUnverifiedSource?: boolean;
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

  // Storage 目标构造即校验(https + 恰为 <ref>.supabase.co):service key 只发往
  // 已验证的 Supabase 项目源;目标库连接串拒绝 host 覆盖(身份判定=实际写入目标)
  // 两个字段必须成对:只给其一时静默退回"本地下载"会让库级调用方把受保护文件
  // 写进 worker 本地目录还以为回传成功了(评审第 9 轮)
  if (!!opts.targetSupabaseUrl !== !!opts.targetServiceRoleKey) {
    throw new Error(
      "targetSupabaseUrl and targetServiceRoleKey must be provided together — " +
        "refusing to silently fall back to a local download."
    );
  }
  const storageTarget: StorageRestoreTarget | null =
    opts.targetSupabaseUrl && opts.targetServiceRoleKey
      ? {
          supabaseUrl: validateStorageTargetOrigin(opts.targetSupabaseUrl),
          serviceRoleKey: opts.targetServiceRoleKey,
        }
      : null;
  if (opts.targetDatabaseUrl) assertNoHostOverride(opts.targetDatabaseUrl);

  // 同源阻断(统一收口):目标(库或 Storage)的 ref 命中任何源项目 ref → 拒绝。
  // 覆盖 storage-only 组合:目标 Storage = 备份读取源的项目时,upsert 会改写源。
  const sourceRefs = sourceProjectRefs(config, manifest);
  const targetRefs = [
    opts.targetDatabaseUrl ? projectRefOf(opts.targetDatabaseUrl) : null,
    opts.targetSupabaseUrl ? refFromSupabaseUrl(opts.targetSupabaseUrl) : null,
  ].filter((r): r is string => r !== null);
  for (const ref of targetRefs) {
    if (sourceRefs.has(ref)) {
      throw new Error(
        `target project "${ref}" is the backup SOURCE — restoring onto the source is blocked. ` +
          `Point the restore at a fresh Supabase project.`
      );
    }
  }
  // 源身份必须**对每类目标可比**才算已知(评审第 10/14 轮):
  //  - 库目标:有真实源连接串即可(host+user 逐一可比),或有 ref;
  //  - Storage 目标:只有 ref 能比(无关的外部 DATABASE_URL 不构成 Storage 侧身份)。
  // 不可比 + 未显式认知风险 = 拒绝,不 fail-open。
  const refIdentityKnown = sourceRefs.size > 0;
  const dbIdentityComparable = config.databaseUrl !== NO_SOURCE_DATABASE || refIdentityKnown;
  const unverifiable =
    (opts.targetDatabaseUrl && !dbIdentityComparable) || (storageTarget && !refIdentityKnown);
  if (unverifiable && !opts.acknowledgeUnverifiedSource) {
    throw new Error(
      "source identity cannot be verified for every requested target (legacy snapshot without a " +
        "comparable source record) — same-source protection would be inert. Restore with the original " +
        "backup config (-c backupdrill.config.json), or pass --acknowledge-unverified-source after " +
        "double-checking the target is NOT the original project."
    );
  }

  const result: RestoreResult = {
    snapshot,
    restoredToDatabase: false,
    storageFilesWritten: 0,
  };

  assertRequestApplies(manifest, !!opts.targetDatabaseUrl, !!storageTarget);

  // dry-run:只读预检后直接返回,零写入(PRD §5.3.2)
  if (opts.dryRun) {
    log.step(`Dry run for snapshot ${snapshot} — nothing will be written`);
    await dryRunPreflight(config, manifest, opts.targetDatabaseUrl, storageTarget);
    result.dryRun = true;
    return result;
  }

  // 正式执行的确认门(PRD §5.3.3):任何目标写入(库或 Storage)之前
  if (opts.targetDatabaseUrl || storageTarget) {
    assertConfirmedTarget(opts.confirmTarget, opts.targetDatabaseUrl, opts.targetSupabaseUrl);
  }

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
            "restoring onto the source project is blocked. Point BACKUPDRILL_TARGET_DATABASE_URL " +
            "at a fresh Supabase project."
        );
      }

      log.step("Checking target is empty…");
      await assertEmptyTarget(targetUrl, manifest.database.schemas);

      // 版本预检不只属于 dry-run:跳过 dry-run 直接执行时,目标比源旧照样会
      // 半途炸掉或部分恢复(评审第 8 轮)——写入前必须拦住
      const versionClient = new Client(pgConnectOptions(targetUrl));
      await versionClient.connect();
      let targetMajor: number;
      try {
        const res = await versionClient.query<{ v: string }>(
          "select current_setting('server_version') as v"
        );
        targetMajor = parseInt(res.rows[0].v, 10);
      } finally {
        await versionClient.end();
      }
      const sourceMajor = parseInt(manifest.database.serverVersion, 10);
      if (!Number.isFinite(targetMajor) || targetMajor < sourceMajor) {
        throw new Error(
          `target PostgreSQL (${Number.isFinite(targetMajor) ? targetMajor : "undeterminable"}) is older ` +
            `than the source (${sourceMajor}) — pg_restore would fail or partially restore. ` +
            `Create the target on PostgreSQL ${sourceMajor} or newer.`
        );
      }

      // 本地工具闸(评审第 10 轮):dump 归档格式跟随写入工具版本,老 pg_restore
      // 读不了新归档——不查的话会先装完扩展再在恢复中途才炸
      const toolMajor = await localPgRestoreMajor();
      const requiredMajor = requiredRestoreToolMajor(manifest);
      // 查不到版本(pg_restore 缺失/输出不可解析)= fail-closed:不能先装扩展改了目标,
      // 才发现根本没有可用的恢复工具(评审第 11 轮)
      if (toolMajor === null) {
        throw new Error(
          `cannot determine the local pg_restore version — install postgresql client ${requiredMajor}+ ` +
            `and/or point BACKUPDRILL_PG_RESTORE at it before restoring.`
        );
      }
      if (toolMajor < requiredMajor) {
        throw new Error(
          `local pg_restore is v${toolMajor} but this archive needs v${requiredMajor}+ ` +
            `(archive format follows the writing tool). Install postgresql client ${requiredMajor}+ ` +
            `and/or point BACKUPDRILL_PG_RESTORE at it.`
        );
      }

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
      log.warn("No database target (--database + BACKUPDRILL_TARGET_DATABASE_URL); skipping database restore.");
    }

    // 2a. Storage → 目标项目回传(P0-D:给了目标 Storage 凭据时)
    if (manifest.storage && storageTarget) {
      const summary = await restoreStorage(
        { s3, bucket: config.storage.bucket, base },
        storageTarget,
        manifest
      );
      result.storageSummary = summary;
      result.storageFilesWritten = summary.filesUploaded;
      log.ok(
        `Storage restored: ${summary.filesUploaded}/${manifest.storage.files.length} files uploaded` +
          (summary.filesSkippedIdentical
            ? `, ${summary.filesSkippedIdentical} already present (identical size)`
            : "") +
          ` (${(summary.bytesUploaded / 1024 / 1024).toFixed(1)} MB), ` +
          `buckets created ${summary.bucketsCreated.length} / existing ${summary.bucketsExisting.length}`
      );
      if (summary.bucketsWithoutAttrs.length) {
        log.warn(
          `bucket attributes not captured for: ${summary.bucketsWithoutAttrs.join(", ")} — ` +
            `created with defaults; review public/size/MIME settings by hand`
        );
      }
      for (const failed of summary.filesFailed.slice(0, 5)) {
        log.warn(`file failed: ${failed.file} — ${failed.reason}`);
      }
      if (summary.filesFailed.length > 5) {
        log.warn(`…and ${summary.filesFailed.length - 5} more file failure(s)`);
      }
      for (const drift of summary.bucketAttrDrift) {
        log.warn(`bucket attribute drift: ${drift}`);
      }
      for (const note of summary.metadataNotes) {
        log.warn(`metadata: ${note}`);
      }
      if (summary.retries) log.warn(`transient failures retried: ${summary.retries}`);
      const rec = summary.reconcile;
      (rec.matches ? log.ok : log.error)(
        `reconcile: ${rec.verified}/${manifest.storage.files.length} file(s) present with matching size` +
          (rec.missing.length ? `; MISSING: ${rec.missing.slice(0, 5).join(", ")}` : "") +
          (rec.sizeMismatched.length ? `; SIZE MISMATCH: ${rec.sizeMismatched.slice(0, 5).join(", ")}` : "") +
          (rec.extras ? `; ${rec.extras} extra object(s) on target not in this snapshot` : "")
      );
      if (summary.checksumSample.checked) {
        (summary.checksumSample.mismatched.length === 0 ? log.ok : log.error)(
          `checksum sample: ${summary.checksumSample.checked} file(s) re-hashed from target` +
            (summary.checksumSample.mismatched.length
              ? `, MISMATCH: ${summary.checksumSample.mismatched.join(", ")}`
              : ", all match")
        );
      }
      log.warn(summary.ownerNote);
    } else if (manifest.storage && manifest.storage.files.length) {
      const outDir = opts.storageDir ?? join(process.cwd(), `restored-storage-${snapshot}`);
      // 输出目录必须是新的/空的:路径锚定检查是词法层面的,防不住目录里**已有**的
      // 符号链接把写入引到别处;保证目录从空开始 = 所有子路径都由本进程创建,无链接可循
      // 根路径若已存在,必须是真目录:mkdir/readdir/词法锚定都会跟随根上的符号链接,
      // 一条预置的 link 就能把"新目录"指到别处(评审第 12 轮)
      const rootStat = await lstat(outDir).catch(() => null);
      if (rootStat && !rootStat.isDirectory()) {
        throw new Error(`storage output path exists and is not a real directory: ${outDir}`);
      }
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
