import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { promisify } from "node:util";
import type { BackupConfig } from "./config.js";
import { s3SnapshotStore, type DumpUpload, type SnapshotStore, type SnapshotWriter } from "./snapshot-store.js";
import { MANIFEST_SCHEMA_VERSION } from "./manifest.js";
import type { AuthSection, BucketAttrs, ExtensionInfo, Manifest, TableStat } from "./manifest.js";
import {
  AUTH_DUMP_MAX_BYTES,
  authDumpArgs,
  exportSharedSnapshot,
  inspectAuth,
  schemasMayIncludeAuth,
  unbackedAuthDependencies,
  type AuthMode,
  type SharedSnapshot,
} from "./auth-backup.js";
import { syncStorage } from "./storage.js";
import { inspectBucketAttrs } from "./storage-catalog.js";
import { projectRefOf, refFromStorageEndpoint, assertNoHostOverride } from "./restore-engine.js";
import { log } from "./log.js";
import { TOOL_VERSION } from "./version.js";
import { parsePgDumpMajor } from "./pgbin.js";
import { relationBytes } from "./estimate.js";
import { captureIdentifiedGrants, grantsHeldThroughout, type IdentifiedGrants } from "./grants.js";

// 解析函数搬到了 pgbin(演练与恢复都要读 pg_restore 版本,放这里会成环);保留旧出口
export { parsePgDumpMajor };
import { dumpUrlFor, connectPg, isSupabaseHost } from "./supabase-ca.js";
import { credentialSafeDbArgs, libpqChildEnv, urlSslModeOf } from "./restore-engine.js";

const execFileAsync = promisify(execFile);

function majorOf(serverVersionNum: number): number {
  // server_version_num: 150004 → 15,  170002 → 17
  return Math.floor(serverVersionNum / 10000);
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
  /** 要转储的表的磁盘占用;量不出来时为 null(只影响分片大小,不影响备份本身) */
  relationBytes: number | null;
}

async function inspectDatabase(
  databaseUrl: string,
  schemas: string[]
): Promise<DbFacts> {
  // Supabase 主机 → 用打包的根 CA 做 verify-full(pooler 证书自签、不在系统信任库);
  // 非 Supabase(本 CLI 不限制目标)→ 保持默认,别把开源用户挡在门外
  const client = await connectPg(databaseUrl);
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
    // 量体积失败不该让备份失败:分片退回保底值,200 GiB 以内的转储照常上传
    let measuredBytes: number | null = null;
    try {
      measuredBytes = await relationBytes(client, schemas);
    } catch (error) {
      log.warn(
        `Could not measure database size (${(error as Error).message}); ` +
          `uploading with the baseline part size, which fits a dump of up to 200 GiB.`
      );
    }
    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number(versionNum.rows[0].server_version_num),
      tables: tables.rows.map((r) => ({
        schema: r.schema,
        name: r.name,
        estimatedRows: Number(r.estimated_rows),
      })),
      extensions: extensions.rows,
      relationBytes: measuredBytes,
    };
  } finally {
    await client.end();
  }
}

async function readGrants(databaseUrl: string, schemas: string[]): Promise<IdentifiedGrants[]> {
  const client = await connectPg(databaseUrl);
  try {
    return await captureIdentifiedGrants(client, schemas);
  } finally {
    await client.end();
  }
}

/** 主 dump 的 pg_dump 参数。snapshotId 省略时与 2.10.0 之前逐字一致(Auth 关闭时就是这样) */
export function mainDumpArgs(schemas: string[], snapshotId?: string): string[] {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    ...(snapshotId ? [`--snapshot=${snapshotId}`] : []),
    ...schemas.map((s) => `--schema=${s}`),
  ];
}

class AuthDumpTooLarge extends Error {}

/**
 * 流式跑 pg_dump,边写快照边算 sha256 与字节数。返回校验和与大小。
 * onFirstByte:pg_dump 先导入快照才会吐出第一个字节,调用方据此尽早释放导出快照的连接。
 * maxBytes:超过就中止(只用于 auth.dump)。
 */
async function streamPgDump(opts: {
  databaseUrl: string;
  pgDumpBin: string;
  args: string[];
  upload: (body: Readable) => DumpUpload;
  onFirstByte?: () => void;
  maxBytes?: number;
  signal?: AbortSignal;
  endOnlyOnSuccess?: boolean;
}): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (bytes === 0) opts.onFirstByte?.();
      hash.update(chunk);
      bytes += chunk.length;
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
        cb(new AuthDumpTooLarge(`archive is larger than ${opts.maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });

  // pg_dump(libpq):Supabase 主机才改写成 sslmode=verify-full + sslrootcert=<打包CA临时文件>
  // 凭据不进 argv(D6):argv 对同机任何进程的 `ps` 可见。与恢复路径同一个函数——
  // 先改写 SSL 再拆密码,密码经 PGPASSWORD 交给 libpq
  const { url: dumpDbUrl, env: credentialEnv } = credentialSafeDbArgs(dumpUrlFor(opts.databaseUrl));
  const dump = spawn(
    opts.pgDumpBin,
    [...opts.args, "--dbname", dumpDbUrl],
    // 环境剔除改写目标/身份的 PG* 变量:pg_dump 只认 --dbname 里的 URL(TLS 策略等保留)
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: libpqChildEnv(credentialEnv, process.env, {
        supabaseHost: isSupabaseHost(opts.databaseUrl),
        urlSslMode: urlSslModeOf(dumpDbUrl),
      }),
    }
  );
  // 调用方要求停下(例如主 dump 失败了,并行的 auth dump 不必再跑):杀掉 pg_dump,下面的 catch 负责中止上传
  const onAbort = () => dump.kill("SIGKILL");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  dump.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  // endOnlyOnSuccess(auth.dump 用):pg_dump 成功退出才结束上传流,失败就带错中断,上传因此完不成——
  // 不在用户桶里留下一个空的或半截的 auth.dump。主 dump 不传这个选项,行为与之前一致
  dump.stdout.pipe(meter, { end: !opts.endOnlyOnSuccess });
  if (opts.endOnlyOnSuccess) {
    dump.on("close", (code) => {
      if (code === 0) meter.end();
      else meter.destroy(new Error(`pg_dump exited with code ${code}`));
    });
  }

  const dumpDone = new Promise<void>((resolve, reject) => {
    dump.on("error", reject); // 启动失败(如 ENOENT)
    dump.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`))
    );
  });

  // 失败双向联动:dump 失败要中止上传(绝不把半截转储当成功);上传失败也必须
  // 杀掉 pg_dump —— 否则上传侧停止消费后,背压会让 pg_dump 永远阻塞在 stdout
  // 写入上,调用方(worker 的串行队列)随之永久挂起。Promise.all 会订阅两侧,
  // 先失败的一方抛出后,另一方稍后的 rejection 也已被视为 handled。
  // 开始上传也放进 try:实现可能在建上传时就同步抛错,那时 pg_dump 已经在跑,同样要杀掉。
  let upload: DumpUpload | null = null;
  try {
    upload = opts.upload(meter);
    await Promise.all([dumpDone, upload.done]);
  } catch (error) {
    dumpDone.catch(() => {}); // 没走到 Promise.all 时,被杀的 pg_dump 的退出也得有人接住
    dump.kill("SIGKILL");
    meter.destroy();
    await upload?.abort().catch(() => {});
    // 超限时先失败的往往是上传那一侧(流被 meter 报错中断),原因统一报成超限
    if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
      throw new AuthDumpTooLarge(`archive is larger than ${opts.maxBytes} bytes`);
    }
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  return { bytes, sha256: hash.digest("hex") };
}

type ReadableAuth = Extract<Awaited<ReturnType<typeof inspectAuth>>, { readable: true }>;

/** 主 dump 完成后还肯等 Auth 导出多久 */
const AUTH_WAIT_AFTER_MAIN_MS = 10 * 60 * 1000;

/** 做不了 Auth 备份时记什么:默认开启记 skipped(不算失败);显式要求记 failed */
function authNotDone(mode: AuthMode, reason: string): AuthSection {
  return mode === "on" ? { status: "failed", reason } : { status: "skipped", reason };
}

const AUTH_SKIP_TEXT: Record<string, string> = {
  no_permission:
    "the backup role can't read every row of auth.users and auth.identities (it needs BYPASSRLS or superuser, plus read access)",
  no_auth_schema: "this database has no Supabase auth schema",
  unsupported_destination: "this backup destination can't hold the Auth archive yet",
  schemas_may_include_auth: "your schema list already includes auth (or a pattern), so it is in the main dump",
  too_large: "the Auth archive is larger than 2 GiB",
  snapshot_unavailable: "a consistent snapshot for the Auth export couldn't be set up",
};

/** 报错只留第一行、截短:pg_dump / 上传的错误不该把大段原文(更不能是行值)带进 manifest 和告警 */
function shortReason(error: unknown): string {
  return String((error as Error)?.message ?? error).split("\n")[0].slice(0, 300);
}

type AuthPlan =
  | { kind: "none" }
  | { kind: "settled"; section: AuthSection }
  | { kind: "dump"; shared: SharedSnapshot; inspection: ReadableAuth; key: string; upload: (body: Readable) => DumpUpload };

/**
 * 决定这次要不要、能不能另外备 Auth。任何"不能"都在这里落成 skipped/failed,不抛错——
 * 主 dump 永远不因 Auth 受影响。返回 dump 时,共享快照已经导出,调用方负责释放。
 */
async function planAuth(config: BackupConfig, writer: SnapshotWriter, mode: AuthMode): Promise<AuthPlan> {
  if (mode === "off") return { kind: "none" };
  // schemas 已经(可能)把 auth 带进主 dump:今天怎样以后还怎样,不另备一份,也不算失败
  if (schemasMayIncludeAuth(config.schemas)) {
    return { kind: "settled", section: { status: "skipped", reason: "schemas_may_include_auth" } };
  }
  if (!writer.uploadAuthDump || !writer.authDumpKey) {
    return { kind: "settled", section: authNotDone(mode, "unsupported_destination") };
  }
  const shared = await exportSharedSnapshot(config.databaseUrl);
  if (!shared) return { kind: "settled", section: authNotDone(mode, "snapshot_unavailable") };
  let inspection: Awaited<ReturnType<typeof inspectAuth>>;
  try {
    inspection = await inspectAuth(config.databaseUrl, shared.id);
  } catch (error) {
    await shared.release();
    // 导入快照失败(经连接池时最可能)按"快照不可用"跳过;其余是统计查询本身出错
    const section = /snapshot/i.test(shortReason(error))
      ? authNotDone(mode, "snapshot_unavailable")
      : ({ status: "failed", reason: `could not inspect the Auth tables: ${shortReason(error)}` } as AuthSection);
    return { kind: "settled", section };
  }
  if (!inspection.readable) {
    await shared.release();
    return { kind: "settled", section: authNotDone(mode, inspection.reason) };
  }
  const uploadAuthDump = writer.uploadAuthDump.bind(writer);
  return { kind: "dump", shared, inspection, key: writer.authDumpKey, upload: (body) => uploadAuthDump(body) };
}

/**
 * 主 dump 和 auth dump 并行,都导入同一个共享快照。两份都吐出第一个字节(= 都已导入快照)后
 * 立刻释放导出快照的连接,所以它只占几秒,和主 dump 多大无关。
 * Auth 一侧失败只影响 Auth 段;主 dump 因导入快照失败而一个字节都没写出时,按今天的方式重导一次。
 */
async function dumpWithAuth(
  config: BackupConfig,
  writer: SnapshotWriter,
  pgDumpBin: string,
  relationBytes: number | null,
  mode: AuthMode,
  plan: Extract<AuthPlan, { kind: "dump" }>
): Promise<{ main: { bytes: number; sha256: string }; auth: AuthSection }> {
  const { shared, inspection } = plan;
  let mainStarted = false;
  let markMainStarted!: () => void;
  let markAuthStarted!: () => void;
  const mainStartedP = new Promise<void>((resolve) => (markMainStarted = resolve));
  const authStartedP = new Promise<void>((resolve) => (markAuthStarted = resolve));
  void Promise.all([mainStartedP, authStartedP]).then(() => shared.release());

  const authAbort = new AbortController();
  const authRun = streamPgDump({
    databaseUrl: config.databaseUrl,
    pgDumpBin,
    args: authDumpArgs(shared.id),
    upload: plan.upload,
    onFirstByte: () => markAuthStarted(),
    maxBytes: AUTH_DUMP_MAX_BYTES,
    signal: authAbort.signal,
    endOnlyOnSuccess: true,
  }).then(
    (result) => ({ ok: true as const, ...result }),
    (error: unknown) => ({ ok: false as const, error })
  );
  void authRun.finally(() => markAuthStarted());

  let main: { bytes: number; sha256: string };
  try {
    main = await streamPgDump({
      databaseUrl: config.databaseUrl,
      pgDumpBin,
      args: mainDumpArgs(config.schemas, shared.id),
      upload: (body) => writer.uploadDump(body, relationBytes),
      onFirstByte: () => {
        mainStarted = true;
        markMainStarted();
      },
    });
  } catch (error) {
    markMainStarted();
    authAbort.abort();
    await authRun;
    await shared.release();
    // 主 dump 导入快照失败、一个字节都没写出:Auth 不做了,主 dump 按今天的方式重导
    if (!mainStarted && /snapshot/i.test(shortReason(error))) {
      log.warn(`Couldn't share a snapshot with the main dump (${shortReason(error)}); dumping it the usual way.`);
      const plain = await streamPgDump({
        databaseUrl: config.databaseUrl,
        pgDumpBin,
        args: mainDumpArgs(config.schemas),
        upload: (body) => writer.uploadDump(body, relationBytes),
      });
      return { main: plain, auth: authNotDone(mode, "snapshot_unavailable") };
    }
    throw error;
  }

  // 主 dump 已经完成:Auth 两张表通常几秒就导完。万一那边卡住,最多再等这么久就放弃,
  // 不能让整份备份(以及 worker 的串行队列)陪着它挂住
  let authTimer: NodeJS.Timeout | undefined;
  const authResult = await Promise.race([
    authRun,
    new Promise<Awaited<typeof authRun>>((resolve) => {
      authTimer = setTimeout(() => {
        authAbort.abort();
        void authRun.then(() =>
          resolve({ ok: false, error: new Error(`timed out ${AUTH_WAIT_AFTER_MAIN_MS / 60000} minutes after the main dump`) })
        );
      }, AUTH_WAIT_AFTER_MAIN_MS);
    }),
  ]);
  clearTimeout(authTimer);
  await shared.release();
  if (!authResult.ok) {
    const auth =
      authResult.error instanceof AuthDumpTooLarge
        ? authNotDone(mode, "too_large")
        : ({ status: "failed", reason: `Auth archive not written: ${shortReason(authResult.error)}` } as AuthSection);
    return { main, auth };
  }
  return {
    main,
    auth: {
      status: "included",
      dump: { key: plan.key, format: "custom", bytes: authResult.bytes, sha256: authResult.sha256 },
      rows: { users: inspection.users, identities: inspection.identities },
      passwordHashes: inspection.passwordHashes,
      anonymousUsers: inspection.anonymousUsers,
      ssoUsers: inspection.ssoUsers,
      mfaUsers: inspection.mfaUsers,
      triggers: inspection.triggers,
      policies: inspection.policies,
    },
  };
}

/** 备份结束时把 Auth 段的结果说给人听;warn 的都是不影响数据库备份的事 */
function logAuthOutcome(auth: AuthSection, schemas: string[]): void {
  if (auth.status === "included") {
    log.ok(
      `Auth users backed up (${auth.rows!.users.toLocaleString("en-US")} users, ` +
        `${auth.rows!.identities.toLocaleString("en-US")} sign-in identities, ` +
        `${(auth.dump!.bytes / 1024 / 1024).toFixed(1)} MB)`
    );
    if (auth.passwordHashes!.encrypted > 0) {
      log.warn(
        `${auth.passwordHashes!.encrypted} password hash(es) are encrypted with this project's key; ` +
          `after a restore into a new project those users can't sign in with their old password.`
      );
    }
    for (const note of unbackedAuthDependencies({ triggers: auth.triggers!, policies: auth.policies! }, schemas)) {
      log.warn(`${note}. Add that schema to the backup to keep it.`);
    }
    return;
  }
  const why = AUTH_SKIP_TEXT[auth.reason ?? ""] ?? auth.reason ?? "unknown reason";
  if (auth.status === "skipped") {
    // 不是 Supabase 库时这是正常情况,不该显得像个问题
    if (auth.reason === "no_auth_schema") log.step(`Auth users: skipped (${why}).`);
    else log.warn(`Auth users not backed up: ${why}. The database backup itself is complete.`);
  } else {
    log.warn(`Auth users backup failed: ${why}. The database backup itself is complete.`);
  }
}

export async function runBackup(
  config: BackupConfig,
  opts: {
    /** 快照写到哪;省略 = config.storage 指的 S3 兼容桶 */
    store?: SnapshotStore;
  } = {}
): Promise<Manifest> {
  // 源身份先于一切传输(评审第 12 轮):①连接串不许带 ?host=/user= 覆盖——否则
  // 快照记的 ref 与实际读取对象脱节,恢复端的同源保护随之失真;②库与 Storage
  // 跨项目 = 配置错误,全量 dump+同步之后才发现会白烧 egress 还留下半截快照前缀
  assertNoHostOverride(config.databaseUrl);
  const dbRef = projectRefOf(config.databaseUrl);
  const storageRef = config.supabaseStorage
    ? refFromStorageEndpoint(config.supabaseStorage.endpoint)
    : null;
  if (dbRef && storageRef && dbRef !== storageRef) {
    throw new Error(
      `database points at Supabase project "${dbRef}" but Storage at "${storageRef}" — ` +
        `one BackupDrill project backs up one Supabase project; fix the config before backing up.`
    );
  }
  const sourceProjectRef = dbRef ?? storageRef;

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

  const store = opts.store ?? s3SnapshotStore(config);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const writer = await store.createSnapshot(timestamp);
  const storageFiles = writer.storageFiles;
  // 在转储之前拦下:目标放不了 Storage 文件却配了 Storage,转储完才发现等于白跑一遍
  if (config.supabaseStorage && !storageFiles) {
    throw new Error(
      "Storage file backup needs an S3-compatible bucket; this backup destination only holds the database."
    );
  }
  const dumpKey = writer.dumpKey;

  // 授权在转储前后各读一次,只记两次都有的(为什么见 grantsHeldThroughout)。
  // 哪次读不到都让备份失败,不留一份缺授权记录的快照:恢复端把"没有记录"当成 2.9.0 之前的旧快照,
  // 按 Supabase 以前的默认授权开放 public,会把源库关着的表打开
  const grantsBeforeDump = await readGrants(config.databaseUrl, config.schemas);

  // Auth 用户另备一份(2.10.0 起,见 auth-backup.ts)。库调用方没传 = 关闭,下面走的就是之前的那条路,
  // 参数、文件、manifest 都和之前一样。共享快照在转储前一刻才导出,尽量少占连接
  const authMode: AuthMode = config.auth ?? "off";
  const authPlan = await planAuth(config, writer, authMode);
  let auth: AuthSection | undefined = authPlan.kind === "settled" ? authPlan.section : undefined;

  log.step(`Dumping → ${writer.describe("dump.pgcustom")}`);
  let bytes: number;
  let sha256: string;
  if (authPlan.kind === "dump") {
    const result = await dumpWithAuth(config, writer, pgDumpBin, db.relationBytes, authMode, authPlan);
    ({ bytes, sha256 } = result.main);
    auth = result.auth;
  } else {
    ({ bytes, sha256 } = await streamPgDump({
      databaseUrl: config.databaseUrl,
      pgDumpBin,
      args: mainDumpArgs(config.schemas),
      upload: (body) => writer.uploadDump(body, db.relationBytes),
    }));
  }
  log.ok(`Database dumped (${(bytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`);
  if (auth) logAuthOutcome(auth, config.schemas);

  const grants = grantsHeldThroughout(grantsBeforeDump, await readGrants(config.databaseUrl, config.schemas));

  // Storage 文件同步(源配置存在才做;否则只备数据库)
  let storageResult: Manifest["storage"] = null;
  if (config.supabaseStorage && storageFiles) {
    log.step("Syncing Storage files…");
    const synced = await syncStorage(config.supabaseStorage, {
      client: storageFiles.s3,
      bucket: storageFiles.bucket,
      base: storageFiles.base, // syncStorage 内部会加 /storage/<bucket>/<key>
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
    ...(sourceProjectRef ? { sourceProjectRef } : {}),
    database: {
      serverVersion: db.serverVersion,
      pgDumpVersion: pgd.raw,
      schemas: config.schemas,
      tableCount: db.tables.length,
      estimatedRowTotal: db.tables.reduce((n, t) => n + t.estimatedRows, 0),
      tables: db.tables,
      extensions: db.extensions,
      grants,
    },
    dump: { key: dumpKey, format: "custom", bytes, sha256 },
    // 关闭时不写这个字段:manifest 与之前逐字节一致
    ...(auth ? { auth } : {}),
    storage: storageResult,
  };

  // RECOVERY.md(PRD §5.9.2.1)先于 manifest 落桶:manifest 是快照的"完成标记"
  // (演练/恢复按它找快照)——先写手册再写标记,"快照完成"就蕴含"手册在场";
  // 手册写失败 = 备份失败(同桶同权限,与 manifest 自身的写入风险一致)。
  await writer.writeRecoveryDoc(manifest);
  log.ok(`Recovery runbook written → ${writer.describe("RECOVERY.md")}`);

  await writer.writeManifest(manifest);
  log.ok(`Manifest written → ${writer.describe("manifest.json")}`);

  return manifest;
}
